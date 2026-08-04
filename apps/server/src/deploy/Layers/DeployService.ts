import { DateTime, Effect, Layer, Option } from "effect";

import {
  DeployError,
  type DeployRun,
  DeployRunId,
  type DeploySshConfig,
  type DeployTarget,
  DeployTargetId,
} from "@t3tools/contracts";

import { ServerSecretStore } from "../../auth/Services/ServerSecretStore.ts";
import { DeployRepository } from "../../persistence/Services/DeployTargets.ts";
import { runProcess } from "../../processRunner.ts";
import { DeployService, type DeployServiceShape } from "../Services/DeployService.ts";

const DEPLOY_TIMEOUT_MS = 10 * 60_000;
const MAX_OUTPUT_BYTES = 512 * 1024;

/**
 * Build the argv used to run a target's command on a remote host. Passwords are
 * piped through `sshpass -e` so they never appear in the process arguments.
 */
export function buildSshCommand(input: {
  readonly ssh: DeploySshConfig;
  readonly command: string;
  readonly hasPassword: boolean;
}): { readonly command: string; readonly args: ReadonlyArray<string> } {
  const remoteCommand = input.ssh.remotePath
    ? `cd ${JSON.stringify(input.ssh.remotePath)} && ${input.command}`
    : input.command;
  const sshArgs = [
    "-o",
    "StrictHostKeyChecking=no",
    "-o",
    "BatchMode=no",
    ...(input.ssh.port !== undefined ? ["-p", String(input.ssh.port)] : []),
    ...(input.ssh.identityFile ? ["-i", input.ssh.identityFile] : []),
    `${input.ssh.user}@${input.ssh.host}`,
    remoteCommand,
  ];
  return input.hasPassword
    ? { command: "sshpass", args: ["-e", "ssh", ...sshArgs] }
    : { command: "ssh", args: sshArgs };
}

function truncateOutput(value: string): string {
  if (value.length <= MAX_OUTPUT_BYTES) {
    return value;
  }
  return `${value.slice(0, MAX_OUTPUT_BYTES)}\n...output truncated...`;
}

