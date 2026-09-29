import { describe, expect, it } from "vitest";

import { buildIntentQuestion, parseIntentAnswer } from "./IntentClassification.ts";

describe("buildIntentQuestion", () => {
  it("builds exactly one choice question covering all four intents", () => {
    const questions = buildIntentQuestion();
    const keys = Object.keys(questions);
    expect(keys).toHaveLength(1);
    const question = questions[keys[0]!]!;
    expect(question.type).toBe("choice");
    expect(Object.keys(question.criteria).sort()).toEqual([
      "ACTION",
      "CONTINUATION",
      "QUESTION",
      "STATEMENT",
    ]);
  });
});

describe("parseIntentAnswer", () => {
  it("extracts the choice and probability distribution when well-formed", () => {
    const questions = buildIntentQuestion();
    const key = Object.keys(questions)[0]!;
    const result = parseIntentAnswer({
      [key]: {
        choice: "ACTION",
        probabilities: { ACTION: 0.82, QUESTION: 0.1, STATEMENT: 0.05, CONTINUATION: 0.03 },
      },
    });
    expect(result).toEqual({
      intent: "ACTION",
      probabilities: { ACTION: 0.82, QUESTION: 0.1, STATEMENT: 0.05, CONTINUATION: 0.03 },
    });
  });

  it("returns null when the answer is missing entirely", () => {
    expect(parseIntentAnswer({})).toBeNull();
    expect(parseIntentAnswer(undefined)).toBeNull();
  });

  it("returns null when the choice isn't one of the four valid intents", () => {
    const questions = buildIntentQuestion();
    const key = Object.keys(questions)[0]!;
    const result = parseIntentAnswer({
      [key]: {
        choice: "BANANA",
        probabilities: { ACTION: 0.25, QUESTION: 0.25, STATEMENT: 0.25, CONTINUATION: 0.25 },
      },
    });
    expect(result).toBeNull();
  });

  it("returns null when probabilities are missing a required key", () => {
    const questions = buildIntentQuestion();
    const key = Object.keys(questions)[0]!;
    const result = parseIntentAnswer({
      [key]: { choice: "ACTION", probabilities: { ACTION: 0.9 } },
    });
    expect(result).toBeNull();
  });
});
