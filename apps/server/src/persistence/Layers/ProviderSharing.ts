import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { Effect, Layer, Option, Schema } from "effect";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  GetProviderMemberGrantInput,
  ListProviderAccountsForUserInput,
  ListProviderAccountsForUsersInput,
  ListProviderGrantsForWorkspaceInput,
  ListProviderPoliciesForWorkspaceInput,
  ListProviderSharesForUserInput,
  ListProviderSharesForWorkspaceInput,
  type ProviderAccountIndexRecord,
  type ProviderAccountShareRecord,
  type ProviderMemberGrantRecord,
  ProviderSharingRepository,
  type ProviderSharingRepositoryShape,
  type ProviderWorkspacePolicyRecord,
  RemoveProviderAccountInput,
  TouchProviderAccountUsedInput,
  UpsertProviderAccountInput,
  UpsertProviderAccountShareInput,
  UpsertProviderMemberGrantInput,
  UpsertProviderWorkspacePolicyInput,
} from "../Services/ProviderSharing.ts";

const ProviderAccountIndexRow = Schema.Struct({
  userId: Schema.String,
  provider: Schema.String,
  accountId: Schema.String,
  label: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  lastUsedAt: Schema.NullOr(Schema.String),
});

const ProviderAccountShareRow = Schema.Struct({
  tenantId: Schema.String,
  workspaceId: Schema.String,
  ownerUserId: Schema.String,
  provider: Schema.String,
  accountId: Schema.String,
  // SQLite has no boolean type; the column is 0/1 and is widened back to a real
  // boolean in `toProviderAccountShare` so no caller ever has to know that.
  enabled: Schema.Int,
  updatedAt: Schema.String,
});

const ProviderWorkspacePolicyRow = Schema.Struct({
  tenantId: Schema.String,
  workspaceId: Schema.String,
  provider: Schema.String,
  mode: Schema.String,
  sharedOwnerUserId: Schema.NullOr(Schema.String),
  sharedAccountId: Schema.NullOr(Schema.String),
  updatedAt: Schema.String,
});

const ProviderMemberGrantRow = Schema.Struct({
  tenantId: Schema.String,
  workspaceId: Schema.String,
  userId: Schema.String,
  provider: Schema.String,
  access: Schema.String,
  updatedAt: Schema.String,
});

const accountColumns = `user_id AS "userId",
  provider,
  account_id AS "accountId",
  label,
  created_at AS "createdAt",
  last_used_at AS "lastUsedAt"`;

const shareColumns = `tenant_id AS "tenantId",
  workspace_id AS "workspaceId",
  owner_user_id AS "ownerUserId",
  provider,
  account_id AS "accountId",
  enabled,
  updated_at AS "updatedAt"`;

const policyColumns = `tenant_id AS "tenantId",
  workspace_id AS "workspaceId",
  provider,
  mode,
  shared_owner_user_id AS "sharedOwnerUserId",
  shared_account_id AS "sharedAccountId",
  updated_at AS "updatedAt"`;

const grantColumns = `tenant_id AS "tenantId",
  workspace_id AS "workspaceId",
  user_id AS "userId",
  provider,
  access,
  updated_at AS "updatedAt"`;

const makeProviderSharingRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertAccountRow = SqlSchema.void({
    Request: UpsertProviderAccountInput,
    execute: (input) =>
      sql`
        INSERT INTO provider_account_index (
          user_id,
          provider,
          account_id,
          label,
          created_at,
          last_used_at
        )
        VALUES (
          ${input.userId},
          ${input.provider},
          ${input.accountId},
          ${input.label},
          ${input.createdAt},
          ${input.lastUsedAt}
        )
        ON CONFLICT (user_id, provider, account_id)
        DO UPDATE SET
          label = excluded.label,
          -- created_at is deliberately absent. Re-indexing happens on every
          -- store scan and on re-auth; letting it move would make an account
          -- look newly connected every time its token was refreshed, and the
          -- panel sorts by it.
          last_used_at = COALESCE(excluded.last_used_at, provider_account_index.last_used_at)
      `,
  });

  const removeAccountRow = SqlSchema.void({
    Request: RemoveProviderAccountInput,
    execute: (input) =>
      sql`
        DELETE FROM provider_account_index
        WHERE user_id = ${input.userId}
          AND provider = ${input.provider}
          AND account_id = ${input.accountId}
      `,
  });

  const listAccountsForUserRows = SqlSchema.findAll({
    Request: ListProviderAccountsForUserInput,
    Result: ProviderAccountIndexRow,
    execute: ({ userId }) =>
      sql`SELECT ${sql.literal(accountColumns)} FROM provider_account_index
          WHERE user_id = ${userId}
          ORDER BY provider ASC, created_at ASC`,
  });

  const listAccountsForUsersRows = SqlSchema.findAll({
    Request: ListProviderAccountsForUsersInput,
    Result: ProviderAccountIndexRow,
    // `sql.in` collapses an empty set to `1=0` rather than emitting `IN ()`,
    // which SQLite rejects — a workspace with no members must read as empty,
    // not as a syntax error.
    execute: ({ userIds }) =>
      sql`SELECT ${sql.literal(accountColumns)} FROM provider_account_index
          WHERE ${sql.in("user_id", userIds)}
          ORDER BY user_id ASC, provider ASC, created_at ASC`,
  });

  const touchAccountUsedRow = SqlSchema.void({
    Request: TouchProviderAccountUsedInput,
    // An UPDATE, not an upsert: a turn running on an account the index has
    // never seen means the store failed to register it, and inventing a row
    // here would fabricate a `created_at` and hide that bug from the roster.
    execute: (input) =>
      sql`
        UPDATE provider_account_index
        SET last_used_at = ${input.lastUsedAt}
        WHERE user_id = ${input.userId}
          AND provider = ${input.provider}
          AND account_id = ${input.accountId}
      `,
  });

  const upsertShareRow = SqlSchema.void({
    Request: UpsertProviderAccountShareInput,
    execute: (input) =>
      sql`
        INSERT INTO provider_account_shares (
          tenant_id,
          workspace_id,
          owner_user_id,
          provider,
          account_id,
          enabled,
          updated_at
        )
        VALUES (
          ${input.tenantId},
          ${input.workspaceId},
          ${input.ownerUserId},
          ${input.provider},
          ${input.accountId},
          ${input.enabled ? 1 : 0},
          ${input.updatedAt}
        )
        ON CONFLICT (tenant_id, workspace_id, owner_user_id, provider)
        DO UPDATE SET
          account_id = excluded.account_id,
          enabled = excluded.enabled,
          updated_at = excluded.updated_at
      `,
  });

  const listSharesForWorkspaceRows = SqlSchema.findAll({
    Request: ListProviderSharesForWorkspaceInput,
    Result: ProviderAccountShareRow,
    execute: ({ tenantId, workspaceId }) =>
      sql`SELECT ${sql.literal(shareColumns)} FROM provider_account_shares
          WHERE tenant_id = ${tenantId} AND workspace_id = ${workspaceId}
          ORDER BY owner_user_id ASC, provider ASC`,
  });

  const listSharesForUserRows = SqlSchema.findAll({
    Request: ListProviderSharesForUserInput,
    Result: ProviderAccountShareRow,
    execute: ({ tenantId, workspaceId, ownerUserId }) =>
      sql`SELECT ${sql.literal(shareColumns)} FROM provider_account_shares
          WHERE tenant_id = ${tenantId}
            AND workspace_id = ${workspaceId}
            AND owner_user_id = ${ownerUserId}
          ORDER BY provider ASC`,
  });

  const upsertPolicyRow = SqlSchema.void({
    Request: UpsertProviderWorkspacePolicyInput,
    execute: (input) =>
      sql`
        INSERT INTO provider_workspace_policy (
          tenant_id,
          workspace_id,
          provider,
          mode,
          shared_owner_user_id,
          shared_account_id,
          updated_at
        )
        VALUES (
          ${input.tenantId},
          ${input.workspaceId},
          ${input.provider},
          ${input.mode},
          ${input.sharedOwnerUserId},
          ${input.sharedAccountId},
          ${input.updatedAt}
        )
        ON CONFLICT (tenant_id, workspace_id, provider)
        DO UPDATE SET
          mode = excluded.mode,
          shared_owner_user_id = excluded.shared_owner_user_id,
          shared_account_id = excluded.shared_account_id,
          updated_at = excluded.updated_at
      `,
  });

  const listPoliciesForWorkspaceRows = SqlSchema.findAll({
    Request: ListProviderPoliciesForWorkspaceInput,
    Result: ProviderWorkspacePolicyRow,
    execute: ({ tenantId, workspaceId }) =>
      sql`SELECT ${sql.literal(policyColumns)} FROM provider_workspace_policy
          WHERE tenant_id = ${tenantId} AND workspace_id = ${workspaceId}
          ORDER BY provider ASC`,
  });

  const upsertGrantRow = SqlSchema.void({
    Request: UpsertProviderMemberGrantInput,
    execute: (input) =>
      sql`
        INSERT INTO provider_member_grants (
          tenant_id,
          workspace_id,
          user_id,
          provider,
          access,
          updated_at
        )
        VALUES (
          ${input.tenantId},
          ${input.workspaceId},
          ${input.userId},
          ${input.provider},
          ${input.access},
          ${input.updatedAt}
        )
        ON CONFLICT (tenant_id, workspace_id, user_id, provider)
        DO UPDATE SET
          access = excluded.access,
          updated_at = excluded.updated_at
      `,
  });

  const listGrantsForWorkspaceRows = SqlSchema.findAll({
    Request: ListProviderGrantsForWorkspaceInput,
    Result: ProviderMemberGrantRow,
    execute: ({ tenantId, workspaceId }) =>
      sql`SELECT ${sql.literal(grantColumns)} FROM provider_member_grants
          WHERE tenant_id = ${tenantId} AND workspace_id = ${workspaceId}
          ORDER BY user_id ASC, provider ASC`,
  });

  const getGrantRow = SqlSchema.findOneOption({
    Request: GetProviderMemberGrantInput,
    Result: ProviderMemberGrantRow,
    execute: ({ tenantId, workspaceId, userId, provider }) =>
      sql`SELECT ${sql.literal(grantColumns)} FROM provider_member_grants
          WHERE tenant_id = ${tenantId}
            AND workspace_id = ${workspaceId}
            AND user_id = ${userId}
            AND provider = ${provider}`,
  });

  const upsertAccount: ProviderSharingRepositoryShape["upsertAccount"] = (input) =>
    upsertAccountRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProviderSharingRepository.upsertAccount:query")),
    );

  const removeAccount: ProviderSharingRepositoryShape["removeAccount"] = (input) =>
    removeAccountRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProviderSharingRepository.removeAccount:query")),
    );

  const listAccountsForUser: ProviderSharingRepositoryShape["listAccountsForUser"] = (input) =>
    listAccountsForUserRows(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProviderSharingRepository.listAccountsForUser:query")),
      Effect.map((rows) => rows.map(toProviderAccount)),
    );

  const listAccountsForUsers: ProviderSharingRepositoryShape["listAccountsForUsers"] = (input) =>
    listAccountsForUsersRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProviderSharingRepository.listAccountsForUsers:query"),
      ),
      Effect.map((rows) => rows.map(toProviderAccount)),
    );

  const touchAccountUsed: ProviderSharingRepositoryShape["touchAccountUsed"] = (input) =>
    touchAccountUsedRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProviderSharingRepository.touchAccountUsed:query")),
    );

  const upsertShare: ProviderSharingRepositoryShape["upsertShare"] = (input) =>
    upsertShareRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProviderSharingRepository.upsertShare:query")),
    );

  const listSharesForWorkspace: ProviderSharingRepositoryShape["listSharesForWorkspace"] = (
    input,
  ) =>
    listSharesForWorkspaceRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProviderSharingRepository.listSharesForWorkspace:query"),
      ),
      Effect.map((rows) => rows.map(toProviderAccountShare)),
    );

  const listSharesForUser: ProviderSharingRepositoryShape["listSharesForUser"] = (input) =>
    listSharesForUserRows(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProviderSharingRepository.listSharesForUser:query")),
      Effect.map((rows) => rows.map(toProviderAccountShare)),
    );

  const upsertPolicy: ProviderSharingRepositoryShape["upsertPolicy"] = (input) =>
    upsertPolicyRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProviderSharingRepository.upsertPolicy:query")),
    );

  const listPoliciesForWorkspace: ProviderSharingRepositoryShape["listPoliciesForWorkspace"] = (
    input,
  ) =>
    listPoliciesForWorkspaceRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProviderSharingRepository.listPoliciesForWorkspace:query"),
      ),
      Effect.map((rows) => rows.map(toProviderWorkspacePolicy)),
    );

  const upsertGrant: ProviderSharingRepositoryShape["upsertGrant"] = (input) =>
    upsertGrantRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProviderSharingRepository.upsertGrant:query")),
    );

  const listGrantsForWorkspace: ProviderSharingRepositoryShape["listGrantsForWorkspace"] = (
    input,
  ) =>
    listGrantsForWorkspaceRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProviderSharingRepository.listGrantsForWorkspace:query"),
      ),
      Effect.map((rows) => rows.map(toProviderMemberGrant)),
    );

  const getGrant: ProviderSharingRepositoryShape["getGrant"] = (input) =>
    getGrantRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProviderSharingRepository.getGrant:query")),
      Effect.map((row) =>
        Option.isSome(row) ? Option.some(toProviderMemberGrant(row.value)) : row,
      ),
    );

  return {
    upsertAccount,
    removeAccount,
    listAccountsForUser,
    listAccountsForUsers,
    touchAccountUsed,
    upsertShare,
    listSharesForWorkspace,
    listSharesForUser,
    upsertPolicy,
    listPoliciesForWorkspace,
    upsertGrant,
    listGrantsForWorkspace,
    getGrant,
  } satisfies ProviderSharingRepositoryShape;
});

