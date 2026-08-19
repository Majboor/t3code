#!/usr/bin/env node
// Drives the packaged desktop app the way a person does, and writes down
// everything the renderer says while doing it.
//
//   bun run test:app-smoke
//   node scripts/app-smoke.mjs --keep            # keep the sandbox home
//   node scripts/app-smoke.mjs --only chat       # one phase
//   node scripts/app-smoke.mjs --no-provider     # nothing logged in anywhere
//
// The point is the listeners, not the clicks. "The app crashes" is not a bug
// report you can act on; a `pageerror` with a stack is. So every window this
// app opens gets `console`, `pageerror` and `crash` attached the moment it
// appears, the main process gets `render-process-gone`, and the run prints the
// lot at the end whether or not a check failed.
//
// It launches the *installed* app, not a dev build, because the dev server and
// the package disagree about enough (module graph, asset scheme, state
// directory) that a green dev run says nothing about the thing users install.
//
// The app is given its own HOME so a run cannot touch the real one: the state
// directory (`~/.t3`), the Chromium profile and the desktop settings are all
// derived from it. The parts of the home a run genuinely needs — the CLI
// binaries on PATH and their credentials — are symlinked in, so the sandbox is
// a fresh install of *this app*, not a fresh machine.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

const { _electron: electron } = createRequire(new URL("../apps/web/package.json", import.meta.url))(
  "playwright",
);

const APP_PATH =
  process.env["T3_SMOKE_APP"] ??
  "/Applications/LogicPacks (Alpha).app/Contents/MacOS/LogicPacks (Alpha)";
const ARGS = process.argv.slice(2);
const KEEP = ARGS.includes("--keep");
const NO_PROVIDER = ARGS.includes("--no-provider");
const ONLY = readFlag("--only");
const SANDBOX =
  readFlag("--home") ??
  path.join(os.tmpdir(), "t3-app-smoke", `home-${KEEP ? "keep" : Date.now()}`);
const EMAIL = readFlag("--email") ?? `smoke+${Date.now()}@example.com`;
const PASSWORD = "AppSmoke!2026";
const SHOTS = path.join(SANDBOX, "shots");

function readFlag(name) {
  const index = ARGS.indexOf(name);
  return index >= 0 ? ARGS[index + 1] : undefined;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const results = [];
let phaseName = "setup";
const phase = (title) => {
  phaseName = title;
  console.log(`\n── ${title} ${"─".repeat(Math.max(0, 58 - title.length))}`);
};
const check = (step, ok, detail = "") => {
  results.push({ phase: phaseName, step, ok });
  const trimmed = String(detail).replaceAll("\n", " | ").slice(0, 300);
  console.log(
    `  ${ok ? "[32mPASS[0m" : "[31mFAIL[0m"}  ${step}${trimmed ? `  — ${trimmed}` : ""}`,
  );
  return ok;
};
const note = (text) => console.log(`  [36mNOTE[0m  ${text}`);

/**
 * Everything the renderer said, in order, with the phase it said it in — the
 * phase is what turns a stack trace into a reproduction.
 */
const diagnostics = [];
const record = (kind, text) => {
  const entry = { phase: phaseName, kind, text: String(text).slice(0, 4_000) };
  diagnostics.push(entry);
  if (kind !== "console.log") console.log(`  [35m${kind}[0m  ${entry.text.slice(0, 300)}`);
};

/** The agent CLIs' own credentials, which `--no-provider` withholds. */
const PROVIDER_HOME_ENTRIES = [".claude", ".claude.json", ".codex"];

/**
 * The home a run is allowed to write to. Only the entries a packaged app needs
 * to find the agent CLIs are linked through; everything the app itself stores
 * lands inside the sandbox and is thrown away with it.
 *
 * `--no-provider` leaves the CLI credentials out, which is the state a person
 * who has never run `codex login` installs into — and the state in which every
 * refusal path this run cares about is reachable.
 */
function buildSandboxHome() {
  if (!KEEP) rmSync(SANDBOX, { recursive: true, force: true });
  mkdirSync(SANDBOX, { recursive: true });
  mkdirSync(SHOTS, { recursive: true });
  const real = os.homedir();
  for (const entry of [
    ".local",
    ".nvm",
    ".bun",
    ".cargo",
    ".pyenv",
    "bin",
    ".config",
    ".npmrc",
    ".zshrc",
    ".zprofile",
    ".zshenv",
    ".gitconfig",
    ...(NO_PROVIDER ? [] : PROVIDER_HOME_ENTRIES),
  ]) {
    const source = path.join(real, entry);
    const target = path.join(SANDBOX, entry);
    if (!existsSync(source) || existsSync(target)) continue;
    try {
      symlinkSync(source, target);
    } catch {
      // A link that cannot be made is not worth failing a run over; the phase
      // that needs it will say so in its own words.
    }
  }
  return SANDBOX;
}

function attachWindowListeners(page, label) {
  page.on("console", (message) => {
    const type = message.type();
    if (type === "error" || type === "warning") record(`console.${type}[${label}]`, message.text());
  });
  page.on("pageerror", (error) => record(`pageerror[${label}]`, error.stack ?? String(error)));
  page.on("crash", () => record(`crash[${label}]`, "renderer process crashed"));
  page.on("requestfailed", (request) => {
    const failure = request.failure()?.errorText ?? "";
    if (failure && !failure.includes("ERR_ABORTED")) {
      record(`requestfailed[${label}]`, `${request.url()} — ${failure}`);
    }
  });
}

/**
 * The app opens two windows: the notch overlay (a `data:` document over the
 * menu bar) and the app itself. `firstWindow()` returns whichever won the race,
 * which for the first minute of a run is usually the notch — so the window is
 * chosen by what it loaded, not by when it appeared.
 */
async function mainWindow(app, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const candidate of app.windows()) {
      if (/^https?:/.test(candidate.url())) return candidate;
    }
    await sleep(500);
  }
  throw new Error("no window ever loaded the app over http");
}

