/**
 * The macOS notch panel: a slim always-on-top surface hugging the top-centre of
 * the primary display that expands into a small activity panel on hover.
 *
 * Three decisions here are non-obvious.
 *
 * 1. It is a `BaseWindow` + `WebContentsView`, not a `BrowserWindow`. `main.ts`
 *    treats `BrowserWindow.getAllWindows()` as "the app's real windows" — it
 *    decides whether to open the initial window from it, routes menu actions
 *    through it, and repaints every entry with an opaque theme background when
 *    the system theme changes. A `BrowserWindow` here would suppress the main
 *    window on a packaged launch and have its transparency painted over.
 *    `BrowserWindow.getAllWindows()` filters to `BrowserWindow` instances, so a
 *    `BaseWindow` stays invisible to all of that.
 *
 * 2. The window is always sized for the *expanded* panel; hover only changes
 *    what the page draws inside it. Growing the window itself would mean
 *    tweening native bounds against a transparent, shadowless surface — which
 *    on macOS leaves shadow artifacts and reflows the page on every frame.
 *    A CSS morph inside a fixed window is both smoother and simpler, and the
 *    extra area is transparent and click-through, so it costs nothing.
 *
 * 3. Hover is sampled in this process rather than reported by the page. The
 *    window is click-through for all but one of its states, which makes DOM
 *    hover dependent on forwarded mouse messages; polling the cursor is
 *    deterministic instead, and it is the same sample that decides whether the
 *    panel may take a click at all. The panel does now have a preload
 *    (`notchPreload.ts`), but it carries one button press and nothing else —
 *    hover has no reason to become the page's business.
 *
 * 4. The figures are fetched here and written into the page. Giving the page a
 *    channel to ask over would mean handing a sandboxed surface a credential.
 *    Main already holds the server's address, so the read stays on this side and
 *    the page only ever receives a few short strings. What it reads and how it
 *    authenticates is `notchData.ts`.
 *
 * 5. What it shows follows the app window's route, and that route is *sampled*
 *    from `webContents.getURL()` in the same loop as the cursor rather than
 *    subscribed to with `did-navigate`. The app window is not this module's to
 *    own: it does not exist when the panel is created, it is closed and rebuilt
 *    on `activate`, and attaching listeners to it would put panel lifecycle
 *    code inside the main window's constructor. A synchronous string read ten
 *    times a second costs nothing, survives the window being replaced, and
 *    needs no renderer channel — the same argument that made hover a poll.
 *
 * 6. Mouse events are refused except over the expanded panel in the one state
 *    that offers something to press. The window is a single rectangle reaching
 *    up to the top of the display, so "clickable" is all-or-nothing for the
 *    whole frame — including the strip the menu bar owns. Scoping it by cursor
 *    position, against a rect that starts at the top of the *work* area, is what
 *    lets the panel hold a button without the collapsed pill ever being in a
 *    position to swallow a click meant for the menu bar. See
 *    `resolveNotchClickTarget`.
 */

import { app, BaseWindow, ipcMain, screen, WebContentsView } from "electron";
import type { Display, IpcMainEvent } from "electron";
import * as Path from "node:path";

import {
  areNotchContextsEqual,
  defaultNotchContext,
  type NotchContext,
  resolveNotchContext,
} from "./notchContext.ts";
import {
  areRectsEqual,
  containsPoint,
  type NotchLayout,
  type NotchPoint,
  resolveNotchClickTarget,
  resolveNotchHoverTarget,
  resolveNotchLayout,
} from "./notchGeometry.ts";
import {
  initialNotchHoverState,
  type NotchHoverState,
  reduceNotchHoverState,
} from "./notchHover.ts";
import { createNotchRefreshScheduler, pendingNotchPanelView } from "./notchData.ts";
import {
  buildNotchDataScript,
  buildNotchLayoutScript,
  buildNotchPanelDataUrl,
  buildNotchStateScript,
  NOTCH_SIGN_IN_CHANNEL,
  type NotchPanelView,
} from "./notchPanelDocument.ts";