function toProviderAccount(row: typeof ProviderAccountIndexRow.Type): ProviderAccountIndexRecord {
  return {
    userId: row.userId,
    provider: row.provider,
    accountId: row.accountId,
    label: row.label,
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
  };
}

function toProviderAccountShare(
  row: typeof ProviderAccountShareRow.Type,
): ProviderAccountShareRecord {
  return {
    tenantId: row.tenantId,
    workspaceId: row.workspaceId,
    ownerUserId: row.ownerUserId,
    provider: row.provider,
    accountId: row.accountId,
    // The one place 0/1 becomes a boolean. A contributor's off switch is the
    // strictest rule in the precedence chain, and `0` is truthy nowhere but is
    // exactly the kind of value a `??` or a JSON round-trip turns into `true`.
    enabled: row.enabled !== 0,
    updatedAt: row.updatedAt,
  };
}

function toProviderWorkspacePolicy(
  row: typeof ProviderWorkspacePolicyRow.Type,
): ProviderWorkspacePolicyRecord {
  return {
    tenantId: row.tenantId,
    workspaceId: row.workspaceId,
    provider: row.provider,
    mode: row.mode,
    sharedOwnerUserId: row.sharedOwnerUserId,
    sharedAccountId: row.sharedAccountId,
    updatedAt: row.updatedAt,
  };
}

function toProviderMemberGrant(row: typeof ProviderMemberGrantRow.Type): ProviderMemberGrantRecord {
  return {
    tenantId: row.tenantId,
    workspaceId: row.workspaceId,
    userId: row.userId,
    provider: row.provider,
    access: row.access,
    updatedAt: row.updatedAt,
  };
}

export const ProviderSharingRepositoryLive: Layer.Layer<
  ProviderSharingRepository,
  never,
  SqlClient.SqlClient
> = Layer.effect(ProviderSharingRepository, makeProviderSharingRepository);
