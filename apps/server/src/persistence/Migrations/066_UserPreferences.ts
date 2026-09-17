import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * One row per user: the raw onboarding answers (kept for the record; null
 * when skipped) plus the three settings onboarding only ever sets an initial
 * default for — every one of them stays independently toggleable in Settings
 * afterward, regardless of what (if anything) was answered at signup.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS user_preferences (
      subject TEXT PRIMARY KEY,
      onboarding_completed_at TEXT,
      onboarding_role TEXT,
      onboarding_experience TEXT,
      onboarding_focus TEXT,
      org_settings_visible INTEGER NOT NULL DEFAULT 0,
      vibe_mode_enabled INTEGER NOT NULL DEFAULT 0,
      api_usage_tab_visible INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL
    )
  `;
});
