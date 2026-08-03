import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS tenant_workspaces (
      workspace_id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      organization_id TEXT,
      owner_user_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      access_mode TEXT NOT NULL,
      title TEXT NOT NULL,
      created_at TEXT NOT NULL,
      archived_at TEXT
    )
  `;

  yield* sql`CREATE INDEX IF NOT EXISTS idx_tenant_workspaces_tenant ON tenant_workspaces(tenant_id, archived_at)`;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_tenant_workspaces_org ON tenant_workspaces(organization_id, archived_at)`;
});
