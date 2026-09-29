/**
 * Pure helpers for classifying composer text into one of the promptbar's four
 * intents (ACTION/QUESTION/STATEMENT/CONTINUATION) via a typed-decision model
 * `choice` question, replacing the old bespoke classifier service.
 *
 * Kept dependency-free (no fetch, no config) for the same reason
 * `PackDecision.ts` is — the request/response shaping is unit-testable
 * without a live call. `zone` is deliberately not asked for: it has always
 * been a pure function of confidence alone (`zoneForConfidence` in
 * `intentRouting.ts`), never an independent model output, live classifier
 * included.
 *
 * @module IntentClassification
 */
import type { PromptbarIntent } from "./Services/PromptbarClient.ts";
import type { IntentScores } from "./intentRouting.ts";

export interface IntentChoiceQuestion {
  readonly type: "choice";
  readonly instructions: string;
  readonly criteria: Readonly<Record<PromptbarIntent, string>>;
}

const INTENT_QUESTION_KEY = "intent";

const INTENT_CRITERIA: Readonly<Record<PromptbarIntent, string>> = {
  ACTION:
    "The user wants something done — a task, request, or instruction to carry out (e.g. \"deploy this\", \"write a function\", \"fix this bug\").",
  QUESTION: "The user is asking a question rather than requesting that any action be performed.",
  STATEMENT:
    "A plain remark, acknowledgement, or comment that is not a request for anything (e.g. \"that's intense\", \"ok cool\", \"thanks\").",
  CONTINUATION:
    "A short follow-up building on what the agent was just doing (e.g. \"yes do that\", \"also add X\", \"try the other one\") rather than a new standalone request.",
};

/** One `choice` question over the four intents, keyed for lookup on the way back. */
export function buildIntentQuestion(): Record<string, IntentChoiceQuestion> {
  return {
    [INTENT_QUESTION_KEY]: {
      type: "choice",
      instructions:
        "In the context of a coding-assistant chat, what kind of message is this — what is the user doing with it?",
      criteria: INTENT_CRITERIA,
    },
  };
}

function isPromptbarIntent(value: unknown): value is PromptbarIntent {
  return value === "ACTION" || value === "QUESTION" || value === "STATEMENT" || value === "CONTINUATION";
}

function isIntentScores(value: unknown): value is IntentScores {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record["ACTION"] === "number" &&
    typeof record["QUESTION"] === "number" &&
    typeof record["STATEMENT"] === "number" &&
    typeof record["CONTINUATION"] === "number"
  );
}

/**
 * Pulls the intent choice/probabilities back out of the decision API's
 * `answers` object. Returns `null` for a missing or malformed answer — the
 * caller's job to decide what "the model didn't answer" means, not this
 * function's.
 */
export function parseIntentAnswer(
  answers: Readonly<Record<string, { readonly choice?: unknown; readonly probabilities?: unknown }>> | undefined,
): { readonly intent: PromptbarIntent; readonly probabilities: IntentScores } | null {
  const answer = answers?.[INTENT_QUESTION_KEY];
  if (!answer || !isPromptbarIntent(answer.choice) || !isIntentScores(answer.probabilities)) {
    return null;
  }
  return { intent: answer.choice, probabilities: answer.probabilities };
}
