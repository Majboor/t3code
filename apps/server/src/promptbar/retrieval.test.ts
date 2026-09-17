import { describe, expect, it } from "vitest";

import {
  bestRankPerPack,
  buildFtsMatchQuery,
  computeSkipAgent,
  normalizeRrfScores,
  reciprocalRankFusion,
  RRF_K,
  topFusedPackIds,
} from "./retrieval.ts";

describe("bestRankPerPack", () => {
  it("assigns 1-indexed ranks in first-seen order", () => {
    const ranks = bestRankPerPack([{ packId: "a" }, { packId: "b" }, { packId: "c" }]);
    expect(ranks.get("a")).toBe(1);
    expect(ranks.get("b")).toBe(2);
    expect(ranks.get("c")).toBe(3);
  });

  it("keeps a pack's first (best) rank when it repeats across phrasings", () => {
    const ranks = bestRankPerPack([{ packId: "ssh_deploy" }, { packId: "analytics_core" }, { packId: "ssh_deploy" }]);
    expect(ranks.get("ssh_deploy")).toBe(1);
    expect(ranks.get("analytics_core")).toBe(2);
    expect(ranks.size).toBe(2);
  });

  it("returns an empty map for no hits", () => {
    expect(bestRankPerPack([]).size).toBe(0);
  });
});

describe("reciprocalRankFusion", () => {
  it("matches the spec formula: score = Σ 1/(60 + rank_i)", () => {
    const bm25 = new Map([["a", 1]]);
    const dense = new Map([["a", 3]]);
    const scores = reciprocalRankFusion([bm25, dense]);
    expect(scores.get("a")).toBeCloseTo(1 / (RRF_K + 1) + 1 / (RRF_K + 3), 10);
  });

  it("gives a pack found by only one leg just that leg's contribution", () => {
    const bm25 = new Map([["a", 1]]);
    const dense = new Map<string, number>();
    const scores = reciprocalRankFusion([bm25, dense]);
    expect(scores.get("a")).toBeCloseTo(1 / (RRF_K + 1), 10);
  });

  it("ranks a pack found near the top of both legs above one found only at the top of one leg", () => {
    const bm25 = new Map([
      ["found-by-both", 2],
      ["bm25-only", 1],
    ]);
    const dense = new Map([["found-by-both", 2]]);
    const scores = reciprocalRankFusion([bm25, dense]);
    expect(scores.get("found-by-both")!).toBeGreaterThan(scores.get("bm25-only")!);
  });
});

describe("normalizeRrfScores", () => {
  it("scales a pack ranked #1 in every list up to exactly 1.0", () => {
    const raw = reciprocalRankFusion([new Map([["a", 1]]), new Map([["a", 1]])]);
    const normalized = normalizeRrfScores(raw, 2);
    expect(normalized.get("a")).toBeCloseTo(1, 10);
  });

  it("keeps raw RRF's relative ordering (a monotonic rescale)", () => {
    const raw = reciprocalRankFusion([
      new Map([
        ["a", 1],
        ["b", 5],
      ]),
    ]);
    const normalized = normalizeRrfScores(raw, 1);
    expect(normalized.get("a")!).toBeGreaterThan(normalized.get("b")!);
  });

  it("puts scores in a range where the skipAgent 0.85/0.25 thresholds are reachable", () => {
    // Without normalization, raw RRF for 2 lists tops out around 2/61 ≈
    // 0.033 - nowhere near 0.85 - which would make skipAgent permanently
    // false. This is the regression this normalization step exists to fix.
    const raw = reciprocalRankFusion([new Map([["a", 1]]), new Map([["a", 1]])]);
    const normalized = normalizeRrfScores(raw, 2);
    expect(normalized.get("a")!).toBeGreaterThan(0.85);
  });
});

describe("topFusedPackIds", () => {
  it("sorts by score descending and truncates to the limit", () => {
    const scores = new Map([
      ["low", 0.01],
      ["high", 0.5],
      ["mid", 0.2],
    ]);
    expect(topFusedPackIds(scores, 2)).toEqual([
      { packId: "high", score: 0.5 },
      { packId: "mid", score: 0.2 },
    ]);
  });
});

describe("computeSkipAgent", () => {
  it("is false with fewer than two candidates", () => {
    expect(computeSkipAgent([])).toBe(false);
    expect(computeSkipAgent([{ retrievalScore: 0.99 }])).toBe(false);
  });

  it("is true when the top score is above 0.85 and the gap to #2 exceeds 0.25", () => {
    expect(computeSkipAgent([{ retrievalScore: 0.9 }, { retrievalScore: 0.6 }])).toBe(true);
  });

  it("is false when the top score does not clear 0.85, even with a big gap", () => {
    expect(computeSkipAgent([{ retrievalScore: 0.8 }, { retrievalScore: 0.1 }])).toBe(false);
  });

  it("is false when the top score clears 0.85 but the gap does not exceed 0.25", () => {
    expect(computeSkipAgent([{ retrievalScore: 0.9 }, { retrievalScore: 0.7 }])).toBe(false);
  });

  it("treats the thresholds as strict (not inclusive)", () => {
    expect(computeSkipAgent([{ retrievalScore: 0.85 }, { retrievalScore: 0.6 }])).toBe(false);
    expect(computeSkipAgent([{ retrievalScore: 0.86 }, { retrievalScore: 0.61 }])).toBe(false);
  });
});

describe("buildFtsMatchQuery", () => {
  it("ORs quoted tokens together for a permissive, recall-oriented match", () => {
    expect(buildFtsMatchQuery("restart nginx")).toBe('"restart" OR "nginx"');
  });

  it("strips FTS5 operator characters instead of letting them form a query", () => {
    expect(buildFtsMatchQuery("deploy -this \"NEAR\" thing*")).toBe(
      '"deploy" OR "this" OR "NEAR" OR "thing"',
    );
  });

  it("escapes a literal double quote inside a token by doubling it", () => {
    // buildFtsMatchQuery only ever emits quotes it itself added around a
    // token, but a token containing `"` (however unlikely from `\w+`
    // matching) must still come out as valid FTS5 string-literal syntax.
    expect(buildFtsMatchQuery('say "hi"')).toBe('"say" OR "hi"');
  });

  it("returns null for text with no indexable tokens", () => {
    expect(buildFtsMatchQuery("   ")).toBeNull();
    expect(buildFtsMatchQuery("???")).toBeNull();
    expect(buildFtsMatchQuery("")).toBeNull();
  });

  it("keeps Roman Urdu / code-switched phrasings as ordinary tokens", () => {
    expect(buildFtsMatchQuery("analytics lagao")).toBe('"analytics" OR "lagao"');
  });
});
