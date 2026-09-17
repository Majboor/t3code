import { assert, it } from "@effect/vitest";
import { DateTime, Effect, Layer } from "effect";

import {
  PromptbarClient,
  PromptbarError,
  type PromptbarClientShape,
  type PromptbarZone,
} from "./Services/PromptbarClient.ts";
import {
  abstentionPrecision,
  abstentionRate,
  abstentionRecall,
  acceptanceRate,
  computeReport,
  falseAttachRate,
  isAbstention,
  isFalseAttach,
  meanReciprocalRank,
  rankOfCorrectCandidate,
  recallAtK,
  resolveTestSetCases,
  type PromptbarEvalCase,
} from "./eval.ts";
import type { PromptbarTestSetRow } from "./Services/PromptbarTestSet.ts";

// ---------------------------------------------------------------------------
// rankOfCorrectCandidate
// ---------------------------------------------------------------------------

it("rankOfCorrectCandidate: ranks are 1-based and follow candidate order", () => {
  const candidates = [{ packId: "a" }, { packId: "b" }, { packId: "c" }];
  assert.equal(rankOfCorrectCandidate(candidates, "a"), 1);
  assert.equal(rankOfCorrectCandidate(candidates, "b"), 2);
  assert.equal(rankOfCorrectCandidate(candidates, "c"), 3);
});

it("rankOfCorrectCandidate: returns null when the correct pack is not present", () => {
  assert.isNull(rankOfCorrectCandidate([{ packId: "a" }, { packId: "b" }], "z"));
  assert.isNull(rankOfCorrectCandidate([], "a"));
});

it("rankOfCorrectCandidate: returns null when there is no correct pack to rank (abstention case)", () => {
  assert.isNull(rankOfCorrectCandidate([{ packId: "a" }], null));
});

// ---------------------------------------------------------------------------
// recallAtK
// ---------------------------------------------------------------------------

it("recallAtK: counts a hit only when the rank is at or above k", () => {
  const ranks = [1, 2, 3, null];
  assert.equal(recallAtK(ranks, 1), 0.25); // only rank 1 hits
  assert.equal(recallAtK(ranks, 3), 0.75); // ranks 1,2,3 hit; null misses
  assert.equal(recallAtK(ranks, 5), 0.75); // still 3/4, no rank exceeds 3
});

it("recallAtK: a perfect set scores 1 at every k that covers it", () => {
  assert.equal(recallAtK([1, 1, 1], 1), 1);
  assert.equal(recallAtK([5, 5], 5), 1);
});

it("recallAtK: an empty ranked set is defined as 0, not NaN", () => {
  assert.equal(recallAtK([], 1), 0);
  assert.equal(recallAtK([], 5), 0);
});

it("recallAtK: all misses scores 0", () => {
  assert.equal(recallAtK([null, null], 3), 0);
});

// ---------------------------------------------------------------------------
// meanReciprocalRank
// ---------------------------------------------------------------------------

it("meanReciprocalRank: averages 1/rank, treating a miss as 0", () => {
  // 1/1, 1/2, 0 -> (1 + 0.5 + 0) / 3
  assert.approximately(meanReciprocalRank([1, 2, null]), 0.5, 1e-9);
});

it("meanReciprocalRank: is 1 when every case is a perfect top-1 hit", () => {
  assert.equal(meanReciprocalRank([1, 1, 1]), 1);
});

it("meanReciprocalRank: is 0 when everything misses", () => {
  assert.equal(meanReciprocalRank([null, null]), 0);
});

it("meanReciprocalRank: an empty set is defined as 0, not NaN", () => {
  assert.equal(meanReciprocalRank([]), 0);
});

// ---------------------------------------------------------------------------
// isFalseAttach / falseAttachRate
// ---------------------------------------------------------------------------

const attach = (topPackId: string | null, correctPackId: string | null) => ({
  zone: "attach" as PromptbarZone,
  topPackId,
  correctPackId,
});
const suggest = (topPackId: string | null, correctPackId: string | null) => ({
  zone: "suggest" as PromptbarZone,
  topPackId,
  correctPackId,
});

