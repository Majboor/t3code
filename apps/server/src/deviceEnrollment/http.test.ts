import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { assert, beforeEach, it } from "@effect/vitest";
import { AuthSessionId, UserId } from "@t3tools/contracts";
import { DateTime, Effect, Layer } from "effect";
import { HttpRouter, HttpServer } from "effect/unstable/http";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { AuthError, ServerAuth, type AuthenticatedSession } from "../auth/Services/ServerAuth.ts";
import { SessionCredentialService } from "../auth/Services/SessionCredentialService.ts";
import { AccountMachineRepositoryLive } from "../persistence/Layers/AccountMachines.ts";
import { DeviceEnrollmentRepositoryLive } from "../persistence/Layers/DeviceEnrollments.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { hashDeviceEnrollmentCode } from "../persistence/Services/DeviceEnrollments.ts";
import {
  deviceEnrollmentApproveRouteLayer,
  deviceEnrollmentCollectRouteLayer,
  deviceEnrollmentCreateRouteLayer,
  deviceEnrollmentDenyRouteLayer,
  deviceEnrollmentPreviewRouteLayer,
  resetDeviceEnrollmentRateLimits,
} from "./http.ts";

/**
 * The device-enrollment routes, against a real database and a stubbed identity.
 *
 * The repository is the live one on an in-memory SQLite, because the properties
 * worth testing here — collected exactly once, expiry refused, a denial that
 * stays denied — are properties of what the database does under a guarded write,
 * and a fake repository would only prove that the fake agrees with itself.
 *
 * Identity is stubbed, because who the browser is belongs to `ServerAuth` and is
 * tested there. What matters at this layer is only whether the route asked.
 */

const APPROVER: AuthenticatedSession = {
  sessionId: AuthSessionId.make("session-approver"),
  subject: "local-user:local:ana",
  method: "browser-session-cookie",
  role: "client",
  client: { deviceType: "desktop" },
  userId: UserId.make("local:ana"),
};

interface IssuedRecord {
  readonly subject: string;
  readonly role: string;
}

/**
 * The session the collector walks away with, and a record of what it was minted
 * from. The subject and role are the whole point: a machine must arrive as the
 * person who approved it and with no more than they had.
 */
const makeSessionLayer = (issued: Array<IssuedRecord>) =>
  Layer.mock(SessionCredentialService)({
    cookieName: "t3_session",
    issue: (input) =>
      Effect.sync(() => {
        const role = input?.role ?? "client";
        issued.push({ subject: input?.subject ?? "", role });
        return {
          sessionId: AuthSessionId.make(`session-${issued.length}`),
          token: `minted-session-token-${issued.length}`,
          method: "bearer-session-token" as const,
          client: input?.client ?? { deviceType: "unknown" as const },
          expiresAt: DateTime.makeUnsafe(new Date("2030-01-01T00:00:00.000Z")),
          role,
        };
      }),
  });

const makeAuthLayer = (session: AuthenticatedSession | null) =>
  Layer.mock(ServerAuth)({
    authenticateHttpRequest: () =>
      session === null
        ? Effect.fail(new AuthError({ message: "Unauthorized request.", status: 401 }))
        : Effect.succeed(session),
  });

const routes = Layer.mergeAll(
  deviceEnrollmentCreateRouteLayer,
  deviceEnrollmentPreviewRouteLayer,
  deviceEnrollmentApproveRouteLayer,
  deviceEnrollmentDenyRouteLayer,
  deviceEnrollmentCollectRouteLayer,
);

const buildAppUnderTest = (options: {
  readonly session?: AuthenticatedSession | null;
  readonly issued?: Array<IssuedRecord>;
}) =>
  Layer.build(
    HttpRouter.serve(routes, { disableListenLog: true, disableLogger: true }).pipe(
      Layer.provide(makeAuthLayer(options.session ?? null)),
      Layer.provide(makeSessionLayer(options.issued ?? [])),
      Layer.provide(DeviceEnrollmentRepositoryLive),
      // Live, not mocked: `/collect` now files the machine under the approving
      // account before it answers, and a fake that always succeeds would hide
      // the fact that a failure there takes the credential back.
      Layer.provide(AccountMachineRepositoryLive),
    ),
  );

