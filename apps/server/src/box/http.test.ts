import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, beforeEach, it } from "@effect/vitest";
import { DateTime, Effect, Layer } from "effect";
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
import { BoxCommandJournalRepositoryLive } from "../persistence/Layers/BoxCommandJournal.ts";
import { DeviceEnrollmentRepositoryLive } from "../persistence/Layers/DeviceEnrollments.ts";
import { EnvironmentRelayBindingRepositoryLive } from "../persistence/Layers/EnvironmentRelayBindings.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { AccountMachineRepository } from "../persistence/Services/AccountMachines.ts";
import { EnvironmentRelayBindingRepository } from "../persistence/Services/EnvironmentRelayBindings.ts";
import { boxCommandsRouteLayer } from "./http.ts";
import { boxCommandsPath } from "./hubProtocol.ts";
import { BoxCommandsLive } from "./Layers/BoxCommands.ts";
import { BoxSessionRelayLive } from "./Layers/BoxSessionRelay.ts";

/**
 * Who may ask a hub to drive a box, and what the hub is allowed to answer.
 *
 * Nothing here connects a box, and that is the point. Every rule about what a
 * box will *do* is covered against a machine that does not exist
 * (`decideBoxCommand.test.ts`) and against a machine that does
 * (`scripts/box-relay-e2e.mjs`, with real processes and a real `lsof`). What is
 * left over is the route's own question — is there a session, and is this box
 * this session's — and that question is answered here with the real `ServerAuth`
 * over a real HTTP server, because a mocked one replaces the very thing under
 * test.
 *
 * With no relay connection registered in this process, a box that genuinely
 * belongs to the caller comes back as an ordinary refusal rather than an error.
 * That is the shape being asserted: the hub is transport, so what a caller gets
 * is what the rules said, in the words the rules chose.
 */

const OWNER_SUBJECT = "box-route-test-owner";
const STRANGER_SUBJECT = "box-route-test-stranger";
const ENVIRONMENT_ID = "box-route-test-environment";