/**
 * The notch overlay's page. It is the one document in the app that is served
 * from a `data:` URL — `notchPanelDocument.ts` generates it in-process — so that
 * is what identifies it, for the same reason `mainWindow` matches on `http:`.
 */
async function notchPage(app, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const candidate of app.windows()) {
      if (candidate.url().startsWith("data:text/html")) return candidate;
    }
    await sleep(500);
  }
  return null;
}

const bodyText = (page) =>
  page
    .locator("body")
    .innerText()
    .catch(() => "");

async function shoot(page, name) {
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) }).catch(() => undefined);
}

async function main() {
  const home = buildSandboxHome();
  console.log(`app      ${APP_PATH}`);
  console.log(`sandbox  ${home}`);
  console.log(`email    ${EMAIL}`);

  const app = await electron.launch({
    executablePath: APP_PATH,
    args: [],
    env: {
      ...process.env,
      HOME: home,
      T3CODE_HOME: path.join(home, ".t3"),
      // Two copies of the app must not share a port; the desktop scans upward
      // from its default, but pin it so the run knows what it is talking to.
      T3CODE_DISABLE_AUTO_UPDATE: "1",
    },
    timeout: 120_000,
  });

  // A renderer that dies takes its `page` events with it, so the death itself
  // has to come from the main process.
  await app
    .evaluate(({ app: electronApp }) => {
      electronApp.on("render-process-gone", (_event, _contents, details) => {
        console.error(`[main] render-process-gone ${JSON.stringify(details)}`);
      });
      electronApp.on("child-process-gone", (_event, details) => {
        console.error(`[main] child-process-gone ${JSON.stringify(details)}`);
      });
    })
    .catch((error) => note(`could not hook main process: ${error}`));

  app.on("console", (message) => record("main", message.text()));
  app.on("window", (page) => {
    attachWindowListeners(page, "extra");
    record("window", `opened ${page.url()}`);
  });

  const page = await mainWindow(app);
  attachWindowListeners(page, "main");
  await page.waitForLoadState("domcontentloaded").catch(() => undefined);
  await sleep(8_000);

  const context = { app, page, home, origin: new URL(page.url()).origin };
  const phases = {
    boot: bootPhase,
    // Before the sign-in phase on purpose: the notch panel's only pressable
    // state is the signed-out one, and this is the only moment in a run when it
    // is reached honestly rather than by forcing an attribute onto the page.
    notch: notchPhase,
    signin: signInPhase,
    project: projectPhase,
    chat: chatPhase,
    picker: pickerPhase,
    connections: connectionsPhase,
    publish: publishPhase,
    sweep: sweepPhase,
    // Last, because it is the same panel read by an account that exists: the
    // signed-out pass above can prove the button and not the figures.
    notchlive: notchLivePhase,
  };
  for (const [name, run] of Object.entries(phases)) {
    if (ONLY && ONLY !== name) continue;
    await run(context).catch((error) => {
      check(`${name} phase completed`, false, String(error).slice(0, 300));
    });
  }

  await shoot(page, "final");
  await app.close().catch(() => undefined);

  console.log("\n── renderer diagnostics ─────────────────────────────────");
  if (diagnostics.length === 0) console.log("  (nothing — the renderer stayed quiet)");
  for (const entry of diagnostics) {
    console.log(
      `  [${entry.phase}] ${entry.kind}\n      ${entry.text.replaceAll("\n", "\n      ")}`,
    );
  }

  const failed = results.filter((result) => !result.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  for (const result of failed) console.log(`  FAILED  [${result.phase}] ${result.step}`);
  console.log(`\nscreenshots ${SHOTS}`);
  if (!KEEP) note(`sandbox kept for inspection: ${SANDBOX}`);
  process.exit(failed.length === 0 ? 0 : 1);
}

async function bootPhase({ page }) {
  phase("boot");
  const url = page.url();
  const text = await bodyText(page);
  check("a window opened", Boolean(url), url);
  check("the window rendered something", text.trim().length > 0, `${text.slice(0, 120)}`);
  await shoot(page, "01-boot");
}

/*
 * ── the notch panel ──────────────────────────────────────────────────────────
 *
 * Everything below drives `apps/desktop/src/notch*.ts`, which was unit-tested
 * against synthetic displays and never once watched running. Three things it
 * can prove and one it cannot, stated here so a green run is not read as more
 * than it is:
 *
 * - **Proven.** That the window and its document exist at the notch, that the
 *   preload really did attach to a `data:` document inside a sandboxed
 *   `WebContentsView` (a click on the page arrives in `ipcMain`), that hover
 *   expands and collapses the panel, and that navigating the app window swaps
 *   the panel's context without moving a pixel of its geometry.
 * - **Not proven, and not provable from here.** That macOS delivers a *physical*
 *   click to a `focusable: false`, `type: "panel"` window, and that the menu bar
 *   still takes clicks underneath the collapsed pill. Both are questions about
 *   AppKit's hit-testing of a real cursor. Playwright's clicks are injected into
 *   the renderer over the debugger, which is exactly the layer below the one in
 *   doubt, and driving the real cursor would take over the machine of whoever is
 *   running this. What this run does instead is check the decision that hit
 *   testing depends on — that the window is only ever taken out of
 *   click-through while the cursor is inside the expanded panel, which starts at
 *   the top of the work area and so never overlaps the menu bar.
 *
 * The cursor is stubbed rather than moved: `notchWindow.ts` polls
 * `screen.getCursorScreenPoint()`, so replacing that one function drives the
 * real sampler, the real hysteresis and the real geometry without touching the
 * pointer of the person running this. Everything it stubs, it puts back.
 */

/** Mirrors `notchGeometry.ts`; kept here because a script cannot import the TS. */
const NOTCH_GEOMETRY = { panelWidth: 380, panelHeight: 160, gutter: 16, pillWidth: 190 };

/** `NOTCH_SLOT_COUNT` — the panel lays out this many rows once, at load. */
const NOTCH_SLOT_COUNT = 3;

/**
 * Wraps the three things the panel reads from the outside world so a run can
 * drive them: the cursor, the app window's URL, and the click-through call it
 * makes in response. Each wrapper keeps the original and `releaseNotchProbe`
 * puts it back, because every later phase shares this main process.
 */
async function installNotchProbe(app) {
  return app.evaluate(({ BaseWindow, BrowserWindow, ipcMain, screen }) => {
    const scope = globalThis;
    const panel = BaseWindow.getAllWindows().find((window) => !(window instanceof BrowserWindow));
    if (panel === undefined) return { found: false };
    scope.__notchPanel = panel;

    // Every click-through flip, with the cursor that caused it, is the whole
    // evidence for "the collapsed pill cannot swallow a menu bar click".
    scope.__notchMouseCalls = [];
    const setIgnoreMouseEvents = panel.setIgnoreMouseEvents.bind(panel);
    panel.setIgnoreMouseEvents = (ignore, options) => {
      scope.__notchMouseCalls.push({
        ignore,
        forward: options?.forward ?? false,
        at: Date.now(),
        // The cursor the decision was taken against. Without it "mouse events
        // were turned on" is not a statement about where they were turned on.
        cursor: scope.__notchCursor ?? screen.getCursorScreenPoint(),
      });
      return setIgnoreMouseEvents(ignore, options);
    };

    // A second listener on the panel's own channel. `notchWindow.ts` keeps its
    // own and still runs; this only counts.
    scope.__notchSignIns = 0;
    scope.__notchSignInListener = () => {
      scope.__notchSignIns += 1;
    };
    ipcMain.on("desktop:notch-sign-in", scope.__notchSignInListener);

    scope.__notchCursor = null;
    const getCursorScreenPoint = screen.getCursorScreenPoint.bind(screen);
    screen.getCursorScreenPoint = () => scope.__notchCursor ?? getCursorScreenPoint();

    scope.__notchUrl = null;
    const appWindow = BrowserWindow.getAllWindows()[0];
    const getURL = appWindow ? appWindow.webContents.getURL.bind(appWindow.webContents) : null;
    if (appWindow && getURL) {
      appWindow.webContents.getURL = () => scope.__notchUrl ?? getURL();
    }

    scope.__notchRelease = () => {
      panel.setIgnoreMouseEvents = setIgnoreMouseEvents;
      screen.getCursorScreenPoint = getCursorScreenPoint;
      if (appWindow && getURL && !appWindow.isDestroyed()) {
        appWindow.webContents.getURL = getURL;
      }
      ipcMain.removeListener("desktop:notch-sign-in", scope.__notchSignInListener);
    };

    const display = screen.getPrimaryDisplay();
    return {
      found: true,
      isBrowserWindow: panel instanceof BrowserWindow,
      title: panel.getTitle(),
      visible: panel.isVisible(),
      alwaysOnTop: panel.isAlwaysOnTop(),
      childViews: panel.contentView.children.length,
      bounds: panel.getBounds(),
      display: { bounds: display.bounds, workArea: display.workArea },
      // The app window must still be a `BrowserWindow` and the panel must not
      // be one: `main.ts` drives menus, theme repaints and "is there a window
      // open" off `BrowserWindow.getAllWindows()`.
      browserWindows: BrowserWindow.getAllWindows().length,
    };
  });
}

const releaseNotchProbe = (app) =>
  app.evaluate(() => globalThis.__notchRelease?.()).catch(() => undefined);

const setNotchCursor = (app, point) =>
  app.evaluate((_electron, value) => {
    globalThis.__notchCursor = value;
  }, point);

const setNotchUrl = (app, url) =>
  app.evaluate((_electron, value) => {
    globalThis.__notchUrl = value;
  }, url);

const readNotchProbe = (app) =>
  app.evaluate(() => ({
    signIns: globalThis.__notchSignIns ?? 0,
    mouse: globalThis.__notchMouseCalls ?? [],
    bounds: globalThis.__notchPanel?.getBounds() ?? null,
  }));

/** What the panel is drawing, read out of the document itself. */
const readNotchPanel = (panel) =>
  panel.evaluate(() => ({
    state: document.documentElement.dataset.notchState ?? null,
    action: document.documentElement.dataset.notchAction ?? null,
    title: document.querySelector("[data-panel-title]")?.textContent ?? null,
    slots: [...document.querySelectorAll("[data-slot]")].map((slot) => ({
      label: slot.children[0]?.textContent ?? "",
      value: slot.children[1]?.children[0]?.textContent ?? "",
      note: slot.children[1]?.children[1]?.textContent ?? "",
    })),
    hasButton: Boolean(document.querySelector("[data-notch-action-button]")),
    hasSurface: Boolean(document.querySelector(".surface")),
    panelWidth: getComputedStyle(document.documentElement)
      .getPropertyValue("--notch-panel-width")
      .trim(),
  }));

/**
 * Waits for the panel to settle on a state rather than sleeping past it: the
 * hover reducer needs two agreeing samples at 90ms, and a fixed sleep would
 * either be flaky or be ten times longer than it needs to be.
 */
async function waitForNotch(panel, predicate, timeoutMs = 6_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await readNotchPanel(panel).catch(() => null);
    if (last && predicate(last)) return last;
    await sleep(120);
  }
  return last;
}

