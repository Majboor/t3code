/**
 * Pure aggregation for a workspace's in-progress "pack draft" — the record
 * of labeled turns (`TurnLabeling.ts`) that accumulates as a person works
 * with Pack Mode on, before it's ever turned into a real, publishable pack.
 *
 * Deliberately dependency-free (no fs, no config) — file I/O for reading
 * and writing the draft to `.t3pack/draft.pack.json` in the workspace is a
 * thin wrapper around these functions, not mixed into them, so the
 * aggregation rules themselves stay unit-testable without a filesystem.
 *
 * @module PackDraft
 */
import type { TurnFindingCategory, TurnLabel, TurnOutcome } from "./TurnLabeling.ts";

/** Below this, a turn's label says "not worth keeping" and it's dropped rather than appended. */
export const WORTH_KEEPING_THRESHOLD = 0.5;

export function shouldKeepLabeledTurn(label: TurnLabel): boolean {
  return label.worthKeeping >= WORTH_KEEPING_THRESHOLD;
}

export interface PackDraftEntry {
  readonly turnId: string;
  readonly createdAt: string;
  readonly userPrompt: string;
  readonly assistantSummary: string;
  readonly changedFiles: ReadonlyArray<string>;
  readonly outcome: TurnOutcome;
  readonly outcomeConfidence: number;
  readonly findingCategory: TurnFindingCategory;
  readonly findingCategoryConfidence: number;
  readonly worthKeeping: number;
}

export interface PackDraft {
  readonly packDraftId: string;
  readonly projectId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly entries: ReadonlyArray<PackDraftEntry>;
}

export function createEmptyPackDraft(input: {
  readonly packDraftId: string;
  readonly projectId: string;
  readonly now: string;
}): PackDraft {
  return {
    packDraftId: input.packDraftId,
    projectId: input.projectId,
    createdAt: input.now,
    updatedAt: input.now,
    entries: [],
  };
}

/**
 * Appends one turn's worth of labeled content — replacing any existing
 * entry for the same `turnId` rather than duplicating it, so a re-labeled or
 * re-run turn doesn't pile up twice. Callers filter with
 * `shouldKeepLabeledTurn` themselves before calling this; it does not
 * re-check worthiness.
 */
export function appendPackDraftEntry(
  draft: PackDraft,
  entry: PackDraftEntry,
  now: string,
): PackDraft {
  const withoutExisting = draft.entries.filter((existing) => existing.turnId !== entry.turnId);
  return {
    ...draft,
    updatedAt: now,
    entries: [...withoutExisting, entry],
  };
}

export interface PackDraftSummary {
  readonly totalEntries: number;
  readonly succeeded: number;
  readonly partial: number;
  readonly failed: number;
  readonly byFindingCategory: Readonly<Record<TurnFindingCategory, number>>;
  readonly uniqueChangedFiles: ReadonlyArray<string>;
}

/** A quick "what's in this draft" rollup — what a publish UI would show before generating the real pack. */
export function summarizePackDraft(draft: PackDraft): PackDraftSummary {
  const byFindingCategory: Record<TurnFindingCategory, number> = {
    fix: 0,
    gotcha: 0,
    config: 0,
    error_resolution: 0,
    none: 0,
  };
  let succeeded = 0;
  let partial = 0;
  let failed = 0;
  const changedFiles = new Set<string>();

  for (const entry of draft.entries) {
    byFindingCategory[entry.findingCategory] += 1;
    if (entry.outcome === "succeeded") succeeded += 1;
    else if (entry.outcome === "partial") partial += 1;
    else failed += 1;
    for (const file of entry.changedFiles) changedFiles.add(file);
  }

  return {
    totalEntries: draft.entries.length,
    succeeded,
    partial,
    failed,
    byFindingCategory,
    uniqueChangedFiles: [...changedFiles].sort(),
  };
}
