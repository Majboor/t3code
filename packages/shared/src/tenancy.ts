import {
  ProviderAccountId,
  ProviderSessionId,
  type OrganizationPermission,
  type OrganizationRole,
  type ProviderAccount,
  type ProviderAccountId as ProviderAccountIdType,
  type ProviderAccountOwner,
  type ProviderAccountSharing,
  type ProviderKind,
  type ProviderSessionId as ProviderSessionIdType,
  type ProviderSessionIsolation,
  type PublicAccessLimits,
  type TenantSessionContext,
  type TenantRuntimeIsolation,
  type TenantPermission,
  type TenantRole,
  type TenantUsageCounters,
  type UserId,
} from "@t3tools/contracts";
import path from "node:path";

export const TENANT_ROLE_PERMISSIONS = {
  viewer: ["tenant.read", "workspace.view", "project.view", "session.view", "file.read"],
  developer: [
    "tenant.read",
    "workspace.view",
    "workspace.edit",
    "project.view",
    "project.create",
    "project.edit",
    "session.view",
    "session.create",
    "session.prompt",
    "file.read",
    "file.write",
    "file.upload",
    "provider.use",
  ],
  pm: [
    "tenant.read",
    "workspace.view",
    "workspace.edit",
    "workspace.invite",
    "project.view",
    "project.create",
    "project.edit",
    "session.view",
    "session.create",
    "session.prompt",
    "file.read",
    "audit.view",
  ],
  support: [
    "tenant.read",
    "workspace.view",
    "project.view",
    "session.view",
    "file.read",
    "audit.view",
    "support.assist",
  ],
  admin: [
    "tenant.read",
    "tenant.update",
    "workspace.view",
    "workspace.edit",
    "workspace.invite",
    "project.view",
    "project.create",
    "project.edit",
    "session.view",
    "session.create",
    "session.prompt",
    "file.read",
    "file.write",
    "file.upload",
    "provider.use",
    "provider.connect",
    "provider.manage",
    "membership.manage",
    "organization.manage",
    "audit.view",
  ],
  owner: [
    "tenant.read",
    "tenant.update",
    "tenant.quarantine",
    "workspace.view",
    "workspace.edit",
    "workspace.invite",
    "project.view",
    "project.create",
    "project.edit",
    "session.view",
    "session.create",
    "session.prompt",
    "file.read",
    "file.write",
    "file.upload",
    "provider.use",
    "provider.connect",
    "provider.manage",
    "runtime.manage",
    "membership.manage",
    "organization.manage",
    "audit.view",
  ],
  "platform-operator": [
    "tenant.read",
    "tenant.quarantine",
    "runtime.manage",
    "audit.view",
    "platform.operate",
  ],
} as const satisfies Record<TenantRole, readonly TenantPermission[]>;

export const ORGANIZATION_ROLE_PERMISSIONS = {
  viewer: ["organization.read"],
  developer: ["organization.read"],
  pm: ["organization.read", "employee.invite", "access.review"],
  support: ["organization.read", "audit.view"],
  auditor: ["organization.read", "access.review", "audit.view"],
  manager: [
    "organization.read",
    "employee.invite",
    "employee.update",
    "team.manage",
    "department.manage",
    "access.review",
    "audit.view",
  ],
  admin: [
    "organization.read",
    "organization.update",
    "employee.invite",
    "employee.update",
    "employee.disable",
    "team.manage",
    "department.manage",
    "access.grant",
    "access.revoke",
    "access.review",
    "audit.view",
  ],
  owner: [
    "organization.read",
    "organization.update",
    "employee.invite",
    "employee.update",
    "employee.disable",
    "team.manage",
    "department.manage",
    "access.grant",
    "access.revoke",
    "access.review",
    "audit.view",
  ],
} as const satisfies Record<OrganizationRole, readonly OrganizationPermission[]>;

export interface TenantAccessInput {
  readonly roles: readonly TenantRole[];
  readonly permission: TenantPermission;
}

export interface TenantAccessDecision {
  readonly allowed: boolean;
  readonly permission: TenantPermission;
  readonly reason: string;
}

export function getTenantRolePermissions(role: TenantRole): readonly TenantPermission[] {
  return TENANT_ROLE_PERMISSIONS[role];
}

export function getOrganizationRolePermissions(
  role: OrganizationRole,
): readonly OrganizationPermission[] {
  return ORGANIZATION_ROLE_PERMISSIONS[role];
}

export function hasOrganizationPermission(input: {
  readonly roles: readonly OrganizationRole[];
  readonly permission: OrganizationPermission;
}): boolean {
  return input.roles.some((role) =>
    getOrganizationRolePermissions(role).includes(input.permission),
  );
}

export function hasTenantPermission(input: TenantAccessInput): boolean {
  return input.roles.some((role) => getTenantRolePermissions(role).includes(input.permission));
}

export function evaluateTenantAccess(input: TenantAccessInput): TenantAccessDecision {
  if (input.roles.length === 0) {
    return {
      allowed: false,
      permission: input.permission,
      reason: "No tenant role is present in the session context.",
    };
  }

  if (hasTenantPermission(input)) {
    return {
      allowed: true,
      permission: input.permission,
      reason: "At least one tenant role grants the requested permission.",
    };
  }

  return {
    allowed: false,
    permission: input.permission,
    reason: "The tenant roles do not grant the requested permission.",
  };
}

export interface TenantLimitCheck {
  readonly allowed: boolean;
  readonly limit: string;
  readonly current: number;
  readonly maximum: number;
}

export const TENANT_RUNTIME_DIRECTORY_MODE = 0o700;
export const DEFAULT_TENANT_RUNTIME_ROOT_DIR = "/opt/t3-tenants";

export interface TenantRuntimeLayoutInput {
  readonly tenantId: string;
  readonly rootDir?: string;
  readonly runId?: string;
}

export interface TenantRuntimeDirectoryLayout {
  readonly baseDir: string;
  readonly dataDir: string;
  readonly userdataDir: string;
  readonly secretsDir: string;
  readonly attachmentsDir: string;
  readonly worktreesDir: string;
  readonly runsDir: string;
  readonly providerHomesDir: string;
  readonly logsDir: string;
}

export interface TenantRuntimeIsolationValidation {
  readonly allowed: boolean;
  readonly violations: readonly string[];
}

