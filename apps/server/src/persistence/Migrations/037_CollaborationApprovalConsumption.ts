import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * An approval is good for exactly one turn. Recording when it was spent is what
 * keeps a single yes from being replayed into any number of runs.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`ALTER TABLE collaboration_prompt_approvals ADD COLUMN consumed_at TEXT`;
});
