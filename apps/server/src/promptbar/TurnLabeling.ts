/**
 * Pure helpers for labeling a completed turn via the same typed-decision
 * model as intent classification and pack disambiguation — the "did this
 * work, is it worth keeping" tagging step behind auto-pack-building.
 *
 * Jev only ever returns typed classifications (probabilities over fixed
 * categories) — never free text. It cannot write a finding's prose or
 * extract a snippet; it can only say "this turn looks like a fix, with high
 * confidence" or "this failed." Turning a run of labeled turns into an
 * actual pack's prose knowledge (`handover.md`-style write-ups) still needs
 * a real generative call — this module's job ends at the label.
 *
 * Kept dependency-free (no fetch, no config) for the same reason
 * `PackDecision.ts`/`IntentClassification.ts` are.
 *
 * @module TurnLabeling
 */

export type TurnOutcome = "succeeded" | "partial" | "failed";
export type TurnFindingCategory = "fix" | "gotcha" | "config" | "error_resolution" | "none";

export interface TurnLabelingInput {
  readonly userPrompt: string;
  readonly assistantSummary: string;
  /** Short one-line-per-item summaries — "ran: npm test", "edited: src/foo.ts", "error: 404 from X". */
  readonly activitySummaries: ReadonlyArray<string>;
}

export interface TurnLabelChoiceQuestion {
  readonly type: "choice";
  readonly instructions: string;
  readonly criteria: Readonly<Record<string, string>>;
}

export interface TurnLabelNoulQuestion {
  readonly type: "noul";
  readonly instructions: string;
  readonly criteria: { readonly true: string; readonly false: string };
}

const OUTCOME_KEY = "outcome";
const FINDING_CATEGORY_KEY = "finding_category";
const WORTH_KEEPING_KEY = "worth_keeping";

const OUTCOME_CRITERIA: Readonly<Record<TurnOutcome, string>> = {
  succeeded: "The turn accomplished what the user asked, with no unresolved errors.",
  partial: "Some progress was made, but the turn ended incomplete, blocked, or with an unresolved issue.",
  failed: "The turn did not accomplish what the user asked, or ended in an error that was never resolved.",
};

const FINDING_CATEGORY_CRITERIA: Readonly<Record<TurnFindingCategory, string>> = {
  fix: "A real bug was found and fixed — the root cause and the fix are both worth remembering.",
  gotcha: "A non-obvious pitfall, surprising behavior, or a wrong assumption that cost time to discover.",
  config: "A configuration, environment, or setup detail that was needed to make something work.",
  error_resolution: "An error was hit and worked around or resolved, but it wasn't a deeper code bug.",
  none: "Nothing here is worth recording as a distinct finding.",
};

/**
 * Three questions in one call: outcome (choice), finding category (choice),
 * and whether this turn is worth keeping in a pack draft at all (noul) —
 * filters out trivial turns ("hi", "thanks") before they ever reach storage.
 */
export function buildTurnLabelQuestions(): Record<
  string,
  TurnLabelChoiceQuestion | TurnLabelNoulQuestion
> {
  return {
    [OUTCOME_KEY]: {
      type: "choice",
      instructions: "Given what the user asked and what actually happened, how did this turn go?",
      criteria: OUTCOME_CRITERIA,
    },
    [FINDING_CATEGORY_KEY]: {
      type: "choice",
      instructions:
        "If this turn contains something worth remembering for next time, what kind of finding is it? Pick \"none\" if there's nothing distinct worth recording.",
      criteria: FINDING_CATEGORY_CRITERIA,
    },
    [WORTH_KEEPING_KEY]: {
      type: "noul",
      instructions:
        "Is this turn substantial enough to record in a workspace pack — real work, a real decision, or a real finding — rather than routine chit-chat, a trivial greeting, or a no-op?",
      criteria: {
        true: "Substantial: real work was done, decided, or discovered.",
        false: "Trivial: small talk, acknowledgement, or nothing notable happened.",
      },
    },
  };
}

/** Plain-text `state` for the labeling call: the prompt, the response, then what actually happened. */
export function buildTurnLabelState(input: TurnLabelingInput): string {
  const lines = [
    `user prompt: ${input.userPrompt}`,
    `assistant response: ${input.assistantSummary}`,
  ];
  if (input.activitySummaries.length > 0) {
    lines.push("what happened:", ...input.activitySummaries.map((line) => `- ${line}`));
  }
  return lines.join("\n");
}

export interface TurnLabel {
  readonly outcome: TurnOutcome;
  readonly outcomeConfidence: number;
  readonly findingCategory: TurnFindingCategory;
  readonly findingCategoryConfidence: number;
  readonly worthKeeping: number;
}

function isTurnOutcome(value: unknown): value is TurnOutcome {
  return value === "succeeded" || value === "partial" || value === "failed";
}

function isTurnFindingCategory(value: unknown): value is TurnFindingCategory {
  return value === "fix" || value === "gotcha" || value === "config" || value === "error_resolution" || value === "none";
}

function isProbabilityRecord(value: unknown): value is Record<string, number> {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.values(value as Record<string, unknown>).every((entry) => typeof entry === "number")
  );
}

/** Parses all three answers, or `null` if any one of them is missing or malformed — a partial label is not a usable one. */
export function parseTurnLabelAnswers(
  answers:
    | Readonly<
        Record<
          string,
          { readonly choice?: unknown; readonly probabilities?: unknown; readonly noul?: unknown }
        >
      >
    | undefined,
): TurnLabel | null {
  const outcomeAnswer = answers?.[OUTCOME_KEY];
  const categoryAnswer = answers?.[FINDING_CATEGORY_KEY];
  const worthKeepingAnswer = answers?.[WORTH_KEEPING_KEY];

  if (
    !outcomeAnswer ||
    !isTurnOutcome(outcomeAnswer.choice) ||
    !isProbabilityRecord(outcomeAnswer.probabilities)
  ) {
    return null;
  }
  if (
    !categoryAnswer ||
    !isTurnFindingCategory(categoryAnswer.choice) ||
    !isProbabilityRecord(categoryAnswer.probabilities)
  ) {
    return null;
  }
  if (!worthKeepingAnswer || typeof worthKeepingAnswer.noul !== "number") {
    return null;
  }

  return {
    outcome: outcomeAnswer.choice,
    outcomeConfidence: outcomeAnswer.probabilities[outcomeAnswer.choice] ?? 0,
    findingCategory: categoryAnswer.choice,
    findingCategoryConfidence: categoryAnswer.probabilities[categoryAnswer.choice] ?? 0,
    worthKeeping: worthKeepingAnswer.noul,
  };
}
