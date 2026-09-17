import React from "react";
import ReactDOM from "react-dom/client";
import { RouterProvider } from "@tanstack/react-router";
import { createHashHistory, createBrowserHistory } from "@tanstack/react-router";

import "@xterm/xterm/css/xterm.css";
import "./index.css";

import { isElectron } from "./env";
import { getRouter } from "./router";
import { APP_DISPLAY_NAME } from "./branding";
import { syncDocumentWindowControlsOverlayClass } from "./lib/windowControlsOverlay";

/**
 * A tab left open across a redeploy holds an `index.html` referencing chunk
 * hashes that no longer exist on disk. The server's static handler has no
 * concept of "gone" for an asset request — any missing file falls through to
 * serving `index.html` itself (so a client-side route always has something to
 * render), which means a stale chunk's `import()` gets back real HTML with
 * `content-type: text/html`, and the browser's module loader correctly
 * refuses to execute it — the exact "'text/html' is not a valid JavaScript
 * MIME type" crash. Vite fires `vite:preloadError` on `window` for exactly
 * this failure; reloading once picks up the current `index.html` and its
 * matching chunks. The `sessionStorage` flag stops a genuinely broken deploy
 * (not just a stale tab) from reload-looping forever.
 */
function installChunkLoadErrorRecovery(): void {
  window.addEventListener("vite:preloadError", () => {
    const key = "t3code:chunk-reload-attempted";
    if (window.sessionStorage.getItem(key) === "1") {
      return;
    }
    window.sessionStorage.setItem(key, "1");
    window.location.reload();
  });
}
installChunkLoadErrorRecovery();

// Electron loads the app from a file-backed shell, so hash history avoids path resolution issues.
const history = isElectron ? createHashHistory() : createBrowserHistory();

const router = getRouter(history);

if (isElectron) {
  syncDocumentWindowControlsOverlayClass();
}

document.title = APP_DISPLAY_NAME;

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>,
);

// A successful mount means this tab is now running current chunks — clear
// the one-reload guard so a *future* redeploy can still trigger one more
// automatic recovery instead of silently doing nothing for the rest of this
// tab's life.
window.sessionStorage.removeItem("t3code:chunk-reload-attempted");