it("isFalseAttach: false when the zone never attached", () => {
  assert.isFalse(isFalseAttach(suggest("a", "b")));
  assert.isFalse(isFalseAttach({ zone: "silent", topPackId: null, correctPackId: "a" }));
});

it("isFalseAttach: false when attach picked the right pack", () => {
  assert.isFalse(isFalseAttach(attach("a", "a")));
});

it("isFalseAttach: true when attach picked the wrong pack", () => {
  assert.isTrue(isFalseAttach(attach("a", "b")));
});

it("isFalseAttach: true when attach fired with no correct pack at all", () => {
  assert.isTrue(isFalseAttach(attach("a", null)));
});

it("isFalseAttach: true when attach fired with no candidates (contradiction, treated as false)", () => {
  assert.isTrue(isFalseAttach(attach(null, "a")));
  assert.isTrue(isFalseAttach(attach(null, null)));
});

it("falseAttachRate: fraction of all cases that were confidently wrong", () => {
  const cases = [attach("a", "a"), attach("a", "b"), suggest("a", "b"), attach(null, "b")];
  // false attaches: attach("a","b") and attach(null,"b") -> 2 of 4
  assert.equal(falseAttachRate(cases), 0.5);
});

it("falseAttachRate: 0 when nothing attached at all", () => {
  assert.equal(falseAttachRate([suggest("a", "b")]), 0);
});

it("falseAttachRate: an empty set is defined as 0, not NaN", () => {
  assert.equal(falseAttachRate([]), 0);
});

// ---------------------------------------------------------------------------
// isAbstention / abstentionRate / abstentionPrecision / abstentionRecall
// ---------------------------------------------------------------------------

const silent = (correctPackId: string | null) => ({
  zone: "silent" as PromptbarZone,
  candidateCount: 0,
  correctPackId,
});
const withCandidates = (zone: PromptbarZone, candidateCount: number, correctPackId: string | null) => ({
  zone,
  candidateCount,
  correctPackId,
});

it("isAbstention: true when zone is silent, even if candidates were somehow present", () => {
  assert.isTrue(isAbstention(withCandidates("silent", 2, "a")));
});

it("isAbstention: true when there are zero candidates, even if zone isn't silent", () => {
  assert.isTrue(isAbstention(withCandidates("suggest", 0, "a")));
});

it("isAbstention: false when there's a non-silent zone with candidates", () => {
  assert.isFalse(isAbstention(withCandidates("attach", 1, "a")));
  assert.isFalse(isAbstention(withCandidates("suggest", 3, "a")));
});

it("abstentionRate: fraction of all cases that abstained", () => {
  const cases = [silent(null), silent("a"), withCandidates("attach", 1, "a"), withCandidates("suggest", 2, "b")];
  assert.equal(abstentionRate(cases), 0.5);
});

it("abstentionRate: an empty set is defined as 0, not NaN", () => {
  assert.equal(abstentionRate([]), 0);
});

it("abstentionPrecision: fraction of abstentions that were actually correct (no pack existed)", () => {
  // Two abstentions: one where correctPackId is null (right call), one where it wasn't (wrong call).
  const cases = [silent(null), silent("a"), withCandidates("attach", 1, "a")];
  assert.equal(abstentionPrecision(cases), 0.5);
});

it("abstentionPrecision: null when nothing abstained -- no precision to report", () => {
  assert.isNull(abstentionPrecision([withCandidates("attach", 1, "a")]));
});

it("abstentionPrecision: 1 when every abstention was justified", () => {
  assert.equal(abstentionPrecision([silent(null), silent(null)]), 1);
});

it("abstentionRecall: fraction of true no-pack cases that were actually abstained on", () => {
  // Two cases with no correct pack: one abstained (right), one didn't (a false attach elsewhere).
  const cases = [silent(null), withCandidates("attach", 1, null), withCandidates("attach", 1, "a")];
  assert.equal(abstentionRecall(cases), 0.5);
});

