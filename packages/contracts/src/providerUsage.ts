import { Schema } from "effect";

import {
  IsoDateTime,
  ProviderAccountId,
  TenantId,
  TrimmedNonEmptyString,
  UserId,
  WorkspaceId,
} from "./baseSchemas.ts";
import { ProviderAuthKind } from "./providerSharing.ts";

/**
 * Asking a workspace for provider usage: the other half of
 * `providerSharing.ts`. Sharing lets someone who has a credential offer it;
 * this lets someone who has none — or is about to run out — say so, and be
 * answered. Without it the only path is the refusal message, which can do
 * nothing but tell people to go and buy their own subscription.
 *
 * Everything here is a request and a decision. No credential material, no
 * account contents: granting a request is expressed by writing the sharing
 * tables, and this file only records that the answer was yes.
 */

/**
 * Branded here rather than in `baseSchemas.ts` because these ids never appear
 * outside this exchange — the same reason `PackId` lives in `pack.ts`.
 */
export const ProviderUsageRequestId = TrimmedNonEmptyString.pipe(
  Schema.brand("ProviderUsageRequestId"),
);
export type ProviderUsageRequestId = typeof ProviderUsageRequestId.Type;

/**
 * `withdrawn` is the requester taking it back and is deliberately distinct
 * from `declined`: a panel that showed "declined" for a request nobody ever
 * looked at would accuse a colleague of refusing.
 */
export const ProviderUsageRequestStatus = Schema.Literals([
  "pending",
  "granted",
  "declined",
  "withdrawn",
]);
export type ProviderUsageRequestStatus = typeof ProviderUsageRequestStatus.Type;

/**
 * Why the person is asking, as it was true at the moment they asked.
 *
 * `asked` is the catch-all: someone who could run turns but wants the
 * workspace's account anyway.
 */
export const ProviderUsageRequestReason = Schema.Literals(["no-account", "limit-reached", "asked"]);
export type ProviderUsageRequestReason = typeof ProviderUsageRequestReason.Type;

/** grant contributes an account; decline closes the request without one. */
export const ProviderUsageRequestDecision = Schema.Literals(["grant", "decline"]);
export type ProviderUsageRequestDecision = typeof ProviderUsageRequestDecision.Type;

/**
 * One person asking one workspace for usage of one provider.
 *
 * `reason` is stored rather than derived because it is a fact about the moment
 * of asking, not about now. Someone who asks with `no-account` and then
 * connects one, or asks with `limit-reached` at the end of a billing period,
 * would have the panel re-derive `asked` and quietly rewrite why they were
 * asking — turning an urgent request into a casual one, or the reverse. The
 * panel explains the request in the requester's own terms or not at all.
 *
 * `requesterDisplayName` is denormalised for the same reason a roster row
 * carries one: the responder has to be told who is asking, and a request
 * outlives the membership row that could otherwise supply the name.
 *
 * Which account a grant actually contributed is deliberately *not* here.
 * Unlike the reason, that is live state — an owner may switch the share off or
 * disconnect the account a minute later — so it is read from
 * `ProviderAccountShare` at the time of asking rather than frozen into an
 * answer that would go stale.
 */
export const ProviderUsageRequest = Schema.Struct({
  id: ProviderUsageRequestId,
  tenantId: TenantId,
  workspaceId: WorkspaceId,
  requesterUserId: UserId,
  requesterDisplayName: TrimmedNonEmptyString,
  provider: ProviderAuthKind,
  reason: ProviderUsageRequestReason,
  /** Free text from the requester: "just for the migration", and so on. */
  note: Schema.NullOr(TrimmedNonEmptyString),
  status: ProviderUsageRequestStatus,
  createdAt: IsoDateTime,
  respondedAt: Schema.NullOr(IsoDateTime),
  /** Null while pending, and null on withdrawal — nobody answered. */
  respondedByUserId: Schema.NullOr(UserId),
});
export type ProviderUsageRequest = typeof ProviderUsageRequest.Type;

