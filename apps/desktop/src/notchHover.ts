/**
 * Hover state machine for the notch panel.
 *
 * The panel is sampled rather than event-driven (see `notchWindow.ts`), so raw
 * "is the cursor inside" answers arrive on a fixed cadence and are noisy at the
 * edges. Requiring the answer to hold for a few consecutive samples turns that
 * into hysteresis: the panel ignores a cursor merely passing through the notch
 * on its way to a menu, and does not blink shut when someone clips a corner.
 */

export interface NotchHoverState {
  readonly expanded: boolean;
  /** Consecutive samples that disagree with `expanded`. */
  readonly dwellSamples: number;
}

/** ~180ms at the sampling interval: long enough to reject a passing cursor. */
export const NOTCH_HOVER_ENTER_SAMPLES = 2;

/** Matched to entry so the panel does not feel stickier than it was eager. */
export const NOTCH_HOVER_EXIT_SAMPLES = 2;

export const initialNotchHoverState: NotchHoverState = { expanded: false, dwellSamples: 0 };

export function reduceNotchHoverState(
  state: NotchHoverState,
  cursorInside: boolean,
): NotchHoverState {
  if (cursorInside === state.expanded) {
    return state.dwellSamples === 0 ? state : { expanded: state.expanded, dwellSamples: 0 };
  }

  const dwellSamples = state.dwellSamples + 1;
  const required = cursorInside ? NOTCH_HOVER_ENTER_SAMPLES : NOTCH_HOVER_EXIT_SAMPLES;
  if (dwellSamples < required) {
    return { expanded: state.expanded, dwellSamples };
  }

  return { expanded: cursorInside, dwellSamples: 0 };
}
