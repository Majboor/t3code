import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Records who accepted an invite.
 *
 * The roster worked out a member's email by finding the membership whose
 * created_at exactly equalled the invite's accepted_at — a join on two
 * timestamps agreeing to the millisecond. When it missed, the person appeared
 * with no email at all, which in a workspace where two people share a display
 * name makes them impossible to tell apart, and makes every action that starts
 * by picking somebody out of the list unavailable.
 *
 * Existing rows stay null. The old timestamp match is kept as a fallback for
 * exactly those, because guessing a user for an invite accepted before anybody
 * recorded one would put the wrong email against a name.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const columns = yield* sql`PRAGMA table_info(tenant_invites)`;
  const alreadyThere = columns.some(
    (column) => (column as { name?: string }).name === "accepted_by_user_id",
  );
  if (alreadyThere) {
    return;
  }

  yield* sql`ALTER TABLE tenant_invites ADD COLUMN accepted_by_user_id TEXT`;
});
