import { describe, expect, it } from "vitest";

import {
  createInitialDeviceEnrollmentState,
  hasEnrollmentExpired,
  isTerminalEnrollmentPhase,
  MAX_CONSECUTIVE_ENROLLMENT_POLL_FAILURES,
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

const NOW = 1_700_000_000_000;
const TEN_MINUTES_MS = 10 * 60 * 1000;
const EXPIRES_AT = NOW + TEN_MINUTES_MS;

/** A freshly created enrollment, browser opened, nothing decided yet. */
function waiting(overrides: Partial<DeviceEnrollmentState> = {}): DeviceEnrollmentState {
  return {
    ...reduceEnrollmentOnCreated(createInitialDeviceEnrollmentState(), {
      code: "ABC123xyz",
      approveUrl: "https://app.logicpacks.io/devices/ABC123xyz",
      expiresAtMs: EXPIRES_AT,
    }),
    ...overrides,
  };
}

describe("the happy path", () => {
  /*
   * The whole flow in one test, because the thing worth defending is the
   * sequence rather than any single transition: a person clicks Connect, waits,
   * approves, and the credential is collected exactly once.
   */
  it("runs idle -> requesting -> waiting -> pending -> approved -> collected", () => {
    const initial = createInitialDeviceEnrollmentState();
    expect(initial.phase).toBe("idle");

    const requesting = reduceEnrollmentOnRequestStart(initial);
    expect(requesting.phase).toBe("requesting");

    const created = reduceEnrollmentOnCreated(requesting, {
      code: "ABC123xyz",
      approveUrl: "https://app.logicpacks.io/devices/ABC123xyz",
      expiresAtMs: EXPIRES_AT,
    });
    expect(created.phase).toBe("waiting");
    expect(created.code).toBe("ABC123xyz");
    expect(created.approveUrl).toBe("https://app.logicpacks.io/devices/ABC123xyz");
    expect(created.expiresAtMs).toBe(EXPIRES_AT);

    const stillPending = reduceEnrollmentOnStatus(created, "pending", NOW + 1_000);
    expect(stillPending.phase).toBe("waiting");
    expect(stillPending.pollAttempt).toBe(1);

    const approved = reduceEnrollmentOnStatus(stillPending, "approved", NOW + 2_000);
    expect(approved.phase).toBe("approved");

    const collecting = reduceEnrollmentOnCollectStart(approved, NOW + 2_100);
    expect(collecting.phase).toBe("collecting");

    const connected = reduceEnrollmentOnCollected(collecting);
    expect(connected.phase).toBe("connected");
    expect(connected.canRetry).toBe(false);
    expect(isTerminalEnrollmentPhase(connected.phase)).toBe(true);
  });

  /*
   * The backoff that paced a nine-minute wait must not also pace the collection.
   * Without this reset the credential is fetched a full backoff interval after
   * the click that authorised it.
   */
  it("resets the backoff on approval so collection is not delayed by the wait", () => {
    const patient = waiting({ pollAttempt: 6 });
    expect(reduceEnrollmentOnStatus(patient, "approved", NOW + 1_000).pollAttempt).toBe(0);
  });
});

describe("refusal", () => {
  it("ends the flow when the person denies it, and offers a way to start over", () => {
    const denied = reduceEnrollmentOnStatus(waiting(), "denied", NOW + 1_000);
    expect(denied.phase).toBe("denied");
    expect(denied.canRetry).toBe(true);
    expect(denied.message).toBeTruthy();
    expect(isTerminalEnrollmentPhase(denied.phase)).toBe(true);
  });

  /*
   * A denial is final on the server, so it must be final here. Continuing to
   * poll would ask a question that has been answered and would show "waiting"
   * over a decision already made.
   */
  it("keeps a denial final against every later answer", () => {
    const denied = reduceEnrollmentOnStatus(waiting(), "denied", NOW + 1_000);
    expect(reduceEnrollmentOnStatus(denied, "approved", NOW + 2_000)).toBe(denied);
    expect(reduceEnrollmentOnStatus(denied, "pending", NOW + 2_000)).toBe(denied);
    expect(reduceEnrollmentOnPollFailure(denied, "network", NOW + 2_000)).toBe(denied);
    expect(reduceEnrollmentOnCollectStart(denied, NOW + 2_000)).toBe(denied);
  });

  /*
   * Collection succeeds exactly once. If the server says the code is spent and
   * this app has no credential, something else took it — retrying cannot
   * recover it, and claiming to still be waiting would hang forever.
   */
  it("stops rather than waits when the code was already spent elsewhere", () => {
    const failed = reduceEnrollmentOnStatus(waiting(), "collected", NOW + 1_000);
    expect(failed.phase).toBe("failed");
    expect(failed.canRetry).toBe(true);
    expect(failed.message).toContain("already used");
  });
});

describe("expiry", () => {
  it("fires exactly at the deadline, not a millisecond later", () => {
    const state = waiting();
    expect(hasEnrollmentExpired(state, EXPIRES_AT - 1)).toBe(false);
    expect(hasEnrollmentExpired(state, EXPIRES_AT)).toBe(true);
  });

  /*
   * Nothing sweeps enrollments on a timer, so a row reads `pending` long after
   * it stopped being usable. Believing that status would leave the app waiting
   * on a code that can never be collected.
   */
  it("overrides a stale pending status rather than believing it", () => {
    const expired = reduceEnrollmentOnStatus(waiting(), "pending", EXPIRES_AT + 1);
    expect(expired.phase).toBe("expired");
    expect(expired.canRetry).toBe(true);
  });

  it("refuses to approve or collect past the deadline", () => {
    expect(reduceEnrollmentOnStatus(waiting(), "approved", EXPIRES_AT).phase).toBe("expired");
    expect(reduceEnrollmentOnCollectStart(waiting(), EXPIRES_AT).phase).toBe("expired");
    expect(
      reduceEnrollmentOnCollectFailure(
        waiting(),
        { retryable: true, message: "not yet" },
        EXPIRES_AT,
      ).phase,
    ).toBe("expired");
  });

  /*
   * The path that matters when the network is down. Without a deadline that can
   * end the flow with no response in hand, an unreachable server leaves
   * "waiting for approval" on screen indefinitely.
   */
  it("ends the flow from a timer alone, with no server answer involved", () => {
    expect(reduceEnrollmentOnDeadline(waiting(), EXPIRES_AT).phase).toBe("expired");
    expect(reduceEnrollmentOnDeadline(waiting(), EXPIRES_AT - 1).phase).toBe("waiting");
  });

  it("leaves idle and terminal states alone when the deadline passes", () => {
    const idle = createInitialDeviceEnrollmentState();
    expect(reduceEnrollmentOnDeadline(idle, EXPIRES_AT + 1)).toBe(idle);
    const connected = reduceEnrollmentOnCollected(waiting());
    expect(reduceEnrollmentOnDeadline(connected, EXPIRES_AT + 1)).toBe(connected);
  });
});

describe("transient failure", () => {
  /*
   * Laptops sleep and wifi drops. One unanswered request says nothing about
   * whether the person approved, only that we could not ask.
   */
  it("holds the phase through a single unanswered poll", () => {
    const afterFailure = reduceEnrollmentOnPollFailure(waiting(), "network", NOW + 1_000);
    expect(afterFailure.phase).toBe("waiting");
    expect(afterFailure.consecutiveFailures).toBe(1);
    expect(afterFailure.pollAttempt).toBe(1);
  });

  it("gives up once failures stack up, rather than claiming to still be waiting", () => {
    let state = waiting();
    for (let index = 0; index < MAX_CONSECUTIVE_ENROLLMENT_POLL_FAILURES; index += 1) {
      state = reduceEnrollmentOnPollFailure(state, "network unreachable", NOW + index);
    }
    expect(state.phase).toBe("failed");
    expect(state.canRetry).toBe(true);
    expect(state.message).toBe("network unreachable");
  });

  /*
   * The two counters exist so a patient user does not trip the ceiling that is
   * there to catch a dead network: any answer at all clears the failure streak.
   */
  it("clears the failure streak on any answer, while the poll count keeps rising", () => {
    const shaky = reduceEnrollmentOnPollFailure(
      reduceEnrollmentOnPollFailure(waiting(), "network", NOW + 1),
      "network",
      NOW + 2,
    );
    expect(shaky.consecutiveFailures).toBe(2);

    const answered = reduceEnrollmentOnStatus(shaky, "pending", NOW + 3);
    expect(answered.consecutiveFailures).toBe(0);
    expect(answered.pollAttempt).toBe(3);
  });

  it("treats a not-yet-approved collect as ordinary waiting, not an error", () => {
    const stillWaiting = reduceEnrollmentOnCollectFailure(
      reduceEnrollmentOnStatus(waiting(), "approved", NOW + 1_000),
      { retryable: true, message: "not yet" },
      NOW + 1_100,
    );
    expect(stillWaiting.phase).toBe("waiting");
    expect(stillWaiting.message).toBeNull();
  });

  it("reports an unrecoverable collect failure instead of retrying it", () => {
    const failed = reduceEnrollmentOnCollectFailure(
      reduceEnrollmentOnStatus(waiting(), "approved", NOW + 1_000),
      { retryable: false, message: "credentials could not be saved" },
      NOW + 1_100,
    );
    expect(failed.phase).toBe("failed");
    expect(failed.message).toBe("credentials could not be saved");
    expect(failed.canRetry).toBe(true);
  });

  it("surfaces a failed request for a code with a retry", () => {
    const failed = reduceEnrollmentOnRequestFailure(
      reduceEnrollmentOnRequestStart(createInitialDeviceEnrollmentState()),
      "the service is unreachable",
    );
    expect(failed.phase).toBe("failed");
    expect(failed.canRetry).toBe(true);
  });
});

describe("starting over", () => {
  /*
   * A retry must ask for a fresh code. Reusing one after a denial or an expiry
   * asks the server to reconsider a decision it has already recorded as final.
   */
  it("discards the old code entirely", () => {
    const denied = reduceEnrollmentOnStatus(waiting(), "denied", NOW + 1_000);
    const restarted = reduceEnrollmentOnRestart();
    expect(restarted).toEqual(createInitialDeviceEnrollmentState());
    expect(restarted.code).toBeNull();

    const requesting = reduceEnrollmentOnRequestStart(denied);
    expect(requesting.code).toBeNull();
    expect(requesting.approveUrl).toBeNull();
    expect(requesting.expiresAtMs).toBeNull();
    expect(requesting.message).toBeNull();
  });
});

describe("nextEnrollmentPollDelayMs", () => {
  it("backs off instead of hammering the server once a second for ten minutes", () => {
    const delays = [0, 1, 2, 3, 4, 5, 6].map(
      (pollAttempt) =>
        nextEnrollmentPollDelayMs({ pollAttempt, expiresAtMs: EXPIRES_AT, nowMs: NOW }) ?? 0,
    );
    expect(delays[0]).toBeGreaterThan(0);
    for (let index = 1; index < delays.length; index += 1) {
      expect(delays[index]).toBeGreaterThanOrEqual(delays[index - 1] ?? 0);
    }
    // Capped, so a person who approves late is not left staring at a stale
    // screen for a minute while the backoff unwinds.
    expect(Math.max(...delays)).toBeLessThanOrEqual(8_000);
  });

  /*
   * Returning null at the deadline is what stops the loop on its own terms,
   * without needing a response to notice.
   */
  it("refuses to schedule another poll once the deadline has passed", () => {
    expect(
      nextEnrollmentPollDelayMs({ pollAttempt: 0, expiresAtMs: EXPIRES_AT, nowMs: EXPIRES_AT }),
    ).toBeNull();
  });

  /*
   * Without the clip, a code expiring in two seconds gets an eight second sleep
   * and its approval is noticed only after it stopped counting.
   */
  it("clips the last wait to the deadline so the final poll lands inside it", () => {
    expect(
      nextEnrollmentPollDelayMs({
        pollAttempt: 6,
        expiresAtMs: EXPIRES_AT,
        nowMs: EXPIRES_AT - 2_000,
      }),
    ).toBe(2_000);
  });
});
