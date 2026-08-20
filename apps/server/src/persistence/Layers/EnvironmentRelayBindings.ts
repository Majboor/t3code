import { Effect, Layer, Option, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import {
  toPersistenceDecodeError,
  toPersistenceSqlError,
  type EnvironmentRelayBindingRepositoryError,
} from "../Errors.ts";
import {
  BindEnvironmentRelayInput,
  EnvironmentRelayBindingRecord,
  EnvironmentRelayBindingRepository,
  type EnvironmentRelayBindingRepositoryShape,
  GetEnvironmentRelayBindingInput,
  ListEnvironmentRelayBindingsInput,
  ReleaseEnvironmentRelayBindingsInput,
} from "../Services/EnvironmentRelayBindings.ts";

function toPersistenceSqlOrDecodeError(sqlOperation: string, decodeOperation: string) {
  return (cause: unknown): EnvironmentRelayBindingRepositoryError =>
    Schema.isSchemaError(cause)
      ? toPersistenceDecodeError(decodeOperation)(cause)
      : toPersistenceSqlError(sqlOperation)(cause);
}

/** Spelled once, so every read of this table returns the same shape. */
const bindingColumns = `
  environment_id AS "environmentId",
  user_id AS "userId",
  machine_id AS "machineId",
  label AS "label",
  first_bound_at AS "firstBoundAt",
  last_connected_at AS "lastConnectedAt"
`;

const makeEnvironmentRelayBindingRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  /**
   * One statement, because the reconnect case is the common one and a
   * read-then-write would let two dials of the same environment interleave into
   * two half-applied bindings.
   *
   * `first_bound_at` is excluded from the update clause on purpose: it is the
   * age of the *environment*, and a rebind onto a new laptop must not reset it.
   * `user_id` is written on conflict rather than left alone because the caller
   * has already established, via `decideRelayBinding`, that the owner either
   * matches or the claim was refused before reaching here — so the only way
   * this line changes anything is a row it was allowed to change.
   */
  const upsertBindingRow = SqlSchema.findOneOption({
    Request: BindEnvironmentRelayInput,
    Result: EnvironmentRelayBindingRecord,
    execute: (input) =>
      sql`
        INSERT INTO environment_relay_bindings (
          environment_id,
          user_id,
          machine_id,
          label,
          first_bound_at,
          last_connected_at
        )
        VALUES (
          ${input.environmentId},
          ${input.userId},
          ${input.machineId},
          ${input.label},
          ${input.nowIso},
          ${input.nowIso}
        )
        ON CONFLICT (environment_id) DO UPDATE SET
          user_id = excluded.user_id,
          machine_id = excluded.machine_id,
          label = excluded.label,
          last_connected_at = excluded.last_connected_at
        RETURNING ${sql.literal(bindingColumns)}
      `,
  });

  const getBindingRow = SqlSchema.findOneOption({
    Request: GetEnvironmentRelayBindingInput,
    Result: EnvironmentRelayBindingRecord,
    execute: ({ environmentId }) =>
      sql`
        SELECT ${sql.literal(bindingColumns)}
        FROM environment_relay_bindings
        WHERE environment_id = ${environmentId}
      `,
  });

  const listBindingRows = SqlSchema.findAll({
    Request: ListEnvironmentRelayBindingsInput,
    Result: EnvironmentRelayBindingRecord,
    execute: ({ userId }) =>
      sql`
        SELECT ${sql.literal(bindingColumns)}
        FROM environment_relay_bindings
        WHERE user_id = ${userId}
        ORDER BY last_connected_at DESC, environment_id ASC
      `,
  });

  /**
   * Deletes and reports back in one statement.
   *
   * The caller needs the ids to drop the matching live connections out of the
   * in-memory registry, and a `SELECT` followed by a `DELETE` would miss a
   * binding created between the two — which is exactly a machine reconnecting
   * in the instant it was revoked.
   */
  const releaseBindingRows = SqlSchema.findAll({
    Request: ReleaseEnvironmentRelayBindingsInput,
    Result: EnvironmentRelayBindingRecord,
    execute: ({ machineId }) =>
      sql`
        DELETE FROM environment_relay_bindings
        WHERE machine_id = ${machineId}
        RETURNING ${sql.literal(bindingColumns)}
      `,
  });

  const bind: EnvironmentRelayBindingRepositoryShape["bind"] = (input) =>
    upsertBindingRow(input).pipe(
      Effect.flatMap((row) =>
        Option.isSome(row)
          ? Effect.succeed(row.value)
          : // `RETURNING` on an upsert that ran without error always yields the
            // row, so this is unreachable. It fails rather than inventing a
            // record: a caller told "bound" about a row that is not there would
            // route a browser by a name nothing owns.
            Effect.fail(new Error("Upsert returned no environment relay binding row.")),
      ),
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "EnvironmentRelayBindingRepository.bind:query",
          "EnvironmentRelayBindingRepository.bind:decodeRow",
        ),
      ),
    );

  const getByEnvironmentId: EnvironmentRelayBindingRepositoryShape["getByEnvironmentId"] = (
    input,
  ) =>
    getBindingRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "EnvironmentRelayBindingRepository.getByEnvironmentId:query",
          "EnvironmentRelayBindingRepository.getByEnvironmentId:decodeRow",
        ),
      ),
    );

  const listForUser: EnvironmentRelayBindingRepositoryShape["listForUser"] = (input) =>
    listBindingRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "EnvironmentRelayBindingRepository.listForUser:query",
          "EnvironmentRelayBindingRepository.listForUser:decodeRows",
        ),
      ),
    );

  const releaseForMachine: EnvironmentRelayBindingRepositoryShape["releaseForMachine"] = (input) =>
    releaseBindingRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "EnvironmentRelayBindingRepository.releaseForMachine:query",
          "EnvironmentRelayBindingRepository.releaseForMachine:decodeRows",
        ),
      ),
    );

  return {
    bind,
    getByEnvironmentId,
    listForUser,
    releaseForMachine,
  } satisfies EnvironmentRelayBindingRepositoryShape;
});

export const EnvironmentRelayBindingRepositoryLive = Layer.effect(
  EnvironmentRelayBindingRepository,
  makeEnvironmentRelayBindingRepository,
);
