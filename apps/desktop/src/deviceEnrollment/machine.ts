/**
 * The state of one machine trying to join an account, as a pure reducer.
 *
 * The server owns the rules about whether an enrollment may proceed
 * (`apps/server/src/deviceEnrollment/decideEnrollment.ts`); this owns what the
 * app believes and therefore what the person is looking at. Keeping it separate
 * from the timers and the HTTP is what makes "waiting", "denied" and "expired"
 * testable states rather than branches inside a polling loop — and the failure
 * this whole flow exists to avoid is a spinner that never resolves, which is
 * precisely what an untested polling loop produces the first time a response
 * shape surprises it.
 *
 * Time is an input everywhere it matters. Expiry is not something this module
 * reads off a clock, because the deadline case is the one worth testing exactly
 * and a module that calls `Date.now()` cannot be asked about it.
 *
 * @module DeviceEnrollment
 */

import type { EnrollmentStatus } from "./types.ts";

/**
 * What the person is being told, and what the driver should do next.
 *
 * `approved` is deliberately visible even though it lasts a moment. Somebody
 * who has just clicked Connect in their browser and switched back deserves to
 * see that the click landed, rather than the same "waiting" they left behind
 * while the credential is fetched.
 *
 * `failed` is separate from `denied` and `expired` because they mean opposite
 * things to the reader: one is "the network or the server let us down, try
 * again", the others are "this is over, and here is why".
 */
export type DeviceEnrollmentPhase =
  | "idle"
  | "requesting"
  | "waiting"
  | "approved"
  | "collecting"
  | "connected"
  | "denied"
  | "expired"
  | "failed";

export interface DeviceEnrollmentState {
  readonly phase: DeviceEnrollmentPhase;
  readonly code: string | null;
  /** Where the browser was sent. Kept so the page can be reopened without a new code. */
  readonly approveUrl: string | null;
  readonly expiresAtMs: number | null;
  /**
   * Drives the backoff. Counts polls rather than failures, so a long, healthy
   * wait for a person to click still slows down instead of hammering the server
   * once a second for ten minutes.
   */
  readonly pollAttempt: number;
  /**
   * Counts only consecutive *failed* polls, and resets on any answer at all.
   * Separate from `pollAttempt` because otherwise a patient user waiting nine
   * minutes would trip the give-up ceiling that exists to catch a dead network.
   */
  readonly consecutiveFailures: number;
  /** Human-readable detail for the current phase; `null` when there is nothing to add. */
  readonly message: string | null;
  readonly canRetry: boolean;
}

/**
 * How many polls in a row may fail before the app stops claiming to be waiting.
 *
 * A transient failure is normal — laptops sleep, wifi drops, servers restart —
 * so a single one must not tear down a flow the person is mid-way through. But
 * failing forever while showing "waiting for approval" is the lie this ceiling
 * exists to prevent.
 */
export const MAX_CONSECUTIVE_ENROLLMENT_POLL_FAILURES = 8;

const FIRST_POLL_DELAY_MS = 1_000;
const POLL_BACKOFF_FACTOR = 1.6;
const MAX_POLL_DELAY_MS = 8_000;

/** Phases from which nothing further happens without the person acting. */
export function isTerminalEnrollmentPhase(phase: DeviceEnrollmentPhase): boolean {
  return phase === "connected" || phase === "denied" || phase === "expired" || phase === "failed";
}

export function createInitialDeviceEnrollmentState(): DeviceEnrollmentState {
  return {
    phase: "idle",
    code: null,
    approveUrl: null,
    expiresAtMs: null,
    pollAttempt: 0,
    consecutiveFailures: 0,
    message: null,
    canRetry: false,
  };
}

/**
 * How long to wait before the next poll, or `null` when there must not be one.
 *
 * Returning `null` at the deadline rather than a delay is what stops the loop
 * on its own terms. A driver that only checked expiry when a *response* came
 * back would keep a dead enrollment alive for as long as the server stayed
 * unreachable, which is exactly when the check matters most.
 *
 * The final wait is clipped to the deadline so the last poll lands just inside
 * it — without the clip, a code expiring in two seconds would be given an eight
 * second sleep and its approval would be noticed only after it stopped counting.
 */
