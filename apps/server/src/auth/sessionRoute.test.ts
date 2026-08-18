import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { assert, it } from "@effect/vitest";
import type { AuthSessionState } from "@t3tools/contracts";
import { DateTime, Effect, Layer } from "effect";
import { HttpRouter, HttpServer } from "effect/unstable/http";

import { ServerConfig, type ServerConfigShape } from "../config.ts";
import { authSessionRouteLayer } from "./http.ts";
import {
  resolveAdvertisedAuthPolicy,
  type ServerAuthPolicyConfig,
} from "./Layers/ServerAuthPolicy.ts";
import { ServerAuth } from "./Services/ServerAuth.ts";
import { SessionCredentialService } from "./Services/SessionCredentialService.ts";

const SESSION_TOKEN = "issued-owner-session-token";
const SESSION_COOKIE_NAME = "t3_session";

const LOOPBACK_WEB_SERVER: ServerAuthPolicyConfig = {
  mode: "web",
  host: "127.0.0.1",
  unsafeNoAuth: false,
  basicAuthUsername: undefined,
  basicAuthPassword: undefined,
  publishedBeyondLoopback: false,
};

/**
 * The route is what is under test, so the services around it answer only the two
 * questions it asks: what does the session state look like, and hand me an owner
 * session. Standing up the real ServerAuth would drag in the database and the
 * secret store without making a single assertion stronger.
 */
const makeServerAuthLayer = (config: ServerAuthPolicyConfig) => {
  const sessionState: AuthSessionState = {
    authenticated: false,
    auth: {
      policy: resolveAdvertisedAuthPolicy(config),
      bootstrapMethods: ["one-time-token"],
      sessionMethods: ["browser-session-cookie", "bearer-session-token"],
      sessionCookieName: SESSION_COOKIE_NAME,
    },
  };
  const issued = {
    response: {
      authenticated: true,
      role: "owner",
      sessionMethod: "browser-session-cookie",
      expiresAt: DateTime.makeUnsafe(new Date("2030-01-01T00:00:00.000Z")),
    },
    sessionToken: SESSION_TOKEN,
  } as const;

  return Layer.mock(ServerAuth)({
    getSessionState: () => Effect.succeed(sessionState),
    issueLoopbackOwnerSession: () => Effect.succeed(issued),
    issueUnsafeNoAuthOwnerSession: () => Effect.succeed(issued),
  });
};

const sessionCredentialLayer = Layer.mock(SessionCredentialService)({
  cookieName: SESSION_COOKIE_NAME,
});

const buildAppUnderTest = (overrides: Partial<ServerConfigShape> = {}) => {
  const policyConfig: ServerAuthPolicyConfig = { ...LOOPBACK_WEB_SERVER, ...overrides };
  const configLayer = Layer.effect(
    ServerConfig,
    Effect.gen(function* () {
      const config = yield* ServerConfig;
      return { ...config, ...policyConfig, ...overrides } satisfies ServerConfigShape;
    }),
  ).pipe(Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-session-route-" })));

  return Layer.build(
    HttpRouter.serve(authSessionRouteLayer, {
      disableListenLog: true,
      disableLogger: true,
    }).pipe(
      Layer.provide(makeServerAuthLayer(policyConfig)),
      Layer.provide(sessionCredentialLayer),
      Layer.provide(configLayer),
    ),
  );
};

const probeSession = (headers: Record<string, string> = {}) =>
  Effect.gen(function* () {
    const server = yield* HttpServer.HttpServer;
    const address = server.address as HttpServer.TcpAddress;
    const response = yield* Effect.promise(() =>
      fetch(`http://127.0.0.1:${address.port}/api/auth/session`, { headers }),
    );
    const body = (yield* Effect.promise(() => response.json())) as AuthSessionState;
    return {
      status: response.status,
      authenticated: body.authenticated,
      policy: body.auth.policy,
      setCookie: response.headers.get("set-cookie"),
      refused: response.headers.get("x-t3-auth-local-session-refused"),
      refusedReason: response.headers.get("x-t3-auth-local-session-refused-reason"),
    };
  });

it.effect("signs in a browser talking straight to a loopback server", () =>
  Effect.gen(function* () {
    yield* buildAppUnderTest();

    const probe = yield* probeSession();

    assert.equal(probe.status, 200);
    assert.isTrue(probe.authenticated);
    assert.equal(probe.policy, "loopback-browser");
    assert.include(probe.setCookie ?? "", SESSION_TOKEN);
    assert.isNull(probe.refused);
  }).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("refuses, with a reason, once the server knows it is published", () =>
  Effect.gen(function* () {
    yield* buildAppUnderTest({ publishedBeyondLoopback: true });

    const probe = yield* probeSession();

    assert.equal(probe.status, 200);
    assert.isFalse(probe.authenticated);
    assert.isNull(probe.setCookie);
    assert.equal(probe.refused, "server-published");
    assert.match(probe.refusedReason ?? "", /one-time token/i);
    // A published server stops claiming a policy that promises loopback-only reach.
    assert.equal(probe.policy, "remote-reachable");
  }).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("refuses a relayed request, even on a server that is only bound to loopback", () =>
  Effect.gen(function* () {
    yield* buildAppUnderTest();

    const probe = yield* probeSession({
      "cf-connecting-ip": "203.0.113.7",
      "x-forwarded-for": "203.0.113.7",
    });

    assert.equal(probe.status, 200);
    assert.isFalse(probe.authenticated);
    assert.isNull(probe.setCookie);
    assert.equal(probe.refused, "request-forwarded");
    assert.include(probe.refusedReason ?? "", "x-forwarded-for");
  }).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("leaves a desktop-managed server alone: no session, and nothing to explain", () =>
  Effect.gen(function* () {
    yield* buildAppUnderTest({ mode: "desktop" });

    const probe = yield* probeSession();

    assert.equal(probe.status, 200);
    assert.isFalse(probe.authenticated);
    assert.isNull(probe.setCookie);
    assert.isNull(probe.refused);
  }).pipe(Effect.provide(NodeHttpServer.layerTest)),
);