export interface TenantRuntimeSystemdUnitInput {
  readonly runtime: TenantRuntimeIsolation;
  readonly command?: string;
  readonly environment?: Readonly<Record<string, string>>;
  readonly memoryMax?: string;
  readonly cpuQuota?: string;
  readonly tasksMax?: number;
  readonly nofileLimit?: number;
}

export interface TenantRuntimeSystemdUnit {
  readonly unitName: string;
  readonly description: string;
  readonly unitDirectives: readonly string[];
  readonly serviceDirectives: readonly string[];
  readonly installDirectives: readonly string[];
  readonly unitFile: string;
}

export type TenantRuntimeLifecycleAction =
  | "none"
  | "start"
  | "deny-start"
  | "mark-running"
  | "stop-idle"
  | "stop-expired"
  | "restart-unhealthy"
  | "quarantine-unhealthy"
  | "cleanup-stopped";

export interface TenantRuntimeLifecycleInput {
  readonly runtime: TenantRuntimeIsolation;
  readonly now: string;
  readonly demand?: boolean;
  readonly lastActivityAt?: string | null;
  readonly healthCheckSucceeded?: boolean;
  readonly consecutiveHealthFailures?: number;
  readonly maxHealthFailuresBeforeRestart?: number;
  readonly maxHealthFailuresBeforeQuarantine?: number;
  readonly maxWallClockMs?: number;
}

export interface TenantRuntimeLifecycleDecision {
  readonly action: TenantRuntimeLifecycleAction;
  readonly nextStatus: TenantRuntimeIsolation["status"];
  readonly reason: string;
}

export type TenantRuntimeStorageOperation =
  | "backup"
  | "restore"
  | "export"
  | "delete"
  | "migrate-default-tenant";

export interface TenantRuntimeStorageOperationInput {
  readonly operation: TenantRuntimeStorageOperation;
  readonly tenantId: string;
  readonly layout: TenantRuntimeDirectoryLayout;
  readonly now?: string;
  readonly archivePath?: string;
  readonly archiveRootDir?: string;
  readonly legacyRootDir?: string;
}

export interface TenantRuntimeStorageOperationPlan {
  readonly operation: TenantRuntimeStorageOperation;
  readonly tenantId: string;
  readonly title: string;
  readonly sourcePaths: readonly string[];
  readonly destinationPaths: readonly string[];
  readonly requiresStoppedRuntime: boolean;
  readonly destructive: boolean;
  readonly preconditions: readonly string[];
  readonly steps: readonly string[];
  readonly auditEvent: string;
}

export interface ProviderAccountHomeLayoutInput {
  readonly runtimeLayout: TenantRuntimeDirectoryLayout;
  readonly userId: UserId | string;
  readonly provider: ProviderKind;
  readonly accountSegment?: string;
}

export interface ProviderAccountHomeLayout {
  readonly providerHomeDir: string;
  readonly configDir: string;
  readonly secretsDir: string;
}

export interface ProviderAccountIsolationValidation {
  readonly allowed: boolean;
  readonly violations: readonly string[];
}

export interface ProviderAccountAccessDecision {
  readonly allowed: boolean;
  readonly reason: string;
}

export interface ProviderLaunchEnvironmentInput {
  readonly account: ProviderAccount;
  readonly providerSession: ProviderSessionIsolation;
  readonly tenantSession: TenantSessionContext;
  readonly runtimeLayout?: TenantRuntimeDirectoryLayout;
  readonly baseEnv?: Readonly<Record<string, string | undefined>>;
}

export interface ProviderLaunchEnvironmentPlan {
  readonly allowed: boolean;
  readonly reason: string;
  readonly provider: ProviderKind;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly secretEnvKeys: readonly string[];
}

export interface ProviderIsolationSnapshot {
  readonly providerAccounts: readonly ProviderAccount[];
  readonly providerSessions: readonly ProviderSessionIsolation[];
}

export interface ProviderAccountConnectionPlanInput {
  readonly snapshot: ProviderIsolationSnapshot;
  readonly runtimeLayout: TenantRuntimeDirectoryLayout;
  readonly tenantSession: TenantSessionContext;
  readonly provider: ProviderKind;
  readonly cwd: string;
  readonly now: string;
  readonly providerAccountId?: ProviderAccountIdType | string;
  readonly providerSessionId?: ProviderSessionIdType | string;
  readonly accountOwner?: ProviderAccountOwner;
  readonly sharing?: ProviderAccountSharing;
  readonly baseEnv?: Readonly<Record<string, string | undefined>>;
}

export interface ProviderAccountConnectionPlan {
  readonly allowed: boolean;
  readonly reason: string;
  readonly account: ProviderAccount | null;
  readonly providerSession: ProviderSessionIsolation | null;
  readonly snapshot: ProviderIsolationSnapshot;
  readonly createdAccount: boolean;
  readonly createdSession: boolean;
  readonly launchEnvironment: ProviderLaunchEnvironmentPlan | null;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);
const DEFAULT_TENANT_RUNTIME_COMMAND = "/usr/local/bin/t3-runtime serve";
const DEFAULT_TENANT_RUNTIME_MEMORY_MAX = "2G";
const DEFAULT_TENANT_RUNTIME_CPU_QUOTA = "200%";
const DEFAULT_TENANT_RUNTIME_TASKS_MAX = 512;
const DEFAULT_TENANT_RUNTIME_NOFILE_LIMIT = 8192;
const DEFAULT_TENANT_RUNTIME_RESTART_FAILURES = 3;
const DEFAULT_TENANT_RUNTIME_QUARANTINE_FAILURES = 5;
const DEFAULT_TENANT_RUNTIME_ARCHIVE_ROOT_DIR = "/var/backups/t3-tenants";
const DEFAULT_SINGLE_TENANT_LEGACY_ROOT_DIR = "/var/lib/t3";

