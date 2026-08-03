import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { Effect, Layer, Option } from "effect";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  AuthUserProfileRecord,
  AuthUserProfileRepository,
  type AuthUserProfileRepositoryShape,
  GetAuthUserProfileBySubjectInput,
  UpsertAuthUserProfileInput,
} from "../Services/AuthUserProfiles.ts";

const makeAuthUserProfileRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertProfileRow = SqlSchema.void({
    Request: UpsertAuthUserProfileInput,
    execute: (input) =>
      sql`
        INSERT INTO auth_user_profiles (
          subject,
          display_name,
          avatar_initials,
          updated_at
        )
        VALUES (
          ${input.subject},
          ${input.displayName},
          ${input.avatarInitials},
          ${input.updatedAt}
        )
        ON CONFLICT (subject)
        DO UPDATE SET
          display_name = excluded.display_name,
          avatar_initials = excluded.avatar_initials,
          updated_at = excluded.updated_at
      `,
  });

  const getProfileRowBySubject = SqlSchema.findOneOption({
    Request: GetAuthUserProfileBySubjectInput,
    Result: AuthUserProfileRecord,
    execute: ({ subject }) =>
      sql`
        SELECT
          subject,
          display_name AS "displayName",
          avatar_initials AS "avatarInitials",
          updated_at AS "updatedAt"
        FROM auth_user_profiles
        WHERE subject = ${subject}
      `,
  });

  const upsert: AuthUserProfileRepositoryShape["upsert"] = (input) =>
    upsertProfileRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("AuthUserProfileRepository.upsert:query")),
    );

  const getBySubject: AuthUserProfileRepositoryShape["getBySubject"] = (input) =>
    getProfileRowBySubject(input).pipe(
      Effect.mapError(toPersistenceSqlError("AuthUserProfileRepository.getBySubject:query")),
      Effect.map((profile) => (Option.isSome(profile) ? Option.some(profile.value) : profile)),
    );

  return {
    upsert,
    getBySubject,
  } satisfies AuthUserProfileRepositoryShape;
});

export const AuthUserProfileRepositoryLive = Layer.effect(
  AuthUserProfileRepository,
  makeAuthUserProfileRepository,
);
