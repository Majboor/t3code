import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { TenantId, TenantRuntimeId, type TenantRuntimeIsolation } from "@t3tools/contracts";
import { deriveTenantRuntimeDirectoryLayout } from "@t3tools/shared/tenancy";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";

import type {
  TenancyRepositoryShape,
  TenantRuntimeLifecyclePersistenceSnapshot,
} from "../persistence/Services/Tenancy.ts";
import { TenancyRepository } from "../persistence/Services/Tenancy.ts";
import type { TenantRuntimeLifecycleStepExecutor } from "./runtimeLifecycleSupervisor.ts";
import { runTenantRuntimeLifecycleSchedulerOnce } from "./runtimeLifecycleScheduler.ts";

function makeRuntime(overrides: Partial<TenantRuntimeIsolation> = {}): TenantRuntimeIsolation {
  const tenantId = overrides.tenantId ?? TenantId.make("tenant-scheduler");
  const layout = deriveTenantRuntimeDirectoryLayout({
    tenantId,
    rootDir: "/opt/t3-tenants",
  });
  return {
    runtimeId: TenantRuntimeId.make(`runtime-${tenantId}`),
    tenantId,
    strategy: "systemd-per-tenant",
    linuxUser: `t3-${tenantId}`,
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

function makeRepositoryLayer(stateRef: {
  current: TenantRuntimeLifecyclePersistenceSnapshot;
  saves: TenantRuntimeLifecyclePersistenceSnapshot[];
}): Layer.Layer<TenancyRepository> {
  const emptySnapshot = {
    organizations: [],
    tenants: [],
    employees: [],
    invites: [],
    memberships: [],
    teams: [],
    departments: [],
    grants: [],
    reviews: [],
    auditEvents: [],
  };
  const repository: TenancyRepositoryShape = {
    loadOrganizations: () => Effect.succeed(emptySnapshot),
    saveOrganizations: () => Effect.void,
    loadCollaboration: () =>
      Effect.succeed({
        presence: [],
        invites: [],
        memberships: [],
        activities: [],
      }),
    saveCollaboration: () => Effect.void,
    loadWorkspaces: () =>
      Effect.succeed({
        workspaces: [],
      }),
    saveWorkspaces: () => Effect.void,
    loadProviderIsolation: () =>
      Effect.succeed({
        providerAccounts: [],
        providerSessions: [],
      }),
    saveProviderIsolation: () => Effect.void,
    loadTenantRuntimeLifecycleState: () => Effect.succeed(stateRef.current),
    saveTenantRuntimeLifecycleState: (snapshot) =>
      Effect.sync(() => {
        stateRef.current = snapshot;
        stateRef.saves.push(snapshot);
      }),
  };

  return Layer.succeed(TenancyRepository, repository);
}

function makeExecutor(operations: string[]): TenantRuntimeLifecycleStepExecutor {
  const run =
    (label: string): TenantRuntimeLifecycleStepExecutor["stop"] =>
    (step) =>
      Effect.sync(() => operations.push(`${label}:${step.runtime.runtimeId}`)).pipe(
        Effect.flatMap(() => Effect.void),
      );

  return {
    provisionAndStart: run("provision-and-start"),
    recordDeniedStart: run("record-denied-start"),
    markRunning: run("mark-running"),
    stop: run("stop"),
    restart: run("restart"),
    quarantine: run("quarantine"),
    markStopped: run("mark-stopped"),
  };
}

describe("tenant runtime lifecycle scheduler", () => {
  it("loads persisted runtimes and runs one repository-backed lifecycle tick", async () => {
    const runtime = makeRuntime({
      runtimeId: TenantRuntimeId.make("runtime-scheduler-start"),
      tenantId: TenantId.make("tenant-scheduler-start"),
    });
    const stateRef = {
      current: {
        runtimes: [runtime],
        systemdUnits: [],
        completedSteps: [],
      } satisfies TenantRuntimeLifecyclePersistenceSnapshot,
      saves: [] as TenantRuntimeLifecyclePersistenceSnapshot[],
    };
    const operations: string[] = [];
    const unitDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "t3-scheduler-units-"));

    const result = await Effect.runPromise(
      runTenantRuntimeLifecycleSchedulerOnce({
        now: "2026-05-09T10:00:00.000Z",
        demandRuntimeIds: [runtime.runtimeId],
        executor: makeExecutor(operations),
        unitDirectory,
      }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, makeRepositoryLayer(stateRef)))),
    );

    expect(result.loadedState.runtimes).toEqual([runtime]);
    expect(result.admission).toMatchObject({
      activeTenantRuntimesForMachine: 0,
      admittedDemandRuntimeIds: [runtime.runtimeId],
      deniedDemandRuntimeIds: [],
    });
    expect(operations).toEqual(["provision-and-start:runtime-scheduler-start"]);
    expect(stateRef.saves).toHaveLength(1);
    expect(stateRef.current.runtimes[0]).toMatchObject({
      runtimeId: runtime.runtimeId,
      status: "starting",
      lastStartedAt: "2026-05-09T10:00:00.000Z",
    });
  });

  it("applies the machine-level runtime cap before admitting stopped runtime demand", async () => {
    const running = makeRuntime({
      runtimeId: TenantRuntimeId.make("runtime-scheduler-running"),
      tenantId: TenantId.make("tenant-scheduler-running"),
      status: "running",
      lastStartedAt: "2026-05-09T09:00:00.000Z",
    });
    const queued = makeRuntime({
      runtimeId: TenantRuntimeId.make("runtime-scheduler-queued"),
      tenantId: TenantId.make("tenant-scheduler-queued"),
    });
    const stateRef = {
      current: {
        runtimes: [running, queued],
        systemdUnits: [],
        completedSteps: [],
      } satisfies TenantRuntimeLifecyclePersistenceSnapshot,
      saves: [] as TenantRuntimeLifecyclePersistenceSnapshot[],
    };
    const operations: string[] = [];

    const result = await Effect.runPromise(
      runTenantRuntimeLifecycleSchedulerOnce({
        now: "2026-05-09T10:00:00.000Z",
        demandRuntimeIds: [queued.runtimeId],
        executor: makeExecutor(operations),
        limits: {
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
          maxActiveTenantRuntimesPerMachine: 1,
          maxRuntimeIdleMs: 15 * 60 * 1000,
          maxRuntimeWallClockMs: 24 * 60 * 60 * 1000,
        },
      }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, makeRepositoryLayer(stateRef)))),
    );

    expect(result.admission).toMatchObject({
      activeTenantRuntimesForMachine: 1,
      maximumActiveTenantRuntimesForMachine: 1,
      admittedDemandRuntimeIds: [],
      deniedDemandRuntimeIds: [queued.runtimeId],
    });
    expect(result.supervisor.steps).toEqual([]);
    expect(operations).toEqual([]);
    expect(stateRef.current.runtimes).toEqual([running, queued]);
  });

  it("still admits lifecycle maintenance actions while machine start admission is full", async () => {
    const expired = makeRuntime({
      runtimeId: TenantRuntimeId.make("runtime-scheduler-expired"),
      tenantId: TenantId.make("tenant-scheduler-expired"),
      status: "running",
      lastStartedAt: "2026-05-09T08:00:00.000Z",
    });
    const queued = makeRuntime({
      runtimeId: TenantRuntimeId.make("runtime-scheduler-denied-start"),
      tenantId: TenantId.make("tenant-scheduler-denied-start"),
    });
    const stateRef = {
      current: {
        runtimes: [expired, queued],
        systemdUnits: [],
        completedSteps: [],
      } satisfies TenantRuntimeLifecyclePersistenceSnapshot,
      saves: [] as TenantRuntimeLifecyclePersistenceSnapshot[],
    };
    const operations: string[] = [];

    const result = await Effect.runPromise(
      runTenantRuntimeLifecycleSchedulerOnce({
        now: "2026-05-09T10:00:00.000Z",
        demandRuntimeIds: [queued.runtimeId],
        maxWallClockMs: 60 * 60 * 1000,
        executor: makeExecutor(operations),
        limits: {
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
          maxActiveTenantRuntimesPerMachine: 1,
          maxRuntimeIdleMs: 15 * 60 * 1000,
          maxRuntimeWallClockMs: 24 * 60 * 60 * 1000,
        },
      }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, makeRepositoryLayer(stateRef)))),
    );

    expect(result.admission.deniedDemandRuntimeIds).toEqual([queued.runtimeId]);
    expect(result.supervisor.steps.map((step) => step.operation)).toEqual(["stop"]);
    expect(operations).toEqual(["stop:runtime-scheduler-expired"]);
    expect(stateRef.current.runtimes[0]).toMatchObject({
      runtimeId: expired.runtimeId,
      status: "stopping",
      lastStoppedAt: "2026-05-09T10:00:00.000Z",
    });
  });
});
