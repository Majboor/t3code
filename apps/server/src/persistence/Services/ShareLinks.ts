import * as Crypto from "node:crypto";

import { Context, type Option, Schema } from "effect";
import type { Effect } from "effect";

import type { PersistenceSqlError } from "../Errors.ts";

/**
 * Records are primitives only, deliberately — the same reasoning as
 * `Services/ProviderSharing.ts`.
 *
 * `@t3tools/contracts` brands the ids and narrows `scope` to a literal union.
 * Reaching for those here would make the repository refuse to load a row
 * written by an older build using a scope the current union no longer lists,
 * and a decode failure on read is far worse than a mismatch above: it would
 * take out the whole management panel rather than one row, and — because
 * `getLinkByToken` is on the unauthenticated path — turn a stale row into a
 * hard 500 for a visitor who did nothing wrong. The service maps and
 * validates; storage stays dumb.
 */

/**
 * Bytes of entropy behind a share link. This is not a namespacing id, it is
 * the credential: the URL is the entire access control for whatever the link
 * points at, so it has to survive being forwarded, indexed, and guessed at in
 * bulk by someone who knows the format. 32 bytes is 256 bits, which puts an
 * online search past any budget; a uuid would be 122 bits with published
 * structure and, worse, would look like every other id in the logs and get
 * treated as safe to print.
 */
const SHARE_LINK_TOKEN_BYTES = 32;

/**
 * base64url so the token survives a URL, an email client's linkifier and a
 * copy-paste unchanged — the ordinary journey of a share link — without
 * percent-encoding turning one character into three.
 *
 * `Crypto.randomBytes` and nothing else: not `Math.random`, not a uuid, not a
 * hash of anything the caller knows. Every one of those is either predictable
 * from another value the system already exposes or has far less entropy than
 * its length suggests.
 */
export function generateShareLinkToken(): string {
  return Crypto.randomBytes(SHARE_LINK_TOKEN_BYTES).toString("base64url");
}

/**
 * One share link. `scope` is `file` | `project` | `workspace`, and which of
 * `projectId` / `filePath` is set follows from it — an invariant the service
 * enforces, since storage cannot express it.
 *
 * `viewCount` and `lastViewedAt` are the running summary the listing renders.
 * The per-click detail is `ShareLinkViewRecord`.
 */
export interface ShareLinkRecord {
  readonly linkId: string;
  /** The secret from the URL. Never log this, and never put it in an error. */
  readonly token: string;
  readonly scope: string;
  readonly tenantId: string;
  readonly workspaceId: string;
  /** Null for a workspace link. */
  readonly projectId: string | null;
  /** Project-relative, and only ever set for scope `file`. */
  readonly filePath: string | null;
  readonly createdByUserId: string;
  readonly label: string | null;
  readonly createdAt: string;
  /** Null means it never lapses on its own. */
  readonly expiresAt: string | null;
  /** Set once and never moved: when access actually ended. */
  readonly revokedAt: string | null;
  readonly lastViewedAt: string | null;
  readonly viewCount: number;
}

/** One click, appended and never updated. */
export interface ShareLinkViewRecord {
  readonly viewId: string;
  readonly linkId: string;
  readonly viewedAt: string;
  /** Null when nobody was signed in, which is the ordinary case. */
  readonly viewerUserId: string | null;
  /** A salted hash computed above this layer. Never a raw address. */
  readonly viewerFingerprint: string | null;
}

/**
 * The token arrives already minted, by `generateShareLinkToken`. Generating it
 * inside the INSERT would make the value unavailable to the caller that has to
 * put it in a URL, and would hide the one line of this feature that most needs
 * to be read.
 */
export const CreateShareLinkInput = Schema.Struct({
  linkId: Schema.String,
  token: Schema.String,
  scope: Schema.String,
  tenantId: Schema.String,
  workspaceId: Schema.String,
  projectId: Schema.NullOr(Schema.String),
  filePath: Schema.NullOr(Schema.String),
  createdByUserId: Schema.String,
  label: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  expiresAt: Schema.NullOr(Schema.String),
});
export type CreateShareLinkInput = typeof CreateShareLinkInput.Type;

export const ListShareLinksForWorkspaceInput = Schema.Struct({
  tenantId: Schema.String,
  workspaceId: Schema.String,
});
export type ListShareLinksForWorkspaceInput = typeof ListShareLinksForWorkspaceInput.Type;

