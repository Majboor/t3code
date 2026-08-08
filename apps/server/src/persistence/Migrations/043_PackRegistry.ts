import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * The pack registry: one entry per published pack, and one append-only row per
 * version.
 *
 * The version table has no mutable columns on purpose. A published version is a
 * promise about behaviour, so a change is a new row and a rollback is a consumer
 * pinning an older one. Only the entry moves — its visibility, and the
 * projection of whichever version was published last.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS pack_registry_entries (
      pack_id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      name TEXT NOT NULL,
      publisher_handle TEXT NOT NULL,
      display_name TEXT NOT NULL,
      summary TEXT NOT NULL,
      capability_summary TEXT NOT NULL,
      tags_json TEXT NOT NULL,
      search_text TEXT NOT NULL,
      visibility_scope TEXT NOT NULL,
      visibility_owner_id TEXT,
      visibility_json TEXT NOT NULL,
      latest_version TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  // A pack name is unique per publisher, never globally.
  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS pack_registry_entries_publisher_name_idx
      ON pack_registry_entries (publisher_handle, name)
  `;

  // Private-to-workspace is the first-class case, so it gets the narrowing
  // index every search runs through before it looks at any text.
  yield* sql`
    CREATE INDEX IF NOT EXISTS pack_registry_entries_workspace_idx
      ON pack_registry_entries (tenant_id, workspace_id, updated_at DESC)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS pack_registry_entries_visibility_idx
      ON pack_registry_entries (visibility_scope, visibility_owner_id, updated_at DESC)
  `;

  // Name lookup is what an agent does when it already knows what it wants.
  yield* sql`
    CREATE INDEX IF NOT EXISTS pack_registry_entries_name_idx
      ON pack_registry_entries (name)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS pack_registry_versions (
      pack_id TEXT NOT NULL,
      version TEXT NOT NULL,
      manifest_json TEXT NOT NULL,
      capability_summary TEXT NOT NULL,
      published_by_user_id TEXT NOT NULL,
      published_at TEXT NOT NULL,
      PRIMARY KEY (pack_id, version)
    )
  `;

  // The history is always read for one pack, newest first.
  yield* sql`
    CREATE INDEX IF NOT EXISTS pack_registry_versions_history_idx
      ON pack_registry_versions (pack_id, published_at DESC)
  `;
});
