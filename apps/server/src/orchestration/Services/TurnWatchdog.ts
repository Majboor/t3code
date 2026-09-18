/**
 * TurnWatchdog - Stuck-turn detection and recovery service interface.
 *
 * Periodically scans the orchestration read model for turns that are stuck
 * in the `running` state with no forward progress (no new thread activity)
 * and nothing pending on a human (no open approval or user-input request).
 * When one is found it is force-ended through the same command paths a
 * user-initiated Stop already uses, with an honest error surfaced on the
 * thread so the user knows what happened and can resend.
 *
 * @module TurnWatchdog
 */
import { Context } from "effect";
import type { Effect, Scope } from "effect";

/**
 * TurnWatchdogShape - Service API for turn watchdog lifecycle.
 */
export interface TurnWatchdogShape {
  /**
   * Start the background turn watchdog within the provided scope.
   *
   * The returned effect must be run in a scope so the sweep loop fiber can
   * be finalized on shutdown.
   */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;

  /**
   * Runs a single sweep over the current read model synchronously.
   *
   * Exposed separately from `start` so tests can trigger a deterministic
   * sweep (after advancing a `TestClock`) without depending on the
   * scheduled loop's timing.
   */
  readonly sweepOnce: Effect.Effect<void>;
}

/**
 * TurnWatchdog - Service tag for the stuck-turn watchdog.
 */
export class TurnWatchdog extends Context.Service<TurnWatchdog, TurnWatchdogShape>()(
  "t3/orchestration/Services/TurnWatchdog",
) {}
