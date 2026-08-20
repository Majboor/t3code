import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * What was run on a box, when, by which turn, and how it went.
 *
 * A box is a machine an agent drives and never lives on. Everything else the
 * agent knows about a machine it learns by looking at the machine, which works
 * for the present tense and fails completely for the past one: the service
 * registry (migration 063) says what is listening *now*, and a command that ran
 * yesterday and exited leaves no trace anywhere. So every session started from
 * nothing. The agent rediscovered the box — which port the app is on, whether
 * the migration was ever applied, why the last deploy was abandoned halfway —
 * by re-running things to find out, which on a machine serving real traffic is
 * how the same mistake gets made twice.
 *
 * This table is the continuity. It is the one durable answer to "what happened
 * here", and it is deliberately the only verb that does not need the box to be
 * reachable — the question is asked most often when the machine is down, which
 * is exactly when a record that lived on the machine would be unavailable.
 *
 * Decisions worth keeping:
 *
 * `environment_id` and not a machine id, matching migrations 061 and 063. That
 * is the name the box keeps across reboots and the name traffic is routed by;
 * filing the journal under a second identity would mean two things to revoke
 * and two lists that could disagree about which box is which. Ownership and
 * revocation are reached through the binding to `account_machines`, so cutting
 * a machine off cuts this off with it and there is no second switch to forget.
 *
 * `refused` is a first-class outcome and not an absence of a row. A refusal is
 * the most interesting entry in the table: it is the record that an agent tried
 * to stop somebody's database and was stopped, and it is the only evidence that
 * exists if the next attempt succeeds with an override. Journalling only
 * successes would delete precisely the history worth having.
 *
 * `unmanaged` records that an override was used to act on a process T3 did not
 * start. One integer, and it is the audit line this whole feature is judged by:
 * "who killed the production API" has to be answerable afterwards, and an
 * override that left no different mark than an ordinary stop would not answer
 * it. Never null — the answer is always known at write time.
 *
 * `pid` is kept for a detached start so the process is findable after the
 * connection that started it is gone. It is a historical fact and not a claim of
 * ownership: pids are reused, and the registry — which correlates a pid against
 * a live start record — is the only thing that may decide anything is ours. A
 * reader who treats this column as permission has reintroduced the port-match
 * bug in a new place.
 *
 * `stdout` and `stderr` hold what the truncated reply in the turn did not. They
 * are bounded on the way in (`BOX_JOURNAL_HEAD_BYTES`), because an unbounded
 * write here is an agent running a build putting the whole build log into a
 * SQLite file on somebody's laptop. `output_bytes` is the *true* size before
 * bounding, so the row never implies it kept more than it did.
 *
 * `turn_id` is nullable because not every command comes from a turn — a person
 * at a shell has none — and a synthetic id for those would make "which turn did
 * this" unanswerable for the rows where it matters.
 *
 * No foreign keys, matching the rest of this schema: SQLite enforces none by
 * default, so a declared one is documentation wearing a guarantee's clothes.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS box_command_journal (
      entry_id TEXT PRIMARY KEY,
      -- The box, under the name it keeps across reboots (migration 061).
      environment_id TEXT NOT NULL,
      -- Whose behalf it ran on, as resolveAuthenticatedUserId reports it.
      user_id TEXT NOT NULL,
      -- The turn that asked, when a turn did. Null for a person at a shell.
      turn_id TEXT,
      -- "run" | "stop" | "logs" | "claim-port" | "release-port" | "services".
      -- Not a CHECK, matching the rest of this schema: a newer binary that
      -- learns another verb would otherwise write rows an older one refuses.
      verb TEXT NOT NULL,
      -- The command line for a run, else what the verb named.
      command TEXT,
      -- The registry's service id when the verb resolved to one.
      service_id TEXT,
      -- "ok" | "failed" | "refused" | "running".
      outcome TEXT NOT NULL,
      -- Set only on a refusal, and it is the reason decideBoxCommand gave.
      refusal_reason TEXT,
      exit_code INTEGER,
      signal TEXT,
      -- Kept so a detached process is findable once its connection is gone.
      -- Evidence, never permission: the registry decides ownership.
      pid INTEGER,
      -- 1 when an override let this act on a process T3 did not start.
      unmanaged INTEGER NOT NULL DEFAULT 0,
      stdout TEXT,
      stderr TEXT,
      -- The size before bounding, so the row cannot overstate what it kept.
      output_bytes INTEGER NOT NULL DEFAULT 0,
      started_at TEXT NOT NULL,
      -- Null while a detached process is still running.
      finished_at TEXT
    )
  `;

  // The read is always "what happened on this box recently", and it happens on
  // every history verb. Without this it is a scan of every command ever run on
  // every box the account owns.
  yield* sql`
    CREATE INDEX IF NOT EXISTS box_command_journal_recent
      ON box_command_journal (environment_id, started_at DESC)
  `;

  // Finding a detached start again is the other question this table answers, and
  // it is asked with nothing but a pid: the connection that started the process
  // is gone and the registry has forgotten it. Partial so the index stays the
  // size of what is actually running rather than of all history.
  yield* sql`
    CREATE INDEX IF NOT EXISTS box_command_journal_running
      ON box_command_journal (environment_id, pid)
      WHERE finished_at IS NULL
  `;
});
