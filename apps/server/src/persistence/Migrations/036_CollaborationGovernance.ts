import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Backing tables for collaborative governance: who approves prompts, which
 * prompts are waiting, each person's own view filter and branch, and who last
 * touched which file.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS collaboration_workspace_settings (
      tenant_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      lead_user_id TEXT,
      approval_mode TEXT NOT NULL,
      approver_user_ids_json TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (tenant_id, workspace_id)
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS collaboration_prompt_approvals (
      approval_id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      thread_id TEXT,
      requested_by_user_id TEXT NOT NULL,
      requested_by_name TEXT NOT NULL,
      prompt TEXT NOT NULL,
      mode TEXT NOT NULL,
      status TEXT NOT NULL,
      decided_by_user_id TEXT,
      decided_at TEXT,
      note TEXT,
      created_at TEXT NOT NULL
    )
  `;

  // The approval queue is always read workspace-scoped and newest-first.
  yield* sql`
    CREATE INDEX IF NOT EXISTS collaboration_prompt_approvals_workspace_idx
      ON collaboration_prompt_approvals (tenant_id, workspace_id, created_at)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS collaboration_view_preferences (
      tenant_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      show_others_prompts INTEGER NOT NULL,
      show_others_files INTEGER NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (tenant_id, workspace_id, user_id)
    )
  `;

  // One branch per person per workspace, so the key is the person.
  yield* sql`
    CREATE TABLE IF NOT EXISTS collaboration_branch_claims (
      tenant_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      display_name TEXT NOT NULL,
      branch TEXT NOT NULL,
      base_branch TEXT NOT NULL,
      worktree_path TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (tenant_id, workspace_id, user_id)
    )
  `;

  // Latest toucher wins, so the path is the key rather than an append log.
  yield* sql`
    CREATE TABLE IF NOT EXISTS collaboration_file_touches (
      tenant_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      path TEXT NOT NULL,
      user_id TEXT NOT NULL,
      display_name TEXT NOT NULL,
      touched_at TEXT NOT NULL,
      PRIMARY KEY (tenant_id, workspace_id, path)
    )
  `;
});
