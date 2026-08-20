import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { Effect, Layer, Schema } from "effect";

import { PortNumber } from "@t3tools/contracts";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  EnvironmentPortClaimRow,
  EnvironmentServiceRepository,
  type EnvironmentServiceRepositoryShape,
  EnvironmentServiceRow,
  GetEnvironmentServiceInput,
  HeartbeatEnvironmentServicesInput,
  ListEnvironmentServicesInput,
  ReleasePortClaimInput,
  StopEnvironmentServiceInput,
} from "../Services/EnvironmentServices.ts";

const SERVICE_COLUMNS = `service_id AS "id",
  environment_id AS "environmentId",
  name,
  port,
  pid,
  command,
  started_by AS "startedBy",
  started_at AS "startedAt",
  heartbeat_at AS "heartbeatAt",
  stopped_at AS "stoppedAt"`;

const CLAIM_COLUMNS = `environment_id AS "environmentId",
  port,
  claimed_by AS "claimedBy",
  purpose,
  claimed_at AS "claimedAt",
  expires_at AS "expiresAt"`;

const ReleasedPort = Schema.Struct({ port: PortNumber });

const makeEnvironmentServiceRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  /**
   * Registering replaces whatever live record held the port.
   *
   * The conflict target is the partial unique index from migration 063, so it
   * only fires against a record that has not been stopped. A restart is the same
   * service with a new pid; leaving the old row live would leave a dead pid
   * claiming to be running, and the pid is the thing ownership is decided on.
   */
  const registerRow = SqlSchema.void({
    Request: EnvironmentServiceRow,
    execute: (input) =>
      sql`
        INSERT INTO environment_services (
          service_id,
          environment_id,
          name,
          port,
          pid,
          command,
          started_by,
          started_at,
          heartbeat_at,
          stopped_at
        )
        VALUES (
          ${input.id},
          ${input.environmentId},
          ${input.name},
          ${input.port},
          ${input.pid},
          ${input.command},
          ${input.startedBy},
          ${input.startedAt},
          ${input.heartbeatAt},
          ${input.stoppedAt}
        )
        ON CONFLICT (environment_id, port) WHERE stopped_at IS NULL
        DO UPDATE SET
          service_id = excluded.service_id,
          name = excluded.name,
          pid = excluded.pid,
          command = excluded.command,
          started_by = excluded.started_by,
          started_at = excluded.started_at,
          heartbeat_at = excluded.heartbeat_at
      `,
  });

  // Stopped records are returned too. The sweep that decides what counts as
  // running happens above this, against an explicit clock, and it cannot make
  // that decision from rows it was never shown.
  const listRows = SqlSchema.findAll({
    Request: ListEnvironmentServicesInput,
    Result: EnvironmentServiceRow,
    execute: ({ environmentId }) =>
      sql`SELECT ${sql.literal(SERVICE_COLUMNS)} FROM environment_services
          WHERE environment_id = ${environmentId}
          ORDER BY port ASC, started_at ASC`,
  });

  const getRow = SqlSchema.findOneOption({
    Request: GetEnvironmentServiceInput,
    Result: EnvironmentServiceRow,
    execute: ({ serviceId }) =>
      sql`SELECT ${sql.literal(SERVICE_COLUMNS)} FROM environment_services
          WHERE service_id = ${serviceId}`,
  });

  const heartbeatRows = SqlSchema.void({
    Request: HeartbeatEnvironmentServicesInput,
    execute: ({ ids, heartbeatAt }) =>
      sql`
        UPDATE environment_services
        SET heartbeat_at = ${heartbeatAt}
        WHERE stopped_at IS NULL AND ${sql.in("service_id", ids)}
      `,
  });

  // Guarded on `stopped_at IS NULL` so stopping twice does not rewrite the
  // moment it stopped. The first answer is the true one.
  const stopRow = SqlSchema.void({
    Request: StopEnvironmentServiceInput,
    execute: ({ serviceId, stoppedAt }) =>
      sql`
        UPDATE environment_services
        SET stopped_at = ${stoppedAt}
        WHERE service_id = ${serviceId} AND stopped_at IS NULL
      `,
  });

  const listClaimRows = SqlSchema.findAll({
    Request: ListEnvironmentServicesInput,
    Result: EnvironmentPortClaimRow,
    execute: ({ environmentId }) =>
      sql`SELECT ${sql.literal(CLAIM_COLUMNS)} FROM environment_port_claims
          WHERE environment_id = ${environmentId}
          ORDER BY port ASC`,
  });

  /**
   * Taking a port that already has a live claim is refused above this, so an
   * upsert here means one of two harmless things: the holder is extending their
   * own reservation, or the previous one had already lapsed.
   */
  const upsertClaimRow = SqlSchema.void({
    Request: EnvironmentPortClaimRow,
    execute: (input) =>
      sql`
        INSERT INTO environment_port_claims (
          environment_id, port, claimed_by, purpose, claimed_at, expires_at
        )
        VALUES (
          ${input.environmentId},
          ${input.port},
          ${input.claimedBy},
          ${input.purpose},
          ${input.claimedAt},
          ${input.expiresAt}
        )
        ON CONFLICT (environment_id, port)
        DO UPDATE SET
          claimed_by = excluded.claimed_by,
          purpose = excluded.purpose,
          claimed_at = excluded.claimed_at,
          expires_at = excluded.expires_at
      `,
  });

  /**
   * Deletes and reports in one statement.
   *
   * `claimed_by` is in the WHERE rather than checked beforehand: a read followed
   * by a delete would let somebody else's claim, taken in between, be released
   * by this call. The empty result is how "there was nothing of yours here" gets
   * back to the caller, which is not an error — releasing a lapsed reservation is
   * the ordinary end of one.
   */
  const releaseClaimRows = SqlSchema.findAll({
    Request: ReleasePortClaimInput,
    Result: ReleasedPort,
    execute: ({ environmentId, port, claimedBy }) =>
      sql`
        DELETE FROM environment_port_claims
        WHERE environment_id = ${environmentId}
          AND port = ${port}
          AND claimed_by = ${claimedBy}
        RETURNING port
      `,
  });

  return {
    list: (input) =>
      listRows(input).pipe(
        Effect.mapError(toPersistenceSqlError("EnvironmentServiceRepository.list:query")),
      ),
    get: (input) =>
      getRow(input).pipe(
        Effect.mapError(toPersistenceSqlError("EnvironmentServiceRepository.get:query")),
      ),
    register: (input) =>
      registerRow(input).pipe(
        Effect.mapError(toPersistenceSqlError("EnvironmentServiceRepository.register:query")),
      ),
    heartbeat: (input) =>
      // An empty batch is the common case on an idle machine and must not reach
      // `sql.in`, which has no sensible SQL for "none of these".
      input.ids.length === 0
        ? Effect.void
        : heartbeatRows(input).pipe(
            Effect.mapError(toPersistenceSqlError("EnvironmentServiceRepository.heartbeat:query")),
          ),
    stop: (input) =>
      stopRow(input).pipe(
        Effect.mapError(toPersistenceSqlError("EnvironmentServiceRepository.stop:query")),
      ),
    listClaims: (input) =>
      listClaimRows(input).pipe(
        Effect.mapError(toPersistenceSqlError("EnvironmentServiceRepository.listClaims:query")),
      ),
    upsertClaim: (input) =>
      upsertClaimRow(input).pipe(
        Effect.mapError(toPersistenceSqlError("EnvironmentServiceRepository.upsertClaim:query")),
      ),
    releaseClaim: (input) =>
      releaseClaimRows(input).pipe(
        Effect.map((rows) => rows.length > 0),
        Effect.mapError(toPersistenceSqlError("EnvironmentServiceRepository.releaseClaim:query")),
      ),
  } satisfies EnvironmentServiceRepositoryShape;
});

export const EnvironmentServiceRepositoryLive: Layer.Layer<
  EnvironmentServiceRepository,
  never,
  SqlClient.SqlClient
> = Layer.effect(EnvironmentServiceRepository, makeEnvironmentServiceRepository);
