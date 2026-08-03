import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { Effect, Layer, Option } from "effect";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  GetLocalAuthAccountByEmailInput,
  GetLocalAuthAccountByUserIdInput,
  LocalAuthAccountRecord,
  LocalAuthAccountRepository,
  type LocalAuthAccountRepositoryShape,
  UpsertLocalAuthAccountInput,
} from "../Services/LocalAuthAccounts.ts";

const makeLocalAuthAccountRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertAccountRow = SqlSchema.void({
    Request: UpsertLocalAuthAccountInput,
    execute: (input) =>
      sql`
        INSERT INTO auth_local_accounts (
          user_id,
          email,
          password_hash,
          password_salt,
          display_name,
          avatar_initials,
          created_at,
          updated_at,
          disabled_at
        )
        VALUES (
          ${input.userId},
          ${input.email},
          ${input.passwordHash},
          ${input.passwordSalt},
          ${input.displayName},
          ${input.avatarInitials},
          ${input.createdAt},
          ${input.updatedAt},
          ${input.disabledAt}
        )
        ON CONFLICT (user_id)
        DO UPDATE SET
          email = excluded.email,
          password_hash = excluded.password_hash,
          password_salt = excluded.password_salt,
          display_name = excluded.display_name,
          avatar_initials = excluded.avatar_initials,
          updated_at = excluded.updated_at,
          disabled_at = excluded.disabled_at
      `,
  });

  const getAccountRowByEmail = SqlSchema.findOneOption({
    Request: GetLocalAuthAccountByEmailInput,
    Result: LocalAuthAccountRecord,
    execute: ({ email }) =>
      sql`
        SELECT
          user_id AS "userId",
          email,
          password_hash AS "passwordHash",
          password_salt AS "passwordSalt",
          display_name AS "displayName",
          avatar_initials AS "avatarInitials",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          disabled_at AS "disabledAt"
        FROM auth_local_accounts
        WHERE email = ${email}
      `,
  });

  const getAccountRowByUserId = SqlSchema.findOneOption({
    Request: GetLocalAuthAccountByUserIdInput,
    Result: LocalAuthAccountRecord,
    execute: ({ userId }) =>
      sql`
        SELECT
          user_id AS "userId",
          email,
          password_hash AS "passwordHash",
          password_salt AS "passwordSalt",
          display_name AS "displayName",
          avatar_initials AS "avatarInitials",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          disabled_at AS "disabledAt"
        FROM auth_local_accounts
        WHERE user_id = ${userId}
      `,
  });

  const upsert: LocalAuthAccountRepositoryShape["upsert"] = (input) =>
    upsertAccountRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("LocalAuthAccountRepository.upsert:query")),
    );

  const getByEmail: LocalAuthAccountRepositoryShape["getByEmail"] = (input) =>
    getAccountRowByEmail(input).pipe(
      Effect.mapError(toPersistenceSqlError("LocalAuthAccountRepository.getByEmail:query")),
      Effect.map((account) => (Option.isSome(account) ? Option.some(account.value) : account)),
    );

  const getByUserId: LocalAuthAccountRepositoryShape["getByUserId"] = (input) =>
    getAccountRowByUserId(input).pipe(
      Effect.mapError(toPersistenceSqlError("LocalAuthAccountRepository.getByUserId:query")),
      Effect.map((account) => (Option.isSome(account) ? Option.some(account.value) : account)),
    );

  return {
    upsert,
    getByEmail,
    getByUserId,
  } satisfies LocalAuthAccountRepositoryShape;
});

export const LocalAuthAccountRepositoryLive = Layer.effect(
  LocalAuthAccountRepository,
  makeLocalAuthAccountRepository,
);