async function notchPhase({ app, page }) {
  phase("notch");
  if (process.platform !== "darwin") {
    note("not macOS; `createNotchPanel` returns null by design and there is nothing to drive");
    return;
  }

  const panel = await notchPage(app);
  if (!check("the panel document loaded from a data: URL", panel !== null)) return;
  attachWindowListeners(panel, "notch");

  const probe = await installNotchProbe(app);
  if (!check("a non-BrowserWindow overlay exists", probe.found === true)) return;
  check("it stays out of BrowserWindow.getAllWindows()", probe.isBrowserWindow === false);
  check("it is visible and above the menu bar", probe.visible && probe.alwaysOnTop);
  check("it hosts exactly one WebContentsView", probe.childViews === 1, `${probe.childViews}`);

  // The rects `notchGeometry.ts` computes, recomputed here from the display the
  // app actually launched on — the unit tests prove the arithmetic, this proves
  // the window was given the answer.
  const inset = probe.display.workArea.y - probe.display.bounds.y;
  const expected = {
    x: Math.round(
      probe.display.bounds.x +
        (probe.display.bounds.width - (NOTCH_GEOMETRY.panelWidth + NOTCH_GEOMETRY.gutter * 2)) / 2,
    ),
    y: probe.display.bounds.y,
    width: NOTCH_GEOMETRY.panelWidth + NOTCH_GEOMETRY.gutter * 2,
    height: inset + NOTCH_GEOMETRY.panelHeight + NOTCH_GEOMETRY.gutter,
  };
  check(
    "it is placed at the notch, sized for the expanded panel",
    JSON.stringify(probe.bounds) === JSON.stringify(expected),
    `got ${JSON.stringify(probe.bounds)} want ${JSON.stringify(expected)}`,
  );
  note(`menu bar inset ${inset}pt — over 32 is read as a notched display`);

  // The panel is the only surface here, so the rect a click may land in is the
  // expanded one: it starts at the top of the work area by construction.
  const expandedRect = {
    x: Math.round(
      probe.display.bounds.x + (probe.display.bounds.width - NOTCH_GEOMETRY.panelWidth) / 2,
    ),
    y: probe.display.bounds.y + inset,
    width: NOTCH_GEOMETRY.panelWidth,
    height: NOTCH_GEOMETRY.panelHeight,
  };
  // The pill hides behind the notch on a display that has one and sits below
  // the menu bar on one that does not, so the point to hover is derived rather
  // than assumed — this run has to mean the same thing on both.
  const hasNotch = inset >= 32;
  const pillTop = hasNotch ? probe.display.bounds.y : probe.display.bounds.y + inset;
  const pillHeight = hasNotch ? inset + 10 : 14;
  const pillPoint = {
    x: Math.round(probe.bounds.x + probe.bounds.width / 2),
    y: pillTop + Math.floor(pillHeight / 2),
  };
  const panelPoint = { x: expandedRect.x + 40, y: expandedRect.y + 60 };
  const awayPoint = { x: probe.display.bounds.x + 10, y: probe.display.workArea.y + 400 };
  const insidePanel = (point) =>
    point.x >= expandedRect.x &&
    point.x < expandedRect.x + expandedRect.width &&
    point.y >= expandedRect.y &&
    point.y < expandedRect.y + expandedRect.height;

  const drawn = await readNotchPanel(panel);
  check("the document rendered its surface", drawn.hasSurface === true);
  check(
    `it laid out ${NOTCH_SLOT_COUNT} slots`,
    drawn.slots.length === NOTCH_SLOT_COUNT,
    `${drawn.slots.length}`,
  );
  check("the slots are sized for the panel", drawn.panelWidth === `${NOTCH_GEOMETRY.panelWidth}px`);
  check("it starts collapsed", drawn.state === "collapsed", `${drawn.state}`);
  note(`panel reads: ${drawn.title} — ${drawn.slots.map((s) => `${s.label} ${s.value} ${s.note}`).join(" | ")}`);

  // Nobody has signed in in this sandbox, so this is the signed-out outcome
  // arriving on its own rather than an attribute forced onto the page.
  const signedOut = await waitForNotch(panel, (view) => view.action === "sign-in", 20_000);
  check(
    "a signed-out read draws the sign-in button",
    signedOut?.action === "sign-in" && signedOut.hasButton,
    `action=${signedOut?.action}`,
  );

  // ── hover ──────────────────────────────────────────────────────────────────
  await setNotchCursor(app, pillPoint);
  const expandedView = await waitForNotch(panel, (view) => view.state === "expanded");
  check(
    "a cursor on the pill expands the panel",
    expandedView?.state === "expanded",
    `${expandedView?.state}`,
  );
  await setNotchCursor(app, panelPoint);
  const heldView = await waitForNotch(panel, (view) => view.state === "expanded");
  check("moving down into the panel keeps it open", heldView?.state === "expanded");

  // ── click-through ──────────────────────────────────────────────────────────
  const overPanel = await readNotchProbe(app);
  check(
    "the window takes mouse events only once the cursor is in the panel",
    overPanel.mouse.filter((call) => call.ignore === false).length === 1,
    JSON.stringify(overPanel.mouse),
  );
  // The whole of "the collapsed pill cannot swallow a menu bar click": the
  // window is only ever taken out of click-through with the cursor inside the
  // expanded rect, and that rect starts at the top of the work area, so no such
  // moment can exist while the cursor is over the menu bar.
  check(
    "mouse events are only ever turned on with the cursor inside the panel rect",
    overPanel.mouse.every((call) => call.ignore === true || insidePanel(call.cursor)),
    JSON.stringify(overPanel.mouse),
  );
  check(
    "the panel rect never reaches the menu bar",
    expandedRect.y >= probe.display.workArea.y,
    `panel top ${expandedRect.y}, work area top ${probe.display.workArea.y}`,
  );

  // ── the button ─────────────────────────────────────────────────────────────
  //
  // This is the one that could have failed silently: `notchPreload.ts` is
  // configured as the view's preload, but nothing had ever confirmed Electron
  // attaches a preload to a `data:` document in a sandboxed `WebContentsView`.
  // If it does not, this click reaches the page, finds no listener, and the
  // count below stays at zero.
  const before = await readNotchProbe(app);
  // Hidden first, so "the app window came forward" is something this run
  // watched happen rather than something that was already true.
  const appWindowState = (evaluated) =>
    evaluated.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      return window ? { visible: window.isVisible(), minimized: window.isMinimized() } : null;
    });
  await app
    .evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.hide())
    .catch(() => undefined);
  await sleep(500);
  note(`app window before the click: ${JSON.stringify(await appWindowState(app))}`);

  await panel
    .locator("[data-notch-action-button]")
    .click({ timeout: 5_000 })
    .catch((error) => note(`sign-in click: ${String(error).slice(0, 200)}`));
  await sleep(1_500);
  const after = await readNotchProbe(app);
  check(
    "clicking Sign in reaches main over desktop:notch-sign-in",
    after.signIns > before.signIns,
    `${before.signIns} -> ${after.signIns}`,
  );
  note(
    "the click is injected into the renderer, so this proves the preload attached to the data: document — not that AppKit delivers a physical click to a non-activating panel",
  );
  const revealed = await appWindowState(app).catch(() => null);
  check(
    "signing in brings the app window forward",
    revealed?.visible === true && revealed.minimized === false,
    JSON.stringify(revealed),
  );
  // Whatever the check said, the rest of the run needs that window back.
  if (revealed?.visible !== true) {
    await app
      .evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.show())
      .catch(() => undefined);
  }

  // ── collapse ───────────────────────────────────────────────────────────────
  const leftAt = Date.now();
  await setNotchCursor(app, awayPoint);
  const collapsedView = await waitForNotch(panel, (view) => view.state === "collapsed");
  check(
    "leaving the panel collapses it",
    collapsedView?.state === "collapsed",
    `${collapsedView?.state}`,
  );
  const closed = await readNotchProbe(app);
  const restored = closed.mouse.filter((call) => call.ignore === true).at(-1);
  check(
    "and puts the window back to click-through",
    Boolean(restored) && restored.at >= leftAt && restored.forward === true,
    JSON.stringify(closed.mouse.at(-1)),
  );
  // The gap between the cursor leaving the panel and the window going back to
  // click-through is one sampling interval, and during it the window is still
  // taking mouse events over the menu bar strip. Worth a number rather than a
  // shrug: it is the only window in which the overlay can shadow the menu bar.
  if (restored) note(`click-through restored ${restored.at - leftAt}ms after the cursor left`);

  // ── contexts ───────────────────────────────────────────────────────────────
  const geometryBefore = closed.bounds;
  for (const [kind, url, title] of [
    ["deployment", "http://127.0.0.1:1/#/infra/smoke-project-id", "Deployment"],
    ["analytics", "http://127.0.0.1:1/#/analytics/smoke-project-id", "Analytics"],
    ["prompting", "http://127.0.0.1:1/#/env-1/thread-1", "Current thread"],
    ["default", "http://127.0.0.1:1/#/settings/general", "Live activity"],
  ]) {
    await setNotchUrl(app, url);
    const view = await waitForNotch(panel, (candidate) => candidate.title === title);
    check(`${kind} route relabels the panel`, view?.title === title, `${view?.title}`);
    check(
      `${kind} keeps ${NOTCH_SLOT_COUNT} slots and the same rect`,
      view?.slots.length === NOTCH_SLOT_COUNT &&
        JSON.stringify((await readNotchProbe(app)).bounds) === JSON.stringify(geometryBefore),
      `${view?.slots.length} slots`,
    );
    // The reason `pendingNotchPanelView` exists: the moment the route changes,
    // every figure has to be blanked, or the panel is drawing one page's numbers
    // under another page's names until the next read lands.
    check(
      `${kind} shows no reading from the page it just left`,
      view?.slots.every((slot) => slot.value === "—"),
      JSON.stringify(view?.slots),
    );
  }
  await setNotchUrl(app, null);

  // A read is deliberately not made for a collapsed panel, so the dashes above
  // stay until someone looks — this is the hover that makes them fill in again.
  await setNotchCursor(app, pillPoint);
  const refilled = await waitForNotch(panel, (view) => view.action === "sign-in", 20_000);
  check(
    "expanding after a navigation reads again",
    refilled?.action === "sign-in",
    JSON.stringify(refilled?.slots),
  );
  await setNotchCursor(app, awayPoint);
  await waitForNotch(panel, (view) => view.state === "collapsed");

  // ── the app's own routing ──────────────────────────────────────────────────
  //
  // Everything above stubbed the app window's URL, which proves the mapping and
  // not that the app produces URLs it maps. This navigates the window itself.
  await setNotchUrl(app, null);
  await page.evaluate(() => {
    window.location.hash = "#/infra/smoke-navigated";
  });
  const navigated = await waitForNotch(panel, (view) => view.title === "Deployment", 8_000);
  check(
    "navigating the real app window switches the panel",
    navigated?.title === "Deployment",
    `url=${page.url().slice(-40)} title=${navigated?.title}`,
  );
  await page.evaluate(() => {
    window.location.hash = "#/";
  });
  await waitForNotch(panel, (view) => view.title === "Live activity", 8_000);

  await releaseNotchProbe(app);
  await panel.screenshot({ path: path.join(SHOTS, "notch-panel.png") }).catch(() => undefined);
}

