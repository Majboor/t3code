import type { ProjectId, ShareLink, ShareLinkError, ShareLinkScope } from "@t3tools/contracts";

/**
 * Everything the share-link UI decides without a server.
 *
 * The two things worth knowing before reading further:
 *
 * `create` is the only reply that ever carries a token, and `list` returns the
 * same row without it forever after. So a URL exists for exactly as long as the
 * creation call's `.then`, and every rule about showing one lives here rather
 * than being re-derived per component.
 *
 * The three scopes are three different acts — handing over one file, handing
 * over a project, and inviting somebody into a workspace to work in it — so
 * they get three descriptions rather than one sentence with the noun swapped.
 */

/**
 * Where a token is redeemed. The contract returns the token alone and no URL,
 * so the path is the client's to know; keeping it in one place means a server
 * that later returns a path has one line to replace.
 */
export const SHARE_LINK_PATH_PREFIX = "/s";

export function buildShareLinkUrl(token: string, origin: string): string {
  return `${origin.replace(/\/+$/, "")}${SHARE_LINK_PATH_PREFIX}/${encodeURIComponent(token)}`;
}

export type ShareLinkErrorCode = ShareLinkError["code"];

export function readShareLinkErrorCode(error: unknown): ShareLinkErrorCode | null {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return null;
  }
  switch ((error as { code: unknown }).code) {
    case "forbidden":
      return "forbidden";
    case "not-found":
      return "not-found";
    case "expired":
      return "expired";
    case "revoked":
      return "revoked";
    case "invalid-target":
      return "invalid-target";
    default:
      return null;
  }
}

export interface ShareLinkFailureNotice {
  readonly tone: "error" | "info";
  readonly title: string;
  readonly description: string;
}

export function describeShareLinkFailure(
  error: unknown,
  context: { readonly fallbackTitle: string },
): ShareLinkFailureNotice {
  switch (readShareLinkErrorCode(error)) {
    case "forbidden":
      return {
        tone: "error",
        title: "You cannot share this",
        description:
          "Handing this out to people outside the workspace is an admin's call. Ask someone who can manage this workspace to make the link.",
      };
    case "not-found":
      return {
        tone: "info",
        title: "That link is gone",
        description: "Somebody deleted it, or the thing it pointed at no longer exists.",
      };
    case "expired":
      return {
        tone: "info",
        title: "That link had already lapsed",
        description: "Make a new one if it is still needed.",
      };
    case "revoked":
      return {
        tone: "info",
        title: "That link was already switched off",
        description: "Nothing more to do — it stopped working when it was revoked.",
      };
    case "invalid-target":
      return {
        tone: "error",
        title: "Nothing to point the link at",
        description: "Open the project first, then share from inside it.",
      };
    case null:
      return {
        tone: "error",
        title: context.fallbackTitle,
        description: error instanceof Error ? error.message : "The request failed.",
      };
  }
}

/**
 * `revoked` beats `expired` when both apply: switching a link off is something
 * a person did, and reporting the lapse instead would hide it.
 */
export type ShareLinkState = "active" | "expired" | "revoked";

export function readShareLinkState(link: ShareLink, nowIso: string): ShareLinkState {
  if (link.revokedAt !== null) {
    return "revoked";
  }
  if (link.expiresAt !== null && link.expiresAt <= nowIso) {
    return "expired";
  }
  return "active";
}

/** What a row is called when its maker gave it no label. */
export function describeShareLinkTarget(link: ShareLink): string {
  if (link.scope === "file") {
    return link.filePath ?? "A file";
  }
  if (link.scope === "project") {
    return "Whole project";
  }
  return "Whole workspace";
}

export function shareLinkTitle(link: ShareLink): string {
  return link.label ?? describeShareLinkTarget(link);
}

/**
 * Views are the only evidence of what a public link actually did, so zero says
 * so out loud instead of rendering "0" next to the counts that mean something.
 */
export function describeShareLinkViews(link: ShareLink): string {
  if (link.viewCount === 0) {
    return "Not opened yet";
  }
  const views = `${link.viewCount} ${link.viewCount === 1 ? "view" : "views"}`;
  return link.lastViewedAt === null
    ? views
    : `${views} · last ${formatShareLinkTime(link.lastViewedAt)}`;
}

export function formatShareLinkTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** The sentence under a row, once its state is known. */
export function describeShareLinkState(link: ShareLink, nowIso: string): string {
  const state = readShareLinkState(link, nowIso);
  if (state === "revoked" && link.revokedAt !== null) {
    return `Stopped working ${formatShareLinkTime(link.revokedAt)}`;
  }
  if (state === "expired" && link.expiresAt !== null) {
    return `Lapsed ${formatShareLinkTime(link.expiresAt)}`;
  }
  if (link.expiresAt !== null) {
    return `Works until ${formatShareLinkTime(link.expiresAt)}`;
  }
  return "Works until you revoke it";
}

