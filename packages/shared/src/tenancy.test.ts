import {
  AuthSessionId,
  OrganizationId,
  ProviderAccountId,
  ProviderSessionId,
  TenantId,
  TenantRuntimeId,
  UserId,
  type ProviderAccount,
  type ProviderSessionIsolation,
  type TenantRuntimeIsolation,
  type TenantSessionContext,
} from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_PUBLIC_ACCESS_LIMITS,
  TENANT_RUNTIME_DIRECTORY_MODE,
  deriveProviderAccountConnectionPlan,
  deriveProviderAccountHomeLayout,
  deriveProviderLaunchEnvironment,
  deriveTenantRuntimeStorageOperationPlan,
  deriveTenantRuntimeSystemdUnit,
  evaluateProviderAccountAccess,
  evaluateTenantRuntimeLifecycle,
  evaluateTenantAccess,
  evaluateTenantUsageLimits,
  findFirstTenantUsageLimitViolation,
  deriveTenantRuntimeDirectoryLayout,
  getOrganizationRolePermissions,
  getTenantRolePermissions,
  hasOrganizationPermission,
  hasTenantPermission,
  validateProviderAccountIsolation,
  validateTenantRuntimeIsolation,
} from "./tenancy.ts";

const limits = DEFAULT_PUBLIC_ACCESS_LIMITS;

const emptyCounters = {
  webSocketConnectionsForIp: 0,
  webSocketConnectionsForUser: 0,
  webSocketConnectionsForTenant: 0,
  rpcRequestsThisMinuteForUser: 0,
  rpcRequestsThisMinuteForTenant: 0,
  activeTurnsForUser: 0,
  activeTurnsForTenant: 0,
  activeProviderSessionsForUser: 0,
  activeProviderSessionsForTenant: 0,
  providerConnectFailuresForUser: 0,
  activeTenantRuntimesForMachine: 0,
} as const;

function makeRuntime(overrides: Partial<TenantRuntimeIsolation> = {}): TenantRuntimeIsolation {
  const layout = deriveTenantRuntimeDirectoryLayout({
    tenantId: "tenant-acme",
    rootDir: "/opt/t3-tenants",
  });
  return {
    runtimeId: TenantRuntimeId.make("runtime-acme"),
    tenantId: TenantId.make("tenant-acme"),
    strategy: "systemd-per-tenant",
    linuxUser: "t3-tenant-acme",
    baseDir: layout.baseDir,
    dataDir: layout.dataDir,
    secretsDir: layout.secretsDir,
    attachmentsDir: layout.attachmentsDir,
    worktreesDir: layout.worktreesDir,
    runsDir: layout.runsDir,
    providerHomesDir: layout.providerHomesDir,
    internalHost: "127.0.0.1",
    internalPort: 4473,
    status: "stopped",
    idleShutdownAfterMs: 900_000,
    lastStartedAt: null,
    lastStoppedAt: null,
    ...overrides,
  };
}

function makeTenantSession(overrides: Partial<TenantSessionContext> = {}): TenantSessionContext {
  return {
    authSessionId: AuthSessionId.make("auth-tenant-acme"),
    userId: UserId.make("user-1"),
    tenantId: TenantId.make("tenant-acme"),
    organizationId: null,
    membershipIds: [],
    roles: ["developer"],
    activeWorkspaceId: null,
    issuedAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2026-01-01T08:00:00.000Z",
    ...overrides,
  };
}

function makeProviderAccount(overrides: Partial<ProviderAccount> = {}): ProviderAccount {
  const layout = deriveTenantRuntimeDirectoryLayout({
    tenantId: "tenant-acme",
    rootDir: "/opt/t3-tenants",
  });
  const accountLayout = deriveProviderAccountHomeLayout({
    runtimeLayout: layout,
    userId: UserId.make("user-1"),
    provider: "codex",
  });

  return {
    id: ProviderAccountId.make("provider-account-1"),
    provider: "codex",
    tenantId: TenantId.make("tenant-acme"),
    owner: {
      type: "user",
      userId: UserId.make("user-1"),
    },
    sharing: "private",
    authHomeDir: accountLayout.providerHomeDir,
    configDir: accountLayout.configDir,
    secretsDir: accountLayout.secretsDir,
    createdAt: "2026-01-01T00:00:00.000Z",
    disabledAt: null,
    ...overrides,
  };
}

function makeProviderSession(
  overrides: Partial<ProviderSessionIsolation> = {},
): ProviderSessionIsolation {
  const account = makeProviderAccount();
  return {
    id: ProviderSessionId.make("provider-session-1"),
    tenantId: TenantId.make("tenant-acme"),
    userId: UserId.make("user-1"),
    providerAccountId: account.id,
    provider: "codex",
    providerHomeDir: account.authHomeDir,
    cwd: "/opt/t3-tenants/tenant-acme/worktrees/project",
    createdAt: "2026-01-01T00:00:00.000Z",
    endedAt: null,
    ...overrides,
  };
}

