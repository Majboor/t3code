import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { assert, it } from "@effect/vitest";
import type { AuthPairingCredentialResult, AuthSessionId } from "@t3tools/contracts";
import { DateTime, Effect, Layer } from "effect";
import { HttpRouter, HttpServer } from "effect/unstable/http";

import { BROWSER_HANDOFF_PAIRING_LABEL, authSelfPairingCredentialRouteLayer } from "./http.ts";
import { AuthError, type AuthenticatedSession } from "./Services/ServerAuth.ts";
import { ServerAuth } from "./Services/ServerAuth.ts";

const EXPIRES_AT = DateTime.makeUnsafe(new Date("2030-01-01T00:00:00.000Z"));

const makeSession = (overrides: Partial<AuthenticatedSession> = {}): AuthenticatedSession =>
  ({
    sessionId: "session-1" as AuthSessionId,
    subject: "desktop-bootstrap",
    role: "owner",
    method: "browser-session-cookie",
    client: {},
    expiresAt: EXPIRES_AT,
    ...overrides,
  }) as AuthenticatedSession;

interface IssueCall {
  readonly role?: string;
  readonly subject?: string;
  readonly label?: string;
}

const buildAppUnderTest = (input: {
  readonly session: AuthenticatedSession | null;
  readonly issued: IssueCall[];
}) => {
  const serverAuthLayer = Layer.mock(ServerAuth)({
    authenticateHttpRequest: () =>
      input.session
        ? Effect.succeed(input.session)
        : Effect.fail(new AuthError({ message: "Unauthorized request.", status: 401 })),
    issuePairingCredential: (issueInput?: IssueCall) => {
      input.issued.push(issueInput ?? {});
      return Effect.succeed({
        id: "pairing-link-1",
        credential: "ABC123XYZ789",
        ...(issueInput?.label ? { label: issueInput.label } : {}),
        expiresAt: EXPIRES_AT,
      } satisfies AuthPairingCredentialResult);
    },
  });

  return Layer.build(
    HttpRouter.serve(authSelfPairingCredentialRouteLayer, {
      disableListenLog: true,
      disableLogger: true,
    }).pipe(Layer.provide(serverAuthLayer)),
  );
};

const mintSelfPairingCredential = Effect.gen(function* () {
  const server = yield* HttpServer.HttpServer;
  const address = server.address as HttpServer.TcpAddress;
  const response = yield* Effect.promise(() =>
    fetch(`http://127.0.0.1:${address.port}/api/auth/pairing-token/self`, { method: "POST" }),
  );
  const body = (yield* Effect.promise(() => response.json())) as Record<string, unknown>;
  return { status: response.status, body };
});

it.effect("mints a credential for the caller's own identity, not a new principal", () =>
  Effect.gen(function* () {
    const issued: IssueCall[] = [];
    yield* buildAppUnderTest({ session: makeSession(), issued });

    const result = yield* mintSelfPairingCredential;

    assert.equal(result.status, 200);
    assert.equal(result.body["credential"], "ABC123XYZ789");
    // The whole point: same subject and same role as the session that asked, so
    // the browser arrives as the same person rather than a fresh paired client.
    assert.deepEqual(issued, [
      { role: "owner", subject: "desktop-bootstrap", label: BROWSER_HANDOFF_PAIRING_LABEL },
    ]);
  }).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("carries whatever subject the caller actually has", () =>
  Effect.gen(function* () {
    const issued: IssueCall[] = [];
    yield* buildAppUnderTest({
      session: makeSession({ subject: "local:6f1c9d3e" }),
      issued,
    });

    yield* mintSelfPairingCredential;

    assert.equal(issued[0]?.subject, "local:6f1c9d3e");
  }).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("refuses a client session: it may not hand out an owner-shaped credential", () =>
  Effect.gen(function* () {
    const issued: IssueCall[] = [];
    yield* buildAppUnderTest({
      session: makeSession({ role: "client", subject: "paired-client:abc" }),
      issued,
    });

    const result = yield* mintSelfPairingCredential;

    assert.equal(result.status, 403);
    assert.deepEqual(issued, []);
  }).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("refuses an unauthenticated caller, so reaching the port proves nothing", () =>
  Effect.gen(function* () {
    const issued: IssueCall[] = [];
    yield* buildAppUnderTest({ session: null, issued });

    const result = yield* mintSelfPairingCredential;

    assert.equal(result.status, 401);
    assert.deepEqual(issued, []);
  }).pipe(Effect.provide(NodeHttpServer.layerTest)),
);
