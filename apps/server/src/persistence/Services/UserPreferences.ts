import { Context, Option, Schema } from "effect";
import type { Effect } from "effect";

import type { AuthSessionRepositoryError } from "../Errors.ts";

export const OnboardingRole = Schema.Literals([
  "individual",
  "startup",
  "agency",
  "enterprise",
  "student",
]);
export type OnboardingRole = typeof OnboardingRole.Type;

export const OnboardingExperience = Schema.Literals(["new", "some", "experienced"]);
export type OnboardingExperience = typeof OnboardingExperience.Type;

export const OnboardingFocus = Schema.Literals(["backend", "frontend", "fullstack", "unsure"]);
export type OnboardingFocus = typeof OnboardingFocus.Type;

export const UserPreferencesRecord = Schema.Struct({
  subject: Schema.String,
  onboardingCompletedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  onboardingRole: Schema.NullOr(OnboardingRole),
  onboardingExperience: Schema.NullOr(OnboardingExperience),
  onboardingFocus: Schema.NullOr(OnboardingFocus),
  orgSettingsVisible: Schema.Boolean,
  vibeModeEnabled: Schema.Boolean,
  apiUsageTabVisible: Schema.Boolean,
  /** Gates whether a new note/DM shows an interrupting toast at all; either way it still lands in the normal activity/inbox view. */
  notificationPopupsEnabled: Schema.Boolean,
  updatedAt: Schema.DateTimeUtcFromString,
});
export type UserPreferencesRecord = typeof UserPreferencesRecord.Type;

export const UpsertUserPreferencesInput = UserPreferencesRecord;
export type UpsertUserPreferencesInput = typeof UpsertUserPreferencesInput.Type;

export const GetUserPreferencesBySubjectInput = Schema.Struct({
  subject: Schema.String,
});
export type GetUserPreferencesBySubjectInput = typeof GetUserPreferencesBySubjectInput.Type;

export interface UserPreferencesRepositoryShape {
  readonly upsert: (
    input: UpsertUserPreferencesInput,
  ) => Effect.Effect<void, AuthSessionRepositoryError>;
  readonly getBySubject: (
    input: GetUserPreferencesBySubjectInput,
  ) => Effect.Effect<Option.Option<UserPreferencesRecord>, AuthSessionRepositoryError>;
}

export class UserPreferencesRepository extends Context.Service<
  UserPreferencesRepository,
  UserPreferencesRepositoryShape
>()("t3/persistence/Services/UserPreferences/UserPreferencesRepository") {}
