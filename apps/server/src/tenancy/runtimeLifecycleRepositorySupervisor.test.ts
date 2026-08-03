import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { TenantId, TenantRuntimeId, type TenantRuntimeIsolation } from "@t3tools/contracts";
import {
  deriveTenantRuntimeDirectoryLayout,
  deriveTenantRuntimeSystemdUnit,
} from "@t3tools/shared/tenancy";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";

import type {
  TenancyRepositoryShape,
  TenantRuntimeLifecyclePersistenceSnapshot,
} from "../persistence/Services/Tenancy.ts";
import { TenancyRepository } from "../persistence/Services/Tenancy.ts";
import {
  TenantRuntimeLifecycleExecutorError,
  type TenantRuntimeLifecycleStepExecutor,
} from "./runtimeLifecycleSupervisor.ts";
import { superviseTenantRuntimeLifecycleWithRepository } from "./runtimeLifecycleRepositorySupervisor.ts";

function makeRuntime(overrides: Partial<TenantRuntimeIsolation> = {}): TenantRuntimeIsolation {
  const tenantId = overrides.tenantId ?? TenantId.make("tenant-repository");
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
      }),
  };

  return Layer.succeed(TenancyRepository, repository);
}

function makeExecutor(
  operations: string[],
  failures: ReadonlySet<string> = new Set(),
): TenantRuntimeLifecycleStepExecutor {
  const run =
    (label: string): TenantRuntimeLifecycleStepExecutor["stop"] =>
    (step) =>
      Effect.sync(() => operations.push(`${label}:${step.runtime.runtimeId}`)).pipe(
        Effect.flatMap(() =>
          failures.has(label)
            ? Effect.fail(
                new TenantRuntimeLifecycleExecutorError({
                  message: `${label} failed`,
                }),
              )
            : Effect.void,
        ),
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

describe("tenant runtime lifecycle repository supervisor", () => {
  it("loads completed steps, writes systemd units, delegates execution, and persists completions", async () => {
    const stateRef = {
      current: {
        runtimes: [],
        systemdUnits: [],
        completedSteps: [],
      } satisfies TenantRuntimeLifecyclePersistenceSnapshot,
    };
    const unitDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "t3-runtime-units-"));
    const runtime = makeRuntime({
      runtimeId: TenantRuntimeId.make("runtime-repository-start"),
      tenantId: TenantId.make("tenant-repository-start"),
    });
    const operations: string[] = [];

    const result = await Effect.runPromise(
      superviseTenantRuntimeLifecycleWithRepository({
        runtimes: [runtime],
        now: "2026-05-09T09:00:00.000Z",
        demandRuntimeIds: [runtime.runtimeId],
        executor: makeExecutor(operations),
        unitDirectory,
      }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, makeRepositoryLayer(stateRef)))),
    );
    const unit = deriveTenantRuntimeSystemdUnit({ runtime });
    const unitPath = path.join(unitDirectory, unit.unitName);

    expect(result.results.map((entry) => entry.outcome)).toEqual(["executed"]);
    expect(operations).toEqual(["provision-and-start:runtime-repository-start"]);
    expect(fs.readFileSync(unitPath, "utf8")).toBe(unit.unitFile);
    expect(stateRef.current.runtimes).toEqual([
      {
        ...runtime,
        status: "starting",
        lastStartedAt: "2026-05-09T09:00:00.000Z",
        lastStoppedAt: null,
      },
    ]);
    expect(stateRef.current.systemdUnits).toEqual([
      {
        tenantId: runtime.tenantId,
        runtimeId: runtime.runtimeId,
        unitName: unit.unitName,
        unitFile: unit.unitFile,
        generatedAt: "2026-05-09T09:00:00.000Z",
        lastWrittenAt: "2026-05-09T09:00:00.000Z",
      },
    ]);
    expect(stateRef.current.completedSteps).toEqual([
      expect.objectContaining({
        idempotencyKey: result.steps[0]?.idempotencyKey,
        tenantId: runtime.tenantId,
        runtimeId: runtime.runtimeId,
        operation: "provision-and-start",
        sourceAction: "start",
        targetStatus: "starting",
        processAction: true,
        completedAt: "2026-05-09T09:00:00.000Z",
      }),
    ]);
  });

  it("skips repository-completed idempotency keys without rewriting unit files", async () => {
    const runtime = makeRuntime({
      runtimeId: TenantRuntimeId.make("runtime-repository-skip"),
      tenantId: TenantId.make("tenant-repository-skip"),
    });
    const operations: string[] = [];
    const firstRunState = {
      current: {
        runtimes: [],
        systemdUnits: [],
        completedSteps: [],
      } satisfies TenantRuntimeLifecyclePersistenceSnapshot,
    };
    const unitDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "t3-runtime-units-skip-"));

    const firstResult = await Effect.runPromise(
      superviseTenantRuntimeLifecycleWithRepository({
        runtimes: [runtime],
        now: "2026-05-09T09:00:00.000Z",
        demandRuntimeIds: [runtime.runtimeId],
        executor: makeExecutor(operations),
        unitDirectory,
      }).pipe(
        Effect.provide(Layer.mergeAll(NodeServices.layer, makeRepositoryLayer(firstRunState))),
      ),
    );
    const completedState = firstRunState.current;
    const secondRunState = { current: completedState };
    const skippedOperations: string[] = [];

    const secondResult = await Effect.runPromise(
      superviseTenantRuntimeLifecycleWithRepository({
        runtimes: [runtime],
        now: "2026-05-09T09:05:00.000Z",
        demandRuntimeIds: [runtime.runtimeId],
        executor: makeExecutor(skippedOperations),
        unitDirectory,
      }).pipe(
        Effect.provide(Layer.mergeAll(NodeServices.layer, makeRepositoryLayer(secondRunState))),
      ),
    );

    expect(firstResult.results.map((entry) => entry.outcome)).toEqual(["executed"]);
    expect(secondResult.results.map((entry) => entry.outcome)).toEqual(["skipped"]);
    expect(skippedOperations).toEqual([]);
    expect(secondRunState.current).toEqual(completedState);
  });

  it("does not persist completed steps when execution fails after unit materialization", async () => {
    const stateRef = {
      current: {
        runtimes: [],
        systemdUnits: [],
        completedSteps: [],
      } satisfies TenantRuntimeLifecyclePersistenceSnapshot,
    };
    const unitDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "t3-runtime-units-fail-"));
    const runtime = makeRuntime({
      runtimeId: TenantRuntimeId.make("runtime-repository-fail"),
      tenantId: TenantId.make("tenant-repository-fail"),
    });

    await expect(
      Effect.runPromise(
        superviseTenantRuntimeLifecycleWithRepository({
          runtimes: [runtime],
          now: "2026-05-09T09:00:00.000Z",
          demandRuntimeIds: [runtime.runtimeId],
          executor: makeExecutor([], new Set(["provision-and-start"])),
          unitDirectory,
        }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, makeRepositoryLayer(stateRef)))),
      ),
    ).rejects.toMatchObject({
      _tag: "TenantRuntimeLifecycleRepositorySupervisorError",
      message: "Tenant runtime lifecycle supervision failed.",
    });
    expect(stateRef.current).toEqual({
      runtimes: [],
      systemdUnits: [],
      completedSteps: [],
    });
  });

  it("persists stop-like and state-only runtime descriptor transitions", async () => {
    const running = makeRuntime({
      runtimeId: TenantRuntimeId.make("runtime-repository-expired"),
      tenantId: TenantId.make("tenant-repository-expired"),
      status: "running",
      lastStartedAt: "2026-05-08T08:00:00.000Z",
    });
    const stopping = makeRuntime({
      runtimeId: TenantRuntimeId.make("runtime-repository-cleanup"),
      tenantId: TenantId.make("tenant-repository-cleanup"),
      status: "stopping",
      lastStartedAt: "2026-05-08T08:00:00.000Z",
      lastStoppedAt: "2026-05-09T08:30:00.000Z",
    });
    const stateRef = {
      current: {
        runtimes: [running, stopping],
        systemdUnits: [],
        completedSteps: [],
      } satisfies TenantRuntimeLifecyclePersistenceSnapshot,
    };
    const operations: string[] = [];

    const result = await Effect.runPromise(
      superviseTenantRuntimeLifecycleWithRepository({
        runtimes: [running, stopping],
        now: "2026-05-09T09:00:00.000Z",
        maxWallClockMs: 60 * 60 * 1000,
        executor: makeExecutor(operations),
      }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, makeRepositoryLayer(stateRef)))),
    );

    expect(result.results.map((entry) => entry.step.operation)).toEqual(["stop", "mark-stopped"]);
    expect(operations).toEqual([
      "stop:runtime-repository-expired",
      "mark-stopped:runtime-repository-cleanup",
    ]);
    expect(stateRef.current.runtimes).toEqual([
      {
        ...running,
        status: "stopping",
        lastStoppedAt: "2026-05-09T09:00:00.000Z",
      },
      {
        ...stopping,
        status: "stopped",
      },
    ]);
  });
});
