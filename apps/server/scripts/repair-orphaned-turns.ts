#!/usr/bin/env node

/**
 * One-off maintenance script for the orphaned-turn data-consistency bug: a
 * `projection_turns` row left `state = 'running'`, `completed_at IS NULL`
 * forever because the provider session it belonged to ended (process crash,
 * an explicit stop, or a runtime error) without going through a normal turn-
 * completion path. `apps/server/src/orchestration/abandonedTurnClosure.ts`
 * fixes this going forward at the source (ProviderRuntimeIngestion.ts /
 * ProviderCommandReactor.ts); this script closes out the rows that were
 * already stuck before that fix landed.
 *
 * A row only counts as orphaned when there is genuinely no live session
 * behind it -- i.e. `projection_thread_sessions` for that thread either has
 * no row, isn't `status = 'running'`, or its `active_turn_id` no longer
 * points at that turn. A turn that is legitimately still running (its
 * thread's session is `running` with `active_turn_id` pointing right back at
 * it) is never touched, matching TurnWatchdog's own "don't second-guess a
 * live session" rule.
 *
 * Closure reuses the exact same honest path
 * `apps/server/src/orchestration/abandonedTurnClosure.ts` gives every real-
 * time session-ending path: an honest "the session ended before this turn
 * finished" error activity, then the same `thread.turn.interrupt` domain
 * command a user-initiated Stop (and TurnWatchdog's own recovery) already
 * uses. It goes through the real `OrchestrationEngineService` -- append an
 * event, project it -- rather than patching the `projection_turns` row
 * directly with raw SQL, so the fix is durable across a future full replay
 * of the event log, not just a one-time edit of a derived table.
 *
 * Idempotent: once a row is closed its `state` is no longer `'running'`, so
 * finding orphaned rows naturally excludes it on a re-run. Safe to run
 * against a database with other, genuinely-still-active `running` turns --
 * those are excluded by construction, never touched.
 *
 * Usage:
 *   node scripts/repair-orphaned-turns.ts --db /srv/t3/data/userdata/state.sqlite
 *     Dry run (default): lists every orphaned row found, changes nothing.
 *
 *   node scripts/repair-orphaned-turns.ts --db /srv/t3/data/userdata/state.sqlite --apply
 *     Closes every orphaned row found, then reports a before/after count.
 *
 * Follows this package's `../scripts/promptbar-eval.ts` convention: a
 * standalone `Command.make` + `NodeRuntime.runMain` script, not wired into
 * the big `src/cli.ts` `t3` CLI, since this is a maintenance/repair tool,
 * not a shipped end-user command.
 */
import nodePath from "node:path";

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId, TurnId } from "@t3tools/contracts";
import { Effect, Layer } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { type ServerConfigShape, ServerConfig } from "../src/config.ts";
import { closeAbandonedTurn } from "../src/orchestration/abandonedTurnClosure.ts";
import { OrchestrationLayerLive } from "../src/orchestration/runtimeLayer.ts";
import { OrchestrationEngineService } from "../src/orchestration/Services/OrchestrationEngine.ts";
import { makeSqlitePersistenceLive } from "../src/persistence/Layers/Sqlite.ts";
import { RepositoryIdentityResolverLive } from "../src/project/Layers/RepositoryIdentityResolver.ts";

interface OrphanedTurnRow {
  readonly threadId: string;
  readonly turnId: string;
  readonly state: string;
  readonly requestedAt: string;
  readonly sessionStatus: string | null;
  readonly sessionActiveTurnId: string | null;
}

const findOrphanedTurns = Effect.fn("findOrphanedTurns")(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<OrphanedTurnRow>`
    SELECT
      t.thread_id AS "threadId",
      t.turn_id AS "turnId",
      t.state AS "state",
      t.requested_at AS "requestedAt",
      s.status AS "sessionStatus",
      s.active_turn_id AS "sessionActiveTurnId"
    FROM projection_turns t
    LEFT JOIN projection_thread_sessions s ON s.thread_id = t.thread_id
    WHERE t.state = 'running'
      AND t.turn_id IS NOT NULL
      AND t.completed_at IS NULL
      AND (
        s.thread_id IS NULL
        OR s.status <> 'running'
        OR s.active_turn_id IS NULL
        OR s.active_turn_id <> t.turn_id
      )
    ORDER BY t.requested_at ASC
  `;
});

/**
 * A minimal-but-valid `ServerConfigShape`, derived straight from `--db`
 * rather than through `deriveServerPaths`/`baseDir` (which assumes a
 * `<baseDir>/userdata/state.sqlite` layout) so this works for any db path,
 * not just one that happens to sit in a directory literally named
 * "userdata". Every field this script's own commands actually exercise
 * (`thread.activity.append`, `thread.turn.interrupt`) is thread/turn-scoped
 * and never reads `ServerConfig`; the paths below only matter because
 * `OrchestrationProjectionPipelineLive` requires a `ServerConfig` in scope
 * to construct at all (it reads `attachmentsDir` for `thread.deleted`/
 * `thread.reverted` attachment cleanup -- events this script never emits).
 */
