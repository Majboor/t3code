import { Schema } from "effect";

import {
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  TenantId,
  TrimmedNonEmptyString,
  UserId,
  WorkspaceId,
} from "./baseSchemas.ts";

/**
 * Public share links: access for someone who has no account here.
 *
 * Invites (`tenancy.ts`) are the other half and cannot cover this. An invite
 * names a person, needs them to sign up, and only ever grants a workspace. A
 * share link is addressed to nobody, survives being forwarded, and is the only
 * way to hand over a single file or a single project without first making the
 * recipient a member.
 *
 * That reach is exactly what makes these dangerous, and it shapes every
 * decision below: the token *is* the credential, so it is minted from 32 bytes
 * of CSPRNG output rather than from any id, and the three scopes are separate
 * literals rather than a flag so that widening a file link into a workspace
 * link is a different call and not a changed field.
 */

/**
 * Branded here rather than in `baseSchemas.ts` because these ids never leave
 * this exchange — the same reason `ProviderUsageRequestId` lives in
 * `providerUsage.ts`.
 */
export const ShareLinkId = TrimmedNonEmptyString.pipe(Schema.brand("ShareLinkId"));
export type ShareLinkId = typeof ShareLinkId.Type;

export const ShareLinkViewId = TrimmedNonEmptyString.pipe(Schema.brand("ShareLinkViewId"));
export type ShareLinkViewId = typeof ShareLinkViewId.Type;

/**
 * The secret in the URL. Branded apart from every other string so that a token
 * cannot be passed where an id is wanted — or, far worse, an id where a token
 * is wanted, which would make links guessable from a list of ids.
 *
 * Never log it, never put it in an analytics property, never let it into an
 * error message: anyone holding this string has whatever the link grants.
 */
export const ShareLinkToken = TrimmedNonEmptyString.pipe(Schema.brand("ShareLinkToken"));
export type ShareLinkToken = typeof ShareLinkToken.Type;

/**
 * What a link opens.
 *
 * `file` and `project` are read-only views. `workspace` is categorically
 * different — it is an invitation to collaborate, and following it makes the
 * visitor a member — so it is a third literal rather than a `canJoin` boolean
 * on the other two. A boolean would let a file link acquire join rights by a
 * single mistaken write; a scope change cannot happen without rewriting the
 * targeting columns too.
 */
export const ShareLinkScope = Schema.Literals(["file", "project", "workspace"]);
export type ShareLinkScope = typeof ShareLinkScope.Type;

/**
 * One link. `projectId` and `filePath` are the target and are nullable because
 * which of them is meaningful depends on the scope: a workspace link has
 * neither, a project link has a project, a file link has both. The schema
 * cannot express that dependency without splitting this into three structs
 * that every reader would then have to re-join, so the invariant is the
 * service's to enforce on write and `ShareLinkError`'s `invalid-target` to
 * report.
 *
 * `revokedAt` and `expiresAt` are kept as timestamps rather than collapsed to
 * an `active` boolean: a revoked link stays visible in the owner's list, and
 * "this link stopped working on Tuesday" is the answer someone actually needs
 * when a recipient reports a 404.
 *
 * `viewCount` and `lastViewedAt` are a running summary for the list view. The
 * per-click detail lives in `ShareLinkView` — see the note there for why both
 * exist.
 */
export const ShareLink = Schema.Struct({
  id: ShareLinkId,
  token: ShareLinkToken,
  scope: ShareLinkScope,
  tenantId: TenantId,
  workspaceId: WorkspaceId,
  /** Null for a workspace link. */
  projectId: Schema.NullOr(ProjectId),
  /** Project-relative, and only ever set for scope `file`. */
  filePath: Schema.NullOr(TrimmedNonEmptyString),
  createdByUserId: UserId,
  /** What the creator called it, for their own list. Null if they said nothing. */
  label: Schema.NullOr(TrimmedNonEmptyString),
  createdAt: IsoDateTime,
  /** Null means it never lapses on its own; only a revocation stops it. */
  expiresAt: Schema.NullOr(IsoDateTime),
  /** Set once and never moved: it is when access actually ended. */
  revokedAt: Schema.NullOr(IsoDateTime),
  lastViewedAt: Schema.NullOr(IsoDateTime),
  viewCount: NonNegativeInt,
});
export type ShareLink = typeof ShareLink.Type;

