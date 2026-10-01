import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * What a project is, stored rather than guessed every time somebody looks.
 *
 * A project's nature has been implied so far by things that have nothing to do
 * with each other: whether cloud sync happens to be on, whether the server calls
 * itself `this-server` or `paired-environment`, whether a share link was ever
 * sent. Each of those is true of a project without being *about* the project, so
 * the answer to "is this on my laptop or on LogicPacks" was reassembled from
 * scratch by every surface that needed it, and no two of them reassembled it the
 * same way. This column is the answer written down once. See `ProjectKind` in
 * packages/contracts/src/orchestration.ts for what the four names mean.
 *
 * Nullable, with no backfill and no default, for the reason migration 062 gave
 * `machine_role`: a value written into every existing row would be
 * indistinguishable from a kind somebody actually chose, and the next slice —
 * the one that starts *setting* kinds — would have no way to tell a project
 * whose kind is known from one whose kind was assumed on its behalf. `NULL` is
 * the honest state and `resolveProjectKind` is the single place that says what
 * it means. Nullable is also what keeps this an `ALTER TABLE ... ADD COLUMN`,
 * which SQLite performs without rewriting the table.
 *
 * No `CHECK` constraint, matching `machine_role` and `status` elsewhere: a newer
 * binary that learns a fifth kind would otherwise write rows an older one
 * refuses to read, and this column rides along on the projection snapshot — the
 * payload that paints the project list, which is close to the last thing that
 * should ever fail closed. `parseProjectKind` narrows anything unrecognised to
 * `null` on the way out instead.
 *
 * Note for whoever writes the upsert next: `projection_projects` is inserted
 * into with named columns, and it must stay that way. An `ALTER TABLE` appends
 * at the end of the row, so a positional insert starts filling the wrong columns
 * the moment a migration like this one runs — that is how invite acceptance
 * broke once (see the comment in apps/server/src/persistence/Layers/Tenancy.ts).
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Guarded rather than `Effect.ignore`d: a swallowed error hides a genuinely
  // broken ALTER just as well as it hides the duplicate-column one, and this
  // column is the whole point of the migration.
  const columns = yield* sql`PRAGMA table_info(projection_projects)`;
  const columnNames = new Set(
    columns.map((column) => (column as { readonly name?: string }).name).filter(Boolean),
  );

  // "local" | "hosted" | "self-hosted" | "joined", or NULL for every project
  // that was created before anybody was asked.
  if (!columnNames.has("project_kind")) {
    yield* sql`ALTER TABLE projection_projects ADD COLUMN project_kind TEXT`;
  }
});
