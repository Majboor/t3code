import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS analytics_streams (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      name TEXT NOT NULL,
      purpose TEXT NOT NULL,
      properties_json TEXT NOT NULL,
      ingest_key_name TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      archived_at TEXT
    )
  `;

  // A stream is addressed by project and name from the deployment side, so the
  // pair has to be unique or a posted event has no single stream to land in.
  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS analytics_streams_project_name_idx
      ON analytics_streams (project_id, name)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS analytics_events (
      id TEXT PRIMARY KEY,
      stream_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      received_at TEXT NOT NULL,
      properties_json TEXT NOT NULL
    )
  `;

  // Every question asked of this table is "this stream, over this window", so
  // the index matches the query rather than the insert.
  yield* sql`
    CREATE INDEX IF NOT EXISTS analytics_events_stream_time_idx
      ON analytics_events (stream_id, occurred_at)
  `;
});
