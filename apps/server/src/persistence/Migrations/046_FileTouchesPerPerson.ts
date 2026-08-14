import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Widens the file-touch key to include the person.
 *
 * The table was keyed on the path alone, so the newest author replaced the
 * previous one. That reads as "who last changed this file", which is true and
 * is also the only question it could answer: two people working on the same
 * file left exactly the same row as one person working on it twice, and the
 * fact worth surfacing was gone before anything could ask for it.
 *
 * The old rows survive the widening — each becomes that person's entry — so
 * nothing is lost, and "who last touched it" is now a max over the rows rather
 * than the single row that happened to remain.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS collaboration_file_touches_per_person (
      tenant_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      path TEXT NOT NULL,
      user_id TEXT NOT NULL,
      display_name TEXT NOT NULL,
      touched_at TEXT NOT NULL,
      PRIMARY KEY (tenant_id, workspace_id, path, user_id)
    )
  `;

  yield* sql`
    INSERT OR IGNORE INTO collaboration_file_touches_per_person (
      tenant_id, workspace_id, path, user_id, display_name, touched_at
    )
    SELECT tenant_id, workspace_id, path, user_id, display_name, touched_at
    FROM collaboration_file_touches
  `;

  yield* sql`DROP TABLE collaboration_file_touches`;
  yield* sql`
    ALTER TABLE collaboration_file_touches_per_person
      RENAME TO collaboration_file_touches
  `;

  // Every question asked of this table is "who has been in this file", so the
  // index matches that rather than the insert.
  yield* sql`
    CREATE INDEX IF NOT EXISTS collaboration_file_touches_path_idx
      ON collaboration_file_touches (tenant_id, workspace_id, path)
  `;
});
