import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS deploy_targets (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      tenant_id TEXT,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      command TEXT NOT NULL,
      ssh_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      archived_at TEXT
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS deploy_targets_project_idx
      ON deploy_targets (project_id)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS deploy_runs (
      id TEXT PRIMARY KEY,
      target_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      status TEXT NOT NULL,
      exit_code INTEGER,
      output TEXT NOT NULL,
      triggered_by TEXT NOT NULL,
      started_at TEXT NOT NULL,
      completed_at TEXT
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS deploy_runs_target_idx
      ON deploy_runs (target_id, started_at DESC)
  `;
});