/**
 * Fast enough that expansion reads as a response to the hover rather than a
 * delayed reaction, and slow enough that a synchronous cursor read eight to ten
 * times a second is not worth measuring.
 */
const HOVER_SAMPLE_INTERVAL_MS = 90;

/**
 * How often the figures are re-read *while the panel is open*.
 *
 * The panel is collapsed for almost all of the day it is running, and nobody is
 * reading a number they cannot see, so there is no background poll at all: one
 * read when the panel first appears, one the moment it expands, and this
 * cadence only for as long as it stays expanded. A hover lasts seconds, so in
 * practice most expansions cost exactly one request.
 */
const DATA_REFRESH_INTERVAL_MS = 15_000;

export interface NotchPanelController {
  destroy(): void;
}

export interface NotchPanelOptions {
  /**
   * Reads the figures the given context calls for. Omitted — as in tests, or
   * before the app has an account — the panel keeps the dashes it was built
   * with.
   */
  readonly readView?: (context: NotchContext) => Promise<NotchPanelView>;
  /**
   * The app window's current URL, or `null` while there is no window. Omitted,
   * the panel never leaves its default context. Resolved per call rather than
   * captured, because the window it reads is closed and recreated.
   */
  readonly readUrl?: () => string | null;
  /**
   * Carries the reader to where they can sign in. Required, not optional: the
   * panel draws a sign-in button whenever the read comes back signed out, and a
   * button with nobody behind it is worse than the dash it replaced.
   */
  readonly onSignIn: () => void;
  readonly refreshIntervalMs?: number;
}

function toLayoutInput(display: Display): NotchLayout {
  return resolveNotchLayout({ bounds: display.bounds, workArea: display.workArea });
}

/**
 * Creates the notch panel and wires it to the app's lifetime.
 *
 * Returns `null` off macOS: the panel is defined by the notch and by the macOS
 * menu bar it floats over, and neither Windows nor Linux has a surface it could
 * mean anything on — so this is a deliberate absence, not an unimplemented
 * branch.
 */