/**
 * The same panel, once an account exists.
 *
 * The signed-out pass can prove the button and nothing about the figures: every
 * slot it sees says "sign in". This is the only run in which `notchData.ts`
 * reads a token out of the app window, calls `/api/desktop/activity` and draws
 * what came back — so it is the only place the panel's whole point is observed.
 */
async function notchLivePhase({ app, page }) {
  phase("notch (signed in)");
  if (process.platform !== "darwin") return;

  const panel = await notchPage(app, 5_000);
  if (!check("the panel is still up at the end of the run", panel !== null)) return;

  const token = await page
    .evaluate(() => localStorage.getItem("t3code.supabase.accessToken"))
    .catch(() => null);
  if (!token) {
    note("no Supabase token in the app window — sign-in never completed, so the signed-in panel cannot be observed");
    check("the panel keeps saying sign in rather than inventing figures", true);
    return;
  }

  const probe = await installNotchProbe(app);
  if (!check("the overlay is still there", probe.found === true)) return;
  const pill = { x: Math.round(probe.bounds.x + probe.bounds.width / 2), y: probe.bounds.y + 4 };
  await setNotchCursor(app, pill);
  const view = await waitForNotch(panel, (candidate) => candidate.action === "none", 25_000);
  check(
    "a signed-in read drops the sign-in button",
    view?.action === "none",
    `action=${view?.action}`,
  );
  check(
    "and every slot says either a figure or why there is none",
    view?.slots.every((slot) => slot.value !== "" && (slot.value !== "—" || slot.note !== "")),
    JSON.stringify(view?.slots),
  );
  note(`signed-in panel: ${view?.slots.map((s) => `${s.label} ${s.value} ${s.note}`).join(" | ")}`);
  await setNotchCursor(app, { x: probe.display.bounds.x + 10, y: probe.display.workArea.y + 400 });
  await sleep(500);
  await releaseNotchProbe(app);
}