export interface ShareLinkScopeCopy {
  /** The button, phrased as the act rather than as the object. */
  readonly action: string;
  /** What happens to whoever opens it. Said before the link is made. */
  readonly consequence: string;
  readonly badge: string;
}

/**
 * A workspace link makes the visitor a colleague; a file link makes one file
 * public. Presenting those as one control with a scope picker would let a
 * mis-click on a dropdown hand over the workspace, so each gets its own
 * sentence and its own button.
 */
export function describeShareLinkScope(
  scope: ShareLinkScope,
  names: {
    readonly projectLabel: string;
    readonly workspaceLabel: string;
  },
): ShareLinkScopeCopy {
  switch (scope) {
    case "file":
      return {
        action: "Copy share link",
        consequence:
          "Anyone with the URL can read this one file. They need no account, and forwarding the URL passes the access along.",
        badge: "File",
      };
    case "project":
      return {
        action: `Make a link to ${names.projectLabel}`,
        consequence: `Anyone with the URL can read every file in ${names.projectLabel}. They need no account and cannot change anything.`,
        badge: "Project",
      };
    case "workspace":
      return {
        action: `Invite someone into ${names.workspaceLabel}`,
        consequence: `Opening this link joins ${names.workspaceLabel} as a collaborator: they get every project in it and can work in them. Send it to people, not to channels.`,
        badge: "Workspace",
      };
  }
}

export interface ShareLinkTargetInput {
  readonly scope: ShareLinkScope;
  readonly projectId: ProjectId | null;
  readonly filePath: string | null;
}

export type ShareLinkTargetCheck =
  | { readonly ok: true; readonly projectId: ProjectId | null; readonly filePath: string | null }
  | { readonly ok: false; readonly reason: string };

/**
 * The client's half of `invalid-target`. The server enforces this too, but a
 * button that cannot succeed should be off rather than produce a red toast, and
 * the fields are cleared here so a project link cannot carry a stale file path
 * from whatever was open when it was made.
 */
export function checkShareLinkTarget(input: ShareLinkTargetInput): ShareLinkTargetCheck {
  if (input.scope === "workspace") {
    return { ok: true, projectId: null, filePath: null };
  }
  if (input.projectId === null) {
    return { ok: false, reason: "Open a project before sharing from it." };
  }
  if (input.scope === "project") {
    return { ok: true, projectId: input.projectId, filePath: null };
  }
  const filePath = input.filePath?.trim() ?? "";
  if (filePath.length === 0) {
    return { ok: false, reason: "Pick a file to share." };
  }
  return { ok: true, projectId: input.projectId, filePath };
}

/** Newest first: the link somebody just made is the one they are looking for. */
export function sortShareLinks(links: readonly ShareLink[]): readonly ShareLink[] {
  return [...links].toSorted((left, right) => right.createdAt.localeCompare(left.createdAt));
}

/**
 * What one project's panel is answerable for.
 *
 * The read is workspace-wide because a workspace link belongs to no project and
 * narrowing the call would drop it — but another project's links are somebody
 * else's business, so they are filtered out here rather than listed under a
 * heading that does not describe them.
 */
export function selectShareLinksForPanel(
  links: readonly ShareLink[],
  projectId: ProjectId | null,
): readonly ShareLink[] {
  return sortShareLinks(
    links.filter((link) => link.scope === "workspace" || link.projectId === projectId),
  );
}

/**
 * What to say the moment a link exists.
 *
 * A failed clipboard write is not a cosmetic problem here: the token was
 * returned once, nothing can fetch it again, and a link nobody holds is a live
 * public URL that its own maker cannot use. So that case says so and the caller
 * shows the URL, which is the only remaining chance to read it.
 */
export function describeMintedShareLink(input: {
  readonly scope: ShareLinkScope;
  readonly copied: boolean;
}): { readonly tone: "success" | "error"; readonly title: string; readonly description: string } {
  if (input.copied) {
    return {
      tone: "success",
      title: input.scope === "workspace" ? "Invite link copied" : "Share link copied",
      description:
        input.scope === "workspace"
          ? "Paste it to the person you meant to invite. It is not shown again."
          : "Paste it wherever you meant to send it. It is not shown again.",
    };
  }
  return {
    tone: "error",
    title: "The link was made but not copied",
    description: "Copy it from the panel now — this is the only time it can be read.",
  };
}
