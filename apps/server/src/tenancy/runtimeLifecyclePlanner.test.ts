import { TenantId, TenantRuntimeId, type TenantRuntimeIsolation } from "@t3tools/contracts";
import { deriveTenantRuntimeDirectoryLayout } from "@t3tools/shared/tenancy";
import { describe, expect, it } from "vitest";

import {
  deriveTenantRuntimeLifecycleExecutionSteps,
  planTenantRuntimeLifecycle,
} from "./runtimeLifecyclePlanner.ts";

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

describe("tenant runtime lifecycle planner", () => {
  it("returns actionable start, idle stop, and wall-clock stop decisions", () => {
    const stopped = makeRuntime({
      runtimeId: TenantRuntimeId.make("runtime-demand"),
      tenantId: TenantId.make("tenant-demand"),
    });
    const idle = makeRuntime({
      runtimeId: TenantRuntimeId.make("runtime-idle"),
      tenantId: TenantId.make("tenant-idle"),
      status: "running",
      lastStartedAt: "2026-01-01T00:00:00.000Z",
    });
    const expired = makeRuntime({
      runtimeId: TenantRuntimeId.make("runtime-expired"),
      tenantId: TenantId.make("tenant-expired"),
      status: "running",
      lastStartedAt: "2026-01-01T00:00:00.000Z",
    });
    const active = makeRuntime({
      runtimeId: TenantRuntimeId.make("runtime-active"),
      tenantId: TenantId.make("tenant-active"),
      status: "running",
      lastStartedAt: "2026-01-01T00:59:00.000Z",
    });

    const plan = planTenantRuntimeLifecycle({
      runtimes: [stopped, idle, expired, active],
      now: "2026-01-01T01:00:00.000Z",
      demandRuntimeIds: new Set([stopped.runtimeId]),
      lastActivityByRuntimeId: {
        [idle.runtimeId]: "2026-01-01T00:44:00.000Z",
        [active.runtimeId]: "2026-01-01T00:59:00.000Z",
      },
      maxWallClockMs: 60 * 60 * 1000,
    });

    expect(plan.entries.map((entry) => entry.decision.action)).toEqual([
      "start",
      "stop-idle",
      "stop-expired",
      "none",
    ]);
    expect(plan.actionable.map((entry) => entry.runtime.runtimeId)).toEqual([
      stopped.runtimeId,
      idle.runtimeId,
      expired.runtimeId,
    ]);
  });

  it("keeps unhealthy escalation and quarantine decisions in the actionable plan", () => {
    const unhealthy = makeRuntime({
      runtimeId: TenantRuntimeId.make("runtime-unhealthy"),
      status: "running",
      lastStartedAt: "2026-01-01T00:00:00.000Z",
    });
    const quarantined = makeRuntime({
      runtimeId: TenantRuntimeId.make("runtime-quarantine"),
      status: "running",
      lastStartedAt: "2026-01-01T00:00:00.000Z",
    });

    const plan = planTenantRuntimeLifecycle({
      runtimes: [unhealthy, quarantined],
      now: "2026-01-01T00:10:00.000Z",
      healthByRuntimeId: new Map([
        [unhealthy.runtimeId, { healthCheckSucceeded: false, consecutiveHealthFailures: 3 }],
        [quarantined.runtimeId, { healthCheckSucceeded: false, consecutiveHealthFailures: 5 }],
      ]),
    });

    expect(plan.actionable.map((entry) => entry.decision.action)).toEqual([
      "restart-unhealthy",
      "quarantine-unhealthy",
    ]);
  });

  it("derives deterministic execution steps for process and state actions", () => {
    const stopped = makeRuntime({
      runtimeId: TenantRuntimeId.make("runtime-demand"),
      tenantId: TenantId.make("tenant-demand"),
    });
    const unsafe = makeRuntime({
      runtimeId: TenantRuntimeId.make("runtime-unsafe"),
      tenantId: TenantId.make("tenant-unsafe"),
      linuxUser: "root",
    });
    const starting = makeRuntime({
      runtimeId: TenantRuntimeId.make("runtime-starting"),
      tenantId: TenantId.make("tenant-starting"),
      status: "starting",
      lastStartedAt: "2026-01-01T00:00:00.000Z",
    });
    const expired = makeRuntime({
      runtimeId: TenantRuntimeId.make("runtime-expired"),
      tenantId: TenantId.make("tenant-expired"),
      status: "running",
      lastStartedAt: "2026-01-01T00:00:00.000Z",
    });
    const unhealthy = makeRuntime({
      runtimeId: TenantRuntimeId.make("runtime-unhealthy"),
      tenantId: TenantId.make("tenant-unhealthy"),
      status: "running",
      lastStartedAt: "2026-01-01T00:10:00.000Z",
    });
    const quarantined = makeRuntime({
      runtimeId: TenantRuntimeId.make("runtime-quarantine"),
      tenantId: TenantId.make("tenant-quarantine"),
      status: "running",
      lastStartedAt: "2026-01-01T00:10:00.000Z",
    });
    const stopping = makeRuntime({
      runtimeId: TenantRuntimeId.make("runtime-stopping"),
      tenantId: TenantId.make("tenant-stopping"),
      status: "stopping",
      lastStartedAt: "2026-01-01T00:00:00.000Z",
      lastStoppedAt: "2026-01-01T00:59:00.000Z",
    });

    const plan = planTenantRuntimeLifecycle({
      runtimes: [stopped, unsafe, starting, expired, unhealthy, quarantined, stopping],
      now: "2026-01-02T01:00:00.000Z",
      demandRuntimeIds: [stopped.runtimeId, unsafe.runtimeId],
      healthByRuntimeId: {
        [starting.runtimeId]: { healthCheckSucceeded: true },
        [unhealthy.runtimeId]: { healthCheckSucceeded: false, consecutiveHealthFailures: 3 },
        [quarantined.runtimeId]: { healthCheckSucceeded: false, consecutiveHealthFailures: 5 },
      },
      maxWallClockMs: 60 * 60 * 1000,
    });

    const steps = deriveTenantRuntimeLifecycleExecutionSteps(plan);

    expect(
      steps.map((step) => ({
        sourceAction: step.sourceAction,
        operation: step.operation,
        targetStatus: step.targetStatus,
        processAction: step.processAction,
      })),
    ).toEqual([
      {
        sourceAction: "start",
        operation: "provision-and-start",
        targetStatus: "starting",
        processAction: true,
      },
      {
        sourceAction: "deny-start",
        operation: "record-denied-start",
        targetStatus: "stopped",
        processAction: false,
      },
      {
        sourceAction: "mark-running",
        operation: "mark-running",
        targetStatus: "running",
        processAction: false,
      },
      {
        sourceAction: "stop-expired",
        operation: "stop",
        targetStatus: "stopping",
        processAction: true,
      },
      {
        sourceAction: "restart-unhealthy",
        operation: "restart",
        targetStatus: "stopping",
        processAction: true,
      },
      {
        sourceAction: "quarantine-unhealthy",
        operation: "quarantine",
        targetStatus: "quarantined",
        processAction: true,
      },
      {
        sourceAction: "cleanup-stopped",
        operation: "mark-stopped",
        targetStatus: "stopped",
        processAction: false,
      },
    ]);
    expect(new Set(steps.map((step) => step.idempotencyKey)).size).toBe(steps.length);
    expect(steps[0]?.idempotencyKey).toBe(
      "tenant-runtime-lifecycle:tenant-demand:runtime-demand:start:stopped:starting:never-started:never-stopped",
    );
    expect(deriveTenantRuntimeLifecycleExecutionSteps(plan)).toEqual(steps);
  });
});
