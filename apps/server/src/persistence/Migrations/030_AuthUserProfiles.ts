import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS auth_user_profiles (
      subject TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      avatar_initials TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
});
