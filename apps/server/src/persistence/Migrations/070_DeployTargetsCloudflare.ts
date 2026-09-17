import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * `cloudflare-tunnel`/`cloudflare-pages` join `command`/`ssh` as deploy
 * target kinds — each existing config column (`ssh_json`) is one kind's own
 * JSON blob, null for every other kind, so a new kind is a new nullable
 * column rather than a schema change to the ones already there.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE deploy_targets ADD COLUMN cloudflare_tunnel_json TEXT
  `;

  yield* sql`
    ALTER TABLE deploy_targets ADD COLUMN cloudflare_pages_json TEXT
  `;
});