export function deriveTenantRuntimeDirectoryLayout(
  input: TenantRuntimeLayoutInput,
): TenantRuntimeDirectoryLayout {
  const tenantSegment = sanitizeTenantPathSegment(input.tenantId);
  const runSegment = sanitizeTenantPathSegment(input.runId ?? "default");
  const rootDir = normalizeRuntimePath(input.rootDir ?? DEFAULT_TENANT_RUNTIME_ROOT_DIR);
  const baseDir = path.posix.join(rootDir, tenantSegment);
  const userdataDir = path.posix.join(baseDir, "data", "userdata");

  return {
    baseDir,
    dataDir: path.posix.join(baseDir, "data"),
    userdataDir,
    secretsDir: path.posix.join(userdataDir, "secrets"),
    attachmentsDir: path.posix.join(userdataDir, "attachments"),
    worktreesDir: path.posix.join(baseDir, "worktrees"),
    runsDir: path.posix.join(baseDir, "runs", runSegment),
    providerHomesDir: path.posix.join(baseDir, "provider-homes"),
    logsDir: path.posix.join(baseDir, "logs"),
  };
}

export function validateTenantRuntimeIsolation(
  runtime: TenantRuntimeIsolation,
): TenantRuntimeIsolationValidation {
  const violations: string[] = [];
  const baseDir = normalizeRuntimePath(runtime.baseDir);

  if (runtime.linuxUser === "root") {
    violations.push("Tenant runtime must not run as root.");
  }
  if (!isInternalTenantRuntimeHost(runtime.internalHost)) {
    violations.push("Tenant runtime host must be loopback or private-network only.");
  }

  for (const [label, runtimePath] of runtimeIsolationPathEntries(runtime)) {
    const normalizedPath = normalizeRuntimePath(runtimePath);
    if (!path.posix.isAbsolute(normalizedPath)) {
      violations.push(`${label} must be an absolute path.`);
      continue;
    }
    if (label !== "baseDir" && !isPathInside(baseDir, normalizedPath)) {
      violations.push(`${label} must stay inside the tenant base directory.`);
    }
  }

  return {
    allowed: violations.length === 0,
    violations,
  };
}

export function deriveTenantRuntimeSystemdUnit(
  input: TenantRuntimeSystemdUnitInput,
): TenantRuntimeSystemdUnit {
  const runtime = input.runtime;
  const unitName = `t3-tenant-runtime@${sanitizeSystemdInstance(runtime.tenantId)}.service`;
  const description = `T3 tenant runtime ${runtime.tenantId}`;
  const environment = {
    T3_TENANT_ID: runtime.tenantId,
    T3_RUNTIME_ID: runtime.runtimeId,
    T3_RUNTIME_HOST: runtime.internalHost,
    T3_RUNTIME_PORT: String(runtime.internalPort),
    T3_RUNTIME_BASE_DIR: runtime.baseDir,
    T3_RUNTIME_DATA_DIR: runtime.dataDir,
    T3_RUNTIME_SECRETS_DIR: runtime.secretsDir,
    T3_RUNTIME_ATTACHMENTS_DIR: runtime.attachmentsDir,
    T3_RUNTIME_WORKTREES_DIR: runtime.worktreesDir,
    T3_RUNTIME_RUNS_DIR: runtime.runsDir,
    T3_RUNTIME_PROVIDER_HOMES_DIR: runtime.providerHomesDir,
    ...input.environment,
  };
  const environmentDirectives = Object.entries(environment)
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `Environment=${key}=${quoteSystemdValue(value)}`);

  const unitDirectives = [
    `[Unit]`,
    `Description=${description}`,
    `After=network-online.target`,
    `Wants=network-online.target`,
  ];
  const serviceDirectives = [
    `[Service]`,
    `Type=simple`,
    `User=${runtime.linuxUser}`,
    `Group=${runtime.linuxUser}`,
    `WorkingDirectory=${runtime.baseDir}`,
    ...environmentDirectives,
    `ExecStart=${input.command ?? DEFAULT_TENANT_RUNTIME_COMMAND}`,
    `Restart=on-failure`,
    `RestartSec=5s`,
    `TimeoutStopSec=30s`,
    `KillMode=mixed`,
    `NoNewPrivileges=true`,
    `PrivateTmp=true`,
    `ProtectSystem=strict`,
    `ProtectHome=true`,
    `MemoryMax=${input.memoryMax ?? DEFAULT_TENANT_RUNTIME_MEMORY_MAX}`,
    `CPUQuota=${input.cpuQuota ?? DEFAULT_TENANT_RUNTIME_CPU_QUOTA}`,
    `TasksMax=${input.tasksMax ?? DEFAULT_TENANT_RUNTIME_TASKS_MAX}`,
    `LimitNOFILE=${input.nofileLimit ?? DEFAULT_TENANT_RUNTIME_NOFILE_LIMIT}`,
    `IPAddressDeny=any`,
    ...tenantRuntimeSystemdNetworkAllowDirectives(runtime.internalHost),
    `ReadWritePaths=${runtime.baseDir}`,
    `InaccessiblePaths=/root /home /var/lib/t3/secrets`,
  ];
  const installDirectives = [`[Install]`, `WantedBy=multi-user.target`];
  const unitFile = [...unitDirectives, "", ...serviceDirectives, "", ...installDirectives, ""].join(
    "\n",
  );

  return {
    unitName,
    description,
    unitDirectives,
    serviceDirectives,
    installDirectives,
    unitFile,
  };
}

export function evaluateTenantRuntimeLifecycle(
  input: TenantRuntimeLifecycleInput,
): TenantRuntimeLifecycleDecision {
  const runtime = input.runtime;
  if (runtime.status === "quarantined") {
    return lifecycleDecision("none", "quarantined", "Tenant runtime is quarantined.");
  }

  if (runtime.status === "stopped") {
    if (!input.demand) {
      return lifecycleDecision("none", "stopped", "Tenant runtime is stopped and has no demand.");
    }

    const validation = validateTenantRuntimeIsolation(runtime);
    if (!validation.allowed) {
      return lifecycleDecision(
        "deny-start",
        "stopped",
        `Tenant runtime start denied: ${validation.violations.join(" ")}`,
      );
    }

    return lifecycleDecision("start", "starting", "Tenant runtime has demand and may start.");
  }

  if (runtime.status === "starting" && input.healthCheckSucceeded === true) {
    return lifecycleDecision("mark-running", "running", "Tenant runtime health check passed.");
  }

  if (runtime.status === "running") {
    const healthFailureDecision = evaluateRuntimeHealthFailure(input);
    if (healthFailureDecision !== undefined) {
      return healthFailureDecision;
    }

    if (isRuntimeIdle(input)) {
      return lifecycleDecision(
        "stop-idle",
        "stopping",
        "Tenant runtime exceeded its idle shutdown window.",
      );
    }

    if (isRuntimeWallClockExpired(input)) {
      return lifecycleDecision(
        "stop-expired",
        "stopping",
        "Tenant runtime exceeded its wall-clock ceiling.",
      );
    }
  }

  if (runtime.status === "stopping" && runtime.lastStoppedAt !== null) {
    return lifecycleDecision("cleanup-stopped", "stopped", "Tenant runtime stop completed.");
  }

  return lifecycleDecision("none", runtime.status, "No tenant runtime lifecycle action is needed.");
}

