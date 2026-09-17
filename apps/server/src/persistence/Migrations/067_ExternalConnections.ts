import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * OAuth connections to external services on a user's behalf (GitHub,
 * Cloudflare) so LogicPacks can create/push repos and deploy Pages projects
 * for them. One row per (user, provider). Tokens stored in plaintext,
 * consistent with this codebase's existing trust model (see gateway_accounts,
 * provider OAuth tokens) — no per-row field-encryption helper exists here.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS external_connections (
      user_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      access_token TEXT NOT NULL,
      refresh_token TEXT,
      expires_at TEXT,
      account_id TEXT,
      account_label TEXT,
      scope TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (user_id, provider)
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS external_oauth_states (
      state TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `;
});