async function signInPhase({ page }) {
  phase("sign in");
  const text = await bodyText(page);
  if (/Add project|New thread/.test(text)) {
    check("already signed in", true);
    return;
  }
  const signUp = page.locator('button:has-text("Sign up")').first();
  if ((await signUp.count()) > 0) await signUp.click().catch(() => undefined);
  await sleep(1_500);
  const email = page.locator('input[type="email"]').first();
  check("a sign-in form is on screen", (await email.count()) > 0, text.slice(0, 200));
  if ((await email.count()) === 0) return;
  await email.fill(EMAIL);
  await page.locator('input[type="password"]').first().fill(PASSWORD);
  await page.locator('button[type="submit"]').first().click();
  await sleep(9_000);
  await shoot(page, "02-signin");
  const after = await bodyText(page);
  check(
    "signing up lands in the app",
    /Add project|New thread|Projects/.test(after),
    after.slice(0, 200),
  );
}

async function projectPhase({ page, home }) {
  phase("add a project");
  const projectDir = path.join(home, "smoke-project");
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(path.join(projectDir, "notes.txt"), "hello from the smoke run\n");
  writeFileSync(path.join(projectDir, "readme.md"), "# smoke\n");
  try {
    execFileSync("git", ["init", "-q"], { cwd: projectDir });
    execFileSync("git", ["add", "-A"], { cwd: projectDir });
    execFileSync(
      "git",
      ["-c", "user.email=smoke@example.com", "-c", "user.name=Smoke", "commit", "-qm", "init"],
      {
        cwd: projectDir,
      },
    );
  } catch {
    // A project without a repository is still a project.
  }

  const add = page.locator('button:has-text("Add project")').first();
  check("the Add project control is reachable", (await add.count()) > 0);
  if ((await add.count()) === 0) return;
  await add.click();
  await sleep(2_500);
  const input = page.locator("[data-base-ui-portal] input").first();
  if ((await input.count()) === 0) {
    check("the add-project dialog opened", false, (await bodyText(page)).slice(0, 200));
    return;
  }
  await input.fill(projectDir);
  await sleep(3_000);
  await page.keyboard.press("Enter");
  await sleep(9_000);
  await page.keyboard.press("Escape").catch(() => undefined);
  await sleep(1_500);
  await shoot(page, "03-project");
  const text = await bodyText(page);
  check("the project is listed", text.includes("smoke-project"), text.slice(0, 300));
}

