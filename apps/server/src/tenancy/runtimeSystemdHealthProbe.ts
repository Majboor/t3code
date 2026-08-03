import type { TenantRuntimeIsolation } from "@t3tools/contracts";
import { deriveTenantRuntimeSystemdUnit } from "@t3tools/shared/tenancy";
import { Data, Effect } from "effect";

import { runProcess, type ProcessRunResult } from "../processRunner.ts";
import type { TenantRuntimeHealthSnapshot } from "./runtimeLifecyclePlanner.ts";

export interface TenantRuntimeSystemdHealthCommand {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly reason: string;
}

export class TenantRuntimeSystemdHealthProbeError extends Data.TaggedError(
  "TenantRuntimeSystemdHealthProbeError",
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export type TenantRuntimeSystemdHealthCommandRunner = (
  command: TenantRuntimeSystemdHealthCommand,
) => Effect.Effect<ProcessRunResult, TenantRuntimeSystemdHealthProbeError>;

export type TenantRuntimeHealthProbe = (
  runtime: TenantRuntimeIsolation,
) => Effect.Effect<TenantRuntimeHealthSnapshot, never>;

export interface TenantRuntimeSystemdHealthProbeOptions {
  readonly commandRunner?: TenantRuntimeSystemdHealthCommandRunner;
}

const DEFAULT_SYSTEMD_HEALTH_TIMEOUT_MS = 10_000;

export function deriveTenantRuntimeSystemdHealthCommand(
  runtime: TenantRuntimeIsolation,
): TenantRuntimeSystemdHealthCommand {
  const unit = deriveTenantRuntimeSystemdUnit({ runtime });
  return {
    command: "systemctl",
    args: ["is-active", unit.unitName],
    reason: "Probe tenant runtime systemd unit health.",
  };
}

function defaultCommandRunner(
  command: TenantRuntimeSystemdHealthCommand,
): Effect.Effect<ProcessRunResult, TenantRuntimeSystemdHealthProbeError> {
  return Effect.tryPromise({
    try: () =>
      runProcess(command.command, command.args, {
        allowNonZeroExit: true,
        outputMode: "truncate",
        maxBufferBytes: 4 * 1024,
        timeoutMs: DEFAULT_SYSTEMD_HEALTH_TIMEOUT_MS,
      }),
    catch: (cause) =>
      new TenantRuntimeSystemdHealthProbeError({
        message: `Tenant runtime health probe failed: ${command.command} ${command.args.join(" ")}`,
        cause,
      }),
  });
}

function systemdIsActive(result: ProcessRunResult): boolean {
  return result.code === 0 && result.stdout.trim() === "active" && !result.timedOut;
}

export function probeTenantRuntimeSystemdHealth(
  runtime: TenantRuntimeIsolation,
  options: TenantRuntimeSystemdHealthProbeOptions = {},
): Effect.Effect<TenantRuntimeHealthSnapshot, never> {
  const commandRunner = options.commandRunner ?? defaultCommandRunner;
  const command = deriveTenantRuntimeSystemdHealthCommand(runtime);

  return commandRunner(command).pipe(
    Effect.map((result) => ({
      healthCheckSucceeded: systemdIsActive(result),
    })),
    Effect.catch((error) =>
      Effect.logWarning("tenant.runtime.health.probe-failed", {
        error,
        runtimeId: runtime.runtimeId,
        tenantId: runtime.tenantId,
      }).pipe(Effect.as({ healthCheckSucceeded: false })),
    ),
  );
}

export function createTenantRuntimeSystemdHealthProbe(
  options: TenantRuntimeSystemdHealthProbeOptions = {},
): TenantRuntimeHealthProbe {
  return (runtime) => probeTenantRuntimeSystemdHealth(runtime, options);
}
