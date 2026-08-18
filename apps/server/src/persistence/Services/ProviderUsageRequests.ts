import { Context, type Option, Schema } from "effect";
import type { Effect } from "effect";

import type { PersistenceSqlError } from "../Errors.ts";

/**
 * Primitives only, for the same reason `ProviderSharing.ts` gives: a branded
 * or literal-union schema here would turn a row written by an older build into
 * a decode failure on read, and a request that cannot be read is a request
 * nobody can answer or withdraw. `reason` and `status` are the values most
 * likely to grow a new member, so they are plain strings in storage and are
 * narrowed by the service above.
 */

/** One person asking a workspace for provider usage. Holds no credential material. */
export interface ProviderUsageRequestRecord {
  readonly requestId: string;
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly requesterUserId: string;
  readonly provider: string;
  /** `no-account` | `limit-reached` | `asked`. Derived by the server, not typed by the asker. */
  readonly reason: string;
  /** Null when nothing was written, which is not the same as an empty note. */
  readonly note: string | null;
  /** `pending` | `granted` | `declined` | `withdrawn`. */
  readonly status: string;
  readonly createdAt: string;
  /** The three response fields are null together while the request is pending. */
  readonly respondedAt: string | null;
  readonly respondedByUserId: string | null;
  /** The account that was lent. Null on a decline or a withdrawal. */
  readonly respondedAccountId: string | null;
}

/**
 * `status` is absent on purpose: a created request is always pending, and
 * letting a caller name the status would let it write a row that is born
 * answered and outside the pending uniqueness rule.
 */
export const CreateProviderUsageRequestInput = Schema.Struct({
  requestId: Schema.String,
  tenantId: Schema.String,
  workspaceId: Schema.String,
  requesterUserId: Schema.String,
  provider: Schema.String,
  reason: Schema.String,
  note: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
});
export type CreateProviderUsageRequestInput = typeof CreateProviderUsageRequestInput.Type;

export const ListProviderUsageRequestsForWorkspaceInput = Schema.Struct({
  tenantId: Schema.String,
  workspaceId: Schema.String,
  /** Omitted means every status, which is the history view rather than the queue. */
  status: Schema.optional(Schema.String),
});
export type ListProviderUsageRequestsForWorkspaceInput =
  typeof ListProviderUsageRequestsForWorkspaceInput.Type;

export const ListProviderUsageRequestsForUserInput = Schema.Struct({
  tenantId: Schema.String,
  workspaceId: Schema.String,
  requesterUserId: Schema.String,
});
export type ListProviderUsageRequestsForUserInput =
  typeof ListProviderUsageRequestsForUserInput.Type;

export const GetProviderUsageRequestInput = Schema.Struct({
  requestId: Schema.String,
});
export type GetProviderUsageRequestInput = typeof GetProviderUsageRequestInput.Type;

export const UpdateProviderUsageRequestStatusInput = Schema.Struct({
  requestId: Schema.String,
  status: Schema.String,
  respondedAt: Schema.String,
  /** Null when the workspace closed the request rather than a person. */
  respondedByUserId: Schema.NullOr(Schema.String),
  /** Set only on a grant — the account being lent. */
  respondedAccountId: Schema.NullOr(Schema.String),
});
export type UpdateProviderUsageRequestStatusInput =
  typeof UpdateProviderUsageRequestStatusInput.Type;

export interface ProviderUsageRequestRepositoryShape {
  /**
   * Returns the request that is now open for this person and provider, which
   * is not always the one just described: a second ask while one is still
   * pending updates the existing row and hands back its original id and
   * `createdAt`. Callers must use the returned id rather than the one they
   * generated.
   */
  readonly createRequest: (
    input: CreateProviderUsageRequestInput,
  ) => Effect.Effect<ProviderUsageRequestRecord, PersistenceSqlError>;
  readonly listRequestsForWorkspace: (
    input: ListProviderUsageRequestsForWorkspaceInput,
  ) => Effect.Effect<ReadonlyArray<ProviderUsageRequestRecord>, PersistenceSqlError>;
  readonly listRequestsForUser: (
    input: ListProviderUsageRequestsForUserInput,
  ) => Effect.Effect<ReadonlyArray<ProviderUsageRequestRecord>, PersistenceSqlError>;
  readonly getRequest: (
    input: GetProviderUsageRequestInput,
  ) => Effect.Effect<Option.Option<ProviderUsageRequestRecord>, PersistenceSqlError>;
  /**
   * Only a pending request can be answered, so `Option.none` means the request
   * is gone or someone else answered first — the difference between "your
   * grant landed" and "you were second" that a void return would hide.
   */
  readonly updateRequestStatus: (
    input: UpdateProviderUsageRequestStatusInput,
  ) => Effect.Effect<Option.Option<ProviderUsageRequestRecord>, PersistenceSqlError>;
}

export class ProviderUsageRequestRepository extends Context.Service<
  ProviderUsageRequestRepository,
  ProviderUsageRequestRepositoryShape
>()("t3/persistence/Services/ProviderUsageRequests/ProviderUsageRequestRepository") {}
