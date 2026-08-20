/**
 * The connect window's preload: one click, travelling one way.
 *
 * Modelled on `notchPreload.ts`, and small for the same reasons — with one
 * extra that matters more here. This window is the surface a person sees
 * *before* they have an account, so it is the last place that should hold a
 * wide IPC bridge. Nothing is exposed to the page: there is no `contextBridge`
 * call, the listener runs in the isolated world against the DOM it already
 * shares, and `sandbox`/`contextIsolation` stay exactly as they were.
 *
 * The one thing that does cross is the action name, and main validates it
 * rather than trusting it (`isEnrollmentWindowAction`). The document is
 * generated in-process so the set of buttons is known, but "the page can only
 * send strings main already recognises" is a property worth holding by check
 * rather than by assumption about who wrote the page.
 *
 * It is a separate bundle from `preload.ts` for the same reason the notch's is:
 * the app window's bridge exposes settings, secrets and the environment
 * registry, and none of that belongs on a pre-auth window.
 */

import { ipcRenderer } from "electron";

import {
  ENROLLMENT_ACTION_ATTRIBUTE,
  ENROLLMENT_ACTION_CHANNEL,
} from "./deviceEnrollment/document.ts";

const ACTION_SELECTOR = `[${ENROLLMENT_ACTION_ATTRIBUTE}]`;

window.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof Element)) {
    return;
  }
  // `closest` rather than an equality check: the button holds a text node, and
  // a click landing on the text has that node's parent as its target.
  const button = target.closest(ACTION_SELECTOR);
  if (button === null) {
    return;
  }
  const action = button.getAttribute(ENROLLMENT_ACTION_ATTRIBUTE);
  if (!action) {
    return;
  }
  ipcRenderer.send(ENROLLMENT_ACTION_CHANNEL, action);
});