export function deriveTenantRuntimeStorageOperationPlan(
  input: TenantRuntimeStorageOperationInput,
): TenantRuntimeStorageOperationPlan {
  const tenantSegment = sanitizeTenantPathSegment(input.tenantId);
  const archivePath = deriveTenantRuntimeArchivePath(input, tenantSegment);

  switch (input.operation) {
    case "backup":
      return {
        operation: input.operation,
        tenantId: input.tenantId,
        title: `Back up tenant ${input.tenantId}`,
        sourcePaths: tenantRuntimeStoragePaths(input.layout),
        destinationPaths: [archivePath],
        requiresStoppedRuntime: true,
        destructive: false,
        preconditions: [
          "Tenant runtime is stopped or quiesced.",
          "Latest tenant database checkpoint is flushed.",
          "Backup destination is outside the tenant base directory.",
        ],
        steps: [
          "Create a compressed archive from the tenant runtime storage paths.",
          "Record archive checksum, size, tenant id, and created-at metadata.",
          "Store the manifest beside the archive for restore validation.",
        ],
        auditEvent: "tenant.runtime.backup.planned",
      };
    case "export":
      return {
        operation: input.operation,
        tenantId: input.tenantId,
        title: `Export tenant ${input.tenantId}`,
        sourcePaths: tenantRuntimeStoragePaths(input.layout),
        destinationPaths: [archivePath],
        requiresStoppedRuntime: true,
        destructive: false,
        preconditions: [
          "Tenant runtime is stopped or quiesced.",
          "Export request is authorized for tenant data access.",
          "Secrets are included only when the requester has provider management permission.",
        ],
        steps: [
          "Create a portable tenant archive from the runtime storage paths.",
          "Include a manifest with tenant id, layout version, and secret-inclusion policy.",
          "Return the export archive through an authenticated control-plane download.",
        ],
        auditEvent: "tenant.runtime.export.planned",
      };
    case "restore":
      return {
        operation: input.operation,
        tenantId: input.tenantId,
        title: `Restore tenant ${input.tenantId}`,
        sourcePaths: [archivePath],
        destinationPaths: [input.layout.baseDir],
        requiresStoppedRuntime: true,
        destructive: true,
        preconditions: [
          "Tenant runtime is stopped.",
          "Archive checksum and tenant manifest are verified.",
          "Existing tenant storage is snapshotted before replacement.",
        ],
        steps: [
          "Extract the verified archive into a temporary restore directory.",
          "Validate restored paths remain inside the tenant base directory.",
          "Atomically replace tenant storage and re-apply tenant ownership and 0700 permissions.",
        ],
        auditEvent: "tenant.runtime.restore.planned",
      };
    case "delete":
      return {
        operation: input.operation,
        tenantId: input.tenantId,
        title: `Delete tenant ${input.tenantId}`,
        sourcePaths: [input.layout.baseDir],
        destinationPaths: [],
        requiresStoppedRuntime: true,
        destructive: true,
        preconditions: [
          "Tenant runtime is stopped.",
          "Tenant deletion has passed retention and confirmation policy.",
          "A final backup or explicit backup waiver has been recorded.",
        ],
        steps: [
          "Disable future runtime starts for the tenant.",
          "Remove tenant runtime storage under the tenant base directory only.",
          "Record a deletion audit event with manifest and final backup reference.",
        ],
        auditEvent: "tenant.runtime.delete.planned",
      };
    case "migrate-default-tenant": {
      const legacyRootDir = normalizeRuntimePath(
        input.legacyRootDir ?? DEFAULT_SINGLE_TENANT_LEGACY_ROOT_DIR,
      );
      return {
        operation: input.operation,
        tenantId: input.tenantId,
        title: `Migrate single-tenant install into ${input.tenantId}`,
        sourcePaths: [
          path.posix.join(legacyRootDir, "userdata"),
          path.posix.join(legacyRootDir, "worktrees"),
          path.posix.join(legacyRootDir, "provider-homes"),
          path.posix.join(legacyRootDir, "attachments"),
          path.posix.join(legacyRootDir, "logs"),
        ],
        destinationPaths: [
          input.layout.userdataDir,
          input.layout.worktreesDir,
          input.layout.providerHomesDir,
          input.layout.attachmentsDir,
          input.layout.logsDir,
        ],
        requiresStoppedRuntime: true,
        destructive: false,
        preconditions: [
          "Current single-tenant runtime is stopped.",
          "Default tenant record and tenant Linux user already exist.",
          "A full pre-migration backup has completed.",
        ],
        steps: [
          "Copy legacy userdata, worktrees, provider homes, attachments, and logs into the generated default tenant layout.",
          "Rewrite runtime configuration to point at the default tenant base directory.",
          "Apply tenant ownership and 0700 permissions before enabling public signup.",
        ],
        auditEvent: "tenant.runtime.default-migration.planned",
      };
    }
  }
}

export function deriveProviderAccountHomeLayout(
  input: ProviderAccountHomeLayoutInput,
): ProviderAccountHomeLayout {
  const userSegment = sanitizeTenantPathSegment(input.accountSegment ?? input.userId);
  const providerSegment = sanitizeTenantPathSegment(input.provider);
  const providerHomeDir = path.posix.join(
    input.runtimeLayout.providerHomesDir,
    userSegment,
    providerSegment,
  );

  return {
    providerHomeDir,
    configDir: path.posix.join(providerHomeDir, "config"),
    secretsDir: path.posix.join(
      input.runtimeLayout.secretsDir,
      "provider-accounts",
      userSegment,
      providerSegment,
    ),
  };
}

