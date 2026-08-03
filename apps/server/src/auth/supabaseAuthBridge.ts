import {
  AuthSessionId,
  TenantId,
  UserId,
  type TenantMembership,
  type TenantRole,
  type TenantSessionContext,
  WorkspaceId,
} from "@t3tools/contracts";
import { Data } from "effect";

import type { ServerConfigShape } from "../config.ts";
import {
  fetchSupabaseJwks,
  verifySupabaseJwt,
  type SupabaseJwks,
  type SupabaseJwtClaims,
} from "./supabaseJwt.ts";

export type SupabaseAuthBridgeConfig = {
  readonly projectUrl: string;
  readonly audience: string | undefined;
  readonly anonKey: string | undefined;
  readonly serviceRoleSecretName: string | undefined;
};

export type SupabaseIdentity = {
  readonly userId: UserId;
  readonly subject: string;
  readonly email: string | undefined;
  readonly displayName: string;
  readonly avatarUrl: string | undefined;
  readonly provider: string | undefined;
  readonly claims: SupabaseJwtClaims;
};

export type SupabaseTenantSessionInput = {
  readonly authSessionId: AuthSessionId;
  readonly identity: SupabaseIdentity;
  readonly memberships: readonly TenantMembership[];
  readonly tenantId?: TenantId | undefined;
  readonly activeWorkspaceId?: WorkspaceId | null | undefined;
  readonly issuedAt: string;
  readonly expiresAt: string;
};

export class SupabaseAuthBridgeError extends Data.TaggedError("SupabaseAuthBridgeError")<{
  readonly message: string;
  readonly status?: 400 | 401 | 403 | 500;
  readonly cause?: unknown;
}> {}

function normalizeNonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function normalizeConfigValue(value: string | URL | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const normalized = value instanceof URL ? value.toString() : value;
  return normalizeNonEmpty(normalized);
}

function readJsonObjectString(
  value: SupabaseJwtClaims["app_metadata"] | SupabaseJwtClaims["user_metadata"] | undefined,
  key: string,
): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return normalizeNonEmpty(value[key]);
}

export function resolveSupabaseAuthBridgeConfig(
  config: Pick<
    ServerConfigShape,
    | "supabaseAnonKey"
    | "supabaseJwtAudience"
    | "supabaseProjectUrl"
    | "supabaseServiceRoleSecretName"
  >,
): SupabaseAuthBridgeConfig | undefined {
  const projectUrl = normalizeConfigValue(config.supabaseProjectUrl);
  if (!projectUrl) {
    return undefined;
  }
  return {
    projectUrl,
    audience: normalizeNonEmpty(config.supabaseJwtAudience),
    anonKey: normalizeNonEmpty(config.supabaseAnonKey),
    serviceRoleSecretName: normalizeNonEmpty(config.supabaseServiceRoleSecretName),
  };
}

export function requireSupabaseAuthBridgeConfig(
  config: Parameters<typeof resolveSupabaseAuthBridgeConfig>[0],
): SupabaseAuthBridgeConfig {
  const resolved = resolveSupabaseAuthBridgeConfig(config);
  if (!resolved) {
    throw new SupabaseAuthBridgeError({
      message: "Supabase auth is not configured.",
      status: 500,
    });
  }
  return resolved;
}

export function mapSupabaseClaimsToIdentity(claims: SupabaseJwtClaims): SupabaseIdentity {
  const subject = normalizeNonEmpty(claims.sub);
  if (!subject) {
    throw new SupabaseAuthBridgeError({
      message: "Supabase JWT is missing a subject.",
      status: 401,
    });
  }

  const displayName =
    readJsonObjectString(claims.user_metadata, "full_name") ??
    readJsonObjectString(claims.user_metadata, "name") ??
    normalizeNonEmpty(claims.email) ??
    subject;

  return {
    userId: UserId.make(`supabase:${subject}`),
    subject,
    email: normalizeNonEmpty(claims.email),
    displayName,
    avatarUrl: readJsonObjectString(claims.user_metadata, "avatar_url"),
    provider: readJsonObjectString(claims.app_metadata, "provider"),
    claims,
  };
}