export function nextEnrollmentPollDelayMs(input: {
  readonly pollAttempt: number;
  readonly expiresAtMs: number | null;
  readonly nowMs: number;
}): number | null {
  const { pollAttempt, expiresAtMs, nowMs } = input;
  const uncapped = FIRST_POLL_DELAY_MS * POLL_BACKOFF_FACTOR ** Math.max(0, pollAttempt);
  const delay = Math.round(Math.min(MAX_POLL_DELAY_MS, uncapped));

  if (expiresAtMs === null) {
    return delay;
  }
  const remaining = expiresAtMs - nowMs;
  if (remaining <= 0) {
    return null;
  }
  return Math.min(delay, remaining);
}

/** Whether the deadline on the current enrollment has passed. */
export function hasEnrollmentExpired(state: DeviceEnrollmentState, nowMs: number): boolean {
  return state.expiresAtMs !== null && nowMs >= state.expiresAtMs;
}

function expiredState(state: DeviceEnrollmentState): DeviceEnrollmentState {
  return {
    ...state,
    phase: "expired",
    message: "This request timed out. Start over to connect this machine.",
    canRetry: true,
  };
}

/**
 * Starts a request for a code, discarding whatever came before.
 *
 * The previous state is taken and ignored on purpose — hence the underscore.
 * The parameter stays so this reads like every other reducer here, but nothing
 * carries over: a retry asks for a *fresh* code, because reusing one after a
 * denial or an expiry would ask the server to reconsider a decision it has
 * already made and recorded as final.
 */
export function reduceEnrollmentOnRequestStart(
  _previous: DeviceEnrollmentState,
): DeviceEnrollmentState {
  return {
    ...createInitialDeviceEnrollmentState(),
    phase: "requesting",
  };
}

export function reduceEnrollmentOnRequestFailure(
  state: DeviceEnrollmentState,
  message: string,
): DeviceEnrollmentState {
  return {
    ...state,
    phase: "failed",
    message,
    canRetry: true,
  };
}

export function reduceEnrollmentOnCreated(
  state: DeviceEnrollmentState,
  created: {
    readonly code: string;
    readonly approveUrl: string;
    readonly expiresAtMs: number;
  },
): DeviceEnrollmentState {
  return {
    ...state,
    phase: "waiting",
    code: created.code,
    approveUrl: created.approveUrl,
    expiresAtMs: created.expiresAtMs,
    pollAttempt: 0,
    consecutiveFailures: 0,
    message: null,
    canRetry: false,
  };
}

/**
 * Folds a status read from the server into what the app believes.
 *
 * Expiry is evaluated before the reported status, matching the server's own
 * ordering: nothing sweeps enrollments on a timer, so a row can still read
 * `pending` long after it stopped being usable, and believing that status would
 * leave the app waiting on a code that can never be collected.
 *
 * Late responses that arrive after a terminal phase are dropped. A `denied`
 * that lands a moment after the user restarted must not overwrite the new
 * attempt with the old one's verdict.
 */
export function reduceEnrollmentOnStatus(
  state: DeviceEnrollmentState,
  status: EnrollmentStatus,
  nowMs: number,
): DeviceEnrollmentState {
  if (isTerminalEnrollmentPhase(state.phase)) {
    return state;
  }
  if (hasEnrollmentExpired(state, nowMs)) {
    return expiredState(state);
  }

  const answered = { ...state, consecutiveFailures: 0 };

  switch (status) {
    case "pending": {
      return {
        ...answered,
        phase: "waiting",
        pollAttempt: state.pollAttempt + 1,
        message: null,
      };
    }
    case "approved": {
      // The wait is over, so the backoff that paced it is reset: collection
      // should happen now, not after the eight-second sleep the last poll earned.
      return {
        ...answered,
        phase: "approved",
        pollAttempt: 0,
        message: null,
      };
    }
    case "denied": {
      return {
        ...answered,
        phase: "denied",
        message: "This machine was not approved.",
        canRetry: true,
      };
    }
    case "expired": {
      return expiredState(answered);
    }
    case "collected": {
      // The credential is handed over exactly once and this app does not have
      // it, so something else spent this code. Saying so is the only honest
      // option: retrying cannot recover it, and pretending to still be waiting
      // would hang forever.
      return {
        ...answered,
        phase: "failed",
        message: "This request was already used. Start over to connect this machine.",
        canRetry: true,
      };
    }
  }
}