export function deriveProviderAccountConnectionPlan(
  input: ProviderAccountConnectionPlanInput,
): ProviderAccountConnectionPlan {
  const cwd = normalizeRuntimePath(input.cwd);
  const existingAccount = findProviderAccountForConnection(input);
  if (existingAccount?.disabledAt !== null && existingAccount !== undefined) {
    return {
      allowed: false,
      reason: "Provider account is disabled.",
      account: existingAccount,
      providerSession: null,
      snapshot: input.snapshot,
      createdAccount: false,
      createdSession: false,
      launchEnvironment: null,
    };
  }

  const account =
    existingAccount ??
    createProviderAccount({
      runtimeLayout: input.runtimeLayout,
      tenantSession: input.tenantSession,
      provider: input.provider,
      now: input.now,
      ...(input.providerAccountId === undefined
        ? {}
        : { providerAccountId: input.providerAccountId }),
      ...(input.accountOwner === undefined ? {} : { accountOwner: input.accountOwner }),
      ...(input.sharing === undefined ? {} : { sharing: input.sharing }),
    });
  const existingSession = findActiveProviderSessionForConnection({
    snapshot: input.snapshot,
    account,
    tenantSession: input.tenantSession,
    provider: input.provider,
    cwd,
    ...(input.providerSessionId === undefined
      ? {}
      : { providerSessionId: input.providerSessionId }),
  });
  const providerSession =
    existingSession ??
    createProviderSessionIsolation({
      account,
      tenantSession: input.tenantSession,
      provider: input.provider,
      cwd,
      now: input.now,
      ...(input.providerSessionId === undefined
        ? {}
        : { providerSessionId: input.providerSessionId }),
    });

  const launchEnvironment = deriveProviderLaunchEnvironment({
    account,
    providerSession,
    tenantSession: input.tenantSession,
    runtimeLayout: input.runtimeLayout,
    ...(input.baseEnv === undefined ? {} : { baseEnv: input.baseEnv }),
  });
  if (!launchEnvironment.allowed) {
    return {
      allowed: false,
      reason: launchEnvironment.reason,
      account,
      providerSession,
      snapshot: input.snapshot,
      createdAccount: false,
      createdSession: false,
      launchEnvironment,
    };
  }

  return {
    allowed: true,
    reason: "Provider account connection is ready for isolated launch.",
    account,
    providerSession,
    snapshot: upsertProviderIsolationSnapshot({
      snapshot: input.snapshot,
      account,
      providerSession,
    }),
    createdAccount: existingAccount === undefined,
    createdSession: existingSession === undefined,
    launchEnvironment,
  };
}

export function validateProviderAccountIsolation(input: {
  readonly account: ProviderAccount;
  readonly runtimeLayout: TenantRuntimeDirectoryLayout;
}): ProviderAccountIsolationValidation {
  const violations: string[] = [];
  const account = input.account;
  if (
    !isPathInside(input.runtimeLayout.providerHomesDir, normalizeRuntimePath(account.authHomeDir))
  ) {
    violations.push("Provider account auth home must stay inside tenant provider homes.");
  }
  if (
    !isPathInside(input.runtimeLayout.providerHomesDir, normalizeRuntimePath(account.configDir))
  ) {
    violations.push("Provider account config dir must stay inside tenant provider homes.");
  }
  if (!isPathInside(input.runtimeLayout.secretsDir, normalizeRuntimePath(account.secretsDir))) {
    violations.push("Provider account secrets dir must stay inside tenant secrets.");
  }

  return {
    allowed: violations.length === 0,
    violations,
  };
}

export function evaluateProviderAccountAccess(input: {
  readonly account: ProviderAccount;
  readonly providerSession: ProviderSessionIsolation;
  readonly tenantSession: TenantSessionContext;
  readonly runtimeLayout?: TenantRuntimeDirectoryLayout;
}): ProviderAccountAccessDecision {
  const { account, providerSession, tenantSession } = input;
  if (account.disabledAt !== null) {
    return providerAccountAccessDecision(false, "Provider account is disabled.");
  }
  if (account.id !== providerSession.providerAccountId) {
    return providerAccountAccessDecision(false, "Provider session references a different account.");
  }
  if (
    account.tenantId !== tenantSession.tenantId ||
    providerSession.tenantId !== tenantSession.tenantId
  ) {
    return providerAccountAccessDecision(
      false,
      "Provider account and session must match the active tenant.",
    );
  }
  if (providerSession.provider !== account.provider) {
    return providerAccountAccessDecision(
      false,
      "Provider session provider must match the account provider.",
    );
  }
  if (input.runtimeLayout !== undefined) {
    const validation = validateProviderAccountIsolation({
      account,
      runtimeLayout: input.runtimeLayout,
    });
    if (!validation.allowed) {
      return providerAccountAccessDecision(
        false,
        `Provider account isolation is invalid: ${validation.violations.join(" ")}`,
      );
    }
    if (
      !isPathAtOrInside(account.authHomeDir, normalizeRuntimePath(providerSession.providerHomeDir))
    ) {
      return providerAccountAccessDecision(
        false,
        "Provider session home must stay inside the selected provider account home.",
      );
    }
    if (
      isPathAtOrInside(
        input.runtimeLayout.worktreesDir,
        normalizeRuntimePath(providerSession.providerHomeDir),
      )
    ) {
      return providerAccountAccessDecision(
        false,
        "Provider session home must not be inside tenant worktrees.",
      );
    }
  }

  switch (account.owner.type) {
    case "user":
      if (
        account.owner.userId === tenantSession.userId &&
        providerSession.userId === tenantSession.userId
      ) {
        return providerAccountAccessDecision(true, "User owns the private provider account.");
      }
      return providerAccountAccessDecision(
        false,
        "User does not own this private provider account.",
      );
    case "tenant":
      if (
        account.sharing === "tenant-shared" &&
        account.owner.tenantId === tenantSession.tenantId
      ) {
        return providerAccountAccessDecision(true, "Provider account is shared with the tenant.");
      }
      return providerAccountAccessDecision(false, "Tenant-owned provider account is not shared.");
    case "organization":
      if (
        account.sharing === "tenant-shared" &&
        tenantSession.organizationId !== null &&
        account.owner.organizationId === tenantSession.organizationId
      ) {
        return providerAccountAccessDecision(
          true,
          "Provider account is shared with the active organization.",
        );
      }
      return providerAccountAccessDecision(
        false,
        "Organization-owned provider account is not shared with the active organization.",
      );
  }
}

