import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * The name an environment keeps across reboots.
 *
 * A saved environment in the browser is a row pointing at a URL. When that URL
 * is a Cloudflare quick tunnel it changes on every restart, so every saved
 * environment dies the moment the laptop reboots — the record survives and the
 * thing it names does not. An environment that dials *out* has no URL at all,
 * which fixes the reachability problem and creates a naming one: the hub has to
 * be able to say "this connection is the same environment as yesterday's", and
 * a TCP connection is the one thing that definitely is not.
 *
 * This table is that name. The environment declares an id it has generated once
 * and kept on disk; the hub records which account and which machine that id
 * belongs to. Traffic is routed by the id, so a reconnecting environment lands
 * back on the browser's existing saved record instead of appearing as a
 * stranger with all its threads pointing at nothing.
 *
 * Decisions worth keeping:
 *
 * `environment_id` is the primary key, and it is *claimed* rather than issued.
 * That inverts the usual trust direction, so it needs the guard: a claim is only
 * honoured if the id is unclaimed or already belongs to the claiming account
 * (`decideRelayBinding`). Without the row, the check has nothing to compare
 * against and the first machine to guess an id inherits somebody else's
 * routing entry — the browser would keep talking to the environment it always
 * has and reach a different computer.
 *
 * `machine_id` and not a session id. Sessions are re-issued: a machine that
 * re-enrols gets a new one, and binding to it would break the reconnect on the
 * one path — re-enrolment — where keeping the environment matters most. The
 * machine row in `account_machines` is the durable thing, and it already
 * carries the session, so revocation still reaches this through one hop rather
 * than through a second copy of the credential. There is deliberately no
 * `revoked_at` column here: a second revocation flag would be a second thing to
 * forget to set, and the answer to "may this environment carry traffic" must
 * have exactly one source, which is whether its machine is still in
 * `account_machines`.
 *
 * `user_id` is denormalised out of the machine row on purpose. Listing "my
 * environments" is the commonest read, it happens on every load of the
 * environments screen, and joining to `account_machines` for the owner would
 * make the answer depend on a row that revocation is allowed to change
 * underneath it. Filed under what `resolveAuthenticatedUserId` returns, like
 * every other ownership column in this schema.
 *
 * No foreign key to `account_machines`, matching the rest of this schema:
 * SQLite enforces none by default, so a declared one is documentation wearing a
 * guarantee's clothes.
 *
 * `last_connected_at` is a floor, not a heartbeat. Liveness is decided in
 * memory from a recent ping/pong exchange (`decideRelayLink`) and is never read
 * from here — a durable "connected" flag is exactly the stale green dot this
 * feature is supposed to stop showing. What this column answers is the other
 * question, the one a person actually asks of a list: which of these have I not
 * seen in a month.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS environment_relay_bindings (
      -- Claimed by the environment and kept on its disk. See the note above for
      -- why a claimed key is safe only alongside the ownership check.
      environment_id TEXT PRIMARY KEY,
      -- Whose environment this is, as resolveAuthenticatedUserId reports it.
      user_id TEXT NOT NULL,
      -- The machine in account_machines holding the credential it dials with.
      -- Revoking that machine is what ends this binding's usefulness.
      machine_id TEXT NOT NULL,
      -- What to call it in a list. Nullable: an unnamed environment still routes.
      label TEXT,
      first_bound_at TEXT NOT NULL,
      -- A floor. Liveness lives in memory, never here.
      last_connected_at TEXT NOT NULL
    )
  `;

  // The list is always "my environments, most recently seen first". Without
  // this it is a scan of every environment every account has ever dialled in.
  yield* sql`
    CREATE INDEX IF NOT EXISTS environment_relay_bindings_by_user
      ON environment_relay_bindings (user_id, last_connected_at DESC)
  `;

  // Revocation asks the opposite question — "what did this machine own" — and
  // asks it on the one path where a scan would be worst: the person pressing
  // Disconnect is usually doing it because the hardware is already gone.
  yield* sql`
    CREATE INDEX IF NOT EXISTS environment_relay_bindings_by_machine
      ON environment_relay_bindings (machine_id)
  `;
});
