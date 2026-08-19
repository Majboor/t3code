import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Where a live copy of a project is reachable while its first pass is still
 * running, and when the machine holding it last said so.
 *
 * Sharing does not make anyone wait for a first pass. It starts the upload and a
 * quick tunnel at the same time, and the link handed out is always the cloud
 * URL — never the tunnel's, which changes on every restart and dies with the
 * laptop. These two columns are how the cloud knows there is a faster route to
 * offer while it fills in.
 *
 * Both are on `project_cloud_sync` rather than in a table of their own. There is
 * at most one live copy per sync, it is read on exactly the request that already
 * reads this row, and it is thrown away rather than kept — a table would buy
 * history nobody wants of addresses that stopped working.
 *
 * `live_copy_url` is advisory and perishable and must never be treated as an
 * identity. `laptop_confirmed_at` is what makes it safe to hold: a tunnel dies
 * without telling anyone, so the address is only a claim about the past, and a
 * claim older than the staleness window in `@t3tools/contracts` counts as no
 * registration at all.
 *
 * The timestamp is deliberately *not* named after the URL, because it is stamped
 * by every heartbeat including one that carries no URL. That is what lets a
 * visitor be told "still uploading, no live copy" apart from "the person sharing
 * this closed their laptop" — the spec requires different advice for each, and
 * without a heartbeat that survives the absence of a tunnel the two look
 * identical from the data.
 *
 * No index. Both columns are read by project id, which is already the primary
 * key, and neither is ever a search term.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const columns = yield* sql`PRAGMA table_info(project_cloud_sync)`;
  const names = new Set(columns.map((column) => (column as { name?: string }).name));

  if (!names.has("live_copy_url")) {
    yield* sql`ALTER TABLE project_cloud_sync ADD COLUMN live_copy_url TEXT`;
  }

  if (!names.has("laptop_confirmed_at")) {
    yield* sql`ALTER TABLE project_cloud_sync ADD COLUMN laptop_confirmed_at TEXT`;
  }
});
