import { describe, expect, it } from "vitest";

import { buildTurnLabelQuestions, buildTurnLabelState, parseTurnLabelAnswers } from "./TurnLabeling.ts";

describe("buildTurnLabelQuestions", () => {
  it("builds exactly the three expected questions", () => {
    const questions = buildTurnLabelQuestions();
    expect(Object.keys(questions).sort()).toEqual(["finding_category", "outcome", "worth_keeping"]);
    expect(questions["outcome"]?.type).toBe("choice");
    expect(questions["finding_category"]?.type).toBe("choice");
    expect(questions["worth_keeping"]?.type).toBe("noul");
  });

  it("covers all outcome and finding-category values in their criteria", () => {
    const questions = buildTurnLabelQuestions();
    const outcome = questions["outcome"];
    const category = questions["finding_category"];
    expect(outcome?.type).toBe("choice");
    expect(category?.type).toBe("choice");
    if (outcome?.type === "choice") {
      expect(Object.keys(outcome.criteria).sort()).toEqual(["failed", "partial", "succeeded"]);
    }
    if (category?.type === "choice") {
      expect(Object.keys(category.criteria).sort()).toEqual([
        "config",
        "error_resolution",
        "fix",
        "gotcha",
        "none",
      ]);
    }
  });
});

describe("buildTurnLabelState", () => {
  it("includes the prompt, response, and activity summaries in order", () => {
    const state = buildTurnLabelState({
      userPrompt: "deploy this",
      assistantSummary: "Deployed via ssh-deploy, registered as a live target.",
      activitySummaries: ["ran: t3 deploy add", "ran: t3 deploy run"],
    });
    expect(state).toBe(
      [
        "user prompt: deploy this",
        "assistant response: Deployed via ssh-deploy, registered as a live target.",
        "what happened:",
        "- ran: t3 deploy add",
        "- ran: t3 deploy run",
      ].join("\n"),
    );
  });

  it("omits the activity section entirely when there is nothing to report", () => {
    const state = buildTurnLabelState({
      userPrompt: "thanks",
      assistantSummary: "You're welcome!",
      activitySummaries: [],
    });
    expect(state).toBe("user prompt: thanks\nassistant response: You're welcome!");
  });
});

describe("parseTurnLabelAnswers", () => {
  const wellFormed = {
    outcome: { choice: "succeeded", probabilities: { succeeded: 0.9, partial: 0.08, failed: 0.02 } },
    finding_category: {
      choice: "fix",
      probabilities: { fix: 0.7, gotcha: 0.1, config: 0.1, error_resolution: 0.05, none: 0.05 },
    },
    worth_keeping: { noul: 0.95 },
  };

  it("parses a well-formed response into a full label", () => {
    expect(parseTurnLabelAnswers(wellFormed)).toEqual({
      outcome: "succeeded",
      outcomeConfidence: 0.9,
      findingCategory: "fix",
      findingCategoryConfidence: 0.7,
      worthKeeping: 0.95,
    });
  });

  it("returns null when any one of the three answers is missing", () => {
    const { outcome: _outcome, ...withoutOutcome } = wellFormed;
    expect(parseTurnLabelAnswers(withoutOutcome)).toBeNull();
  });

  it("returns null when a choice value isn't a valid category", () => {
    expect(
      parseTurnLabelAnswers({
        ...wellFormed,
        outcome: { choice: "banana", probabilities: wellFormed.outcome.probabilities },
      }),
    ).toBeNull();
  });

  it("returns null when worth_keeping's noul isn't a number", () => {
    expect(
      parseTurnLabelAnswers({ ...wellFormed, worth_keeping: { noul: "yes" } }),
    ).toBeNull();
  });

  it("tolerates an undefined answers object", () => {
    expect(parseTurnLabelAnswers(undefined)).toBeNull();
  });
});
