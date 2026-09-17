import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

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

/**
 * The file a `cloudflare-tunnel` target's command is expected to redirect
 * `cloudflared`'s stdout/stderr into, so its quick-tunnel URL can be read back
 * after the command itself exits (per this platform's existing convention —
 * shared with `ssh`/`command` targets — that the command backgrounds the
 * service and returns quickly, it does not stay attached). Injected as an env
 * var rather than hardcoded so a target's command can build the exact
 * `cloudflared tunnel --url http://127.0.0.1:$PORT >> "$T3_TUNNEL_LOG_PATH" 2>&1 &`
 * invocation without guessing the path.
 */
export const TUNNEL_LOG_ENV_VAR = "T3_TUNNEL_LOG_PATH";
// KNOWN OPEN ISSUE, not yet fixed here: a `cloudflare-tunnel` command that
// backgrounds cloudflared with `(nohup cloudflared ... </dev/null >>"$T3_TUNNEL_LOG_PATH"
// 2>&1 &)` still does not make `run()` return quickly when cloudflared itself
// is slow to fail — measured at 2m21s wall-clock for a run whose foreground
// script (`echo started`) finishes in ~1s. Cause, confirmed by reading
// processRunner.ts: `runProcess` uses `spawn(..., { stdio: "pipe" })` and
// resolves on the child's `close` event, which Node only fires once every fd
// referencing those pipes is closed. A background job started with plain `&`
// inside a non-interactive `sh -c` stays in the same process group/session as
// that `sh`, even with full `</dev/null >>file 2>&1` redirection — `nohup`
// only ignores SIGHUP, it does not start a new session. So `close` wound up
// waiting on cloudflared's own lifetime (here, its ~2 minute internal
// deadline for a failed quick-tunnel request), not on the launcher script
// finishing. `command`/`ssh` targets that background a fast, well-behaved
// service rarely hit this because the parent shell still exits almost
// immediately and nothing else holds the pipe open — cloudflared specifically
// keeps running (and keeps the fd) until it gives up. Current advice for a
// `cloudflare-tunnel` command: wrap the background invocation in `setsid`
// (e.g. `setsid cloudflared tunnel --url http://127.0.0.1:$PORT </dev/null
// >>"$T3_TUNNEL_LOG_PATH" 2>&1 &`), which puts it in a new session and should
// detach it from `run()`'s wait — not yet re-verified end-to-end after this
// change, flagging rather than claiming fixed.
const TUNNEL_LOG_FILE_NAME = ".t3-tunnel.log";
// Excludes `api.trycloudflare.com` deliberately: that is cloudflared's own
// control-plane host, and it appears verbatim in a real failure line
// ('failed to request quick Tunnel: Post "https://api.trycloudflare.com/tunnel"')
// — a real tunnel's subdomain is always a random word sequence, never
// literally `api`. Found by testing, not by inspection: a stale failed-attempt
// line from a PREVIOUS run, still sitting in the append-mode log file, matched
// a naive pattern and got registered as the deployment's URL while the real
// tunnel (created seconds later, same run) was ignored. Truncating the log
// before each run (below) closes the same hole from the other side.
const TRYCLOUDFLARE_URL_PATTERN = /https:\/\/(?!api\.)[a-z0-9-]+\.trycloudflare\.com/;

/**
 * `cloudflared` needs a moment after starting to register the tunnel with
 * Cloudflare's edge and print its URL — polling beats a single read, which
 * would race a tunnel that backgrounded a heartbeat behind it.
 */
