import { describe, expect, it } from "vitest";

import {
  decideRelayBinding,
  decideRelayLink,
  RELAY_DIAL_BASE_DELAY_MS,
  RELAY_DIAL_MAX_DELAY_MS,
  RELAY_HEARTBEAT_INTERVAL_MS,
  RELAY_MISSED_BEATS_ALLOWED,
  relayDialDelayMs,
  relayHealthDeadlineMs,
  spreadRelayDialDelayMs,
  type RelayLinkObservation,
} from "./decideRelayLink.ts";
import type { EnvironmentReportedState } from "./protocol.ts";

const NOW = 1_000_000;

/** A link with nothing wrong with it, so each test can spoil one thing. */
function healthy(overrides: Partial<RelayLinkObservation> = {}): RelayLinkObservation {
  return {
    socketOpen: true,
    revoked: false,
    acceptedAtMs: NOW - 60_000,
    lastHealthAtMs: NOW - 1_000,
    reportedState: "ready",
    reportedDetail: null,
    ...overrides,
  };
}

describe("what makes a relayed environment connected", () => {
  it("is connected when the socket is up, the identity settled and a ping came back", () => {
    const verdict = decideRelayLink({ observation: healthy(), nowMs: NOW });
    expect(verdict.state).toBe("connected");
    expect(verdict.reason).toBe("healthy");
    expect(verdict.acceptsTraffic).toBe(true);
    expect(verdict.healthAgeMs).toBe(1_000);
  });

  it("is not connected on an open socket alone", () => {
    // The whole point of the module: a socket proves the machine can be
    // reached, not that anything behind it works.
    const verdict = decideRelayLink({
      observation: healthy({ acceptedAtMs: null, lastHealthAtMs: null, reportedState: null }),
      nowMs: NOW,
    });
    expect(verdict.state).toBe("connecting");
    expect(verdict.reason).toBe("identity-pending");
    expect(verdict.acceptsTraffic).toBe(false);
  });

  it("is not connected while the identity is settled but nothing has answered yet", () => {
    const verdict = decideRelayLink({
      observation: healthy({ lastHealthAtMs: null, reportedState: null }),
      nowMs: NOW,
    });
    expect(verdict.state).toBe("connecting");
    expect(verdict.reason).toBe("awaiting-first-health");
    expect(verdict.healthAgeMs).toBeNull();
  });

  it("is not connected when a ping was answered but the answer said nothing", () => {
    const verdict = decideRelayLink({
      observation: healthy({ reportedState: null }),
      nowMs: NOW,
    });
    expect(verdict.state).toBe("connecting");
    expect(verdict.reason).toBe("awaiting-first-health");
  });

  it("goes unhealthy once the last answered ping falls outside the window", () => {
    const deadline = relayHealthDeadlineMs();
    const observation = healthy({ lastHealthAtMs: NOW - deadline - 1 });
    const verdict = decideRelayLink({ observation, nowMs: NOW });
    expect(verdict.state).toBe("unhealthy");
    expect(verdict.reason).toBe("health-stale");
    expect(verdict.acceptsTraffic).toBe(false);
  });

  it("tolerates silence right up to the deadline, so one missed beat is not a failure", () => {
    const deadline = relayHealthDeadlineMs();
    const verdict = decideRelayLink({
      observation: healthy({ lastHealthAtMs: NOW - deadline }),
      nowMs: NOW,
    });
    expect(verdict.state).toBe("connected");
  });

  it("takes the caller's window when it has one", () => {
    const window = { intervalMs: 1_000, missedBeatsAllowed: 2 };
    expect(relayHealthDeadlineMs(window)).toBe(2_000);
    expect(
      decideRelayLink({ observation: healthy({ lastHealthAtMs: NOW - 2_001 }), nowMs: NOW, window })
        .state,
    ).toBe("unhealthy");
    expect(
      decideRelayLink({ observation: healthy({ lastHealthAtMs: NOW - 1_999 }), nowMs: NOW, window })
        .state,
    ).toBe("connected");
  });

  it("defaults to three beats of fifteen seconds", () => {
    expect(RELAY_HEARTBEAT_INTERVAL_MS).toBe(15_000);
    expect(RELAY_MISSED_BEATS_ALLOWED).toBe(3);
    expect(relayHealthDeadlineMs()).toBe(45_000);
  });
});

