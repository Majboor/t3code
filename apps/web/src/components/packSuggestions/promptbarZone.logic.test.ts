import { describe, expect, it } from "vitest";

import type { PromptbarCandidate, PromptbarResolution } from "../../environments/primary/promptbar";
import {
  candidateToSuggestablePack,
  deriveZoneDecision,
  isAbstained,
  resolveTabAcceptCandidate,
} from "./promptbarZone.logic";
import type { SuggestablePack } from "./matchPrompt.logic";

const candidate = (overrides: Partial<PromptbarCandidate> = {}): PromptbarCandidate => ({
  packId: "pack-ssh-deploy",
  name: "ssh-deploy",
  description: "Ships a project to a host over SSH.",
  retrievalScore: 0.9,
  params: [],
  ...overrides,
});

const resolution = (overrides: Partial<PromptbarResolution> = {}): PromptbarResolution => ({
  intent: "ACTION",
  confidence: 0.8,
  zone: "attach",
  candidates: [candidate()],
  skipAgent: false,
  note: null,
  ...overrides,
});

describe("deriveZoneDecision", () => {
  it("shows nothing when there is no resolution yet (loading, disabled, or the endpoint is down)", () => {
    expect(deriveZoneDecision(null)).toBeNull();
  });

  it("shows candidates for ACTION intent in the attach zone", () => {
    expect(deriveZoneDecision(resolution({ zone: "attach" }))).toEqual({
      zone: "attach",
      candidates: [candidate()],
    });
  });

  it("shows candidates for ACTION intent in the suggest zone", () => {
    expect(deriveZoneDecision(resolution({ zone: "suggest", confidence: 0.5 }))?.zone).toBe(
      "suggest",
    );
  });

  it("shows nothing in the silent zone, per the confidence table", () => {
    expect(deriveZoneDecision(resolution({ zone: "silent", confidence: 0.1, candidates: [] }))).toBeNull();
  });

  it("suppresses QUESTION intent — documentation search is a separate surface", () => {
    expect(deriveZoneDecision(resolution({ intent: "QUESTION" }))).toBeNull();
  });

  it("suppresses STATEMENT intent", () => {
    expect(deriveZoneDecision(resolution({ intent: "STATEMENT", zone: "silent", candidates: [] }))).toBeNull();
  });

  it("suppresses CONTINUATION intent", () => {
    expect(
      deriveZoneDecision(resolution({ intent: "CONTINUATION", zone: "silent", candidates: [] })),
    ).toBeNull();
  });

  it("shows nothing if ACTION somehow comes back with an empty candidate list", () => {
    expect(deriveZoneDecision(resolution({ candidates: [] }))).toBeNull();
  });
});

describe("isAbstained", () => {
  it("is false with no resolution", () => {
    expect(isAbstained(null)).toBe(false);
  });

  it("is true for ACTION intent gone silent — the eval harness's zero-candidate signal", () => {
    expect(isAbstained(resolution({ zone: "silent", confidence: 0.1, candidates: [] }))).toBe(true);
  });

  it("is true for ACTION intent with an empty candidate list even outside the silent zone", () => {
    expect(isAbstained(resolution({ candidates: [] }))).toBe(true);
  });

  it("is false for a good ACTION match", () => {
    expect(isAbstained(resolution())).toBe(false);
  });

  it("is false for non-ACTION intents — abstaining is only ever about ACTION", () => {
    expect(isAbstained(resolution({ intent: "QUESTION", zone: "silent", candidates: [] }))).toBe(
      false,
    );
  });
});

describe("resolveTabAcceptCandidate", () => {
  it("accepts the top candidate in the suggest zone", () => {
    const result = resolveTabAcceptCandidate({
      resolution: resolution({ zone: "suggest", confidence: 0.5 }),
      searching: false,
      dismissed: false,
    });
    expect(result?.packId).toBe("pack-ssh-deploy");
  });

  it("does nothing in the attach zone — Tab is only for the lower-confidence case", () => {
    const result = resolveTabAcceptCandidate({
      resolution: resolution({ zone: "attach" }),
      searching: false,
      dismissed: false,
    });
    expect(result).toBeNull();
  });

  it("does nothing while hand-searching for a pack", () => {
    const result = resolveTabAcceptCandidate({
      resolution: resolution({ zone: "suggest", confidence: 0.5 }),
      searching: true,
      dismissed: false,
    });
    expect(result).toBeNull();
  });

  it("does nothing once the bar has been dismissed for this prompt", () => {
    const result = resolveTabAcceptCandidate({
      resolution: resolution({ zone: "suggest", confidence: 0.5 }),
      searching: false,
      dismissed: true,
    });
    expect(result).toBeNull();
  });

  it("does nothing in the silent zone", () => {
    const result = resolveTabAcceptCandidate({
      resolution: resolution({ zone: "silent", confidence: 0.1, candidates: [] }),
      searching: false,
      dismissed: false,
    });
    expect(result).toBeNull();
  });
});

describe("candidateToSuggestablePack", () => {
  const known: SuggestablePack = {
    id: "pack-ssh-deploy",
    name: "ssh-deploy",
    qualified: "t3demo/ssh-deploy@1.0.2",
    summary: "Ships a project to a host over SSH and keeps it running.",
    capabilities: ["deploy"],
  };

  it("prefers the workspace's own registry entry, for a correctly qualified mention", () => {
    expect(candidateToSuggestablePack(candidate(), [known])).toBe(known);
  });

  it("falls back to the candidate's own fields when the pack isn't known locally", () => {
    const result = candidateToSuggestablePack(candidate({ packId: "pack-unknown" }), [known]);
    expect(result).toEqual({
      id: "pack-unknown",
      name: "ssh-deploy",
      qualified: "ssh-deploy",
      summary: "Ships a project to a host over SSH.",
      capabilities: [],
    });
  });
});
