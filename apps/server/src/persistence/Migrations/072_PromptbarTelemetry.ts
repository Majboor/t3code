import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * One row per promptbar outcome the composer bar reached: a candidate was
 * accepted (click or Tab), a suggestion was dismissed, or the resolve call
 * came back ACTION with nothing good enough to show ("abstained"). No
 * aggregation lives here on purpose — a separate eval-harness agent computes
 * recall/MRR/etc. by reading this table directly, so the schema stays a
 * plain append-only log rather than growing columns for someone else's
 * metrics.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS promptbar_telemetry (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      event TEXT NOT NULL,
      pack_id TEXT,
      query TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `;

  // The harness reads "everything for this outcome, in order" far more often
  // than it looks up a single row by id.
  yield* sql`
    CREATE INDEX IF NOT EXISTS promptbar_telemetry_event_time_idx
      ON promptbar_telemetry (event, created_at)
  `;
});