/**
 * Separate from `ProviderSharingError` rather than widening it. That error's
 * vocabulary is about accounts and policies — what may be contributed and by
 * whom — while these codes are the lifecycle of a request, which the sharing
 * calls can never raise and should not have to narrow past. Shaped after
 * `CollaborationError`, whose approval codes this exchange mirrors.
 */
export class ProviderUsageError extends Schema.TaggedErrorClass<ProviderUsageError>()(
  "ProviderUsageError",
  {
    message: TrimmedNonEmptyString,
    code: Schema.Literals([
      "forbidden",
      "workspace-not-found",
      "request-not-found",
      /** Already granted, declined or withdrawn: an answer is good once. */
      "request-already-decided",
      /** The same person already has an open request for this provider. */
      "request-already-pending",
      /** The responder has no connected account for the provider asked for. */
      "not-a-contributor",
      /** `grant` named an account that is not the responder's. */
      "account-not-found",
    ]),
    cause: Schema.optional(Schema.Defect),
  },
) {}

/**
 * No `requesterUserId`: the session is the requester. Letting the input name
 * one would let anybody file a request in someone else's name, and the panel
 * treats a request as that person's word.
 */
export const ProviderUsageRequestCreateInput = Schema.Struct({
  tenantId: TenantId,
  workspaceId: WorkspaceId,
  provider: ProviderAuthKind,
  reason: ProviderUsageRequestReason,
  /**
   * Optional-and-nullable so an untouched or cleared note field decodes to the
   * same absent note the record stores, instead of being rejected.
   */
  note: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
});
export type ProviderUsageRequestCreateInput = typeof ProviderUsageRequestCreateInput.Type;

export const ProviderUsageRequestCreateResult = Schema.Struct({
  request: ProviderUsageRequest,
});
export type ProviderUsageRequestCreateResult = typeof ProviderUsageRequestCreateResult.Type;

export const ProviderUsageRequestListInput = Schema.Struct({
  tenantId: TenantId,
  workspaceId: WorkspaceId,
});
export type ProviderUsageRequestListInput = typeof ProviderUsageRequestListInput.Type;

/**
 * Everyone sees their own requests; someone with a connected account for a
 * provider also sees the workspace's pending ones for it.
 *
 * `canRespond` is returned rather than inferred from a non-empty `requests`,
 * because both halves are legitimately empty: a contributor with nothing
 * waiting and a requester with nothing asked look identical otherwise, and the
 * panel has to tell "no one needs you" from "you cannot help".
 */
export const ProviderUsageRequestListResult = Schema.Struct({
  requests: Schema.Array(ProviderUsageRequest),
  canRespond: Schema.Boolean,
});
export type ProviderUsageRequestListResult = typeof ProviderUsageRequestListResult.Type;

/**
 * `accountId` is optional because `decline` has nothing to name. A `grant`
 * without one is the service's to reject, not the schema's: the schema cannot
 * see the decision and the account together without splitting this into two
 * methods, which would put the same authorisation check in two places.
 */
export const ProviderUsageRequestRespondInput = Schema.Struct({
  tenantId: TenantId,
  workspaceId: WorkspaceId,
  requestId: ProviderUsageRequestId,
  decision: ProviderUsageRequestDecision,
  accountId: Schema.optional(ProviderAccountId),
});
export type ProviderUsageRequestRespondInput = typeof ProviderUsageRequestRespondInput.Type;

export const ProviderUsageRequestRespondResult = Schema.Struct({
  request: ProviderUsageRequest,
});
export type ProviderUsageRequestRespondResult = typeof ProviderUsageRequestRespondResult.Type;

export const ProviderUsageRequestWithdrawInput = Schema.Struct({
  tenantId: TenantId,
  workspaceId: WorkspaceId,
  requestId: ProviderUsageRequestId,
});
export type ProviderUsageRequestWithdrawInput = typeof ProviderUsageRequestWithdrawInput.Type;

export const ProviderUsageRequestWithdrawResult = Schema.Struct({
  request: ProviderUsageRequest,
});
export type ProviderUsageRequestWithdrawResult = typeof ProviderUsageRequestWithdrawResult.Type;
