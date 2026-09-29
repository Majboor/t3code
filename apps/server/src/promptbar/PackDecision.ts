/**
 * Pure helpers for the promptbar's stage-3 decision step: turning retrieval's
 * top candidates into a typed-decision API request (one calibrated `noul`
 * question per candidate — "is this pack relevant?") and parsing the answers
 * back into a packId -> probability map.
 *
 * Kept dependency-free (no fetch, no config) so the request/response shaping
 * is unit-testable without a live decision-model call — same rationale as
 * `retrieval.ts` keeping the RRF math separate from `PromptbarClientLive`.
 * The live HTTP call itself (today: OpenRouter's `typesafe/jev-1.13`,
 * eventually a self-hosted GLiClass-style model) lives in
 * `Layers/PromptbarClient.ts` and is swapped by changing that one call site
 * — everything here is provider-agnostic.
 *
 * @module PackDecision
 */

export interface DecisionCandidate {
  readonly packId: string;
  readonly name: string;
  readonly description: string;
}

export interface DecisionContextEntry {
  readonly role: "user" | "assistant" | "tool";
  readonly text: string;
}

/** One `noul` (binary probability) question per candidate, keyed for lookup on the way back. */
export interface DecisionQuestion {
  readonly type: "noul";
  readonly instructions: string;
  readonly criteria: { readonly true: string; readonly false: string };
}

const RELEVANCE_QUESTION_PREFIX = "relevant__";

function relevanceQuestionKey(packId: string): string {
  return `${RELEVANCE_QUESTION_PREFIX}${packId}`;
}

/**
 * Builds the decision model's `state` string: recent turn history (if any)
 * followed by the current prompt, oldest first. Plain, readable text rather
 * than JSON — the decision model reads it as prose context, not a payload to
 * parse.
 */
export function buildDecisionState(
  recentContext: ReadonlyArray<DecisionContextEntry> | undefined,
  currentText: string,
): string {
  const historyLines = (recentContext ?? []).map((entry) => `${entry.role}: ${entry.text}`);
  return [...historyLines, `current prompt: ${currentText}`].join("\n");
}

/** One relevance question per candidate pack, using the pack's own description as the "true" criterion. */
export function buildDecisionQuestions(
  candidates: ReadonlyArray<DecisionCandidate>,
): Record<string, DecisionQuestion> {
  const questions: Record<string, DecisionQuestion> = {};
  for (const candidate of candidates) {
    questions[relevanceQuestionKey(candidate.packId)] = {
      type: "noul",
      instructions: `Is the "${candidate.name}" pack relevant to what the user is asking for right now?`,
      criteria: {
        true: candidate.description,
        false: "Not relevant to this request",
      },
    };
  }
  return questions;
}

/**
 * Pulls each candidate's `noul` probability back out of the decision API's
 * `answers` object by the same key `buildDecisionQuestions` assigned it.
 * A candidate missing from `answers` (a partial/malformed response) is
 * simply absent from the returned map — callers fall back to that
 * candidate's own retrieval score, not a fabricated 0.
 */
export function parseDecisionAnswers(
  answers: Readonly<Record<string, { readonly noul?: unknown }>> | undefined,
  candidates: ReadonlyArray<DecisionCandidate>,
): Map<string, number> {
  const scores = new Map<string, number>();
  for (const candidate of candidates) {
    const value = answers?.[relevanceQuestionKey(candidate.packId)]?.noul;
    if (typeof value === "number" && Number.isFinite(value)) {
      scores.set(candidate.packId, value);
    }
  }
  return scores;
}

/**
 * Re-sorts candidates by decision-model relevance where available (falling
 * back to each candidate's own retrieval score otherwise), attaching
 * `decisionRelevance` to each. Order-stable for candidates the decision
 * model didn't answer for — they keep their relative retrieval order,
 * just sorted after any it did answer.
 */
export function applyDecisionRelevance<
  T extends { readonly packId: string; readonly retrievalScore: number },
>(candidates: ReadonlyArray<T>, relevance: ReadonlyMap<string, number>): Array<T & { readonly decisionRelevance: number | null }> {
  return candidates
    .map((candidate) => ({
      ...candidate,
      decisionRelevance: relevance.get(candidate.packId) ?? null,
    }))
    .toSorted(
      (a, b) =>
        (b.decisionRelevance ?? b.retrievalScore) - (a.decisionRelevance ?? a.retrievalScore),
    );
}
