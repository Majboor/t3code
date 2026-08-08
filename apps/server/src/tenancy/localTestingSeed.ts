import {
  CollaborationActivityId,
  MembershipId,
  OrganizationAuditEventId,
  OrganizationId,
  ProviderAccountId,
  ProviderSessionId,
  TenantId,
  TenantRuntimeId,
  UserId,
  WorkspaceId,
} from "@t3tools/contracts";
import { deriveTenantRuntimeDirectoryLayout } from "@t3tools/shared/tenancy";
import { Effect } from "effect";

import type {
  CollaborationPersistenceSnapshot,
  OrganizationPersistenceSnapshot,
  ProviderIsolationPersistenceSnapshot,
  TenancyRepositoryShape,
  TenantRuntimeLifecyclePersistenceSnapshot,
  WorkspacePersistenceSnapshot,
} from "../persistence/Services/Tenancy.ts";

export interface LocalTestingTenancySeedOptions {
  readonly now?: string;
  readonly tenantRootDir?: string;
}

export interface LocalTestingTenancySeed {
  readonly organizations: OrganizationPersistenceSnapshot;
  readonly collaboration: CollaborationPersistenceSnapshot;
  readonly workspaces: WorkspacePersistenceSnapshot;
  readonly providerIsolation: ProviderIsolationPersistenceSnapshot;
  readonly runtimeLifecycle: TenantRuntimeLifecyclePersistenceSnapshot;
}

const DEFAULT_SEED_NOW = "2026-05-09T00:00:00.000Z";
const DEFAULT_TENANT_ROOT_DIR = "/opt/t3-tenants";

