import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { Effect, Layer, Option } from "effect";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  ConsumeOAuthStateInput,
  DeleteExternalConnectionInput,
  ExternalConnectionRecord,
  ExternalConnectionRepository,
  type ExternalConnectionRepositoryShape,
  GetExternalConnectionInput,
  InsertOAuthStateInput,
  OAuthStateRecord,
  UpsertExternalConnectionInput,
} from "../Services/ExternalConnections.ts";

const makeExternalConnectionRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertRow = SqlSchema.void({
    Request: UpsertExternalConnectionInput,
    execute: (input) =>
      sql`
        INSERT INTO external_connections (
          user_id, provider, access_token, refresh_token, expires_at,
          account_id, account_label, scope, created_at, updated_at
        )
        VALUES (
          ${input.userId}, ${input.provider}, ${input.accessToken}, ${input.refreshToken},
          ${input.expiresAt}, ${input.accountId}, ${input.accountLabel}, ${input.scope},
          ${input.createdAt}, ${input.updatedAt}
        )
        ON CONFLICT (user_id, provider)
        DO UPDATE SET
          access_token = excluded.access_token,
          refresh_token = excluded.refresh_token,
          expires_at = excluded.expires_at,
          account_id = excluded.account_id,
          account_label = excluded.account_label,
          scope = excluded.scope,
          updated_at = excluded.updated_at
      `,
  });

  const getRow = SqlSchema.findOneOption({
    Request: GetExternalConnectionInput,
    Result: ExternalConnectionRecord,
    execute: ({ userId, provider }) =>
      sql`
        SELECT
          user_id AS "userId", provider, access_token AS "accessToken",
          refresh_token AS "refreshToken", expires_at AS "expiresAt",
          account_id AS "accountId", account_label AS "accountLabel", scope,
          created_at AS "createdAt", updated_at AS "updatedAt"
        FROM external_connections
        WHERE user_id = ${userId} AND provider = ${provider}
      `,
  });

  const deleteRow = SqlSchema.void({
    Request: DeleteExternalConnectionInput,
    execute: ({ userId, provider }) =>
      sql`DELETE FROM external_connections WHERE user_id = ${userId} AND provider = ${provider}`,
  });

  const insertStateRow = SqlSchema.void({
    Request: InsertOAuthStateInput,
    execute: (input) =>
      sql`
        INSERT INTO external_oauth_states (state, user_id, provider, created_at)
        VALUES (${input.state}, ${input.userId}, ${input.provider}, ${input.createdAt})
      `,
  });

  const findStateRow = SqlSchema.findOneOption({
    Request: ConsumeOAuthStateInput,
    Result: OAuthStateRecord,
    execute: ({ state }) =>
      sql`
        SELECT state, user_id AS "userId", provider, created_at AS "createdAt"
        FROM external_oauth_states WHERE state = ${state}
      `,
  });

  const deleteStateRow = SqlSchema.void({
    Request: ConsumeOAuthStateInput,
    execute: ({ state }) => sql`DELETE FROM external_oauth_states WHERE state = ${state}`,
  });

  const upsert: ExternalConnectionRepositoryShape["upsert"] = (input) =>
    upsertRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("ExternalConnectionRepository.upsert:query")),
    );

  const getByUserAndProvider: ExternalConnectionRepositoryShape["getByUserAndProvider"] = (
    input,
  ) =>
    getRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ExternalConnectionRepository.getByUserAndProvider:query"),
      ),
    );

  const del: ExternalConnectionRepositoryShape["delete"] = (input) =>
    deleteRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("ExternalConnectionRepository.delete:query")),
    );

  const insertOAuthState: ExternalConnectionRepositoryShape["insertOAuthState"] = (input) =>
    insertStateRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("ExternalConnectionRepository.insertOAuthState:query")),
    );

  const consumeOAuthState: ExternalConnectionRepositoryShape["consumeOAuthState"] = (input) =>
    findStateRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ExternalConnectionRepository.consumeOAuthState:find"),
      ),
      Effect.tap((row) =>
        Option.isSome(row)
          ? deleteStateRow(input).pipe(
              Effect.mapError(
                toPersistenceSqlError("ExternalConnectionRepository.consumeOAuthState:delete"),
              ),
            )
          : Effect.void,
      ),
    );

  return {
    upsert,
    getByUserAndProvider,
    delete: del,
    insertOAuthState,
    consumeOAuthState,
  } satisfies ExternalConnectionRepositoryShape;
});

export const ExternalConnectionRepositoryLive = Layer.effect(
  ExternalConnectionRepository,
  makeExternalConnectionRepository,
);
