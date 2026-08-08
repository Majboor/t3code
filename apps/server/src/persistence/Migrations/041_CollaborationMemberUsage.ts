import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Tokens a member has spent, kept per thread. Providers report a cumulative
 * figure for a thread rather than a delta, so a row holds the highest total
 * that thread has reached and a member's usage is the sum across their rows.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS collaboration_member_usage (
      tenant_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      total_tokens INTEGER NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (tenant_id, workspace_id, user_id, thread_id)
    )
  `;
});
