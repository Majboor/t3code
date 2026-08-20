import { assert, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { DeviceEnrollmentRepositoryLive } from "./DeviceEnrollments.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";
import {
  DeviceEnrollmentRepository,
  hashDeviceEnrollmentCode,
} from "../Services/DeviceEnrollments.ts";

const layer = it.layer(
  Layer.mergeAll(
    DeviceEnrollmentRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
    SqlitePersistenceMemory,
  ),
);

const AT = Date.parse("2026-08-20T12:00:00.000Z");
const TEN_MINUTES = 10 * 60 * 1000;

const newEnrollment = {
  createdAt: "2026-08-20T12:00:00.000Z",
  expiresAtMs: AT + TEN_MINUTES,
  deviceLabel: "Ana's MacBook",
  devicePlatform: "macos",
  requestedIp: "203.0.113.7",
};

layer("DeviceEnrollmentRepository", (it) => {
  it.effect("keeps the digest and never the code", () =>
    Effect.gen(function* () {
      const repository = yield* DeviceEnrollmentRepository;
      const sql = yield* SqlClient.SqlClient;

      const created = yield* repository.create(newEnrollment);
      assert.equal(created.codeHash, hashDeviceEnrollmentCode(created.code));

      // The point of the whole scheme: an operator reading this table finds no
      // working codes for machines still waiting to be approved.
      const matchingCode = yield* sql`
        SELECT code_hash FROM device_enrollments WHERE code_hash = ${created.code}
      `;
      assert.equal(matchingCode.length, 0);
      const matchingHash = yield* sql`
        SELECT code_hash FROM device_enrollments WHERE code_hash = ${created.codeHash}
      `;
      assert.equal(matchingHash.length, 1);

      const found = yield* repository.getByCode({ code: created.code });
      assert.isTrue(Option.isSome(found));
      assert.equal(Option.getOrUndefined(found)?.status, "pending");
      assert.equal(Option.getOrUndefined(found)?.deviceLabel, "Ana's MacBook");

      const guessed = yield* repository.getByCode({ code: "a-code-somebody-guessed" });
      assert.isTrue(Option.isNone(guessed));
    }),
  );

  it.effect("mints a different code every time", () =>
    Effect.gen(function* () {
      const repository = yield* DeviceEnrollmentRepository;
      const codes = new Set<string>();
      for (let index = 0; index < 16; index += 1) {
        codes.add((yield* repository.create(newEnrollment)).code);
      }
      assert.equal(codes.size, 16);
    }),
  );

  it.effect("collects exactly once, whatever the state machine was told twice", () =>
    Effect.gen(function* () {
      const repository = yield* DeviceEnrollmentRepository;
      const created = yield* repository.create(newEnrollment);

      const approved = yield* repository.applyTransition({
        code: created.code,
        action: { type: "approve", byUserId: "local:ana" },
        nowMs: AT,
        nowIso: "2026-08-20T12:01:00.000Z",
        approvedByUserId: "local:ana",
        approvedBySubject: "local-user:local:ana",
        approvedByRole: "client",
      });
      assert.equal(approved.outcome, "accept");

      const first = yield* repository.applyTransition({
        code: created.code,
        action: { type: "collect" },
        nowMs: AT,
        nowIso: "2026-08-20T12:02:00.000Z",
      });
      assert.equal(first.outcome, "accept");
      if (first.outcome === "accept") {
        assert.equal(first.record.status, "collected");
        // The subject survives the collection, because it is what the session
        // about to be minted is made from.
        assert.equal(first.record.approvedBySubject, "local-user:local:ana");
        assert.equal(first.record.approvedByRole, "client");
      }

      const second = yield* repository.applyTransition({
        code: created.code,
        action: { type: "collect" },
        nowMs: AT,
        nowIso: "2026-08-20T12:03:00.000Z",
      });
      assert.equal(second.outcome, "reject");
      if (second.outcome === "reject") {
        assert.equal(second.reason, "already-collected");
      }
    }),
  );

  it.effect("reads expiry off the row rather than believing the status column", () =>
    Effect.gen(function* () {
      const repository = yield* DeviceEnrollmentRepository;
      const created = yield* repository.create(newEnrollment);

      // Still literally 'pending' in the table; nothing sweeps it.
      const stored = yield* repository.getByCode({ code: created.code });
      assert.equal(Option.getOrUndefined(stored)?.status, "pending");

      const late = yield* repository.applyTransition({
        code: created.code,
        action: { type: "approve", byUserId: "local:ana" },
        nowMs: AT + TEN_MINUTES,
        nowIso: "2026-08-20T12:10:00.000Z",
        approvedByUserId: "local:ana",
        approvedBySubject: "local-user:local:ana",
        approvedByRole: "client",
      });
      assert.equal(late.outcome, "reject");
      if (late.outcome === "reject") {
        assert.equal(late.reason, "expired");
      }
    }),
  );

  it.effect("clears the approver when a machine is denied", () =>
    Effect.gen(function* () {
      const repository = yield* DeviceEnrollmentRepository;
      const created = yield* repository.create(newEnrollment);

      yield* repository.applyTransition({
        code: created.code,
        action: { type: "approve", byUserId: "local:ana" },
        nowMs: AT,
        nowIso: "2026-08-20T12:01:00.000Z",
        approvedByUserId: "local:ana",
        approvedBySubject: "local-user:local:ana",
        approvedByRole: "client",
      });

      const denied = yield* repository.applyTransition({
        code: created.code,
        action: { type: "deny" },
        nowMs: AT,
        nowIso: "2026-08-20T12:02:00.000Z",
      });
      assert.equal(denied.outcome, "accept");
      if (denied.outcome === "accept") {
        // A stale approver on a denied row is an identity something could be
        // collected against if a guard above ever slipped.
        assert.equal(denied.record.approvedByUserId, null);
        assert.equal(denied.record.approvedBySubject, null);
        assert.equal(denied.record.approvedByRole, null);
      }
    }),
  );

  it.effect("reports a code it has never seen as missing, not as refused", () =>
    Effect.gen(function* () {
      const repository = yield* DeviceEnrollmentRepository;
      const applied = yield* repository.applyTransition({
        code: "never-issued",
        action: { type: "collect" },
        nowMs: AT,
        nowIso: "2026-08-20T12:00:00.000Z",
      });
      assert.equal(applied.outcome, "not-found");
    }),
  );

  it.effect("lists what one person approved, newest first, and nobody else's", () =>
    Effect.gen(function* () {
      const repository = yield* DeviceEnrollmentRepository;

      const approve = (byUserId: string, approvedAt: string) =>
        Effect.gen(function* () {
          const created = yield* repository.create(newEnrollment);
          yield* repository.applyTransition({
            code: created.code,
            action: { type: "approve", byUserId },
            nowMs: AT,
            nowIso: approvedAt,
            approvedByUserId: byUserId,
            approvedBySubject: `local-user:${byUserId}`,
            approvedByRole: "client",
          });
          return created;
        });

      yield* approve("local:list-ana", "2026-08-20T12:01:00.000Z");
      yield* approve("local:list-ana", "2026-08-20T12:05:00.000Z");
      yield* approve("local:list-bo", "2026-08-20T12:06:00.000Z");
      yield* repository.create(newEnrollment);

      const ana = yield* repository.listApprovedBy({ approvedByUserId: "local:list-ana" });
      assert.equal(ana.length, 2);
      assert.equal(ana[0]?.approvedAt, "2026-08-20T12:05:00.000Z");
      assert.equal(ana[1]?.approvedAt, "2026-08-20T12:01:00.000Z");

      const bo = yield* repository.listApprovedBy({ approvedByUserId: "local:list-bo" });
      assert.equal(bo.length, 1);

      const nobody = yield* repository.listApprovedBy({ approvedByUserId: "local:list-carter" });
      assert.equal(nobody.length, 0);
    }),
  );
});