it("abstentionRecall: null when no case in the set should have abstained", () => {
  assert.isNull(abstentionRecall([withCandidates("attach", 1, "a"), withCandidates("suggest", 1, "b")]));
});

it("abstentionRecall: 1 when every true no-pack case was caught", () => {
  assert.equal(abstentionRecall([silent(null), silent(null)]), 1);
});

// ---------------------------------------------------------------------------
// acceptanceRate
// ---------------------------------------------------------------------------

it("acceptanceRate: accept over accept+dismiss, ignoring abstain events", () => {
  assert.equal(acceptanceRate({ accept: 3, dismiss: 1, abstain: 100 }), 0.75);
});

it("acceptanceRate: null when nothing was ever decided on", () => {
  assert.isNull(acceptanceRate({ accept: 0, dismiss: 0, abstain: 5 }));
});

it("acceptanceRate: 0 when every suggestion was dismissed", () => {
  assert.equal(acceptanceRate({ accept: 0, dismiss: 4, abstain: 0 }), 0);
});

it("acceptanceRate: 1 when every suggestion was accepted", () => {
  assert.equal(acceptanceRate({ accept: 4, dismiss: 0, abstain: 0 }), 1);
});

// ---------------------------------------------------------------------------
// computeReport -- integration of the pure math above over a realistic mixed set
// ---------------------------------------------------------------------------

const evalCase = (
  correctPackId: string | null,
  outcome: PromptbarEvalCase["outcome"],
  error: string | null = null,
): PromptbarEvalCase => ({
  phrasing: "irrelevant for this test",
  correctPackId,
  source: "manual",
  outcome,
  error,
});

it("computeReport: end to end over a hand-worked mixed set of hits, misses, false attaches, abstentions, and failures", () => {
  const cases: ReadonlyArray<PromptbarEvalCase> = [
    // Perfect top-1 hit, attach, correct -- ideal case.
    evalCase("a", { zone: "attach", candidates: [{ packId: "a" }] }),
    // Correct pack present but ranked 2nd, zone suggest (not confident enough to attach).
    evalCase("b", { zone: "suggest", candidates: [{ packId: "x" }, { packId: "b" }] }),
    // Miss entirely -- correct pack never retrieved.
    evalCase("c", { zone: "suggest", candidates: [{ packId: "x" }, { packId: "y" }] }),
    // False attach: confident, wrong.
    evalCase("d", { zone: "attach", candidates: [{ packId: "z" }] }),
    // Genuine abstention: no correct pack, system correctly stayed silent.
    evalCase(null, { zone: "silent", candidates: [] }),
    // Wrong abstention: no correct pack, but the failure was that it attached anyway (false attach again).
    evalCase(null, { zone: "attach", candidates: [{ packId: "q" }] }),
    // Resolve itself failed (e.g. the retrieval stub) -- must not silently vanish from totals.
    evalCase("e", null, "PromptbarError: not implemented yet"),
  ];

  const report = computeReport(cases, { accept: 6, dismiss: 2, abstain: 1 });

  assert.equal(report.totalCases, 7);
  assert.equal(report.failedCases, 1);
  assert.equal(report.resolvedCases, 6);
  // Ranked cases: the 4 with a non-null correctPackId among the resolved ones (a, b, c, d) -- "e" failed to resolve.
  assert.equal(report.rankedCases, 4);

  // Ranks among ranked cases: a->1, b->2, c->null (miss), d->null (wrong top, but "d" not even present as topPackId... rank is about correctPackId presence)
  // d's candidates are [{packId:'z'}], correctPackId 'd' is absent -> rank null (miss).
  assert.equal(report.recallAt1, 0.25); // only "a" at rank 1, of 4 ranked
  assert.equal(report.recallAt3, 0.5); // "a" (1) and "b" (2) are <=3, of 4 ranked
  assert.equal(report.recallAt5, 0.5); // no additional hits appear beyond rank 3 with only 2 candidates max
  assert.approximately(report.mrr, (1 + 0.5 + 0 + 0) / 4, 1e-9);

  // False attaches among the 6 resolved cases: "d" (attach, wrong) and the null-correct attach case -> 2 of 6.
  assert.approximately(report.falseAttachRate, 2 / 6, 1e-9);

  // Abstentions among the 6 resolved cases: only the "silent" one -> 1 of 6.
  assert.approximately(report.abstentionRate, 1 / 6, 1e-9);
  assert.equal(report.abstentionPrecision, 1); // the one abstention was justified (correctPackId null)
  // Two cases truly had no correct pack (the silent one and the wrongly-attached one); only 1 was abstained on.
  assert.equal(report.abstentionRecall, 0.5);

  assert.equal(report.acceptanceRate, 0.75);
});

