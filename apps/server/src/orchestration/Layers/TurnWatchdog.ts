import {
  CommandId,
  EventId,
  type OrchestrationThread,
  type OrchestrationThreadActivity,
  type ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { Clock, Duration, Effect, Layer, Schedule } from "effect";

import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { TurnWatchdog, type TurnWatchdogShape } from "../Services/TurnWatchdog.ts";

/**
 * No new `projection_thread_activities` row for this long (and nothing
 * pending on a human) marks a `running` turn as stuck. Deliberately based on
 * *no new activity*, not on total turn runtime, so a long-but-progressing
 * turn (e.g. a slow build/deploy pack) is never killed.
 *
 * 5 minutes: comfortably longer than the gap between normal progress
 * signals (assistant deltas, tool lifecycle activities, plan updates all
 * append activities well inside that window for a live turn), while being
 * far short of the multi-hour silent hangs this watchdog exists to catch.
 */
export const DEFAULT_STALE_ACTIVITY_THRESHOLD_MS = 5 * 60 * 1000;
const DEFAULT_SWEEP_INTERVAL_MS = 60 * 1000;

const ENV_STALE_ACTIVITY_THRESHOLD_MS = "T3CODE_TURN_WATCHDOG_STALE_ACTIVITY_MS";
const ENV_SWEEP_INTERVAL_MS = "T3CODE_TURN_WATCHDOG_SWEEP_INTERVAL_MS";

function readPositiveIntEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export interface TurnWatchdogLiveOptions {
  /** No new activity for this many ms (with nothing pending on a human) marks a turn stuck. */
  readonly staleActivityThresholdMs?: number;
  /** How often the background sweep runs. */
  readonly sweepIntervalMs?: number;
}

function buildStuckTurnMessage(staleActivityThresholdMs: number): string {
  const minutes = Math.max(1, Math.round(staleActivityThresholdMs / 60_000));
  const unit = minutes === 1 ? "minute" : "minutes";
  return (
    `This turn stopped responding for over ${minutes} ${unit} with no activity ` +
    "and was automatically ended. You can send your message again."
  );
}

function extractRequestId(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const requestId = (payload as Record<string, unknown>).requestId;
  return typeof requestId === "string" ? requestId : null;
}

/**
 * True when the turn has an approval or user-input request that was opened
 * and never resolved — i.e. it is legitimately blocked on a human decision,
 * not stuck. Mirrors the open/close accounting the projection pipeline
 * already uses for pending-approval and pending-user-input counts
 * (see ProjectionPipeline.ts derivePendingUserInputCountFromActivities),
 * applied here to the in-memory read model's activity list.
 */
function isTurnAwaitingHuman(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  turnId: TurnId,
): boolean {
  const relevant = activities
    .filter((activity) => activity.turnId === turnId)
    .toSorted((left, right) => left.createdAt.localeCompare(right.createdAt));

  const openApprovalRequestIds = new Set<string>();
  const openUserInputRequestIds = new Set<string>();

  for (const activity of relevant) {
    const requestId = extractRequestId(activity.payload);
    if (requestId === null) continue;

    switch (activity.kind) {
      case "approval.requested":
        openApprovalRequestIds.add(requestId);
        break;
      case "approval.resolved":
        openApprovalRequestIds.delete(requestId);
        break;
      case "user-input.requested":
        openUserInputRequestIds.add(requestId);
        break;
      case "user-input.resolved":
        openUserInputRequestIds.delete(requestId);
        break;
      default:
        break;
    }
  }

  return openApprovalRequestIds.size > 0 || openUserInputRequestIds.size > 0;
}

/**
 * Latest known-progress timestamp (ms) for the given turn: the most recent
 * activity's `createdAt` if any exist, otherwise the turn's own started/
 * requested time, otherwise the session's `updatedAt` (set when the turn
 * started running). Returns `null` if nothing parseable is found.
 */
function latestProgressMs(thread: OrchestrationThread, turnId: TurnId): number | null {
  let latestActivityMs: number | null = null;
  for (const activity of thread.activities) {
    if (activity.turnId !== turnId) continue;
    const ms = Date.parse(activity.createdAt);
    if (Number.isNaN(ms)) continue;
    if (latestActivityMs === null || ms > latestActivityMs) {
      latestActivityMs = ms;
    }
  }
  if (latestActivityMs !== null) return latestActivityMs;

  if (thread.latestTurn?.turnId === turnId) {
    const fallbackIso = thread.latestTurn.startedAt ?? thread.latestTurn.requestedAt;
    const ms = Date.parse(fallbackIso);
    if (!Number.isNaN(ms)) return ms;
  }

  if (thread.session) {
    const ms = Date.parse(thread.session.updatedAt);
    if (!Number.isNaN(ms)) return ms;
  }

  return null;
}

const watchdogCommandId = (threadId: ThreadId, turnId: TurnId, tag: string): CommandId =>
  CommandId.make(`turn-watchdog:${threadId}:${turnId}:${tag}:${crypto.randomUUID()}`);

const makeTurnWatchdog = (options?: TurnWatchdogLiveOptions) =>
  Effect.gen(function* () {
    const orchestrationEngine = yield* OrchestrationEngineService;
    const providerService = yield* ProviderService;

    const staleActivityThresholdMs = Math.max(
      1,
      options?.staleActivityThresholdMs ??
        readPositiveIntEnv(ENV_STALE_ACTIVITY_THRESHOLD_MS) ??
        DEFAULT_STALE_ACTIVITY_THRESHOLD_MS,
    );
    const sweepIntervalMs = Math.max(
      1,
      options?.sweepIntervalMs ?? readPositiveIntEnv(ENV_SWEEP_INTERVAL_MS) ?? DEFAULT_SWEEP_INTERVAL_MS,
    );

    // Reuses the exact recovery path a user-initiated Stop already goes
    // through (see decider.ts "thread.turn.interrupt" and ChatView.tsx
    // onInterrupt), plus the same session-error / activity shape a genuine
    // provider failure already produces (see ProviderRuntimeIngestion.ts
    // handling of "runtime.error" and turn.completed state "failed").
    // No new terminal turn state is invented.
    const recoverStuckTurn = Effect.fn("recoverStuckTurn")(function* (input: {
      readonly thread: OrchestrationThread;
      readonly turnId: TurnId;
      readonly nowIso: string;
    }) {
      const { thread, turnId, nowIso } = input;
      const message = buildStuckTurnMessage(staleActivityThresholdMs);

      // 1) Flip the session out of "running" synchronously so the composer's
      // indefinite "Working for Xm Ys" spinner (keyed off session.status ===
      // "running" / activeTurnId) clears immediately, independent of whether
      // the underlying provider ever responds to a cancellation attempt.
      yield* orchestrationEngine
        .dispatch({
          type: "thread.session.set",
          commandId: watchdogCommandId(thread.id, turnId, "session-set"),
          threadId: thread.id,
          session: {
            threadId: thread.id,
            status: "error",
            providerName: thread.session?.providerName ?? null,
            runtimeMode: thread.session?.runtimeMode ?? "full-access",
            activeTurnId: null,
            lastError: message,
            updatedAt: nowIso,
          },
          createdAt: nowIso,
        })
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("turn.watchdog.session-set-failed", {
              threadId: thread.id,
              turnId,
              cause,
            }),
          ),
        );

      // 2) Append a genuine error activity using the exact same tone/kind/
      // payload shape ProviderRuntimeIngestion.runtimeEventToActivities
      // already produces for a real "runtime.error" event, so it renders
      // through the identical UI path as a real provider error.
      yield* orchestrationEngine
        .dispatch({
          type: "thread.activity.append",
          commandId: watchdogCommandId(thread.id, turnId, "activity-append"),
          threadId: thread.id,
          activity: {
            id: EventId.make(`turn-watchdog:${thread.id}:${turnId}:${crypto.randomUUID()}`),
            tone: "error",
            kind: "runtime.error",
            summary: "Runtime error",
            payload: { message },
            turnId,
            createdAt: nowIso,
          },
          createdAt: nowIso,
        })
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("turn.watchdog.activity-append-failed", {
              threadId: thread.id,
              turnId,
              cause,
            }),
          ),
        );

      // 3) Close out the turn itself through the same domain command a
      // user-initiated Stop dispatches (decider.ts "thread.turn.interrupt"),
      // so the turn's persisted record reaches a real terminal state instead
      // of staying "running" forever, and any listening provider-command
      // reactor still gets a best-effort chance to cancel in place.
      yield* orchestrationEngine
        .dispatch({
          type: "thread.turn.interrupt",
          commandId: watchdogCommandId(thread.id, turnId, "turn-interrupt"),
          threadId: thread.id,
          turnId,
          createdAt: nowIso,
        })
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("turn.watchdog.turn-interrupt-failed", {
              threadId: thread.id,
              turnId,
              cause,
            }),
          ),
        );

      // 4) Best-effort provider/subprocess cleanup, mirroring the exact
      // call ProviderSessionReaper already uses for idle sessions. Safe to
      // call even if no session/subprocess is still alive for this thread.
      yield* providerService.stopSession({ threadId: thread.id }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("turn.watchdog.stop-session-failed", {
            threadId: thread.id,
            turnId,
            cause,
          }),
        ),
      );

      yield* Effect.logInfo("turn.watchdog.turn-marked-stuck", {
        threadId: thread.id,
        turnId,
        staleActivityThresholdMs,
      });
    });

    const sweepOnce: TurnWatchdogShape["sweepOnce"] = Effect.gen(function* () {
      const readModel = yield* orchestrationEngine.getReadModel();
      const nowMs = yield* Clock.currentTimeMillis;
      const nowIso = new Date(nowMs).toISOString();

      for (const thread of readModel.threads) {
        const session = thread.session;
        if (!session || session.status !== "running" || session.activeTurnId === null) {
          continue;
        }
        const turnId = session.activeTurnId;

        if (isTurnAwaitingHuman(thread.activities, turnId)) {
          continue;
        }

        const referenceMs = latestProgressMs(thread, turnId);
        if (referenceMs === null) {
          continue;
        }

        const idleMs = nowMs - referenceMs;
        if (idleMs < staleActivityThresholdMs) {
          continue;
        }

        yield* recoverStuckTurn({ thread, turnId, nowIso }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("turn.watchdog.recover-failed", {
              threadId: thread.id,
              turnId,
              cause,
            }),
          ),
        );
      }
    });

    const start: TurnWatchdogShape["start"] = () =>
      Effect.gen(function* () {
        yield* Effect.forkScoped(
          sweepOnce.pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("turn.watchdog.sweep-failed", { cause }),
            ),
            Effect.repeat(Schedule.spaced(Duration.millis(sweepIntervalMs))),
          ),
        );

        yield* Effect.logInfo("turn.watchdog.started", {
          staleActivityThresholdMs,
          sweepIntervalMs,
        });
      });

    return {
      start,
      sweepOnce,
    } satisfies TurnWatchdogShape;
  });

export const makeTurnWatchdogLive = (options?: TurnWatchdogLiveOptions) =>
  Layer.effect(TurnWatchdog, makeTurnWatchdog(options));

export const TurnWatchdogLive = makeTurnWatchdogLive();
