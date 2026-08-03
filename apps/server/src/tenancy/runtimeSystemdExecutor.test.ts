import { TenantId, TenantRuntimeId, type TenantRuntimeIsolation } from "@t3tools/contracts";
import { deriveTenantRuntimeDirectoryLayout } from "@t3tools/shared/tenancy";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import {
  type TenantRuntimeLifecycleExecutionStep,
  deriveTenantRuntimeLifecycleExecutionSteps,
  planTenantRuntimeLifecycle,
} from "./runtimeLifecyclePlanner.ts";
import {
  TenantRuntimeLifecycleExecutorError,
  type TenantRuntimeLifecycleStepExecutor,
} from "./runtimeLifecycleSupervisor.ts";
import {
  createTenantRuntimeSystemdLifecycleExecutor,
  deriveTenantRuntimeSystemdCommands,
  type TenantRuntimeSystemdCommand,
} from "./runtimeSystemdExecutor.ts";

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

function stepFor(
  runtime: TenantRuntimeIsolation,
  input: Omit<Parameters<typeof planTenantRuntimeLifecycle>[0], "runtimes" | "now"> = {},
): TenantRuntimeLifecycleExecutionStep {
  const plan = planTenantRuntimeLifecycle({
    runtimes: [runtime],
    now: "2026-01-02T01:00:00.000Z",
    ...input,
  });
  const step = deriveTenantRuntimeLifecycleExecutionSteps(plan)[0];
  if (!step) {
    throw new Error("Expected an actionable runtime lifecycle step.");
  }
  return step;
}

function runExecutorStep(
  executor: TenantRuntimeLifecycleStepExecutor,
  step: TenantRuntimeLifecycleExecutionStep,
) {
  switch (step.operation) {
    case "provision-and-start":
      return executor.provisionAndStart(step);
    case "record-denied-start":
      return executor.recordDeniedStart(step);
    case "mark-running":
      return executor.markRunning(step);
    case "stop":
      return executor.stop(step);
    case "restart":
      return executor.restart(step);
    case "quarantine":
      return executor.quarantine(step);
    case "mark-stopped":
      return executor.markStopped(step);
  }
}

describe("tenant runtime systemd lifecycle executor", () => {
  it("derives systemctl command sequences for process lifecycle steps", () => {
    const starting = stepFor(makeRuntime({ runtimeId: TenantRuntimeId.make("runtime-start") }), {
      demandRuntimeIds: ["runtime-start"],
    });
    const stopping = stepFor(
      makeRuntime({
        runtimeId: TenantRuntimeId.make("runtime-stop"),
        tenantId: TenantId.make("tenant-stop"),
        status: "running",
        lastStartedAt: "2026-01-01T00:00:00.000Z",
      }),
      { maxWallClockMs: 60 * 60 * 1000 },
    );
    const restarting = stepFor(
      makeRuntime({
        runtimeId: TenantRuntimeId.make("runtime-restart"),
        tenantId: TenantId.make("tenant-restart"),
        status: "running",
        lastStartedAt: "2026-01-01T23:00:00.000Z",
      }),
      {
        healthByRuntimeId: {
          "runtime-restart": { healthCheckSucceeded: false, consecutiveHealthFailures: 3 },
        },
      },
    );
    const quarantining = stepFor(
      makeRuntime({
        runtimeId: TenantRuntimeId.make("runtime-quarantine"),
        tenantId: TenantId.make("tenant-quarantine"),
        status: "running",
        lastStartedAt: "2026-01-01T23:00:00.000Z",
      }),
      {
        healthByRuntimeId: {
          "runtime-quarantine": { healthCheckSucceeded: false, consecutiveHealthFailures: 5 },
        },
      },
    );

    expect(deriveTenantRuntimeSystemdCommands(starting).map((command) => command.args)).toEqual([
      ["daemon-reload"],
      ["enable", "--now", "t3-tenant-runtime@tenant-acme.service"],
    ]);
    expect(deriveTenantRuntimeSystemdCommands(stopping).map((command) => command.args)).toEqual([
      ["stop", "t3-tenant-runtime@tenant-stop.service"],
    ]);
    expect(deriveTenantRuntimeSystemdCommands(restarting).map((command) => command.args)).toEqual([
      ["restart", "t3-tenant-runtime@tenant-restart.service"],
    ]);
    expect(deriveTenantRuntimeSystemdCommands(quarantining).map((command) => command.args)).toEqual(
      [
        ["stop", "t3-tenant-runtime@tenant-quarantine.service"],
        ["disable", "t3-tenant-runtime@tenant-quarantine.service"],
      ],
    );
  });

  it("executes systemd commands through the injected runner and leaves state-only steps local", async () => {
    const commands: TenantRuntimeSystemdCommand[] = [];
    const executor = createTenantRuntimeSystemdLifecycleExecutor({
      commandRunner: (command) =>
        Effect.sync(() => {
          commands.push(command);
          return { stdout: "", stderr: "", code: 0, signal: null, timedOut: false };
        }),
    });

    const starting = stepFor(makeRuntime({ runtimeId: TenantRuntimeId.make("runtime-run") }), {
      demandRuntimeIds: ["runtime-run"],
    });
    const markRunning = stepFor(
      makeRuntime({
        runtimeId: TenantRuntimeId.make("runtime-mark"),
        status: "starting",
        lastStartedAt: "2026-01-01T00:00:00.000Z",
      }),
      {
        healthByRuntimeId: {
          "runtime-mark": { healthCheckSucceeded: true },
        },
      },
    );

    await Effect.runPromise(runExecutorStep(executor, starting));
    await Effect.runPromise(runExecutorStep(executor, markRunning));

    expect(commands.map((command) => [command.command, command.args])).toEqual([
      ["systemctl", ["daemon-reload"]],
      ["systemctl", ["enable", "--now", "t3-tenant-runtime@tenant-acme.service"]],
    ]);
  });

  it("propagates typed command runner failures", async () => {
    const executor = createTenantRuntimeSystemdLifecycleExecutor({
      commandRunner: (command) =>
        Effect.fail(
          new TenantRuntimeLifecycleExecutorError({
            message: `failed ${command.args.join(" ")}`,
          }),
        ),
    });
    const stopping = stepFor(
      makeRuntime({
        runtimeId: TenantRuntimeId.make("runtime-fail"),
        tenantId: TenantId.make("tenant-fail"),
        status: "running",
        lastStartedAt: "2026-01-01T00:00:00.000Z",
      }),
      { maxWallClockMs: 60 * 60 * 1000 },
    );

    await expect(Effect.runPromise(runExecutorStep(executor, stopping))).rejects.toMatchObject({
      _tag: "TenantRuntimeLifecycleExecutorError",
      message: "failed stop t3-tenant-runtime@tenant-fail.service",
    });
  });
});