export function makeLocalTestingTenancySeed(
  options: LocalTestingTenancySeedOptions = {},
): LocalTestingTenancySeed {
  const now = options.now ?? DEFAULT_SEED_NOW;
  const tenantRootDir = options.tenantRootDir ?? DEFAULT_TENANT_ROOT_DIR;
  const acmeOrganizationId = OrganizationId.make("org-local-acme");
  const personalTenantId = TenantId.make("tenant-local-personal");
  const corporateTenantId = TenantId.make("tenant-local-acme");
  const supportTenantId = TenantId.make("tenant-local-support");
  const ownerUserId = UserId.make("user-local-owner");
  const developerUserId = UserId.make("user-local-developer");
  const pmUserId = UserId.make("user-local-pm");
  const supportUserId = UserId.make("user-local-support");
  const personalRuntime = makeSeedRuntime({
    tenantId: personalTenantId,
    tenantRootDir,
    port: 47101,
  });
  const corporateRuntime = makeSeedRuntime({
    tenantId: corporateTenantId,
    tenantRootDir,
    port: 47102,
  });
  const supportRuntime = makeSeedRuntime({
    tenantId: supportTenantId,
    tenantRootDir,
    port: 47103,
  });
  const personalWorkspaceId = WorkspaceId.make("workspace-local-personal");
  const corporateWorkspaceId = WorkspaceId.make("workspace-local-acme");
  const supportWorkspaceId = WorkspaceId.make("workspace-local-support");
  const ownerMembershipId = MembershipId.make("membership-local-owner");
  const developerMembershipId = MembershipId.make("membership-local-developer");
  const pmMembershipId = MembershipId.make("membership-local-pm");
  const supportMembershipId = MembershipId.make("membership-local-support");
  const ownerProviderAccountId = ProviderAccountId.make("provider-account-local-owner-codex");
  const developerProviderAccountId = ProviderAccountId.make(
    "provider-account-local-developer-codex",
  );

  return {
    organizations: {
      organizations: [
        {
          id: acmeOrganizationId,
          slug: "local-acme",
          displayName: "Local Acme",
          createdAt: now,
          archivedAt: null,
        },
      ],
      tenants: [
        {
          id: personalTenantId,
          slug: "local-personal",
          displayName: "Local Personal",
          kind: "personal",
          organizationId: null,
          runtimeId: personalRuntime.runtimeId,
          createdAt: now,
          archivedAt: null,
        },
        {
          id: corporateTenantId,
          slug: "local-acme",
          displayName: "Local Acme Tenant",
          kind: "corporate",
          organizationId: acmeOrganizationId,
          runtimeId: corporateRuntime.runtimeId,
          createdAt: now,
          archivedAt: null,
        },
        {
          id: supportTenantId,
          slug: "local-support",
          displayName: "Local Support Tenant",
          kind: "support",
          organizationId: null,
          runtimeId: supportRuntime.runtimeId,
          createdAt: now,
          archivedAt: null,
        },
      ],
      memberships: [
        {
          id: ownerMembershipId,
          tenantId: personalTenantId,
          userId: ownerUserId,
          organizationId: null,
          roles: ["owner"],
          createdAt: now,
          disabledAt: null,
        },
        {
          id: developerMembershipId,
          tenantId: corporateTenantId,
          userId: developerUserId,
          organizationId: acmeOrganizationId,
          roles: ["developer"],
          organizationRoles: ["developer"],
          teamIds: [],
          departmentId: null,
          createdAt: now,
          disabledAt: null,
        },
        {
          id: pmMembershipId,
          tenantId: corporateTenantId,
          userId: pmUserId,
          organizationId: acmeOrganizationId,
          roles: ["pm"],
          organizationRoles: ["pm"],
          teamIds: [],
          departmentId: null,
          createdAt: now,
          disabledAt: null,
        },
        {
          id: supportMembershipId,
          tenantId: supportTenantId,
          userId: supportUserId,
          organizationId: null,
          roles: ["support"],
          createdAt: now,
          disabledAt: null,
        },
      ],
      employees: [
        {
          membership: {
            id: developerMembershipId,
            tenantId: corporateTenantId,
            userId: developerUserId,
            organizationId: acmeOrganizationId,
            roles: ["developer"],
            organizationRoles: ["developer"],
            teamIds: [],
            departmentId: null,
            createdAt: now,
            disabledAt: null,
          },
          email: "developer@local-acme.test",
          displayName: "Local Developer",
          status: "active",
        },
        {
          membership: {
            id: pmMembershipId,
            tenantId: corporateTenantId,
            userId: pmUserId,
            organizationId: acmeOrganizationId,
            roles: ["pm"],
            organizationRoles: ["pm"],
            teamIds: [],
            departmentId: null,
            createdAt: now,
            disabledAt: null,
          },
          email: "pm@local-acme.test",
          displayName: "Local PM",
          status: "active",
        },
      ],
      invites: [],
      teams: [],
      departments: [],
      grants: [],
      reviews: [],
      auditEvents: [
        {
          id: OrganizationAuditEventId.make("org-audit-local-acme-created"),
          organizationId: acmeOrganizationId,
          actorUserId: ownerUserId,
          kind: "organization-created",
          summary: "Seeded Local Acme organization for multi-tenant testing.",
          createdAt: now,
        },
      ],
    },
    collaboration: {
      presence: [
        {
          userId: ownerUserId,
          tenantId: personalTenantId,
          workspaceId: personalWorkspaceId,
          threadId: null,
          displayName: "Local Owner",
          avatarInitials: "LO",
          status: "active",
          lastSeenAt: now,
        },
        {
          userId: developerUserId,
          tenantId: corporateTenantId,
          workspaceId: corporateWorkspaceId,
          threadId: null,
          displayName: "Local Developer",
          avatarInitials: "LD",
          status: "active",
          lastSeenAt: now,
        },
      ],
      invites: [],
      memberships: [
        {
          id: ownerMembershipId,
          tenantId: personalTenantId,
          userId: ownerUserId,
          organizationId: null,
          roles: ["owner"],
          createdAt: now,
          disabledAt: null,
        },
        {
          id: supportMembershipId,
          tenantId: supportTenantId,
          userId: supportUserId,
          organizationId: null,
          roles: ["support"],
          createdAt: now,
          disabledAt: null,
        },
      ],
      activities: [
        {
          id: CollaborationActivityId.make("activity:seed-joined"),
          tenantId: corporateTenantId,
          workspaceId: corporateWorkspaceId,
          threadId: null,
          userId: developerUserId,
          kind: "joined",
          summary: "Local developer joined the seeded corporate workspace.",
          hiddenAt: null,
          createdAt: now,
        },
      ],
    },
    workspaces: {
      workspaces: [
        {
          id: personalWorkspaceId,
          tenantId: personalTenantId,
          organizationId: null,
          ownerUserId,
          kind: "personal",
          accessMode: "private",
          title: "Local Personal Workspace",
          createdAt: now,
          archivedAt: null,
        },
        {
          id: corporateWorkspaceId,
          tenantId: corporateTenantId,
          organizationId: acmeOrganizationId,
          ownerUserId: developerUserId,
          kind: "corporate",
          accessMode: "organization",
          title: "Local Acme Workspace",
          createdAt: now,
          archivedAt: null,
        },
        {
          id: supportWorkspaceId,
          tenantId: supportTenantId,
          organizationId: null,
          ownerUserId: supportUserId,
          kind: "support",
          accessMode: "invite-only",
          title: "Local Support Workspace",
          createdAt: now,
          archivedAt: null,
        },
      ],
    },
    providerIsolation: {
      providerAccounts: [
        makeSeedProviderAccount({
          id: ownerProviderAccountId,
          tenantId: personalTenantId,
          userId: ownerUserId,
          runtimeBaseDir: personalRuntime.baseDir,
          providerHomesDir: personalRuntime.providerHomesDir,
          secretsDir: personalRuntime.secretsDir,
          createdAt: now,
        }),
        makeSeedProviderAccount({
          id: developerProviderAccountId,
          tenantId: corporateTenantId,
          userId: developerUserId,
          runtimeBaseDir: corporateRuntime.baseDir,
          providerHomesDir: corporateRuntime.providerHomesDir,
          secretsDir: corporateRuntime.secretsDir,
          createdAt: now,
        }),
      ],
      providerSessions: [
        {
          id: ProviderSessionId.make("provider-session-local-developer-codex"),
          tenantId: corporateTenantId,
          userId: developerUserId,
          providerAccountId: developerProviderAccountId,
          provider: "codex",
          providerHomeDir: `${corporateRuntime.providerHomesDir}/${developerUserId}/codex`,
          cwd: `${corporateRuntime.worktreesDir}/local-acme-app`,
          createdAt: now,
          endedAt: null,
        },
      ],
    },
    runtimeLifecycle: {
      runtimes: [personalRuntime, corporateRuntime, supportRuntime],
      systemdUnits: [],
      completedSteps: [],
    },
  };
}

