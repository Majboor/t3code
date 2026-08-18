import { describe, expect, it } from "vitest";

import {
  initialNotchHoverState,
  NOTCH_HOVER_ENTER_SAMPLES,
  NOTCH_HOVER_EXIT_SAMPLES,
  type NotchHoverState,
  reduceNotchHoverState,
} from "./notchHover.ts";

function drive(state: NotchHoverState, samples: readonly boolean[]): NotchHoverState {
  return samples.reduce(reduceNotchHoverState, state);
}

describe("reduceNotchHoverState", () => {
  it("starts collapsed", () => {
    expect(initialNotchHoverState.expanded).toBe(false);
  });

  it("needs the cursor to settle before expanding", () => {
    const samples = Array.from({ length: NOTCH_HOVER_ENTER_SAMPLES }, () => true);

    expect(drive(initialNotchHoverState, samples.slice(0, -1)).expanded).toBe(false);
    expect(drive(initialNotchHoverState, samples).expanded).toBe(true);
  });

  it("ignores a cursor merely passing through the pill", () => {
    const passingThrough = [
      ...Array.from({ length: NOTCH_HOVER_ENTER_SAMPLES - 1 }, () => true),
      false,
      true,
    ];

    expect(drive(initialNotchHoverState, passingThrough).expanded).toBe(false);
  });

  it("resets the dwell count as soon as the cursor leaves", () => {
    const partway = reduceNotchHoverState(initialNotchHoverState, true);
    expect(partway.dwellSamples).toBe(1);
    expect(reduceNotchHoverState(partway, false).dwellSamples).toBe(0);
  });

  it("tolerates clipping the edge while expanded", () => {
    const expanded = drive(
      initialNotchHoverState,
      Array.from({ length: NOTCH_HOVER_ENTER_SAMPLES }, () => true),
    );
    const clipped = [
      ...Array.from({ length: NOTCH_HOVER_EXIT_SAMPLES - 1 }, () => false),
      true,
      false,
    ];

    expect(drive(expanded, clipped).expanded).toBe(true);
  });

  it("collapses once the cursor stays away", () => {
    const expanded = drive(
      initialNotchHoverState,
      Array.from({ length: NOTCH_HOVER_ENTER_SAMPLES }, () => true),
    );
    const leaving = Array.from({ length: NOTCH_HOVER_EXIT_SAMPLES }, () => false);

    expect(drive(expanded, leaving.slice(0, -1)).expanded).toBe(true);
    expect(drive(expanded, leaving).expanded).toBe(false);
  });

  it("holds steady while the cursor stays put", () => {
    const expanded = drive(
      initialNotchHoverState,
      Array.from({ length: NOTCH_HOVER_ENTER_SAMPLES }, () => true),
    );

    expect(reduceNotchHoverState(expanded, true)).toBe(expanded);
    expect(reduceNotchHoverState(initialNotchHoverState, false)).toBe(initialNotchHoverState);
  });
});
