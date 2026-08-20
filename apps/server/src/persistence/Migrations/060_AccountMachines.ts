import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * The machines an account has handed a credential to.
 *
 * Enrollment (migration 057) answers "may this machine in". Nothing answered
 * the question that comes after it: *which* machines are in. The desktop app
 * writes down what it thinks it is, but that record lives on the machine, so
 * the account's own view of itself was assembled from whatever each client
 * chose to claim. A person who lost a laptop had nowhere to look and nothing to
 * press — the credential stayed live because no server-side row knew it existed
 * as a machine at all.
 *
 * This table is the account's copy of that list, written at the one instant the
 * machine, the person and the credential are all known at once: `/collect`.
 *
 * Decisions worth keeping:
 *
 * `auth_session_id` is the whole point of the row. A list of machines that
 * cannot be traced back to the credential each one holds can only ever offer a
 * Disconnect button that deletes a row — theatre, and worst exactly when it
 * matters, because the hardware is in somebody else's hands and the token in it
 * keeps working. With the session id here, disconnecting means revoking that
 * session, which `SessionCredentialService.verify` already refuses on the very
 * next request. It is `NOT NULL` because a machine row that names no credential
 * describes nothing this feature can act on.
 *
 * It is `UNIQUE` because a credential belongs to one machine. Without that, two
 * rows could point at the same session and revoking either would silently kill
 * the other, which reads to the person as a Disconnect that hit the wrong
 * device.
 *
 * No foreign key to `auth_sessions`, matching every other table here: SQLite
 * enforces none by default, so a declared one is documentation that looks like
 * a guarantee. The session id is also deliberately *kept* after revocation
 * rather than nulled — "this machine held that credential, and it is dead" is
 * the audit answer; a null would leave only "some machine, once".
 *
 * `user_id` and not a subject. It is what `resolveAuthenticatedUserId` returns,
 * which is the one rule the rest of the system uses for "whose is this"; a
 * subject is how a session was established, and the same person can arrive
 * under more than one. Filing machines by subject would split one person's
 * laptops across two lists depending on how each one signed in.
 *
 * `revoked_at` rather than a delete. A machine that was cut off is evidence —
 * it is the row somebody will want to look at after the fact — and keeping it
 * also lets the same physical machine reclaim its own history if it reconnects,
 * instead of collecting a fresh row on every visit.
 *
 * `first_seen_at` / `last_seen_at` are ISO text like every other timestamp in
 * this schema. `last_seen_at` is a floor, not a heartbeat: it moves when the
 * machine registers and when it asks about itself, so it answers "no earlier
 * than" rather than "exactly". A person scanning this list needs to spot the
 * device that has not appeared in six months, and that is a question a floor
 * answers correctly.
 *
 * `label` and `platform` are copied from the enrollment rather than joined back
 * to it. The enrollment row is a spent credential's audit trail and may be
 * pruned; the machine list has to keep naming things a person recognises long
 * after that. They are nullable for the same reason they are nullable on the
 * enrollment: a minimal client that reports nothing should still end up on this
 * list, because an unnamed machine holding a credential is precisely the one
 * worth showing.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS account_machines (
      machine_id TEXT PRIMARY KEY,
      -- Whose machine this is, as resolveAuthenticatedUserId reports it.
      user_id TEXT NOT NULL,
      -- The credential it holds. Revoking this is what Disconnect means.
      auth_session_id TEXT NOT NULL,
      -- Carried over from the enrollment so the list names things a person
      -- recognises. Nullable: unnamed is a fact, not a reason to omit the row.
      label TEXT,
      platform TEXT,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      revoked_at TEXT
    )
  `;

  // The list is always "my machines, most recent first". Without this it is a
  // scan of every machine every account has ever connected.
  yield* sql`
    CREATE INDEX IF NOT EXISTS account_machines_by_user
      ON account_machines (user_id, last_seen_at DESC)
  `;

  // One credential, one machine. See the note above: this is what stops a
  // Disconnect from taking down a device the person did not choose.
  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS account_machines_by_session
      ON account_machines (auth_session_id)
  `;
});
