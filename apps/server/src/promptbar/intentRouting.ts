/**
 * Pure intent-routing rules layered on top of the raw classifier response —
 * kept separate from the HTTP-calling `Layers/PromptbarClient.ts` so the two
 * rules that actually have edge cases (the CONTINUATION-on-first-message
 * override, and the zone recomputed after that override) are unit-testable
 * without a live classifier. See `intentRouting.test.ts`.
 *
 * @module intentRouting
 */
import type { PromptbarIntent, PromptbarZone } from "./Services/PromptbarClient.ts";

/** Matches the classifier's own `/health` thresholds (`attach: 0.6, suggest: 0.35`). */
export const ATTACH_THRESHOLD = 0.6;
export const SUGGEST_THRESHOLD = 0.35;

export interface IntentScores {
  readonly ACTION: number;
  readonly QUESTION: number;
  readonly STATEMENT: number;
  readonly CONTINUATION: number;
}

export function zoneForConfidence(confidence: number): PromptbarZone {
  if (confidence >= ATTACH_THRESHOLD) return "attach";
  if (confidence >= SUGGEST_THRESHOLD) return "suggest";
  return "silent";
}

/**
 * The spec's hard rule: "the first message in a session can never be a
 * CONTINUATION - enforce that as a hard rule, it's free precision." The
 * classifier has no session memory, so it can and does say CONTINUATION on a
 * first message; when that happens here, we pick the best-scoring intent
 * among the other three from the classifier's own `all` distribution rather
 * than discard the call and re-ask it, since it already computed those
 * scores.
 */
export function reclassifyAwayFromContinuation(all: IntentScores): {
  readonly intent: Exclude<PromptbarIntent, "CONTINUATION">;
  readonly confidence: number;
} {
  const candidates: ReadonlyArray<readonly [Exclude<PromptbarIntent, "CONTINUATION">, number]> = [
    ["ACTION", all.ACTION],
    ["QUESTION", all.QUESTION],
    ["STATEMENT", all.STATEMENT],
  ];
  const [intent, confidence] = candidates.reduce((best, next) => (next[1] > best[1] ? next : best));
  return { intent, confidence };
}

export interface EffectiveIntent {
  readonly intent: PromptbarIntent;
  readonly confidence: number;
  readonly zone: PromptbarZone;
  /** Set only when the CONTINUATION-on-first-message override fired. */
  readonly note: string | null;
}

/**
 * Applies the first-message hard rule and the "STATEMENT is always silent"
 * rule from `PromptbarResolution`'s frozen doc comment on top of a raw
 * classifier response, producing the intent/confidence/zone/note this
 * service actually reports.
 */
export function resolveEffectiveIntent(
  classified: { readonly intent: PromptbarIntent; readonly confidence: number; readonly zone: PromptbarZone; readonly all: IntentScores },
  isFirstMessageInSession: boolean,
): EffectiveIntent {
  let intent: PromptbarIntent = classified.intent;
  let confidence = classified.confidence;
  let zone = classified.zone;
  let note: string | null = null;

  if (isFirstMessageInSession && intent === "CONTINUATION") {
    const reclassified = reclassifyAwayFromContinuation(classified.all);
    intent = reclassified.intent;
    confidence = reclassified.confidence;
    zone = zoneForConfidence(confidence);
    note =
      `Classifier said CONTINUATION on the first message of a session, which is never valid there; ` +
      `reclassified as ${intent} (confidence ${confidence.toFixed(4)}) from its own score distribution.`;
  }

  // Frozen interface: "STATEMENT -> always empty, zone is always 'silent'",
  // regardless of what confidence produced it (the live classifier itself
  // reports STATEMENT with an "attach"-level zone, since its zone is a
  // function of confidence alone, not of which intent it's attached to).
  if (intent === "STATEMENT") {
    zone = "silent";
  }

  return { intent, confidence, zone, note };
}
