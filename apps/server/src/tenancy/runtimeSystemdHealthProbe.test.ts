import { TenantId, TenantRuntimeId, type TenantRuntimeIsolation } from "@t3tools/contracts";
import { deriveTenantRuntimeDirectoryLayout } from "@t3tools/shared/tenancy";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import {
  createTenantRuntimeSystemdHealthProbe,
  deriveTenantRuntimeSystemdHealthCommand,
  TenantRuntimeSystemdHealthProbeError,
  type TenantRuntimeSystemdHealthCommand,
} from "./runtimeSystemdHealthProbe.ts";

function makeRuntime(overrides: Partial<TenantRuntimeIsolation> = {}): TenantRuntimeIsolation {
  const tenantId = overrides.tenantId ?? TenantId.make("tenant-health");
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
    status: "running",
    idleShutdownAfterMs: 900_000,
    lastStartedAt: "2026-05-09T09:00:00.000Z",
    lastStoppedAt: null,
    ...overrides,
  };
}

describe("tenant runtime systemd health probe", () => {
  it("derives the systemctl is-active command for a tenant runtime", () => {
    const runtime = makeRuntime({
      tenantId: TenantId.make("tenant-probe"),
      runtimeId: TenantRuntimeId.make("runtime-probe"),
    });

    expect(deriveTenantRuntimeSystemdHealthCommand(runtime)).toEqual({
      command: "systemctl",
      args: ["is-active", "t3-tenant-runtime@tenant-probe.service"],
      reason: "Probe tenant runtime systemd unit health.",
    });
  });

  it("maps active systemd units to healthy snapshots", async () => {
    const commands: TenantRuntimeSystemdHealthCommand[] = [];
    const probe = createTenantRuntimeSystemdHealthProbe({
      commandRunner: (command) =>
        Effect.sync(() => {
          commands.push(command);
          return {
            stdout: "active\n",
            stderr: "",
            code: 0,
            signal: null,
            timedOut: false,
          };
        }),
    });

    const result = await Effect.runPromise(probe(makeRuntime()));

    expect(result).toEqual({ healthCheckSucceeded: true });
    expect(commands.map((command) => [command.command, command.args])).toEqual([
      ["systemctl", ["is-active", "t3-tenant-runtime@tenant-health.service"]],
    ]);
  });

  it("maps inactive units and probe failures to unhealthy snapshots", async () => {
    const inactiveProbe = createTenantRuntimeSystemdHealthProbe({
      commandRunner: () =>
        Effect.succeed({
          stdout: "inactive\n",
          stderr: "",
          code: 3,
          signal: null,
          timedOut: false,
        }),
    });
    const failedProbe = createTenantRuntimeSystemdHealthProbe({
      commandRunner: () =>
        Effect.fail(
          new TenantRuntimeSystemdHealthProbeError({
            message: "systemctl unavailable",
          }),
        ),
    });

    await expect(Effect.runPromise(inactiveProbe(makeRuntime()))).resolves.toEqual({
      healthCheckSucceeded: false,
    });
    await expect(Effect.runPromise(failedProbe(makeRuntime()))).resolves.toEqual({
      healthCheckSucceeded: false,
    });
  });
});
