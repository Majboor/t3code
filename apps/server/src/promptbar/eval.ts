/**
 * Smart Promptbar retrieval eval harness.
 *
 * The intent classifier is already measured elsewhere (~93.3% accuracy,
 * external to this repo). Retrieval quality -- whether `PromptbarClient`
 * actually surfaces the right pack once intent says "this is an ACTION" --
 * was not measured anywhere. This module computes the five metrics the spec
 * requires:
 *
 *   - Recall@1 / @3 / @5 -- @5 is the hard ceiling on the system, since
 *     `PromptbarResolution.candidates` never has more than 5 entries.
 *   - MRR (Mean Reciprocal Rank) -- ranking quality, not just hit/miss.
 *   - False-attach rate -- the classifier said "attach" (skip the user,
 *     act directly) and the top candidate was wrong. This is the metric
 *     that breaks trust, so it's computed over ALL cases, not just the
 *     ones with a correct pack -- attaching to anything when the right
 *     answer is "no pack at all" counts against it too.
 *   - Abstention rate -- how often the system produced nothing (zone
 *     "silent" or zero candidates), split into precision (of the cases
 *     that abstained, how many actually had no correct pack) and recall
 *     (of the cases that truly had no correct pack, how many were
 *     actually abstained on) so "abstains a lot" and "abstains correctly"
 *     don't get conflated into one number.
 *   - Acceptance rate -- read from the telemetry table the composer-UI
 *     agent is adding; see `readTelemetryEventCounts` for the isolated,
 *     defensive query and its schema assumption.
 *
 * Pure math lives in the top half of this file (fully unit-tested,
 * independent of any live infra or the other two agents' work landing).
 * The effectful runner (`runPromptbarEval`) that actually calls
 * `PromptbarClient.resolve` for every test-set row lives at the bottom.
 *
 * @module PromptbarEval
 */
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { Effect } from "effect";

import {
  PromptbarTestSetRepository,
  type PromptbarTestSetRow,
} from "./Services/PromptbarTestSet.ts";
import { PromptbarClient, type PromptbarZone } from "./Services/PromptbarClient.ts";

// ---------------------------------------------------------------------------
// Pure types
// ---------------------------------------------------------------------------

/** The part of a retrieval outcome the metrics below actually need. */
export interface RetrievalOutcome {
  readonly zone: PromptbarZone;
  /** Highest `retrievalScore` first, same ordering contract as `PromptbarResolution.candidates`. */
  readonly candidates: ReadonlyArray<{ readonly packId: string }>;
}

/** One test-set row paired with what retrieval actually returned for it (or `null` on error). */
export interface PromptbarEvalCase {
  readonly phrasing: string;
  readonly correctPackId: string | null;
  readonly source: string;
  readonly outcome: RetrievalOutcome | null;
  /** Set when `resolve` itself failed (e.g. the stub's "not implemented yet"). */
  readonly error: string | null;
}

export interface TelemetryEventCounts {
  readonly accept: number;
  readonly dismiss: number;
  readonly abstain: number;
}

export interface PromptbarEvalReport {
  readonly totalCases: number;
  /** Cases that actually got a resolution back (`totalCases - failedCases`). */
  readonly resolvedCases: number;
  /** Of the resolved cases, how many had a real correct pack (used for recall/MRR). */
  readonly rankedCases: number;
  readonly recallAt1: number;
  readonly recallAt3: number;
  readonly recallAt5: number;
  readonly mrr: number;
  readonly falseAttachRate: number;
  readonly abstentionRate: number;
  readonly abstentionPrecision: number | null;
  readonly abstentionRecall: number | null;
  readonly acceptanceRate: number | null;
  /** `resolve` calls that errored outright (not a resolution, an exception -- e.g. the unimplemented stub). */
  readonly failedCases: number;
}

// ---------------------------------------------------------------------------
// Pure math -- Recall@K / MRR
// ---------------------------------------------------------------------------

/**
 * 1-based rank of `correctPackId` within `candidates`, or `null` if it isn't
 * there (or there is no correct pack to rank in the first place).
 */
export const rankOfCorrectCandidate = (
  candidates: ReadonlyArray<{ readonly packId: string }>,
  correctPackId: string | null,
): number | null => {
  if (correctPackId === null) return null;
  const index = candidates.findIndex((candidate) => candidate.packId === correctPackId);
  return index === -1 ? null : index + 1;
};

/** Fraction of `ranks` that landed at or above `k`. Ranks are 1-based; `null` is a miss. */
export const recallAtK = (ranks: ReadonlyArray<number | null>, k: number): number => {
  if (ranks.length === 0) return 0;
  const hits = ranks.filter((rank) => rank !== null && rank <= k).length;
  return hits / ranks.length;
};

