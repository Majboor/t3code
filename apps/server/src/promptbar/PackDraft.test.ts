import { describe, expect, it } from "vitest";

import {
  appendPackDraftEntry,
  createEmptyPackDraft,
  shouldKeepLabeledTurn,
  summarizePackDraft,
  WORTH_KEEPING_THRESHOLD,
  type PackDraftEntry,
} from "./PackDraft.ts";
import type { TurnLabel } from "./TurnLabeling.ts";

function entry(overrides: Partial<PackDraftEntry> = {}): PackDraftEntry {
  return {
    turnId: "turn-1",
    createdAt: "2026-09-19T00:00:00.000Z",
    userPrompt: "deploy this",
    assistantSummary: "Deployed via ssh-deploy.",
    changedFiles: [],
    outcome: "succeeded",
    outcomeConfidence: 0.9,
    findingCategory: "none",
    findingCategoryConfidence: 0.9,
    worthKeeping: 0.8,
    ...overrides,
  };
}

describe("shouldKeepLabeledTurn", () => {
  const label = (worthKeeping: number): TurnLabel => ({
    outcome: "succeeded",
    outcomeConfidence: 0.9,
    findingCategory: "none",
    findingCategoryConfidence: 0.9,
    worthKeeping,
  });

  it("keeps a turn right at the threshold", () => {
    expect(shouldKeepLabeledTurn(label(WORTH_KEEPING_THRESHOLD))).toBe(true);
  });

  it("drops a turn just below the threshold", () => {
    expect(shouldKeepLabeledTurn(label(WORTH_KEEPING_THRESHOLD - 0.01))).toBe(false);
  });
});

describe("createEmptyPackDraft", () => {
  it("starts with no entries and matching created/updated timestamps", () => {
    const draft = createEmptyPackDraft({ packDraftId: "d1", projectId: "p1", now: "2026-09-19T00:00:00.000Z" });
    expect(draft.entries).toEqual([]);
    expect(draft.createdAt).toBe(draft.updatedAt);
  });
});

describe("appendPackDraftEntry", () => {
  it("appends a new entry and bumps updatedAt", () => {
    const draft = createEmptyPackDraft({ packDraftId: "d1", projectId: "p1", now: "2026-09-19T00:00:00.000Z" });
    const next = appendPackDraftEntry(draft, entry(), "2026-09-19T00:05:00.000Z");
    expect(next.entries).toHaveLength(1);
    expect(next.updatedAt).toBe("2026-09-19T00:05:00.000Z");
    expect(draft.entries).toHaveLength(0); // original untouched
  });

  it("replaces rather than duplicates an entry for the same turnId", () => {
    const draft = createEmptyPackDraft({ packDraftId: "d1", projectId: "p1", now: "2026-09-19T00:00:00.000Z" });
    const first = appendPackDraftEntry(draft, entry({ outcome: "partial" }), "2026-09-19T00:05:00.000Z");
    const second = appendPackDraftEntry(first, entry({ outcome: "succeeded" }), "2026-09-19T00:10:00.000Z");
    expect(second.entries).toHaveLength(1);
    expect(second.entries[0]?.outcome).toBe("succeeded");
  });

  it("keeps distinct turnIds as separate entries", () => {
    const draft = createEmptyPackDraft({ packDraftId: "d1", projectId: "p1", now: "2026-09-19T00:00:00.000Z" });
    const first = appendPackDraftEntry(draft, entry({ turnId: "turn-1" }), "2026-09-19T00:05:00.000Z");
    const second = appendPackDraftEntry(first, entry({ turnId: "turn-2" }), "2026-09-19T00:10:00.000Z");
    expect(second.entries.map((e) => e.turnId).sort()).toEqual(["turn-1", "turn-2"]);
  });
});

describe("summarizePackDraft", () => {
  it("tallies outcomes, finding categories, and unique changed files across entries", () => {
    let draft = createEmptyPackDraft({ packDraftId: "d1", projectId: "p1", now: "2026-09-19T00:00:00.000Z" });
    draft = appendPackDraftEntry(
      draft,
      entry({ turnId: "t1", outcome: "succeeded", findingCategory: "fix", changedFiles: ["a.ts", "b.ts"] }),
      "2026-09-19T00:01:00.000Z",
    );
    draft = appendPackDraftEntry(
      draft,
      entry({ turnId: "t2", outcome: "failed", findingCategory: "gotcha", changedFiles: ["b.ts"] }),
      "2026-09-19T00:02:00.000Z",
    );
    draft = appendPackDraftEntry(
      draft,
      entry({ turnId: "t3", outcome: "partial", findingCategory: "fix", changedFiles: [] }),
      "2026-09-19T00:03:00.000Z",
    );

    const summary = summarizePackDraft(draft);
    expect(summary.totalEntries).toBe(3);
    expect(summary.succeeded).toBe(1);
    expect(summary.failed).toBe(1);
    expect(summary.partial).toBe(1);
    expect(summary.byFindingCategory.fix).toBe(2);
    expect(summary.byFindingCategory.gotcha).toBe(1);
    expect(summary.byFindingCategory.none).toBe(0);
    expect(summary.uniqueChangedFiles).toEqual(["a.ts", "b.ts"]);
  });

  it("returns all-zero counts for an empty draft", () => {
    const draft = createEmptyPackDraft({ packDraftId: "d1", projectId: "p1", now: "2026-09-19T00:00:00.000Z" });
    const summary = summarizePackDraft(draft);
    expect(summary.totalEntries).toBe(0);
    expect(summary.uniqueChangedFiles).toEqual([]);
  });
});