interface Reply {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

const call = (input: {
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly body?: unknown;
}) =>
  Effect.gen(function* () {
    const server = yield* HttpServer.HttpServer;
    const address = server.address as HttpServer.TcpAddress;
    const response = yield* Effect.promise(() =>
      fetch(`http://127.0.0.1:${address.port}${input.path}`, {
        method: input.method,
        ...(input.body === undefined
          ? {}
          : {
              headers: { "content-type": "application/json" },
              body: JSON.stringify(input.body),
            }),
      }),
    );
    const text = yield* Effect.promise(() => response.text());
    let body: Record<string, unknown> = {};
    try {
      body = text.length > 0 ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      body = { raw: text };
    }
    return { status: response.status, body } satisfies Reply;
  });

const createEnrollment = (body?: unknown) =>
  call({ method: "POST", path: "/api/devices/enrollments", ...(body ? { body } : {}) });

const preview = (code: string) => call({ method: "GET", path: `/api/devices/enrollments/${code}` });

const approve = (code: string) =>
  call({ method: "POST", path: `/api/devices/enrollments/${code}/approve` });

const deny = (code: string) =>
  call({ method: "POST", path: `/api/devices/enrollments/${code}/deny` });

const collect = (code: string) =>
  call({ method: "POST", path: `/api/devices/enrollments/${code}/collect` });

/** A row that lapsed before anyone looked at it, written straight to the table. */
const insertExpired = (code: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO device_enrollments (
        code_hash, status, created_at, expires_at_ms, device_label
      ) VALUES (
        ${hashDeviceEnrollmentCode(code)},
        'pending',
        '2026-08-16T09:00:00.000Z',
        ${Date.now() - 1000},
        'Lapsed laptop'
      )
    `;
  });

const testEnvironment = Layer.mergeAll(NodeHttpServer.layerTest, SqlitePersistenceMemory);

// The limiters are module state, so one test's traffic is another's head start.
beforeEach(() => {
  resetDeviceEnrollmentRateLimits();
});

it.live("hands the machine a code, a deadline and a link a person can open", () =>
  Effect.gen(function* () {
    yield* buildAppUnderTest({});

    const created = yield* createEnrollment({
      deviceLabel: "Ana's MacBook",
      devicePlatform: "macos",
    });

    assert.equal(created.status, 201);
    const code = created.body.code as string;
    assert.isString(code);
    assert.isAbove(code.length, 32);
    // Ten minutes, give or take the time this test took to get here.
    const remaining = (created.body.expiresAtMs as number) - Date.now();
    assert.isAbove(remaining, 9 * 60 * 1000);
    assert.isBelow(remaining, 10 * 60 * 1000 + 1000);
    assert.include(created.body.approveUrl as string, `/connect?code=${encodeURIComponent(code)}`);

    // The preview is what the approval screen renders, and it names the machine
    // so that "approve this?" is a question rather than a formality.
    const shown = yield* preview(code);
    assert.equal(shown.status, 200);
    assert.equal(shown.body.status, "pending");
    assert.equal(shown.body.deviceLabel, "Ana's MacBook");
    assert.equal(shown.body.devicePlatform, "macos");
    // No credential, ever, on the route anyone holding the code may call.
    assert.isUndefined(shown.body.code);
    assert.isUndefined(shown.body.sessionToken);
  }).pipe(Effect.provide(testEnvironment)),
);

it.live("refuses to approve without a signed-in browser, and leaves the row alone", () =>
  Effect.gen(function* () {
    yield* buildAppUnderTest({ session: null });

    const created = yield* createEnrollment({ deviceLabel: "Someone else's laptop" });
    const code = created.body.code as string;

    const refused = yield* approve(code);
    assert.equal(refused.status, 401);

    // The refusal has to be total: an unauthenticated approve that "nearly"
    // worked would be the whole feature undone.
    const shown = yield* preview(code);
    assert.equal(shown.body.status, "pending");

    const collected = yield* collect(code);
    assert.equal(collected.status, 425);
    assert.equal(collected.body.reason, "not-approved");
    assert.isUndefined(collected.body.sessionToken);
  }).pipe(Effect.provide(testEnvironment)),
);

it.live("hands over one credential for an approved machine, and never a second", () =>
  Effect.gen(function* () {
    const issued: Array<IssuedRecord> = [];
    yield* buildAppUnderTest({ session: APPROVER, issued });

    const created = yield* createEnrollment({ deviceLabel: "Ana's MacBook" });
    const code = created.body.code as string;

    const approved = yield* approve(code);
    assert.equal(approved.status, 200);
    assert.equal(approved.body.status, "approved");

    const first = yield* collect(code);
    assert.equal(first.status, 200);
    assert.equal(first.body.sessionToken, "minted-session-token-1");
    assert.equal(first.body.sessionMethod, "bearer-session-token");
    // Minted as the person who approved, with the role they had and no more.
    assert.deepEqual(issued, [{ subject: APPROVER.subject, role: APPROVER.role }]);

    const second = yield* collect(code);
    assert.equal(second.status, 409);
    assert.equal(second.body.reason, "already-collected");
    assert.isUndefined(second.body.sessionToken);
    // The second call did not merely fail to return a token; it never minted one.
    assert.equal(issued.length, 1);
  }).pipe(Effect.provide(testEnvironment)),
);

it.live("says 'not yet' to a poll that arrives before the click, and hands over nothing", () =>
  Effect.gen(function* () {
    const issued: Array<IssuedRecord> = [];
    yield* buildAppUnderTest({ session: APPROVER, issued });

    const created = yield* createEnrollment({});
    const code = created.body.code as string;

    const early = yield* collect(code);
    // 425, not 409: this is the ordinary shape of the flow and the poller must
    // keep waiting rather than start over.
    assert.equal(early.status, 425);
    assert.equal(early.body.reason, "not-approved");
    assert.isUndefined(early.body.sessionToken);
    assert.equal(issued.length, 0);

    // And the enrollment is untouched, so approving still works afterwards.
    assert.equal((yield* approve(code)).status, 200);
    assert.equal((yield* collect(code)).status, 200);
  }).pipe(Effect.provide(testEnvironment)),
);

it.live("refuses a code whose ten minutes ran out, whoever is asking", () =>
  Effect.gen(function* () {
    const issued: Array<IssuedRecord> = [];
    yield* buildAppUnderTest({ session: APPROVER, issued });
    const code = "expired-code-written-straight-to-the-table";
    yield* insertExpired(code);

    // Expiry is computed from the row, not read off `status`: nothing sweeps
    // this table, so the row still says "pending" and must not be believed.
    const shown = yield* preview(code);
    assert.equal(shown.status, 200);
    assert.equal(shown.body.status, "expired");

    const approved = yield* approve(code);
    assert.equal(approved.status, 409);
    assert.equal(approved.body.reason, "expired");

    const collected = yield* collect(code);
    assert.equal(collected.status, 409);
    assert.equal(collected.body.reason, "expired");
    assert.equal(issued.length, 0);
  }).pipe(Effect.provide(testEnvironment)),
);

it.live("keeps a denial denied: nothing collects against a machine somebody refused", () =>
  Effect.gen(function* () {
    const issued: Array<IssuedRecord> = [];
    yield* buildAppUnderTest({ session: APPROVER, issued });

    const created = yield* createEnrollment({ deviceLabel: "Not my laptop" });
    const code = created.body.code as string;

    assert.equal((yield* deny(code)).status, 200);
    assert.equal((yield* preview(code)).body.status, "denied");

    // A second attempt must not reopen the question, or the refusal meant
    // nothing.
    const reapproved = yield* approve(code);
    assert.equal(reapproved.status, 409);
    assert.equal(reapproved.body.reason, "denied");

    const collected = yield* collect(code);
    assert.equal(collected.status, 409);
    assert.equal(collected.body.reason, "denied");
    assert.equal(issued.length, 0);
  }).pipe(Effect.provide(testEnvironment)),
);

it.live("stops answering a code that is being hammered", () =>
  Effect.gen(function* () {
    yield* buildAppUnderTest({});

    const created = yield* createEnrollment({});
    const code = created.body.code as string;

    // 60 attempts a minute is far above any honest poll and far below what a
    // search would need.
    let lastStatus = 0;
    for (let attempt = 0; attempt < 61; attempt += 1) {
      lastStatus = (yield* preview(code)).status;
    }
    assert.equal(lastStatus, 429);

    // Collect keeps its own budget: exhausting the preview poll must not lock a
    // machine out of the one call that finishes the flow.
    assert.notEqual((yield* collect(code)).status, 429);
  }).pipe(Effect.provide(testEnvironment)),
);

it.live("stops an anonymous caller filling the table with enrollments", () =>
  Effect.gen(function* () {
    yield* buildAppUnderTest({});

    // Creating grants nothing, but it does write a row nothing ever deletes.
    let lastStatus = 0;
    for (let attempt = 0; attempt < 21; attempt += 1) {
      lastStatus = (yield* createEnrollment({})).status;
    }
    assert.equal(lastStatus, 429);
  }).pipe(Effect.provide(testEnvironment)),
);
