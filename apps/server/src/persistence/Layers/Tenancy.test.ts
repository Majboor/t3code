import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
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
import { deriveTenantRuntimeSystemdUnit } from "@t3tools/shared/tenancy";
import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { makeSqlitePersistenceLive } from "./Sqlite.ts";
import { TenancyRepositoryLive } from "./Tenancy.ts";
import { TenancyRepository } from "../Services/Tenancy.ts";

function makeTenancyLayer<E, R>(persistenceLayer: Layer.Layer<SqlClient.SqlClient, E, R>) {
  return TenancyRepositoryLive.pipe(
    Layer.provide(persistenceLayer),
    Layer.provideMerge(NodeServices.layer),
  );
}

it.effect("persists tenancy, organization, and collaboration rows across layer restart", () =>
  Effect.gen(function* () {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "t3-tenancy-restart-"));
    const dbPath = path.join(tempDir, "tenancy.sqlite");
    const layer = makeTenancyLayer(makeSqlitePersistenceLive(dbPath));
    const organizationId = OrganizationId.make("org-restart");
    const tenantId = TenantId.make("tenant-restart");
    const membershipId = MembershipId.make("membership-restart");
    const userId = UserId.make("user-restart");
    const workspaceId = WorkspaceId.make("workspace-restart");
    const runtimeId = TenantRuntimeId.make("runtime-restart");
    const generatedAt = "2026-05-03T00:01:00.000Z";
    const runtime = {
      runtimeId,
      tenantId,
      strategy: "systemd-per-tenant" as const,
      linuxUser: "t3-tenant-restart",
      baseDir: "/srv/t3/tenants/restart",
      dataDir: "/srv/t3/tenants/restart/data",
      secretsDir: "/srv/t3/tenants/restart/secrets",
      attachmentsDir: "/srv/t3/tenants/restart/attachments",
      worktreesDir: "/srv/t3/tenants/restart/worktrees",
      runsDir: "/srv/t3/tenants/restart/runs",
      providerHomesDir: "/srv/t3/tenants/restart/provider-homes",
      internalHost: "127.0.0.1",
      internalPort: 4473,
      status: "stopped" as const,
      idleShutdownAfterMs: 900_000,
      lastStartedAt: null,
      lastStoppedAt: null,
    };
    const unit = deriveTenantRuntimeSystemdUnit({ runtime });

    yield* Effect.gen(function* () {
      const repository = yield* TenancyRepository;
      yield* repository.saveOrganizations({
        organizations: [
          {
            id: organizationId,
            slug: "restart",
            displayName: "Restart Org",
            createdAt: "2026-05-03T00:00:00.000Z",
            archivedAt: null,
          },
        ],
        tenants: [
          {
            id: tenantId,
            slug: "restart",
            displayName: "Restart Tenant",
            kind: "corporate",
            organizationId,
            runtimeId,
            createdAt: "2026-05-03T00:00:00.000Z",
            archivedAt: null,
          },
        ],
        memberships: [
          {
            id: membershipId,
            tenantId,
            userId,
            organizationId,
            roles: ["owner"],
            organizationRoles: ["owner"],
            teamIds: [],
            departmentId: null,
            createdAt: "2026-05-03T00:00:00.000Z",
            disabledAt: null,
          },
        ],
        employees: [
          {
            membership: {
              id: membershipId,
              tenantId,
              userId,
              organizationId,
              roles: ["owner"],
              organizationRoles: ["owner"],
              teamIds: [],
              departmentId: null,
              createdAt: "2026-05-03T00:00:00.000Z",
              disabledAt: null,
            },
            email: "owner@example.com",
            displayName: "Owner",
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
            id: OrganizationAuditEventId.make("org-audit-restart"),
            organizationId,
            actorUserId: userId,
            kind: "organization-created",
            summary: "Created restart org.",
            createdAt: "2026-05-03T00:00:00.000Z",
          },
        ],
      });
      yield* repository.saveCollaboration({
        presence: [
          {
            userId,
            tenantId,
            workspaceId,
            threadId: null,
            displayName: "Owner",
            status: "active",
            lastSeenAt: "2026-05-03T00:00:00.000Z",
          },
        ],
        invites: [],
        memberships: [],
        activities: [
          {
            id: CollaborationActivityId.make("activity:restart"),
            tenantId,
            workspaceId,
            threadId: null,
            userId,
            kind: "joined",
            summary: "Owner joined.",
            hiddenAt: null,
            createdAt: "2026-05-03T00:00:00.000Z",
          },
        ],
      });
      yield* repository.saveWorkspaces({
        workspaces: [
          {
            id: workspaceId,
            tenantId,
            organizationId,
            ownerUserId: userId,
            kind: "corporate",
            accessMode: "organization",
            title: "Restart Workspace",
            createdAt: "2026-05-03T00:00:00.000Z",
            archivedAt: null,
          },
        ],
      });
      yield* repository.saveProviderIsolation({
        providerAccounts: [
          {
            id: ProviderAccountId.make("provider-account-restart"),
            provider: "codex",
            tenantId,
            owner: { type: "user", userId },
            sharing: "private",
            authHomeDir: "/srv/t3/tenants/restart/provider-homes/user-restart/codex",
            configDir: "/srv/t3/tenants/restart/provider-homes/user-restart/codex/config",
            secretsDir:
              "/srv/t3/tenants/restart/secrets/provider-accounts/provider-account-restart",
            createdAt: "2026-05-03T00:00:00.000Z",
            disabledAt: null,
          },
        ],
        providerSessions: [
          {
            id: ProviderSessionId.make("provider-session-restart"),
            tenantId,
            userId,
            providerAccountId: ProviderAccountId.make("provider-account-restart"),
            provider: "codex",
            providerHomeDir: "/srv/t3/tenants/restart/provider-homes/user-restart/codex",
            cwd: "/srv/t3/tenants/restart/worktrees/workspace-restart",
            createdAt: "2026-05-03T00:00:00.000Z",
            endedAt: null,
          },
        ],
      });
      yield* repository.saveTenantRuntimeLifecycleState({
        runtimes: [runtime],
        systemdUnits: [
          {
            tenantId,
            runtimeId,
            unitName: unit.unitName,
            unitFile: unit.unitFile,
            generatedAt,
            lastWrittenAt: null,
          },
        ],
        completedSteps: [
          {
            idempotencyKey:
              "tenant-runtime-lifecycle:tenant-restart:runtime-restart:start:stopped:starting:never-started:never-stopped",
            tenantId,
            runtimeId,
            operation: "provision-and-start",
            sourceAction: "start",
            targetStatus: "starting",
            processAction: true,
            reason: "Runtime demand requires start.",
            completedAt: "2026-05-03T00:02:00.000Z",
          },
        ],
      });
    }).pipe(Effect.provide(layer));

    yield* Effect.gen(function* () {
      const repository = yield* TenancyRepository;
      const organizations = yield* repository.loadOrganizations();
      const collaboration = yield* repository.loadCollaboration();
      const workspaces = yield* repository.loadWorkspaces();
      const providerIsolation = yield* repository.loadProviderIsolation();
      const lifecycleState = yield* repository.loadTenantRuntimeLifecycleState();

      assert.equal(organizations.organizations[0]?.id, organizationId);
      assert.equal(organizations.tenants[0]?.id, tenantId);
      assert.equal(organizations.employees[0]?.membership.id, membershipId);
      assert.equal(organizations.auditEvents[0]?.kind, "organization-created");
      assert.equal(collaboration.presence[0]?.workspaceId, workspaceId);
      assert.equal(collaboration.activities[0]?.kind, "joined");
      assert.equal(workspaces.workspaces[0]?.id, workspaceId);
      assert.equal(workspaces.workspaces[0]?.title, "Restart Workspace");
      assert.equal(workspaces.workspaces[0]?.accessMode, "organization");
      assert.equal(providerIsolation.providerAccounts[0]?.tenantId, tenantId);
      assert.equal(providerIsolation.providerAccounts[0]?.sharing, "private");
      assert.equal(
        providerIsolation.providerSessions[0]?.providerAccountId,
        "provider-account-restart",
      );
      assert.equal(
        providerIsolation.providerSessions[0]?.providerHomeDir,
        "/srv/t3/tenants/restart/provider-homes/user-restart/codex",
      );
      assert.equal(lifecycleState.runtimes[0]?.runtimeId, runtimeId);
      assert.equal(lifecycleState.runtimes[0]?.status, "stopped");
      assert.equal(lifecycleState.runtimes[0]?.baseDir, "/srv/t3/tenants/restart");
      assert.equal(lifecycleState.systemdUnits[0]?.runtimeId, runtimeId);
      assert.equal(lifecycleState.systemdUnits[0]?.unitName, unit.unitName);
      assert.equal(lifecycleState.systemdUnits[0]?.unitFile, unit.unitFile);
      assert.equal(lifecycleState.systemdUnits[0]?.generatedAt, generatedAt);
      assert.equal(
        lifecycleState.completedSteps[0]?.idempotencyKey,
        "tenant-runtime-lifecycle:tenant-restart:runtime-restart:start:stopped:starting:never-started:never-stopped",
      );
      assert.equal(lifecycleState.completedSteps[0]?.processAction, true);
      assert.equal(lifecycleState.completedSteps[0]?.targetStatus, "starting");
    }).pipe(Effect.provide(layer));
  }),
);