const configLayer = Layer.effect(
  ServerConfig,
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    return { ...config } satisfies ServerConfigShape;
  }),
).pipe(Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-box-route-" })));

const routes = Layer.mergeAll(
  deviceEnrollmentCreateRouteLayer,
  deviceEnrollmentApproveRouteLayer,
  deviceEnrollmentCollectRouteLayer,
  boxCommandsRouteLayer,
);

const appServices = Layer.mergeAll(
  ServerAuthLive,
  DeviceEnrollmentRepositoryLive,
  AccountMachineRepositoryLive,
  EnvironmentRelayBindingRepositoryLive,
).pipe(
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(ServerSecretStoreLive),
  Layer.provideMerge(configLayer),
);

/**
 * The real verb set, over the real relay session, with no relay connected.
 *
 * `BoxSessionRelay` reads revocation through the binding and reachability from
 * the in-memory connection registry, which is empty in this process — so the
 * facts it reports are true rather than stubbed, and the refusals below are the
 * ones a person would actually see.
 */
const boxCommandsLayer = BoxCommandsLive.pipe(
  Layer.provide(BoxSessionRelayLive),
  Layer.provide(BoxCommandJournalRepositoryLive),
);

const buildAppUnderTest = Layer.build(
  HttpRouter.serve(routes, { disableListenLog: true, disableLogger: true }).pipe(
    Layer.provide(boxCommandsLayer),
  ),
);

function parseJsonBody(text: string): Record<string, unknown> {
  if (text.length === 0) return {};
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
  /** Sent verbatim, for the one test about a body that is not a command. */
  readonly rawBody?: string;
}) =>
  Effect.gen(function* () {
    const server = yield* HttpServer.HttpServer;
    const address = server.address as HttpServer.TcpAddress;
    const payload =
      input.rawBody ?? (input.body === undefined ? undefined : JSON.stringify(input.body));
    const response = yield* Effect.promise(() =>
      fetch(`http://127.0.0.1:${address.port}${input.path}`, {
        method: input.method,
        headers: {
          ...(input.token === undefined ? {} : { authorization: `Bearer ${input.token}` }),
          ...(payload === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(payload === undefined ? {} : { body: payload }),
      }),
    );
    const text = yield* Effect.promise(() => response.text());
    return { status: response.status, body: parseJsonBody(text) } satisfies Reply;
  });

const signIn = (subject: string) =>
  Effect.gen(function* () {
    const sessions = yield* SessionCredentialService;
    const issued = yield* sessions.issue({
      subject,
      role: "owner",
      method: "bearer-session-token",
      client: { deviceType: "desktop", label: "Test shell" },
    });
    return issued.token;
  });

/** A real machine on a real account, and an environment name bound to it. */
const connectBox = (input: { readonly approverToken: string; readonly environmentId: string }) =>
  Effect.gen(function* () {
    const created = yield* call({
      method: "POST",
      path: "/api/devices/enrollments",
      body: { deviceLabel: "box-route-test", devicePlatform: "linux" },
    });
    assert.equal(created.status, 201);
    const code = created.body["code"] as string;

    const approved = yield* call({
      method: "POST",
      path: `/api/devices/enrollments/${code}/approve`,
      token: input.approverToken,
      body: { machineRole: "runner" },
    });
    assert.equal(approved.status, 200);

    const collected = yield* call({
      method: "POST",
      path: `/api/devices/enrollments/${code}/collect`,
    });
    assert.equal(collected.status, 200);

    const machines = yield* AccountMachineRepository;
    const bindings = yield* EnvironmentRelayBindingRepository;
    const owned = yield* machines.listActiveForUser({ userId: `auth:${OWNER_SUBJECT}` });
    const machine = owned[0];
    assert.isDefined(machine, "the enrolled machine should be on its owner's list");

    const now = yield* DateTime.now;
    yield* bindings.bind({
      environmentId: input.environmentId,
      userId: `auth:${OWNER_SUBJECT}`,
      machineId: machine!.machineId,
      label: "box-route-test",
      nowIso: DateTime.formatIso(DateTime.toUtc(now)),
    });
    return machine!.machineId;
  });

const testEnvironment = Layer.mergeAll(
  NodeHttpServer.layerTest,
  appServices.pipe(Layer.provide(NodeServices.layer)),
  NodeServices.layer,
);

beforeEach(() => {
  resetDeviceEnrollmentRateLimits();
});

it.live("refuses a request with no session at all", () =>
  Effect.gen(function* () {
    yield* buildAppUnderTest;
    const reply = yield* call({
      method: "POST",
      path: boxCommandsPath(ENVIRONMENT_ID),
      body: { verb: "services" },
    });
    assert.equal(reply.status, 401);
  }).pipe(Effect.provide(testEnvironment)),
);

it.live("answers 404 for a box that is not this account's, and for one that never existed", () =>
  Effect.gen(function* () {
    yield* buildAppUnderTest;
    const ownerToken = yield* signIn(OWNER_SUBJECT);
    yield* connectBox({ approverToken: ownerToken, environmentId: ENVIRONMENT_ID });

    const strangerToken = yield* signIn(STRANGER_SUBJECT);
    const somebodyElses = yield* call({
      method: "POST",
      path: boxCommandsPath(ENVIRONMENT_ID),
      token: strangerToken,
      body: { verb: "services" },
    });
    const invented = yield* call({
      method: "POST",
      path: boxCommandsPath("a-name-nobody-claimed"),
      token: strangerToken,
      body: { verb: "services" },
    });

    assert.equal(somebodyElses.status, 404);
    assert.equal(invented.status, 404);
    // Byte for byte, because anything that distinguished them would answer
    // "that name is taken" to somebody who is not entitled to ask.
    assert.deepEqual(somebodyElses.body, invented.body);
  }).pipe(Effect.provide(testEnvironment)),
);

it.live("hands the owner the rules' own answer rather than one of its own", () =>
  Effect.gen(function* () {
    yield* buildAppUnderTest;
    const ownerToken = yield* signIn(OWNER_SUBJECT);
    yield* connectBox({ approverToken: ownerToken, environmentId: ENVIRONMENT_ID });

    const reply = yield* call({
      method: "POST",
      path: boxCommandsPath(ENVIRONMENT_ID),
      token: ownerToken,
      body: { verb: "run", command: "echo hello", detach: false },
    });

    // 200, because a refusal is an ordinary answer and not a fault. Nothing is
    // connected in this process, so the rules say so in words.
    assert.equal(reply.status, 200);
    assert.equal(reply.body["outcome"], "refused");
    assert.equal((reply.body["refusal"] as Record<string, unknown>)["reason"], "box-unreachable");
  }).pipe(Effect.provide(testEnvironment)),
);

it.live("keeps answering history when the box cannot be reached", () =>
  Effect.gen(function* () {
    yield* buildAppUnderTest;
    const ownerToken = yield* signIn(OWNER_SUBJECT);
    yield* connectBox({ approverToken: ownerToken, environmentId: ENVIRONMENT_ID });

    const reply = yield* call({
      method: "POST",
      path: boxCommandsPath(ENVIRONMENT_ID),
      token: ownerToken,
      body: { verb: "history", limit: 20 },
    });

    assert.equal(reply.status, 200);
    assert.equal(reply.body["outcome"], "history");
  }).pipe(Effect.provide(testEnvironment)),
);

it.live("refuses everything once the machine is disconnected", () =>
  Effect.gen(function* () {
    yield* buildAppUnderTest;
    const ownerToken = yield* signIn(OWNER_SUBJECT);
    const machineId = yield* connectBox({
      approverToken: ownerToken,
      environmentId: ENVIRONMENT_ID,
    });

    const machines = yield* AccountMachineRepository;
    const now = yield* DateTime.now;
    yield* machines.markRevoked({
      machineId,
      userId: `auth:${OWNER_SUBJECT}`,
      revokedAt: DateTime.formatIso(DateTime.toUtc(now)),
    });

    const reply = yield* call({
      method: "POST",
      path: boxCommandsPath(ENVIRONMENT_ID),
      token: ownerToken,
      body: { verb: "history", limit: 20 },
    });

    // Not a 404: it is still this account's machine, and the person is entitled
    // to be told what became of it rather than that it never existed.
    assert.equal(reply.status, 200);
    assert.equal(reply.body["outcome"], "refused");
    assert.equal((reply.body["refusal"] as Record<string, unknown>)["reason"], "machine-revoked");
  }).pipe(Effect.provide(testEnvironment)),
);

it.live("will not dispatch a body it cannot read as a command", () =>
  Effect.gen(function* () {
    yield* buildAppUnderTest;
    const ownerToken = yield* signIn(OWNER_SUBJECT);
    yield* connectBox({ approverToken: ownerToken, environmentId: ENVIRONMENT_ID });

    const unknownVerb = yield* call({
      method: "POST",
      path: boxCommandsPath(ENVIRONMENT_ID),
      token: ownerToken,
      body: { verb: "rm-rf" },
    });
    const notJson = yield* call({
      method: "POST",
      path: boxCommandsPath(ENVIRONMENT_ID),
      token: ownerToken,
      rawBody: "{",
    });

    assert.equal(unknownVerb.status, 400);
    assert.equal(notJson.status, 400);
  }).pipe(Effect.provide(testEnvironment)),
);
