import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS pack_enablements (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      pack_id TEXT NOT NULL,
      version TEXT NOT NULL,
      pack_name TEXT NOT NULL,
      pack_summary TEXT NOT NULL,
      settings_json TEXT NOT NULL,
      enabled_at TEXT NOT NULL,
      disabled_at TEXT
    )
  `;

  // A project enables a pack once. Re-enabling after disabling reuses the row,
  // so the pair has to be unique or the same pack shows up twice in a list.
  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS pack_enablements_project_pack_idx
      ON pack_enablements (project_id, pack_id)
  `;
});
