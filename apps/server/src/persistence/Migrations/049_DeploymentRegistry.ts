import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Records that a deployment exists.
 *
 * `deploy_targets` says how a project ships and `deploy_runs` says how the last
 * shipping went — status, exit code, output. Neither says what is *live*. Once a
 * run succeeds nothing in the database represents the thing it produced: no URL
 * to open, no way to ask which streams it reports to, no way to tell a target
 * that has never shipped from one serving traffic right now.
 *
 * A run is an event and a deployment is a state, so this is a table rather than
 * another column on `deploy_runs`. Re-running a target updates the deployment it
 * already has; it does not append a second live thing at the same URL.
 *
 * `analytics_stream_ids_json` is what connects a deployment to the numbers it
 * reports. It holds ids rather than names because a stream can be renamed and
 * the link should survive it. The list is stored on the deployment rather than
 * in a join table: it is read whole every time it is read at all, and never
 * queried from the stream side without also wanting the deployment.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS deployments (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      target_id TEXT NOT NULL,
      name TEXT NOT NULL,
      url TEXT,
      status TEXT NOT NULL,
      last_run_id TEXT,
      analytics_stream_ids_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      archived_at TEXT
    )
  `;

  // A deployment is addressed by project and name — that pair is what an agent
  // has to go on when it is told "update the staging deployment" — so it has to
  // resolve to exactly one row.
  //
  // Partial, because the uniqueness that matters is among the live ones. A plain
  // unique index would let archiving a deployment burn its name forever: nothing
  // deletes the row, so registering "staging" again after retiring it would fail
  // on a constraint instead of opening a new deployment.
  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS deployments_project_name_idx
      ON deployments (project_id, name)
      WHERE archived_at IS NULL
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS deployments_project_idx
      ON deployments (project_id)
  `;

  // "What did this target put live?" is asked on every deploy, to decide whether
  // to update a deployment or open a new one.
  yield* sql`
    CREATE INDEX IF NOT EXISTS deployments_target_idx
      ON deployments (target_id)
  `;
});
