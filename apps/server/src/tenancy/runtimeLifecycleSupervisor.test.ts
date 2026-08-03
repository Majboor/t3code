import { TenantId, TenantRuntimeId, type TenantRuntimeIsolation } from "@t3tools/contracts";
import { deriveTenantRuntimeDirectoryLayout } from "@t3tools/shared/tenancy";
import { Effect, Metric } from "effect";
import { describe, expect, it } from "vitest";

import {
  deriveTenantRuntimeLifecycleExecutionSteps,
  planTenantRuntimeLifecycle,
} from "./runtimeLifecyclePlanner.ts";
import {
  TenantRuntimeLifecycleExecutorError,
  type TenantRuntimeLifecycleStepExecutor,
  superviseTenantRuntimeLifecycle,
} from "./runtimeLifecycleSupervisor.ts";

function makeRuntime(overrides: Partial<TenantRuntimeIsolation> = {}): TenantRuntimeIsolation {
  const tenantId = overrides.tenantId ?? TenantId.make("tenant-acme");
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

function makeExecutor(
  operations: string[],
  failures: ReadonlySet<string> = new Set(),
): TenantRuntimeLifecycleStepExecutor {
  const run =
    (label: string): TenantRuntimeLifecycleStepExecutor["stop"] =>
    (step) =>
      Effect.sync(() => operations.push(`${label}:${step.runtime.runtimeId}`)).pipe(
        Effect.flatMap(() => {
          if (failures.has(label)) {
            return Effect.fail(
              new TenantRuntimeLifecycleExecutorError({
                message: `${label} failed`,
              }),
            );
          }
          return Effect.void;
        }),
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

function hasMetricSnapshot(
  snapshots: ReadonlyArray<Metric.Metric.Snapshot>,
  id: string,
  attributes: Readonly<Record<string, string>>,
): boolean {
  return snapshots.some(
    (snapshot) =>
      snapshot.id === id &&
      Object.entries(attributes).every(([key, value]) => snapshot.attributes?.[key] === value),
  );
}

describe("tenant runtime lifecycle supervisor", () => {
  it("executes actionable lifecycle steps in order and skips completed idempotency keys", async () => {
    const demand = makeRuntime({
      runtimeId: TenantRuntimeId.make("runtime-supervisor-demand"),
      tenantId: TenantId.make("tenant-supervisor-demand"),
    });
    const expired = makeRuntime({
      runtimeId: TenantRuntimeId.make("runtime-supervisor-expired"),
      tenantId: TenantId.make("tenant-supervisor-expired"),
      status: "running",
      lastStartedAt: "2026-01-01T00:00:00.000Z",
    });
    const planInput = {
      runtimes: [demand, expired],
      now: "2026-01-02T01:00:00.000Z",
      demandRuntimeIds: [demand.runtimeId],
      maxWallClockMs: 60 * 60 * 1000,
    };
    const steps = deriveTenantRuntimeLifecycleExecutionSteps(planTenantRuntimeLifecycle(planInput));
    const operations: string[] = [];

    const result = await Effect.runPromise(
      superviseTenantRuntimeLifecycle({
        ...planInput,
        executor: makeExecutor(operations),
        completedStepIds: [steps[0]?.idempotencyKey ?? ""],
      }),
    );

    expect(result.results.map((entry) => entry.outcome)).toEqual(["skipped", "executed"]);
    expect(operations).toEqual(["stop:runtime-supervisor-expired"]);

    const snapshots = await Effect.runPromise(Metric.snapshot);
    expect(
      hasMetricSnapshot(snapshots, "t3_tenant_runtime_lifecycle_actions_total", {
        operation: "provision-and-start",
        outcome: "skipped",
        runtimeId: "runtime-supervisor-demand",
      }),
    ).toBe(true);
    expect(
      hasMetricSnapshot(snapshots, "t3_tenant_runtime_lifecycle_actions_total", {
        operation: "stop",
        outcome: "success",
        runtimeId: "runtime-supervisor-expired",
      }),
    ).toBe(true);
  });

  it("records failure metrics and fails with the offending lifecycle step", async () => {
    const expired = makeRuntime({
      runtimeId: TenantRuntimeId.make("runtime-supervisor-failure"),
      tenantId: TenantId.make("tenant-supervisor-failure"),
      status: "running",
      lastStartedAt: "2026-01-01T00:00:00.000Z",
    });

    await expect(
      Effect.runPromise(
        superviseTenantRuntimeLifecycle({
          runtimes: [expired],
          now: "2026-01-02T01:00:00.000Z",
          maxWallClockMs: 60 * 60 * 1000,
          executor: makeExecutor([], new Set(["stop"])),
        }),
      ),
    ).rejects.toMatchObject({
      _tag: "TenantRuntimeLifecycleSupervisorError",
      message: "Tenant runtime lifecycle step failed: stop.",
      step: expect.objectContaining({
        operation: "stop",
        sourceAction: "stop-expired",
      }),
    });

    const snapshots = await Effect.runPromise(Metric.snapshot);
    expect(
      hasMetricSnapshot(snapshots, "t3_tenant_runtime_lifecycle_actions_total", {
        operation: "stop",
        outcome: "failure",
        runtimeId: "runtime-supervisor-failure",
      }),
    ).toBe(true);
  });
});