describe("tenant access control", () => {
  it("maps roles to predictable permission sets", () => {
    expect(getTenantRolePermissions("viewer")).toContain("workspace.view");
    expect(getTenantRolePermissions("viewer")).not.toContain("session.prompt");
    expect(getTenantRolePermissions("developer")).toContain("session.prompt");
    expect(getTenantRolePermissions("platform-operator")).not.toContain("file.read");
  });

  it("allows a permission when any role grants it", () => {
    expect(hasTenantPermission({ roles: ["viewer", "developer"], permission: "file.write" })).toBe(
      true,
    );
    expect(hasTenantPermission({ roles: ["viewer"], permission: "file.write" })).toBe(false);
  });

  it("returns an explainable access decision", () => {
    expect(evaluateTenantAccess({ roles: [], permission: "workspace.view" })).toEqual({
      allowed: false,
      permission: "workspace.view",
      reason: "No tenant role is present in the session context.",
    });

    expect(evaluateTenantAccess({ roles: ["owner"], permission: "runtime.manage" }).allowed).toBe(
      true,
    );
  });
});

describe("organization RBAC", () => {
  it("maps organization roles to employee and audit permissions", () => {
    expect(getOrganizationRolePermissions("viewer")).toEqual(["organization.read"]);
    expect(hasOrganizationPermission({ roles: ["auditor"], permission: "audit.view" })).toBe(true);
    expect(
      hasOrganizationPermission({ roles: ["developer"], permission: "employee.disable" }),
    ).toBe(false);
    expect(hasOrganizationPermission({ roles: ["admin"], permission: "access.grant" })).toBe(true);
    expect(hasOrganizationPermission({ roles: ["owner"], permission: "access.revoke" })).toBe(true);
    expect(hasOrganizationPermission({ roles: ["manager"], permission: "access.revoke" })).toBe(
      false,
    );
  });
});

