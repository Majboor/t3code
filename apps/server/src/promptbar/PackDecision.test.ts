import { describe, expect, it } from "vitest";

import {
  applyDecisionRelevance,
  buildDecisionQuestions,
  buildDecisionState,
  parseDecisionAnswers,
  type DecisionCandidate,
} from "./PackDecision.ts";

const sshDeploy: DecisionCandidate = {
  packId: "ssh_deploy",
  name: "ssh-deploy",
  description: "Ships a project to a host over SSH.",
};
const cloudflareDeploy: DecisionCandidate = {
  packId: "cloudflare_deploy",
  name: "cloudflare-deploy",
  description: "Deploys through a Cloudflare quick tunnel or Pages.",
};

describe("buildDecisionState", () => {
  it("joins recent context (oldest first) with the current prompt, one line each", () => {
    const state = buildDecisionState(
      [
        { role: "user", text: "can you deploy this" },
        { role: "assistant", text: "which target did you want?" },
      ],
      "try fireworks",
    );
    expect(state).toBe(
      "user: can you deploy this\nassistant: which target did you want?\ncurrent prompt: try fireworks",
    );
  });

  it("is just the current prompt when there is no recent context", () => {
    expect(buildDecisionState(undefined, "hello")).toBe("current prompt: hello");
    expect(buildDecisionState([], "hello")).toBe("current prompt: hello");
  });
});

describe("buildDecisionQuestions", () => {
  it("builds one noul question per candidate, keyed distinctly, using its description as the true criterion", () => {
    const questions = buildDecisionQuestions([sshDeploy, cloudflareDeploy]);
    const keys = Object.keys(questions);
    expect(keys).toHaveLength(2);
    expect(keys[0]).not.toBe(keys[1]);
    for (const key of keys) {
      expect(questions[key]?.type).toBe("noul");
    }
    const sshKey = keys.find((key) => questions[key]?.criteria.true === sshDeploy.description);
    expect(sshKey).toBeDefined();
    expect(questions[sshKey!]?.instructions).toContain("ssh-deploy");
  });

  it("returns an empty object for no candidates", () => {
    expect(buildDecisionQuestions([])).toEqual({});
  });
});

describe("parseDecisionAnswers", () => {
  it("round-trips through buildDecisionQuestions' own keys", () => {
    const questions = buildDecisionQuestions([sshDeploy, cloudflareDeploy]);
    const sshKey = Object.keys(questions).find(
      (key) => questions[key]?.criteria.true === sshDeploy.description,
    )!;
    const cloudflareKey = Object.keys(questions).find(
      (key) => questions[key]?.criteria.true === cloudflareDeploy.description,
    )!;

    const scores = parseDecisionAnswers(
      { [sshKey]: { noul: 0.96 }, [cloudflareKey]: { noul: 0.16 } },
      [sshDeploy, cloudflareDeploy],
    );
    expect(scores.get("ssh_deploy")).toBe(0.96);
    expect(scores.get("cloudflare_deploy")).toBe(0.16);
  });

  it("omits a candidate missing from the response rather than defaulting it to 0", () => {
    const scores = parseDecisionAnswers({}, [sshDeploy]);
    expect(scores.has("ssh_deploy")).toBe(false);
  });

  it("omits a candidate whose answer is present but not a finite number", () => {
    const questions = buildDecisionQuestions([sshDeploy]);
    const key = Object.keys(questions)[0]!;
    const scores = parseDecisionAnswers({ [key]: { noul: Number.NaN } }, [sshDeploy]);
    expect(scores.has("ssh_deploy")).toBe(false);
  });

  it("tolerates an undefined answers object", () => {
    expect(parseDecisionAnswers(undefined, [sshDeploy]).size).toBe(0);
  });
});

describe("applyDecisionRelevance", () => {
  const base = [
    { packId: "cloudflare_deploy", retrievalScore: 0.9 },
    { packId: "ssh_deploy", retrievalScore: 0.8 },
  ];

  it("re-sorts by decision relevance even when it disagrees with retrieval's own ranking", () => {
    const relevance = new Map([
      ["cloudflare_deploy", 0.1],
      ["ssh_deploy", 0.95],
    ]);
    const result = applyDecisionRelevance(base, relevance);
    expect(result.map((c) => c.packId)).toEqual(["ssh_deploy", "cloudflare_deploy"]);
    expect(result[0]?.decisionRelevance).toBe(0.95);
    expect(result[1]?.decisionRelevance).toBe(0.1);
  });

  it("falls back to retrievalScore for ordering when a candidate has no decision answer", () => {
    const relevance = new Map([["ssh_deploy", 0.95]]);
    const result = applyDecisionRelevance(base, relevance);
    // ssh_deploy: decisionRelevance 0.95 beats cloudflare_deploy's fallback retrievalScore 0.9.
    expect(result.map((c) => c.packId)).toEqual(["ssh_deploy", "cloudflare_deploy"]);
    expect(result[1]?.decisionRelevance).toBeNull();
  });

  it("keeps retrieval's own order when relevance is empty for everyone", () => {
    const result = applyDecisionRelevance(base, new Map());
    expect(result.map((c) => c.packId)).toEqual(["cloudflare_deploy", "ssh_deploy"]);
    expect(result.every((c) => c.decisionRelevance === null)).toBe(true);
  });
});
