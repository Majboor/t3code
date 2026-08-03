import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  AuthSessionId,
  MembershipId,
  ProviderAccount,
  ProviderAccountId,
  PublicAccessLimits,
  TenantId,
  TenantMembership,
  TenantRuntimeId,
  TenantRuntimeIsolation,
  UserId,
  Organization,
  OrganizationAccessGrant,
  OrganizationDepartmentId,
  OrganizationId,
  OrganizationTeamId,
  ProviderAccountConnectResult,
  WorkspaceId,
} from "./index.ts";
import { TenantSessionContext } from "./tenancy.ts";

const decodeTenantRuntimeIsolation = Schema.decodeUnknownSync(TenantRuntimeIsolation);
const decodeTenantMembership = Schema.decodeUnknownSync(TenantMembership);
const decodeTenantSessionContext = Schema.decodeUnknownSync(TenantSessionContext);
const decodeProviderAccount = Schema.decodeUnknownSync(ProviderAccount);
const decodeProviderAccountConnectResult = Schema.decodeUnknownSync(ProviderAccountConnectResult);
const decodePublicAccessLimits = Schema.decodeUnknownSync(PublicAccessLimits);
const decodeOrganization = Schema.decodeUnknownSync(Organization);
const decodeOrganizationAccessGrant = Schema.decodeUnknownSync(OrganizationAccessGrant);

