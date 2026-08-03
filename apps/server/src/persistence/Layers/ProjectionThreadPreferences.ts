import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { Effect, Layer } from "effect";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  ListProjectionThreadPreferencesByUserInput,
  ProjectionThreadPreference,
  ProjectionThreadPreferenceRepository,
  type ProjectionThreadPreferenceRepositoryShape,
  UpsertProjectionThreadPreferenceInput,
} from "../Services/ProjectionThreadPreferences.ts";

const makeProjectionThreadPreferenceRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertPreferenceRow = SqlSchema.void({
    Request: UpsertProjectionThreadPreferenceInput,
    execute: (input) =>
      sql`
        INSERT INTO projection_thread_preferences (
          tenant_id,
          user_id,
          thread_id,
          favorite,
          updated_at
        )
        VALUES (
          ${input.tenantId},
          ${input.userId},
          ${input.threadId},
          ${input.favorite},
          ${input.updatedAt}
        )
        ON CONFLICT (tenant_id, user_id, thread_id)
        DO UPDATE SET
          favorite = excluded.favorite,
          updated_at = excluded.updated_at
      `,
  });

  const listPreferenceRowsByUser = SqlSchema.findAll({
    Request: ListProjectionThreadPreferencesByUserInput,
    Result: ProjectionThreadPreference,
    execute: ({ tenantId, userId }) =>
      sql`
        SELECT
          tenant_id AS "tenantId",
          user_id AS "userId",
          thread_id AS "threadId",
          favorite,
          updated_at AS "updatedAt"
        FROM projection_thread_preferences
        WHERE tenant_id = ${tenantId}
          AND user_id = ${userId}
      `,
  });

  const upsert: ProjectionThreadPreferenceRepositoryShape["upsert"] = (input) =>
    upsertPreferenceRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionThreadPreferenceRepository.upsert:query")),
    );

  const listByUser: ProjectionThreadPreferenceRepositoryShape["listByUser"] = (input) =>
    listPreferenceRowsByUser(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadPreferenceRepository.listByUser:query"),
      ),
    );

  return {
    upsert,
    listByUser,
  } satisfies ProjectionThreadPreferenceRepositoryShape;
});

export const ProjectionThreadPreferenceRepositoryLive = Layer.effect(
  ProjectionThreadPreferenceRepository,
  makeProjectionThreadPreferenceRepository,
);
