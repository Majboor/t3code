import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Records who wrote a message.
 *
 * The transcript stored only `role`, so every human message in a shared thread
 * was equally "user". Two people in one project produced identical bubbles: the
 * roster knew both of them and their colours, and the conversation knew
 * neither. Identity reached the socket and was dropped before the event, so no
 * amount of rendering could have recovered it.
 *
 * Existing rows stay null, and null renders as it always has. Putting a name on
 * words nobody recorded a name for is worse than admitting the author is
 * unknown — the only candidate here would have been a timestamp match, which is
 * the mistake migration 047 exists to undo.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const columns = yield* sql`PRAGMA table_info(projection_thread_messages)`;
  const alreadyThere = columns.some(
    (column) => (column as { name?: string }).name === "author_user_id",
  );
  if (alreadyThere) {
    return;
  }

  yield* sql`ALTER TABLE projection_thread_messages ADD COLUMN author_user_id TEXT`;
});
