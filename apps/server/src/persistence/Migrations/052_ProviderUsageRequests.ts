import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * The other side of provider account sharing: the asking.
 *
 * Migration 051 stores what contributors and admins have already decided. It
 * has no room for the person who has decided nothing because they have nothing
 * to decide with — no connected account at all, or one whose subscription
 * limit is about to run out. Their only route today is out of band, and an
 * admin who is not told cannot grant. This table is that message, kept where
 * the panel can read it.
 *
 * Unlike 051's four tables this one has a surrogate primary key. Every row
 * there is a *current setting*, so its natural key is its identity and a write
 * is an upsert. A request is an *event*: the same person may ask, be declined,
 * and ask again next month, and all three are real rows that must coexist.
 * There is no column combination that stays unique across that history, so the
 * id is minted by the caller and the uniqueness that does matter is expressed
 * as an index instead.
 *
 * Two indexes, and 051's reasoning is why they are needed here when they were
 * not there: a request is never read by its primary key in the path that
 * matters. `getRequest` does, but the panel's read is "the pending requests in
 * this workspace", which starts at `tenant_id` — nowhere near `request_id`.
 *
 *   - `provider_usage_requests_workspace_status_idx`
 *     (tenant_id, workspace_id, status, created_at) serves
 *     `listRequestsForWorkspace`, the read behind the reviewer's queue, as an
 *     ordered range scan: filtered by status and already sorted oldest-first,
 *     so the common case needs no sort step. Its (tenant_id, workspace_id)
 *     prefix also serves `listRequestsForUser` and the unfiltered workspace
 *     listing, which then sort in memory over one workspace's rows.
 *   - `provider_usage_requests_pending_idx` is a *partial* unique index over
 *     pending rows only. It is the duplicate rule, not a performance index: a
 *     person gets at most one open request per provider per workspace, and
 *     asking again updates that row rather than adding a second. Because the
 *     index covers only `status = 'pending'`, answered and withdrawn rows fall
 *     out of it and the same person may ask again afterwards — which is
 *     exactly the history the surrogate key exists to keep.
 *
 * No foreign key to `provider_account_shares` or to the account index. The
 * account that answered a request can be disconnected later, and a cascade
 * would erase the record of who helped. Responses are history and history does
 * not get tidied up when the world moves on.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS provider_usage_requests (
      request_id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      requester_user_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      -- "no-account" | "limit-reached" | "asked". Kept apart from the note
      -- because it is the one part a reviewer can trust: the server derives it
      -- from what it knows, while the note is whatever the asker typed.
      reason TEXT NOT NULL,
      -- Optional, and null is not the empty string: nothing was said, as
      -- opposed to something blank being said.
      note TEXT,
      -- "pending" | "granted" | "declined" | "withdrawn". Not constrained by a
      -- CHECK: a build that learns a fifth status would make every older row
      -- unreadable to an older binary and unwritable to the newer one, and the
      -- service already validates on the way in.
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      -- All three are null while pending and set together when someone
      -- answers. responded_account_id names the account that was lent, so the
      -- asker can be told whose credential they are running on; it stays null
      -- on a decline or a withdrawal, where no account changed hands.
      responded_at TEXT,
      responded_by_user_id TEXT,
      responded_account_id TEXT
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS provider_usage_requests_workspace_status_idx
      ON provider_usage_requests (tenant_id, workspace_id, status, created_at)
  `;

  // Partial, so it constrains only what is still open. This is enforcement,
  // not an optimisation: without it a bored or retrying client stacks pending
  // rows for the same provider and the reviewer's queue fills with the same
  // person's name.
  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS provider_usage_requests_pending_idx
      ON provider_usage_requests (tenant_id, workspace_id, requester_user_id, provider)
      WHERE status = 'pending'
  `;
});
