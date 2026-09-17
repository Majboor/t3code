import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { Effect, Layer, Option, Schema } from "effect";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  GetUserPreferencesBySubjectInput,
  OnboardingExperience,
  OnboardingFocus,
  OnboardingRole,
  UpsertUserPreferencesInput,
  type UserPreferencesRecord,
  UserPreferencesRepository,
  type UserPreferencesRepositoryShape,
} from "../Services/UserPreferences.ts";

// SQLite has no boolean type; these columns are 0/1 and are widened back to
// real booleans in `toUserPreferences` so no caller ever has to know that.
const UserPreferencesRow = Schema.Struct({
  subject: Schema.String,
  onboardingCompletedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  onboardingRole: Schema.NullOr(OnboardingRole),
  onboardingExperience: Schema.NullOr(OnboardingExperience),
  onboardingFocus: Schema.NullOr(OnboardingFocus),
  orgSettingsVisible: Schema.Int,
  vibeModeEnabled: Schema.Int,
  apiUsageTabVisible: Schema.Int,
  updatedAt: Schema.DateTimeUtcFromString,
});

function toUserPreferences(row: typeof UserPreferencesRow.Type): UserPreferencesRecord {
  return {
    subject: row.subject,
    onboardingCompletedAt: row.onboardingCompletedAt,
    onboardingRole: row.onboardingRole,
    onboardingExperience: row.onboardingExperience,
    onboardingFocus: row.onboardingFocus,
    orgSettingsVisible: row.orgSettingsVisible !== 0,
    vibeModeEnabled: row.vibeModeEnabled !== 0,
    apiUsageTabVisible: row.apiUsageTabVisible !== 0,
    updatedAt: row.updatedAt,
  };
}

const makeUserPreferencesRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertPreferencesRow = SqlSchema.void({
    Request: UpsertUserPreferencesInput,
    execute: (input) =>
      sql`
        INSERT INTO user_preferences (
          subject,
          onboarding_completed_at,
          onboarding_role,
          onboarding_experience,
          onboarding_focus,
          org_settings_visible,
          vibe_mode_enabled,
          api_usage_tab_visible,
          updated_at
        )
        VALUES (
          ${input.subject},
          ${input.onboardingCompletedAt},
          ${input.onboardingRole},
          ${input.onboardingExperience},
          ${input.onboardingFocus},
          ${input.orgSettingsVisible ? 1 : 0},
          ${input.vibeModeEnabled ? 1 : 0},
          ${input.apiUsageTabVisible ? 1 : 0},
          ${input.updatedAt}
        )
        ON CONFLICT (subject)
        DO UPDATE SET
          onboarding_completed_at = excluded.onboarding_completed_at,
          onboarding_role = excluded.onboarding_role,
          onboarding_experience = excluded.onboarding_experience,
          onboarding_focus = excluded.onboarding_focus,
          org_settings_visible = excluded.org_settings_visible,
          vibe_mode_enabled = excluded.vibe_mode_enabled,
          api_usage_tab_visible = excluded.api_usage_tab_visible,
          updated_at = excluded.updated_at
      `,
  });

  const getPreferencesRowBySubject = SqlSchema.findOneOption({
    Request: GetUserPreferencesBySubjectInput,
    Result: UserPreferencesRow,
    execute: ({ subject }) =>
      sql`
        SELECT
          subject,
          onboarding_completed_at AS "onboardingCompletedAt",
          onboarding_role AS "onboardingRole",
          onboarding_experience AS "onboardingExperience",
          onboarding_focus AS "onboardingFocus",
          org_settings_visible AS "orgSettingsVisible",
          vibe_mode_enabled AS "vibeModeEnabled",
          api_usage_tab_visible AS "apiUsageTabVisible",
          updated_at AS "updatedAt"
        FROM user_preferences
        WHERE subject = ${subject}
      `,
  });

  const upsert: UserPreferencesRepositoryShape["upsert"] = (input) =>
    upsertPreferencesRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("UserPreferencesRepository.upsert:query")),
    );

  const getBySubject: UserPreferencesRepositoryShape["getBySubject"] = (input) =>
    getPreferencesRowBySubject(input).pipe(
      Effect.mapError(toPersistenceSqlError("UserPreferencesRepository.getBySubject:query")),
      Effect.map(Option.map(toUserPreferences)),
    );

  return {
    upsert,
    getBySubject,
  } satisfies UserPreferencesRepositoryShape;
});

export const UserPreferencesRepositoryLive = Layer.effect(
  UserPreferencesRepository,
  makeUserPreferencesRepository,
);