/** Mean of 1/rank across `ranks`, treating a miss (`null`) as a reciprocal rank of 0. */
export const meanReciprocalRank = (ranks: ReadonlyArray<number | null>): number => {
  if (ranks.length === 0) return 0;
  const sum = ranks.reduce((total: number, rank) => total + (rank === null ? 0 : 1 / rank), 0);
  return sum / ranks.length;
};

// ---------------------------------------------------------------------------
// Pure math -- false-attach rate
// ---------------------------------------------------------------------------

export interface FalseAttachCase {
  readonly zone: PromptbarZone;
  readonly topPackId: string | null;
  readonly correctPackId: string | null;
}

/**
 * True when the system was confident enough to skip the user ("attach") but
 * got it wrong -- including attaching to *something* when the correct answer
 * was no pack at all (`correctPackId: null`), which is the worst version of
 * this failure since there the confident answer is never right.
 */
export const isFalseAttach = (testCase: FalseAttachCase): boolean => {
  if (testCase.zone !== "attach") return false;
  if (testCase.topPackId === null) return true;
  return testCase.topPackId !== testCase.correctPackId;
};

export const falseAttachRate = (cases: ReadonlyArray<FalseAttachCase>): number => {
  if (cases.length === 0) return 0;
  return cases.filter(isFalseAttach).length / cases.length;
};

// ---------------------------------------------------------------------------
// Pure math -- abstention rate / precision / recall
// ---------------------------------------------------------------------------

export interface AbstentionCase {
  readonly zone: PromptbarZone;
  readonly candidateCount: number;
  readonly correctPackId: string | null;
}

export const isAbstention = (testCase: AbstentionCase): boolean =>
  testCase.zone === "silent" || testCase.candidateCount === 0;

/** Fraction of all cases where the system abstained, right or wrong. */
export const abstentionRate = (cases: ReadonlyArray<AbstentionCase>): number => {
  if (cases.length === 0) return 0;
  return cases.filter(isAbstention).length / cases.length;
};

/**
 * Of the cases that abstained, what fraction genuinely had no correct pack
 * (i.e. abstaining was the right call). `null` when nothing abstained --
 * there's no precision to report.
 */
export const abstentionPrecision = (cases: ReadonlyArray<AbstentionCase>): number | null => {
  const abstained = cases.filter(isAbstention);
  if (abstained.length === 0) return null;
  return abstained.filter((testCase) => testCase.correctPackId === null).length / abstained.length;
};

/**
 * Of the cases that genuinely had no correct pack, what fraction were
 * actually abstained on. `null` when no case in the set should have
 * abstained -- there's no recall to report.
 */
export const abstentionRecall = (cases: ReadonlyArray<AbstentionCase>): number | null => {
  const shouldAbstain = cases.filter((testCase) => testCase.correctPackId === null);
  if (shouldAbstain.length === 0) return null;
  return shouldAbstain.filter(isAbstention).length / shouldAbstain.length;
};

// ---------------------------------------------------------------------------
// Pure math -- acceptance rate (from telemetry counts)
// ---------------------------------------------------------------------------

/**
 * Of the suggestions a user actually made a decision on (accept or dismiss),
 * what fraction were accepted. Abstain events are excluded from the
 * denominator -- there was nothing on screen to accept or dismiss. `null`
 * when there's no decided event to compute a rate from.
 */
export const acceptanceRate = (counts: TelemetryEventCounts): number | null => {
  const decided = counts.accept + counts.dismiss;
  return decided === 0 ? null : counts.accept / decided;
};

// ---------------------------------------------------------------------------
// Report assembly (pure -- takes already-resolved cases, produces the report)
// ---------------------------------------------------------------------------

export const computeReport = (
  cases: ReadonlyArray<PromptbarEvalCase>,
  telemetryCounts: TelemetryEventCounts | null,
): PromptbarEvalReport => {
  const resolved = cases.filter(
    (testCase): testCase is PromptbarEvalCase & { readonly outcome: RetrievalOutcome } =>
      testCase.outcome !== null,
  );
  const failedCases = cases.length - resolved.length;

  const ranked = resolved.filter((testCase) => testCase.correctPackId !== null);
  const ranks = ranked.map((testCase) =>
    rankOfCorrectCandidate(testCase.outcome.candidates, testCase.correctPackId),
  );

  const falseAttachCases: ReadonlyArray<FalseAttachCase> = resolved.map((testCase) => ({
    zone: testCase.outcome.zone,
    topPackId: testCase.outcome.candidates[0]?.packId ?? null,
    correctPackId: testCase.correctPackId,
  }));

  const abstentionCases: ReadonlyArray<AbstentionCase> = resolved.map((testCase) => ({
    zone: testCase.outcome.zone,
    candidateCount: testCase.outcome.candidates.length,
    correctPackId: testCase.correctPackId,
  }));

  return {
    totalCases: cases.length,
    resolvedCases: resolved.length,
    rankedCases: ranked.length,
    recallAt1: recallAtK(ranks, 1),
    recallAt3: recallAtK(ranks, 3),
    recallAt5: recallAtK(ranks, 5),
    mrr: meanReciprocalRank(ranks),
    falseAttachRate: falseAttachRate(falseAttachCases),
    abstentionRate: abstentionRate(abstentionCases),
    abstentionPrecision: abstentionPrecision(abstentionCases),
    abstentionRecall: abstentionRecall(abstentionCases),
    acceptanceRate: telemetryCounts ? acceptanceRate(telemetryCounts) : null,
    failedCases,
  };
};