describe("what the environment says about itself", () => {
  const cases: ReadonlyArray<readonly [EnvironmentReportedState, string, string, boolean]> = [
    ["ready", "connected", "healthy", true],
    // A turn in flight is the healthiest state this product has. Greying it out
    // would tell somebody their working machine had failed.
    ["busy", "connected", "healthy", true],
    ["starting", "connecting", "environment-starting", false],
    ["degraded", "unhealthy", "environment-degraded", false],
    ["stopping", "unhealthy", "environment-stopping", false],
  ];

  for (const [reportedState, state, reason, acceptsTraffic] of cases) {
    it(`reports ${reportedState} as ${state}`, () => {
      const verdict = decideRelayLink({ observation: healthy({ reportedState }), nowMs: NOW });
      expect(verdict.state).toBe(state);
      expect(verdict.reason).toBe(reason);
      expect(verdict.acceptsTraffic).toBe(acceptsTraffic);
    });
  }

  it("passes the environment's own words through and never invents any", () => {
    expect(
      decideRelayLink({
        observation: healthy({ reportedState: "degraded", reportedDetail: "workspace is gone" }),
        nowMs: NOW,
      }).detail,
    ).toBe("workspace is gone");
    expect(decideRelayLink({ observation: healthy(), nowMs: NOW }).detail).toBeNull();
  });

  it("does not believe a fresh claim of readiness from a link that went silent", () => {
    // The exact lie this module exists to catch: the last thing the far end
    // said was "ready", and it said it a minute ago.
    const verdict = decideRelayLink({
      observation: healthy({ reportedState: "ready", lastHealthAtMs: NOW - 60_000 }),
      nowMs: NOW,
    });
    expect(verdict.state).toBe("unhealthy");
  });
});

describe("the order the rules are applied in", () => {
  it("calls a revoked machine revoked even with a perfect link", () => {
    const verdict = decideRelayLink({ observation: healthy({ revoked: true }), nowMs: NOW });
    expect(verdict.state).toBe("revoked");
    expect(verdict.reason).toBe("machine-revoked");
    expect(verdict.acceptsTraffic).toBe(false);
  });

  it("calls a revoked machine revoked even with the socket already gone", () => {
    const verdict = decideRelayLink({
      observation: healthy({ revoked: true, socketOpen: false }),
      nowMs: NOW,
    });
    expect(verdict.state).toBe("revoked");
  });

  it("calls a closed socket offline before it looks at health at all", () => {
    const verdict = decideRelayLink({
      observation: healthy({ socketOpen: false, lastHealthAtMs: NOW - 10_000_000 }),
      nowMs: NOW,
    });
    expect(verdict.state).toBe("offline");
    expect(verdict.reason).toBe("socket-closed");
  });

  it("never accepts traffic on anything but connected", () => {
    const observations: ReadonlyArray<RelayLinkObservation> = [
      healthy({ revoked: true }),
      healthy({ socketOpen: false }),
      healthy({ acceptedAtMs: null }),
      healthy({ lastHealthAtMs: null }),
      healthy({ lastHealthAtMs: NOW - 10_000_000 }),
      healthy({ reportedState: "degraded" }),
      healthy({ reportedState: "starting" }),
      healthy({ reportedState: "stopping" }),
      healthy({ reportedState: null }),
    ];
    for (const observation of observations) {
      const verdict = decideRelayLink({ observation, nowMs: NOW });
      expect(verdict.state).not.toBe("connected");
      expect(verdict.acceptsTraffic).toBe(false);
    }
  });
});

describe("the age of the last health answer", () => {
  it("is null when nothing has ever answered", () => {
    expect(
      decideRelayLink({ observation: healthy({ lastHealthAtMs: null }), nowMs: NOW }).healthAgeMs,
    ).toBeNull();
  });

  it("never goes negative, so a clock that ran backwards cannot read as fresh", () => {
    expect(
      decideRelayLink({ observation: healthy({ lastHealthAtMs: NOW + 5_000 }), nowMs: NOW })
        .healthAgeMs,
    ).toBe(0);
  });
});

