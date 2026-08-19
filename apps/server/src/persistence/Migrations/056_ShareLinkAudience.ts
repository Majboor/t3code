import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Who a share link is for.
 *
 * Until now every link was addressed to nobody: holding the URL was the whole
 * of the access control, and a workspace link that reached one wrong inbox
 * handed that inbox a seat in the workspace. `audience` is the column that
 * lets a link name its recipients instead, and `share_link_recipients` is the
 * list it names.
 *
 * Three decisions worth keeping:
 *
 * The default is `'public'`, which is what every existing row already is. A
 * default of `'restricted'` would be safer in the abstract and catastrophic
 * here — every link in flight would stop working, and the people holding them
 * would get the same "not available" that a revoked link gives, with no way to
 * tell the difference. Widening is the migration's job; narrowing is the
 * owner's, one link at a time.
 *
 * The recipients are a table rather than a JSON column on `share_links`,
 * because the check at redemption is "is this one address on the list" and
 * that has to be an indexed equality test on a row, not a parse of a blob that
 * grows with every person added. The primary key is (link_id, email), which
 * makes the membership test a single key probe, makes listing one link's
 * recipients the leftmost prefix of that same key, and makes adding the same
 * address twice impossible rather than merely tidy.
 *
 * Emails are stored already normalised — trimmed and lower-cased by the
 * service — so that the comparison is a plain equality and never a collation
 * question. `Alice@Example.com` and `alice@example.com` are one person, and
 * deciding that at write time means the redemption path cannot get it wrong.
 *
 * No foreign key to `share_links`, matching `share_link_views` and for a
 * related reason: this table is written in the same transaction as the link
 * and read only by link id, and a link is never deleted today. Adding the
 * constraint would buy nothing and would make the eventual "delete a link"
 * feature decide the fate of these rows inside a schema change rather than in
 * the service where it belongs.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const columns = yield* sql`PRAGMA table_info(share_links)`;
  const alreadyThere = columns.some((column) => (column as { name?: string }).name === "audience");
  if (!alreadyThere) {
    // "public" | "restricted". Not a CHECK, matching the `scope` column two
    // migrations back: a build that learns a third audience would otherwise
    // write rows an older binary refuses, and the service validates on the way
    // in either way.
    yield* sql`ALTER TABLE share_links ADD COLUMN audience TEXT NOT NULL DEFAULT 'public'`;
  }

  yield* sql`
    CREATE TABLE IF NOT EXISTS share_link_recipients (
      link_id TEXT NOT NULL,
      -- Already trimmed and lower-cased. The service normalises on write so
      -- that redemption compares two strings and never two spellings.
      email TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (link_id, email)
    )
  `;
});
