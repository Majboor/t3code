import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, beforeEach, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { HttpRouter, HttpServer } from "effect/unstable/http";

import { ServerAuthLive } from "../auth/Layers/ServerAuth.ts";
import { ServerSecretStoreLive } from "../auth/Layers/ServerSecretStore.ts";
import { SessionCredentialService } from "../auth/Services/SessionCredentialService.ts";
import { ServerConfig, type ServerConfigShape } from "../config.ts";
import {
  deviceEnrollmentApproveRouteLayer,
  deviceEnrollmentCollectRouteLayer,
  deviceEnrollmentCreateRouteLayer,
  resetDeviceEnrollmentRateLimits,
} from "../deviceEnrollment/http.ts";
import { AccountMachineRepositoryLive } from "../persistence/Layers/AccountMachines.ts";
import { DeviceEnrollmentRepositoryLive } from "../persistence/Layers/DeviceEnrollments.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { accountMachineRevokeRouteLayer, accountMachinesListRouteLayer } from "./http.ts";

/**
 * Connected machines, end to end, with nothing about authentication faked.
 *
 * The whole claim of this feature is that Disconnect ends a machine's access,
 * and that claim is only worth as much as the thing checking the credential. So
 * the real `ServerAuth` and the real `SessionCredentialService` are wired up
 * over a real HTTP server and a real (in-memory) database, and the machine's
 * token is carried the way a machine carries it: an `Authorization: Bearer`
 * header on an ordinary request.
 *
 * A mocked `ServerAuth` would have made these tests shorter and would have
 * proved nothing at all — the property under test *is* what happens inside
 * `verify` when `auth_sessions.revoked_at` is set, which is exactly the part a
 * mock replaces.
 */

/** Not a local-user subject and not a machine owner, so no tenant provisioning
 * gets dragged into a test about machines. `resolveAuthenticatedUserId` files
 * both the approver and the machine it approves under `auth:<subject>`, which
 * is the point: they are the same person. */
const PERSON_SUBJECT = "connected-machines-test-person";
const OTHER_PERSON_SUBJECT = "connected-machines-test-stranger";

const configLayer = Layer.effect(
  ServerConfig,
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    return { ...config } satisfies ServerConfigShape;
  }),
).pipe(Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-account-machines-" })));

const routes = Layer.mergeAll(
  deviceEnrollmentCreateRouteLayer,
  deviceEnrollmentApproveRouteLayer,
  deviceEnrollmentCollectRouteLayer,
  accountMachinesListRouteLayer,
  accountMachineRevokeRouteLayer,
);

/**
 * One set of services, shared by the routes and by the test.
 *
 * They have to be the same instances: the token a test mints is signed with the
 * secret the routes verify against, and the row `/collect` writes is the row
 * `/machines` reads. Two copies of this layer would pass every assertion here
 * and prove nothing about a running server.
 *
 * `ServerAuthLive` merges `SessionCredentialService` out with it, which is what
 * lets a test sign somebody in without going through a login route.
 */
const appServices = Layer.mergeAll(
  ServerAuthLive,
  DeviceEnrollmentRepositoryLive,
  AccountMachineRepositoryLive,
).pipe(
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(ServerSecretStoreLive),
  Layer.provideMerge(configLayer),
);

/** Serving is all this starts; the services come from the ambient context. */
const buildAppUnderTest = Layer.build(
  HttpRouter.serve(routes, { disableListenLog: true, disableLogger: true }),
);

function parseJsonBody(text: string): Record<string, unknown> {
  if (text.length === 0) {
    return {};
  }
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { raw: text };
  }
}

