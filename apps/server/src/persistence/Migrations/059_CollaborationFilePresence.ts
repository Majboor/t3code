import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Records what is in a file now, next to the table that records who changed it.
 *
 * `collaboration_file_touches` is history. It says a file was touched and by
 * whom, it never expires, and that is right — a mark that vanished would be a
 * worse answer to "who wrote this". It is also why nothing could ever say
 * whether the thing in a file at this moment is a person's editor or an agent
 * rewriting it, which is the one question where the two cases want opposite
 * advice: two people want a branch each, and an agent over an open buffer wants
 * somebody interrupted before the turn lands.
 *
 * So this is a separate table rather than more columns on that one, because it
 * is a different kind of fact with a different lifetime. Every row here is a
 * claim with a deadline: the service prunes anything past its TTL on every
 * read and every write, and the browser applies the same deadline again when it
 * draws. A presence nobody is refreshing has to disappear on its own — the page
 * holding it can be closed, crash or lose its socket without ever saying
 * goodbye, and "somebody is editing this" left standing forever is worse than
 * never having shown it.
 *
 * `kind` is in the key alongside the person: somebody with a file open while
 * their own turn writes it is two rows, and collapsing them would erase exactly
 * the collision worth warning about. `source_id` is in it too — one thread for
 * an agent, one browser page for a person — so two turns by the same person
 * race each other visibly, while two tabs stay one person once the rows are
 * counted.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS collaboration_file_presence (
      tenant_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      path TEXT NOT NULL,
      user_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      source_id TEXT NOT NULL,
      display_name TEXT NOT NULL,
      started_at TEXT NOT NULL,
      refreshed_at TEXT NOT NULL,
      PRIMARY KEY (tenant_id, workspace_id, path, user_id, kind, source_id)
    )
  `;

  // Everything asked of this table is "what is live in this workspace", which
  // is read on every explorer render and every turn start. The path is not in
  // the index on purpose: the answer is filtered per path in memory after the
  // whole workspace's live set has been loaded anyway.
  yield* sql`
    CREATE INDEX IF NOT EXISTS collaboration_file_presence_workspace_idx
      ON collaboration_file_presence (tenant_id, workspace_id, refreshed_at)
  `;
});