export function deriveProviderLaunchEnvironment(
  input: ProviderLaunchEnvironmentInput,
): ProviderLaunchEnvironmentPlan {
  const access = evaluateProviderAccountAccess(input);
  if (!access.allowed) {
    return {
      allowed: false,
      reason: access.reason,
      provider: input.account.provider,
      cwd: input.providerSession.cwd,
      env: {},
      secretEnvKeys: [],
    };
  }

  const baseEnv = filterProviderLaunchBaseEnv(input.baseEnv ?? {});
  const commonEnv = {
    ...baseEnv,
    HOME: input.account.authHomeDir,
    T3_TENANT_ID: input.tenantSession.tenantId,
    T3_USER_ID: input.tenantSession.userId,
    T3_PROVIDER_ACCOUNT_ID: input.account.id,
    T3_PROVIDER_HOME: input.providerSession.providerHomeDir,
    T3_PROVIDER_SECRETS_DIR: input.account.secretsDir,
  };

  switch (input.account.provider) {
    case "codex":
      return {
        allowed: true,
        reason: "Provider launch environment is isolated for the selected Codex account.",
        provider: input.account.provider,
        cwd: input.providerSession.cwd,
        env: {
          ...commonEnv,
          CODEX_HOME: input.providerSession.providerHomeDir,
          XDG_CONFIG_HOME: input.account.configDir,
        },
        secretEnvKeys: [],
      };
    case "claudeAgent":
      return {
        allowed: true,
        reason: "Provider launch environment is isolated for the selected Claude account.",
        provider: input.account.provider,
        cwd: input.providerSession.cwd,
        env: {
          ...commonEnv,
          CLAUDE_CONFIG_DIR: input.account.configDir,
          XDG_CONFIG_HOME: input.account.configDir,
        },
        secretEnvKeys: [],
      };
  }
}

export function isInternalTenantRuntimeHost(host: string): boolean {
  const normalizedHost = host
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, "$1");
  if (LOOPBACK_HOSTS.has(normalizedHost)) {
    return true;
  }
  if (normalizedHost.startsWith("10.")) {
    return true;
  }
  if (normalizedHost.startsWith("192.168.")) {
    return true;
  }
  const secondIpv4Octet = Number(normalizedHost.split(".")[1]);
  if (normalizedHost.startsWith("172.") && secondIpv4Octet >= 16 && secondIpv4Octet <= 31) {
    return true;
  }
  return normalizedHost.startsWith("fc") || normalizedHost.startsWith("fd");
}

export const DEFAULT_PUBLIC_ACCESS_LIMITS = {
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
  providerConnectFailureWindowMs: 15 * 60 * 1000,
  providerConnectLockoutMs: 15 * 60 * 1000,
  maxActiveTenantRuntimesPerMachine: 100,
  maxRuntimeIdleMs: 15 * 60 * 1000,
  maxRuntimeWallClockMs: 24 * 60 * 60 * 1000,
} as const satisfies PublicAccessLimits;

function sanitizeTenantPathSegment(value: string): string {
  const sanitized = value
    .trim()
    .replace(/^tenant:/, "")
    .replace(/^runtime:/, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return sanitized || "default";
}

function sanitizeSystemdInstance(value: string): string {
  return sanitizeTenantPathSegment(value).replaceAll(".", "-");
}

function quoteSystemdValue(value: string): string {
  return JSON.stringify(value);
}

function tenantRuntimeSystemdNetworkAllowDirectives(host: string): readonly string[] {
  const normalizedHost = host
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, "$1");
  if (LOOPBACK_HOSTS.has(normalizedHost)) {
    return ["IPAddressAllow=localhost"];
  }
  if (normalizedHost.startsWith("10.")) {
    return ["IPAddressAllow=10.0.0.0/8"];
  }
  if (normalizedHost.startsWith("192.168.")) {
    return ["IPAddressAllow=192.168.0.0/16"];
  }
  const secondIpv4Octet = Number(normalizedHost.split(".")[1]);
  if (normalizedHost.startsWith("172.") && secondIpv4Octet >= 16 && secondIpv4Octet <= 31) {
    return ["IPAddressAllow=172.16.0.0/12"];
  }
  if (normalizedHost.startsWith("fc") || normalizedHost.startsWith("fd")) {
    return ["IPAddressAllow=fc00::/7"];
  }
  return [];
}

function lifecycleDecision(
  action: TenantRuntimeLifecycleAction,
  nextStatus: TenantRuntimeIsolation["status"],
  reason: string,
): TenantRuntimeLifecycleDecision {
  return {
    action,
    nextStatus,
    reason,
  };
}

function deriveTenantRuntimeArchivePath(
  input: TenantRuntimeStorageOperationInput,
  tenantSegment: string,
): string {
  if (input.archivePath !== undefined) {
    return normalizeRuntimePath(input.archivePath);
  }
  const archiveRootDir = normalizeRuntimePath(
    input.archiveRootDir ?? DEFAULT_TENANT_RUNTIME_ARCHIVE_ROOT_DIR,
  );
  const timestamp = sanitizeTenantPathSegment(input.now ?? "manual").replaceAll(".", "-");
  return path.posix.join(archiveRootDir, `${tenantSegment}-${timestamp}.tar.zst`);
}

function tenantRuntimeStoragePaths(layout: TenantRuntimeDirectoryLayout): readonly string[] {
  return [layout.dataDir, layout.worktreesDir, layout.providerHomesDir, layout.logsDir];
}

function providerAccountAccessDecision(
  allowed: boolean,
  reason: string,
): ProviderAccountAccessDecision {
  return {
    allowed,
    reason,
  };
}

function findProviderAccountForConnection(
  input: ProviderAccountConnectionPlanInput,
): ProviderAccount | undefined {
  if (input.providerAccountId !== undefined) {
    const providerAccountId = ProviderAccountId.make(input.providerAccountId);
    return input.snapshot.providerAccounts.find((account) => account.id === providerAccountId);
  }

  const owner = resolveProviderAccountOwner(input);
  const sharing = resolveProviderAccountSharing(input, owner);
  return input.snapshot.providerAccounts.find(
    (account) =>
      account.provider === input.provider &&
      account.tenantId === input.tenantSession.tenantId &&
      providerAccountOwnerEquals(account.owner, owner) &&
      account.sharing === sharing,
  );
}

