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
import { EnvironmentRelayBindingRepositoryLive } from "../persistence/Layers/EnvironmentRelayBindings.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import {
  environmentRelayAttachRouteLayer,
  environmentRelayDialRouteLayer,
  environmentRelayLinksRouteLayer,
  RELAY_ATTACH_REAUTH_INTERVAL_MS,
  setRelayAttachReauthIntervalMsForTests,
} from "./http.ts";
import { decodeFrame, encodeFrame, RELAY_PROTOCOL_VERSION, type RelayFrame } from "./protocol.ts";
import { dropRelayConnectionsForMachine, resetRelayRegistryForTests } from "./registry.ts";

/**
 * An environment dialling out, over a real socket, against a real hub.
 *
 * Everything about identity here is genuine: the machine enrols through the
 * real device-enrollment flow, takes a real session credential, mints a real
 * websocket token with it, and the hub authenticates the upgrade with the same
 * `ServerAuth` a browser meets. That matters more than usual for this feature —
 * the whole security argument is "an environment authenticates as a machine
 * belonging to a user, using the credential that already exists", and a mocked
 * auth layer would replace precisely the part being claimed.
 *
 * The frames are real too. Nothing below reaches into the registry to make a
 * link look healthy; a link becomes healthy here only because a socket answered
 * a ping, which is the property the whole `connected` rule rests on.
 */

const PERSON_SUBJECT = "environment-relay-test-person";
const OTHER_PERSON_SUBJECT = "environment-relay-test-stranger";

