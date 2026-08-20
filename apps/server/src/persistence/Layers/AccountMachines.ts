import * as Crypto from "node:crypto";

import { Effect, Layer, Option, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import {
  toPersistenceDecodeError,
  toPersistenceSqlError,
  type AccountMachineRepositoryError,
} from "../Errors.ts";
import {
  AccountMachineRecord,
  AccountMachineRepository,
  type AccountMachineRepositoryShape,
  GetAccountMachineInput,
  ListAccountMachinesInput,
} from "../Services/AccountMachines.ts";

function toPersistenceSqlOrDecodeError(sqlOperation: string, decodeOperation: string) {
  return (cause: unknown): AccountMachineRepositoryError =>
    Schema.isSchemaError(cause)
      ? toPersistenceDecodeError(decodeOperation)(cause)
      : toPersistenceSqlError(sqlOperation)(cause);
}

/** Spelled once, so every read of this table returns the same shape. */
const machineColumns = `
  machine_id AS "machineId",
  user_id AS "userId",
  auth_session_id AS "authSessionId",
  label AS "label",
  platform AS "platform",
  first_seen_at AS "firstSeenAt",
  last_seen_at AS "lastSeenAt",
  revoked_at AS "revokedAt"
`;

const InsertAccountMachineRow = Schema.Struct({
  machineId: Schema.String,
  userId: Schema.String,
  authSessionId: Schema.String,
  label: Schema.NullOr(Schema.String),
  platform: Schema.NullOr(Schema.String),
  nowIso: Schema.String,
});

const ReviveAccountMachineRow = Schema.Struct({
  machineId: Schema.String,
  authSessionId: Schema.String,
  platform: Schema.NullOr(Schema.String),
  nowIso: Schema.String,
});

/**
 * The candidate for revival, and note what it insists on.
 *
 * `revoked_at IS NOT NULL` is the whole safety argument. A row is only ever
 * repointed at a new credential when the credential it used to name is one this
 * account already cut off; a *live* machine never has its row taken over. Drop
 * that condition and two laptops that happen to share a name would collapse
 * into one row, and the credential belonging to whichever one lost would go on
 * working while disappearing from the only list that could revoke it — the
 * exact failure this table exists to close.
 *
 * `label IS NOT NULL` is enforced by the caller rather than here, because an
 * unnamed machine cannot be recognised as the same machine by anything: two
 * nulls are not evidence of a reunion.
 */
const FindRevivableAccountMachineRow = Schema.Struct({
  userId: Schema.String,
  label: Schema.String,
  platform: Schema.NullOr(Schema.String),
});

const makeAccountMachineRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const insertMachineRow = SqlSchema.findOneOption({
    Request: InsertAccountMachineRow,
    Result: AccountMachineRecord,
    execute: (input) =>
      sql`
        INSERT INTO account_machines (
          machine_id,
          user_id,
          auth_session_id,
          label,
          platform,
          first_seen_at,
          last_seen_at,
          revoked_at
        )
        VALUES (
          ${input.machineId},
          ${input.userId},
          ${input.authSessionId},
          ${input.label},
          ${input.platform},
          ${input.nowIso},
          ${input.nowIso},
          NULL
        )
        RETURNING ${sql.literal(machineColumns)}
      `,
  });

  const findRevivableMachineRow = SqlSchema.findOneOption({
    Request: FindRevivableAccountMachineRow,
    Result: AccountMachineRecord,
    execute: (input) =>
      sql`
        SELECT ${sql.literal(machineColumns)}
        FROM account_machines
        WHERE user_id = ${input.userId}
          AND label = ${input.label}
          AND platform IS ${input.platform}
          AND revoked_at IS NOT NULL
        ORDER BY last_seen_at DESC
        LIMIT 1
      `,
  });

  const reviveMachineRow = SqlSchema.findOneOption({
    Request: ReviveAccountMachineRow,
    Result: AccountMachineRecord,
    execute: (input) =>
      sql`
        UPDATE account_machines
        SET auth_session_id = ${input.authSessionId},
            platform = ${input.platform},
            last_seen_at = ${input.nowIso},
            revoked_at = NULL
        WHERE machine_id = ${input.machineId}
          AND revoked_at IS NOT NULL
        RETURNING ${sql.literal(machineColumns)}
      `,
  });

  const listActiveRows = SqlSchema.findAll({
    Request: ListAccountMachinesInput,
    Result: AccountMachineRecord,
    execute: ({ userId }) =>
      sql`
        SELECT ${sql.literal(machineColumns)}
        FROM account_machines
        WHERE user_id = ${userId}
          AND revoked_at IS NULL
        ORDER BY last_seen_at DESC, machine_id ASC
      `,
  });

  const getForUserRow = SqlSchema.findOneOption({
    Request: GetAccountMachineInput,
    Result: AccountMachineRecord,
    execute: ({ machineId, userId }) =>
      sql`
        SELECT ${sql.literal(machineColumns)}
        FROM account_machines
        WHERE machine_id = ${machineId}
          AND user_id = ${userId}
      `,
  });

  const revokeMachineRow = SqlSchema.findOneOption({
    Request: Schema.Struct({
      machineId: Schema.String,
      userId: Schema.String,
      revokedAt: Schema.String,
    }),
    Result: AccountMachineRecord,
    execute: (input) =>
      sql`
        UPDATE account_machines
        SET revoked_at = ${input.revokedAt}
        WHERE machine_id = ${input.machineId}
          AND user_id = ${input.userId}
          AND revoked_at IS NULL
        RETURNING ${sql.literal(machineColumns)}
      `,
  });

  const touchRow = SqlSchema.void({
    Request: Schema.Struct({
      authSessionId: Schema.String,
      lastSeenAt: Schema.String,
    }),
    execute: (input) =>
      sql`
        UPDATE account_machines
        SET last_seen_at = ${input.lastSeenAt}
        WHERE auth_session_id = ${input.authSessionId}
          AND revoked_at IS NULL
      `,
  });

  /**
   * One row per credential the account has handed out, reusing a machine's own
   * abandoned row when — and only when — that row names a credential already
   * revoked.
   *
   * The transaction matters: the revival is decided from a row read a moment
   * earlier, and the UPDATE repeats `revoked_at IS NOT NULL` so that a
   * simultaneous reconnection of the same machine cannot both claim it. Whoever
   * loses that race finds no row updated and inserts instead, which costs a
   * duplicate line in Settings rather than a credential nobody can see.
   */
  const register: AccountMachineRepositoryShape["register"] = (input) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          if (input.label !== null) {
            const revivable = yield* findRevivableMachineRow({
              userId: input.userId,
              label: input.label,
              platform: input.platform,
            });
            if (Option.isSome(revivable)) {
              const revived = yield* reviveMachineRow({
                machineId: revivable.value.machineId,
                authSessionId: input.authSessionId,
                platform: input.platform,
                nowIso: input.nowIso,
              });
              if (Option.isSome(revived)) {
                return revived.value;
              }
            }
          }

          const inserted = yield* insertMachineRow({
            machineId: Crypto.randomUUID(),
            userId: input.userId,
            authSessionId: input.authSessionId,
            label: input.label,
            platform: input.platform,
            nowIso: input.nowIso,
          });
          // `RETURNING` on an INSERT that ran without error always yields the
          // row, so this is unreachable; it fails rather than inventing a
          // record, because a caller told "registered" about a row that is not
          // there would hand over a credential nothing can revoke.
          if (Option.isNone(inserted)) {
            return yield* Effect.fail(new Error("Insert returned no account machine row."));
          }
          return inserted.value;
        }),
      )
      .pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "AccountMachineRepository.register:query",
            "AccountMachineRepository.register:decodeRow",
          ),
        ),
      );

  const listActiveForUser: AccountMachineRepositoryShape["listActiveForUser"] = (input) =>
    listActiveRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "AccountMachineRepository.listActiveForUser:query",
          "AccountMachineRepository.listActiveForUser:decodeRows",
        ),
      ),
    );

  const getForUser: AccountMachineRepositoryShape["getForUser"] = (input) =>
    getForUserRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "AccountMachineRepository.getForUser:query",
          "AccountMachineRepository.getForUser:decodeRow",
        ),
      ),
    );

  const markRevoked: AccountMachineRepositoryShape["markRevoked"] = (input) =>
    revokeMachineRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "AccountMachineRepository.markRevoked:query",
          "AccountMachineRepository.markRevoked:decodeRow",
        ),
      ),
    );

  const touchByAuthSession: AccountMachineRepositoryShape["touchByAuthSession"] = (input) =>
    touchRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "AccountMachineRepository.touchByAuthSession:query",
          "AccountMachineRepository.touchByAuthSession:encodeRequest",
        ),
      ),
    );

  return {
    register,
    listActiveForUser,
    getForUser,
    markRevoked,
    touchByAuthSession,
  } satisfies AccountMachineRepositoryShape;
});

export const AccountMachineRepositoryLive = Layer.effect(
  AccountMachineRepository,
  makeAccountMachineRepository,
);
