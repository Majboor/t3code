import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * What T3 started on this machine, and which ports it has spoken for.
 *
 * An agent handed a shell has no record of the machine it is on. It binds a
 * port that is taken, or clears one it believes is stale — and the process it
 * cleared was an unrelated production service that happened to be in the way.
 * On the host this was written for, `days-tracker-api`, `chase-s3` and
 * `nas-buffer` all run beside whatever T3 deploys.
 *
 * Two tables and not one, because the two facts have different lifetimes,
 * different authors and different consequences if believed wrongly.
 *
 * `environment_services` is only ever what **we started**. Nothing observed
 * from the machine is written here, ever. That is the invariant the whole
 * feature rests on: a row in this table is what licenses stopping something, so
 * a row that arrived from a port scan would be a licence to kill a stranger's
 * process. What is listening is read live from the machine on every request and
 * deliberately not stored — a cached socket list is a list of yesterday's
 * truths, and the reconciler needs the two sides to be observations of the same
 * instant.
 *
 * `pid` is `NOT NULL` for the same reason. Correlation with a live socket is by
 * process, never by port: our dev server dies, something else binds 3000, and a
 * port-keyed join would hand the agent our name for somebody else's process. A
 * row that cannot name a pid cannot support that correlation and has no business
 * existing.
 *
 * `heartbeat_at` is what makes the table safe to read after a crash. Nothing
 * here is swept by a timer — the service confirms the pid on each read and
 * refreshes this, and a row nobody has confirmed inside the TTL stops counting
 * as running. A stale "running" that never clears is a worse guide than an empty
 * table, because it is the one an agent will trust.
 *
 * `stopped_at` rather than a delete, matching every other table here. "We
 * started this and then stopped it" is the answer somebody wants after the fact,
 * and it also keeps a stopped service from quietly reappearing if its pid is
 * recycled onto a new process.
 *
 * The unique index is partial — one live record per port, but any number of
 * historical ones. Without `WHERE stopped_at IS NULL` a port could only ever be
 * used once in the life of the database.
 *
 * `environment_port_claims` is a reservation taken *before* starting anything,
 * so two turns racing for the same port collide in a table instead of in the
 * process table. `expires_at` is stored rather than derived: a claim is a
 * promise about the future, and how long the promise runs belongs to the claim
 * — a twenty-minute build and a dev server that binds in a second should not
 * share a deadline. There is no null: a claim with no expiry survives the crash
 * that orphaned it and holds a port forever.
 *
 * `port` is the primary key and not a surrogate. A port can be reserved by
 * exactly one person at a time; that is the entire point, and making it the key
 * means the database enforces it rather than the code remembering to.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS environment_services (
      service_id TEXT PRIMARY KEY,
      -- Which machine this is running on, so a workspace spanning several
      -- environments does not report one machine's ports as another's.
      environment_id TEXT NOT NULL,
      name TEXT NOT NULL,
      port INTEGER NOT NULL,
      -- The process we spawned. NOT NULL: see above — without it, ownership
      -- could only be inferred from the port, which is exactly the mistake.
      pid INTEGER NOT NULL,
      command TEXT NOT NULL,
      -- The account it was started for. An agent has none of its own.
      started_by TEXT NOT NULL,
      started_at TEXT NOT NULL,
      -- Last time anything confirmed the pid still exists. The TTL backstop for
      -- the case where T3 itself was killed and nobody has looked since.
      heartbeat_at TEXT NOT NULL,
      stopped_at TEXT
    )
  `;

  // One live service per port per machine. Partial, so the history of a port
  // stays available while only the current holder is constrained.
  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS environment_services_live_port
      ON environment_services (environment_id, port)
      WHERE stopped_at IS NULL
  `;

  // Every read is "what is live on this machine", on every page render and
  // before every start.
  yield* sql`
    CREATE INDEX IF NOT EXISTS environment_services_live
      ON environment_services (environment_id, stopped_at, heartbeat_at)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS environment_port_claims (
      environment_id TEXT NOT NULL,
      port INTEGER NOT NULL,
      claimed_by TEXT NOT NULL,
      -- In words a stranger can act on: the reader is whoever wanted the port.
      purpose TEXT NOT NULL,
      claimed_at TEXT NOT NULL,
      -- Never null. A reservation with no deadline outlives the crash that
      -- orphaned it and holds the port for good.
      expires_at TEXT NOT NULL,
      PRIMARY KEY (environment_id, port)
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS environment_port_claims_live
      ON environment_port_claims (environment_id, expires_at)
  `;
});
