import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_thread_preferences (
      tenant_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      favorite INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (tenant_id, user_id, thread_id)
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_preferences_user
    ON projection_thread_preferences(tenant_id, user_id)
  `;
});
