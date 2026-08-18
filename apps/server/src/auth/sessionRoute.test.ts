import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { assert, it } from "@effect/vitest";
import type { AuthSessionState } from "@t3tools/contracts";
import { DateTime, Effect, Layer } from "effect";
import { HttpRouter, HttpServer } from "effect/unstable/http";

import { ServerConfig, type ServerConfigShape } from "../config.ts";
import { authSessionRouteLayer } from "./http.ts";
import { resolveAdvertisedAuthPolicy } from "./Layers/ServerAuthPolicy.ts";
import { ServerAuth } from "./Services/ServerAuth.ts";
import { SessionCredentialService } from "./Services/SessionCredentialService.ts";
import { resolveSessionCookieName } from "./utils.ts";

const SESSION_TOKEN = "issued-owner-session-token";

/**
 * The route is the thing under test, so the services around it are stubbed down to
 * the two questions it actually asks: what does the session state look like, and
 * hand me an owner session. Standing up the real ServerAuth would drag in the
 * database and secret store without making the assertions any stronger.
 */
const makeSessionRouteApp = (overrides: Partial<ServerConfigShape>) =>
  Effect.gen(function* () {
    const fileSystem = yield* Effect.service(ServerConfig).pipe(Effect.orDie, Effect.as(null));
    void fileSystem;
  }).pipe(Effect.as(null));

const makeConfigLayer = (overrides: Partial<ServerConfigShape>) =>
  Layer.effect(
    ServerConfig,
    Effect.gen(function* () {
      const config = yield* ServerConfig;
      return { ...config, ...overrides } satisfies ServerConfigShape;
    }),
  ).pipe(Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-session-route-" })));

const makeServerAuthLayer = Layer.effect(
  ServerAuth,
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const expiresAt = DateTime.makeUnsafe(new Date("2030-01-01T00:00:00.000Z"));
    const sessionState: AuthSessionState = {
      authenticated: false,
      auth: {
        policy: resolveAdvertisedAuthPolicy(config),
        bootstrapMethods: ["one-time-token"],
        sessionMethods: ["browser-session-cookie", "bearer-session-token"],
        sessionCookieName: resolveSessionCookieName({ mode: config.mode, port: config.port }),
      },
    };
    const issued = {
      response: {
        authenticated: true,
        role: "owner",
        sessionMethod: "browser-session-cookie",
        expiresAt,
      },
      sessionToken: SESSION_TOKEN,
    } as const;

    return ServerAuth.makeUnsafe({
      getSessionState: () => Effect.succeed(sessionState),
      issueLoopbackOwnerSession: () => Effect.succeed(issued),
      issueUnsafeNoAuthOwnerSession: () => Effect.succeed(issued),
    });
  }),
);

const sessionCredentialLayer = Layer.succeed(
  SessionCredentialService,
  SessionCredentialService.makeUnsafe({ cookieName: "t3_session" }),
);

const buildAppUnderTest = (overrides: Partial<ServerConfigShape> = {}) => {
  const configLayer = makeConfigLayer({ mode: "web", host: "127.0.0.1", ...overrides });
  return Layer.build(
    HttpRouter.serve(authSessionRouteLayer, {
      disableListenLog: true,
      disableLogger: true,
    }).pipe(
      Layer.provide(makeServerAuthLayer.pipe(Layer.provide(configLayer))),
      Layer.provide(sessionCredentialLayer),
      Layer.provideMerge(configLayer),
    ),
  );
};

const getSessionUrl = Effect.gen(function* () {
  const server = yield* HttpServer.HttpServer;
  const address = server.address as HttpServer.TcpAddress;
  return `http://127.0.0.1:${address.port}/api/auth/session`;
});

interface SessionProbe {
  readonly status: number;
  readonly authenticated: boolean;
  readonly policy: string;
  readonly setCookie: string | null;
  readonly refused: string | null;
  readonly refusedReason: string | null;
}

const probeSession = (headers: Record<string, string> = {}) =>
  Effect.gen(function* () {
    const url = yield* getSessionUrl;
    const response = yield* Effect.promise(() => fetch(url, { headers }));
    const body = (yield* Effect.promise(() => response.json())) as AuthSessionState;
    return {
      status: response.status,
      authenticated: body.authenticated,
      policy: body.auth.policy,
      setCookie: response.headers.get("set-cookie"),
      refused: response.headers.get("x-t3-auth-local-session-refused"),
      refusedReason: response.headers.get("x-t3-auth-local-session-refused-reason"),
    } satisfies SessionProbe;
  });

void makeSessionRouteApp;

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
    // A published server no longer claims a policy that promises loopback-only reach.
    assert.equal(probe.policy, "remote-reachable");
  }).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("refuses a request a tunnel relayed, even on a loopback-only server", () =>
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