export const ListShareLinksForProjectInput = Schema.Struct({
  tenantId: Schema.String,
  projectId: Schema.String,
});
export type ListShareLinksForProjectInput = typeof ListShareLinksForProjectInput.Type;

/**
 * No tenant or workspace alongside the token. A visitor supplies neither and
 * has no way to know either, so the token has to be sufficient on its own —
 * which is precisely why it is 32 random bytes.
 */
export const GetShareLinkByTokenInput = Schema.Struct({
  token: Schema.String,
});
export type GetShareLinkByTokenInput = typeof GetShareLinkByTokenInput.Type;

/**
 * Tenant and workspace are carried alongside the id so the UPDATE cannot
 * revoke a link belonging to another workspace even if the id were guessed or
 * replayed. Cheap defence in depth: the service checks membership first, and
 * this makes the storage layer incapable of honouring a mismatch anyway.
 */
export const RevokeShareLinkInput = Schema.Struct({
  linkId: Schema.String,
  tenantId: Schema.String,
  workspaceId: Schema.String,
  revokedAt: Schema.String,
});
export type RevokeShareLinkInput = typeof RevokeShareLinkInput.Type;

export const RecordShareLinkViewInput = Schema.Struct({
  viewId: Schema.String,
  linkId: Schema.String,
  viewedAt: Schema.String,
  viewerUserId: Schema.NullOr(Schema.String),
  viewerFingerprint: Schema.NullOr(Schema.String),
});
export type RecordShareLinkViewInput = typeof RecordShareLinkViewInput.Type;

/**
 * `limit` is required rather than defaulted. A popular link accumulates a row
 * per click forever, and every caller of this — the notch, the analytics page
 * — renders a bounded list, so the bound belongs at the call site where
 * someone can see what it is.
 */
export const ListShareLinkViewsInput = Schema.Struct({
  linkId: Schema.String,
  limit: Schema.Int,
});
export type ListShareLinkViewsInput = typeof ListShareLinkViewsInput.Type;

export interface ShareLinkRepositoryShape {
  readonly createLink: (
    input: CreateShareLinkInput,
  ) => Effect.Effect<ShareLinkRecord, PersistenceSqlError>;
  readonly listLinksForWorkspace: (
    input: ListShareLinksForWorkspaceInput,
  ) => Effect.Effect<ReadonlyArray<ShareLinkRecord>, PersistenceSqlError>;
  readonly listLinksForProject: (
    input: ListShareLinksForProjectInput,
  ) => Effect.Effect<ReadonlyArray<ShareLinkRecord>, PersistenceSqlError>;
  /**
   * The unauthenticated read. Returns the row whatever its state — expired and
   * revoked links come back too, because the caller has to tell "no such link"
   * from "this one was switched off" to say anything useful, and both answers
   * are decided from this single row.
   */
  readonly getLinkByToken: (
    input: GetShareLinkByTokenInput,
  ) => Effect.Effect<Option.Option<ShareLinkRecord>, PersistenceSqlError>;
  /**
   * `Option.none` means no such link in this workspace. A link that was
   * already revoked comes back as `some` with its original `revokedAt`
   * untouched, so the service can report `revoked` rather than `not-found` and
   * the first revocation time survives a double click on the button.
   */
  readonly revokeLink: (
    input: RevokeShareLinkInput,
  ) => Effect.Effect<Option.Option<ShareLinkRecord>, PersistenceSqlError>;
  /**
   * Bumps the running counters and appends the view row, in one transaction so
   * the summary and the series cannot disagree. `Option.none` means the link
   * disappeared between the token lookup and the write.
   */
  readonly recordView: (
    input: RecordShareLinkViewInput,
  ) => Effect.Effect<Option.Option<ShareLinkRecord>, PersistenceSqlError>;
  readonly listViews: (
    input: ListShareLinkViewsInput,
  ) => Effect.Effect<ReadonlyArray<ShareLinkViewRecord>, PersistenceSqlError>;
}

export class ShareLinkRepository extends Context.Service<
  ShareLinkRepository,
  ShareLinkRepositoryShape
>()("t3/persistence/Services/ShareLinks/ShareLinkRepository") {}