export function createNotchPanel(options: NotchPanelOptions): NotchPanelController | null {
  if (process.platform !== "darwin") {
    return null;
  }

  let layout = toLayoutInput(screen.getPrimaryDisplay());

  const window = new BaseWindow({
    ...layout.window,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    // The panel draws its own shadow in CSS. A native shadow would trace the
    // full transparent window rect instead of the pill inside it.
    hasShadow: false,
    // `panel` maps to a non-activating NSPanel, which is what keeps a click
    // from pulling the user out of their editor and keeps the surface out of
    // the window cycler. (Dock presence is process-wide, not per-window, so it
    // is not something this window can or should opt out of.)
    type: "panel",
    focusable: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    closable: false,
    fullscreenable: false,
    skipTaskbar: true,
    roundedCorners: false,
    title: "Live activity",
  });

  // Above the menu bar and above full-screen apps.
  window.setAlwaysOnTop(true, "screen-saver");
  // `skipTransformProcessType` matters: without it, going visible-on-all-
  // workspaces flips the process type and takes the app's Dock icon with it.
  window.setVisibleOnAllWorkspaces(true, {
    visibleOnFullScreen: true,
    skipTransformProcessType: true,
  });
  window.setHiddenInMissionControl(true);
  // An overlay that sits over every screenshot and screen share is noise in
  // both; excluding it costs nothing because the panel is read-only.
  window.setContentProtection(true);
  /**
   * Click-through is the resting state and the only state the pill is ever in:
   * it overlaps the menu bar and must never swallow a click meant for it.
   * `forward` keeps mouse moves flowing to the page while it holds, so the
   * button's hover styling works even before the panel accepts a press.
   */
  const setClickThrough = (clickThrough: boolean): void => {
    if (window.isDestroyed()) {
      return;
    }
    if (clickThrough) {
      window.setIgnoreMouseEvents(true, { forward: true });
      return;
    }
    window.setIgnoreMouseEvents(false);
  };
  setClickThrough(true);

  const view = new WebContentsView({
    webPreferences: {
      // One button press, no exposed API — see `notchPreload.ts`. The page's
      // own world is unchanged by it, so nothing below is relaxed for it.
      preload: Path.join(__dirname, "notchPreload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      transparent: true,
      // The panel is always partly occluded by the notch; throttling it would
      // stutter the expand animation.
      backgroundThrottling: false,
    },
  });
  // A transparent window still composites its views opaquely unless each view
  // opts out.
  view.setBackgroundColor("#00000000");
  window.contentView.addChildView(view);

  const syncViewBounds = (): void => {
    const { width, height } = window.getContentBounds();
    view.setBounds({ x: 0, y: 0, width, height });
  };
  syncViewBounds();
  window.on("resize", syncViewBounds);

  let destroyed = false;

  const evaluateInPanel = (script: string): void => {
    if (destroyed || view.webContents.isDestroyed()) {
      return;
    }
    void view.webContents.executeJavaScript(script, true).catch(() => {
      // The page can be mid-navigation during teardown; the next sample or
      // layout change re-applies the same state, so a miss is not worth logging.
    });
  };

  let hover: NotchHoverState = initialNotchHoverState;
  let action: NotchPanelView["action"] = null;
  let clickThrough = true;

  /**
   * The page and this process learn a reading in the same moment. Drawing the
   * button without recording that there is one — or the reverse — is a button
   * nobody can press, so the two are never written apart.
   */
  const applyView = (next: NotchPanelView): void => {
    action = next.action;
    evaluateInPanel(buildNotchDataScript(next));
  };

  const applyLayout = (): void => {
    if (destroyed || window.isDestroyed()) {
      return;
    }
    const next = toLayoutInput(screen.getPrimaryDisplay());
    if (areRectsEqual(next.window, layout.window) && next.hasNotch === layout.hasNotch) {
      layout = next;
      return;
    }
    layout = next;
    window.setBounds(layout.window);
    syncViewBounds();
    evaluateInPanel(buildNotchLayoutScript(layout));
    // Transparent windows on macOS keep stale shadow geometry after a resize.
    window.invalidateShadow();
  };

  // Without these the panel ends up off-centre or off-screen entirely the first
  // time someone plugs in a monitor or changes resolution.
  screen.on("display-metrics-changed", applyLayout);
  screen.on("display-added", applyLayout);
  screen.on("display-removed", applyLayout);

  let context: NotchContext = defaultNotchContext;

  const readView = options.readView;
  const refresher =
    readView === undefined
      ? null
      : createNotchRefreshScheduler<NotchPanelView | null>({
          readView: async () => {
            const asked = context;
            const view = await readView(asked);
            // A reading can outlive the page it was about. Dropping it is the
            // only way the panel cannot draw a project's deployments under the
            // labels of the page the user has already moved on to.
            return areNotchContextsEqual(asked, context) ? view : null;
          },
          apply: (view) => {
            if (view !== null) {
              applyView(view);
            }
          },
          intervalMs: options.refreshIntervalMs ?? DATA_REFRESH_INTERVAL_MS,
        });

  const readUrl = options.readUrl;

  const sampleContext = (): void => {
    if (readUrl === undefined) {
      return;
    }
    let url: string | null = null;
    try {
      url = readUrl();
    } catch {
      // The app window can be mid-teardown, in which case there is no route to
      // read and the panel falls back to the figures that are true everywhere.
      url = null;
    }
    const next = resolveNotchContext(url);
    if (areNotchContextsEqual(next, context)) {
      return;
    }
    context = next;
    // Repaint the new page's labels straight away, so the panel is never
    // showing one page's numbers beside another page's names while the read
    // for the new one is still in the air.
    applyView(pendingNotchPanelView(next));
    // Collapsed, the next expansion reads anyway; asking now would be a request
    // for a surface nobody is looking at.
    if (hover.expanded) {
      refresher?.readOnce();
    }
  };

  const sampleHover = (cursor: NotchPoint): void => {
    const target = resolveNotchHoverTarget(layout, hover.expanded);
    const next = reduceNotchHoverState(hover, containsPoint(target, cursor));
    if (next.expanded !== hover.expanded) {
      evaluateInPanel(buildNotchStateScript(next.expanded));
      // Refreshing is tied to visibility, not to a clock: a panel nobody has
      // open must not be a reason to talk to the server at all.
      refresher?.setExpanded(next.expanded);
    }
    hover = next;
  };

  /**
   * The window stops being click-through only while the cursor is inside a rect
   * the panel can act on, and `resolveNotchClickTarget` never returns one that
   * reaches the menu bar. Collapsing puts it back by the same rule, without
   * needing a separate path: no expansion, no target.
   *
   * It follows the cursor rather than the hover state alone because the hover
   * region deliberately spans the pill, the gap and the panel — and the pill is
   * over the menu bar. A press is only ever possible where a press makes sense.
   */
  const sampleClickThrough = (cursor: NotchPoint): void => {
    const target = resolveNotchClickTarget(layout, hover.expanded, action !== null);
    const next = target === null || !containsPoint(target, cursor);
    if (next === clickThrough) {
      return;
    }
    clickThrough = next;
    setClickThrough(next);
  };

  const sample = (): void => {
    if (destroyed || window.isDestroyed()) {
      return;
    }
    // Context first: an expansion in the same tick should read the page the
    // window is actually on.
    sampleContext();
    // One cursor read for both: sampling it twice in a tick could put the hover
    // state and the click region on either side of a single mouse move.
    const cursor = screen.getCursorScreenPoint();
    sampleHover(cursor);
    sampleClickThrough(cursor);
  };

  const handleSignIn = (event: IpcMainEvent): void => {
    // `ipcMain` is process-wide, so the panel's own page is checked for rather
    // than assumed: this channel exists for exactly one surface.
    if (destroyed || view.webContents.isDestroyed() || event.sender !== view.webContents) {
      return;
    }
    options.onSignIn();
  };
  ipcMain.on(NOTCH_SIGN_IN_CHANNEL, handleSignIn);

  const hoverTimer = setInterval(sample, HOVER_SAMPLE_INTERVAL_MS);
  // The panel must never be the reason the process stays alive.
  hoverTimer.unref();

  view.webContents.once("did-finish-load", () => {
    if (destroyed || window.isDestroyed()) {
      return;
    }
    // `showInactive` rather than `show`: revealing the panel must not steal the
    // active window from whatever the user is typing in.
    window.showInactive();
    // Whatever the app is already on, before the first read goes out — a panel
    // shown while the user is mid-navigation should not open on the wrong page.
    sampleContext();
    // One read on show, so the first hover lands on figures rather than on
    // dashes waiting for a round trip.
    refresher?.readOnce();
  });
  void view.webContents.loadURL(buildNotchPanelDataUrl(layout));

  const destroy = (): void => {
    if (destroyed) {
      return;
    }
    destroyed = true;
    clearInterval(hoverTimer);
    refresher?.stop();
    ipcMain.removeListener(NOTCH_SIGN_IN_CHANNEL, handleSignIn);
    screen.removeListener("display-metrics-changed", applyLayout);
    screen.removeListener("display-added", applyLayout);
    screen.removeListener("display-removed", applyLayout);
    if (!window.isDestroyed()) {
      window.destroy();
    }
  };

  // Owned here rather than in `main.ts` so the caller needs a single line and
  // the timer and screen listeners cannot outlive the window.
  app.once("before-quit", destroy);

  return { destroy };
}