/**
 * One click. Append-only, and deliberately duplicated by the running
 * `viewCount` on the link itself.
 *
 * This is the same split `collaboration_member_usage` and
 * `collaboration_usage_samples` already make, for the same reason (migration
 * 050 spells it out): a running total answers "how much" cheaply enough to
 * render in a list of twenty links, and can answer nothing else. When it was
 * viewed, how often, by whom — the notch UI and the analytics page need all
 * three, and a counter has thrown every one of them away by the time it is
 * read. So the counter stays for the list and the series stays for the detail;
 * neither is derived from the other at read time.
 *
 * `viewerUserId` is null for the ordinary case, an unauthenticated visitor —
 * that is the entire point of a public link. `viewerFingerprint` is a salted
 * hash the server computes, never a raw IP address: this table is read by a
 * product analytics page, and an analytics page must not be a place where
 * visitor IPs accumulate.
 */
export const ShareLinkView = Schema.Struct({
  id: ShareLinkViewId,
  linkId: ShareLinkId,
  viewedAt: IsoDateTime,
  /** Null when nobody was signed in, which is the normal case. */
  viewerUserId: Schema.NullOr(UserId),
  /** Salted hash, so repeat visits group without anyone being identified. */
  viewerFingerprint: Schema.NullOr(TrimmedNonEmptyString),
});
export type ShareLinkView = typeof ShareLinkView.Type;

/**
 * `expired` and `revoked` are distinct codes even though both mean "this link
 * no longer works", because the visitor's next move differs: an expired link
 * can be reissued by whoever sent it, a revoked one was switched off on
 * purpose and asking again is the wrong advice.
 *
 * `not-found` covers a token that matches nothing, and it must also be what an
 * unauthorised *lookup* returns. Answering "forbidden" for a real token and
 * "not-found" for a fake one would turn this error into an oracle that
 * confirms a guessed token exists.
 */
export class ShareLinkError extends Schema.TaggedErrorClass<ShareLinkError>()("ShareLinkError", {
  message: TrimmedNonEmptyString,
  code: Schema.Literals([
    "forbidden",
    "not-found",
    "expired",
    "revoked",
    /** Scope and target disagree: a file link with no path, and so on. */
    "invalid-target",
  ]),
  cause: Schema.optional(Schema.Defect),
}) {}

/**
 * No `token` and no `createdByUserId`: both are the server's to mint. A
 * caller-supplied token would let anyone install a memorable one, and a
 * caller-supplied author would let anyone create links in someone else's name.
 */
export const ShareLinkCreateInput = Schema.Struct({
  tenantId: TenantId,
  workspaceId: WorkspaceId,
  scope: ShareLinkScope,
  /**
   * Optional-and-nullable throughout, so a form that leaves a field untouched
   * and one that clears it both decode to the absent value the record stores.
   */
  projectId: Schema.optional(Schema.NullOr(ProjectId)),
  filePath: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  label: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  expiresAt: Schema.optional(Schema.NullOr(IsoDateTime)),
});
export type ShareLinkCreateInput = typeof ShareLinkCreateInput.Type;

export const ShareLinkCreateResult = Schema.Struct({
  link: ShareLink,
});
export type ShareLinkCreateResult = typeof ShareLinkCreateResult.Type;

/**
 * `projectId` narrows the listing to one project's links; omitting it lists
 * the whole workspace, including the workspace-scoped links that belong to no
 * project. Two reads, one method, because the caller is the same panel either
 * way and the authorisation check is identical.
 */
export const ShareLinkListInput = Schema.Struct({
  tenantId: TenantId,
  workspaceId: WorkspaceId,
  projectId: Schema.optional(Schema.NullOr(ProjectId)),
});
export type ShareLinkListInput = typeof ShareLinkListInput.Type;

export const ShareLinkListResult = Schema.Struct({
  links: Schema.Array(ShareLink),
});
export type ShareLinkListResult = typeof ShareLinkListResult.Type;

/**
 * Revoking is addressed by id, not by token. The person switching a link off
 * is reading their own list, where ids are what they have; requiring the token
 * would mean the management UI had to hold every secret it displays in order
 * to be able to turn one off.
 */
export const ShareLinkRevokeInput = Schema.Struct({
  tenantId: TenantId,
  workspaceId: WorkspaceId,
  linkId: ShareLinkId,
});
export type ShareLinkRevokeInput = typeof ShareLinkRevokeInput.Type;

/** The revoked row, so the list updates from the reply instead of refetching. */
export const ShareLinkRevokeResult = Schema.Struct({
  link: ShareLink,
});
export type ShareLinkRevokeResult = typeof ShareLinkRevokeResult.Type;
