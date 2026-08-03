import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Crypto from "node:crypto";
import {
  MembershipId,
  OrganizationId,
  TenantId,
  UserId,
  type TenantMembership,
} from "@t3tools/contracts";
import { Effect, Layer } from "effect";
import { vi } from "vitest";

import type { ServerConfigShape } from "../../config.ts";
import { ServerConfig } from "../../config.ts";
import { TenancyRepositoryLive } from "../../persistence/Layers/Tenancy.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { TenancyRepository } from "../../persistence/Services/Tenancy.ts";
import { BootstrapCredentialError } from "../Services/BootstrapCredentialService.ts";
import { ServerAuth, type ServerAuthShape } from "../Services/ServerAuth.ts";
import { ServerAuthLive, toBootstrapExchangeAuthError } from "./ServerAuth.ts";
import { ServerSecretStoreLive } from "./ServerSecretStore.ts";
import type { SupabaseJwtClaims, SupabaseJwks } from "../supabaseJwt.ts";

const SUPABASE_PROJECT_URL = "https://project-ref.supabase.co";
const SUPABASE_ISSUER = `${SUPABASE_PROJECT_URL}/auth/v1`;
const SUPABASE_SUBJECT = "4d7ecde3-b641-4be2-8d62-0bf345fbfd1d";
const SUPABASE_USER_ID = UserId.make(`supabase:${SUPABASE_SUBJECT}`);
const SUPABASE_TENANT_ID = TenantId.make("tenant-supabase-auth-live");
const SUPABASE_ORGANIZATION_ID = OrganizationId.make("org-supabase-auth-live");
const TEST_JWT_EXPIRES_IN_SECONDS = 300;

const makeServerConfigLayer = (overrides?: Partial<ServerConfigShape>) =>
  Layer.effect(
    ServerConfig,
    Effect.gen(function* () {
      const config = yield* ServerConfig;
      return {
        ...config,
        ...overrides,
      } satisfies ServerConfigShape;
    }),
  ).pipe(Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-auth-server-test-" })));

const makeServerAuthLayer = (overrides?: Partial<ServerConfigShape>) =>
  Layer.mergeAll(ServerAuthLive, TenancyRepositoryLive).pipe(
    Layer.provide(SqlitePersistenceMemory),
    Layer.provide(ServerSecretStoreLive),
    Layer.provide(makeServerConfigLayer(overrides)),
  );

const makeCookieRequest = (
  sessionToken: string,
): Parameters<ServerAuthShape["authenticateHttpRequest"]>[0] =>
  ({
    cookies: {
      t3_session: sessionToken,
    },
    headers: {},
  }) as unknown as Parameters<ServerAuthShape["authenticateHttpRequest"]>[0];

const makeBearerRequest = (
  bearerToken: string,
): Parameters<ServerAuthShape["authenticateHttpRequest"]>[0] =>
  ({
    cookies: {},
    headers: {
      authorization: `Bearer ${bearerToken}`,
      "user-agent": "Vitest Supabase Browser",
    },
    source: {
      remoteAddress: "203.0.113.10",
    },
  }) as unknown as Parameters<ServerAuthShape["authenticateHttpRequest"]>[0];

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function signSupabaseJwt(input: {
  readonly keyPair: Crypto.KeyPairKeyObjectResult;
  readonly kid: string;
  readonly claims?: Partial<SupabaseJwtClaims>;
}): string {
  const signingInput = `${base64UrlJson({
    alg: "RS256",
    typ: "JWT",
    kid: input.kid,
  })}.${base64UrlJson({
    sub: SUPABASE_SUBJECT,
    iss: SUPABASE_ISSUER,
    aud: "authenticated",
    exp: Math.floor(Date.now() / 1000) + TEST_JWT_EXPIRES_IN_SECONDS,
    email: "member@example.test",
    role: "authenticated",
    app_metadata: {
      provider: "email",
    },
    user_metadata: {
      full_name: "Member Example",
    },
    ...input.claims,
  })}`;
  const signature = Crypto.createSign("RSA-SHA256")
    .update(signingInput)
    .end()
    .sign(input.keyPair.privateKey)
    .toString("base64url");
  return `${signingInput}.${signature}`;
}

function makeSignedSupabaseFixture(claims?: Partial<SupabaseJwtClaims>): {
  readonly jwt: string;
  readonly jwks: SupabaseJwks;
} {
  const keyPair = Crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const kid = "server-auth-live-key";
  return {
    jwt: signSupabaseJwt({ keyPair, kid, ...(claims ? { claims } : {}) }),
    jwks: {
      keys: [
        {
          ...keyPair.publicKey.export({ format: "jwk" }),
          kid,
          alg: "RS256",
          use: "sig",
        },
      ],
    },
  };
}

function makeSupabaseMembership(overrides?: Partial<TenantMembership>): TenantMembership {
  return {
    id: MembershipId.make("membership-supabase-auth-live"),
    tenantId: SUPABASE_TENANT_ID,
    userId: SUPABASE_USER_ID,
    organizationId: SUPABASE_ORGANIZATION_ID,
    roles: ["developer"],
    createdAt: "2026-05-08T12:00:00.000Z",
    disabledAt: null,
    ...overrides,
  };
}

function mockSupabaseJwksFetch(jwks: SupabaseJwks) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(() =>
    Promise.resolve(
      new Response(JSON.stringify(jwks), {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
      }),
    ),
  );
}

