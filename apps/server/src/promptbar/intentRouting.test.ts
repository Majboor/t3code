import { describe, expect, it } from "vitest";

import {
  ATTACH_THRESHOLD,
  reclassifyAwayFromContinuation,
  resolveEffectiveIntent,
  SUGGEST_THRESHOLD,
  zoneForConfidence,
} from "./intentRouting.ts";

describe("zoneForConfidence", () => {
  it("matches the classifier's own health thresholds (attach 0.6, suggest 0.35)", () => {
    expect(zoneForConfidence(0.99)).toBe("attach");
    expect(zoneForConfidence(ATTACH_THRESHOLD)).toBe("attach");
    expect(zoneForConfidence(0.5)).toBe("suggest");
    expect(zoneForConfidence(SUGGEST_THRESHOLD)).toBe("suggest");
    expect(zoneForConfidence(0.1)).toBe("silent");
  });
});

describe("reclassifyAwayFromContinuation", () => {
  it("picks the best-scoring non-CONTINUATION intent from the classifier's own distribution", () => {
    const result = reclassifyAwayFromContinuation({
      ACTION: 0.6,
      QUESTION: 0.1,
      STATEMENT: 0.05,
      CONTINUATION: 0.9796,
    });
    expect(result).toEqual({ intent: "ACTION", confidence: 0.6 });
  });

  it("never returns CONTINUATION even if it was the highest score overall", () => {
    const result = reclassifyAwayFromContinuation({
      ACTION: 0.01,
      QUESTION: 0.02,
      STATEMENT: 0.9,
      CONTINUATION: 0.99,
    });
    expect(result.intent).toBe("STATEMENT");
  });
});

describe("resolveEffectiveIntent", () => {
  it("leaves a non-first-message CONTINUATION untouched", () => {
    const result = resolveEffectiveIntent(
      { intent: "CONTINUATION", confidence: 0.9796, zone: "attach", all: { ACTION: 0.0157, QUESTION: 0.0017, STATEMENT: 0.0031, CONTINUATION: 0.9796 } },
      false,
    );
    expect(result).toEqual({ intent: "CONTINUATION", confidence: 0.9796, zone: "attach", note: null });
  });

  it("enforces the hard rule: CONTINUATION is never valid on a session's first message", () => {
    const result = resolveEffectiveIntent(
      { intent: "CONTINUATION", confidence: 0.9796, zone: "attach", all: { ACTION: 0.9, QUESTION: 0.05, STATEMENT: 0.05, CONTINUATION: 0.9796 } },
      true,
    );
    expect(result.intent).toBe("ACTION");
    expect(result.confidence).toBe(0.9);
    expect(result.zone).toBe("attach");
    expect(result.note).not.toBeNull();
  });

  it("recomputes zone from the reclassified confidence, not the original classification's zone", () => {
    const result = resolveEffectiveIntent(
      {
        intent: "CONTINUATION",
        confidence: 0.5,
        zone: "attach", // the live classifier's zone tracks its own top confidence, not the reclassified one
        all: { ACTION: 0.2, QUESTION: 0.05, STATEMENT: 0.05, CONTINUATION: 0.5 },
      },
      true,
    );
    // Reclassified to ACTION at confidence 0.2 -> below the 0.6/0.35 thresholds -> silent, not "attach".
    expect(result.intent).toBe("ACTION");
    expect(result.zone).toBe("silent");
  });

  it("forces zone to silent for STATEMENT regardless of the classifier's own zone", () => {
    const result = resolveEffectiveIntent(
      { intent: "STATEMENT", confidence: 0.9753, zone: "attach", all: { ACTION: 0.0178, QUESTION: 0.0045, STATEMENT: 0.9753, CONTINUATION: 0.0024 } },
      false,
    );
    expect(result).toEqual({ intent: "STATEMENT", confidence: 0.9753, zone: "silent", note: null });
  });

  it("passes ACTION and QUESTION through unchanged outside the first-message override", () => {
    const action = resolveEffectiveIntent(
      { intent: "ACTION", confidence: 0.9912, zone: "attach", all: { ACTION: 0.9912, QUESTION: 0.0018, STATEMENT: 0.003, CONTINUATION: 0.004 } },
      false,
    );
    expect(action).toEqual({ intent: "ACTION", confidence: 0.9912, zone: "attach", note: null });

    const question = resolveEffectiveIntent(
      { intent: "QUESTION", confidence: 0.9933, zone: "attach", all: { ACTION: 0.0041, QUESTION: 0.9933, STATEMENT: 0.0016, CONTINUATION: 0.001 } },
      true, // first message, but not CONTINUATION -> no override applies
    );
    expect(question).toEqual({ intent: "QUESTION", confidence: 0.9933, zone: "attach", note: null });
  });
});
