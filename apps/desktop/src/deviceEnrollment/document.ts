/**
 * The connect window's document, generated in-process.
 *
 * Built as a string and served as a `data:` URL for the same reason the notch
 * panel is (`notchPanelDocument.ts`): the desktop bundler emits only `.cjs`
 * entries, so a loose `.html` under `src/` would exist in the repo and be
 * missing from every packaged build — and this screen is the first thing a new
 * install shows, which is the worst possible place for an asset that only fails
 * in production.
 *
 * The page carries no script of its own. State is pushed in from the main
 * process, and clicks come back through the preload by data attribute. That
 * matters more here than on the notch: this window is the only surface a person
 * has before they have an account, so it must render with no network, no
 * fonts, and no renderer-side logic that could fail and leave them staring at
 * a blank frame.
 *
 * `resolveEnrollmentView` is the part worth testing — it is the mapping from
 * "what the state machine believes" to "what the person is told and may click",
 * and the requirement it exists to satisfy is that every state has a way out.
 *
 * @module DeviceEnrollment
 */

import type { DeviceEnrollmentPhase, DeviceEnrollmentState } from "./machine.ts";

/** The hook the preload looks for. Shared so the button and its listener cannot drift. */
export const ENROLLMENT_ACTION_ATTRIBUTE = "data-enroll-action";

/** Page → main. The only message this window sends. */
export const ENROLLMENT_ACTION_CHANNEL = "desktop:device-enrollment-action";

export type EnrollmentWindowAction = "connect" | "open-browser" | "restart" | "dismiss";

export const ENROLLMENT_WINDOW_ACTIONS: readonly EnrollmentWindowAction[] = [
  "connect",
  "open-browser",
  "restart",
  "dismiss",
];

export function isEnrollmentWindowAction(value: unknown): value is EnrollmentWindowAction {
  return typeof value === "string" && ENROLLMENT_WINDOW_ACTIONS.some((action) => action === value);
}

export interface EnrollmentActionButton {
  readonly action: EnrollmentWindowAction;
  readonly label: string;
  readonly primary: boolean;
}

export interface EnrollmentView {
  readonly phase: DeviceEnrollmentPhase;
  readonly headline: string;
  readonly detail: string;
  /** Drives the progress bar. Never true in a phase without a pending request. */
  readonly busy: boolean;
  readonly actions: readonly EnrollmentActionButton[];
}

const START_OVER: EnrollmentActionButton = {
  action: "restart",
  label: "Start over",
  primary: true,
};
const NOT_NOW: EnrollmentActionButton = { action: "dismiss", label: "Not now", primary: false };
const CLOSE: EnrollmentActionButton = { action: "dismiss", label: "Close", primary: true };

/**
 * What this state looks like to the person in front of it.
 *
 * The invariant this function exists to hold: **no phase renders zero actions
 * while not busy.** A screen with nothing to click and nothing happening is the
 * dead end this whole flow was written to avoid, and it is asserted in the
 * tests against every member of the phase union rather than the handful someone
 * remembered.
 */
export function resolveEnrollmentView(
  state: DeviceEnrollmentState,
  deviceLabel: string,
): EnrollmentView {
  const phase = state.phase;

  switch (phase) {
    case "idle": {
      return {
        phase,
        headline: "Connect this machine",
        detail: `We'll open your browser so you can approve “${deviceLabel}” on the account you're already signed in to.`,
        busy: false,
        actions: [{ action: "connect", label: "Connect", primary: true }, NOT_NOW],
      };
    }
    case "requesting": {
      return {
        phase,
        headline: "Preparing…",
        detail: "Asking for a one-time approval request.",
        busy: true,
        actions: [NOT_NOW],
      };
    }
    case "waiting": {
      return {
        phase,
        headline: "Waiting for approval",
        detail: `Approve “${deviceLabel}” in the browser tab we opened. This request expires in ten minutes.`,
        busy: true,
        // Reopening the page matters more than it looks: the tab is easy to
        // close by accident, and without this the only recovery is a new code.
        actions: [
          { action: "open-browser", label: "Open the page again", primary: true },
          { action: "restart", label: "Start over", primary: false },
          NOT_NOW,
        ],
      };
    }
    case "approved": {
      return {
        phase,
        headline: "Approved",
        detail: "Finishing up — collecting this machine's credentials.",
        busy: true,
        actions: [],
      };
    }
    case "collecting": {
      return {
        phase,
        headline: "Approved",
        detail: "Finishing up — collecting this machine's credentials.",
        busy: true,
        actions: [],
      };
    }
    case "connected": {
      return {
        phase,
        headline: "This machine is connected",
        detail: `“${deviceLabel}” has joined your account. You can close this window.`,
        busy: false,
        actions: [CLOSE],
      };
    }
    case "denied": {
      return {
        phase,
        headline: "Not approved",
        detail:
          state.message ??
          "The request was turned down in the browser. Nothing was connected to this machine.",
        busy: false,
        actions: [START_OVER, NOT_NOW],
      };
    }
    case "expired": {
      return {
        phase,
        headline: "The request timed out",
        detail:
          state.message ?? "Approval requests last ten minutes. Start over to get a fresh one.",
        busy: false,
        actions: [START_OVER, NOT_NOW],
      };
    }
    case "failed": {
      return {
        phase,
        headline: "Couldn't connect",
        detail: state.message ?? "Something went wrong reaching the service.",
        busy: false,
        actions: [{ action: "restart", label: "Try again", primary: true }, NOT_NOW],
      };
    }
  }
}