describe("tenant usage limits", () => {
  it("publishes the initial public access limit policy", () => {
    expect(DEFAULT_PUBLIC_ACCESS_LIMITS).toEqual({
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
  });

  it("allows counters that are below every limit", () => {
    expect(findFirstTenantUsageLimitViolation(emptyCounters, limits)).toBeUndefined();
  });

  it("reports the first exceeded public access limit", () => {
    const checks = evaluateTenantUsageLimits(
      {
        ...emptyCounters,
        webSocketConnectionsForIp: 60,
      },
      limits,
    );

    expect(checks[0]).toEqual({
      allowed: false,
      limit: "webSocketConnectionsForIp",
      current: 60,
      maximum: 60,
    });
    expect(
      findFirstTenantUsageLimitViolation({ ...emptyCounters, activeTurnsForTenant: 20 }, limits),
    ).toMatchObject({
      allowed: false,
      limit: "activeTurnsForTenant",
    });
    expect(
      findFirstTenantUsageLimitViolation(
        { ...emptyCounters, providerConnectFailuresForUser: 5 },
        limits,
      ),
    ).toMatchObject({
      allowed: false,
      limit: "providerConnectFailuresForUser",
    });
    expect(
      findFirstTenantUsageLimitViolation(
        { ...emptyCounters, activeTenantRuntimesForMachine: 100 },
        limits,
      ),
    ).toMatchObject({
      allowed: false,
      limit: "activeTenantRuntimesForMachine",
    });
  });
});

describe("tenant runtime isolation", () => {
  it("derives the v1 tenant directory layout with restrictive directory mode guidance", () => {
    const layout = deriveTenantRuntimeDirectoryLayout({
      tenantId: "tenant:acme-corp",
      rootDir: "/srv/t3-tenants",
    });

    expect(TENANT_RUNTIME_DIRECTORY_MODE).toBe(0o700);
    expect(layout).toEqual({
      baseDir: "/srv/t3-tenants/acme-corp",
      dataDir: "/srv/t3-tenants/acme-corp/data",
      userdataDir: "/srv/t3-tenants/acme-corp/data/userdata",
      secretsDir: "/srv/t3-tenants/acme-corp/data/userdata/secrets",
      attachmentsDir: "/srv/t3-tenants/acme-corp/data/userdata/attachments",
      worktreesDir: "/srv/t3-tenants/acme-corp/worktrees",
      runsDir: "/srv/t3-tenants/acme-corp/runs/default",
      providerHomesDir: "/srv/t3-tenants/acme-corp/provider-homes",
      logsDir: "/srv/t3-tenants/acme-corp/logs",
    });
  });

  it("accepts internal-only non-root runtimes with directories confined to the base dir", () => {
    const layout = deriveTenantRuntimeDirectoryLayout({
      tenantId: "tenant-acme",
      rootDir: "/opt/t3-tenants",
    });

    expect(
      validateTenantRuntimeIsolation({
        runtimeId: TenantRuntimeId.make("runtime-acme"),
        tenantId: TenantId.make("tenant-acme"),
        strategy: "systemd-per-tenant",
        linuxUser: "t3-tenant-acme",
        baseDir: layout.baseDir,
        dataDir: layout.dataDir,
        secretsDir: layout.secretsDir,
        attachmentsDir: layout.attachmentsDir,
        worktreesDir: layout.worktreesDir,
        runsDir: layout.runsDir,
        providerHomesDir: layout.providerHomesDir,
        internalHost: "127.0.0.1",
        internalPort: 4473,
        status: "stopped",
        idleShutdownAfterMs: 900_000,
        lastStartedAt: null,
        lastStoppedAt: null,
      }),
    ).toEqual({
      allowed: true,
      violations: [],
    });
  });

  it("rejects root users, public hosts, and directory escapes", () => {
    const layout = deriveTenantRuntimeDirectoryLayout({
      tenantId: "tenant-acme",
      rootDir: "/opt/t3-tenants",
    });

    expect(
      validateTenantRuntimeIsolation({
        runtimeId: TenantRuntimeId.make("runtime-acme"),
        tenantId: TenantId.make("tenant-acme"),
        strategy: "systemd-per-tenant",
        linuxUser: "root",
        baseDir: layout.baseDir,
        dataDir: layout.dataDir,
        secretsDir: "/etc/t3-secrets",
        attachmentsDir: layout.attachmentsDir,
        worktreesDir: layout.worktreesDir,
        runsDir: "../runs",
        providerHomesDir: layout.providerHomesDir,
        internalHost: "0.0.0.0",
        internalPort: 4473,
        status: "stopped",
        idleShutdownAfterMs: 900_000,
        lastStartedAt: null,
        lastStoppedAt: null,
      }).violations,
    ).toEqual([
      "Tenant runtime must not run as root.",
      "Tenant runtime host must be loopback or private-network only.",
      "secretsDir must stay inside the tenant base directory.",
      "runsDir must be an absolute path.",
    ]);
  });

  it("derives the v1 systemd service template with resource and filesystem guards", () => {
    const layout = deriveTenantRuntimeDirectoryLayout({
      tenantId: "tenant-acme",
      rootDir: "/opt/t3-tenants",
    });
    const unit = deriveTenantRuntimeSystemdUnit({
      runtime: {
        runtimeId: TenantRuntimeId.make("runtime-acme"),
        tenantId: TenantId.make("tenant-acme"),
        strategy: "systemd-per-tenant",
        linuxUser: "t3-tenant-acme",
        baseDir: layout.baseDir,
        dataDir: layout.dataDir,
        secretsDir: layout.secretsDir,
        attachmentsDir: layout.attachmentsDir,
        worktreesDir: layout.worktreesDir,
        runsDir: layout.runsDir,
        providerHomesDir: layout.providerHomesDir,
        internalHost: "127.0.0.1",
        internalPort: 4473,
        status: "stopped",
        idleShutdownAfterMs: 900_000,
        lastStartedAt: null,
        lastStoppedAt: null,
      },
      command: "/usr/local/bin/t3-runtime serve --tenant tenant-acme",
      memoryMax: "3G",
      cpuQuota: "250%",
      tasksMax: 768,
      nofileLimit: 16_384,
    });

    expect(unit.unitName).toBe("t3-tenant-runtime@tenant-acme.service");
    expect(unit.serviceDirectives).toEqual(
      expect.arrayContaining([
        "User=t3-tenant-acme",
        "Group=t3-tenant-acme",
        "WorkingDirectory=/opt/t3-tenants/tenant-acme",
        "ExecStart=/usr/local/bin/t3-runtime serve --tenant tenant-acme",
        "NoNewPrivileges=true",
        "PrivateTmp=true",
        "ProtectSystem=strict",
        "ProtectHome=true",
        "MemoryMax=3G",
        "CPUQuota=250%",
        "TasksMax=768",
        "LimitNOFILE=16384",
        "IPAddressDeny=any",
        "IPAddressAllow=localhost",
        "ReadWritePaths=/opt/t3-tenants/tenant-acme",
        "InaccessiblePaths=/root /home /var/lib/t3/secrets",
      ]),
    );
    expect(unit.unitFile).toContain("[Unit]\nDescription=T3 tenant runtime tenant-acme");
    expect(unit.unitFile).toContain('Environment=T3_RUNTIME_HOST="127.0.0.1"');
    expect(unit.unitFile).toContain("[Install]\nWantedBy=multi-user.target");
  });

  it("plans on-demand start and denies unsafe runtime starts", () => {
    expect(
      evaluateTenantRuntimeLifecycle({
        runtime: makeRuntime(),
        now: "2026-01-01T00:00:00.000Z",
        demand: true,
      }),
    ).toEqual({
      action: "start",
      nextStatus: "starting",
      reason: "Tenant runtime has demand and may start.",
    });

    expect(
      evaluateTenantRuntimeLifecycle({
        runtime: makeRuntime({ linuxUser: "root" }),
        now: "2026-01-01T00:00:00.000Z",
        demand: true,
      }),
    ).toMatchObject({
      action: "deny-start",
      nextStatus: "stopped",
      reason: expect.stringContaining("Tenant runtime must not run as root."),
    });
  });

  it("marks starting runtimes running only after a passing health check", () => {
    expect(
      evaluateTenantRuntimeLifecycle({
        runtime: makeRuntime({ status: "starting" }),
        now: "2026-01-01T00:00:00.000Z",
        healthCheckSucceeded: true,
      }),
    ).toEqual({
      action: "mark-running",
      nextStatus: "running",
      reason: "Tenant runtime health check passed.",
    });
  });

  it("stops idle runtimes and escalates unhealthy runtimes through restart and quarantine", () => {
    const runningRuntime = makeRuntime({
      status: "running",
      lastStartedAt: "2026-01-01T00:00:00.000Z",
    });

    expect(
      evaluateTenantRuntimeLifecycle({
        runtime: runningRuntime,
        now: "2026-01-01T00:16:00.000Z",
        lastActivityAt: "2026-01-01T00:00:00.000Z",
      }),
    ).toEqual({
      action: "stop-idle",
      nextStatus: "stopping",
      reason: "Tenant runtime exceeded its idle shutdown window.",
    });

    expect(
      evaluateTenantRuntimeLifecycle({
        runtime: runningRuntime,
        now: "2026-01-01T00:01:00.000Z",
        healthCheckSucceeded: false,
        consecutiveHealthFailures: 3,
      }),
    ).toEqual({
      action: "restart-unhealthy",
      nextStatus: "stopping",
      reason: "Tenant runtime exceeded the unhealthy restart threshold.",
    });

    expect(
      evaluateTenantRuntimeLifecycle({
        runtime: runningRuntime,
        now: "2026-01-01T00:02:00.000Z",
        healthCheckSucceeded: false,
        consecutiveHealthFailures: 5,
      }),
    ).toEqual({
      action: "quarantine-unhealthy",
      nextStatus: "quarantined",
      reason: "Tenant runtime exceeded the unhealthy quarantine threshold.",
    });
  });

  it("stops runtimes that exceed the wall-clock ceiling", () => {
    const runningRuntime = makeRuntime({
      status: "running",
      lastStartedAt: "2026-01-01T00:00:00.000Z",
    });

    expect(
      evaluateTenantRuntimeLifecycle({
        runtime: runningRuntime,
        now: "2026-01-02T00:00:00.000Z",
      }),
    ).toEqual({
      action: "stop-expired",
      nextStatus: "stopping",
      reason: "Tenant runtime exceeded its wall-clock ceiling.",
    });

    expect(
      evaluateTenantRuntimeLifecycle({
        runtime: runningRuntime,
        now: "2026-01-01T01:00:00.000Z",
        maxWallClockMs: 60 * 60 * 1000,
      }),
    ).toMatchObject({
      action: "stop-expired",
    });
  });

  it("plans tenant backup and export archives from bounded runtime storage paths", () => {
    const layout = deriveTenantRuntimeDirectoryLayout({
      tenantId: "tenant-acme",
      rootDir: "/opt/t3-tenants",
    });
    const backupPlan = deriveTenantRuntimeStorageOperationPlan({
      operation: "backup",
      tenantId: "tenant-acme",
      layout,
      now: "2026-01-01T00:00:00.000Z",
    });

    expect(backupPlan).toMatchObject({
      operation: "backup",
      tenantId: "tenant-acme",
      requiresStoppedRuntime: true,
      destructive: false,
      destinationPaths: ["/var/backups/t3-tenants/tenant-acme-2026-01-01T00-00-00-000Z.tar.zst"],
      auditEvent: "tenant.runtime.backup.planned",
    });
    expect(backupPlan.sourcePaths).toEqual([
      layout.dataDir,
      layout.worktreesDir,
      layout.providerHomesDir,
      layout.logsDir,
    ]);

    const exportPlan = deriveTenantRuntimeStorageOperationPlan({
      operation: "export",
      tenantId: "tenant-acme",
      layout,
      archivePath: "/tmp/tenant-acme-export.tar.zst",
    });

    expect(exportPlan).toMatchObject({
      operation: "export",
      destinationPaths: ["/tmp/tenant-acme-export.tar.zst"],
      auditEvent: "tenant.runtime.export.planned",
    });
    expect(exportPlan.preconditions).toContain(
      "Secrets are included only when the requester has provider management permission.",
    );
  });

  it("plans destructive restore and delete operations with stopped-runtime preconditions", () => {
    const layout = deriveTenantRuntimeDirectoryLayout({
      tenantId: "tenant-acme",
      rootDir: "/opt/t3-tenants",
    });

    expect(
      deriveTenantRuntimeStorageOperationPlan({
        operation: "restore",
        tenantId: "tenant-acme",
        layout,
        archivePath: "/backups/tenant-acme.tar.zst",
      }),
    ).toMatchObject({
      operation: "restore",
      sourcePaths: ["/backups/tenant-acme.tar.zst"],
      destinationPaths: [layout.baseDir],
      requiresStoppedRuntime: true,
      destructive: true,
      auditEvent: "tenant.runtime.restore.planned",
    });

    expect(
      deriveTenantRuntimeStorageOperationPlan({
        operation: "delete",
        tenantId: "tenant-acme",
        layout,
      }),
    ).toMatchObject({
      operation: "delete",
      sourcePaths: [layout.baseDir],
      destinationPaths: [],
      requiresStoppedRuntime: true,
      destructive: true,
      auditEvent: "tenant.runtime.delete.planned",
    });
  });

  it("plans default tenant migration from the legacy single-tenant layout", () => {
    const layout = deriveTenantRuntimeDirectoryLayout({
      tenantId: "tenant-default",
      rootDir: "/opt/t3-tenants",
    });
    const plan = deriveTenantRuntimeStorageOperationPlan({
      operation: "migrate-default-tenant",
      tenantId: "tenant-default",
      layout,
      legacyRootDir: "/srv/t3-legacy",
    });

    expect(plan).toMatchObject({
      operation: "migrate-default-tenant",
      sourcePaths: [
        "/srv/t3-legacy/userdata",
        "/srv/t3-legacy/worktrees",
        "/srv/t3-legacy/provider-homes",
        "/srv/t3-legacy/attachments",
        "/srv/t3-legacy/logs",
      ],
      destinationPaths: [
        layout.userdataDir,
        layout.worktreesDir,
        layout.providerHomesDir,
        layout.attachmentsDir,
        layout.logsDir,
      ],
      requiresStoppedRuntime: true,
      destructive: false,
      auditEvent: "tenant.runtime.default-migration.planned",
    });
    expect(plan.steps).toContain(
      "Apply tenant ownership and 0700 permissions before enabling public signup.",
    );
  });
});

describe("provider account isolation", () => {
  it("plans a fresh private provider account connection with isolated launch env", () => {
    const runtimeLayout = deriveTenantRuntimeDirectoryLayout({
      tenantId: "tenant-acme",
      rootDir: "/opt/t3-tenants",
    });

    const plan = deriveProviderAccountConnectionPlan({
      snapshot: {
        providerAccounts: [],
        providerSessions: [],
      },
      runtimeLayout,
      tenantSession: makeTenantSession(),
      provider: "codex",
      cwd: "/opt/t3-tenants/tenant-acme/worktrees/project",
      now: "2026-01-01T00:00:00.000Z",
      baseEnv: {
        HOME: "/Users/dev",
        OPENAI_API_KEY: "global-openai-key",
        PATH: "/usr/local/bin:/usr/bin",
      },
    });

    expect(plan).toMatchObject({
      allowed: true,
      reason: "Provider account connection is ready for isolated launch.",
      createdAccount: true,
      createdSession: true,
    });
    expect(plan.account).toMatchObject({
      id: "provider-account:tenant-acme:user-1:codex",
      provider: "codex",
      tenantId: "tenant-acme",
      sharing: "private",
      disabledAt: null,
    });
    expect(plan.providerSession).toMatchObject({
      tenantId: "tenant-acme",
      userId: "user-1",
      provider: "codex",
      providerHomeDir: "/opt/t3-tenants/tenant-acme/provider-homes/user-1/codex",
      cwd: "/opt/t3-tenants/tenant-acme/worktrees/project",
      endedAt: null,
    });
    expect(plan.snapshot.providerAccounts).toHaveLength(1);
    expect(plan.snapshot.providerSessions).toHaveLength(1);
    expect(plan.launchEnvironment?.env).toMatchObject({
      CODEX_HOME: "/opt/t3-tenants/tenant-acme/provider-homes/user-1/codex",
      HOME: "/opt/t3-tenants/tenant-acme/provider-homes/user-1/codex",
      PATH: "/usr/local/bin:/usr/bin",
      T3_TENANT_ID: "tenant-acme",
      T3_USER_ID: "user-1",
      XDG_CONFIG_HOME: "/opt/t3-tenants/tenant-acme/provider-homes/user-1/codex/config",
    });
    expect(plan.launchEnvironment?.env.OPENAI_API_KEY).toBeUndefined();
  });

  it("plans an organization-shared provider account connection", () => {
    const runtimeLayout = deriveTenantRuntimeDirectoryLayout({
      tenantId: "tenant-acme",
      rootDir: "/opt/t3-tenants",
    });
    const organizationId = OrganizationId.make("org-acme");

    const plan = deriveProviderAccountConnectionPlan({
      snapshot: {
        providerAccounts: [],
        providerSessions: [],
      },
      runtimeLayout,
      tenantSession: makeTenantSession({ organizationId }),
      provider: "codex",
      cwd: "/opt/t3-tenants/tenant-acme/worktrees/project",
      now: "2026-01-01T00:00:00.000Z",
      accountOwner: { type: "organization", organizationId },
    });

    expect(plan).toMatchObject({
      allowed: true,
      createdAccount: true,
      createdSession: true,
    });
    expect(plan.account).toMatchObject({
      id: "provider-account:tenant-acme:organization-org-acme:codex",
      provider: "codex",
      tenantId: "tenant-acme",
      owner: { type: "organization", organizationId: "org-acme" },
      sharing: "tenant-shared",
      authHomeDir: "/opt/t3-tenants/tenant-acme/provider-homes/organization-org-acme/codex",
    });
    expect(plan.launchEnvironment?.env.CODEX_HOME).toBe(
      "/opt/t3-tenants/tenant-acme/provider-homes/organization-org-acme/codex",
    );
  });

  it("reuses existing active provider account connection records idempotently", () => {
    const runtimeLayout = deriveTenantRuntimeDirectoryLayout({
      tenantId: "tenant-acme",
      rootDir: "/opt/t3-tenants",
    });
    const account = makeProviderAccount();
    const providerSession = makeProviderSession();

    const plan = deriveProviderAccountConnectionPlan({
      snapshot: {
        providerAccounts: [account],
        providerSessions: [providerSession],
      },
      runtimeLayout,
      tenantSession: makeTenantSession(),
      provider: "codex",
      cwd: providerSession.cwd,
      now: "2026-01-01T00:10:00.000Z",
    });

    expect(plan).toMatchObject({
      allowed: true,
      account,
      providerSession,
      createdAccount: false,
      createdSession: false,
    });
    expect(plan.snapshot.providerAccounts).toEqual([account]);
    expect(plan.snapshot.providerSessions).toEqual([providerSession]);
  });

  it("does not create a launchable session for disabled provider accounts", () => {
    const runtimeLayout = deriveTenantRuntimeDirectoryLayout({
      tenantId: "tenant-acme",
      rootDir: "/opt/t3-tenants",
    });
    const disabledAccount = makeProviderAccount({
      disabledAt: "2026-01-01T00:10:00.000Z",
    });

    const plan = deriveProviderAccountConnectionPlan({
      snapshot: {
        providerAccounts: [disabledAccount],
        providerSessions: [],
      },
      runtimeLayout,
      tenantSession: makeTenantSession(),
      provider: "codex",
      cwd: "/opt/t3-tenants/tenant-acme/worktrees/project",
      now: "2026-01-01T00:11:00.000Z",
    });

    expect(plan).toEqual({
      allowed: false,
      reason: "Provider account is disabled.",
      account: disabledAccount,
      providerSession: null,
      snapshot: {
        providerAccounts: [disabledAccount],
        providerSessions: [],
      },
      createdAccount: false,
      createdSession: false,
      launchEnvironment: null,
    });
  });

  it("derives per-user provider homes under tenant runtime storage", () => {
    const runtimeLayout = deriveTenantRuntimeDirectoryLayout({
      tenantId: "tenant-acme",
      rootDir: "/opt/t3-tenants",
    });

    expect(
      deriveProviderAccountHomeLayout({
        runtimeLayout,
        userId: UserId.make("user-1"),
        provider: "codex",
      }),
    ).toEqual({
      providerHomeDir: "/opt/t3-tenants/tenant-acme/provider-homes/user-1/codex",
      configDir: "/opt/t3-tenants/tenant-acme/provider-homes/user-1/codex/config",
      secretsDir:
        "/opt/t3-tenants/tenant-acme/data/userdata/secrets/provider-accounts/user-1/codex",
    });
  });

  it("validates provider account homes and secrets stay outside worktrees", () => {
    const runtimeLayout = deriveTenantRuntimeDirectoryLayout({
      tenantId: "tenant-acme",
      rootDir: "/opt/t3-tenants",
    });

    expect(
      validateProviderAccountIsolation({
        account: makeProviderAccount(),
        runtimeLayout,
      }),
    ).toEqual({ allowed: true, violations: [] });

    expect(
      validateProviderAccountIsolation({
        account: makeProviderAccount({
          authHomeDir: "/tmp/shared-codex",
          configDir: "/opt/t3-tenants/tenant-acme/worktrees/project/.codex",
          secretsDir: "/etc/t3/provider-account",
        }),
        runtimeLayout,
      }).violations,
    ).toEqual([
      "Provider account auth home must stay inside tenant provider homes.",
      "Provider account config dir must stay inside tenant provider homes.",
      "Provider account secrets dir must stay inside tenant secrets.",
    ]);
  });

  it("allows private provider accounts only for the owning user", () => {
    const runtimeLayout = deriveTenantRuntimeDirectoryLayout({
      tenantId: "tenant-acme",
      rootDir: "/opt/t3-tenants",
    });

    expect(
      evaluateProviderAccountAccess({
        account: makeProviderAccount(),
        providerSession: makeProviderSession(),
        tenantSession: makeTenantSession(),
        runtimeLayout,
      }),
    ).toEqual({
      allowed: true,
      reason: "User owns the private provider account.",
    });

    expect(
      evaluateProviderAccountAccess({
        account: makeProviderAccount(),
        providerSession: makeProviderSession({ userId: UserId.make("user-2") }),
        tenantSession: makeTenantSession({ userId: UserId.make("user-2") }),
        runtimeLayout,
      }),
    ).toEqual({
      allowed: false,
      reason: "User does not own this private provider account.",
    });
  });

  it("allows tenant-shared provider accounts and rejects disabled or escaped sessions", () => {
    const runtimeLayout = deriveTenantRuntimeDirectoryLayout({
      tenantId: "tenant-acme",
      rootDir: "/opt/t3-tenants",
    });
    const tenantAccount = makeProviderAccount({
      owner: {
        type: "tenant",
        tenantId: TenantId.make("tenant-acme"),
      },
      sharing: "tenant-shared",
    });

    expect(
      evaluateProviderAccountAccess({
        account: tenantAccount,
        providerSession: makeProviderSession({
          providerAccountId: tenantAccount.id,
          userId: UserId.make("user-2"),
          providerHomeDir: tenantAccount.authHomeDir,
        }),
        tenantSession: makeTenantSession({ userId: UserId.make("user-2") }),
        runtimeLayout,
      }).allowed,
    ).toBe(true);

    expect(
      evaluateProviderAccountAccess({
        account: makeProviderAccount({ disabledAt: "2026-01-01T00:10:00.000Z" }),
        providerSession: makeProviderSession(),
        tenantSession: makeTenantSession(),
        runtimeLayout,
      }),
    ).toEqual({
      allowed: false,
      reason: "Provider account is disabled.",
    });

    expect(
      evaluateProviderAccountAccess({
        account: makeProviderAccount(),
        providerSession: makeProviderSession({
          providerHomeDir: "/opt/t3-tenants/tenant-acme/worktrees/project/.codex",
        }),
        tenantSession: makeTenantSession(),
        runtimeLayout,
      }),
    ).toEqual({
      allowed: false,
      reason: "Provider session home must stay inside the selected provider account home.",
    });
  });

  it("allows organization-shared accounts only for the active organization", () => {
    const runtimeLayout = deriveTenantRuntimeDirectoryLayout({
      tenantId: "tenant-acme",
      rootDir: "/opt/t3-tenants",
    });
    const organizationAccount = makeProviderAccount({
      owner: {
        type: "organization",
        organizationId: OrganizationId.make("org-acme"),
      },
      sharing: "tenant-shared",
    });

    expect(
      evaluateProviderAccountAccess({
        account: organizationAccount,
        providerSession: makeProviderSession({
          providerAccountId: organizationAccount.id,
          providerHomeDir: organizationAccount.authHomeDir,
        }),
        tenantSession: makeTenantSession({ organizationId: OrganizationId.make("org-acme") }),
        runtimeLayout,
      }).allowed,
    ).toBe(true);

    expect(
      evaluateProviderAccountAccess({
        account: organizationAccount,
        providerSession: makeProviderSession({
          providerAccountId: organizationAccount.id,
          providerHomeDir: organizationAccount.authHomeDir,
        }),
        tenantSession: makeTenantSession({ organizationId: OrganizationId.make("org-other") }),
        runtimeLayout,
      }).reason,
    ).toBe("Organization-owned provider account is not shared with the active organization.");
  });

  it("derives isolated Codex launch environment and strips inherited global auth", () => {
    const runtimeLayout = deriveTenantRuntimeDirectoryLayout({
      tenantId: "tenant-acme",
      rootDir: "/opt/t3-tenants",
    });
    const account = makeProviderAccount();
    const providerSession = makeProviderSession();

    const plan = deriveProviderLaunchEnvironment({
      account,
      providerSession,
      tenantSession: makeTenantSession(),
      runtimeLayout,
      baseEnv: {
        CODEX_HOME: "/Users/dev/.codex",
        HOME: "/Users/dev",
        OPENAI_API_KEY: "global-openai-key",
        PATH: "/usr/local/bin:/usr/bin",
      },
    });

    expect(plan).toMatchObject({
      allowed: true,
      provider: "codex",
      cwd: "/opt/t3-tenants/tenant-acme/worktrees/project",
      reason: "Provider launch environment is isolated for the selected Codex account.",
    });
    expect(plan.env).toMatchObject({
      CODEX_HOME: providerSession.providerHomeDir,
      HOME: account.authHomeDir,
      PATH: "/usr/local/bin:/usr/bin",
      T3_PROVIDER_ACCOUNT_ID: account.id,
      T3_PROVIDER_HOME: providerSession.providerHomeDir,
      T3_PROVIDER_SECRETS_DIR: account.secretsDir,
      T3_TENANT_ID: "tenant-acme",
      T3_USER_ID: "user-1",
      XDG_CONFIG_HOME: account.configDir,
    });
    expect(plan.env.OPENAI_API_KEY).toBeUndefined();
  });

  it("derives isolated Claude launch environment without inheriting Anthropic credentials", () => {
    const runtimeLayout = deriveTenantRuntimeDirectoryLayout({
      tenantId: "tenant-acme",
      rootDir: "/opt/t3-tenants",
    });
    const claudeLayout = deriveProviderAccountHomeLayout({
      runtimeLayout,
      userId: UserId.make("user-1"),
      provider: "claudeAgent",
    });
    const account = makeProviderAccount({
      provider: "claudeAgent",
      authHomeDir: claudeLayout.providerHomeDir,
      configDir: claudeLayout.configDir,
      secretsDir: claudeLayout.secretsDir,
    });
    const providerSession = makeProviderSession({
      provider: "claudeAgent",
      providerAccountId: account.id,
      providerHomeDir: account.authHomeDir,
    });

    const plan = deriveProviderLaunchEnvironment({
      account,
      providerSession,
      tenantSession: makeTenantSession(),
      runtimeLayout,
      baseEnv: {
        ANTHROPIC_API_KEY: "global-anthropic-key",
        ANTHROPIC_AUTH_TOKEN: "global-anthropic-token",
        CLAUDE_CONFIG_DIR: "/Users/dev/.claude",
        PATH: "/usr/local/bin:/usr/bin",
      },
    });

    expect(plan).toMatchObject({
      allowed: true,
      provider: "claudeAgent",
      cwd: "/opt/t3-tenants/tenant-acme/worktrees/project",
      reason: "Provider launch environment is isolated for the selected Claude account.",
    });
    expect(plan.env).toMatchObject({
      CLAUDE_CONFIG_DIR: account.configDir,
      HOME: account.authHomeDir,
      PATH: "/usr/local/bin:/usr/bin",
      T3_PROVIDER_ACCOUNT_ID: account.id,
      T3_PROVIDER_HOME: providerSession.providerHomeDir,
      T3_PROVIDER_SECRETS_DIR: account.secretsDir,
      T3_TENANT_ID: "tenant-acme",
      T3_USER_ID: "user-1",
      XDG_CONFIG_HOME: account.configDir,
    });
    expect(plan.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(plan.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
  });

  it("denies provider launch environment derivation when account access fails", () => {
    const runtimeLayout = deriveTenantRuntimeDirectoryLayout({
      tenantId: "tenant-acme",
      rootDir: "/opt/t3-tenants",
    });
    const providerSession = makeProviderSession();

    expect(
      deriveProviderLaunchEnvironment({
        account: makeProviderAccount({ disabledAt: "2026-01-01T00:10:00.000Z" }),
        providerSession,
        tenantSession: makeTenantSession(),
        runtimeLayout,
      }),
    ).toEqual({
      allowed: false,
      cwd: providerSession.cwd,
      env: {},
      provider: "codex",
      reason: "Provider account is disabled.",
      secretEnvKeys: [],
    });
  });
});
