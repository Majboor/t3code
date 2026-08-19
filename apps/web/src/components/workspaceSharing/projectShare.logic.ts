import type { DesktopWorkspaceShareState, EnvironmentId, ProjectId } from "@t3tools/contracts";

import type { WorkspaceShareTone } from "./workspaceSharing.logic";

export type ProjectShareLinkKind = "tunnel" | "cloud" | "share-link";

export interface ProjectShareLinkKindNote {
  readonly kind: ProjectShareLinkKind;
  readonly title: string;
  /** How long a link of this kind survives — the difference that ruins a share. */
  readonly lifetime: string;
  /** Where the person gets one, when it is not from this control. */
  readonly source: string;
}

/**
 * Three different things are called "a link" in this app and only one of them is
 * started here. Naming the other two beside it is the whole point: a tunnel link
 * pasted into a colleague's inbox is dead by morning, and someone who never
 * learned there was a durable alternative has no way to know that before it
 * happens.
 */
export const PROJECT_SHARE_TUNNEL_KIND: ProjectShareLinkKindNote = {
  kind: "tunnel",
  title: "Live link from this computer",
  lifetime: "Ends when you stop sharing, quit T3 Code, or close this laptop.",
  source: "Started here.",
};

/** Every kind this control cannot start, so nobody assumes the tunnel is all there is. */
export const PROJECT_SHARE_OTHER_KINDS: readonly ProjectShareLinkKindNote[] = [
  {
    kind: "cloud",
    title: "Cloud link",
    lifetime: "Outlives this laptop — keeps working once the copy is up there.",
    source: "Needs this project synced first: use the Cloud control beside this one.",
  },
  {
    kind: "share-link",
    title: "Share link",
    lifetime: "Lasts until you revoke it.",
    source: "Scoped to one file, project, or workspace: made in the Files panel.",
  },
];

export const PROJECT_SHARE_LINK_KINDS: readonly ProjectShareLinkKindNote[] = [
  PROJECT_SHARE_TUNNEL_KIND,
  ...PROJECT_SHARE_OTHER_KINDS,
];

/**
 * The tunnel publishes the machine, not the project, and the header button sits
 * on a project. Someone who shares from here while looking at one project has to
 * be told the guest can reach the rest.
 */
export const PROJECT_SHARE_TUNNEL_SCOPE_NOTE =
  "The tunnel publishes this whole workspace, not only this project. The link below just opens on this project.";

export interface ProjectShareTriggerPresentation {
  /** Stable value for `data-share-status`, so state is assertable and greppable. */
  readonly status: string;
  readonly tone: WorkspaceShareTone;
  readonly badgeLabel: string | null;
  readonly ariaLabel: string;
  readonly isBusy: boolean;
  readonly isDisabled: boolean;
}

/**
 * What the header button says about itself before anyone opens it.
 *
 * Live and not-live have to be separable at a glance: the state being described
 * is "my computer is on the public internet right now", and a person should
 * never have to open a panel to find that out.
 */
export function describeProjectShareTrigger(input: {
  readonly state: DesktopWorkspaceShareState;
  readonly isDesktop: boolean;
}): ProjectShareTriggerPresentation {
  if (!input.isDesktop) {
    return {
      status: "unsupported",
      tone: "idle",
      badgeLabel: null,
      ariaLabel: "Public sharing runs from the desktop app",
      isBusy: false,
      isDisabled: true,
    };
  }

  switch (input.state.status) {
    case "live":
      return {
        status: "live",
        tone: "live",
        badgeLabel: "Live",
        ariaLabel: "Sharing is live — copy or stop the public link",
        isBusy: false,
        isDisabled: false,
      };

    case "starting":
      return {
        status: "starting",
        tone: "pending",
        badgeLabel: "Starting",
        ariaLabel: "Starting the public link",
        isBusy: true,
        isDisabled: false,
      };

    case "stopping":
      return {
        status: "stopping",
        tone: "pending",
        badgeLabel: "Stopping",
        ariaLabel: "Stopping the public link",
        isBusy: true,
        isDisabled: false,
      };

    case "unavailable":
      return {
        status: "unavailable",
        tone: "warning",
        badgeLabel: "Setup",
        ariaLabel: "Sharing needs cloudflared installed",
        isBusy: false,
        isDisabled: false,
      };

    case "failed":
      return {
        status: "failed",
        tone: "error",
        badgeLabel: "Failed",
        ariaLabel: "Sharing failed — open for details",
        isBusy: false,
        isDisabled: false,
      };

    default:
      return {
        status: "not-shared",
        tone: "idle",
        badgeLabel: null,
        ariaLabel: "Share this project — get a link you can send",
        isBusy: false,
        isDisabled: false,
      };
  }
}

/**
 * The tunnel's own URL lands on whatever the workspace opens by default, which
 * makes the recipient hunt for the project the sender was looking at. The path
 * is the same one a signed-out browser is handed, so it resolves for a stranger.
 *
 * An address cloudflared handed back that will not parse is still a working
 * public link, so it is passed through rather than withheld.
 */
export function buildTunnelProjectUrl(input: {
  readonly shareUrl: string | null;
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}): string | null {
  if (!input.shareUrl) return null;

  try {
    const url = new URL(input.shareUrl);
    url.pathname = `/project/${encodeURIComponent(input.environmentId)}/${encodeURIComponent(
      input.projectId,
    )}`;
    return url.toString();
  } catch {
    return input.shareUrl;
  }
}
