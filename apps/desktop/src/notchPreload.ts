/**
 * The notch panel's preload: one click, travelling one way.
 *
 * The panel is a generated `data:` URL with no script of its own, driven from
 * the main process by evaluated DOM assignments (`notchPanelDocument.ts`). That
 * is a fine arrangement for drawing, and no arrangement at all for a button —
 * evaluation only runs main -> page. So the panel gets a preload of its own,
 * and this is deliberately the smallest one that can exist:
 *
 * - **Nothing is exposed to the page.** There is no `contextBridge` call here,
 *   because there is nothing in the document that could call it. The listener
 *   lives in the isolated world and reads the DOM it already shares, so the
 *   page's own world gains no new capability and `sandbox`/`contextIsolation`
 *   stay exactly as they were.
 * - **The channel carries no payload.** Main does not need to be told anything;
 *   it needs to be told *that*. Nothing crosses that main would have to trust.
 * - **It is a separate entry from `preload.ts`** rather than a flag on it. The
 *   app window's bridge is a wide surface, and none of it belongs on an
 *   always-on-top overlay that anything on screen can point at.
 *
 * Main still decides whether the click is possible at all: the window is
 * click-through except while the panel is expanded over an actionable state,
 * so in every other state this listener is attached to events that cannot
 * arrive. See `notchWindow.ts`.
 */

import { ipcRenderer } from "electron";

import { NOTCH_ACTION_BUTTON_ATTRIBUTE, NOTCH_SIGN_IN_CHANNEL } from "./notchPanelDocument.ts";

const ACTION_BUTTON_SELECTOR = `[${NOTCH_ACTION_BUTTON_ATTRIBUTE}]`;

window.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof Element)) {
    return;
  }
  // `closest` rather than an equality check: the button has a text node inside
  // it, and a click landing on that has the text node's parent as its target.
  if (target.closest(ACTION_BUTTON_SELECTOR) === null) {
    return;
  }
  ipcRenderer.send(NOTCH_SIGN_IN_CHANNEL);
});
