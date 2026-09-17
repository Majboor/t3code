import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  PRODUCT_TOUR_AUTO_START_DELAY_MS,
  scheduleProductTourAutoStart,
} from "./productTourAutoStart.logic";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("scheduleProductTourAutoStart", () => {
  it("does not start the tour when hasSeenProductTour only resolves to true after scheduling", () => {
    // Reproduces the real regression: client settings hydrate from
    // localStorage asynchronously, so `hasSeenProductTour` reads `false` at
    // the moment the auto-start effect runs even when `true` was persisted
    // on a previous visit, and only flips to `true` a tick later once
    // hydration resolves — well before the auto-start timer fires. The
    // scheduler must re-check at fire time, not bake in the value it saw
    // when the timer was set up (which is what let the tour restart on
    // every refresh).
    let hasSeenProductTour = false;
    const startTour = vi.fn();

    scheduleProductTourAutoStart({
      getHasSeenProductTour: () => hasSeenProductTour,
      getTourActive: () => false,
      startTour,
      setTimeout: (callback, delayMs) => setTimeout(callback, delayMs) as unknown as number,
      clearTimeout: (id) => clearTimeout(id),
    });

    // Hydration resolves after the timer was scheduled, but before it fires.
    hasSeenProductTour = true;
    vi.advanceTimersByTime(PRODUCT_TOUR_AUTO_START_DELAY_MS);

    expect(startTour).not.toHaveBeenCalled();
  });

  it("starts the tour when hasSeenProductTour is still false when the timer fires", () => {
    const startTour = vi.fn();

    scheduleProductTourAutoStart({
      getHasSeenProductTour: () => false,
      getTourActive: () => false,
      startTour,
      setTimeout: (callback, delayMs) => setTimeout(callback, delayMs) as unknown as number,
      clearTimeout: (id) => clearTimeout(id),
    });

    vi.advanceTimersByTime(PRODUCT_TOUR_AUTO_START_DELAY_MS);

    expect(startTour).toHaveBeenCalledTimes(1);
  });

  it("does not start the tour if it is already active when the timer fires", () => {
    const startTour = vi.fn();

    scheduleProductTourAutoStart({
      getHasSeenProductTour: () => false,
      getTourActive: () => true,
      startTour,
      setTimeout: (callback, delayMs) => setTimeout(callback, delayMs) as unknown as number,
      clearTimeout: (id) => clearTimeout(id),
    });

    vi.advanceTimersByTime(PRODUCT_TOUR_AUTO_START_DELAY_MS);

    expect(startTour).not.toHaveBeenCalled();
  });

  it("cancels the pending timer via the returned cleanup function", () => {
    const startTour = vi.fn();

    const cancel = scheduleProductTourAutoStart({
      getHasSeenProductTour: () => false,
      getTourActive: () => false,
      startTour,
      setTimeout: (callback, delayMs) => setTimeout(callback, delayMs) as unknown as number,
      clearTimeout: (id) => clearTimeout(id),
    });
    cancel();
    vi.advanceTimersByTime(PRODUCT_TOUR_AUTO_START_DELAY_MS);

    expect(startTour).not.toHaveBeenCalled();
  });
});
