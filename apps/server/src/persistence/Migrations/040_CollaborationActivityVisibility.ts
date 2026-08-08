import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Lets an author take one of their prompts out of the shared history without
 * deleting it — they keep seeing it, everyone else stops.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`ALTER TABLE collaboration_activities ADD COLUMN hidden_at TEXT`;
});
