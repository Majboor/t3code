/**
 * Scheduling logic for `ProductTourAutoStart` (see `__root.tsx`), split out
 * so the race it guards against can be tested without rendering the route.
 *
 * `hasSeenProductTour` comes from client settings, which hydrate from
 * localStorage (or the desktop bridge) asynchronously — `useSettings`
 * reports the default (`false`) on the very first render no matter what was
 * actually persisted, because the read hasn't resolved yet. If the decision
 * to start the tour is made once, at schedule time, it is made against that
 * stale default — so the tour would auto-start on every page load even for
 * someone who has already dismissed or finished it. The fix is to re-check
 * the freshest values right before the timer fires, not when it is set up.
 */

export const PRODUCT_TOUR_AUTO_START_DELAY_MS = 1_200;

export interface ProductTourAutoStartDeps {
  /** Reads the current `hasSeenProductTour` setting at call time. */
  readonly getHasSeenProductTour: () => boolean;
  /** Reads whether the tour is already running at call time. */
  readonly getTourActive: () => boolean;
  readonly startTour: () => void;
  readonly setTimeout: (callback: () => void, delayMs: number) => number;
  readonly clearTimeout: (id: number) => void;
}

/**
 * Schedules the tour to auto-start after a short delay, re-reading
 * `hasSeenProductTour` / tour-active state when the timer actually fires
 * rather than when it was scheduled. Returns a cleanup function that cancels
 * the pending timer.
 */
export function scheduleProductTourAutoStart(deps: ProductTourAutoStartDeps): () => void {
  const timeoutId = deps.setTimeout(() => {
    if (deps.getHasSeenProductTour() || deps.getTourActive()) {
      return;
    }
    deps.startTour();
  }, PRODUCT_TOUR_AUTO_START_DELAY_MS);

  return () => deps.clearTimeout(timeoutId);
}
