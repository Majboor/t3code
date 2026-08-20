/**
 * The window the connect flow draws in.
 *
 * A `BaseWindow` + `WebContentsView` rather than a `BrowserWindow`, for the
 * reason `notchWindow.ts` gives: `main.ts` treats `BrowserWindow.getAllWindows()`
 * as "the app's windows" — `revealOrOpenAppWindow` reveals the first of them and
 * `window-all-closed` quits the app when the last one goes. A connect window
 * that joined that set would be revealed by the Dock icon instead of the
 * workspace, and closing it on Windows or Linux could take the app with it.
 * Staying out of that collection is the whole point.
 *
 * @module DeviceEnrollment
 */

import * as Path from "node:path";

import { BaseWindow, WebContentsView } from "electron";

import {
  buildEnrollmentDataUrl,
  buildEnrollmentViewScript,
  ENROLLMENT_WINDOW_HEIGHT,
  ENROLLMENT_WINDOW_WIDTH,
  type EnrollmentView,
} from "./document.ts";

export interface EnrollmentWindowController {
  /** Draws a view, opening the window the first time and revealing it after. */
  readonly present: (view: EnrollmentView) => void;
  readonly isOpen: () => boolean;
  readonly close: () => void;
}

export interface EnrollmentWindowOptions {
  /** Fired when the person closes the window themselves. */
  readonly onClosed: () => void;
}

export function createEnrollmentWindow(
  options: EnrollmentWindowOptions,
): EnrollmentWindowController {
  let window: BaseWindow | null = null;
  let view: WebContentsView | null = null;
  let loaded = false;
  /**
   * Held until the document finishes loading. Views are pushed from a poll loop
   * that starts the moment the window is asked for, and the first few can
   * easily land before the page exists — without this the opening frame would
   * show the static markup's placeholder instead of the real state.
   */
  let pendingView: EnrollmentView | null = null;

  const evaluate = (script: string): void => {
    const contents = view?.webContents;
    if (!contents || contents.isDestroyed()) {
      return;
    }
    void contents.executeJavaScript(script, true).catch(() => {
      // A destroyed or navigating page is not a failure worth surfacing: the
      // next `present` redraws from the same state.
    });
  };

  const open = (): void => {
    const created = new BaseWindow({
      width: ENROLLMENT_WINDOW_WIDTH,
      height: ENROLLMENT_WINDOW_HEIGHT,
      show: false,
      resizable: false,
      maximizable: false,
      fullscreenable: false,
      minimizable: false,
      title: "Connect this machine",
      autoHideMenuBar: true,
    });

    const created_view = new WebContentsView({
      webPreferences: {
        preload: Path.join(__dirname, "deviceEnrollmentPreload.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    created.contentView.addChildView(created_view);

    const syncBounds = (): void => {
      const { width, height } = created.getContentBounds();
      created_view.setBounds({ x: 0, y: 0, width, height });
    };
    syncBounds();
    created.on("resize", syncBounds);

    created_view.webContents.on("did-finish-load", () => {
      loaded = true;
      if (pendingView) {
        evaluate(buildEnrollmentViewScript(pendingView));
        pendingView = null;
      }
      created.show();
    });

    // Nothing in this document should ever navigate, and it has no links; a
    // window that could be steered elsewhere while holding a pre-auth preload is
    // not a window worth having.
    created_view.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

    created.on("closed", () => {
      window = null;
      view = null;
      loaded = false;
      pendingView = null;
      options.onClosed();
    });

    window = created;
    view = created_view;
    void created_view.webContents.loadURL(buildEnrollmentDataUrl());
  };

  return {
    present: (next) => {
      if (!window || window.isDestroyed()) {
        pendingView = next;
        open();
        return;
      }
      if (!loaded) {
        pendingView = next;
        return;
      }
      evaluate(buildEnrollmentViewScript(next));
      if (!window.isVisible()) {
        window.show();
      }
    },
    isOpen: () => window !== null && !window.isDestroyed(),
    close: () => {
      const current = window;
      window = null;
      view = null;
      loaded = false;
      pendingView = null;
      if (current && !current.isDestroyed()) {
        // The `closed` listener exists to notice the *person* closing this
        // window. Destroying it from code fires the same event, and a caller
        // that closes in response to `onClosed` would recurse — so the listener
        // is detached first and this path stays silent by construction.
        current.removeAllListeners("closed");
        current.destroy();
      }
    },
  };
}
