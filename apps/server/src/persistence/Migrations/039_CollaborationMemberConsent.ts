import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * What a member agreed to share with the workspace when they joined. Null means
 * they have not been asked yet, which is not the same as having said no.
 *
 * Separate from 038 because that migration had already been applied by the time
 * consent was added, and an applied migration never runs again.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`ALTER TABLE collaboration_member_profiles ADD COLUMN share_profile INTEGER`;
  yield* sql`ALTER TABLE collaboration_member_profiles ADD COLUMN share_usage INTEGER`;
  yield* sql`ALTER TABLE collaboration_member_profiles ADD COLUMN consent_at TEXT`;
});
