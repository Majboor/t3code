import { describe, expect, it } from "vitest";

import {
  describePackResultCount,
  normalizePackSearchQuery,
  samePackSearchQuery,
  sortPackResultsByName,
  splitPackCardTags,
} from "./packBrowser.logic";

describe("normalizePackSearchQuery", () => {
  it("returns undefined for an empty string", () => {
    expect(normalizePackSearchQuery("")).toBeUndefined();
  });

  it("returns undefined for whitespace only", () => {
    expect(normalizePackSearchQuery("   \t  ")).toBeUndefined();
  });

  it("trims surrounding whitespace", () => {
    expect(normalizePackSearchQuery("  deploy  ")).toBe("deploy");
  });

  it("collapses internal whitespace runs", () => {
    expect(normalizePackSearchQuery("cloudflare   deploy")).toBe("cloudflare deploy");
  });
});

describe("describePackResultCount", () => {
  it("says nothing matched when there is no query", () => {
    expect(describePackResultCount(0, undefined)).toBe("No packs yet.");
  });

  it("names the query when nothing matched it", () => {
    expect(describePackResultCount(0, "xyzzy")).toBe("No packs match “xyzzy”.");
  });

  it("uses the singular for exactly one result", () => {
    expect(describePackResultCount(1, undefined)).toBe("1 pack");
  });

  it("uses the plural and names the query for more than one result", () => {
    expect(describePackResultCount(3, "deploy")).toBe("3 packs matching “deploy”");
  });
});

describe("splitPackCardTags", () => {
  it("keeps everything when under the limit", () => {
    expect(splitPackCardTags(["a", "b"])).toEqual({ visible: ["a", "b"], overflow: 0 });
  });

  it("keeps exactly the limit with no overflow", () => {
    const tags = ["a", "b", "c", "d"];
    expect(splitPackCardTags(tags)).toEqual({ visible: tags, overflow: 0 });
  });

  it("folds anything past the limit into an overflow count", () => {
    const tags = ["a", "b", "c", "d", "e", "f"];
    expect(splitPackCardTags(tags)).toEqual({ visible: ["a", "b", "c", "d"], overflow: 2 });
  });
});

describe("samePackSearchQuery", () => {
  it("treats undefined and undefined as the same", () => {
    expect(samePackSearchQuery(undefined, undefined)).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(samePackSearchQuery("Deploy", "deploy")).toBe(true);
  });

  it("distinguishes different queries", () => {
    expect(samePackSearchQuery("deploy", "email")).toBe(false);
  });
});

describe("sortPackResultsByName", () => {
  it("sorts by display name", () => {
    const packs = [
      { name: "b-pack", displayName: "Beta Pack" },
      { name: "a-pack", displayName: "Alpha Pack" },
    ];
    expect(sortPackResultsByName(packs).map((pack) => pack.displayName)).toEqual([
      "Alpha Pack",
      "Beta Pack",
    ]);
  });

  it("falls back to name when displayName is empty", () => {
    const packs = [
      { name: "zeta", displayName: "" },
      { name: "alpha", displayName: "" },
    ];
    expect(sortPackResultsByName(packs).map((pack) => pack.name)).toEqual(["alpha", "zeta"]);
  });

  it("does not mutate the input array", () => {
    const packs = [
      { name: "b", displayName: "B" },
      { name: "a", displayName: "A" },
    ];
    const sorted = sortPackResultsByName(packs);
    expect(sorted).not.toBe(packs);
    expect(packs.map((pack) => pack.name)).toEqual(["b", "a"]);
  });
});
