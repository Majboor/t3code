import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * What a connected machine is for, as opposed to merely that it is connected.
 *
 * Migration 060 gave an account a list of its machines. Every row on that list
 * describes the same kind of thing — somewhere the agent works — because that
 * was the only kind there was. It is not: a box that runs and serves things,
 * holds ports and is *driven* by an agent working elsewhere is a machine an
 * account connects too, and it is not a workspace by any reading. Nothing
 * distinguished them, so connecting a deploy target looked identical to
 * connecting a laptop, and led to the same place: "connect your Claude account
 * to start working here" on a box that will never run a turn.
 *
 * Two nullable columns, because the answer has to survive a gap between two
 * requests made by two different parties. The person answers at `approve`, in a
 * browser, holding a session. The machine finds out at `collect`, minutes later,
 * holding only a code. There is nowhere else to keep it: the code is spent
 * immediately afterwards and the enrollment row is the only thing both requests
 * can see.
 *
 * `NULL` is the load-bearing value in both. Every enrollment approved before
 * this migration, and every row already in `account_machines`, is a workspace
 * host — that is what all of them are — and `resolveMachineRole` is the one
 * place that says so. No backfill: a default written into the column would be
 * indistinguishable from a role somebody chose, and would have to be
 * re-interpreted anyway the day a third role exists. Nullable is also what keeps
 * both of these an `ALTER TABLE ... ADD COLUMN`, which SQLite performs without
 * rewriting the table.
 *
 * No `CHECK` constraint, matching `status` on the table this extends and
 * `approved_by_role` beside it: a newer binary that learns a third role would
 * otherwise write rows an older one refuses to read, and this column is read on
 * the path that lists an account's machines — the last screen that should ever
 * fail closed. Anything unrecognised resolves to `workspace-host`, which is the
 * role that *asks* for a provider account, so an unreadable value costs somebody
 * a prompt rather than silently exempting a machine from one.
 *
 * Deliberately not a permission column, and it must never become one. Both roles
 * hold an ordinary session with ordinary reach; the role decides what the
 * product *asks* a person for, not what the credential can do. The enforcement
 * that matters for turns is `decideProviderAccount`, which is unchanged and
 * still refuses a turn with no credential behind it whatever kind of machine it
 * was dispatched from.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const readColumns = (table: "device_enrollments" | "account_machines") =>
    Effect.gen(function* () {
      const columns =
        table === "device_enrollments"
          ? yield* sql`PRAGMA table_info(device_enrollments)`
          : yield* sql`PRAGMA table_info(account_machines)`;
      return new Set(
        columns.map((column) => (column as { readonly name?: string }).name).filter(Boolean),
      );
    });

  // "workspace-host" | "runner". What the approving person said this machine is
  // for, recorded at the one moment they are present to say it.
  const enrollmentColumns = yield* readColumns("device_enrollments");
  if (!enrollmentColumns.has("machine_role")) {
    yield* sql`ALTER TABLE device_enrollments ADD COLUMN machine_role TEXT`;
  }

  // The same answer, copied onto the machine at collect rather than joined back
  // to the enrollment — for the reason `label` and `platform` are copied there:
  // the enrollment row is a spent credential's audit trail and may be pruned,
  // while the machine list has to keep describing the machine long afterwards.
  const machineColumns = yield* readColumns("account_machines");
  if (!machineColumns.has("role")) {
    yield* sql`ALTER TABLE account_machines ADD COLUMN role TEXT`;
  }
});
