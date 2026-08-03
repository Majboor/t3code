import { deriveTenantRuntimeSystemdUnit } from "@t3tools/shared/tenancy";
import { Effect } from "effect";

import { runProcess, type ProcessRunResult } from "../processRunner.ts";
import {
  TenantRuntimeLifecycleExecutorError,
  type TenantRuntimeLifecycleStepExecutor,
} from "./runtimeLifecycleSupervisor.ts";

export interface TenantRuntimeSystemdCommand {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly reason: string;
}

export type TenantRuntimeSystemdCommandRunner = (
  command: TenantRuntimeSystemdCommand,
) => Effect.Effect<ProcessRunResult, TenantRuntimeLifecycleExecutorError>;

export interface TenantRuntimeSystemdExecutorOptions {
  readonly commandRunner?: TenantRuntimeSystemdCommandRunner;
}

const DEFAULT_SYSTEMD_TIMEOUT_MS = 30_000;

function tenantRuntimeUnitName(step: Parameters<TenantRuntimeLifecycleStepExecutor["stop"]>[0]) {
  return deriveTenantRuntimeSystemdUnit({ runtime: step.runtime }).unitName;
}

function systemctlCommand(
  args: ReadonlyArray<string>,
  reason: string,
): TenantRuntimeSystemdCommand {
  return {
    command: "systemctl",
    args,
    reason,
  };
}

function defaultCommandRunner(
  command: TenantRuntimeSystemdCommand,
): Effect.Effect<ProcessRunResult, TenantRuntimeLifecycleExecutorError> {
  return Effect.tryPromise({
    try: () =>
      runProcess(command.command, command.args, {
        timeoutMs: DEFAULT_SYSTEMD_TIMEOUT_MS,
      }),
    catch: (cause) =>
      new TenantRuntimeLifecycleExecutorError({
        message: `Tenant runtime systemd command failed: ${command.command} ${command.args.join(" ")}`,
        cause,
      }),
  });
}

function runSystemdCommands(
  runner: TenantRuntimeSystemdCommandRunner,
  commands: ReadonlyArray<TenantRuntimeSystemdCommand>,
): Effect.Effect<void, TenantRuntimeLifecycleExecutorError> {
  return Effect.forEach(commands, (command) => runner(command), { concurrency: 1 }).pipe(
    Effect.asVoid,
  );
}

export function deriveTenantRuntimeSystemdCommands(
  step: Parameters<TenantRuntimeLifecycleStepExecutor["stop"]>[0],
): ReadonlyArray<TenantRuntimeSystemdCommand> {
  const unitName = tenantRuntimeUnitName(step);

  switch (step.operation) {
    case "provision-and-start":
      return [
        systemctlCommand(["daemon-reload"], "Reload systemd units before tenant runtime start."),
        systemctlCommand(["enable", "--now", unitName], step.reason),
      ];
    case "stop":
      return [systemctlCommand(["stop", unitName], step.reason)];
    case "restart":
      return [systemctlCommand(["restart", unitName], step.reason)];
    case "quarantine":
      return [
        systemctlCommand(["stop", unitName], step.reason),
        systemctlCommand(["disable", unitName], "Disable quarantined tenant runtime restart."),
      ];
    case "record-denied-start":
    case "mark-running":
    case "mark-stopped":
      return [];
  }
}

export function createTenantRuntimeSystemdLifecycleExecutor(
  options: TenantRuntimeSystemdExecutorOptions = {},
): TenantRuntimeLifecycleStepExecutor {
  const commandRunner = options.commandRunner ?? defaultCommandRunner;
  const runStep = (step: Parameters<TenantRuntimeLifecycleStepExecutor["stop"]>[0]) =>
    runSystemdCommands(commandRunner, deriveTenantRuntimeSystemdCommands(step));

  return {
    provisionAndStart: runStep,
    recordDeniedStart: () => Effect.void,
    markRunning: () => Effect.void,
    stop: runStep,
    restart: runStep,
    quarantine: runStep,
    markStopped: () => Effect.void,
  };
}
