import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Per-workspace overrides for how a member is drawn. Colours default from the
 * user id, so a row only exists once a lead has actually changed one.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS collaboration_member_profiles (
      tenant_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      color TEXT,
      display_name TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (tenant_id, workspace_id, user_id)
    )
  `;
});