function buildServerConfig(dbPath: string): ServerConfigShape {
  const stateDir = nodePath.dirname(dbPath);
  const baseDir = nodePath.dirname(stateDir);
  const logsDir = nodePath.join(stateDir, "logs");
  return {
    logLevel: "Error",
    traceMinLevel: "Info",
    traceTimingEnabled: false,
    traceBatchWindowMs: 200,
    traceMaxBytes: 10 * 1024 * 1024,
    traceMaxFiles: 10,
    otlpTracesUrl: undefined,
    otlpMetricsUrl: undefined,
    otlpExportIntervalMs: 10_000,
    otlpServiceName: "t3-server-repair-orphaned-turns",
    cwd: process.cwd(),
    baseDir,
    stateDir,
    dbPath,
    keybindingsConfigPath: nodePath.join(stateDir, "keybindings.json"),
    settingsPath: nodePath.join(stateDir, "settings.json"),
    providerStatusCacheDir: nodePath.join(baseDir, "caches"),
    worktreesDir: nodePath.join(baseDir, "worktrees"),
    attachmentsDir: nodePath.join(stateDir, "attachments"),
    logsDir,
    serverLogPath: nodePath.join(logsDir, "server.log"),
    serverTracePath: nodePath.join(logsDir, "server.trace.ndjson"),
    providerLogsDir: nodePath.join(logsDir, "provider"),
    providerEventLogPath: nodePath.join(logsDir, "provider", "events.log"),
    terminalLogsDir: nodePath.join(logsDir, "terminals"),
    anonymousIdPath: nodePath.join(stateDir, "anonymous-id"),
    environmentIdPath: nodePath.join(stateDir, "environment-id"),
    serverRuntimeStatePath: nodePath.join(stateDir, "server-runtime.json"),
    secretsDir: nodePath.join(stateDir, "secrets"),
    mode: "web",
    autoBootstrapProjectFromCwd: false,
    logWebSocketEvents: false,
    port: 0,
    host: undefined,
    desktopBootstrapToken: undefined,
    publishedBeyondLoopback: false,
    operatorProviderFallback: false,
    unsafeNoAuth: false,
    basicAuthUsername: undefined,
    basicAuthPassword: undefined,
    basicAuthRealm: "T3 Code",
    supabaseProjectUrl: undefined,
    supabaseAnonKey: undefined,
    supabaseJwtAudience: undefined,
    supabaseServiceRoleSecretName: undefined,
    localPasswordAuth: false,
    workspaceSource: "this-server",
    hubUrl: undefined,
    staticDir: undefined,
    devUrl: undefined,
    noBrowser: true,
    startupPresentation: "browser",
  } satisfies ServerConfigShape;
}

const describeSession = (row: OrphanedTurnRow): string =>
  row.sessionStatus === null
    ? "no session row for this thread"
    : `session status="${row.sessionStatus}", session active turn=${row.sessionActiveTurnId ?? "none"}`;

const repairOrphanedTurns = Effect.fn("repairOrphanedTurns")(function* (input: {
  readonly apply: boolean;
}) {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const candidates = yield* findOrphanedTurns();

  if (candidates.length === 0) {
    yield* Effect.log("[repair-orphaned-turns] No orphaned running turns found. Nothing to do.");
    return;
  }

  yield* Effect.log(
    `[repair-orphaned-turns] Found ${candidates.length} orphaned running turn(s)` +
      (input.apply ? ", closing them out:" : " (dry run -- pass --apply to close them out):"),
  );
  for (const row of candidates) {
    yield* Effect.log(
      `  thread=${row.threadId} turn=${row.turnId} requestedAt=${row.requestedAt} (${describeSession(row)})`,
    );
  }

  if (!input.apply) {
    return;
  }

  const nowIso = new Date().toISOString();
  yield* Effect.forEach(
    candidates,
    (row) =>
      closeAbandonedTurn(orchestrationEngine, {
        threadId: ThreadId.make(row.threadId),
        turnId: TurnId.make(row.turnId),
        nowIso,
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logError("[repair-orphaned-turns] failed to close a turn", {
            threadId: row.threadId,
            turnId: row.turnId,
            cause,
          }),
        ),
      ),
    { concurrency: 1 },
  );

  const remaining = yield* findOrphanedTurns();
  yield* Effect.log(
    `[repair-orphaned-turns] Closed ${candidates.length - remaining.length} of ${candidates.length}` +
      (remaining.length > 0
        ? `; ${remaining.length} still orphaned (see the errors above).`
        : "."),
  );
});

const command = Command.make(
  "repair-orphaned-turns",
  {
    db: Flag.string("db").pipe(
      Flag.withDescription(
        "Path to the server's SQLite state db (e.g. /srv/t3/data/userdata/state.sqlite).",
      ),
    ),
    apply: Flag.boolean("apply").pipe(
      Flag.withDefault(false),
      Flag.withDescription(
        "Actually close out the orphaned turns found. Without this, only reports what it would do.",
      ),
    ),
  },
  ({ db, apply }) => {
    // Same `sqlLayer` layer *value* provided into `orchestrationLayer` below
    // AND merged again at the top level, so Effect's layer memoization
    // shares one db/connection instead of standing up a second, disconnected
    // sqlite handle -- `findOrphanedTurns` needs direct `SqlClient` access
    // for its scan query; the orchestration engine needs the same db to
    // actually persist the closure.
    const sqlLayer = makeSqlitePersistenceLive(db);
    const orchestrationLayer = OrchestrationLayerLive.pipe(
      Layer.provide(RepositoryIdentityResolverLive),
      Layer.provide(sqlLayer),
    );
    return repairOrphanedTurns({ apply }).pipe(
      Effect.provide(
        Layer.mergeAll(orchestrationLayer, sqlLayer).pipe(
          Layer.provideMerge(Layer.succeed(ServerConfig, buildServerConfig(db))),
        ),
      ),
    );
  },
).pipe(
  Command.withDescription(
    "Close out projection_turns rows stuck at state='running' whose session already ended (no live session behind them). Dry run by default; pass --apply to actually close them.",
  ),
);

if (import.meta.main) {
  Command.run(command, { version: "0.0.0" }).pipe(
    Effect.scoped,
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
