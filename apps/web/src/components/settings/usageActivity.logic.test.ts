import { describe, expect, it } from "vitest";

import { isLimitReached, percentUsed } from "./usageActivity.logic";

describe("isLimitReached", () => {
  it("is false below the limit", () => {
    expect(isLimitReached(64_999, 65_000)).toBe(false);
  });

  it("is true exactly at the limit", () => {
    expect(isLimitReached(65_000, 65_000)).toBe(true);
  });

  it("is true past the limit, matching the real over-budget case this was built for", () => {
    expect(isLimitReached(70_640, 65_000)).toBe(true);
  });

  it("is false when there is no limit to exceed", () => {
    expect(isLimitReached(100, 0)).toBe(false);
  });
});

describe("percentUsed vs isLimitReached", () => {
  it("percentUsed alone cannot distinguish 'almost full' from 'reached' — both clamp to the same value", () => {
    const almostFull = percentUsed(64_000, 65_000);
    const reached = percentUsed(70_640, 65_000);

    expect(almostFull).toBe(98);
    expect(reached).toBe(100);
    expect(isLimitReached(64_000, 65_000)).toBe(false);
    expect(isLimitReached(70_640, 65_000)).toBe(true);
  });
});
