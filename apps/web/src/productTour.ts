/**
 * Step config for the in-app product tour. A flat, ordered array — add one
 * object to cover a new feature, nothing else to wire up.
 *
 * Every step anchors on a real `data-tour`/`aria-label`/`data-testid`
 * selector already used by the element it describes (added alongside this
 * file, or already present). The engine (`ProductTourOverlay.tsx`) treats a
 * missing anchor as "not reachable right now" rather than an error — it waits
 * briefly, then skips to the next step — so a step for a feature the current
 * user hasn't unlocked yet (no project, no git repo, nothing to share) never
 * blocks the rest of the tour.
 */
export interface ProductTourStep {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  /** CSS selector for the element to spotlight. */
  readonly selector: string;
  /** Route to navigate to first, only if the current path doesn't match. */
  readonly route?: string;
  readonly placement?: "top" | "bottom" | "left" | "right";
}

export const PRODUCT_TOUR_STEPS: readonly ProductTourStep[] = [
  {
    id: "sidebar-thread-list",
    title: "Your projects and threads",
    body: "Every project you've added and every conversation inside it lives here. Pick one up where you left off, or start a new thread.",
    selector: '[data-tour="sidebar-thread-list"]',
    placement: "right",
  },
  {
    id: "sidebar-utility-environments",
    title: "Environments",
    body: "Connect a machine — your own laptop or a remote box — so agents can run commands and deploys somewhere real.",
    selector: '[data-tour="sidebar-utility-environments"]',
    placement: "right",
  },
  {
    id: "sidebar-utility-settings",
    title: "Settings",
    body: "Provider accounts, layout preferences, and everything else that's yours to configure lives here.",
    selector: '[data-tour="sidebar-utility-settings"]',
    placement: "right",
  },
  {
    id: "composer",
    title: "Talk to your agent",
    body: "Type here to send a message. Drag a file in from the workspace panel to reference it, or drop an image to attach it.",
    selector: '[data-chat-composer-form="true"]',
    placement: "top",
  },
  {
    id: "view-options-menu",
    title: "Dev and Vibe layouts",
    body: 'Switch between a chat-first "Vibe" layout and a file-first "Dev" layout from here — along with the workspace, terminal, and diff panels.',
    selector: '[aria-label="View options"]',
    placement: "bottom",
  },
  {
    id: "workspace-toggle",
    title: "The workspace panel",
    body: "Open it to browse, upload, rename, and delete files in your project — and to edit code directly.",
    selector: '[aria-label="Toggle workspace panel"]',
    placement: "bottom",
  },
  {
    id: "provider-status-banner",
    title: "Provider status",
    body: "If a turn can't run — no account connected, or one that's stopped working — this banner says why and gets you to a fix immediately.",
    selector: '[data-tour="provider-status-banner"]',
    placement: "bottom",
  },
  {
    id: "git-actions",
    title: "Git, right in the chat",
    body: "Commit, push, pull, and open pull requests without leaving the conversation.",
    selector: '[aria-label="Git actions"]',
    placement: "bottom",
  },
  {
    id: "infra-link",
    title: "Infrastructure",
    body: "See what this project has deployed and turned on — and its analytics — without leaving the thread.",
    selector: '[data-testid="chat-header-infra-link"]',
    placement: "bottom",
  },
  {
    id: "share-project",
    title: "Share this project",
    body: "Invite someone to collaborate on this workspace directly from here.",
    selector: '[data-tour="share-project"]',
    placement: "bottom",
  },
  {
    id: "provider-accounts-section",
    title: "Connect a provider account",
    body: "This is where you sign in with Claude or Codex. Connect as many accounts as you have — your turns run on whichever one is marked default.",
    selector: '[data-tour="provider-accounts-section"]',
    route: "/settings/connections",
    placement: "bottom",
  },
];
