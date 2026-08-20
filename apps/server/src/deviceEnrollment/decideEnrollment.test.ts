import { describe, expect, it } from "vitest";

import {
  decideEnrollment,
  type EnrollmentRecord,
  type EnrollmentStatus,
} from "./decideEnrollment.ts";

const NOW = 1_000_000;
const USER = "supabase:abc";

const record = (over: Partial<EnrollmentRecord> = {}): EnrollmentRecord => ({
  status: "pending",
  expiresAtMs: NOW + 60_000,
  approvedByUserId: null,
  ...over,
});

describe("decideEnrollment", () => {
  it("attaches the machine to whoever approved it", () => {
    const decision = decideEnrollment({
      record: record(),
      action: { type: "approve", byUserId: USER },
      nowMs: NOW,
    });
    expect(decision).toEqual({
      outcome: "accept",
      next: { status: "approved", expiresAtMs: NOW + 60_000, approvedByUserId: USER },
    });
  });

  it("hands the credential over exactly once", () => {
    const approved = record({ status: "approved", approvedByUserId: USER });
    const first = decideEnrollment({ record: approved, action: { type: "collect" }, nowMs: NOW });
    expect(first.outcome).toBe("accept");

    const collected = first.outcome === "accept" ? first.next : approved;
    expect(collected.status).toBe("collected");

    // A replayed poll must not re-issue access to whoever presents the code.
    expect(
      decideEnrollment({ record: collected, action: { type: "collect" }, nowMs: NOW }),
    ).toEqual({ outcome: "reject", reason: "already-collected" });
  });

  it("refuses to collect before anyone has approved", () => {
    expect(decideEnrollment({ record: record(), action: { type: "collect" }, nowMs: NOW })).toEqual(
      { outcome: "reject", reason: "not-approved" },
    );
  });

  it("never reconsiders a denial, so refusing an unrecognised machine means something", () => {
    const denied = record({ status: "denied" });
    for (const action of [
      { type: "approve", byUserId: USER },
      { type: "collect" },
      { type: "deny" },
    ] as const) {
      expect(decideEnrollment({ record: denied, action, nowMs: NOW })).toEqual({
        outcome: "reject",
        reason: "denied",
      });
    }
  });

  it("treats a pending row past its deadline as expired, since nothing sweeps the table", () => {
    expect(
      decideEnrollment({
        record: record({ status: "pending" }),
        action: { type: "approve", byUserId: USER },
        nowMs: NOW + 60_001,
      }),
    ).toEqual({ outcome: "reject", reason: "expired" });
  });

  it("expires exactly at the deadline rather than a millisecond after", () => {
    expect(
      decideEnrollment({
        record: record({ expiresAtMs: NOW }),
        action: { type: "approve", byUserId: USER },
        nowMs: NOW,
      }),
    ).toEqual({ outcome: "reject", reason: "expired" });
  });

  it("will not let a second person approve a machine already approved", () => {
    expect(
      decideEnrollment({
        record: record({ status: "approved", approvedByUserId: USER }),
        action: { type: "approve", byUserId: "supabase:someone-else" },
        nowMs: NOW,
      }),
    ).toEqual({ outcome: "reject", reason: "already-approved" });
  });

  it("clears any approval when denied, so a stale user id cannot be collected against", () => {
    const decision = decideEnrollment({
      record: record({ status: "approved", approvedByUserId: USER }),
      action: { type: "deny" },
      nowMs: NOW,
    });
    expect(decision).toEqual({
      outcome: "accept",
      next: { status: "denied", expiresAtMs: NOW + 60_000, approvedByUserId: null },
    });
  });

  it("is total: every status and action pair returns a decision", () => {
    const statuses: EnrollmentStatus[] = ["pending", "approved", "collected", "denied", "expired"];
    for (const status of statuses) {
      for (const action of [
        { type: "approve", byUserId: USER },
        { type: "deny" },
        { type: "collect" },
      ] as const) {
        for (const nowMs of [NOW, NOW + 60_001]) {
          const decision = decideEnrollment({
            record: record({ status, approvedByUserId: status === "approved" ? USER : null }),
            action,
            nowMs,
          });
          expect(["accept", "reject"]).toContain(decision.outcome);
        }
      }
    }
  });
});
