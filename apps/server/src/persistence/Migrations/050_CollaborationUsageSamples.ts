import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * An append-only series of token observations, one row per report.
 *
 * `collaboration_member_usage` (migration 041) answers "how much has this member
 * spent in total" and nothing else: it holds one mutable high-water row per
 * thread, overwritten in place. That shape cannot answer when the tokens were
 * spent, on which model, or by which provider — every trend, every peak-hour
 * chart and every cost estimate needs a history that a running total has thrown
 * away. So this table is additive: 041 keeps its job, and this one records the
 * observations that 041 collapses.
 *
 * The token columns hold a DELTA, not a total. Providers report a cumulative
 * per-thread figure many times per turn, so storing what arrives would make
 * every chart count the same tokens once per report. The service subtracts the
 * previous high-water figure before inserting; see `recordUsage` for the reset
 * and compaction rules.
 *
 * There is no backfill. The deltas can only be derived from a series of
 * observations, and no observation before this migration was ever kept — only
 * the high-water totals survive, and those carry no time, model or provider.
 * The series therefore starts empty and begins at the next reported turn.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS collaboration_usage_samples (
      sample_id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      -- Null for a report that arrived outside a turn, which providers do emit.
      turn_id TEXT,
      observed_at TEXT NOT NULL,
      -- Raw provider ids ("codex" / "claudeAgent") and raw model ids. Null when
      -- the thread's model selection could not be resolved at capture time;
      -- those tokens are still counted, they are just unattributable and
      -- therefore unpriceable.
      provider TEXT,
      model TEXT,
      input_tokens INTEGER NOT NULL,
      cached_input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      reasoning_output_tokens INTEGER NOT NULL,
      total_tokens INTEGER NOT NULL
    )
  `;

  // "What did this workspace spend over this window" — the trend and the
  // hour-of-day histogram both scan this range.
  yield* sql`
    CREATE INDEX IF NOT EXISTS collaboration_usage_samples_window_idx
      ON collaboration_usage_samples (tenant_id, workspace_id, observed_at)
  `;

  // "Who spent it" — the leaderboard, and the per-member drill-down.
  yield* sql`
    CREATE INDEX IF NOT EXISTS collaboration_usage_samples_member_idx
      ON collaboration_usage_samples (tenant_id, workspace_id, user_id)
  `;

  // The delta baseline: the last figures a thread actually reported, as opposed
  // to `total_tokens`, which is the highest it has ever reached. The two have to
  // be kept apart. `total_tokens` may never go down — `buildMembers` sums it and
  // a member's total dropping would be nonsense — but after a compaction the
  // provider genuinely reports a lower figure, and subtracting from a high-water
  // mark would then silently discard every token spent climbing back to it.
  //
  // Added here rather than held in memory so a restart does not lose the
  // baseline: without it the first report after a restart would look like a
  // thread's whole history arriving at once.
  //
  // All nullable, with no SQL default, so NULL is legible: it means this row
  // predates the series and has no baseline yet. `recordUsage` adopts the next
  // report as the baseline and emits nothing for it, which costs one skipped
  // observation per existing thread instead of injecting months of accumulated
  // total as a single spike on the day this ships.
  yield* sql`ALTER TABLE collaboration_member_usage ADD COLUMN last_total_tokens INTEGER`;
  yield* sql`ALTER TABLE collaboration_member_usage ADD COLUMN last_input_tokens INTEGER`;
  yield* sql`ALTER TABLE collaboration_member_usage ADD COLUMN last_cached_input_tokens INTEGER`;
  yield* sql`ALTER TABLE collaboration_member_usage ADD COLUMN last_output_tokens INTEGER`;
  yield* sql`ALTER TABLE collaboration_member_usage ADD COLUMN last_reasoning_output_tokens INTEGER`;
});
