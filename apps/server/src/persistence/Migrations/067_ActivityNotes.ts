import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * One entity serving both direct messages between two users and notes/comments
 * on a shared prompt, deliberately unified rather than built as two tables:
 * both are "someone wrote a message aimed at a target, maybe in reply to
 * another one." `target_type` decides what `target_id` means.
 *
 * `status` only ever leaves "open" for a prompt-note (an author resolving
 * feedback on something they shared); a direct message has no reader-visible
 * concept of "resolved" and simply stays "open" forever.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS activity_notes (
      id TEXT PRIMARY KEY,
      author_id TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_id TEXT NOT NULL,
      parent_note_id TEXT,
      body TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      visibility TEXT NOT NULL,
      created_at TEXT NOT NULL,
      resolved_at TEXT,
      resolved_by_user_id TEXT
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS activity_notes_target_idx
      ON activity_notes (target_type, target_id, created_at)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS activity_notes_parent_idx
      ON activity_notes (parent_note_id)
  `;

  // A prompt-note's target is one of these — a durable record of "this user
  // shared this prompt," independent of the in-memory, per-session
  // `CollaborationService` activity feed (`recordSharedPrompt`/`stateRef`),
  // which is ephemeral live state, not a stable id a note can point at.
  yield* sql`
    CREATE TABLE IF NOT EXISTS shared_prompts (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      shared_by_user_id TEXT NOT NULL,
      prompt_text TEXT NOT NULL,
      source_thread_id TEXT,
      source_turn_id TEXT,
      created_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS shared_prompts_workspace_idx
      ON shared_prompts (tenant_id, workspace_id, created_at)
  `;
});
