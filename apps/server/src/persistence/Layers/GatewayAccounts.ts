import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { Effect, Layer, Option } from "effect";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  GatewayAccountRecord,
  GatewayAccountRepository,
  type GatewayAccountRepositoryShape,
  GetGatewayAccountByUserIdInput,
  UpsertGatewayAccountInput,
} from "../Services/GatewayAccounts.ts";

const makeGatewayAccountRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertAccountRow = SqlSchema.void({
    Request: UpsertGatewayAccountInput,
    execute: (input) =>
      sql`
        INSERT INTO gateway_accounts (
          user_id,
          external_id,
          gateway_user_id,
          api_key,
          status,
          created_at,
          updated_at
        )
        VALUES (
          ${input.userId},
          ${input.externalId},
          ${input.gatewayUserId},
          ${input.apiKey},
          ${input.status},
          ${input.createdAt},
          ${input.updatedAt}
        )
        ON CONFLICT (user_id)
        DO UPDATE SET
          external_id = excluded.external_id,
          gateway_user_id = excluded.gateway_user_id,
          api_key = excluded.api_key,
          status = excluded.status,
          updated_at = excluded.updated_at
      `,
  });

  const getAccountRowByUserId = SqlSchema.findOneOption({
    Request: GetGatewayAccountByUserIdInput,
    Result: GatewayAccountRecord,
    execute: ({ userId }) =>
      sql`
        SELECT
          user_id AS "userId",
          external_id AS "externalId",
          gateway_user_id AS "gatewayUserId",
          api_key AS "apiKey",
          status,
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM gateway_accounts
        WHERE user_id = ${userId}
      `,
  });

  const upsert: GatewayAccountRepositoryShape["upsert"] = (input) =>
    upsertAccountRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("GatewayAccountRepository.upsert:query")),
    );

  const getByUserId: GatewayAccountRepositoryShape["getByUserId"] = (input) =>
    getAccountRowByUserId(input).pipe(
      Effect.mapError(toPersistenceSqlError("GatewayAccountRepository.getByUserId:query")),
      Effect.map((account) => (Option.isSome(account) ? Option.some(account.value) : account)),
    );

  return {
    upsert,
    getByUserId,
  } satisfies GatewayAccountRepositoryShape;
});

export const GatewayAccountRepositoryLive = Layer.effect(
  GatewayAccountRepository,
  makeGatewayAccountRepository,
);