export function saveLocalTestingTenancySeed(
  repository: TenancyRepositoryShape,
  options: LocalTestingTenancySeedOptions = {},
) {
  const seed = makeLocalTestingTenancySeed(options);
  return Effect.gen(function* () {
    yield* repository.saveOrganizations(seed.organizations);
    yield* repository.saveCollaboration(seed.collaboration);
    yield* repository.saveWorkspaces(seed.workspaces);
    yield* repository.saveProviderIsolation(seed.providerIsolation);
    yield* repository.saveTenantRuntimeLifecycleState(seed.runtimeLifecycle);
  });
}

function makeSeedRuntime(input: {
  readonly tenantId: TenantId;
  readonly tenantRootDir: string;
  readonly port: number;
}) {
  const layout = deriveTenantRuntimeDirectoryLayout({
    tenantId: input.tenantId,
    rootDir: input.tenantRootDir,
  });
  return {
    runtimeId: TenantRuntimeId.make(`${input.tenantId}-runtime`),
    tenantId: input.tenantId,
    strategy: "systemd-per-tenant" as const,
    linuxUser: `t3-${input.tenantId}`,
    baseDir: layout.baseDir,
    dataDir: layout.dataDir,
    secretsDir: layout.secretsDir,
    attachmentsDir: layout.attachmentsDir,
    worktreesDir: layout.worktreesDir,
    runsDir: layout.runsDir,
    providerHomesDir: layout.providerHomesDir,
    internalHost: "127.0.0.1",
    internalPort: input.port,
    status: "stopped" as const,
    idleShutdownAfterMs: 900_000,
    lastStartedAt: null,
    lastStoppedAt: null,
  };
}

function makeSeedProviderAccount(input: {
  readonly id: ProviderAccountId;
  readonly tenantId: TenantId;
  readonly userId: UserId;
  readonly runtimeBaseDir: string;
  readonly providerHomesDir: string;
  readonly secretsDir: string;
  readonly createdAt: string;
}) {
  const providerHomeDir = `${input.providerHomesDir}/${input.userId}/codex`;
  return {
    id: input.id,
    provider: "codex" as const,
    tenantId: input.tenantId,
    owner: {
      type: "user" as const,
      userId: input.userId,
    },
    sharing: "private" as const,
    authHomeDir: providerHomeDir,
    configDir: `${providerHomeDir}/config`,
    secretsDir: `${input.secretsDir}/provider-accounts/${input.userId}/codex`,
    createdAt: input.createdAt,
    disabledAt: null,
  };
}
