import { describe, expect, it } from "vitest";

import {
  describeDevicePlatform,
  describeEnrollmentOutcome,
  describeMachineLabel,
  describeRequestedIp,
  formatEnrollmentTimeLeft,
  parseEnrollmentPreview,
  readEnrollmentOutcome,
  type EnrollmentOutcome,
  type EnrollmentPreview,
  type EnrollmentStatus,
} from "./deviceEnrollment.logic";

const STATUSES: ReadonlyArray<EnrollmentStatus> = [
  "pending",
  "approved",
  "collected",
  "denied",
  "expired",
];
const OUTCOMES: ReadonlyArray<EnrollmentOutcome> = [...STATUSES, "unknown-code"];

describe("describeEnrollmentOutcome", () => {
  it("answers for every status the server can report, and for a code it has never seen", () => {
    for (const outcome of OUTCOMES) {
      const advice = describeEnrollmentOutcome(outcome);
      expect(advice.title.length, outcome).toBeGreaterThan(0);
      expect(advice.detail.length, outcome).toBeGreaterThan(0);
      expect(advice.advice.length, outcome).toBeGreaterThan(0);
    }
  });

  it("gives each outcome its own advice, because each one needs a different thing done", () => {
    // The point of the mapping. "This expired, start again on the machine" and
    // "somebody already approved this" are not the same news, and a shared
    // sentence would make them look like it.
    const advice = OUTCOMES.map((outcome) => describeEnrollmentOutcome(outcome).advice);
    expect(new Set(advice).size).toBe(OUTCOMES.length);

    const titles = OUTCOMES.map((outcome) => describeEnrollmentOutcome(outcome).title);
    expect(new Set(titles).size).toBe(OUTCOMES.length);
  });

  it("offers Connect on a pending request and nowhere else", () => {
    for (const outcome of OUTCOMES) {
      expect(describeEnrollmentOutcome(outcome).canApprove, outcome).toBe(outcome === "pending");
    }
  });

  it("keeps Deny available on a request somebody else already approved", () => {
    // The server lets a denial land on an approved-but-uncollected request, so
    // this is the last moment a machine you do not recognise can be stopped.
    // Hiding the button would remove the only useful thing left to do.
    expect(describeEnrollmentOutcome("approved").canDeny).toBe(true);
    expect(describeEnrollmentOutcome("pending").canDeny).toBe(true);

    for (const outcome of ["collected", "denied", "expired", "unknown-code"] as const) {
      expect(describeEnrollmentOutcome(outcome).canDeny, outcome).toBe(false);
    }
  });

  it("tells somebody looking at an already-connected machine where the off switch is", () => {
    // The code is spent, so coming back here does nothing; revoking the session
    // is the only act that cuts the machine off.
    expect(describeEnrollmentOutcome("collected").advice).toMatch(/settings/i);
  });

  it("does not tell somebody to retry a code that can never work again", () => {
    expect(describeEnrollmentOutcome("denied").detail).toMatch(/final|cannot be approved/i);
    expect(describeEnrollmentOutcome("expired").advice).toMatch(/start again on the machine/i);
    expect(describeEnrollmentOutcome("unknown-code").advice).toMatch(/start again on the machine/i);
  });

  it("marks the states a person can still act on as decisions and the rest as endings", () => {
    expect(describeEnrollmentOutcome("pending").tone).toBe("decide");
    expect(describeEnrollmentOutcome("approved").tone).toBe("warning");
    expect(describeEnrollmentOutcome("collected").tone).toBe("positive");
    expect(describeEnrollmentOutcome("denied").tone).toBe("dead");
    expect(describeEnrollmentOutcome("expired").tone).toBe("dead");
    expect(describeEnrollmentOutcome("unknown-code").tone).toBe("dead");
  });
});

describe("describeMachineLabel", () => {
  it("uses the name the machine gave", () => {
    expect(describeMachineLabel("Waleed's MacBook Pro")).toBe("Waleed's MacBook Pro");
    expect(describeMachineLabel("  build-box  ")).toBe("build-box");
  });

  it("says a machine is unnamed rather than leaving the row blank", () => {
    // A blank where the name should be reads as a page that failed to load, and
    // a person shrugs and approves anyway.
    expect(describeMachineLabel(null)).toBe("an unnamed machine");
    expect(describeMachineLabel(undefined)).toBe("an unnamed machine");
    expect(describeMachineLabel("")).toBe("an unnamed machine");
    expect(describeMachineLabel("   ")).toBe("an unnamed machine");
  });
});

