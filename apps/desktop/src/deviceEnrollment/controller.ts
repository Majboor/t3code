/**
 * Driving one enrollment from "Connect" to a stored credential.
 *
 * This is the impure half: timers, a browser being opened, a credential landing
 * on disk. Every decision it makes it delegates to `machine.ts`, so what is left
 * here is scheduling and side effects — which is deliberate, because the
 * scheduling is the part that cannot be unit-tested honestly and the decisions
 * are the part that must be.
 *
 * Two independent things can end a run, and both are needed. The poll loop ends
 * it when the server answers; the deadline timer ends it when the server never
 * does. Without the second, an unreachable service leaves "waiting for
 * approval" on screen forever — which is precisely the failure this feature was
 * asked to avoid, and it is the failure that only shows up when the network is
 * bad enough that nobody was testing.
 *
 * Every side effect is injected. `openExternal` and the credential write are the
 * two things this module does that reach outside the process, and both are
 * passed in so a test can drive the whole flow without Electron.
 *
 * @module DeviceEnrollment
 */

import type { EnrollmentClient } from "./client.ts";
import {
  createInitialDeviceEnrollmentState,
  isTerminalEnrollmentPhase,
  nextEnrollmentPollDelayMs,
  reduceEnrollmentOnCollectFailure,
  reduceEnrollmentOnCollectStart,
  reduceEnrollmentOnCollected,
  reduceEnrollmentOnCreated,
  reduceEnrollmentOnDeadline,
  reduceEnrollmentOnPollFailure,
  reduceEnrollmentOnRequestFailure,
  reduceEnrollmentOnRequestStart,
  reduceEnrollmentOnRestart,
  reduceEnrollmentOnStatus,
  type DeviceEnrollmentState,
} from "./machine.ts";
import type { CollectedEnrollment } from "./types.ts";

export interface DeviceEnrollmentControllerOptions {
  readonly client: EnrollmentClient;
  readonly deviceLabel: string;
  readonly devicePlatform: string;
  readonly openExternal: (url: string) => void;
  /**
   * Stores the credential and registers this machine. Throwing is meaningful:
   * a credential that could not be persisted has not connected anything, and
   * reporting success would leave a signed-out app claiming to be signed in.
   */
  readonly persist: (credential: CollectedEnrollment) => Promise<void>;
  readonly onState: (state: DeviceEnrollmentState) => void;
  readonly now?: () => number;
  readonly log?: (message: string) => void;
}

export interface DeviceEnrollmentController {
  readonly getState: () => DeviceEnrollmentState;
  /** Requests a code and opens the browser. Ignored while a run is already live. */
  readonly start: () => void;
  /** Abandons the current code and asks for a fresh one. */
  readonly restart: () => void;
  /** Reopens the approval page for the code already in flight. */
  readonly openApprovalPage: () => void;
  /**
   * The browser saying it is done. Returns whether the link matched the run in
   * flight — a link naming any other code is somebody else's machine.
   */
  readonly handleApprovalCallback: (code: string) => boolean;
  readonly dispose: () => void;
}