/**
 * A poll that never got an answer.
 *
 * The phase is held rather than changed, because one unanswered request says
 * nothing about whether the person approved — only that we could not ask. The
 * phase only breaks once the failures stack up past the ceiling, at which point
 * continuing to display "waiting for approval" would be a claim the app cannot
 * support.
 */
export function reduceEnrollmentOnPollFailure(
  state: DeviceEnrollmentState,
  message: string,
  nowMs: number,
): DeviceEnrollmentState {
  if (isTerminalEnrollmentPhase(state.phase)) {
    return state;
  }
  if (hasEnrollmentExpired(state, nowMs)) {
    return expiredState(state);
  }

  const consecutiveFailures = state.consecutiveFailures + 1;
  if (consecutiveFailures >= MAX_CONSECUTIVE_ENROLLMENT_POLL_FAILURES) {
    return {
      ...state,
      phase: "failed",
      consecutiveFailures,
      message,
      canRetry: true,
    };
  }

  return {
    ...state,
    pollAttempt: state.pollAttempt + 1,
    consecutiveFailures,
    message: null,
  };
}

export function reduceEnrollmentOnCollectStart(
  state: DeviceEnrollmentState,
  nowMs: number,
): DeviceEnrollmentState {
  if (isTerminalEnrollmentPhase(state.phase)) {
    return state;
  }
  if (hasEnrollmentExpired(state, nowMs)) {
    return expiredState(state);
  }
  return { ...state, phase: "collecting", message: null };
}

/**
 * The credential is in hand. This is the only success, and it is terminal:
 * collection succeeds exactly once, so there is nothing left to poll for.
 */
export function reduceEnrollmentOnCollected(state: DeviceEnrollmentState): DeviceEnrollmentState {
  return {
    ...state,
    phase: "connected",
    message: null,
    canRetry: false,
  };
}

/**
 * Collection was refused. Distinct from a poll failure because the server
 * answered — it just said no, and "not yet approved" is the answer that means
 * keep waiting rather than give up.
 */
export function reduceEnrollmentOnCollectFailure(
  state: DeviceEnrollmentState,
  input: { readonly retryable: boolean; readonly message: string },
  nowMs: number,
): DeviceEnrollmentState {
  if (isTerminalEnrollmentPhase(state.phase)) {
    return state;
  }
  if (hasEnrollmentExpired(state, nowMs)) {
    return expiredState(state);
  }
  if (input.retryable) {
    return {
      ...state,
      phase: "waiting",
      pollAttempt: state.pollAttempt + 1,
      consecutiveFailures: 0,
      message: null,
    };
  }
  return {
    ...state,
    phase: "failed",
    message: input.message,
    canRetry: true,
  };
}

/**
 * The deadline arriving on its own, with no request in flight.
 *
 * This is the path that matters when the network is down: without a timer that
 * can end the flow independently of a response, an unreachable server leaves
 * the app waiting on a code the server has already stopped honouring.
 */
export function reduceEnrollmentOnDeadline(
  state: DeviceEnrollmentState,
  nowMs: number,
): DeviceEnrollmentState {
  if (isTerminalEnrollmentPhase(state.phase) || state.phase === "idle") {
    return state;
  }
  return hasEnrollmentExpired(state, nowMs) ? expiredState(state) : state;
}

/**
 * Back to the beginning, discarding the old code entirely.
 *
 * Every terminal state offers this, which is the difference between a flow
 * someone can finish and a dead screen they have to quit the app to escape.
 */
export function reduceEnrollmentOnRestart(): DeviceEnrollmentState {
  return createInitialDeviceEnrollmentState();
}
