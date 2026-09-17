import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

/**
 * The BM25 half of Promptbar's hybrid pack retrieval (see
 * apps/server/src/promptbar/Services/PromptbarClient.ts). `description` and
 * `phrasing` are indexed text; `pack_id`/`name` are stored but UNINDEXED so
 * they come back with a hit without ever being matched against themselves.
 *
 * Rows are populated (and fully replaced on every pack-set change) by
 * `apps/server/src/promptbar/Layers/PromptbarClient.ts` at startup, not by
 * this migration — this only owns the table shape.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE VIRTUAL TABLE pack_fts USING fts5(
      pack_id UNINDEXED,
      name UNINDEXED,
      description,
      phrasing
    )
  `;
});
