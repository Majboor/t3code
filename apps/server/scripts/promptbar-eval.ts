#!/usr/bin/env node

/**
 * Runnable Smart Promptbar retrieval eval harness. Seeds the hand-written
 * test set (`../src/promptbar/testSetSeed.ts`), resolves every row against
 * the real `PromptbarClient` layer (the actual hybrid-retrieval
 * implementation if it's landed, or the "not implemented yet" stub if it
 * isn't -- either way this is a real run, not a mock), reads acceptance
 * counts from the telemetry table if it exists, and prints the report from
 * `../src/promptbar/eval.ts`.
 *
 * Usage:
 *   node scripts/promptbar-eval.ts                  # throwaway :memory: db, seeded, human-readable report
 *   node scripts/promptbar-eval.ts --json            # same, machine-readable
 *   node scripts/promptbar-eval.ts --db ./state.sqlite --no-seed   # score against an existing, already-seeded db
 *
 * Follows this package's `../scripts/cli.ts` / repo-root
 * `../../../scripts/resolve-previous-release-tag.ts` convention: a
 * standalone `Command.make` + `NodeRuntime.runMain` script, not wired into
 * the big `src/cli.ts` `t3` CLI, since this is a maintenance/eval tool, not
 * a shipped end-user command.
 */
import { createHash } from "node:crypto";

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { DateTime, Effect, Layer } from "effect";
import { Command, Flag } from "effect/unstable/cli";

import { makeSqlitePersistenceLive, SqlitePersistenceMemory } from "../src/persistence/Layers/Sqlite.ts";
import { PromptbarClientLive } from "../src/promptbar/Layers/PromptbarClient.ts";
import { PromptbarTestSetRepositoryLive } from "../src/promptbar/Layers/PromptbarTestSet.ts";
import { PromptbarTestSetRepository } from "../src/promptbar/Services/PromptbarTestSet.ts";
import { PROMPTBAR_TEST_SET_SEED } from "../src/promptbar/testSetSeed.ts";
import { runPromptbarEval, type PromptbarEvalReport } from "../src/promptbar/eval.ts";

/**
 * Deterministic id per phrasing (rather than `randomUUID()`) so re-running
 * this script against a persistent `--db` upserts the same rows instead of
 * accumulating duplicates every run.
 */
const seedRowId = (phrasing: string): string =>
  `manual:${createHash("sha1").update(phrasing).digest("hex").slice(0, 16)}`;

const seedTestSet = Effect.fn("seedTestSet")(function* () {
  const repo = yield* PromptbarTestSetRepository;
  const now = yield* DateTime.now;
  const createdAt = DateTime.toUtc(now);
  for (const row of PROMPTBAR_TEST_SET_SEED) {
    yield* repo.insert({
      id: seedRowId(row.phrasing),
      phrasing: row.phrasing,
      correctPackId: row.correctPackId,
      source: "manual",
      createdAt,
    });
  }
  yield* Effect.log(`[promptbar-eval] Seeded ${PROMPTBAR_TEST_SET_SEED.length} manual test-set rows.`);
});

const formatPercent = (value: number | null): string => (value === null ? "n/a" : `${(value * 100).toFixed(1)}%`);

const printHumanReport = (report: PromptbarEvalReport): void => {
  const lines = [
    "",
    "Smart Promptbar retrieval eval",
    "===============================",
    `Test-set rows:         ${report.totalCases}`,
    `Resolved (no error):   ${report.resolvedCases}`,
    `Failed to resolve:     ${report.failedCases}`,
    `Ranked (has a pack):   ${report.rankedCases}`,
    "",
    `Recall@1:              ${formatPercent(report.recallAt1)}`,
    `Recall@3:              ${formatPercent(report.recallAt3)}`,
    `Recall@5:              ${formatPercent(report.recallAt5)}`,
    `MRR:                   ${report.mrr.toFixed(3)}`,
    "",
    `False-attach rate:     ${formatPercent(report.falseAttachRate)}`,
    `Abstention rate:       ${formatPercent(report.abstentionRate)}`,
    `  precision:           ${formatPercent(report.abstentionPrecision)}`,
    `  recall:              ${formatPercent(report.abstentionRecall)}`,
    `Acceptance rate:       ${formatPercent(report.acceptanceRate)}${report.acceptanceRate === null ? " (no promptbar_telemetry data)" : ""}`,
    "",
  ];
  process.stdout.write(`${lines.join("\n")}\n`);
};

const command = Command.make(
  "promptbar-eval",
  {
    db: Flag.string("db").pipe(
      Flag.withDefault(":memory:"),
      Flag.withDescription("SQLite db path, or ':memory:' for a throwaway seeded run (default)."),
    ),
    seed: Flag.boolean("seed").pipe(
      Flag.withDefault(true),
      Flag.withDescription("Seed the hand-written manual test set first (upserts, safe to repeat)."),
    ),
    json: Flag.boolean("json").pipe(
      Flag.withDefault(false),
      Flag.withDescription("Print the report as JSON instead of a human-readable summary."),
    ),
  },
  ({ db, seed, json }) =>
    Effect.gen(function* () {
      if (seed) yield* seedTestSet();
      const report = yield* runPromptbarEval;
      if (json) {
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      } else {
        printHumanReport(report);
      }
    }).pipe(
      Effect.provide(
        (() => {
          // Same Layer *value* reused below so Effect's layer memoization
          // shares one SqlClient/connection between the test-set repo and
          // PromptbarClient, rather than two independent `:memory:` DBs that
          // can never see each other's tables.
          const sql = db === ":memory:" ? SqlitePersistenceMemory : makeSqlitePersistenceLive(db);
          return Layer.mergeAll(
            PromptbarTestSetRepositoryLive.pipe(Layer.provideMerge(sql)),
            PromptbarClientLive.pipe(Layer.provideMerge(sql)),
          );
        })(),
      ),
    ),
).pipe(
  Command.withDescription(
    "Score PromptbarClient retrieval quality (Recall@K, MRR, false-attach rate, abstention rate, acceptance rate) against a held-out test set.",
  ),
);

if (import.meta.main) {
  Command.run(command, { version: "0.0.0" }).pipe(
    Effect.scoped,
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
