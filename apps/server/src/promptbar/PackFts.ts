/**
 * The `pack_fts` (SQLite FTS5) side of Promptbar's hybrid retrieval: builds
 * the rows for a pack set (pure, unit-tested in `PackFts.test.ts`) and the
 * two SQL operations around them — full rebuild, and a BM25 query — which do
 * need a live `SqlClient` and so are only covered by the in-memory-SQLite
 * integration test in `PromptbarClient.test.ts`.
 *
 * @module PackFts
 */
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { toPersistenceSqlError } from "../persistence/Errors.ts";
import { buildFtsMatchQuery, type RetrievalHit } from "./retrieval.ts";
import type { PromptbarPackDefinition } from "./PackSource.ts";

export interface PackFtsRow {
  readonly packId: string;
  readonly name: string;
  readonly description: string;
  readonly phrasing: string;
}

/**
 * One row per phrasing plus one for the pack name, per the spec — the name
 * row is what lets a bare "ssh-deploy" style query still match by BM25 even
 * though `name` itself is an UNINDEXED column.
 */
export function buildFtsRows(pack: PromptbarPackDefinition): ReadonlyArray<PackFtsRow> {
  const base = { packId: pack.id, name: pack.name, description: pack.description };
  return [{ ...base, phrasing: pack.name }, ...pack.phrasings.map((phrasing) => ({ ...base, phrasing }))];
}

/**
 * Full replace, not an incremental diff — startup-only (or an explicit
 * re-index call after a pack changes), never file-watched, so there is no
 * "which rows changed" state to maintain and a full rebuild is cheap at
 * pack-library sizes the spec says to design for (a handful of packs today,
 * "not a concern yet" beyond ~1,000).
 */
export const rebuildFtsIndex = Effect.fn("rebuildFtsIndex")(function* (
  packs: ReadonlyArray<PromptbarPackDefinition>,
) {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`DELETE FROM pack_fts`.pipe(Effect.mapError(toPersistenceSqlError("PackFts.rebuildFtsIndex:clear")));

  for (const pack of packs) {
    for (const row of buildFtsRows(pack)) {
      yield* sql`
        INSERT INTO pack_fts (pack_id, name, description, phrasing)
        VALUES (${row.packId}, ${row.name}, ${row.description}, ${row.phrasing})
      `.pipe(Effect.mapError(toPersistenceSqlError("PackFts.rebuildFtsIndex:insert")));
    }
  }
});

export interface FtsHit extends RetrievalHit {
  readonly name: string;
  readonly description: string;
}

/**
 * Top `limit` phrasing-level BM25 hits, best first. `bm25()` is SQLite's
 * "lower (more negative) is better" relevance score, so it sorts ascending —
 * the opposite of the RRF/dense-cosine scores everywhere else in this
 * module, which is exactly why `retrieval.ts`'s fusion works on *rank*
 * position rather than comparing these two scales directly.
 */
export const searchFtsPhrasings = Effect.fn("searchFtsPhrasings")(function* (
  queryText: string,
  limit: number,
) {
  const matchQuery = buildFtsMatchQuery(queryText);
  if (matchQuery === null) return [] as ReadonlyArray<FtsHit>;

  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql`
    SELECT pack_id AS "packId", name, description
    FROM pack_fts
    WHERE pack_fts MATCH ${matchQuery}
    ORDER BY bm25(pack_fts) ASC
    LIMIT ${limit}
  `.pipe(Effect.mapError(toPersistenceSqlError("PackFts.searchFtsPhrasings")));

  return rows as unknown as ReadonlyArray<FtsHit>;
});
