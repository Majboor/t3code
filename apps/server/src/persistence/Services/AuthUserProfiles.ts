import { Context, Option, Schema } from "effect";
import type { Effect } from "effect";

import type { AuthSessionRepositoryError } from "../Errors.ts";

export const AuthUserProfileRecord = Schema.Struct({
  subject: Schema.String,
  displayName: Schema.String,
  avatarInitials: Schema.String,
  avatarDataUrl: Schema.NullOr(Schema.String),
  updatedAt: Schema.DateTimeUtcFromString,
});
export type AuthUserProfileRecord = typeof AuthUserProfileRecord.Type;

export const UpsertAuthUserProfileInput = AuthUserProfileRecord;
export type UpsertAuthUserProfileInput = typeof UpsertAuthUserProfileInput.Type;

export const GetAuthUserProfileBySubjectInput = Schema.Struct({
  subject: Schema.String,
});
export type GetAuthUserProfileBySubjectInput = typeof GetAuthUserProfileBySubjectInput.Type;

export interface AuthUserProfileRepositoryShape {
  readonly upsert: (
    input: UpsertAuthUserProfileInput,
  ) => Effect.Effect<void, AuthSessionRepositoryError>;
  readonly getBySubject: (
    input: GetAuthUserProfileBySubjectInput,
  ) => Effect.Effect<Option.Option<AuthUserProfileRecord>, AuthSessionRepositoryError>;
}

export class AuthUserProfileRepository extends Context.Service<
  AuthUserProfileRepository,
  AuthUserProfileRepositoryShape
>()("t3/persistence/Services/AuthUserProfiles/AuthUserProfileRepository") {}