function createProviderAccount(input: {
  readonly runtimeLayout: TenantRuntimeDirectoryLayout;
  readonly tenantSession: TenantSessionContext;
  readonly provider: ProviderKind;
  readonly now: string;
  readonly providerAccountId?: ProviderAccountIdType | string;
  readonly accountOwner?: ProviderAccountOwner;
  readonly sharing?: ProviderAccountSharing;
}): ProviderAccount {
  const owner = resolveProviderAccountOwner(input);
  const sharing = resolveProviderAccountSharing(input, owner);
  const ownerSegment = providerAccountOwnerPathSegment(owner);
  const accountLayout = deriveProviderAccountHomeLayout({
    runtimeLayout: input.runtimeLayout,
    userId: input.tenantSession.userId,
    provider: input.provider,
    accountSegment: ownerSegment,
  });

  return {
    id: ProviderAccountId.make(
      input.providerAccountId ??
        `provider-account:${input.tenantSession.tenantId}:${ownerSegment}:${input.provider}`,
    ),
    provider: input.provider,
    tenantId: input.tenantSession.tenantId,
    owner,
    sharing,
    authHomeDir: accountLayout.providerHomeDir,
    configDir: accountLayout.configDir,
    secretsDir: accountLayout.secretsDir,
    createdAt: input.now,
    disabledAt: null,
  };
}

function resolveProviderAccountOwner(input: {
  readonly tenantSession: TenantSessionContext;
  readonly accountOwner?: ProviderAccountOwner;
}): ProviderAccountOwner {
  return input.accountOwner ?? { type: "user", userId: input.tenantSession.userId };
}

function resolveProviderAccountSharing(
  input: { readonly sharing?: ProviderAccountSharing },
  owner: ProviderAccountOwner,
): ProviderAccountSharing {
  return input.sharing ?? (owner.type === "user" ? "private" : "tenant-shared");
}

function providerAccountOwnerEquals(left: ProviderAccountOwner, right: ProviderAccountOwner) {
  switch (left.type) {
    case "user":
      return right.type === "user" && right.userId === left.userId;
    case "tenant":
      return right.type === "tenant" && right.tenantId === left.tenantId;
    case "organization":
      return right.type === "organization" && right.organizationId === left.organizationId;
  }
}

function providerAccountOwnerPathSegment(owner: ProviderAccountOwner): string {
  switch (owner.type) {
    case "user":
      return owner.userId;
    case "tenant":
      return `tenant-${owner.tenantId}`;
    case "organization":
      return `organization-${owner.organizationId}`;
  }
}

function findActiveProviderSessionForConnection(input: {
  readonly snapshot: ProviderIsolationSnapshot;
  readonly account: ProviderAccount;
  readonly tenantSession: TenantSessionContext;
  readonly provider: ProviderKind;
  readonly cwd: string;
  readonly providerSessionId?: ProviderSessionIdType | string;
}): ProviderSessionIsolation | undefined {
  if (input.providerSessionId !== undefined) {
    const providerSessionId = ProviderSessionId.make(input.providerSessionId);
    return input.snapshot.providerSessions.find(
      (providerSession) =>
        providerSession.id === providerSessionId &&
        providerSession.endedAt === null &&
        providerSession.providerAccountId === input.account.id &&
        providerSession.provider === input.provider &&
        providerSession.tenantId === input.tenantSession.tenantId &&
        providerSession.userId === input.tenantSession.userId,
    );
  }

  return input.snapshot.providerSessions.find(
    (providerSession) =>
      providerSession.endedAt === null &&
      providerSession.providerAccountId === input.account.id &&
      providerSession.provider === input.provider &&
      providerSession.tenantId === input.tenantSession.tenantId &&
      providerSession.userId === input.tenantSession.userId &&
      normalizeRuntimePath(providerSession.cwd) === input.cwd,
  );
}

function createProviderSessionIsolation(input: {
  readonly account: ProviderAccount;
  readonly tenantSession: TenantSessionContext;
  readonly provider: ProviderKind;
  readonly cwd: string;
  readonly now: string;
  readonly providerSessionId?: ProviderSessionIdType | string;
}): ProviderSessionIsolation {
  return {
    id: ProviderSessionId.make(
      input.providerSessionId ??
        [
          "provider-session",
          input.account.id,
          sanitizeTenantPathSegment(input.cwd).slice(0, 80),
        ].join(":"),
    ),
    tenantId: input.tenantSession.tenantId,
    userId: input.tenantSession.userId,
    providerAccountId: input.account.id,
    provider: input.provider,
    providerHomeDir: input.account.authHomeDir,
    cwd: input.cwd,
    createdAt: input.now,
    endedAt: null,
  };
}

function upsertProviderIsolationSnapshot(input: {
  readonly snapshot: ProviderIsolationSnapshot;
  readonly account: ProviderAccount;
  readonly providerSession: ProviderSessionIsolation;
}): ProviderIsolationSnapshot {
  const accountExists = input.snapshot.providerAccounts.some(
    (account) => account.id === input.account.id,
  );
  const sessionExists = input.snapshot.providerSessions.some(
    (providerSession) => providerSession.id === input.providerSession.id,
  );

  return {
    providerAccounts: accountExists
      ? input.snapshot.providerAccounts.map((account) =>
          account.id === input.account.id ? input.account : account,
        )
      : [...input.snapshot.providerAccounts, input.account],
    providerSessions: sessionExists
      ? input.snapshot.providerSessions.map((providerSession) =>
          providerSession.id === input.providerSession.id ? input.providerSession : providerSession,
        )
      : [...input.snapshot.providerSessions, input.providerSession],
  };
}

function filterProviderLaunchBaseEnv(
  baseEnv: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string>> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (value === undefined || PROVIDER_LAUNCH_DENIED_ENV_KEYS.has(key)) {
      continue;
    }
    env[key] = value;
  }
  return env;
}

