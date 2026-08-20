import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { Effect, Layer, Option, Schema } from "effect";

import {
  decideEnrollment,
  type EnrollmentAction,
  type EnrollmentStatus,
} from "../../deviceEnrollment/decideEnrollment.ts";
import {
  toPersistenceDecodeError,
  toPersistenceSqlError,
  type DeviceEnrollmentRepositoryError,
} from "../Errors.ts";
import {
  DeviceEnrollmentRecord,
  DeviceEnrollmentRepository,
  type DeviceEnrollmentRepositoryShape,
  type DeviceEnrollmentTransition,
  generateDeviceEnrollmentCode,
  hashDeviceEnrollmentCode,
  ListDeviceEnrollmentsApprovedByInput,
  toEnrollmentStatus,
} from "../Services/DeviceEnrollments.ts";

function toPersistenceSqlOrDecodeError(sqlOperation: string, decodeOperation: string) {
  return (cause: unknown): DeviceEnrollmentRepositoryError =>
    Schema.isSchemaError(cause)
      ? toPersistenceDecodeError(decodeOperation)(cause)
      : toPersistenceSqlError(sqlOperation)(cause);
}

/**
 * Every column a record needs, spelled once.
 *
 * The code is not among them, because the table does not have it. That is the
 * point of `code_hash`, and writing the list out here rather than `SELECT *`
 * keeps it that way if the table ever grows a column that should not travel.
 */
const enrollmentColumns = `
  code_hash AS "codeHash",
  status AS "status",
  created_at AS "createdAt",
  expires_at_ms AS "expiresAtMs",
  approved_at AS "approvedAt",
  approved_by_user_id AS "approvedByUserId",
  approved_by_subject AS "approvedBySubject",
  approved_by_role AS "approvedByRole",
  machine_role AS "machineRole",
  collected_at AS "collectedAt",
  device_label AS "deviceLabel",
  device_platform AS "devicePlatform",
  requested_ip AS "requestedIp"
`;

/** The insert takes a hash, never a code — the code never leaves `create`. */
const InsertDeviceEnrollmentRow = Schema.Struct({
  codeHash: Schema.String,
  createdAt: Schema.String,
  expiresAtMs: Schema.Number,
  deviceLabel: Schema.NullOr(Schema.String),
  devicePlatform: Schema.NullOr(Schema.String),
  requestedIp: Schema.NullOr(Schema.String),
});

/**
 * The write half of a transition, guarded by the status it was decided against.
 *
 * `expectedStatus` in the WHERE clause is what makes collection happen exactly
 * once. Two polls that both read `approved` will both be told to collect by a
 * pure function that cannot see the other; the database is the only place that
 * can break the tie, and it does so by refusing the second UPDATE rather than
 * by anyone remembering to check.
 */
const ApplyDeviceEnrollmentRow = Schema.Struct({
  codeHash: Schema.String,
  expectedStatus: Schema.String,
  nextStatus: Schema.String,
  approvedAt: Schema.NullOr(Schema.String),
  approvedByUserId: Schema.NullOr(Schema.String),
  approvedBySubject: Schema.NullOr(Schema.String),
  approvedByRole: Schema.NullOr(Schema.String),
  machineRole: Schema.NullOr(Schema.String),
  collectedAt: Schema.NullOr(Schema.String),
});

/**
 * What to report when the guarded UPDATE changes nothing.
 *
 * Reaching here means another request applied its own transition between this
 * one's read and its write. The honest answer is the state that writer left
 * behind, and for each action there is only one such state: an approval lost to
 * a concurrent approval, a collection lost to a concurrent collection, and a
 * denial lost to whatever terminal state now holds. Re-reading and re-deciding
 * would be more precise and would open a second race to lose.
 */
function lostRaceReason(action: EnrollmentAction) {
  switch (action.type) {
    case "approve":
      return "already-approved" as const;
    case "deny":
      return "denied" as const;
    case "collect":
      return "already-collected" as const;
  }
}

const makeDeviceEnrollmentRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const insertEnrollmentRow = SqlSchema.void({
    Request: InsertDeviceEnrollmentRow,
    execute: (input) =>
      sql`
        INSERT INTO device_enrollments (
          code_hash,
          status,
          created_at,
          expires_at_ms,
          approved_at,
          approved_by_user_id,
          approved_by_subject,
          approved_by_role,
          machine_role,
          collected_at,
          device_label,
          device_platform,
          requested_ip
        )
        VALUES (
          ${input.codeHash},
          'pending',
          ${input.createdAt},
          ${input.expiresAtMs},
          NULL,
          NULL,
          NULL,
          NULL,
          NULL,
          NULL,
          ${input.deviceLabel},
          ${input.devicePlatform},
          ${input.requestedIp}
        )
      `,
  });

  const getEnrollmentRowByHash = SqlSchema.findOneOption({
    Request: Schema.Struct({ codeHash: Schema.String }),
    Result: DeviceEnrollmentRecord,
    execute: ({ codeHash }) =>
      sql`
        SELECT ${sql.literal(enrollmentColumns)}
        FROM device_enrollments
        WHERE code_hash = ${codeHash}
      `,
  });

  const applyEnrollmentRow = SqlSchema.findOneOption({
    Request: ApplyDeviceEnrollmentRow,
    Result: DeviceEnrollmentRecord,
    execute: (input) =>
      sql`
        UPDATE device_enrollments
        SET status = ${input.nextStatus},
            approved_at = ${input.approvedAt},
            approved_by_user_id = ${input.approvedByUserId},
            approved_by_subject = ${input.approvedBySubject},
            approved_by_role = ${input.approvedByRole},
            machine_role = ${input.machineRole},
            collected_at = ${input.collectedAt}
        WHERE code_hash = ${input.codeHash}
          AND status = ${input.expectedStatus}
        RETURNING ${sql.literal(enrollmentColumns)}
      `,
  });

  const listApprovedByRows = SqlSchema.findAll({
    Request: ListDeviceEnrollmentsApprovedByInput,
    Result: DeviceEnrollmentRecord,
    execute: ({ approvedByUserId }) =>
      sql`
        SELECT ${sql.literal(enrollmentColumns)}
        FROM device_enrollments
        WHERE approved_by_user_id = ${approvedByUserId}
        ORDER BY approved_at DESC, code_hash ASC
      `,
  });

  /**
   * Mints a code, keeps its digest, and hands the code back exactly once.
   *
   * Generation lives here rather than in the caller so there is one place where
   * the entropy is chosen and one place where hashing happens — a caller that
   * could pass its own code could pass a guessable one, and a caller that
   * hashed for itself could forget to.
   */
  const create: DeviceEnrollmentRepositoryShape["create"] = (input) =>
    Effect.gen(function* () {
      const code = generateDeviceEnrollmentCode();
      const codeHash = hashDeviceEnrollmentCode(code);
      yield* insertEnrollmentRow({
        codeHash,
        createdAt: input.createdAt,
        expiresAtMs: input.expiresAtMs,
        deviceLabel: input.deviceLabel,
        devicePlatform: input.devicePlatform,
        requestedIp: input.requestedIp,
      });
      return { code, codeHash, expiresAtMs: input.expiresAtMs };
    }).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "DeviceEnrollmentRepository.create:query",
          "DeviceEnrollmentRepository.create:encodeRequest",
        ),
      ),
    );

  /**
   * The lookup is a hash and a primary-key probe, and the failure label names
   * the operation rather than the code: this runs on unauthenticated routes,
   * and a code in a log line is a credential in a log line.
   */
  const getByCode: DeviceEnrollmentRepositoryShape["getByCode"] = (input) =>
    getEnrollmentRowByHash({ codeHash: hashDeviceEnrollmentCode(input.code) }).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "DeviceEnrollmentRepository.getByCode:query",
          "DeviceEnrollmentRepository.getByCode:decodeRow",
        ),
      ),
    );

  const applyTransition: DeviceEnrollmentRepositoryShape["applyTransition"] = (input) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const codeHash = hashDeviceEnrollmentCode(input.code);
          const existing = yield* getEnrollmentRowByHash({ codeHash });
          if (Option.isNone(existing)) {
            return { outcome: "not-found" } satisfies DeviceEnrollmentTransition;
          }

          const row = existing.value;
          const status: EnrollmentStatus = toEnrollmentStatus(row.status);
          // The rules, asked rather than restated. Everything below is bookkeeping.
          const decision = decideEnrollment({
            record: {
              status,
              expiresAtMs: row.expiresAtMs,
              approvedByUserId: row.approvedByUserId,
            },
            action: input.action,
            nowMs: input.nowMs,
          });

          if (decision.outcome === "reject") {
            return {
              outcome: "reject",
              reason: decision.reason,
            } satisfies DeviceEnrollmentTransition;
          }

          const next = decision.next;
          const updated = yield* applyEnrollmentRow({
            codeHash,
            expectedStatus: row.status,
            nextStatus: next.status,
            // A denial clears the approver, exactly as the state machine says:
            // a stale id left on a denied row is an id that could be collected
            // against if the guard above ever slipped.
            approvedAt: next.status === "approved" ? input.nowIso : row.approvedAt,
            approvedByUserId: next.approvedByUserId,
            approvedBySubject:
              next.status === "approved"
                ? (input.approvedBySubject ?? null)
                : next.approvedByUserId === null
                  ? null
                  : row.approvedBySubject,
            approvedByRole:
              next.status === "approved"
                ? (input.approvedByRole ?? null)
                : next.approvedByUserId === null
                  ? null
                  : row.approvedByRole,
            // Cleared by a denial alongside the approver, for the same reason:
            // the role is half of what a collection would replay, and a denied
            // row must not carry either half forward.
            machineRole:
              next.status === "approved"
                ? (input.machineRole ?? null)
                : next.approvedByUserId === null
                  ? null
                  : row.machineRole,
            collectedAt: next.status === "collected" ? input.nowIso : row.collectedAt,
          });

          return Option.isSome(updated)
            ? ({ outcome: "accept", record: updated.value } satisfies DeviceEnrollmentTransition)
            : ({
                outcome: "reject",
                reason: lostRaceReason(input.action),
              } satisfies DeviceEnrollmentTransition);
        }),
      )
      .pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "DeviceEnrollmentRepository.applyTransition:query",
            "DeviceEnrollmentRepository.applyTransition:decodeRow",
          ),
        ),
      );

  const listApprovedBy: DeviceEnrollmentRepositoryShape["listApprovedBy"] = (input) =>
    listApprovedByRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "DeviceEnrollmentRepository.listApprovedBy:query",
          "DeviceEnrollmentRepository.listApprovedBy:decodeRows",
        ),
      ),
    );

  return {
    create,
    getByCode,
    applyTransition,
    listApprovedBy,
  } satisfies DeviceEnrollmentRepositoryShape;
});

export const DeviceEnrollmentRepositoryLive = Layer.effect(
  DeviceEnrollmentRepository,
  makeDeviceEnrollmentRepository,
);