describe("who may claim an environment's name", () => {
  const claim = { environmentId: "env-1", userId: "auth:ada", machineId: "machine-a" };

  it("binds a name nobody holds", () => {
    expect(decideRelayBinding({ existing: null, claim })).toEqual({ outcome: "bind" });
  });

  it("resumes when the same machine comes back", () => {
    // The reconnect case, and the one that makes saved environments survive a
    // reboot at all.
    expect(
      decideRelayBinding({
        existing: { environmentId: "env-1", userId: "auth:ada", machineId: "machine-a" },
        claim,
      }),
    ).toEqual({ outcome: "resume" });
  });

  it("rebinds when the same person dials in from a different machine", () => {
    expect(
      decideRelayBinding({
        existing: { environmentId: "env-1", userId: "auth:ada", machineId: "machine-b" },
        claim,
      }),
    ).toEqual({ outcome: "rebind" });
  });

  it("refuses a name held by another account, however new the claim", () => {
    expect(
      decideRelayBinding({
        existing: { environmentId: "env-1", userId: "auth:grace", machineId: "machine-b" },
        claim,
      }),
    ).toEqual({ outcome: "reject", reason: "owned-by-another-account" });
  });

  it("refuses even when the other account is dialling from this very machine", () => {
    // Two accounts on one laptop is ordinary. Neither gets to inherit the
    // other's environment because the hardware happens to be shared.
    expect(
      decideRelayBinding({
        existing: { environmentId: "env-1", userId: "auth:grace", machineId: "machine-a" },
        claim,
      }),
    ).toEqual({ outcome: "reject", reason: "owned-by-another-account" });
  });

  it("refuses a row that is not about this environment at all", () => {
    expect(
      decideRelayBinding({
        existing: { environmentId: "env-2", userId: "auth:ada", machineId: "machine-a" },
        claim,
      }),
    ).toEqual({ outcome: "reject", reason: "environment-id-mismatch" });
  });
});

describe("how long a dialer waits before trying again", () => {
  it("starts at the base delay and doubles", () => {
    expect(relayDialDelayMs(0)).toBe(RELAY_DIAL_BASE_DELAY_MS);
    expect(relayDialDelayMs(1)).toBe(1_000);
    expect(relayDialDelayMs(2)).toBe(2_000);
    expect(relayDialDelayMs(3)).toBe(4_000);
  });

  it("is bounded, so a long outage never becomes an unbounded wait", () => {
    expect(relayDialDelayMs(6)).toBe(RELAY_DIAL_MAX_DELAY_MS);
    expect(relayDialDelayMs(50)).toBe(RELAY_DIAL_MAX_DELAY_MS);
    expect(relayDialDelayMs(1_000_000)).toBe(RELAY_DIAL_MAX_DELAY_MS);
    expect(relayDialDelayMs(Number.MAX_SAFE_INTEGER)).toBe(RELAY_DIAL_MAX_DELAY_MS);
  });

  it("never returns a delay of nothing, so a wedged dialer cannot spin", () => {
    for (const attempt of [-1, 0, Number.NaN, Number.POSITIVE_INFINITY, 0.5]) {
      expect(relayDialDelayMs(attempt)).toBeGreaterThanOrEqual(RELAY_DIAL_BASE_DELAY_MS);
      expect(relayDialDelayMs(attempt)).toBeLessThanOrEqual(RELAY_DIAL_MAX_DELAY_MS);
    }
  });

  it("takes the caller's own bounds", () => {
    expect(relayDialDelayMs(10, { baseMs: 100, maxMs: 400 })).toBe(400);
    expect(relayDialDelayMs(1, { baseMs: 100, maxMs: 400 })).toBe(200);
  });

  it("spreads a delay over its second half rather than down to zero", () => {
    expect(spreadRelayDialDelayMs(1_000, 0)).toBe(500);
    expect(spreadRelayDialDelayMs(1_000, 1)).toBe(1_000);
    expect(spreadRelayDialDelayMs(1_000, 0.5)).toBe(750);
  });

  it("clamps a random value outside its range instead of trusting it", () => {
    expect(spreadRelayDialDelayMs(1_000, -5)).toBe(500);
    expect(spreadRelayDialDelayMs(1_000, 5)).toBe(1_000);
  });
});
