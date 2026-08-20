import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * A machine asking to join someone's account.
 *
 * Connecting a machine used to mean carrying a pairing token from one place to
 * another by hand. This table is what replaces that: the app makes a row, opens
 * the browser, and a person who is *already signed in there* approves it. The
 * secret never travels in the download, and nobody types anything.
 *
 * Decisions worth keeping:
 *
 * `code_hash`, not the code. The row is a lookup key for a bearer credential,
 * and a database that can be read — a backup, a support session, an operator
 * with sqlite3 — must not hand out working codes for machines still waiting to
 * be approved. The service hashes on the way in, so a lookup is a hash and an
 * equality test on the primary key.
 *
 * `status` carries `collected` separately from `approved` because approval and
 * handover are different events. Approval says a person consented; collection
 * says the credential is gone. Without the distinction a replayed poll re-issues
 * access to whoever presents the code, which is the one failure this whole flow
 * exists to avoid.
 *
 * `expires_at_ms` is an integer rather than a timestamp string because it is
 * compared, never displayed, and every other date column here is ISO text that
 * would invite a lexical comparison to creep in. Nothing sweeps expired rows on
 * a timer, so the deadline has to be checked at read time — `decideEnrollment`
 * does exactly that and does not trust `status` alone.
 *
 * The descriptive columns — `device_label`, `device_platform`, `requested_ip` —
 * exist so the approval screen can show a person something they can recognise.
 * "Approve this machine?" with no machine named is a dialog people click
 * through, and a flow whose safety rests on a click nobody reads is decoration.
 * They are nullable because an old or minimal client may not send them, and a
 * missing label should read as unknown rather than block enrollment.
 *
 * No foreign key to a user: the row is created *before* anyone approves it, so
 * at insert time it belongs to nobody. `approved_by_user_id` is filled in at
 * approval and is null in every other state, including after a denial — a
 * denial clears it, so a stale id can never be collected against.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS device_enrollments (
      -- SHA-256 of the code the device holds. Never the code itself.
      code_hash TEXT PRIMARY KEY,
      -- "pending" | "approved" | "collected" | "denied". Not a CHECK, matching
      -- the share-link columns: a newer binary that learns another state would
      -- otherwise write rows an older one refuses to read.
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL,
      expires_at_ms INTEGER NOT NULL,
      approved_at TEXT,
      approved_by_user_id TEXT,
      collected_at TEXT,
      -- Shown on the approval screen so the person can tell their own laptop
      -- from a stranger's. Nullable: unknown is better than refused.
      device_label TEXT,
      device_platform TEXT,
      requested_ip TEXT
    )
  `;

  // Approval happens by code, but the *list* of machines waiting on an account
  // is read by user, and so is the audit question "what did I approve". Without
  // this the answer is a table scan that grows with every enrollment ever made.
  yield* sql`
    CREATE INDEX IF NOT EXISTS device_enrollments_by_user
      ON device_enrollments (approved_by_user_id, approved_at)
  `;
});