export function readSupabaseTenantIdClaim(claims: SupabaseJwtClaims): TenantId | undefined {
  const value =
    readJsonObjectString(claims.app_metadata, "tenant_id") ??
    readJsonObjectString(claims.user_metadata, "tenant_id");
  return value ? TenantId.make(value) : undefined;
}

export function readSupabaseActiveWorkspaceIdClaim(
  claims: SupabaseJwtClaims,
): WorkspaceId | undefined {
  const value =
    readJsonObjectString(claims.app_metadata, "active_workspace_id") ??
    readJsonObjectString(claims.user_metadata, "active_workspace_id");
  return value ? WorkspaceId.make(value) : undefined;
}

function uniqueTenantRoles(
  memberships: readonly TenantMembership[],
): [TenantRole, ...TenantRole[]] {
  const roles = Array.from(new Set(memberships.flatMap((membership) => membership.roles)));
  if (roles.length === 0) {
    throw new SupabaseAuthBridgeError({
      message: "Supabase user has no active tenant roles.",
      status: 403,
    });
  }
  return roles as [TenantRole, ...TenantRole[]];
}

export function mapSupabaseIdentityToTenantSessionContext(
  input: SupabaseTenantSessionInput,
): TenantSessionContext {
  const userMemberships = input.memberships.filter(
    (membership) => membership.userId === input.identity.userId,
  );
  if (userMemberships.length === 0) {
    throw new SupabaseAuthBridgeError({
      message: "Supabase user is not a member of any tenant.",
      status: 403,
    });
  }

  const activeMemberships = userMemberships.filter((membership) => membership.disabledAt === null);
  if (activeMemberships.length === 0) {
    throw new SupabaseAuthBridgeError({
      message: "Supabase user tenant memberships are disabled.",
      status: 403,
    });
  }

  const selectedTenantId = input.tenantId ?? activeMemberships[0]?.tenantId;
  if (!selectedTenantId) {
    throw new SupabaseAuthBridgeError({
      message: "Supabase user is not an active member of any tenant.",
      status: 403,
    });
  }
  const tenantMemberships = activeMemberships.filter(
    (membership) => membership.tenantId === selectedTenantId,
  );
  if (tenantMemberships.length === 0) {
    throw new SupabaseAuthBridgeError({
      message: "Supabase user is not an active member of the requested tenant.",
      status: 403,
    });
  }

  const organizationId = tenantMemberships.find(
    (membership) => membership.organizationId !== null,
  )?.organizationId;

  return {
    authSessionId: input.authSessionId,
    userId: input.identity.userId,
    tenantId: selectedTenantId,
    organizationId: organizationId ?? null,
    membershipIds: tenantMemberships.map((membership) => membership.id),
    roles: uniqueTenantRoles(tenantMemberships),
    activeWorkspaceId: input.activeWorkspaceId ?? null,
    issuedAt: input.issuedAt,
    expiresAt: input.expiresAt,
  };
}

export function authenticateSupabaseBearerToken(input: {
  readonly token: string;
  readonly config: SupabaseAuthBridgeConfig;
  readonly jwks: SupabaseJwks;
  readonly now?: () => Date;
}): SupabaseIdentity {
  const claims = verifySupabaseJwt(input.token, input.jwks, {
    projectUrl: input.config.projectUrl,
    ...(input.config.audience ? { audience: input.config.audience } : {}),
    ...(input.now ? { now: input.now } : {}),
  });
  return mapSupabaseClaimsToIdentity(claims);
}

export async function authenticateSupabaseBearerTokenWithRemoteJwks(input: {
  readonly token: string;
  readonly config: SupabaseAuthBridgeConfig;
  readonly fetchImpl?: Parameters<typeof fetchSupabaseJwks>[1];
  readonly now?: () => Date;
}): Promise<SupabaseIdentity> {
  const jwks = await fetchSupabaseJwks(input.config.projectUrl, input.fetchImpl);
  return authenticateSupabaseBearerToken({
    token: input.token,
    config: input.config,
    jwks,
    ...(input.now ? { now: input.now } : {}),
  });
}