const requestMetadata = {
  deviceType: "desktop" as const,
  os: "macOS",
  browser: "Chrome",
  ipAddress: "192.168.1.23",
};

it.layer(NodeServices.layer)("ServerAuthLive", (it) => {
  it.effect("maps invalid bootstrap credential failures to 401", () =>
    Effect.sync(() => {
      const error = toBootstrapExchangeAuthError(
        new BootstrapCredentialError({
          message: "Unknown bootstrap credential.",
          status: 401,
        }),
      );

      expect(error.status).toBe(401);
      expect(error.message).toBe("Invalid bootstrap credential.");
    }),
  );

  it.effect("maps unexpected bootstrap failures to 500", () =>
    Effect.sync(() => {
      const error = toBootstrapExchangeAuthError(
        new BootstrapCredentialError({
          message: "Failed to consume bootstrap credential.",
          status: 500,
          cause: new Error("sqlite is unavailable"),
        }),
      );

      expect(error.status).toBe(500);
      expect(error.message).toBe("Failed to validate bootstrap credential.");
    }),
  );

  it.effect("issues client pairing credentials by default", () =>
    Effect.gen(function* () {
      const serverAuth = yield* ServerAuth;

      const pairingCredential = yield* serverAuth.issuePairingCredential();
      const exchanged = yield* serverAuth.exchangeBootstrapCredential(
        pairingCredential.credential,
        requestMetadata,
      );
      const verified = yield* serverAuth.authenticateHttpRequest(
        makeCookieRequest(exchanged.sessionToken),
      );

      expect(verified.sessionId.length).toBeGreaterThan(0);
      expect(verified.role).toBe("client");
      expect(verified.subject).toMatch(/^paired-client:/);
    }).pipe(Effect.provide(makeServerAuthLayer())),
  );

  it.effect("authenticates local password accounts as pending tenant users", () =>
    Effect.gen(function* () {
      const serverAuth = yield* ServerAuth;

      const signup = yield* serverAuth.authenticatePassword(
        {
          email: "employee@example.test",
          password: "CorrectHorseBatteryStaple1!",
          mode: "signup",
          displayName: "Employee Example",
        },
        requestMetadata,
      );
      const signupRequest = makeCookieRequest(signup.sessionToken);
      const signupSession = yield* serverAuth.authenticateHttpRequest(signupRequest);
      const signupProfile = yield* serverAuth.getUserProfile(signupRequest);

      expect(signupSession.subject).toMatch(/^local-user:local:/);
      expect(signupSession.userId).toBeDefined();
      expect(signupSession.tenantSessionContext).toBeUndefined();
      expect(signupProfile.userId).toBe(signupSession.userId);
      expect(signupProfile.tenantStatus).toBe("pending-membership");
      expect(signupProfile.displayName).toBe("Employee Example");

      const login = yield* serverAuth.authenticatePassword(
        {
          email: "employee@example.test",
          password: "CorrectHorseBatteryStaple1!",
          mode: "login",
        },
        requestMetadata,
      );
      const loginSession = yield* serverAuth.authenticateHttpRequest(
        makeCookieRequest(login.sessionToken),
      );

      expect(loginSession.subject).toBe(signupSession.subject);
      expect(loginSession.userId).toBe(signupSession.userId);
    }).pipe(Effect.provide(makeServerAuthLayer({ localPasswordAuth: true }))),
  );

  it.effect("persists account profile updates by authenticated subject", () =>
    Effect.gen(function* () {
      const serverAuth = yield* ServerAuth;

      const pairingCredential = yield* serverAuth.issuePairingCredential({
        label: "Original Account",
      });
      const exchanged = yield* serverAuth.exchangeBootstrapCredential(
        pairingCredential.credential,
        requestMetadata,
      );
      const request = makeCookieRequest(exchanged.sessionToken);

      const updated = yield* serverAuth.updateUserProfile(request, {
        displayName: "Ada Lovelace",
        avatarInitials: "AL",
      });
      const session = yield* serverAuth.authenticateHttpRequest(request);
      const loaded = yield* serverAuth.getUserProfile(request);
      const resolved = yield* serverAuth.resolveUserProfile(session);

      expect(updated.displayName).toBe("Ada Lovelace");
      expect(updated.avatarInitials).toBe("AL");
      expect(loaded.displayName).toBe("Ada Lovelace");
      expect(loaded.avatarInitials).toBe("AL");
      expect(resolved.displayName).toBe("Ada Lovelace");
      expect(resolved.avatarInitials).toBe("AL");
      expect(loaded.subject).toMatch(/^paired-client:/);
    }).pipe(Effect.provide(makeServerAuthLayer())),
  );

  it.effect("issues startup pairing URLs that bootstrap owner sessions", () =>
    Effect.gen(function* () {
      const serverAuth = yield* ServerAuth;

      const pairingUrl = yield* serverAuth.issueStartupPairingUrl("http://127.0.0.1:3773");
      const token = new URLSearchParams(new URL(pairingUrl).hash.slice(1)).get("token");
      const listedPairingLinks = yield* serverAuth.listPairingLinks();
      expect(token).toBeTruthy();
      expect(
        listedPairingLinks.some((pairingLink) => pairingLink.subject === "owner-bootstrap"),
      ).toBe(false);

      const exchanged = yield* serverAuth.exchangeBootstrapCredential(token ?? "", requestMetadata);
      const verified = yield* serverAuth.authenticateHttpRequest(
        makeCookieRequest(exchanged.sessionToken),
      );

      expect(verified.role).toBe("owner");
      expect(verified.subject).toBe("owner-bootstrap");
    }).pipe(Effect.provide(makeServerAuthLayer())),
  );

  it.effect("issues loopback owner sessions without a pairing credential", () =>
    Effect.gen(function* () {
      const serverAuth = yield* ServerAuth;

      const issued = yield* serverAuth.issueLoopbackOwnerSession(requestMetadata);
      const verified = yield* serverAuth.authenticateHttpRequest(
        makeCookieRequest(issued.sessionToken),
      );

      expect(issued.response.authenticated).toBe(true);
      expect(issued.response.role).toBe("owner");
      expect(issued.response.sessionMethod).toBe("browser-session-cookie");
      expect(verified.role).toBe("owner");
      expect(verified.subject).toBe("loopback-local-owner");
    }).pipe(
      Effect.provide(
        makeServerAuthLayer({
          mode: "web",
          host: "127.0.0.1",
        }),
      ),
    ),
  );

  it.effect(
    "issues owner sessions without a pairing credential when unsafe no-auth is enabled",
    () =>
      Effect.gen(function* () {
        const serverAuth = yield* ServerAuth;

        const issued = yield* serverAuth.issueUnsafeNoAuthOwnerSession(requestMetadata);
        const verified = yield* serverAuth.authenticateHttpRequest(
          makeCookieRequest(issued.sessionToken),
        );

        expect(issued.response.authenticated).toBe(true);
        expect(issued.response.role).toBe("owner");
        expect(issued.response.sessionMethod).toBe("browser-session-cookie");
        expect(verified.role).toBe("owner");
        expect(verified.subject).toBe("unsafe-no-auth-owner");
      }).pipe(
        Effect.provide(
          makeServerAuthLayer({
            mode: "web",
            host: "0.0.0.0",
            unsafeNoAuth: true,
          }),
        ),
      ),
  );

  it.effect("lists pairing links and revokes other client sessions while keeping the owner", () =>
    Effect.gen(function* () {
      const serverAuth = yield* ServerAuth;

      const ownerExchange = yield* serverAuth.exchangeBootstrapCredential(
        "desktop-bootstrap-token",
        requestMetadata,
      );
      const ownerSession = yield* serverAuth.authenticateHttpRequest(
        makeCookieRequest(ownerExchange.sessionToken),
      );
      const pairingCredential = yield* serverAuth.issuePairingCredential({
        label: "Julius iPhone",
      });
      const listedPairingLinks = yield* serverAuth.listPairingLinks();
      const clientExchange = yield* serverAuth.exchangeBootstrapCredential(
        pairingCredential.credential,
        {
          ...requestMetadata,
          deviceType: "mobile",
          os: "iOS",
          browser: "Safari",
          ipAddress: "192.168.1.88",
        },
      );
      const clientSession = yield* serverAuth.authenticateHttpRequest(
        makeCookieRequest(clientExchange.sessionToken),
      );
      const clientsBeforeRevoke = yield* serverAuth.listClientSessions(ownerSession.sessionId);
      const revokedCount = yield* serverAuth.revokeOtherClientSessions(ownerSession.sessionId);
      const clientsAfterRevoke = yield* serverAuth.listClientSessions(ownerSession.sessionId);

      expect(listedPairingLinks.map((entry) => entry.id)).toContain(pairingCredential.id);
      expect(listedPairingLinks.find((entry) => entry.id === pairingCredential.id)?.label).toBe(
        "Julius iPhone",
      );
      expect(clientsBeforeRevoke).toHaveLength(2);
      expect(
        clientsBeforeRevoke.find((entry) => entry.sessionId === ownerSession.sessionId)?.current,
      ).toBe(true);
      expect(
        clientsBeforeRevoke.find((entry) => entry.sessionId === clientSession.sessionId)?.current,
      ).toBe(false);
      expect(
        clientsBeforeRevoke.find((entry) => entry.sessionId === clientSession.sessionId)?.client
          .label,
      ).toBe("Julius iPhone");
      expect(
        clientsBeforeRevoke.find((entry) => entry.sessionId === clientSession.sessionId)?.client
          .deviceType,
      ).toBe("mobile");
      expect(revokedCount).toBe(1);
      expect(clientsAfterRevoke).toHaveLength(1);
      expect(clientsAfterRevoke[0]?.sessionId).toBe(ownerSession.sessionId);
    }).pipe(
      Effect.provide(
        makeServerAuthLayer({
          desktopBootstrapToken: "desktop-bootstrap-token",
        }),
      ),
    ),
  );

  it.effect("authenticates Supabase bearer tokens as tenant-scoped client sessions", () =>
    Effect.gen(function* () {
      const fixture = makeSignedSupabaseFixture();
      const fetchSpy = mockSupabaseJwksFetch(fixture.jwks);
      try {
        const tenancyRepository = yield* TenancyRepository;
        yield* tenancyRepository.saveCollaboration({
          presence: [],
          invites: [],
          memberships: [makeSupabaseMembership()],
          activities: [],
        });

        const serverAuth = yield* ServerAuth;
        const session = yield* serverAuth.authenticateHttpRequest(makeBearerRequest(fixture.jwt));
        const sessionState = yield* serverAuth.getSessionState(makeBearerRequest(fixture.jwt));
        const profile = yield* serverAuth.getUserProfile(makeBearerRequest(fixture.jwt));

        expect(fetchSpy).toHaveBeenCalledWith(
          `${SUPABASE_PROJECT_URL}/auth/v1/.well-known/jwks.json`,
          {
            headers: {
              accept: "application/json",
            },
          },
        );
        expect(session.subject).toBe(SUPABASE_SUBJECT);
        expect(session.role).toBe("client");
        expect(session.method).toBe("bearer-session-token");
        expect(session.client.label).toBe("Member Example");
        expect(session.tenantSessionContext).toMatchObject({
          userId: SUPABASE_USER_ID,
          tenantId: SUPABASE_TENANT_ID,
          organizationId: SUPABASE_ORGANIZATION_ID,
          membershipIds: [MembershipId.make("membership-supabase-auth-live")],
          roles: ["developer"],
        });
        expect(sessionState.tenantStatus).toBe("active");
        expect(sessionState.tenantSession).toMatchObject({
          userId: SUPABASE_USER_ID,
          tenantId: SUPABASE_TENANT_ID,
        });
        expect(profile.userId).toBe(SUPABASE_USER_ID);
        expect(profile.tenantStatus).toBe("active");
        expect(profile.tenantSession).toMatchObject({
          userId: SUPABASE_USER_ID,
          tenantId: SUPABASE_TENANT_ID,
        });
      } finally {
        fetchSpy.mockRestore();
      }
    }).pipe(
      Effect.provide(
        makeServerAuthLayer({
          supabaseProjectUrl: new URL(SUPABASE_PROJECT_URL),
          supabaseJwtAudience: "authenticated",
        }),
      ),
    ),
  );

  it.effect(
    "authenticates Supabase bearer tokens without membership as pending tenant sessions",
    () =>
      Effect.gen(function* () {
        const fixture = makeSignedSupabaseFixture();
        const fetchSpy = mockSupabaseJwksFetch(fixture.jwks);
        try {
          const serverAuth = yield* ServerAuth;
          const session = yield* serverAuth.authenticateHttpRequest(makeBearerRequest(fixture.jwt));
          const sessionState = yield* serverAuth.getSessionState(makeBearerRequest(fixture.jwt));
          const profile = yield* serverAuth.getUserProfile(makeBearerRequest(fixture.jwt));

          expect(session.subject).toBe(SUPABASE_SUBJECT);
          expect(session.role).toBe("client");
          expect(session.method).toBe("bearer-session-token");
          expect(session.userId).toBe(SUPABASE_USER_ID);
          expect(session.tenantSessionContext).toBeUndefined();
          expect(sessionState.tenantStatus).toBe("pending-membership");
          expect(sessionState.tenantSession).toBeUndefined();
          expect(profile.userId).toBe(SUPABASE_USER_ID);
          expect(profile.tenantStatus).toBe("pending-membership");
          expect(profile.tenantSession).toBeUndefined();
        } finally {
          fetchSpy.mockRestore();
        }
      }).pipe(
        Effect.provide(
          makeServerAuthLayer({
            supabaseProjectUrl: new URL(SUPABASE_PROJECT_URL),
            supabaseJwtAudience: "authenticated",
          }),
        ),
      ),
  );

  it.effect("denies Supabase bearer tokens without an active tenant membership", () =>
    Effect.gen(function* () {
      const fixture = makeSignedSupabaseFixture();
      const fetchSpy = mockSupabaseJwksFetch(fixture.jwks);
      try {
        const tenancyRepository = yield* TenancyRepository;
        yield* tenancyRepository.saveCollaboration({
          presence: [],
          invites: [],
          memberships: [
            makeSupabaseMembership({
              disabledAt: "2026-05-08T12:30:00.000Z",
            }),
          ],
          activities: [],
        });

        const serverAuth = yield* ServerAuth;
        const error = yield* Effect.flip(
          serverAuth.authenticateHttpRequest(makeBearerRequest(fixture.jwt)),
        );

        expect(error.status).toBe(403);
        expect(error.message).toBe("Supabase user tenant memberships are disabled.");
      } finally {
        fetchSpy.mockRestore();
      }
    }).pipe(
      Effect.provide(
        makeServerAuthLayer({
          supabaseProjectUrl: new URL(SUPABASE_PROJECT_URL),
          supabaseJwtAudience: "authenticated",
        }),
      ),
    ),
  );
});