export function createDeviceEnrollmentController(
  options: DeviceEnrollmentControllerOptions,
): DeviceEnrollmentController {
  const now = options.now ?? (() => Date.now());
  const log = options.log ?? (() => {});

  let state = createInitialDeviceEnrollmentState();
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  /**
   * Invalidates work belonging to an abandoned run. Restarting mid-flight is
   * ordinary — someone waits, gives up, clicks "Start over" — and without this
   * the old run's in-flight response would land on the new run's state and
   * report the previous code's verdict.
   */
  let runId = 0;

  const clearTimers = (): void => {
    if (pollTimer !== null) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
    if (deadlineTimer !== null) {
      clearTimeout(deadlineTimer);
      deadlineTimer = null;
    }
  };

  const commit = (next: DeviceEnrollmentState): void => {
    if (state === next) {
      return;
    }
    state = next;
    options.onState(state);
    if (isTerminalEnrollmentPhase(state.phase)) {
      clearTimers();
    }
  };

  const armDeadline = (): void => {
    if (deadlineTimer !== null) {
      clearTimeout(deadlineTimer);
      deadlineTimer = null;
    }
    if (state.expiresAtMs === null) {
      return;
    }
    const remaining = Math.max(0, state.expiresAtMs - now());
    const generation = runId;
    deadlineTimer = setTimeout(() => {
      if (disposed || generation !== runId) return;
      commit(reduceEnrollmentOnDeadline(state, now()));
    }, remaining);
  };

  const schedulePoll = (): void => {
    if (pollTimer !== null) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
    if (disposed || isTerminalEnrollmentPhase(state.phase) || state.code === null) {
      return;
    }

    const delay = nextEnrollmentPollDelayMs({
      pollAttempt: state.pollAttempt,
      expiresAtMs: state.expiresAtMs,
      nowMs: now(),
    });
    if (delay === null) {
      commit(reduceEnrollmentOnDeadline(state, now()));
      return;
    }

    const generation = runId;
    pollTimer = setTimeout(() => {
      if (disposed || generation !== runId) return;
      void poll(generation);
    }, delay);
  };

  const collect = async (generation: number, code: string): Promise<void> => {
    commit(reduceEnrollmentOnCollectStart(state, now()));
    if (generation !== runId || isTerminalEnrollmentPhase(state.phase)) {
      return;
    }

    let result: Awaited<ReturnType<EnrollmentClient["collect"]>>;
    try {
      result = await options.client.collect(code);
    } catch (error) {
      if (disposed || generation !== runId) return;
      commit(reduceEnrollmentOnPollFailure(state, describe(error), now()));
      schedulePoll();
      return;
    }
    if (disposed || generation !== runId) return;

    if (result.outcome === "not-ready") {
      commit(
        reduceEnrollmentOnCollectFailure(
          state,
          { retryable: true, message: "Still waiting for approval." },
          now(),
        ),
      );
      schedulePoll();
      return;
    }

    if (result.outcome === "failed") {
      commit(
        reduceEnrollmentOnCollectFailure(
          state,
          { retryable: result.retryable, message: result.message },
          now(),
        ),
      );
      if (result.retryable) {
        schedulePoll();
      }
      return;
    }

    // The credential exists exactly once and the server has now spent it. If
    // storing it fails there is nothing to poll for and nothing to retry — the
    // only honest outcome is a visible failure and a fresh code.
    try {
      await options.persist(result.credential);
    } catch (error) {
      if (disposed || generation !== runId) return;
      log(`device enrollment failed to store credential message=${describe(error)}`);
      commit(
        reduceEnrollmentOnCollectFailure(
          state,
          {
            retryable: false,
            message: "This machine was approved but its credentials could not be saved.",
          },
          now(),
        ),
      );
      return;
    }
    if (disposed || generation !== runId) return;

    log("device enrollment connected");
    commit(reduceEnrollmentOnCollected(state));
  };

  const poll = async (generation: number): Promise<void> => {
    const code = state.code;
    if (code === null) {
      return;
    }

    let snapshot: Awaited<ReturnType<EnrollmentClient["read"]>>;
    try {
      snapshot = await options.client.read(code);
    } catch (error) {
      if (disposed || generation !== runId) return;
      commit(reduceEnrollmentOnPollFailure(state, describe(error), now()));
      schedulePoll();
      return;
    }
    if (disposed || generation !== runId) return;

    if (snapshot === null) {
      commit(reduceEnrollmentOnPollFailure(state, "The service sent an unreadable answer.", now()));
      schedulePoll();
      return;
    }

    commit(reduceEnrollmentOnStatus(state, snapshot.status, now()));
    if (isTerminalEnrollmentPhase(state.phase)) {
      return;
    }
    if (state.phase === "approved") {
      await collect(generation, code);
      return;
    }
    schedulePoll();
  };

  const begin = async (generation: number): Promise<void> => {
    let created: Awaited<ReturnType<EnrollmentClient["create"]>>;
    try {
      created = await options.client.create({
        deviceLabel: options.deviceLabel,
        devicePlatform: options.devicePlatform,
      });
    } catch (error) {
      if (disposed || generation !== runId) return;
      log(`device enrollment request failed message=${describe(error)}`);
      commit(reduceEnrollmentOnRequestFailure(state, describe(error)));
      return;
    }
    if (disposed || generation !== runId) return;

    commit(reduceEnrollmentOnCreated(state, created));
    armDeadline();
    log(`device enrollment opened approval page expiresAtMs=${created.expiresAtMs}`);
    options.openExternal(created.approveUrl);
    schedulePoll();
  };

  const start = (): void => {
    if (disposed) return;
    // A live run is not restarted by a second click. Doing so would abandon a
    // code the person may be mid-way through approving in another window.
    if (state.phase !== "idle" && !isTerminalEnrollmentPhase(state.phase)) {
      return;
    }
    clearTimers();
    runId += 1;
    const generation = runId;
    commit(reduceEnrollmentOnRequestStart(state));
    void begin(generation);
  };

  return {
    getState: () => state,
    start,
    restart: () => {
      if (disposed) return;
      clearTimers();
      runId += 1;
      commit(reduceEnrollmentOnRestart());
      start();
    },
    openApprovalPage: () => {
      if (state.approveUrl) {
        options.openExternal(state.approveUrl);
      }
    },
    handleApprovalCallback: (code) => {
      if (disposed || state.code === null || state.code !== code) {
        return false;
      }
      if (isTerminalEnrollmentPhase(state.phase)) {
        return true;
      }
      // The link is a nudge, never evidence. It only collapses the backoff so
      // the next question is asked immediately; the answer still comes from the
      // server, which is the only thing that knows whether anyone approved.
      log("device enrollment nudged by deep link");
      const generation = runId;
      if (pollTimer !== null) {
        clearTimeout(pollTimer);
        pollTimer = null;
      }
      void poll(generation);
      return true;
    },
    dispose: () => {
      disposed = true;
      clearTimers();
    },
  };
}

function describe(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return "The service could not be reached.";
}