interface Reply {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

const call = (input: {
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly token?: string;
  readonly body?: unknown;
}) =>
  Effect.gen(function* () {
    const server = yield* HttpServer.HttpServer;
    const address = server.address as HttpServer.TcpAddress;
    const response = yield* Effect.promise(() =>
      fetch(`http://127.0.0.1:${address.port}${input.path}`, {
        method: input.method,
        headers: {
          ...(input.token === undefined ? {} : { authorization: `Bearer ${input.token}` }),
          ...(input.body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
      }),
    );
    const text = yield* Effect.promise(() => response.text());
    return { status: response.status, body: parseJsonBody(text) } satisfies Reply;
  });

/** A signed-in person, as a bearer token the tests can hand to a route. */
const signIn = (subject: string) =>
  Effect.gen(function* () {
    const sessions = yield* SessionCredentialService;
    const issued = yield* sessions.issue({
      subject,
      role: "owner",
      method: "bearer-session-token",
      client: { deviceType: "desktop", label: "Test browser" },
    });
    return issued.token;
  });

interface ConnectedMachine {
  readonly machineToken: string;
  readonly machineId: string;
}

/**
 * The whole enrollment flow, run for real, so that what the tests below revoke
 * is a credential this server genuinely minted and genuinely accepts.
 */
const connectMachine = (input: {
  readonly approverToken: string;
  readonly label?: string;
  readonly platform?: string;
}) =>
  Effect.gen(function* () {
    const created = yield* call({
      method: "POST",
      path: "/api/devices/enrollments",
      body: {
        ...(input.label === undefined ? {} : { deviceLabel: input.label }),
        ...(input.platform === undefined ? {} : { devicePlatform: input.platform }),
      },
    });
    assert.equal(created.status, 201);
    const code = created.body["code"] as string;

    const approved = yield* call({
      method: "POST",
      path: `/api/devices/enrollments/${code}/approve`,
      token: input.approverToken,
    });
    assert.equal(approved.status, 200);

    const collected = yield* call({
      method: "POST",
      path: `/api/devices/enrollments/${code}/collect`,
    });
    assert.equal(collected.status, 200);
    const machineToken = collected.body["sessionToken"] as string;
    assert.isString(machineToken);

    // The machine can see itself, which is also how the test learns its id.
    const listed = yield* call({
      method: "GET",
      path: "/api/devices/machines",
      token: machineToken,
    });
    assert.equal(listed.status, 200);
    const machines = listed.body["machines"] as ReadonlyArray<Record<string, unknown>>;
    const self = machines.find((machine) => machine["current"] === true);
    assert.isDefined(self, "the collecting machine should appear as the current device");
    return {
      machineToken,
      machineId: self!["machineId"] as string,
    } satisfies ConnectedMachine;
  });

const testEnvironment = Layer.mergeAll(
  NodeHttpServer.layerTest,
  appServices.pipe(Layer.provide(NodeServices.layer)),
  NodeServices.layer,
);

beforeEach(() => {
  resetDeviceEnrollmentRateLimits();
});

it.live("puts a machine on its owner's list the moment it collects a credential", () =>
  Effect.gen(function* () {
    yield* buildAppUnderTest;
    const approverToken = yield* signIn(PERSON_SUBJECT);

    yield* connectMachine({
      approverToken,
      label: "Ana's MacBook",
      platform: "macos",
    });

    const listed = yield* call({
      method: "GET",
      path: "/api/devices/machines",
      token: approverToken,
    });
    assert.equal(listed.status, 200);
    const machines = listed.body["machines"] as ReadonlyArray<Record<string, unknown>>;
    assert.equal(machines.length, 1);
    const machine = machines[0]!;
    // What the enrollment captured, carried across so the list names something
    // a person recognises.
    assert.equal(machine["label"], "Ana's MacBook");
    assert.equal(machine["platform"], "macos");
    assert.isString(machine["firstSeenAt"]);
    assert.isString(machine["lastSeenAt"]);
    // The browser asking is not the machine that enrolled, and the list has to
    // say so or a person cannot tell which row is safe to disconnect.
    assert.equal(machine["current"], false);
    // The credential's id is the account's business, not the browser's.
    assert.isUndefined(machine["authSessionId"]);
  }).pipe(Effect.provide(testEnvironment)),
);

/**
 * The test this feature exists for.
 *
 * Not "the row disappeared" — the row disappearing is the easy half and the
 * worthless half. The assertion that matters is the last one: the same token,
 * on the same route, is refused afterwards. If this ever goes green while the
 * machine keeps working, the whole surface is decoration.
 */
it.live("revokes the credential itself, so the disconnected machine is refused next request", () =>
  Effect.gen(function* () {
    yield* buildAppUnderTest;
    const approverToken = yield* signIn(PERSON_SUBJECT);

    const machine = yield* connectMachine({
      approverToken,
      label: "The laptop on the train",
      platform: "macos",
    });

    // Before: the machine's token is a working credential on a route that
    // requires one.
    const beforeRevoke = yield* call({
      method: "GET",
      path: "/api/devices/machines",
      token: machine.machineToken,
    });
    assert.equal(beforeRevoke.status, 200);

    const revoked = yield* call({
      method: "POST",
      path: `/api/devices/machines/${machine.machineId}/revoke`,
      token: approverToken,
    });
    assert.equal(revoked.status, 200);
    assert.equal(revoked.body["revoked"], true);

    // After: the same token, unchanged, on the same route. This is the claim.
    const afterRevoke = yield* call({
      method: "GET",
      path: "/api/devices/machines",
      token: machine.machineToken,
    });
    assert.equal(afterRevoke.status, 401);

    // And it stays refused — a revocation that only held for one request would
    // be a race, not a revocation.
    const stillRefused = yield* call({
      method: "GET",
      path: "/api/devices/machines",
      token: machine.machineToken,
    });
    assert.equal(stillRefused.status, 401);

    // The owner's list no longer offers a button that would do nothing.
    const listed = yield* call({
      method: "GET",
      path: "/api/devices/machines",
      token: approverToken,
    });
    assert.equal(listed.status, 200);
    assert.deepEqual(listed.body["machines"], []);
  }).pipe(Effect.provide(testEnvironment)),
);

it.live("refuses to disconnect the device making the request", () =>
  Effect.gen(function* () {
    yield* buildAppUnderTest;
    const approverToken = yield* signIn(PERSON_SUBJECT);
    const machine = yield* connectMachine({ approverToken, label: "This very machine" });

    const refused = yield* call({
      method: "POST",
      path: `/api/devices/machines/${machine.machineId}/revoke`,
      token: machine.machineToken,
    });
    assert.equal(refused.status, 403);
    assert.equal(refused.body["reason"], "current-device");

    // Refused means untouched: the machine is still working afterwards.
    const stillWorks = yield* call({
      method: "GET",
      path: "/api/devices/machines",
      token: machine.machineToken,
    });
    assert.equal(stillWorks.status, 200);
  }).pipe(Effect.provide(testEnvironment)),
);

it.live("keeps one account's machines out of another's list and out of its reach", () =>
  Effect.gen(function* () {
    yield* buildAppUnderTest;
    const approverToken = yield* signIn(PERSON_SUBJECT);
    const strangerToken = yield* signIn(OTHER_PERSON_SUBJECT);

    const machine = yield* connectMachine({ approverToken, label: "Ana's MacBook" });

    const strangersView = yield* call({
      method: "GET",
      path: "/api/devices/machines",
      token: strangerToken,
    });
    assert.equal(strangersView.status, 200);
    assert.deepEqual(strangersView.body["machines"], []);

    // 404 rather than 403: telling a stranger that an id is real is telling
    // them something about somebody else's hardware.
    const strangersRevoke = yield* call({
      method: "POST",
      path: `/api/devices/machines/${machine.machineId}/revoke`,
      token: strangerToken,
    });
    assert.equal(strangersRevoke.status, 404);

    // And the machine is untouched by the attempt.
    const stillWorks = yield* call({
      method: "GET",
      path: "/api/devices/machines",
      token: machine.machineToken,
    });
    assert.equal(stillWorks.status, 200);
  }).pipe(Effect.provide(testEnvironment)),
);

it.live("asks for a session before saying anything about an account's machines", () =>
  Effect.gen(function* () {
    yield* buildAppUnderTest;

    const listed = yield* call({ method: "GET", path: "/api/devices/machines" });
    assert.equal(listed.status, 401);
    assert.isUndefined(listed.body["machines"]);

    const revoked = yield* call({
      method: "POST",
      path: "/api/devices/machines/whatever/revoke",
    });
    assert.equal(revoked.status, 401);
  }).pipe(Effect.provide(testEnvironment)),
);

it.live("gives a machine that reconnects its old row back, and never a live one", () =>
  Effect.gen(function* () {
    yield* buildAppUnderTest;
    const approverToken = yield* signIn(PERSON_SUBJECT);

    const first = yield* connectMachine({
      approverToken,
      label: "Ana's MacBook",
      platform: "macos",
    });
    yield* call({
      method: "POST",
      path: `/api/devices/machines/${first.machineId}/revoke`,
      token: approverToken,
    });

    // Same name, same platform, after a disconnect: this is the machine coming
    // back, so it reclaims its own row rather than leaving a stale one behind.
    const second = yield* connectMachine({
      approverToken,
      label: "Ana's MacBook",
      platform: "macos",
    });
    assert.equal(second.machineId, first.machineId);

    // Same name again, but the previous one is *live* — so this is a second
    // machine that happens to share a name, and it must get its own row. Folding
    // them together would leave the older credential working and unlistable,
    // which is the failure this whole table exists to prevent.
    const third = yield* connectMachine({
      approverToken,
      label: "Ana's MacBook",
      platform: "macos",
    });
    assert.notEqual(third.machineId, second.machineId);

    const listed = yield* call({
      method: "GET",
      path: "/api/devices/machines",
      token: approverToken,
    });
    const machines = listed.body["machines"] as ReadonlyArray<Record<string, unknown>>;
    assert.equal(machines.length, 2);
  }).pipe(Effect.provide(testEnvironment)),
);
