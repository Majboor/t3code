import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * A separate migration from 066_UserPreferences.ts rather than editing that
 * table's own CREATE, since that migration is already shared/committed on
 * the branch other in-flight work is also building on -- an additive ALTER
 * here can't conflict with it the way editing its column list could.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE user_preferences
    ADD COLUMN notification_popups_enabled INTEGER NOT NULL DEFAULT 1
  `;
});
