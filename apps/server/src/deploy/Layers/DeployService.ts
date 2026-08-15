import { DateTime, Effect, Layer, Option } from "effect";

import {
  type DeployAnalyticsInjection,
  DeployError,
  type DeployRun,
  DeployRunId,
  type DeploySshConfig,
  type DeployTarget,
  DeployTargetId,
} from "@t3tools/contracts";

import { AnalyticsStore } from "../../analytics/Services/AnalyticsStore.ts";
import { ServerSecretStore } from "../../auth/Services/ServerSecretStore.ts";
import { DeployRepository } from "../../persistence/Services/DeployTargets.ts";
import { runProcess } from "../../processRunner.ts";
import { DeploymentRegistry } from "../Services/DeploymentRegistry.ts";
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

/** Where the ingest key arrives unless the target's command expects another name. */
export const DEFAULT_INGEST_KEY_VARIABLE = "T3_ANALYTICS_INGEST_KEY";

const REDACTED = "***";

/**
 * Take a secret back out of text that is about to be stored.
 *
 * Deploy output is captured and kept, and a deploy script that echoes its
 * environment — `set -x` is enough — would write the ingest key into a row that
 * outlives the deploy. The key is injected as an environment variable, so this
 * is the one place it can leak back into the database.
 */
export function redactSecret(text: string, secret: string): string {
  if (secret.length === 0) return text;
  return text.split(secret).join(REDACTED);
}

/**
 * Decide how to get a working key for a stream, given what already reports to it.
 *
 * Reissuing is what makes a key obtainable at all for a stream that exists, and
 * it breaks whatever was using the old one. That is acceptable for the
 * deployment being replaced and unacceptable for anything else, so the decision
 * turns entirely on who else is still reporting.
 */
export function planIngestKey(input: {
  readonly streamExists: boolean;
  /** Live deployments reporting to the stream, excluding the one being deployed. */
  readonly otherReporters: ReadonlyArray<string>;
}): { readonly action: "declare" | "reissue" } | { readonly action: "refuse"; readonly why: string } {
  if (!input.streamExists) {
    return { action: "declare" };
  }
  if (input.otherReporters.length > 0) {
    return {
      action: "refuse",
      why: `${input.otherReporters.join(", ")} ${
        input.otherReporters.length === 1 ? "already reports" : "already report"
      } to this stream. Issuing a key here would stop ${
        input.otherReporters.length === 1 ? "it" : "them"
      } being able to write, so this deploy would silently take their numbers away.`,
    };
  }
  return { action: "reissue" };
}

const makeDeployService = Effect.gen(function* () {
  const repository = yield* DeployRepository;
  const secrets = yield* ServerSecretStore;
  const analyticsStore = yield* AnalyticsStore;
  const deploymentRegistry = yield* DeploymentRegistry;

  const repositoryError = (message: string) => (cause: unknown) =>
    new DeployError({ code: "execution-failed", message, cause });

  /**
   * Mint the key this deploy will carry.
   *
   * Done before the process starts, because the key has to be in its
   * environment. That ordering has a cost worth naming: a deploy that then fails
   * has still replaced the stream's key, so the instance it was replacing keeps
   * running but stops being able to report. Only the deployment being replaced
   * can be in that position — anything else is refused above — which is what
   * makes the cost bearable rather than arbitrary.
   */
  const issueIngestKey = (input: {
    readonly target: DeployTarget;
    readonly analytics: DeployAnalyticsInjection;
    readonly deploymentName: string;
  }): Effect.Effect<string, DeployError> =>
    Effect.gen(function* () {
      const projectId = input.target.projectId;
      const analyticsError = (cause: { readonly message: string }) =>
        new DeployError({ code: "execution-failed", message: cause.message });

      const listed = yield* analyticsStore
        .listStreams({ projectId })
        .pipe(Effect.mapError(analyticsError));
      const existing = listed.streams.find((stream) => stream.name === input.analytics.stream);

      const live = yield* deploymentRegistry.list({ projectId });
      const otherReporters =
        existing === undefined
          ? []
          : live
              .filter(
                (deployment) =>
                  deployment.name !== input.deploymentName &&
                  deployment.analyticsStreamIds.includes(existing.id),
              )
              .map((deployment) => deployment.name);

      const plan = planIngestKey({ streamExists: existing !== undefined, otherReporters });
      if (plan.action === "refuse") {
        return yield* new DeployError({ code: "analytics-conflict", message: plan.why });
      }

      if (plan.action === "declare") {
        const declared = yield* analyticsStore
          .declareStream({
            projectId,
            name: input.analytics.stream,
            purpose:
              input.analytics.purpose ?? `Reported by the ${input.deploymentName} deployment.`,
            properties: input.analytics.properties ?? [],
          })
          .pipe(Effect.mapError(analyticsError));
        return declared.ingestKey;
      }

      const reissued = yield* analyticsStore
        .reissueIngestKey({ projectId, stream: input.analytics.stream })
        .pipe(Effect.mapError(analyticsError));
      return reissued.ingestKey;
    });

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

      const deploymentName = input.analytics?.deploymentName ?? target.name;
      const ingestKey =
        input.analytics === undefined
          ? undefined
          : yield* issueIngestKey({
              target,
              analytics: input.analytics,
              deploymentName,
            });

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
              // The only place this key exists outside the deployment. Nothing
              // writes it down, here or anywhere downstream.
              ...(ingestKey !== undefined
                ? {
                    [input.analytics?.keyVariable ?? DEFAULT_INGEST_KEY_VARIABLE]: ingestKey,
                  }
                : {}),
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
      const captured = [result.stdout, result.stderr].filter((part) => part.length > 0).join("\n");
      // Redacted before truncation, so a key straddling the cut cannot survive
      // as a fragment of itself.
      const output = truncateOutput(
        ingestKey === undefined ? captured : redactSecret(captured, ingestKey),
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

      // Only a run that worked put something live. A failed one leaves the
      // previous deployment recorded as it was, which is still true of the world.
      if (input.analytics !== undefined && completed.status === "succeeded") {
        yield* deploymentRegistry.register({
          projectId: target.projectId,
          targetId: target.id,
          name: deploymentName,
          ...(input.analytics.url !== undefined ? { url: input.analytics.url } : {}),
          status: "live",
          lastRunId: completed.id,
          streams: [input.analytics.stream],
        });
      }

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
  DeployRepository | ServerSecretStore | AnalyticsStore | DeploymentRegistry
> = Layer.effect(DeployService, makeDeployService);