async function readTunnelUrl(logPath: string): Promise<string | null> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      const contents = await readFile(logPath, "utf8");
      const match = TRYCLOUDFLARE_URL_PATTERN.exec(contents);
      if (match) return match[0];
    } catch {
      // Not written yet, or the command never started a tunnel — either way,
      // keep polling until the budget below runs out rather than fail the
      // whole deploy over a log file that just hasn't appeared yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return null;
}

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
}):
  | { readonly action: "declare" | "reissue" }
  | { readonly action: "refuse"; readonly why: string } {
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
      if (input.kind === "cloudflare-tunnel" && !input.cloudflareTunnel) {
        return yield* new DeployError({
          code: "invalid-target",
          message: "cloudflare-tunnel deploy targets require a port.",
        });
      }
      if (input.kind === "cloudflare-pages" && !input.cloudflarePages) {
        return yield* new DeployError({
          code: "invalid-target",
          message: "cloudflare-pages deploy targets require an account id, project name and build output directory.",
        });
      }
      const now = yield* DateTime.now;
      const timestamp = DateTime.formatIso(DateTime.toUtc(now));

      // Registering the same name twice re-registers one target rather than
      // adding a second. An agent re-runs `deploy add` on every deploy — it has
      // no memory of the last one — and a fresh row each time meant two targets
      // racing for one port, and, worse, a second *deployment*: the registry
      // identifies a deployment by name, so a duplicate target starts a rival
      // that already reports to the stream, and the next deploy is refused for
      // taking numbers away from what is really its own previous self.
      const siblings = yield* repository
        .listTargets({ projectId: input.projectId })
        .pipe(Effect.mapError(repositoryError("Failed to read deploy targets.")));
      const existing = siblings.find((candidate) => candidate.name === input.name);

      const target: DeployTarget = {
        id: existing?.id ?? DeployTargetId.make(`deploy-target:${crypto.randomUUID()}`),
        projectId: input.projectId,
        tenantId: existing?.tenantId ?? null,
        name: input.name,
        kind: input.kind,
        command: input.command,
        ssh: input.ssh ?? null,
        cloudflareTunnel: input.cloudflareTunnel ?? null,
        cloudflarePages: input.cloudflarePages ?? null,
        createdAt: existing?.createdAt ?? timestamp,
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

      const tunnelLogPath =
        target.kind === "cloudflare-tunnel" ? join(input.workspaceRoot, TUNNEL_LOG_FILE_NAME) : null;
      // Truncated before the command runs, not just excluded-by-pattern at
      // read time: a redeploy appends to the same path (the command's own
      // `>>` redirect, declared in its integration prompt), so a stale
      // success or failure line from the PREVIOUS run is otherwise still in
      // the file when this run's tunnel starts.
      if (tunnelLogPath !== null) {
        yield* Effect.promise(() => writeFile(tunnelLogPath, "").catch(() => undefined));
      }

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
              ...(tunnelLogPath !== null ? { [TUNNEL_LOG_ENV_VAR]: tunnelLogPath } : {}),
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

      // Read after the command exits, matching the same "command backgrounds
      // it and returns" contract ssh/command targets already rely on — the
      // tunnel is expected to still be running, only the launcher has exited.
      const tunnelUrl =
        tunnelLogPath !== null && result.code === 0 ? yield* Effect.promise(() => readTunnelUrl(tunnelLogPath)) : null;

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
      //
      // Registered whether or not this run wired analytics. Deploying and then
      // deciding to measure is the normal order, and gating registration on
      // analytics meant the usual case — deploy, look at the project, then ask
      // for numbers — left nothing recorded to attach those numbers to, so the
      // infrastructure page had nothing to show for a project that was live.
      if (completed.status === "succeeded") {
        // `tunnelUrl` (discovered from the run itself) takes priority over a
        // caller-supplied `analytics.url`: for a cloudflare-tunnel target the
        // real address is only known after the tunnel actually starts, so a
        // caller could not have supplied the right one up front even if it tried.
        yield* deploymentRegistry.register({
          projectId: target.projectId,
          targetId: target.id,
          name: deploymentName,
          ...(tunnelUrl !== null
            ? { url: tunnelUrl }
            : input.analytics?.url !== undefined
              ? { url: input.analytics.url }
              : {}),
          status: "live",
          lastRunId: completed.id,
          // Omitted, not empty, when this run wired nothing: `register` reads an
          // absent `streams` as "leave them alone" and an empty one as "clear
          // them", so passing [] would make a plain redeploy silently unwire the
          // analytics an earlier run had attached.
          ...(input.analytics !== undefined ? { streams: [input.analytics.stream] } : {}),
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