async function openProject(page) {
  const link = page.locator('[data-testid="dashboard-workspace-project-link"]').first();
  if ((await link.count()) > 0) {
    await link.click();
    await sleep(6_000);
    return true;
  }
  return false;
}

async function chatPhase({ page }) {
  phase("chat");
  await openProject(page);
  await sleep(3_000);
  await shoot(page, "04-chat-open");
  const composer = page.locator('[contenteditable="true"], textarea').first();
  check("a composer is on screen", (await composer.count()) > 0, await bodyText(page));
  if ((await composer.count()) === 0) return;
  await composer.click().catch(() => undefined);
  await page.keyboard.type(SENT);
  await sleep(1_000);
  await shoot(page, "05-chat-typed");
  const typed = await bodyText(page);
  check("typing reaches the composer", typed.includes("Say hello"), typed);
  await page.keyboard.press("Enter");
  await sleep(20_000);
  await shoot(page, "06-chat-sent");
  const after = await bodyText(page);
  check("sending does not blank the app", after.trim().length > 0, after);

  // A turn that cannot run is fine; a turn that cannot run *silently* is the
  // bug. Either an answer or a reason has to be on screen — the sent message
  // sitting alone is neither, and that is exactly what a fresh install showed
  // for twenty seconds and counting.
  const transcript = (text) => text.split(SENT).join("");
  const answered = transcript(after).length > transcript(typed).length + 8;
  const refused = /connect|not connected|Settings → Connections|failed|error|unavailable/i.test(
    after,
  );
  check("a send either answers or explains itself", answered || refused, after);
  note(`after send: ${after.replaceAll("\n", " | ").slice(0, 800)}`);
}

