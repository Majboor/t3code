/**
 * abandonedTurnClosure - Honest closure for a turn whose provider session
 * ended before the turn itself reached a normal terminal state.
 *
 * `projection_turns` rows are only closed by three domain events:
 * `thread.message-sent` (a final assistant message), `thread.turn-interrupt-
 * requested`, or `thread.turn-diff-completed` (see ProjectionPipeline.ts
 * applyThreadTurnsProjection). A `thread.session-set` event that moves
 * `session.status` away from `"running"` is *not* one of those -- the
 * projector only touches `projection_turns` when the incoming status *is*
 * `"running"` -- so any code path that ends a session (process crash/exit,
 * an explicit stop, or a runtime error) while a turn is still `running` on
 * it leaves that turn's row `running` forever, with no live session behind
 * it to ever finish it.
 *
 * This module gives every such session-ending path one honest, shared way
 * to close the abandoned turn out: append a clear error activity, then
 * dispatch the exact same `thread.turn.interrupt` domain command a
 * user-initiated Stop (and TurnWatchdog's own stuck-turn recovery) already
 * uses, so the turn reaches a real terminal state (`interrupted`,
 * `completedAt` set) through the same path instead of a second, bespoke
 * closure mechanism. It intentionally does *not* touch `thread.session`
 * itself -- callers are already in the middle of transitioning the session
 * to its own terminal status and dispatch that separately -- and does not
 * call into `ProviderService.stopSession`, since the session is already
 * gone by the time these paths run.
 *
 * @module abandonedTurnClosure
 */
import { CommandId, EventId, type ThreadId, type TurnId } from "@t3tools/contracts";
import { Effect } from "effect";

import type { OrchestrationEngineShape } from "./Services/OrchestrationEngine.ts";

/**
 * Deliberately distinct from TurnWatchdog's "stopped responding for N
 * minutes" wording: that phrasing implies a timeout on a session that is
 * still alive. Here the session itself is gone, not silently idle.
 */
export const ABANDONED_TURN_MESSAGE =
  "The session ended before this turn finished. You can send your message again.";

const abandonedTurnCommandId = (threadId: ThreadId, turnId: TurnId, tag: string): CommandId =>
  CommandId.make(`turn-abandoned:${threadId}:${turnId}:${tag}:${crypto.randomUUID()}`);

export interface CloseAbandonedTurnInput {
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
  /** ISO timestamp to stamp on the activity/command; caller-supplied so tests can control it. */
  readonly nowIso: string;
}

/**
 * Appends the honest "session ended" error activity for an abandoned turn.
 * Split out from `interruptAbandonedTurn` so a caller that already produced
 * its own honest activity for the same event (e.g. a genuine `runtime.error`
 * event, which already turns into a `runtime.error` activity with the real
 * provider error message via `runtimeEventToActivities`) can close the turn
 * out without appending a second, redundant error bubble.
 */
export const appendAbandonedTurnActivity = (
  orchestrationEngine: OrchestrationEngineShape,
  input: CloseAbandonedTurnInput,
) => {
  const { threadId, turnId, nowIso } = input;
  return orchestrationEngine
    .dispatch({
      type: "thread.activity.append",
      commandId: abandonedTurnCommandId(threadId, turnId, "activity-append"),
      threadId,
      activity: {
        id: EventId.make(`turn-abandoned:${threadId}:${turnId}:${crypto.randomUUID()}`),
        tone: "error",
        kind: "runtime.error",
        summary: "Runtime error",
        payload: { message: ABANDONED_TURN_MESSAGE },
        turnId,
        createdAt: nowIso,
      },
      createdAt: nowIso,
    })
    .pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("turn.abandoned.activity-append-failed", {
          threadId,
          turnId,
          cause,
        }),
      ),
    );
};

/**
 * Dispatches the same `thread.turn.interrupt` domain command a user-
 * initiated Stop already uses, closing the turn's `projection_turns` row
 * out of `"running"` into a real terminal state (`interrupted`,
 * `completedAt` set). Safe to call more than once for the same turn -- the
 * projector just re-upserts an `interrupted` row -- so callers should not
 * gate this on whether it "already ran".
 */
export const interruptAbandonedTurn = (
  orchestrationEngine: OrchestrationEngineShape,
  input: CloseAbandonedTurnInput,
) => {
  const { threadId, turnId, nowIso } = input;
  return orchestrationEngine
    .dispatch({
      type: "thread.turn.interrupt",
      commandId: abandonedTurnCommandId(threadId, turnId, "turn-interrupt"),
      threadId,
      turnId,
      createdAt: nowIso,
    })
    .pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("turn.abandoned.turn-interrupt-failed", {
          threadId,
          turnId,
          cause,
        }),
      ),
    );
};

/**
 * Closes out a turn left `running` by a session that ended without it: the
 * honest error activity, then the terminal-state interrupt. Use this when
 * nothing else already appended an honest activity for the same event; use
 * `interruptAbandonedTurn` alone when one already has (see
 * `appendAbandonedTurnActivity`'s doc comment).
 */
export const closeAbandonedTurn = (
  orchestrationEngine: OrchestrationEngineShape,
  input: CloseAbandonedTurnInput,
) =>
  Effect.gen(function* () {
    yield* appendAbandonedTurnActivity(orchestrationEngine, input);
    yield* interruptAbandonedTurn(orchestrationEngine, input);
    yield* Effect.logInfo("turn.abandoned.closed", {
      threadId: input.threadId,
      turnId: input.turnId,
    });
  });