describe("describeDevicePlatform", () => {
  it("says what a person calls it, not what Node calls it", () => {
    expect(describeDevicePlatform("darwin")).toBe("macOS");
    expect(describeDevicePlatform("win32")).toBe("Windows");
    expect(describeDevicePlatform("linux")).toBe("Linux");
    expect(describeDevicePlatform("Darwin")).toBe("macOS");
  });

  it("shows an unrecognised platform as it arrived, since it is still evidence", () => {
    expect(describeDevicePlatform("freebsd")).toBe("freebsd");
  });

  it("says nothing was reported rather than showing an empty row", () => {
    expect(describeDevicePlatform(null)).toBe("Platform not reported");
    expect(describeDevicePlatform("  ")).toBe("Platform not reported");
  });
});

describe("describeRequestedIp", () => {
  it("shows the address, and admits when there is not one", () => {
    expect(describeRequestedIp("192.168.1.24")).toBe("192.168.1.24");
    expect(describeRequestedIp(null)).toBe("Address not recorded");
    expect(describeRequestedIp("")).toBe("Address not recorded");
  });
});

describe("formatEnrollmentTimeLeft", () => {
  const now = 1_700_000_000_000;

  it("counts down to the deadline", () => {
    expect(formatEnrollmentTimeLeft(now + 240_000, now)).toBe("Expires in 4m");
    expect(formatEnrollmentTimeLeft(now + 45_000, now)).toBe("Expires in 45s");
  });

  it("reports a deadline that has passed as expired", () => {
    expect(formatEnrollmentTimeLeft(now - 1, now)).toBe("Expired");
  });

  it("does not claim a request expired when it does not know the deadline", () => {
    // Saying "Expired" here would send somebody back to the other machine to
    // redo a request that is still perfectly good.
    expect(formatEnrollmentTimeLeft(Number.NaN, now)).toBe("Expiry unknown");
  });
});

function preview(status: EnrollmentStatus, expiresAtMs: number): EnrollmentPreview {
  return {
    status,
    deviceLabel: null,
    devicePlatform: null,
    requestedIp: null,
    expiresAtMs,
  };
}

describe("readEnrollmentOutcome", () => {
  const now = 1_700_000_000_000;

  it("reads a lapsed pending request as expired, since nothing sweeps the table", () => {
    // A row sits at `pending` long after it stopped being usable. Trusting the
    // status would draw a Connect button the server is going to refuse.
    expect(readEnrollmentOutcome(preview("pending", now), now)).toBe("expired");
    expect(readEnrollmentOutcome(preview("pending", now - 1000), now)).toBe("expired");
  });

  it("leaves a live pending request alone", () => {
    expect(readEnrollmentOutcome(preview("pending", now + 1000), now)).toBe("pending");
  });

  it("never rewrites a terminal status because of the clock", () => {
    expect(readEnrollmentOutcome(preview("collected", now - 1000), now)).toBe("collected");
    expect(readEnrollmentOutcome(preview("denied", now - 1000), now)).toBe("denied");
  });

  it("does not expire a request whose deadline it could not read", () => {
    expect(readEnrollmentOutcome(preview("pending", Number.NaN), now)).toBe("pending");
  });
});

describe("parseEnrollmentPreview", () => {
  it("reads the reply the enrollment API is contracted to send", () => {
    expect(
      parseEnrollmentPreview({
        status: "pending",
        deviceLabel: "Waleed's MacBook Pro",
        devicePlatform: "darwin",
        requestedIp: "192.168.1.24",
        expiresAtMs: 1_700_000_000_000,
      }),
    ).toEqual({
      status: "pending",
      deviceLabel: "Waleed's MacBook Pro",
      devicePlatform: "darwin",
      requestedIp: "192.168.1.24",
      expiresAtMs: 1_700_000_000_000,
    });
  });

  it("accepts the nullable descriptive fields, which the server may not know", () => {
    expect(
      parseEnrollmentPreview({
        status: "pending",
        deviceLabel: null,
        devicePlatform: null,
        requestedIp: null,
        expiresAtMs: 1_700_000_000_000,
      }),
    ).toEqual({
      status: "pending",
      deviceLabel: null,
      devicePlatform: null,
      requestedIp: null,
      expiresAtMs: 1_700_000_000_000,
    });
  });

  it("refuses a status this build does not know rather than rendering a button next to it", () => {
    expect(parseEnrollmentPreview({ status: "revoked", expiresAtMs: 1 })).toBeNull();
    expect(parseEnrollmentPreview({ expiresAtMs: 1 })).toBeNull();
    expect(parseEnrollmentPreview(null)).toBeNull();
    expect(parseEnrollmentPreview("pending")).toBeNull();
  });
});
