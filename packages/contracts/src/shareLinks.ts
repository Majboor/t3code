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
 * Who the link is for.
 *
 * `public` is the original behaviour and the dangerous one: the token is the
 * whole credential, so anyone it is forwarded to is inside. `restricted` names
 * the people it was meant for and is enforced against the account that redeems
 * it, not against what a form was rendered with.
 *
 * A second literal rather than a `requiresEmail` boolean, and for the same
 * reason the scopes are literals: widening "these three people" into "anyone
 * with the link" has to be a different call with a different payload, not a
 * flipped flag.
 */
export const ShareLinkAudienceKind = Schema.Literals(["public", "restricted"]);
export type ShareLinkAudienceKind = typeof ShareLinkAudienceKind.Type;

/**
 * The audience, as the creator states it.
 *
 * A union rather than a kind beside an optional list, so that "anyone with the
 * link" cannot be sent carrying a list of people and "these people" cannot be
 * sent with an empty one. The two cases are different acts and the caller has
 * to have decided which one it is making before it can build this value at all.
 *
 * Emails are normalised by the server before they are stored or compared —
 * whatever case and padding a form supplies, the comparison at redemption is
 * against the trimmed, lower-cased form.
 */
export const ShareLinkAudience = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("public"),
  }),
  Schema.Struct({
    kind: Schema.Literal("restricted"),
    /** At least one; a restricted link with nobody on it could never be used. */
    emails: Schema.NonEmptyArray(TrimmedNonEmptyString),
  }),
]);
export type ShareLinkAudience = typeof ShareLinkAudience.Type;

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
  /**
   * Who may redeem it. Only a `workspace` link may be `restricted`: the other
   * two scopes are served to an anonymous browser with no session to check an
   * email against, so an audience there would be a promise the redemption path
   * cannot keep.
   */
  audience: ShareLinkAudienceKind,
  /**
   * The people a `restricted` link names, and `null` on any path that has not
   * earned them.
   *
   * Null is not "nobody": it means this reply is not one that discloses them.
   * Only `create`, `list` and `revoke` — all of which already know the caller
   * is a member of the workspace — ever fill it in. Redemption leaves it null,
   * because a leaked link must not become a way to find out who was invited.
   */
  allowedEmails: Schema.NullOr(Schema.Array(TrimmedNonEmptyString)),
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
   * Required, and deliberately not defaulted to `public`.
   *
   * "Anyone with the link" is the most consequential thing this call can do,
   * so it is something a caller says rather than something it gets by leaving
   * a field out. An older client that omits it fails to decode instead of
   * quietly publishing a workspace.
   */
  audience: ShareLinkAudience,
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

/**
 * Joining a workspace from a link, and the two exchanges it takes.
 *
 * A `workspace` link is not content to be served, it is an offer to become a
 * member, and a member is a person rather than a browser. So the redemption of
 * one is split in two: an unauthenticated *preview* that says only enough to
 * draw a page, and an authenticated *claim* that is the only thing that grants
 * anything.
 *
 * The split is what makes an email-scoped link enforceable. Nothing about who
 * the link is for is decided in the browser; the browser only learns that it
 * must produce somebody, and the server compares that somebody's own account
 * email against the list it holds.
 */

/**
 * What a stranger holding the URL may be told, and nothing beyond it.
 *
 * No emails, no workspace name, no ids, no member list. `audience` is here
 * because the page has to say something true about what is being asked of the
 * visitor — "anyone with this link can join" is a different sentence from
 * "sign in with the address this was sent to" — and saying which of the two it
 * is discloses nobody.
 *
 * A missing, expired or revoked token produces no preview at all: it fails
 * exactly as a token that never existed does.
 */
export const ShareLinkPreview = Schema.Struct({
  /** Always `workspace`. The other scopes are served as bytes, never previewed. */
  scope: Schema.Literal("workspace"),
  audience: ShareLinkAudienceKind,
  /** What the creator called it. Chosen by a member, shown to the visitor. */
  label: Schema.NullOr(TrimmedNonEmptyString),
});
export type ShareLinkPreview = typeof ShareLinkPreview.Type;

/**
 * The token, again, from a caller who has now signed in.
 *
 * No email field: the address that is checked is the one on the session's own
 * account, which the caller cannot choose. A claim that took an email would be
 * a claim anybody could make about anybody.
 */
export const ShareLinkClaimInput = Schema.Struct({
  token: ShareLinkToken,
});
export type ShareLinkClaimInput = typeof ShareLinkClaimInput.Type;

/**
 * Where the claimant now belongs. `joined` is false when they were already a
 * member — re-opening a link you have already used is not an error, and saying
 * so lets the page skip the celebration and go straight in.
 */
export const ShareLinkClaimResult = Schema.Struct({
  tenantId: TenantId,
  workspaceId: WorkspaceId,
  joined: Schema.Boolean,
});
export type ShareLinkClaimResult = typeof ShareLinkClaimResult.Type;