it("computeReport: acceptanceRate is null when no telemetry counts are supplied", () => {
  const report = computeReport([evalCase("a", { zone: "attach", candidates: [{ packId: "a" }] })], null);
  assert.isNull(report.acceptanceRate);
});

it("computeReport: an empty test set produces a report of all zeroes/nulls, not a crash", () => {
  const report = computeReport([], null);
  assert.equal(report.totalCases, 0);
  assert.equal(report.resolvedCases, 0);
  assert.equal(report.rankedCases, 0);
  assert.equal(report.recallAt1, 0);
  assert.equal(report.recallAt3, 0);
  assert.equal(report.recallAt5, 0);
  assert.equal(report.mrr, 0);
  assert.equal(report.falseAttachRate, 0);
  assert.equal(report.abstentionRate, 0);
  assert.isNull(report.abstentionPrecision);
  assert.isNull(report.abstentionRecall);
  assert.isNull(report.acceptanceRate);
  assert.equal(report.failedCases, 0);
});

// ---------------------------------------------------------------------------
// resolveTestSetCases -- effectful wiring against a fake PromptbarClient
// ---------------------------------------------------------------------------

const testSetRow = (phrasing: string, correctPackId: string | null): PromptbarTestSetRow => ({
  id: `id:${phrasing}`,
  phrasing,
  correctPackId,
  source: "manual",
  createdAt: DateTime.makeUnsafe(new Date("2026-09-01T00:00:00.000Z")),
});

it.effect("resolveTestSetCases: captures a resolve() failure per-row instead of aborting the run", () =>
  Effect.gen(function* () {
    const rows = [testSetRow("send an email please", "gmail_apps_script_mail")];
    const fakeClient: PromptbarClientShape = {
      resolve: () => Effect.fail(new PromptbarError({ message: "Promptbar hybrid retrieval is not implemented on this instance yet." })),
    };
    const results = yield* resolveTestSetCases(rows).pipe(
      Effect.provide(Layer.succeed(PromptbarClient, fakeClient)),
    );
    assert.equal(results.length, 1);
    assert.isNull(results[0]?.outcome);
    assert.isNotNull(results[0]?.error);
  }),
);

it.effect("resolveTestSetCases: maps a successful resolution's zone and candidates straight through", () =>
  Effect.gen(function* () {
    const rows = [testSetRow("send an email please", "gmail_apps_script_mail")];
    const fakeClient: PromptbarClientShape = {
      resolve: () =>
        Effect.succeed({
          intent: "ACTION",
          confidence: 0.9,
          zone: "attach",
          candidates: [
            {
              packId: "gmail_apps_script_mail",
              name: "Send mail",
              description: "desc",
              retrievalScore: 0.95,
              params: [],
            },
          ],
          skipAgent: true,
          note: null,
        }),
    };
    const results = yield* resolveTestSetCases(rows).pipe(
      Effect.provide(Layer.succeed(PromptbarClient, fakeClient)),
    );
    assert.equal(results.length, 1);
    assert.isNull(results[0]?.error);
    assert.equal(results[0]?.outcome?.zone, "attach");
    assert.deepEqual(
      results[0]?.outcome?.candidates.map((c) => c.packId),
      ["gmail_apps_script_mail"],
    );
  }),
);