/** What the chat phase sends, subtracted from the page to see what came back. */
const SENT = "Say hello and stop.";

/** The composer's model chip, which is the only way into the picker. */
const PICKER = '[data-chat-provider-model-picker="true"]';

async function pickerPhase({ page, origin }) {
  phase("model picker");

  // A thread that has started locks its provider on purpose, so the question
  // "can I switch to Claude" is only meaningful on a fresh one.
  await page.goto(`${origin}/`, { waitUntil: "domcontentloaded" }).catch(() => undefined);
  await sleep(5_000);
  await openProject(page);
  const newThread = page.locator('[data-testid="new-thread-button"]').first();
  if ((await newThread.count()) > 0) {
    await newThread.click({ force: true }).catch(() => undefined);
    await sleep(6_000);
  } else {
    note("no new-thread button; the picker is being read on a thread that has run");
  }

  const trigger = page.locator(PICKER).first();
  check("the composer has a model chip", (await trigger.count()) > 0, await bodyText(page));
  if ((await trigger.count()) === 0) return;
  note(`chip reads: ${(await trigger.innerText().catch(() => "")).replaceAll("\n", " ")}`);
  await trigger.click().catch(() => undefined);
  await sleep(2_000);
  await shoot(page, "07-picker-open");
  const menu = await bodyText(page);
  check("the picker lists Claude", /Claude/.test(menu), menu);
  check("the picker lists Codex", /Codex|GPT/.test(menu), menu);

  const claude = page.locator('[role="menuitem"]:has-text("Claude")').first();
  if ((await claude.count()) > 0) {
    const disabled = await claude.getAttribute("data-disabled").catch(() => null);
    const label = (await claude.innerText().catch(() => "")).replaceAll("\n", " ");
    check("Claude is selectable", disabled === null, `${label} (data-disabled=${disabled})`);
    await claude.hover().catch(() => undefined);
    await sleep(1_500);
    await shoot(page, "08-picker-claude");
    note(`claude submenu: ${(await bodyText(page)).replaceAll("\n", " | ").slice(0, 500)}`);
  }
  await page.keyboard.press("Escape").catch(() => undefined);
  await sleep(1_000);
}

/**
 * The chat refusal tells people to go to Settings → Connections, so that page
 * is part of the chat story: if it cannot connect a provider, chat is not
 * merely refused, it is unrecoverable.
 */
