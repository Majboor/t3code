import { Context, type Option, Schema } from "effect";
import type { Effect } from "effect";

import type { PersistenceSqlError } from "../Errors.ts";

/**
 * Records are primitives only, deliberately.
 *
 * The contracts in `@t3tools/contracts` brand their ids and narrow `provider`,
 * `mode` and `access` to literal unions. Reaching for them here would make the
 * repository refuse to load a row written by an older build that used a value
 * the current union no longer lists — a decode failure on read is a much worse
 * outcome than a service-layer mismatch, because it takes the whole panel down
 * rather than one row. The service above maps and validates; storage stays
 * dumb.
 */

/** One connected credential, as seen by the roster. Never holds token material. */
export interface ProviderAccountIndexRecord {
  readonly userId: string;
  readonly provider: string;
  readonly accountId: string;
  /** Null for the legacy "default" account, which predates labels. */
  readonly label: string | null;
  readonly createdAt: string;
  /** Null until this account has run a turn. */
  readonly lastUsedAt: string | null;
}

/** A contributor lending one account into one workspace. */
export interface ProviderAccountShareRecord {
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly ownerUserId: string;
  readonly provider: string;
  readonly accountId: string;
  readonly enabled: boolean;
  readonly updatedAt: string;
}

/** The workspace default. `mode` is `own` | `shared`. */
export interface ProviderWorkspacePolicyRecord {
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly provider: string;
  readonly mode: string;
  /** Both null under mode `own`. */
  readonly sharedOwnerUserId: string | null;
  readonly sharedAccountId: string | null;
  readonly updatedAt: string;
}

/** An admin's override for one member. `access` is `own` | `workspace`. */
export interface ProviderMemberGrantRecord {
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly userId: string;
  readonly provider: string;
  readonly access: string;
  readonly updatedAt: string;
}

export const UpsertProviderAccountInput = Schema.Struct({
  userId: Schema.String,
  provider: Schema.String,
  accountId: Schema.String,
  label: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  lastUsedAt: Schema.NullOr(Schema.String),
});
export type UpsertProviderAccountInput = typeof UpsertProviderAccountInput.Type;

export const RemoveProviderAccountInput = Schema.Struct({
  userId: Schema.String,
  provider: Schema.String,
  accountId: Schema.String,
});
export type RemoveProviderAccountInput = typeof RemoveProviderAccountInput.Type;

export const ListProviderAccountsForUserInput = Schema.Struct({
  userId: Schema.String,
});
export type ListProviderAccountsForUserInput = typeof ListProviderAccountsForUserInput.Type;

export const ListProviderAccountsForUsersInput = Schema.Struct({
  userIds: Schema.Array(Schema.String),
});
export type ListProviderAccountsForUsersInput = typeof ListProviderAccountsForUsersInput.Type;

export const TouchProviderAccountUsedInput = Schema.Struct({
  userId: Schema.String,
  provider: Schema.String,
  accountId: Schema.String,
  lastUsedAt: Schema.String,
});
export type TouchProviderAccountUsedInput = typeof TouchProviderAccountUsedInput.Type;

export const UpsertProviderAccountShareInput = Schema.Struct({
  tenantId: Schema.String,
  workspaceId: Schema.String,
  ownerUserId: Schema.String,
  provider: Schema.String,
  accountId: Schema.String,
  enabled: Schema.Boolean,
  updatedAt: Schema.String,
});
export type UpsertProviderAccountShareInput = typeof UpsertProviderAccountShareInput.Type;

export const ListProviderSharesForWorkspaceInput = Schema.Struct({
  tenantId: Schema.String,
  workspaceId: Schema.String,
});
export type ListProviderSharesForWorkspaceInput = typeof ListProviderSharesForWorkspaceInput.Type;

export const ListProviderSharesForUserInput = Schema.Struct({
  tenantId: Schema.String,
  workspaceId: Schema.String,
  ownerUserId: Schema.String,
});
export type ListProviderSharesForUserInput = typeof ListProviderSharesForUserInput.Type;

