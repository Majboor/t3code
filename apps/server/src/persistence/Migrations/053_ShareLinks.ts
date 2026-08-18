import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Public share links, and every click on one.
 *
 * These two tables are the first storage in the product whose primary read
 * happens with no session at all. A visitor arrives holding nothing but a
 * string out of a URL, and that string alone has to decide what they may see.
 * Everything below follows from that.
 *
 * The token column is the credential, so it gets a UNIQUE index of its own
 * rather than being made the primary key. Two reasons for keeping it off the
 * key: the views table references a link, and a foreign key made of the secret
 * would copy that secret into every analytics row, where it would then be
 * dumped by every debug query over the series; and an id is safe to log while
 * a token is not, so the thing rows are named by should not be the thing that
 * grants access.
 *
 * "Is this link still good" is one query and no joins. `scope`, `expires_at`
 * and `revoked_at` all sit on the row the token index finds, so the redemption
 * path reads exactly one row and decides from it — no second lookup to check
 * revocation, which would open a window where a link works for one request
 * after being switched off.
 *
 * Indexes, and which read each one serves — 051's convention, and needed here
 * for the reason 052 gives: unlike 051's tables, nothing here is read by a
 * leftmost prefix of the primary key in the path that matters.
 *
 *   - `share_links_token_idx` UNIQUE (token) serves `getLinkByToken`, the
 *     unauthenticated read on every single visit. It is also the collision
 *     guard: two links sharing a token is not a constraint violation to be
 *     retried but a sign the generator has stopped being random, and it should
 *     fail loudly at the INSERT rather than silently hand one person's link to
 *     another's visitor.
 *   - `share_links_workspace_idx` (tenant_id, workspace_id, created_at) serves
 *     `listLinksForWorkspace` as an ordered range scan — the management panel,
 *     newest first, already sorted.
 *   - `share_links_project_idx` (tenant_id, project_id, created_at) serves
 *     `listLinksForProject`, the same panel scoped to one project. Partial on
 *     `project_id IS NOT NULL`, because workspace links have no project and
 *     would otherwise occupy an entry that no read can ever match.
 *   - `share_link_views_link_idx` (link_id, viewed_at) serves `listViews` for
 *     one link, newest first.
 *
 * No foreign key from the views to the links. A view is a record of something
 * that happened, and deleting a link — which is not offered today, but will be
 * asked for — must not quietly rewrite the history of who saw what.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS share_links (
      link_id TEXT PRIMARY KEY,
      -- 32 bytes of CSPRNG output, base64url. Never a uuid: v4 leaks version
      -- and variant bits and, more to the point, uuids are minted for ids all
      -- over this codebase and get logged as such. This URL is the entire
      -- access control for whatever it points at, so it is sized to be
      -- unguessable under sustained online attack rather than merely unique.
      token TEXT NOT NULL,
      -- "file" | "project" | "workspace". Not constrained by a CHECK, matching
      -- 052: a build that learns a fourth scope would make its rows unreadable
      -- to an older binary, and the service validates on the way in.
      scope TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      -- Null for a workspace link. Set for project and file links.
      project_id TEXT,
      -- Project-relative, and only ever set for scope "file".
      file_path TEXT,
      created_by_user_id TEXT NOT NULL,
      -- What the creator called it. Null is not the empty string: they named
      -- nothing, as opposed to naming it blank.
      label TEXT,
      created_at TEXT NOT NULL,
      -- Null means the link never lapses on its own. Stored as a moment rather
      -- than a lifetime so that redemption compares two timestamps and never
      -- has to do date arithmetic on the hot path.
      expires_at TEXT,
      -- Set once, never moved. Revoking twice keeps the first time, because
      -- that is when access actually ended and it is what an incident review
      -- asks for.
      revoked_at TEXT,
      -- The running summary, for the list. The per-click detail is in
      -- share_link_views; see that table for why both exist.
      last_viewed_at TEXT,
      view_count INTEGER NOT NULL DEFAULT 0
    )
  `;

  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS share_links_token_idx
      ON share_links (token)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS share_links_workspace_idx
      ON share_links (tenant_id, workspace_id, created_at)
  `;

  // Partial, so the workspace links that have no project stay out of it.
  yield* sql`
    CREATE INDEX IF NOT EXISTS share_links_project_idx
      ON share_links (tenant_id, project_id, created_at)
      WHERE project_id IS NOT NULL
  `;

  // One row per click, appended and never updated. The counter on share_links
  // could answer "how many" on its own, and nothing else: not when, not how
  // often, not whether one person refreshed forty times. This is the same
  // split collaboration_member_usage and collaboration_usage_samples already
  // make, for the same reason migration 050 gives — the running total is what
  // a list of twenty links can afford to render, and the series is what the
  // notch UI and the analytics page actually read.
  yield* sql`
    CREATE TABLE IF NOT EXISTS share_link_views (
      view_id TEXT PRIMARY KEY,
      link_id TEXT NOT NULL,
      viewed_at TEXT NOT NULL,
      -- Null for an unauthenticated visitor, which is the ordinary case and
      -- the whole point of a public link.
      viewer_user_id TEXT,
      -- A salted hash the server computes, never a raw IP. Repeat visits need
      -- to group together; an analytics table does not need to be a place
      -- where visitor addresses accumulate, and once they are written down
      -- they are subject to every request that follows.
      viewer_fingerprint TEXT
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS share_link_views_link_idx
      ON share_link_views (link_id, viewed_at)
  `;
});
