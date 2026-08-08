import { describe, expect, it } from "vitest";

import type { Pack, PackRequirements } from "./packMode.logic";
import {
  appendPackInstructionToPrompt,
  buildPackIntegrationInstruction,
  formatTimeInService,
  packMeetsRequirements,
  selectSuggestedPack,
} from "./packMode.logic";

function makePack(id: string, overrides: Partial<Pack["signals"]> = {}): Pack {
  return {
    id,
    name: `Pack ${id}`,
    version: "1.0.0",
    scope: "ecosystem",
    summary: "Does the thing.",
    handles: ["the case that breaks most implementations"],
    requires: ["an API key"],
    signals: {
      deployments: 100,
      monthsInService: 12,
      independentOperators: 10,
      cleanInstallRate: 0.95,
      breakagesCaught: 4,
      ...overrides,
    },
  };
}

const REQUIREMENTS: PackRequirements = {
  minDeployments: 25,
  minMonthsInService: 3,
  includeAuthorOnly: false,
};

describe("packMeetsRequirements", () => {
  it("accepts a pack that clears every signal", () => {
    expect(packMeetsRequirements(makePack("a"), REQUIREMENTS)).toBe(true);
  });

  it("rejects a pack below the deployment or service floor", () => {
    expect(packMeetsRequirements(makePack("a", { deployments: 24 }), REQUIREMENTS)).toBe(false);
    expect(packMeetsRequirements(makePack("a", { monthsInService: 2 }), REQUIREMENTS)).toBe(false);
  });

  it("rejects a pack only its author has run unless that is asked for", () => {
    const authorOnly = makePack("a", { independentOperators: 0 });
    expect(packMeetsRequirements(authorOnly, REQUIREMENTS)).toBe(false);
    expect(packMeetsRequirements(authorOnly, { ...REQUIREMENTS, includeAuthorOnly: true })).toBe(
      true,
    );
  });
});

describe("selectSuggestedPack", () => {
  it("prefers the most deployed pack, then the longest running", () => {
    const packs = [
      makePack("a", { deployments: 100, monthsInService: 20 }),
      makePack("b", { deployments: 400 }),
      makePack("c", { deployments: 400, monthsInService: 30 }),
    ];
    expect(selectSuggestedPack(packs, [])?.id).toBe("c");
  });

  it("skips dismissed packs and returns nothing when all are dismissed", () => {
    const packs = [makePack("a"), makePack("b", { deployments: 900 })];
    expect(selectSuggestedPack(packs, ["b"])?.id).toBe("a");
    expect(selectSuggestedPack(packs, ["a", "b"])).toBeNull();
  });
});

describe("formatTimeInService", () => {
  it("reads as plain language at every scale", () => {
    expect(formatTimeInService(0)).toBe("under a month in service");
    expect(formatTimeInService(7)).toBe("7 months in service");
    expect(formatTimeInService(12)).toBe("a year in service");
    expect(formatTimeInService(30)).toBe("2 years in service");
  });
});

describe("buildPackIntegrationInstruction", () => {
  it("argues correctness and never effort saved", () => {
    const instruction = buildPackIntegrationInstruction(makePack("a"));
    expect(instruction).toContain("the case that breaks most implementations");
    expect(instruction).toContain("100 deployments");
    expect(instruction).toContain("an API key");
    expect(instruction.toLowerCase()).not.toContain("token");
  });
});

describe("appendPackInstructionToPrompt", () => {
  it("keeps what the person already wrote", () => {
    expect(appendPackInstructionToPrompt("add billing  ", "Use the pack.")).toBe(
      "add billing\n\nUse the pack.",
    );
    expect(appendPackInstructionToPrompt("", "Use the pack.")).toBe("Use the pack.");
  });
});
