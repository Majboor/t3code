import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { Effect, Layer, Schema } from "effect";

import {
  AnalyticsStreamId,
  DeploymentId,
  DeploymentStatus,
  DeployRunId,
  DeployTargetId,
  ProjectId,
} from "@t3tools/contracts";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  DeploymentRepository,
  type DeploymentRepositoryShape,
  FindDeploymentInput,
  GetDeploymentInput,
  ListDeploymentsInput,
  UpsertDeploymentInput,
} from "../Services/Deployments.ts";

const DeploymentRow = Schema.Struct({
  id: DeploymentId,
  projectId: ProjectId,
  targetId: DeployTargetId,
  name: Schema.String,
  url: Schema.NullOr(Schema.String),
  status: DeploymentStatus,
  lastRunId: Schema.NullOr(DeployRunId),
  analyticsStreamIds: Schema.fromJsonString(Schema.Array(AnalyticsStreamId)),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  archivedAt: Schema.NullOr(Schema.String),
});

const DEPLOYMENT_COLUMNS = `id,
  project_id AS "projectId",
  target_id AS "targetId",
  name,
  url,
  status,
  last_run_id AS "lastRunId",
  analytics_stream_ids_json AS "analyticsStreamIds",
  created_at AS "createdAt",
  updated_at AS "updatedAt",
  archived_at AS "archivedAt"`;

const makeDeploymentRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertRow = SqlSchema.void({
    Request: UpsertDeploymentInput,
    execute: (input) =>
      sql`
        INSERT INTO deployments (
          id,
          project_id,
          target_id,
          name,
          url,
          status,
          last_run_id,
          analytics_stream_ids_json,
          created_at,
          updated_at,
          archived_at
        )
        VALUES (
          ${input.id},
          ${input.projectId},
          ${input.targetId},
          ${input.name},
          ${input.url},
          ${input.status},
          ${input.lastRunId},
          ${JSON.stringify(input.analyticsStreamIds)},
          ${input.createdAt},
          ${input.updatedAt},
          ${input.archivedAt}
        )
        ON CONFLICT (id)
        DO UPDATE SET
          name = excluded.name,
          url = excluded.url,
          status = excluded.status,
          last_run_id = excluded.last_run_id,
          analytics_stream_ids_json = excluded.analytics_stream_ids_json,
          updated_at = excluded.updated_at,
          archived_at = excluded.archived_at
      `,
  });

  const listRows = SqlSchema.findAll({
    Request: ListDeploymentsInput,
    Result: DeploymentRow,
    execute: ({ projectId, targetId }) => {
      if (targetId !== undefined) {
        return sql`SELECT ${sql.literal(DEPLOYMENT_COLUMNS)} FROM deployments
              WHERE archived_at IS NULL AND target_id = ${targetId} ORDER BY created_at ASC`;
      }
      if (projectId !== undefined) {
        return sql`SELECT ${sql.literal(DEPLOYMENT_COLUMNS)} FROM deployments
              WHERE archived_at IS NULL AND project_id = ${projectId} ORDER BY created_at ASC`;
      }
      return sql`SELECT ${sql.literal(DEPLOYMENT_COLUMNS)} FROM deployments
            WHERE archived_at IS NULL ORDER BY created_at ASC`;
    },
  });

  // Archived rows are still reachable by id, so an update that resurrects one
  // has something to read first.
  const getRow = SqlSchema.findOneOption({
    Request: GetDeploymentInput,
    Result: DeploymentRow,
    execute: ({ deploymentId }) =>
      sql`SELECT ${sql.literal(DEPLOYMENT_COLUMNS)} FROM deployments WHERE id = ${deploymentId}`,
  });

  const findRow = SqlSchema.findOneOption({
    Request: FindDeploymentInput,
    Result: DeploymentRow,
    execute: ({ projectId, name }) =>
      sql`SELECT ${sql.literal(DEPLOYMENT_COLUMNS)} FROM deployments
          WHERE archived_at IS NULL AND project_id = ${projectId} AND name = ${name}`,
  });

  return {
    upsert: (input) =>
      upsertRow(input).pipe(
        Effect.mapError(toPersistenceSqlError("DeploymentRepository.upsert:query")),
      ),
    list: (input) =>
      listRows(input).pipe(
        Effect.mapError(toPersistenceSqlError("DeploymentRepository.list:query")),
      ),
    get: (input) =>
      getRow(input).pipe(Effect.mapError(toPersistenceSqlError("DeploymentRepository.get:query"))),
    find: (input) =>
      findRow(input).pipe(
        Effect.mapError(toPersistenceSqlError("DeploymentRepository.find:query")),
      ),
  } satisfies DeploymentRepositoryShape;
});

export const DeploymentRepositoryLive: Layer.Layer<
  DeploymentRepository,
  never,
  SqlClient.SqlClient
> = Layer.effect(DeploymentRepository, makeDeploymentRepository);
