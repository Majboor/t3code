import { expect, it } from "@effect/vitest";
import * as Crypto from "node:crypto";
import {
  AuthSessionId,
  MembershipId,
  OrganizationId,
  TenantId,
  UserId,
  WorkspaceId,
  type TenantMembership,
} from "@t3tools/contracts";

import {
  authenticateSupabaseBearerToken,
  mapSupabaseIdentityToTenantSessionContext,
  mapSupabaseClaimsToIdentity,
  requireSupabaseAuthBridgeConfig,
  resolveSupabaseAuthBridgeConfig,
  SupabaseAuthBridgeError,
} from "./supabaseAuthBridge.ts";
import type { SupabaseJwtClaims, SupabaseJwks } from "./supabaseJwt.ts";

const PROJECT_URL = "https://project-ref.supabase.co";
const ISSUER = `${PROJECT_URL}/auth/v1`;
const NOW = new Date("2026-05-08T12:00:00.000Z");
const NOW_SECONDS = Math.floor(NOW.getTime() / 1000);
const AUTH_SESSION_ID = AuthSessionId.make("auth-supabase-session");
const SUPABASE_USER_ID = UserId.make("supabase:4d7ecde3-b641-4be2-8d62-0bf345fbfd1d");
const TENANT_ID = TenantId.make("tenant-supabase");
const OTHER_TENANT_ID = TenantId.make("tenant-other");
const ORGANIZATION_ID = OrganizationId.make("org-supabase");
const ISSUED_AT = "2026-05-08T12:00:00.000Z";
const EXPIRES_AT = "2026-05-08T13:00:00.000Z";

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function signJwt(input: {
  readonly keyPair: Crypto.KeyPairKeyObjectResult;
  readonly kid: string;
  readonly claims?: Partial<SupabaseJwtClaims>;
}): string {
  const signingInput = `${base64UrlJson({
    alg: "RS256",
    typ: "JWT",
    kid: input.kid,
  })}.${base64UrlJson({
    sub: "4d7ecde3-b641-4be2-8d62-0bf345fbfd1d",
    iss: ISSUER,
    aud: "authenticated",
    exp: NOW_SECONDS + 300,
    email: "member@example.test",
    role: "authenticated",
    app_metadata: {
      provider: "email",
    },
    user_metadata: {
      full_name: "Member Example",
      avatar_url: "https://cdn.example/avatar.png",
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

function makeSignedFixture(): {
  readonly jwt: string;
  readonly jwks: SupabaseJwks;
} {
  const keyPair = Crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const kid = "bridge-key";
  return {
    jwt: signJwt({ keyPair, kid }),
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

function makeIdentity() {
  return mapSupabaseClaimsToIdentity({
    sub: "4d7ecde3-b641-4be2-8d62-0bf345fbfd1d",
    email: "member@example.test",
    user_metadata: {
      full_name: "Member Example",
    },
  });
}

function makeMembership(overrides?: Partial<TenantMembership>): TenantMembership {
  return {
    id: MembershipId.make("membership-supabase"),
    tenantId: TENANT_ID,
    userId: SUPABASE_USER_ID,
    organizationId: ORGANIZATION_ID,
    roles: ["developer"],
    createdAt: ISSUED_AT,
    disabledAt: null,
    ...overrides,
  };
}

it("resolves Supabase bridge config without exposing the service-role key", () => {
  const config = resolveSupabaseAuthBridgeConfig({
    supabaseProjectUrl: new URL(`${PROJECT_URL}/`),
    supabaseAnonKey: " anon-public-key ",
    supabaseJwtAudience: " authenticated ",
    supabaseServiceRoleSecretName: " supabase/service-role ",
  });

  expect(config).toEqual({
    projectUrl: `${PROJECT_URL}/`,
    audience: "authenticated",
    anonKey: "anon-public-key",
    serviceRoleSecretName: "supabase/service-role",
  });
});

it("treats missing Supabase project URL as disabled config", () => {
  expect(
    resolveSupabaseAuthBridgeConfig({
      supabaseProjectUrl: undefined,
      supabaseAnonKey: "anon-key",
      supabaseJwtAudience: "authenticated",
      supabaseServiceRoleSecretName: "supabase/service-role",
    }),
  ).toBeUndefined();
  expect(() =>
    requireSupabaseAuthBridgeConfig({
      supabaseProjectUrl: undefined,
      supabaseAnonKey: undefined,
      supabaseJwtAudience: undefined,
      supabaseServiceRoleSecretName: undefined,
    }),
  ).toThrow("Supabase auth is not configured.");
});

it("verifies a Supabase access token and maps it to a T3 identity", () => {
  const fixture = makeSignedFixture();

  const identity = authenticateSupabaseBearerToken({
    token: fixture.jwt,
    jwks: fixture.jwks,
    config: {
      projectUrl: PROJECT_URL,
      audience: "authenticated",
      anonKey: "anon-key",
      serviceRoleSecretName: "supabase/service-role",
    },
    now: () => NOW,
  });

  expect(identity).toMatchObject({
    userId: "supabase:4d7ecde3-b641-4be2-8d62-0bf345fbfd1d",
    subject: "4d7ecde3-b641-4be2-8d62-0bf345fbfd1d",
    email: "member@example.test",
    displayName: "Member Example",
    avatarUrl: "https://cdn.example/avatar.png",
    provider: "email",
  });
});

it("fails closed when token verification denies the JWT", () => {
  const fixture = makeSignedFixture();

  expect(() =>
    authenticateSupabaseBearerToken({
      token: fixture.jwt,
      jwks: fixture.jwks,
      config: {
        projectUrl: PROJECT_URL,
        audience: "service-role",
        anonKey: undefined,
        serviceRoleSecretName: undefined,
      },
      now: () => NOW,
    }),
  ).toThrow("Supabase JWT audience is not allowed.");
});

it("requires a subject before mapping claims to a T3 identity", () => {
  expect(() =>
    mapSupabaseClaimsToIdentity({
      sub: "",
      email: "member@example.test",
    }),
  ).toThrow("Supabase JWT is missing a subject.");
});

it("uses email as the display name when Supabase metadata has no name", () => {
  const identity = mapSupabaseClaimsToIdentity({
    sub: "user-with-email",
    email: "fallback@example.test",
  });

  expect(identity.displayName).toBe("fallback@example.test");
});

it("maps a verified Supabase identity to an active tenant session context", () => {
  const identity = makeIdentity();
  const session = mapSupabaseIdentityToTenantSessionContext({
    authSessionId: AUTH_SESSION_ID,
    identity,
    memberships: [
      makeMembership({ roles: ["viewer"] }),
      makeMembership({
        id: MembershipId.make("membership-supabase-admin"),
        roles: ["admin"],
      }),
    ],
    tenantId: TENANT_ID,
    activeWorkspaceId: WorkspaceId.make("workspace-supabase"),
    issuedAt: ISSUED_AT,
    expiresAt: EXPIRES_AT,
  });

  expect(session).toEqual({
    authSessionId: AUTH_SESSION_ID,
    userId: SUPABASE_USER_ID,
    tenantId: TENANT_ID,
    organizationId: ORGANIZATION_ID,
    membershipIds: [
      MembershipId.make("membership-supabase"),
      MembershipId.make("membership-supabase-admin"),
    ],
    roles: ["viewer", "admin"],
    activeWorkspaceId: WorkspaceId.make("workspace-supabase"),
    issuedAt: ISSUED_AT,
    expiresAt: EXPIRES_AT,
  });
});

it("fails closed when a Supabase user has no tenant membership", () => {
  expect(() =>
    mapSupabaseIdentityToTenantSessionContext({
      authSessionId: AUTH_SESSION_ID,
      identity: makeIdentity(),
      memberships: [
        makeMembership({
          userId: UserId.make("supabase:someone-else"),
        }),
      ],
      tenantId: TENANT_ID,
      issuedAt: ISSUED_AT,
      expiresAt: EXPIRES_AT,
    }),
  ).toThrow("Supabase user is not a member of any tenant.");
});

it("fails closed when all Supabase tenant memberships are disabled", () => {
  expect(() =>
    mapSupabaseIdentityToTenantSessionContext({
      authSessionId: AUTH_SESSION_ID,
      identity: makeIdentity(),
      memberships: [
        makeMembership({
          disabledAt: "2026-05-08T12:30:00.000Z",
        }),
      ],
      tenantId: TENANT_ID,
      issuedAt: ISSUED_AT,
      expiresAt: EXPIRES_AT,
    }),
  ).toThrow("Supabase user tenant memberships are disabled.");
});

it("fails closed when a Supabase user requests a tenant they do not belong to", () => {
  expect(() =>
    mapSupabaseIdentityToTenantSessionContext({
      authSessionId: AUTH_SESSION_ID,
      identity: makeIdentity(),
      memberships: [makeMembership()],
      tenantId: OTHER_TENANT_ID,
      issuedAt: ISSUED_AT,
      expiresAt: EXPIRES_AT,
    }),
  ).toThrow("Supabase user is not an active member of the requested tenant.");
});

it("exposes bridge errors as tagged auth errors", () => {
  const error = new SupabaseAuthBridgeError({
    message: "example",
    status: 401,
  });

  expect(error._tag).toBe("SupabaseAuthBridgeError");
  expect(error.status).toBe(401);
});