const PROVIDER_LAUNCH_DENIED_ENV_KEYS = new Set([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CONFIG_DIR",
  "CODEX_HOME",
  "HOME",
  "OPENAI_API_KEY",
  "XDG_CONFIG_HOME",
]);

function evaluateRuntimeHealthFailure(
  input: TenantRuntimeLifecycleInput,
): TenantRuntimeLifecycleDecision | undefined {
  if (input.healthCheckSucceeded !== false) {
    return undefined;
  }

  const consecutiveFailures = input.consecutiveHealthFailures ?? 1;
  const restartFailures =
    input.maxHealthFailuresBeforeRestart ?? DEFAULT_TENANT_RUNTIME_RESTART_FAILURES;
  const quarantineFailures =
    input.maxHealthFailuresBeforeQuarantine ?? DEFAULT_TENANT_RUNTIME_QUARANTINE_FAILURES;

  if (consecutiveFailures >= quarantineFailures) {
    return lifecycleDecision(
      "quarantine-unhealthy",
      "quarantined",
      "Tenant runtime exceeded the unhealthy quarantine threshold.",
    );
  }
  if (consecutiveFailures >= restartFailures) {
    return lifecycleDecision(
      "restart-unhealthy",
      "stopping",
      "Tenant runtime exceeded the unhealthy restart threshold.",
    );
  }

  return lifecycleDecision(
    "none",
    input.runtime.status,
    "Tenant runtime health check failed below the restart threshold.",
  );
}

function isRuntimeIdle(input: TenantRuntimeLifecycleInput): boolean {
  if (input.lastActivityAt === undefined || input.lastActivityAt === null) {
    return false;
  }
  const nowMs = Date.parse(input.now);
  const lastActivityMs = Date.parse(input.lastActivityAt);
  if (!Number.isFinite(nowMs) || !Number.isFinite(lastActivityMs)) {
    return false;
  }
  return nowMs - lastActivityMs >= input.runtime.idleShutdownAfterMs;
}

function isRuntimeWallClockExpired(input: TenantRuntimeLifecycleInput): boolean {
  if (input.runtime.lastStartedAt === null) {
    return false;
  }
  const nowMs = Date.parse(input.now);
  const lastStartedMs = Date.parse(input.runtime.lastStartedAt);
  if (!Number.isFinite(nowMs) || !Number.isFinite(lastStartedMs)) {
    return false;
  }
  const maxWallClockMs = input.maxWallClockMs ?? DEFAULT_PUBLIC_ACCESS_LIMITS.maxRuntimeWallClockMs;
  return nowMs - lastStartedMs >= maxWallClockMs;
}

function normalizeRuntimePath(value: string): string {
  return path.posix.normalize(value.replaceAll("\\", "/"));
}

function isPathInside(baseDir: string, candidatePath: string): boolean {
  const relative = path.posix.relative(baseDir, candidatePath);
  return relative.length > 0 && !relative.startsWith("..") && !path.posix.isAbsolute(relative);
}

function isPathAtOrInside(baseDir: string, candidatePath: string): boolean {
  const normalizedBaseDir = normalizeRuntimePath(baseDir);
  const normalizedCandidatePath = normalizeRuntimePath(candidatePath);
  return (
    normalizedCandidatePath === normalizedBaseDir ||
    isPathInside(normalizedBaseDir, normalizedCandidatePath)
  );
}

function runtimeIsolationPathEntries(
  runtime: TenantRuntimeIsolation,
): ReadonlyArray<readonly [string, string]> {
  return [
    ["baseDir", runtime.baseDir],
    ["dataDir", runtime.dataDir],
    ["secretsDir", runtime.secretsDir],
    ["attachmentsDir", runtime.attachmentsDir],
    ["worktreesDir", runtime.worktreesDir],
    ["runsDir", runtime.runsDir],
    ["providerHomesDir", runtime.providerHomesDir],
  ];
}

const checkLimit = (limit: string, current: number, maximum: number): TenantLimitCheck => ({
  allowed: current < maximum,
  limit,
  current,
  maximum,
});

export function evaluateTenantUsageLimits(
  counters: TenantUsageCounters,
  limits: PublicAccessLimits,
): readonly TenantLimitCheck[] {
  return [
    checkLimit(
      "webSocketConnectionsForIp",
      counters.webSocketConnectionsForIp,
      limits.maxWebSocketConnectionsPerIp,
    ),
    checkLimit(
      "webSocketConnectionsForUser",
      counters.webSocketConnectionsForUser,
      limits.maxWebSocketConnectionsPerUser,
    ),
    checkLimit(
      "webSocketConnectionsForTenant",
      counters.webSocketConnectionsForTenant,
      limits.maxWebSocketConnectionsPerTenant,
    ),
    checkLimit(
      "rpcRequestsThisMinuteForUser",
      counters.rpcRequestsThisMinuteForUser,
      limits.maxRpcRequestsPerMinutePerUser,
    ),
    checkLimit(
      "rpcRequestsThisMinuteForTenant",
      counters.rpcRequestsThisMinuteForTenant,
      limits.maxRpcRequestsPerMinutePerTenant,
    ),
    checkLimit("activeTurnsForUser", counters.activeTurnsForUser, limits.maxActiveTurnsPerUser),
    checkLimit(
      "activeTurnsForTenant",
      counters.activeTurnsForTenant,
      limits.maxActiveTurnsPerTenant,
    ),
    checkLimit(
      "activeProviderSessionsForUser",
      counters.activeProviderSessionsForUser,
      limits.maxActiveProviderSessionsPerUser,
    ),
    checkLimit(
      "activeProviderSessionsForTenant",
      counters.activeProviderSessionsForTenant,
      limits.maxActiveProviderSessionsPerTenant,
    ),
    checkLimit(
      "providerConnectFailuresForUser",
      counters.providerConnectFailuresForUser,
      limits.maxProviderConnectFailuresPerUser,
    ),
    checkLimit(
      "activeTenantRuntimesForMachine",
      counters.activeTenantRuntimesForMachine,
      limits.maxActiveTenantRuntimesPerMachine,
    ),
  ];
}

export function findFirstTenantUsageLimitViolation(
  counters: TenantUsageCounters,
  limits: PublicAccessLimits,
): TenantLimitCheck | undefined {
  return evaluateTenantUsageLimits(counters, limits).find((check) => !check.allowed);
}