/**
 * `JSON.stringify` with `<` escaped.
 *
 * Plain `JSON.stringify` leaves `</script>` intact, so a machine whose hostname
 * contained one would close a script element if this payload were ever placed
 * inside a document. Today it is not — it is evaluated through
 * `executeJavaScript`, where no HTML parser is involved — but that is a
 * property of the current caller rather than of this function, and the fix is
 * one replacement that makes the string safe wherever it ends up.
 */
function encodeScriptPayload(value: unknown): string {
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}

export const ENROLLMENT_WINDOW_WIDTH = 460;
export const ENROLLMENT_WINDOW_HEIGHT = 340;

/**
 * The static structure. Everything that changes is a slot the update script
 * writes into, so the page is laid out exactly once and no state transition can
 * reflow it or leave a half-rendered frame.
 */
export function buildEnrollmentDocumentHtml(): string {
  return `<!doctype html>
<html lang="en" data-enroll-phase="idle" data-enroll-busy="false">
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'" />
<title>Connect this machine</title>
<style>
  :root {
    color-scheme: light dark;
    --enroll-bg: #ffffff;
    --enroll-fg: #101114;
    --enroll-muted: #5c6070;
    --enroll-line: #e2e4ea;
    --enroll-accent: #3b5bdb;
    --enroll-accent-fg: #ffffff;
    --enroll-ghost-bg: transparent;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --enroll-bg: #16171b;
      --enroll-fg: #f2f3f5;
      --enroll-muted: #9aa0ae;
      --enroll-line: #2c2e35;
      --enroll-accent: #5c7cfa;
      --enroll-accent-fg: #0b0c0f;
    }
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body {
    background: var(--enroll-bg);
    color: var(--enroll-fg);
    font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Ubuntu, sans-serif;
    display: flex;
    flex-direction: column;
    padding: 26px 28px 22px;
    user-select: none;
    -webkit-user-select: none;
  }
  h1 {
    font-size: 17px;
    font-weight: 620;
    letter-spacing: -0.01em;
    margin: 0 0 8px;
  }
  p {
    margin: 0;
    color: var(--enroll-muted);
    /* The detail line carries server text and device names, so it must wrap
       rather than widen a window whose size is fixed at creation. */
    overflow-wrap: anywhere;
  }
  .content { flex: 1 1 auto; }
  .progress {
    height: 2px;
    margin: 18px 0 0;
    border-radius: 2px;
    background: var(--enroll-line);
    overflow: hidden;
    visibility: hidden;
  }
  html[data-enroll-busy="true"] .progress { visibility: visible; }
  .progress > i {
    display: block;
    height: 100%;
    width: 38%;
    border-radius: 2px;
    background: var(--enroll-accent);
    animation: slide 1.25s ease-in-out infinite;
  }
  @keyframes slide {
    0% { transform: translateX(-100%); }
    100% { transform: translateX(300%); }
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    justify-content: flex-end;
    border-top: 1px solid var(--enroll-line);
    padding-top: 16px;
    margin-top: 16px;
    min-height: 33px;
  }
  button {
    font: inherit;
    font-weight: 550;
    border-radius: 7px;
    border: 1px solid var(--enroll-line);
    padding: 6px 14px;
    background: var(--enroll-ghost-bg);
    color: var(--enroll-fg);
    cursor: pointer;
  }
  button[data-enroll-primary="true"] {
    background: var(--enroll-accent);
    border-color: var(--enroll-accent);
    color: var(--enroll-accent-fg);
  }
  button:focus-visible { outline: 2px solid var(--enroll-accent); outline-offset: 2px; }
</style>
</head>
<body>
  <div class="content">
    <h1 data-enroll-headline>Connect this machine</h1>
    <p data-enroll-detail></p>
    <div class="progress"><i></i></div>
  </div>
  <div class="actions" data-enroll-actions role="group" aria-label="Connect this machine"></div>
</body>
</html>`;
}

export function buildEnrollmentDataUrl(): string {
  return `data:text/html;charset=utf-8,${encodeURIComponent(buildEnrollmentDocumentHtml())}`;
}

/**
 * The script main evaluates in the page to show a view.
 *
 * Buttons are rebuilt through `createElement`/`textContent` rather than an
 * `innerHTML` assignment, so a device label or a server-supplied message can
 * never be parsed as markup in a window that runs before the person has
 * authenticated anything.
 */
export function buildEnrollmentViewScript(view: EnrollmentView): string {
  const payload = encodeScriptPayload({
    phase: view.phase,
    headline: view.headline,
    detail: view.detail,
    busy: view.busy,
    actions: view.actions.map((button) => ({
      action: button.action,
      label: button.label,
      primary: button.primary,
    })),
  });

  return `(() => {
  const view = ${payload};
  const root = document.documentElement;
  root.dataset.enrollPhase = view.phase;
  root.dataset.enrollBusy = view.busy ? "true" : "false";
  const headline = document.querySelector("[data-enroll-headline]");
  if (headline) headline.textContent = view.headline;
  const detail = document.querySelector("[data-enroll-detail]");
  if (detail) detail.textContent = view.detail;
  const actions = document.querySelector("[data-enroll-actions]");
  if (actions) {
    actions.replaceChildren();
    for (const item of view.actions) {
      const button = document.createElement("button");
      button.type = "button";
      button.setAttribute(${JSON.stringify(ENROLLMENT_ACTION_ATTRIBUTE)}, item.action);
      button.setAttribute("data-enroll-primary", item.primary ? "true" : "false");
      button.textContent = item.label;
      actions.append(button);
    }
  }
})();`;
}
