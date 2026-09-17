import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * The Smart Promptbar retrieval eval harness's test set: (phrasing ->
 * correct_pack_id) pairs used to score Recall@K/MRR/false-attach/abstention
 * for `PromptbarClient.resolve`, independent of the retrieval index itself.
 *
 * Deliberately NOT populated from `packs/*\/promptbar.json`'s own indexed
 * phrasings -- scoring retrieval against the exact strings it was built from
 * is training on the test set. Rows come from two places, distinguished by
 * `source`: `manual` (hand-written rephrasings, genuinely different wording
 * from what's indexed) and `sampled_from_usage` (pulled from real composer
 * input later, once that pipeline exists).
 *
 * `correct_pack_id` is nullable on purpose: a null row is a case that should
 * resolve to no pack at all (the classifier abstaining is the correct
 * outcome), which is what exercises the abstention-rate metric.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS promptbar_test_set (
      id TEXT PRIMARY KEY,
      phrasing TEXT NOT NULL,
      correct_pack_id TEXT,
      source TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS promptbar_test_set_source_idx
      ON promptbar_test_set (source)
  `;
});
