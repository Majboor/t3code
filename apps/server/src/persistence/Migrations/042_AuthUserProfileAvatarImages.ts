import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Holds an uploaded avatar as a size-capped `data:` URL so profiles stay
 * self-contained: no blob store, no image serving route.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`ALTER TABLE auth_user_profiles ADD COLUMN avatar_data_url TEXT`;
});