export const UpsertProviderWorkspacePolicyInput = Schema.Struct({
  tenantId: Schema.String,
  workspaceId: Schema.String,
  provider: Schema.String,
  mode: Schema.String,
  sharedOwnerUserId: Schema.NullOr(Schema.String),
  sharedAccountId: Schema.NullOr(Schema.String),
  updatedAt: Schema.String,
});
export type UpsertProviderWorkspacePolicyInput = typeof UpsertProviderWorkspacePolicyInput.Type;

export const ListProviderPoliciesForWorkspaceInput = Schema.Struct({
  tenantId: Schema.String,
  workspaceId: Schema.String,
});
export type ListProviderPoliciesForWorkspaceInput =
  typeof ListProviderPoliciesForWorkspaceInput.Type;

export const UpsertProviderMemberGrantInput = Schema.Struct({
  tenantId: Schema.String,
  workspaceId: Schema.String,
  userId: Schema.String,
  provider: Schema.String,
  access: Schema.String,
  updatedAt: Schema.String,
});
export type UpsertProviderMemberGrantInput = typeof UpsertProviderMemberGrantInput.Type;

export const ListProviderGrantsForWorkspaceInput = Schema.Struct({
  tenantId: Schema.String,
  workspaceId: Schema.String,
});
export type ListProviderGrantsForWorkspaceInput = typeof ListProviderGrantsForWorkspaceInput.Type;

export const GetProviderMemberGrantInput = Schema.Struct({
  tenantId: Schema.String,
  workspaceId: Schema.String,
  userId: Schema.String,
  provider: Schema.String,
});
export type GetProviderMemberGrantInput = typeof GetProviderMemberGrantInput.Type;

export interface ProviderSharingRepositoryShape {
  readonly upsertAccount: (
    input: UpsertProviderAccountInput,
  ) => Effect.Effect<void, PersistenceSqlError>;
  readonly removeAccount: (
    input: RemoveProviderAccountInput,
  ) => Effect.Effect<void, PersistenceSqlError>;
  readonly listAccountsForUser: (
    input: ListProviderAccountsForUserInput,
  ) => Effect.Effect<ReadonlyArray<ProviderAccountIndexRecord>, PersistenceSqlError>;
  /** The admin roster: every connected account belonging to a set of members. */
  readonly listAccountsForUsers: (
    input: ListProviderAccountsForUsersInput,
  ) => Effect.Effect<ReadonlyArray<ProviderAccountIndexRecord>, PersistenceSqlError>;
  readonly touchAccountUsed: (
    input: TouchProviderAccountUsedInput,
  ) => Effect.Effect<void, PersistenceSqlError>;
  readonly upsertShare: (
    input: UpsertProviderAccountShareInput,
  ) => Effect.Effect<void, PersistenceSqlError>;
  readonly listSharesForWorkspace: (
    input: ListProviderSharesForWorkspaceInput,
  ) => Effect.Effect<ReadonlyArray<ProviderAccountShareRecord>, PersistenceSqlError>;
  readonly listSharesForUser: (
    input: ListProviderSharesForUserInput,
  ) => Effect.Effect<ReadonlyArray<ProviderAccountShareRecord>, PersistenceSqlError>;
  readonly upsertPolicy: (
    input: UpsertProviderWorkspacePolicyInput,
  ) => Effect.Effect<void, PersistenceSqlError>;
  readonly listPoliciesForWorkspace: (
    input: ListProviderPoliciesForWorkspaceInput,
  ) => Effect.Effect<ReadonlyArray<ProviderWorkspacePolicyRecord>, PersistenceSqlError>;
  readonly upsertGrant: (
    input: UpsertProviderMemberGrantInput,
  ) => Effect.Effect<void, PersistenceSqlError>;
  readonly listGrantsForWorkspace: (
    input: ListProviderGrantsForWorkspaceInput,
  ) => Effect.Effect<ReadonlyArray<ProviderMemberGrantRecord>, PersistenceSqlError>;
  /** `Option.none` means "follow the policy", which is not the same as `own`. */
  readonly getGrant: (
    input: GetProviderMemberGrantInput,
  ) => Effect.Effect<Option.Option<ProviderMemberGrantRecord>, PersistenceSqlError>;
}

export class ProviderSharingRepository extends Context.Service<
  ProviderSharingRepository,
  ProviderSharingRepositoryShape
>()("t3/persistence/Services/ProviderSharing/ProviderSharingRepository") {}