const configLayer = Layer.effect(
  ServerConfig,
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    return { ...config } satisfies ServerConfigShape;
  }),
).pipe(Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-environment-relay-" })));

const routes = Layer.mergeAll(
  deviceEnrollmentCreateRouteLayer,
  deviceEnrollmentApproveRouteLayer,
  deviceEnrollmentCollectRouteLayer,
  environmentRelayDialRouteLayer,
  environmentRelayLinksRouteLayer,
  environmentRelayAttachRouteLayer,
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

const serverPort = Effect.gen(function* () {
  const server = yield* HttpServer.HttpServer;
  return (server.address as HttpServer.TcpAddress).port;
});

const call = (input: {
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly token?: string;
  readonly body?: unknown;
}) =>
  Effect.gen(function* () {
    const port = yield* serverPort;
    const response = yield* Effect.promise(() =>
      fetch(`http://127.0.0.1:${port}${input.path}`, {
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

/**
 * The enrollment flow, run for real, so the credential the environment dials
 * with is one this server genuinely minted.
 */
const connectMachine = (input: { readonly approverToken: string; readonly label?: string }) =>
  Effect.gen(function* () {
    const created = yield* call({
      method: "POST",
      path: "/api/devices/enrollments",
      body: input.label === undefined ? {} : { deviceLabel: input.label },
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
    return collected.body["sessionToken"] as string;
  });

/**
 * A websocket token, minted the way an environment mints one: over HTTP, with
 * its own bearer credential. A browser cannot set headers on a websocket and
 * neither can Node's, so the token travels in the query string — the same
 * arrangement `/ws` has always used.
 */
const webSocketTokenFor = (sessionToken: string) =>
  Effect.gen(function* () {
    const sessions = yield* SessionCredentialService;
    const verified = yield* sessions.verify(sessionToken);
    const issued = yield* sessions.issueWebSocketToken(verified.sessionId, {
      sessionSnapshot: {
        subject: verified.subject,
        method: verified.method,
        role: verified.role,
        client: verified.client,
      },
    });
    return issued.token;
  });

/** A socket the test can drive turn by turn. */
interface TestSocket {
  readonly socket: WebSocket;
  readonly frames: Array<RelayFrame>;
  readonly raw: Array<string>;
  readonly send: (frame: RelayFrame) => void;
  readonly sendRaw: (text: string) => void;
  readonly close: () => void;
  readonly closedWith: () => number | null;
}

function openSocket(url: string, options?: { readonly decode?: boolean }): Promise<TestSocket> {
  const decode = options?.decode ?? true;
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const frames: Array<RelayFrame> = [];
    const raw: Array<string> = [];
    let closeCode: number | null = null;

    socket.addEventListener("message", (event) => {
      const text = typeof event.data === "string" ? event.data : String(event.data);
      raw.push(text);
      if (decode) {
        const frame = decodeFrame(text);
        if (frame !== null) {
          frames.push(frame);
        }
      }
    });
    socket.addEventListener("close", (event) => {
      closeCode = event.code;
    });
    socket.addEventListener("error", () => {
      reject(new Error(`socket failed: ${url}`));
    });
    socket.addEventListener("open", () => {
      resolve({
        socket,
        frames,
        raw,
        send: (frame) => socket.send(encodeFrame(frame)),
        sendRaw: (text) => socket.send(text),
        close: () => socket.close(),
        closedWith: () => closeCode,
      });
    });
  });
}

/** Polls rather than sleeps, so a slow machine does not make this flaky. */
async function waitFor<T>(read: () => T | undefined | null, what: string): Promise<T> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const value = read();
    if (value !== undefined && value !== null) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** The same, for something that has to be awaited on each attempt. */
async function waitForAsync<T>(
  attempt: () => Promise<T | undefined | null>,
  what: string,
): Promise<T> {
  for (let tries = 0; tries < 100; tries += 1) {
    const value = await attempt();
    if (value !== undefined && value !== null) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${what}`);
}

function findFrame<T extends RelayFrame["type"]>(
  frames: ReadonlyArray<RelayFrame>,
  type: T,
): Extract<RelayFrame, { type: T }> | undefined {
  return frames.find((frame) => frame.type === type) as
    | Extract<RelayFrame, { type: T }>
    | undefined;
}

/**
 * Dials in and answers the first ping, which is what actually makes a link
 * healthy. Answering is left to the caller when a test is about *not*
 * answering.
 */
const dialEnvironment = (input: {
  readonly port: number;
  readonly wsToken: string;
  readonly environmentId: string;
  readonly label?: string | null;
  readonly answerPings?: boolean;
}) =>
  Effect.promise(async () => {
    const dialled = await openSocket(
      `ws://127.0.0.1:${input.port}/api/environments/relay?wsToken=${encodeURIComponent(input.wsToken)}`,
    );

    if (input.answerPings ?? true) {
      dialled.socket.addEventListener("message", (event) => {
        const frame = decodeFrame(typeof event.data === "string" ? event.data : String(event.data));
        if (frame?.type === "ping") {
          dialled.send({ type: "pong", nonce: frame.nonce, state: "ready", detail: null });
        }
      });
    }

    dialled.send({
      type: "hello",
      protocolVersion: RELAY_PROTOCOL_VERSION,
      environmentId: input.environmentId,
      label: input.label ?? "Test laptop",
    });
    return dialled;
  });

const testEnvironment = Layer.mergeAll(
  NodeHttpServer.layerTest,
  appServices.pipe(Layer.provide(NodeServices.layer)),
  NodeServices.layer,
);

beforeEach(() => {
  resetDeviceEnrollmentRateLimits();
  resetRelayRegistryForTests();
  setRelayAttachReauthIntervalMsForTests(RELAY_ATTACH_REAUTH_INTERVAL_MS);
});

it.live("lets an enrolled machine hold an environment open with no public URL of its own", () =>
  Effect.gen(function* () {
    yield* buildAppUnderTest;
    const port = yield* serverPort;
    const approverToken = yield* signIn(PERSON_SUBJECT);
    const machineToken = yield* connectMachine({ approverToken, label: "Ada's laptop" });
    const wsToken = yield* webSocketTokenFor(machineToken);

    const dialled = yield* dialEnvironment({ port, wsToken, environmentId: "env-alpha" });

    const welcome = yield* Effect.promise(() =>
      waitFor(() => findFrame(dialled.frames, "welcome"), "a welcome frame"),
    );
    assert.equal(welcome.environmentId, "env-alpha");
    assert.isAbove(welcome.heartbeatIntervalMs, 0);

    dialled.close();
  }).pipe(Effect.provide(testEnvironment)),
);

it.live("refuses a browser session that is not a machine on the account", () =>
  Effect.gen(function* () {
    yield* buildAppUnderTest;
    const port = yield* serverPort;
    // A signed-in person, but not an enrolled machine. Nothing about being
    // logged in should let a browser tab hold an environment name open.
    const approverToken = yield* signIn(PERSON_SUBJECT);
    const wsToken = yield* webSocketTokenFor(approverToken);

    const response = yield* Effect.promise(() =>
      fetch(
        `http://127.0.0.1:${port}/api/environments/relay?wsToken=${encodeURIComponent(wsToken)}`,
      ),
    );
    assert.equal(response.status, 403);
    const body = parseJsonBody(yield* Effect.promise(() => response.text()));
    assert.equal(body["reason"], "not-a-machine");
  }).pipe(Effect.provide(testEnvironment)),
);

it.live("refuses an unauthenticated dial", () =>
  Effect.gen(function* () {
    yield* buildAppUnderTest;
    const port = yield* serverPort;
    const response = yield* Effect.promise(() =>
      fetch(`http://127.0.0.1:${port}/api/environments/relay`),
    );
    assert.equal(response.status, 401);
  }).pipe(Effect.provide(testEnvironment)),
);

it.live("will not let one account claim an environment name another account holds", () =>
  Effect.gen(function* () {
    yield* buildAppUnderTest;
    const port = yield* serverPort;

    const owner = yield* signIn(PERSON_SUBJECT);
    const ownerMachine = yield* connectMachine({ approverToken: owner, label: "Ada's laptop" });
    const ownerWsToken = yield* webSocketTokenFor(ownerMachine);
    const ownersLink = yield* dialEnvironment({
      port,
      wsToken: ownerWsToken,
      environmentId: "env-contested",
    });
    yield* Effect.promise(() =>
      waitFor(() => findFrame(ownersLink.frames, "welcome"), "the owner's welcome"),
    );

    const stranger = yield* signIn(OTHER_PERSON_SUBJECT);
    const strangerMachine = yield* connectMachine({
      approverToken: stranger,
      label: "Someone else's laptop",
    });
    const strangerWsToken = yield* webSocketTokenFor(strangerMachine);
    const strangersLink = yield* dialEnvironment({
      port,
      wsToken: strangerWsToken,
      environmentId: "env-contested",
    });

    // Told why, rather than dropped: a dropped socket is indistinguishable from
    // a network failure and would be retried forever.
    const bye = yield* Effect.promise(() =>
      waitFor(() => findFrame(strangersLink.frames, "bye"), "a refusal"),
    );
    assert.equal(bye.reason, "rejected");
    assert.isUndefined(findFrame(strangersLink.frames, "welcome"));

    // And the rightful owner is untouched.
    assert.isUndefined(findFrame(ownersLink.frames, "bye"));

    ownersLink.close();
    strangersLink.close();
  }).pipe(Effect.provide(testEnvironment)),
);

it.live("reports connected only once a health exchange has actually happened", () =>
  Effect.gen(function* () {
    yield* buildAppUnderTest;
    const port = yield* serverPort;
    const approverToken = yield* signIn(PERSON_SUBJECT);
    const machineToken = yield* connectMachine({ approverToken, label: "Ada's laptop" });
    const wsToken = yield* webSocketTokenFor(machineToken);

    // A socket that dials, names itself, and then answers nothing. This is the
    // shape of a wedged environment, and the shape a socket-liveness check calls
    // healthy.
    const silent = yield* dialEnvironment({
      port,
      wsToken,
      environmentId: "env-silent",
      answerPings: false,
    });
    yield* Effect.promise(() => waitFor(() => findFrame(silent.frames, "welcome"), "a welcome"));

    const listed = yield* call({
      method: "GET",
      path: "/api/environments/relay/links",
      token: approverToken,
    });
    assert.equal(listed.status, 200);
    const environments = listed.body["environments"] as ReadonlyArray<Record<string, unknown>>;
    const entry = environments.find((row) => row["environmentId"] === "env-silent");
    assert.isDefined(entry);
    assert.notEqual(entry!["state"], "connected");
    assert.equal(entry!["healthAgeMs"], null);

    silent.close();
  }).pipe(Effect.provide(testEnvironment)),
);

it.live("carries a browser's frames to the environment and back", () =>
  Effect.gen(function* () {
    yield* buildAppUnderTest;
    const port = yield* serverPort;
    const approverToken = yield* signIn(PERSON_SUBJECT);
    const machineToken = yield* connectMachine({ approverToken, label: "Ada's laptop" });
    const wsToken = yield* webSocketTokenFor(machineToken);

    // The environment echoes whatever arrives on a channel, upper-cased, so the
    // test can tell a relayed reply from anything else.
    const dialled = yield* dialEnvironment({ port, wsToken, environmentId: "env-relayed" });
    dialled.socket.addEventListener("message", (event) => {
      const frame = decodeFrame(typeof event.data === "string" ? event.data : String(event.data));
      if (frame?.type === "data") {
        dialled.send({
          type: "data",
          channelId: frame.channelId,
          payload: frame.payload.toUpperCase(),
        });
      }
    });
    yield* Effect.promise(() => waitFor(() => findFrame(dialled.frames, "welcome"), "a welcome"));

    // The link only accepts traffic once a ping has come back, so this retries
    // until the first health exchange has genuinely completed. It is the gate
    // under test as much as the routing is.
    const browserWsToken = yield* webSocketTokenFor(approverToken);
    const attached = yield* Effect.promise(() =>
      waitForAsync(
        () =>
          openSocket(
            `ws://127.0.0.1:${port}/api/environments/relay/attach/env-relayed?wsToken=${encodeURIComponent(browserWsToken)}`,
            { decode: false },
          ).catch(() => null),
        "a browser attachment",
      ),
    );

    attached.sendRaw('{"_tag":"Request"}');
    const echoed = yield* Effect.promise(() => waitFor(() => attached.raw[0], "a relayed reply"));
    assert.equal(echoed, '{"_TAG":"REQUEST"}');

    // And the environment saw an `open` for it, which is how it knew to serve.
    assert.isDefined(findFrame(dialled.frames, "open"));

    attached.close();
    dialled.close();
  }).pipe(Effect.provide(testEnvironment)),
);

it.live("refuses to attach a browser to somebody else's environment", () =>
  Effect.gen(function* () {
    yield* buildAppUnderTest;
    const port = yield* serverPort;
    const owner = yield* signIn(PERSON_SUBJECT);
    const ownerMachine = yield* connectMachine({ approverToken: owner, label: "Ada's laptop" });
    const dialled = yield* dialEnvironment({
      port,
      wsToken: yield* webSocketTokenFor(ownerMachine),
      environmentId: "env-private",
    });
    yield* Effect.promise(() => waitFor(() => findFrame(dialled.frames, "welcome"), "a welcome"));

    const stranger = yield* signIn(OTHER_PERSON_SUBJECT);
    const strangerWsToken = yield* webSocketTokenFor(stranger);
    const response = yield* Effect.promise(() =>
      fetch(
        `http://127.0.0.1:${port}/api/environments/relay/attach/env-private?wsToken=${encodeURIComponent(strangerWsToken)}`,
      ),
    );
    // The same answer a name that does not exist would get.
    assert.equal(response.status, 404);

    dialled.close();
  }).pipe(Effect.provide(testEnvironment)),
);

it.live("keeps an environment's name across a reconnect instead of minting a new one", () =>
  Effect.gen(function* () {
    yield* buildAppUnderTest;
    const port = yield* serverPort;
    const approverToken = yield* signIn(PERSON_SUBJECT);
    const machineToken = yield* connectMachine({ approverToken, label: "Ada's laptop" });
    const wsToken = yield* webSocketTokenFor(machineToken);

    const first = yield* dialEnvironment({ port, wsToken, environmentId: "env-stable" });
    yield* Effect.promise(() => waitFor(() => findFrame(first.frames, "welcome"), "a welcome"));
    first.close();

    const second = yield* dialEnvironment({ port, wsToken, environmentId: "env-stable" });
    const welcome = yield* Effect.promise(() =>
      waitFor(() => findFrame(second.frames, "welcome"), "a second welcome"),
    );
    assert.equal(welcome.environmentId, "env-stable");

    const listed = yield* call({
      method: "GET",
      path: "/api/environments/relay/links",
      token: approverToken,
    });
    const environments = listed.body["environments"] as ReadonlyArray<Record<string, unknown>>;
    // One environment, not two. A reconnecting machine that appeared as a
    // stranger would leave every saved thread pointing at nothing.
    assert.equal(environments.filter((row) => row["environmentId"] === "env-stable").length, 1);

    second.close();
  }).pipe(Effect.provide(testEnvironment)),
);

it.live("says a binding is offline rather than omitting it when nothing is dialled in", () =>
  Effect.gen(function* () {
    yield* buildAppUnderTest;
    const port = yield* serverPort;
    const approverToken = yield* signIn(PERSON_SUBJECT);
    const machineToken = yield* connectMachine({ approverToken, label: "Ada's laptop" });
    const wsToken = yield* webSocketTokenFor(machineToken);

    const dialled = yield* dialEnvironment({ port, wsToken, environmentId: "env-sleepy" });
    yield* Effect.promise(() => waitFor(() => findFrame(dialled.frames, "welcome"), "a welcome"));
    dialled.close();
    // Give the hub's read loop a moment to notice the close.
    yield* Effect.sleep(200);

    const listed = yield* call({
      method: "GET",
      path: "/api/environments/relay/links",
      token: approverToken,
    });
    const environments = listed.body["environments"] as ReadonlyArray<Record<string, unknown>>;
    const entry = environments.find((row) => row["environmentId"] === "env-sleepy");
    // "Your laptop is asleep" and "you have never connected this" are different
    // sentences, and only the list can tell them apart.
    assert.isDefined(entry);
    assert.equal(entry!["state"], "offline");
  }).pipe(Effect.provide(testEnvironment)),
);

it.live("drops the outbound connection when the machine holding it is revoked", () =>
  Effect.gen(function* () {
    yield* buildAppUnderTest;
    const port = yield* serverPort;
    const approverToken = yield* signIn(PERSON_SUBJECT);
    const machineToken = yield* connectMachine({ approverToken, label: "Ada's laptop" });
    const wsToken = yield* webSocketTokenFor(machineToken);

    const dialled = yield* dialEnvironment({ port, wsToken, environmentId: "env-revoked" });
    yield* Effect.promise(() => waitFor(() => findFrame(dialled.frames, "welcome"), "a welcome"));

    const listed = yield* call({
      method: "GET",
      path: "/api/environments/relay/links",
      token: approverToken,
    });
    const environments = listed.body["environments"] as ReadonlyArray<Record<string, unknown>>;
    const machineId = environments.find((row) => row["environmentId"] === "env-revoked")?.[
      "machineId"
    ] as string;
    assert.isString(machineId);

    // Authentication happened once, at dial time. Nothing on this socket will
    // ever check the credential again, so revocation has to reach in.
    const dropped = dropRelayConnectionsForMachine(machineId, "This machine was disconnected.");
    assert.deepEqual([...dropped], ["env-revoked"]);

    const bye = yield* Effect.promise(() =>
      waitFor(() => findFrame(dialled.frames, "bye"), "a revocation notice"),
    );
    assert.equal(bye.reason, "revoked");

    dialled.close();
  }).pipe(Effect.provide(testEnvironment)),
);

// The attach socket authenticated once, at the upgrade, and then relayed
// whatever the browser sent into the machine for as long as it stayed open.
// Signing that browser session out took the next connection away and left this
// one carrying traffic: a revoked tab kept reaching a laptop it no longer had
// any credential for.
it.live("stops relaying into the machine when the browser's session is revoked", () =>
  Effect.gen(function* () {
    // Short enough for a test to watch; the shipped interval is a heartbeat.
    setRelayAttachReauthIntervalMsForTests(50);
    yield* buildAppUnderTest;
    const port = yield* serverPort;
    const approverToken = yield* signIn(PERSON_SUBJECT);
    const machineToken = yield* connectMachine({ approverToken, label: "Ada's laptop" });

    const dialled = yield* dialEnvironment({
      port,
      wsToken: yield* webSocketTokenFor(machineToken),
      environmentId: "env-attached",
    });
    dialled.socket.addEventListener("message", (event) => {
      const frame = decodeFrame(typeof event.data === "string" ? event.data : String(event.data));
      if (frame?.type === "data") {
        dialled.send({
          type: "data",
          channelId: frame.channelId,
          payload: frame.payload.toUpperCase(),
        });
      }
    });
    yield* Effect.promise(() => waitFor(() => findFrame(dialled.frames, "welcome"), "a welcome"));

    const sessions = yield* SessionCredentialService;
    const browserSession = yield* sessions.verify(approverToken);
    const browserWsToken = yield* webSocketTokenFor(approverToken);
    const attached = yield* Effect.promise(() =>
      waitForAsync(
        () =>
          openSocket(
            `ws://127.0.0.1:${port}/api/environments/relay/attach/env-attached?wsToken=${encodeURIComponent(browserWsToken)}`,
            { decode: false },
          ).catch(() => null),
        "a browser attachment",
      ),
    );

    // It genuinely reaches the machine first, or the assertion below would
    // pass against a channel that never worked.
    attached.sendRaw('{"_tag":"Request"}');
    const echoed = yield* Effect.promise(() => waitFor(() => attached.raw[0], "a relayed reply"));
    assert.equal(echoed, '{"_TAG":"REQUEST"}');

    yield* sessions.revoke(browserSession.sessionId);

    // The socket is closed rather than left quietly holding a routing entry.
    const closeCode = yield* Effect.promise(() =>
      waitFor(() => attached.closedWith(), "the attachment to be cut"),
    );
    assert.equal(closeCode, 1008);

    // And the machine was told its channel is gone, so it stops serving it.
    const closed = yield* Effect.promise(() =>
      waitFor(() => findFrame(dialled.frames, "close"), "the environment's channel close"),
    );
    assert.isDefined(closed);

    dialled.close();
  }).pipe(Effect.provide(testEnvironment)),
);

// The other half: a session that is still good keeps working across several
// re-checks. A watchdog that cut every channel on its first tick would pass
// the test above and break the feature.
it.live("keeps an attached browser working while its session is still good", () =>
  Effect.gen(function* () {
    setRelayAttachReauthIntervalMsForTests(20);
    yield* buildAppUnderTest;
    const port = yield* serverPort;
    const approverToken = yield* signIn(PERSON_SUBJECT);
    const machineToken = yield* connectMachine({ approverToken, label: "Ada's laptop" });

    const dialled = yield* dialEnvironment({
      port,
      wsToken: yield* webSocketTokenFor(machineToken),
      environmentId: "env-still-good",
    });
    dialled.socket.addEventListener("message", (event) => {
      const frame = decodeFrame(typeof event.data === "string" ? event.data : String(event.data));
      if (frame?.type === "data") {
        dialled.send({
          type: "data",
          channelId: frame.channelId,
          payload: frame.payload.toUpperCase(),
        });
      }
    });
    yield* Effect.promise(() => waitFor(() => findFrame(dialled.frames, "welcome"), "a welcome"));

    const browserWsToken = yield* webSocketTokenFor(approverToken);
    const attached = yield* Effect.promise(() =>
      waitForAsync(
        () =>
          openSocket(
            `ws://127.0.0.1:${port}/api/environments/relay/attach/env-still-good?wsToken=${encodeURIComponent(browserWsToken)}`,
            { decode: false },
          ).catch(() => null),
        "a browser attachment",
      ),
    );

    // Several re-check intervals later, it is still carrying traffic.
    yield* Effect.sleep(200);
    assert.isNull(attached.closedWith());
    attached.sendRaw('{"_tag":"StillHere"}');
    const echoed = yield* Effect.promise(() => waitFor(() => attached.raw[0], "a relayed reply"));
    assert.equal(echoed, '{"_TAG":"STILLHERE"}');

    attached.close();
    dialled.close();
  }).pipe(Effect.provide(testEnvironment)),
);
