import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Who approved a device, in the terms a session is actually minted from.
 *
 * `device_enrollments` records `approved_by_user_id`, which is the right answer
 * to "whose machine is this" and the wrong answer to "what session do I issue
 * when the machine collects". A session in this server is defined entirely by
 * its *subject* and *role* — every user id downstream is derived from the
 * subject, never the other way round — and that derivation is deliberately not
 * invertible: `local-user:local:<uuid>` can be reversed, `auth:<subject>` can be
 * reversed by accident, and a Supabase-backed session cannot be reversed at all.
 * Reconstructing a subject from a user id would mean re-implementing a private
 * mapping from `Layers/ServerAuth.ts` in a second place, where it would go stale
 * silently and hand somebody a session as the wrong person.
 *
 * So approval writes down what it actually had in its hands: the subject and
 * role of the browser session whose owner clicked approve. Collection replays
 * exactly that and nothing wider, which is the property that matters — the
 * machine can never end up with more than the person who approved it had.
 *
 * Both columns are nullable and neither is backfilled. A row written before this
 * migration is a pending enrollment from the last ten minutes at most; if one is
 * approved without a subject, collection refuses rather than guessing. Nullable
 * also keeps this an `ALTER TABLE ... ADD COLUMN`, which SQLite does without
 * rewriting the table.
 *
 * They are not stored in place of `approved_by_user_id`. That column is what the
 * `device_enrollments_by_user` index is for — "what machines did I approve" is a
 * question about a person, not about a session subject — and the two answers are
 * needed for different jobs.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const columns = yield* sql`PRAGMA table_info(device_enrollments)`;
  const present = new Set(
    columns.map((column) => (column as { readonly name?: string }).name).filter(Boolean),
  );

  if (!present.has("approved_by_subject")) {
    yield* sql`ALTER TABLE device_enrollments ADD COLUMN approved_by_subject TEXT`;
  }

  // "owner" | "client". Not a CHECK, for the same reason `status` is not one on
  // the table this extends: an older binary must still be able to read a row a
  // newer one wrote.
  if (!present.has("approved_by_role")) {
    yield* sql`ALTER TABLE device_enrollments ADD COLUMN approved_by_role TEXT`;
  }
});