// ---------------------------------------------------------------------------
// Telemetry read (isolated + defensive -- see module doc)
// ---------------------------------------------------------------------------

/**
 * ASSUMPTION, flagged: the composer-UI-wiring agent's `POST
 * /api/promptbar/telemetry` endpoint doesn't exist in this worktree yet.
 * This reads a table named `promptbar_telemetry` with columns
 * `(id, event text, pack_id text nullable, query text, created_at)`, where
 * `event` is one of `'accept' | 'dismiss' | 'abstain'`. That's a reasonable
 * guess at their shape, not a confirmed contract -- once all three of us
 * land, reconcile this against their actual migration. Kept to this one
 * function (just the SQL string + the row-shape cast below) on purpose, so a
 * column/table rename on their side is a one-line fix here, not a rewrite.
 *
 * Degrades to `null` (rather than failing the whole eval run) when the table
 * doesn't exist yet or the query otherwise fails, since "telemetry isn't
 * landed yet" is an expected, non-fatal state for this harness to run in.
 */
export const readTelemetryEventCounts: Effect.Effect<
  TelemetryEventCounts | null,
  never,
  SqlClient.SqlClient
> = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql`
      SELECT event, COUNT(*) AS n FROM promptbar_telemetry GROUP BY event
    `;
  const counts = { accept: 0, dismiss: 0, abstain: 0 };
  for (const row of rows as ReadonlyArray<{
    readonly event: string;
    readonly n: number | string;
  }>) {
    const n = Number(row.n);
    if (row.event === "accept") counts.accept = n;
    else if (row.event === "dismiss") counts.dismiss = n;
    else if (row.event === "abstain") counts.abstain = n;
  }
  return counts;
}).pipe(Effect.catch(() => Effect.succeed(null)));

// ---------------------------------------------------------------------------
// Effectful runner -- calls the real PromptbarClient for every test-set row
// ---------------------------------------------------------------------------

/**
 * Resolves every row of the test set against the live `PromptbarClient`
 * layer in scope. A `resolve` failure (e.g. the retrieval stub's "not
 * implemented yet") is captured per-row rather than aborting the whole run,
 * so a harness run against an unfinished backend still produces a report
 * (with every case counted under `failedCases`) instead of just crashing.
 */
export const resolveTestSetCases = (
  rows: ReadonlyArray<PromptbarTestSetRow>,
): Effect.Effect<ReadonlyArray<PromptbarEvalCase>, never, PromptbarClient> =>
  Effect.gen(function* () {
    const client = yield* PromptbarClient;
    return yield* Effect.forEach(rows, (row) =>
      client.resolve({ text: row.phrasing, isFirstMessageInSession: true, k: 5 }).pipe(
        Effect.map(
          (resolution): PromptbarEvalCase => ({
            phrasing: row.phrasing,
            correctPackId: row.correctPackId,
            source: row.source,
            outcome: { zone: resolution.zone, candidates: resolution.candidates },
            error: null,
          }),
        ),
        Effect.catch((error) =>
          Effect.succeed<PromptbarEvalCase>({
            phrasing: row.phrasing,
            correctPackId: row.correctPackId,
            source: row.source,
            outcome: null,
            error: String((error as { readonly message?: string })?.message ?? error),
          }),
        ),
      ),
    );
  });

/**
 * End-to-end: reads the test set, resolves every row against the real
 * `PromptbarClient`, reads telemetry acceptance counts, and produces the
 * final report. This is the one function `scripts/promptbar-eval.ts` calls.
 */
export const runPromptbarEval: Effect.Effect<
  PromptbarEvalReport,
  never,
  PromptbarTestSetRepository | PromptbarClient | SqlClient.SqlClient
> = Effect.gen(function* () {
  const testSet = yield* PromptbarTestSetRepository;
  const rows = yield* testSet.listAll().pipe(Effect.catch(() => Effect.succeed([])));
  const cases = yield* resolveTestSetCases(rows);
  const telemetryCounts = yield* readTelemetryEventCounts;
  return computeReport(cases, telemetryCounts);
});