describe("tenant contracts", () => {
  it("models runtime isolation as a filesystem and process boundary", () => {
    const parsed = decodeTenantRuntimeIsolation({
      runtimeId: TenantRuntimeId.make("runtime-acme"),
      tenantId: TenantId.make("tenant-acme"),
      strategy: "systemd-per-tenant",
      linuxUser: "t3-tenant-acme",
      baseDir: "/srv/t3/tenants/acme",
      dataDir: "/srv/t3/tenants/acme/userdata",
      secretsDir: "/srv/t3/tenants/acme/secrets",
      attachmentsDir: "/srv/t3/tenants/acme/attachments",
      worktreesDir: "/srv/t3/tenants/acme/worktrees",
      runsDir: "/srv/t3/tenants/acme/runs",
      providerHomesDir: "/srv/t3/tenants/acme/provider-homes",
      internalHost: "127.0.0.1",
      internalPort: 41377,
      status: "running",
      idleShutdownAfterMs: 900_000,
      lastStartedAt: "2026-04-25T02:00:00.000Z",
      lastStoppedAt: null,
    });

    expect(parsed.tenantId).toBe("tenant-acme");
    expect(parsed.strategy).toBe("systemd-per-tenant");
  });

  it("requires at least one role for memberships and tenant sessions", () => {
    expect(() =>
      decodeTenantMembership({
        id: MembershipId.make("membership-1"),
        tenantId: TenantId.make("tenant-acme"),
        userId: UserId.make("user-1"),
        organizationId: null,
        roles: [],
        createdAt: "2026-04-25T02:00:00.000Z",
        disabledAt: null,
      }),
    ).toThrow();

    const parsed = decodeTenantSessionContext({
      authSessionId: AuthSessionId.make("auth-1"),
      userId: UserId.make("user-1"),
      tenantId: TenantId.make("tenant-acme"),
      organizationId: null,
      membershipIds: [MembershipId.make("membership-1")],
      roles: ["developer"],
      activeWorkspaceId: WorkspaceId.make("workspace-1"),
      issuedAt: "2026-04-25T02:00:00.000Z",
      expiresAt: "2026-04-25T10:00:00.000Z",
    });

    expect(parsed.roles).toEqual(["developer"]);
  });

  it("keeps provider account homes tenant-scoped", () => {
    const parsed = decodeProviderAccount({
      id: ProviderAccountId.make("provider-account-1"),
      provider: "codex",
      tenantId: TenantId.make("tenant-acme"),
      owner: {
        type: "user",
        userId: UserId.make("user-1"),
      },
      sharing: "private",
      authHomeDir: "/srv/t3/tenants/acme/provider-homes/user-1/codex",
      configDir: "/srv/t3/tenants/acme/provider-homes/user-1/codex/config",
      secretsDir: "/srv/t3/tenants/acme/secrets/provider-accounts/provider-account-1",
      createdAt: "2026-04-25T02:00:00.000Z",
      disabledAt: null,
    });

    expect(parsed.owner.type).toBe("user");
    expect(parsed.sharing).toBe("private");
  });

  it("models redacted provider account connect instructions", () => {
    const parsed = decodeProviderAccountConnectResult({
      instructions: {
        provider: "codex",
        authCommand: "codex login --device-auth",
        statusCommand: "codex login status",
        verificationHint: "Start a hosted Codex turn after the device-auth flow completes.",
        steps: ["Open a hosted provider shell.", "Run the device-auth command."],
      },
    });

    expect(parsed.instructions.provider).toBe("codex");
    expect(parsed.instructions.authCommand).toBe("codex login --device-auth");
  });

  it("validates public abuse limit shape", () => {
    const parsed = decodePublicAccessLimits({
      maxWebSocketConnectionsPerIp: 60,
      maxWebSocketConnectionsPerUser: 4,
      maxWebSocketConnectionsPerTenant: 40,
      maxRpcRequestsPerMinutePerUser: 120,
      maxRpcRequestsPerMinutePerTenant: 2_000,
      maxRpcRequestBytes: 12 * 1024 * 1024,
      maxFileUploadBytes: 10 * 1024 * 1024,
      maxFileReadBytes: 2 * 1024 * 1024,
      maxDirectoryEntries: 1_000,
      maxDiffBytes: 2 * 1024 * 1024,
      maxActiveTurnsPerUser: 2,
      maxActiveTurnsPerTenant: 20,
      maxActiveProviderSessionsPerUser: 3,
      maxActiveProviderSessionsPerTenant: 30,
      maxProviderConnectFailuresPerUser: 5,
      providerConnectFailureWindowMs: 900_000,
      providerConnectLockoutMs: 900_000,
      maxActiveTenantRuntimesPerMachine: 100,
      maxRuntimeIdleMs: 900_000,
      maxRuntimeWallClockMs: 86_400_000,
    });

    expect(parsed.maxWebSocketConnectionsPerIp).toBe(60);
    expect(parsed.maxActiveTurnsPerTenant).toBe(20);
    expect(parsed.maxProviderConnectFailuresPerUser).toBe(5);
    expect(parsed.maxActiveTenantRuntimesPerMachine).toBe(100);
  });

  it("models organization employees, teams, departments, and scoped access", () => {
    const organization = decodeOrganization({
      id: OrganizationId.make("org-acme"),
      slug: "acme",
      displayName: "Acme",
      createdAt: "2026-04-25T02:00:00.000Z",
      archivedAt: null,
    });

    const membership = decodeTenantMembership({
      id: MembershipId.make("membership-2"),
      tenantId: TenantId.make("tenant-acme"),
      userId: UserId.make("user-2"),
      organizationId: organization.id,
      roles: ["developer"],
      organizationRoles: ["manager"],
      teamIds: [OrganizationTeamId.make("team-platform")],
      departmentId: OrganizationDepartmentId.make("department-eng"),
      createdAt: "2026-04-25T02:00:00.000Z",
      disabledAt: null,
    });

    const grant = decodeOrganizationAccessGrant({
      id: "grant-1",
      organizationId: organization.id,
      membershipId: membership.id,
      scope: { type: "team", teamId: OrganizationTeamId.make("team-platform") },
      roles: ["developer"],
      grantedByUserId: UserId.make("user-owner"),
      createdAt: "2026-04-25T02:00:00.000Z",
      revokedAt: null,
    });

    expect(membership.organizationRoles).toEqual(["manager"]);
    expect(grant.scope.type).toBe("team");
  });
});