const makeDeployService = Effect.gen(function* () {
  const repository = yield* DeployRepository;
  const secrets = yield* ServerSecretStore;

  const repositoryError = (message: string) => (cause: unknown) =>
    new DeployError({ code: "execution-failed", message, cause });

  const listTargets: DeployServiceShape["listTargets"] = (input) =>
    repository
      .listTargets(input.projectId !== undefined ? { projectId: input.projectId } : {})
      .pipe(Effect.mapError(repositoryError("Failed to list deploy targets.")));

  const createTarget: DeployServiceShape["createTarget"] = (input) =>
    Effect.gen(function* () {
      if (input.kind === "ssh" && !input.ssh) {
        return yield* new DeployError({
          code: "invalid-target",
          message: "SSH deploy targets require host and user configuration.",
        });
      }
      const now = yield* DateTime.now;
      const timestamp = DateTime.formatIso(DateTime.toUtc(now));
      const target: DeployTarget = {
        id: DeployTargetId.make(`deploy-target:${crypto.randomUUID()}`),
        projectId: input.projectId,
        tenantId: null,
        name: input.name,
        kind: input.kind,
        command: input.command,
        ssh: input.ssh ?? null,
        createdAt: timestamp,
        updatedAt: timestamp,
        archivedAt: null,
      };
      yield* repository
        .upsertTarget(target)
        .pipe(Effect.mapError(repositoryError("Failed to save deploy target.")));
      return target;
    });

  const deleteTarget: DeployServiceShape["deleteTarget"] = (input) =>
    Effect.gen(function* () {
      const existing = yield* repository
        .getTarget({ targetId: input.targetId })
        .pipe(Effect.mapError(repositoryError("Failed to load deploy target.")));
      if (Option.isNone(existing)) {
        return yield* new DeployError({
          code: "target-not-found",
          message: `Deploy target ${input.targetId} was not found.`,
        });
      }
      const now = yield* DateTime.now;
      const timestamp = DateTime.formatIso(DateTime.toUtc(now));
      yield* repository
        .upsertTarget({ ...existing.value, archivedAt: timestamp, updatedAt: timestamp })
        .pipe(Effect.mapError(repositoryError("Failed to archive deploy target.")));
    });

  const resolveSshPassword = (
    target: DeployTarget,
  ): Effect.Effect<string | undefined, DeployError> => {
    const secretName = target.ssh?.passwordSecretName;
    if (!secretName) {
      return Effect.succeed(undefined);
    }
    return secrets.get(secretName).pipe(
      Effect.mapError(repositoryError("Failed to read deploy credential.")),
      Effect.map((value) => (value === null ? undefined : new TextDecoder().decode(value))),
    );
  };

  const run: DeployServiceShape["run"] = (input) =>
    Effect.gen(function* () {
      const targetOption = yield* repository
        .getTarget({ targetId: input.targetId })
        .pipe(Effect.mapError(repositoryError("Failed to load deploy target.")));
      if (Option.isNone(targetOption) || targetOption.value.archivedAt !== null) {
        return yield* new DeployError({
          code: "target-not-found",
          message: `Deploy target ${input.targetId} was not found.`,
        });
      }
      const target = targetOption.value;
      const password = yield* resolveSshPassword(target);
      if (target.kind === "ssh" && !target.ssh) {
        return yield* new DeployError({
          code: "invalid-target",
          message: "SSH deploy target is missing its host configuration.",
        });
      }

      const startedAtInstant = yield* DateTime.now;
      const startedAt = DateTime.formatIso(DateTime.toUtc(startedAtInstant));
      const runRecord: DeployRun = {
        id: DeployRunId.make(`deploy-run:${crypto.randomUUID()}`),
        targetId: target.id,
        projectId: target.projectId,
        status: "running",
        exitCode: null,
        output: "",
        triggeredBy: input.actor.label,
        startedAt,
        completedAt: null,
      };
      yield* repository
        .upsertRun(runRecord)
        .pipe(Effect.mapError(repositoryError("Failed to record deploy run.")));

      const invocation =
        target.kind === "ssh" && target.ssh
          ? buildSshCommand({
              ssh: target.ssh,
              command: target.command,
              hasPassword: password !== undefined,
            })
          : { command: "/bin/sh", args: ["-lc", target.command] };

      const result = yield* Effect.tryPromise({
        try: () =>
          runProcess(invocation.command, invocation.args, {
            cwd: input.workspaceRoot,
            timeoutMs: DEPLOY_TIMEOUT_MS,
            allowNonZeroExit: true,
            outputMode: "truncate",
            maxBufferBytes: MAX_OUTPUT_BYTES,
            env: {
              ...process.env,
              ...(password !== undefined ? { SSHPASS: password } : {}),
            },
          }),
        catch: (cause) =>
          new DeployError({
            code: "execution-failed",
            message: `Failed to start deploy command: ${String(cause)}`,
            cause,
          }),
      });

      const completedAtInstant = yield* DateTime.now;
      const output = truncateOutput(
        [result.stdout, result.stderr].filter((part) => part.length > 0).join("\n"),
      );
      const completed: DeployRun = {
        ...runRecord,
        status: result.code === 0 ? "succeeded" : "failed",
        exitCode: result.code,
        output,
        completedAt: DateTime.formatIso(DateTime.toUtc(completedAtInstant)),
      };
      yield* repository
        .upsertRun(completed)
        .pipe(Effect.mapError(repositoryError("Failed to record deploy result.")));
      yield* Effect.logInfo("deploy.run.completed").pipe(
        Effect.annotateLogs({
          targetId: target.id,
          runId: completed.id,
          status: completed.status,
          exitCode: completed.exitCode,
        }),
      );
      return completed;
    });

  const listRuns: DeployServiceShape["listRuns"] = (input) =>
    repository
      .listRuns({
        ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
        ...(input.targetId !== undefined ? { targetId: input.targetId } : {}),
        ...(input.limit !== undefined ? { limit: input.limit } : {}),
      })
      .pipe(Effect.mapError(repositoryError("Failed to list deploy runs.")));

  return {
    listTargets,
    createTarget,
    deleteTarget,
    run,
    listRuns,
  } satisfies DeployServiceShape;
});

export const DeployServiceLive: Layer.Layer<
  DeployService,
  never,
  DeployRepository | ServerSecretStore
> = Layer.effect(DeployService, makeDeployService);
