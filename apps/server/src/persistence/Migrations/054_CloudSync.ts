import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Syncing a project between a laptop and a cloud copy.
 *
 * Three tables of very different shapes and lifetimes. `project_cloud_sync` has
 * one row per shared project and is read to render a button.
 * `cloud_sync_files` has one row per path per project — tens of thousands is
 * the design point, not the edge case — and is read in full by every
 * reconciliation pass. `cloud_sync_conflicts` is an append-only record of
 * places where two people's work collided.
 *
 * `cloud_sync_files` is the one that matters, and it is worth being explicit
 * about what it holds: the **base revision**, the content hash both sides last
 * agreed on for a path. It is not an inventory of what is on either machine.
 * The reconciler compares local, remote and this; without the third value the
 * only way to settle "both sides changed" is to trust a clock, and the clock on
 * a laptop disagrees with the server's by enough to delete somebody's morning.
 *
 * `deleted_at` is load-bearing and must never be optimised into a missing row.
 * Three states, not two:
 *
 *   - row, deleted_at NULL  -> we agreed on this content
 *   - row, deleted_at set   -> we agreed this path is gone
 *   - no row                -> we have never seen this path
 *
 * The last two look the same and behave oppositely: a path the server has never
 * seen is never removed whatever its index says, while a path both sides agreed
 * to delete may be. Collapse them and the first sync after a reinstall empties
 * a project. `hash` therefore stays populated on a tombstone too, holding what
 * the file was before the agreed deletion, so an edit that beats a delete can
 * still be restored from the base.
 *
 * Indexes, and which read each one serves — 051's convention, and worth
 * spelling out here because one of these is on the hot path of the whole
 * feature:
 *
 *   - cloud_sync_files PRIMARY KEY (project_id, path). SQLite builds an
 *     implicit unique index for a composite primary key, and `project_id` is
 *     its leftmost column, so "every base revision for this project, in path
 *     order" is one ordered range scan on that index and needs no index of its
 *     own. This is the read the reconciler makes once per pass over a tree of
 *     tens of thousands of rows, so it is also why `listBaseFiles` pages by
 *     `path >` rather than OFFSET: a keyset cursor resumes inside the same scan
 *     at constant cost, while OFFSET re-walks every row it skips and turns one
 *     pass into a quadratic one.
 *   - project_cloud_sync_workspace_idx (tenant_id, workspace_id, project_id)
 *     serves listing every synced project in a workspace. The primary key is
 *     project_id alone, so nothing else here can answer that without a scan.
 *   - cloud_sync_conflicts_open_idx (project_id, detected_at) partial on
 *     resolved_at IS NULL serves the default listing and the badge — what still
 *     needs a person. Partial because resolved conflicts are kept forever and
 *     would otherwise make "what is waiting" grow more expensive every time
 *     somebody tidied one up.
 *   - cloud_sync_conflicts_project_idx (project_id, detected_at) serves the
 *     same listing when it includes resolved rows: the history view, which is
 *     rare and unbounded.
 *   - cloud_sync_conflicts_copy_idx UNIQUE (project_id, conflicted_copy_path)
 *     serves no read. It is a guard; see the table.
 *
 * No foreign keys between the three. A conflict and a base revision are records
 * of what happened, and deleting a sync — which is not offered today and will
 * be asked for — must not cascade away the evidence of files somebody still has
 * two copies of on disk.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS project_cloud_sync (
      project_id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      -- "handoff" | "mirror". Not a CHECK, matching 052 and 053: a build that
      -- learns a third mode would make its rows unreadable to an older binary,
      -- and the service validates on the way in.
      mode TEXT NOT NULL,
      -- "idle" | "scanning" | "transferring" | "paused" | "error".
      status TEXT NOT NULL,
      -- When both sides last fully agreed. The one durable fact on this row:
      -- it survives every pass, because it is the only column that answers "is
      -- my work safe", and nothing short of a completed agreement moves it.
      last_agreed_at TEXT,
      -- Written with status "error" and cleared by the next pass that gets
      -- past it. A message that outlives its failure is how a working sync
      -- ends up permanently red.
      last_error TEXT,
      -- The next four describe THE CURRENT PASS ONLY. They are not lifetime
      -- totals and they are reset to zero when a pass begins: after two passes
      -- over a hundred files, files_done is at most a hundred, never two
      -- hundred. A counter that only climbs makes a progress bar that can
      -- never fill, and someone will spend an hour hunting the leak. They may
      -- also legitimately go down between passes, since a second pass over a
      -- mostly-unchanged tree has less to move than the first.
      files_total INTEGER NOT NULL DEFAULT 0,
      files_done INTEGER NOT NULL DEFAULT 0,
      bytes_total INTEGER NOT NULL DEFAULT 0,
      bytes_done INTEGER NOT NULL DEFAULT 0,
      -- 1 when the watcher saw a write in the last few seconds. This is why a
      -- sync that never finishes is not always broken: somebody is typing. The
      -- UI has no other way to tell that apart from stuck.
      actively_changing INTEGER NOT NULL DEFAULT 0,
      -- Open conflicts only, kept as a running summary so the badge costs one
      -- row rather than a count over a table that only grows. The same split
      -- 050 and 053 make, for the same reason; the detail is in
      -- cloud_sync_conflicts and neither is derived from the other at read
      -- time.
      conflict_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS project_cloud_sync_workspace_idx
      ON project_cloud_sync (tenant_id, workspace_id, project_id)
  `;

  // The base revision, one row per path. See the header: this is what both
  // sides last agreed on, not what either machine currently holds.
  yield* sql`
    CREATE TABLE IF NOT EXISTS cloud_sync_files (
      project_id TEXT NOT NULL,
      -- Project-relative, stored exactly as it is on disk. Never trimmed or
      -- normalised here: a trailing space is a legal part of a filename on
      -- macOS and Linux, and a rewritten path is a file restored to the wrong
      -- place.
      path TEXT NOT NULL,
      -- The agreed content hash, and NOT NULL even on a tombstone, where it
      -- holds what the file was before the agreed deletion. Mtimes are
      -- deliberately absent from this table: they are a cheap "might have
      -- changed" filter on the client and were never a tiebreak, so storing
      -- one would only invite somebody to compare them.
      hash TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      updated_at TEXT NOT NULL,
      -- Set means "both sides agreed this path is gone", which is categorically
      -- different from having no row at all. Read the header before touching
      -- this column.
      deleted_at TEXT,
      -- Composite key, in this order on purpose: project_id leads so that the
      -- implicit index it creates is also the index the per-project scan and
      -- its keyset pagination ride on.
      PRIMARY KEY (project_id, path)
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS cloud_sync_conflicts (
      conflict_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      -- The path that stayed canonical, holding the remote version, so that
      -- collaborators in the browser stay consistent with each other.
      path TEXT NOT NULL,
      -- Where the local version was kept instead of being discarded. There is
      -- no winner column anywhere in this table: a conflict is never resolved
      -- by choosing, both versions survive, and a person decides later with
      -- both in front of them.
      conflicted_copy_path TEXT NOT NULL,
      detected_at TEXT NOT NULL,
      -- A person dealt with it. Not "the system picked one". The row outlives
      -- the badge so that anybody asking later what happened to their file can
      -- still be told.
      resolved_at TEXT
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS cloud_sync_conflicts_open_idx
      ON cloud_sync_conflicts (project_id, detected_at)
      WHERE resolved_at IS NULL
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS cloud_sync_conflicts_project_idx
      ON cloud_sync_conflicts (project_id, detected_at)
  `;

  // A guard rather than a read path, and the only unique constraint here. Two
  // conflicts claiming the same conflicted copy path would mean the second one
  // overwrote the first person's rescued file, which is the exact loss this
  // whole feature exists to prevent. Left to fail at the INSERT, in the spirit
  // of 053: a collision is a bug in whoever names these copies, not a
  // condition to quietly upsert past.
  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS cloud_sync_conflicts_copy_idx
      ON cloud_sync_conflicts (project_id, conflicted_copy_path)
  `;
});
