import type {
  ShareLink,
  ShareLinkCreateInput,
  ShareLinkCreateResult,
  ShareLinkError,
  ShareLinkListInput,
  ShareLinkListResult,
  ShareLinkRevokeInput,
  ShareLinkRevokeResult,
  UserId,
} from "@t3tools/contracts";
import { Context, type Effect } from "effect";

/**
 * Whoever is minting, listing or switching off a link.
 *
 * Structurally the collaboration actor, and deliberately so: membership is read
 * from the collaboration roster, so the same person has to be recognisable to
 * both. Nothing here comes off the wire — the caller's identity comes from the
 * session, which is what stops "create a link in this workspace" from being a
 * claim anyone can make about any workspace.
 */
export interface ShareLinkActor {
  readonly userId: UserId;
  readonly displayName: string;
  readonly avatarInitials?: string;
}

/** One file inside a project listing. Names and sizes, never contents. */
export interface ShareLinkProjectEntry {
  readonly path: string;
  readonly sizeBytes: number;
}

/**
 * A file served from a link — either the one a `file` link names, or the one a
 * visitor picked out of a `project` link's listing.
 *
 * Bytes rather than text. What is on the far end of a path is not this
 * service's decision to make, and decoding it as UTF-8 here would mean a stray
 * byte in an otherwise readable file came back mangled with no way to tell.
 */
export interface ShareLinkFileRedemption {
  readonly kind: "file";
  readonly link: ShareLink;
  /** Project-relative and already proven to resolve inside the project root. */
  readonly filePath: string;
  readonly contents: Uint8Array;
  readonly sizeBytes: number;
}

export interface ShareLinkProjectRedemption {
  readonly kind: "project";
  readonly link: ShareLink;
  readonly projectTitle: string;
  readonly entries: ReadonlyArray<ShareLinkProjectEntry>;
  /** The walk stopped at a cap rather than at the end of the project. */
  readonly truncated: boolean;
}

/**
 * An invitation, and nothing more. Joining is the collaboration invite flow's
 * business and needs an account; all this hands over is the workspace to join,
 * so a visitor's browser can offer it.
 */
export interface ShareLinkWorkspaceRedemption {
  readonly kind: "workspace";
  readonly link: ShareLink;
}

export type ShareLinkRedemption =
  | ShareLinkFileRedemption
  | ShareLinkProjectRedemption
  | ShareLinkWorkspaceRedemption;

export interface ShareLinkRedemptionInput {
  /** Straight out of the URL, and therefore entirely untrusted. */
  readonly token: string;
  /**
   * Which file inside a `project` link was asked for; absent asks for the
   * listing. Supplied by an anonymous visitor, so it is the most hostile string
   * this service handles.
   */
  readonly path?: string | null;
  /**
   * Already salted and hashed by the caller. The raw address deliberately never
   * reaches this service, so no future change here can start storing one.
   */
  readonly viewerFingerprint?: string | null;
}

export interface ShareLinkServiceShape {
  /**
   * Mints a link and returns it with its token.
   *
   * This is the only method that ever yields the token, and that is a security
   * property rather than an omission — see the note on `list`.
   */
  readonly create: (
    actor: ShareLinkActor,
    input: ShareLinkCreateInput,
  ) => Effect.Effect<ShareLinkCreateResult, ShareLinkError>;

  /**
   * The management panel's read: labels, scopes, counts, timestamps.
   *
   * Every link comes back with its `token` field withheld. A share link is a
   * bearer credential, so re-displaying all of them to everyone in a workspace
   * would turn one screenshot, one shoulder-surf or one over-broad support
   * session into total compromise of every link the workspace has ever issued.
   * The token is shown once, at creation, to the person who minted it.
   */
  readonly list: (
    actor: ShareLinkActor,
    input: ShareLinkListInput,
  ) => Effect.Effect<ShareLinkListResult, ShareLinkError>;

  /** Switches a link off. Revoking one that is already off is `revoked`. */
  readonly revoke: (
    actor: ShareLinkActor,
    input: ShareLinkRevokeInput,
  ) => Effect.Effect<ShareLinkRevokeResult, ShareLinkError>;

  /**
   * The unauthenticated half: a token becomes the thing it points at.
   *
   * Missing, expired and revoked all fail as `not-found` with one wording, so
   * that a visitor cannot tell a real token from a fake one and the route
   * cannot be used to confirm guesses. Only `create`, `list` and `revoke` —
   * which already know who is asking — get to see `expired` and `revoked`.
   */
  readonly redeem: (
    input: ShareLinkRedemptionInput,
  ) => Effect.Effect<ShareLinkRedemption, ShareLinkError>;
}

export class ShareLinkService extends Context.Service<ShareLinkService, ShareLinkServiceShape>()(
  "t3/shareLinks/Services/ShareLinkService",
) {}
