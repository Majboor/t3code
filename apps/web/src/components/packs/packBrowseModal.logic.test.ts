import { describe, expect, it } from "vitest";

import type { Pack, PackRequirements } from "./packMode.logic";
import {
  describeBrowseResultCount,
  filterPacksForBrowse,
  sortPacksForBrowse,
} from "./packBrowseModal.logic";

function makePack(
  id: string,
  overrides: Partial<Omit<Pack, "signals">> = {},
  signalOverrides: Partial<Pack["signals"]> = {},
): Pack {
  return {
    id,
    name: `Pack ${id}`,
    version: "1.0.0",
    scope: "ecosystem",
    summary: "Does the thing.",
    handles: [],
    requires: [],
    signals: {
      deployments: 100,
      monthsInService: 12,
      independentOperators: 10,
      cleanInstallRate: 0.95,
      breakagesCaught: 4,
      ...signalOverrides,
    },
    ...overrides,
  };
}

const REQUIREMENTS: PackRequirements = {
  minDeployments: 25,
  minMonthsInService: 3,
  includeAuthorOnly: false,
};

describe("filterPacksForBrowse", () => {
  it("keeps a pack that meets the requirements in ecosystem scope", () => {
    const packs = [makePack("a")];
    expect(filterPacksForBrowse(packs, "ecosystem", REQUIREMENTS)).toEqual(packs);
  });

  it("drops an ecosystem-scoped pack when scope is restricted to this workspace", () => {
    const packs = [makePack("a", { scope: "ecosystem" }), makePack("b", { scope: "workspace" })];
    expect(filterPacksForBrowse(packs, "workspace", REQUIREMENTS).map((p) => p.id)).toEqual(["b"]);
  });

  it("drops a pack below the signal thresholds", () => {
    const packs = [makePack("a", {}, { deployments: 5 })];
    expect(filterPacksForBrowse(packs, "ecosystem", REQUIREMENTS)).toEqual([]);
  });

  it("does not mutate the input array", () => {
    const packs = [makePack("a")];
    filterPacksForBrowse(packs, "ecosystem", REQUIREMENTS);
    expect(packs).toHaveLength(1);
  });
});

describe("sortPacksForBrowse", () => {
  it("puts verified packs first regardless of signals", () => {
    const packs = [
      makePack("z-pack", {}, { deployments: 500 }),
      makePack("verified:a-pack", {}, { deployments: 1 }),
    ];
    expect(sortPacksForBrowse(packs).map((p) => p.id)).toEqual(["verified:a-pack", "z-pack"]);
  });

  it("orders unverified packs by deployments, most first", () => {
    const packs = [makePack("a", {}, { deployments: 10 }), makePack("b", {}, { deployments: 200 })];
    expect(sortPacksForBrowse(packs).map((p) => p.id)).toEqual(["b", "a"]);
  });

  it("breaks a deployment tie alphabetically by name", () => {
    const packs = [
      makePack("a", { name: "Zeta" }, { deployments: 50 }),
      makePack("b", { name: "Alpha" }, { deployments: 50 }),
    ];
    expect(sortPacksForBrowse(packs).map((p) => p.name)).toEqual(["Alpha", "Zeta"]);
  });

  it("does not mutate the input array", () => {
    const packs = [makePack("b"), makePack("a")];
    const sorted = sortPacksForBrowse(packs);
    expect(sorted).not.toBe(packs);
  });
});

describe("describeBrowseResultCount", () => {
  it("says nothing meets the filters when there is no query", () => {
    expect(describeBrowseResultCount(0, "")).toBe("No packs meet these filters yet.");
  });

  it("names the query when nothing matched it", () => {
    expect(describeBrowseResultCount(0, "xyzzy")).toBe("No packs match “xyzzy”.");
  });

  it("uses the singular for exactly one filtered result", () => {
    expect(describeBrowseResultCount(1, "")).toBe("1 pack meets these filters");
  });

  it("uses the plural and names the query for more than one result", () => {
    expect(describeBrowseResultCount(3, "deploy")).toBe("3 packs matching “deploy”");
  });
});
