import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Maps a LogicPacks user to their account on the standalone LogicPacks API
 * gateway (the GLM-5.3 reseller). One row per user, 1:1, created lazily the
 * first time we provision them (see gateway/Layers/LogicPacksGateway.ts).
 *
 * `api_key` is the gateway's own issued `sk_live_...` secret, stored in
 * plaintext — this codebase has no per-row field-encryption helper anywhere
 * (provider OAuth tokens are stored unencrypted too), so this is consistent
 * with the existing trust model, not a new class of risk.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS gateway_accounts (
      user_id TEXT PRIMARY KEY,
      external_id TEXT NOT NULL,
      gateway_user_id TEXT,
      api_key TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
});
