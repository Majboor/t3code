import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS tenant_runtime_systemd_units (
      runtime_id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      unit_name TEXT NOT NULL,
      unit_file TEXT NOT NULL,
      generated_at TEXT NOT NULL,
      last_written_at TEXT
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS tenant_runtime_descriptors (
      runtime_id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      strategy TEXT NOT NULL,
      linux_user TEXT NOT NULL,
      base_dir TEXT NOT NULL,
      data_dir TEXT NOT NULL,
      secrets_dir TEXT NOT NULL,
      attachments_dir TEXT NOT NULL,
      worktrees_dir TEXT NOT NULL,
      runs_dir TEXT NOT NULL,
      provider_homes_dir TEXT NOT NULL,
      internal_host TEXT NOT NULL,
      internal_port INTEGER NOT NULL,
      status TEXT NOT NULL,
      idle_shutdown_after_ms INTEGER NOT NULL,
      last_started_at TEXT,
      last_stopped_at TEXT
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS tenant_runtime_lifecycle_steps (
      idempotency_key TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      runtime_id TEXT NOT NULL,
      operation TEXT NOT NULL,
      source_action TEXT NOT NULL,
      target_status TEXT NOT NULL,
      process_action INTEGER NOT NULL,
      reason TEXT NOT NULL,
      completed_at TEXT NOT NULL
    )
  `;

  yield* sql`CREATE INDEX IF NOT EXISTS idx_tenant_runtime_systemd_units_tenant ON tenant_runtime_systemd_units(tenant_id)`;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_tenant_runtime_descriptors_tenant_status ON tenant_runtime_descriptors(tenant_id, status)`;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_tenant_runtime_lifecycle_steps_runtime ON tenant_runtime_lifecycle_steps(tenant_id, runtime_id, completed_at)`;
});