async function connectionsPhase({ page, origin }) {
  phase("connections");
  // Typing the route into the address bar lands back on the dashboard, so go
  // the way a person does: the sidebar's Settings, then Connections.
  await page.goto(`${origin}/`, { waitUntil: "domcontentloaded" }).catch(() => undefined);
  await sleep(4_000);
  await page
    .locator('a:has-text("Settings"), button:has-text("Settings")')
    .first()
    .click({ force: true })
    .catch((error) => note(`settings click: ${error}`));
  await sleep(4_000);
  await shoot(page, "11-settings");
  await page
    .locator('a:has-text("Connections"), button:has-text("Connections")')
    .first()
    .click({ force: true })
    .catch((error) => note(`connections click: ${error}`));
  await sleep(6_000);
  await shoot(page, "12-connections");
  const text = await bodyText(page);
  check("the connections page renders", text.trim().length > 40, text);
  check("it names both providers", /Claude/.test(text) && /Codex/.test(text), text);
  note(`connections: ${text.replaceAll("\n", " | ").slice(0, 900)}`);

  const connect = page.locator('button:has-text("Open Claude sign-in")').first();
  if ((await connect.count()) === 0) {
    check("a provider sign-in control exists", false, text);
    return;
  }
  await connect.click({ force: true }).catch((error) => note(`connect click: ${error}`));
  await sleep(8_000);
  await shoot(page, "13-connect-clicked");
  const after = await bodyText(page);
  check("connecting says something", after !== text, after);
  note(`after connect: ${after.replaceAll("\n", " | ").slice(0, 900)}`);
}

async function publishPhase({ page, origin }) {
  phase("publish");
  await page.goto(`${origin}/`, { waitUntil: "domcontentloaded" }).catch(() => undefined);
  await sleep(6_000);
  const publish = page.locator('button[aria-label^="Publish "]').first();
  check("the dashboard offers Publish", (await publish.count()) > 0, await bodyText(page));
  if ((await publish.count()) === 0) return;
  await publish.click({ force: true }).catch((error) => note(`publish click: ${error}`));
  await sleep(4_000);
  await shoot(page, "09-publish-dialog");
  const dialog = await bodyText(page);
  check("the publish dialog opens", /Publish as a pack/.test(dialog), dialog);
  if (!/Publish as a pack/.test(dialog)) return;

  const confirm = page.locator('[data-testid="publish-pack-confirm"]').first();
  if ((await confirm.count()) === 0) {
    check("the dialog has a Publish button", false, dialog);
    return;
  }

  // Publishing with the fields empty only proves the validation works, and the
  // report is about the button that publishes.
  await page
    .locator('[data-testid="publish-pack-summary"]')
    .fill("A folder with two files in it, published by the smoke run.")
    .catch(() => undefined);
  await page
    .locator('[data-testid="publish-pack-handover"]')
    .fill("Built nothing; this is a smoke test. Nothing was tried. Everything is undone.")
    .catch(() => undefined);
  await sleep(500);
  await confirm.click().catch((error) => note(`confirm click: ${error}`));

  // The dialog answers with a toast, and toasts do not wait around, so look
  // while it is still on screen and again once the request has had its time.
  await sleep(3_000);
  await shoot(page, "10-publishing");
  note(`3s after publish: ${(await bodyText(page)).replaceAll("\n", " | ").slice(0, 800)}`);
  await sleep(25_000);
  await shoot(page, "11-published");
  const after = await bodyText(page);
  check("publishing does not blank the app", after.trim().length > 40, after);
  check(
    "publishing leaves the dialog",
    !/Publish as a pack/.test(after),
    after.includes("Could not publish") ? "the dialog reported a failure" : after,
  );
  note(`after publish: ${after.replaceAll("\n", " | ").slice(0, 800)}`);
}

/**
 * Everything else a person can reach in two clicks. It asserts almost nothing
 * beyond "the page still has content", because the value is in the listeners:
 * a route that throws shows up as a `pageerror` with a stack whether or not
 * this run knew what to expect there.
 */
async function sweepPhase({ page, origin }) {
  phase("sweep");
  const routes = [
    "/",
    "/settings/general",
    "/settings/account",
    "/settings/connections",
    "/settings/organization",
    "/settings/archived",
  ];
  for (const route of routes) {
    await page.goto(`${origin}${route}`, { waitUntil: "domcontentloaded" }).catch(() => undefined);
    await sleep(4_000);
    const text = await bodyText(page);
    check(`${route} renders`, text.trim().length > 40, text);
    await shoot(page, `sweep${route.replaceAll("/", "-")}`);
  }

  await page.goto(`${origin}/`, { waitUntil: "domcontentloaded" }).catch(() => undefined);
  await sleep(5_000);
  await openProject(page);

  // The chrome around a thread: each of these is a component that can throw on
  // its own, and none of them is reached by any other phase.
  for (const [label, selector] of [
    ["workspace panel", 'button[aria-label="Toggle workspace panel"]'],
    ["terminal drawer", 'button[aria-label*="terminal" i]'],
    ["packs menu", 'button:has-text("Packs")'],
    ["runtime mode", 'button:has-text("Build")'],
    ["access mode", 'button:has-text("Full access")'],
    ["thread overflow", 'button[aria-label*="more" i]'],
  ]) {
    const control = page.locator(selector).first();
    if ((await control.count()) === 0) {
      note(`no ${label} control on screen`);
      continue;
    }
    await control.click({ force: true }).catch((error) => note(`${label} click: ${error}`));
    await sleep(2_500);
    await shoot(page, `sweep-${label.replaceAll(" ", "-")}`);
    const text = await bodyText(page);
    check(`${label} survives a click`, text.trim().length > 40, text);
    await page.keyboard.press("Escape").catch(() => undefined);
    await sleep(1_000);
  }
}

await main();
