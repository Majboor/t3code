import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { Effect, Layer, Option, Schema } from "effect";

import {
  type DeployRun,
  DeployRunId,
  DeployRunStatus,
  DeploySshConfig,
  DeployTarget,
  DeployTargetId,
  DeployTargetKind,
  ProjectId,
  TenantId,
} from "@t3tools/contracts";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  DeployRepository,
  type DeployRepositoryShape,
  GetDeployRunInput,
  GetDeployTargetInput,
  ListDeployRunsInput,
  ListDeployTargetsInput,
  UpsertDeployRunInput,
  UpsertDeployTargetInput,
} from "../Services/DeployTargets.ts";

const DeployTargetRow = Schema.Struct({
  id: DeployTargetId,
  projectId: ProjectId,
  tenantId: Schema.NullOr(TenantId),
  name: Schema.String,
  kind: DeployTargetKind,
  command: Schema.String,
  ssh: Schema.NullOr(Schema.fromJsonString(DeploySshConfig)),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  archivedAt: Schema.NullOr(Schema.String),
});

const DeployRunRow = Schema.Struct({
  id: DeployRunId,
  targetId: DeployTargetId,
  projectId: ProjectId,
  status: DeployRunStatus,
  exitCode: Schema.NullOr(Schema.Int),
  output: Schema.String,
  triggeredBy: Schema.String,
  startedAt: Schema.String,
  completedAt: Schema.NullOr(Schema.String),
});

const makeDeployRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertTargetRow = SqlSchema.void({
    Request: UpsertDeployTargetInput,
    execute: (input) =>
      sql`
        INSERT INTO deploy_targets (
          id,
          project_id,
          tenant_id,
          name,
          kind,
          command,
          ssh_json,
          created_at,
          updated_at,
          archived_at
        )
        VALUES (
          ${input.id},
          ${input.projectId},
          ${input.tenantId},
          ${input.name},
          ${input.kind},
          ${input.command},
          ${input.ssh === null ? null : JSON.stringify(input.ssh)},
          ${input.createdAt},
          ${input.updatedAt},
          ${input.archivedAt}
        )
        ON CONFLICT (id)
        DO UPDATE SET
          name = excluded.name,
          kind = excluded.kind,
          command = excluded.command,
          ssh_json = excluded.ssh_json,
          tenant_id = excluded.tenant_id,
          updated_at = excluded.updated_at,
          archived_at = excluded.archived_at
      `,
  });

  const listTargetRows = SqlSchema.findAll({
    Request: ListDeployTargetsInput,
    Result: DeployTargetRow,
    execute: ({ projectId }) =>
      projectId === undefined
        ? sql`SELECT id,
          project_id AS "projectId",
          tenant_id AS "tenantId",
          name,
          kind,
          command,
          ssh_json AS "ssh",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          archived_at AS "archivedAt" FROM deploy_targets WHERE archived_at IS NULL ORDER BY created_at ASC`
        : sql`SELECT id,
          project_id AS "projectId",
          tenant_id AS "tenantId",
          name,
          kind,
          command,
          ssh_json AS "ssh",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          archived_at AS "archivedAt" FROM deploy_targets WHERE archived_at IS NULL AND project_id = ${projectId} ORDER BY created_at ASC`,
  });

  const getTargetRow = SqlSchema.findOneOption({
    Request: GetDeployTargetInput,
    Result: DeployTargetRow,
    execute: ({ targetId }) =>
      sql`SELECT id,
          project_id AS "projectId",
          tenant_id AS "tenantId",
          name,
          kind,
          command,
          ssh_json AS "ssh",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          archived_at AS "archivedAt" FROM deploy_targets WHERE id = ${targetId}`,
  });

  const upsertRunRow = SqlSchema.void({
    Request: UpsertDeployRunInput,
    execute: (input) =>
      sql`
        INSERT INTO deploy_runs (
          id,
          target_id,
          project_id,
          status,
          exit_code,
          output,
          triggered_by,
          started_at,
          completed_at
        )
        VALUES (
          ${input.id},
          ${input.targetId},
          ${input.projectId},
          ${input.status},
          ${input.exitCode},
          ${input.output},
          ${input.triggeredBy},
          ${input.startedAt},
          ${input.completedAt}
        )
        ON CONFLICT (id)
        DO UPDATE SET
          status = excluded.status,
          exit_code = excluded.exit_code,
          output = excluded.output,
          completed_at = excluded.completed_at
      `,
  });

  const listRunRows = SqlSchema.findAll({
    Request: ListDeployRunsInput,
    Result: DeployRunRow,
    execute: ({ projectId, targetId, limit }) => {
      const max = limit ?? 50;
      if (targetId !== undefined) {
        return sql`SELECT id,
          target_id AS "targetId",
          project_id AS "projectId",
          status,
          exit_code AS "exitCode",
          output,
          triggered_by AS "triggeredBy",
          started_at AS "startedAt",
          completed_at AS "completedAt" FROM deploy_runs WHERE target_id = ${targetId} ORDER BY started_at DESC LIMIT ${max}`;
      }
      if (projectId !== undefined) {
        return sql`SELECT id,
          target_id AS "targetId",
          project_id AS "projectId",
          status,
          exit_code AS "exitCode",
          output,
          triggered_by AS "triggeredBy",
          started_at AS "startedAt",
          completed_at AS "completedAt" FROM deploy_runs WHERE project_id = ${projectId} ORDER BY started_at DESC LIMIT ${max}`;
      }
      return sql`SELECT id,
          target_id AS "targetId",
          project_id AS "projectId",
          status,
          exit_code AS "exitCode",
          output,
          triggered_by AS "triggeredBy",
          started_at AS "startedAt",
          completed_at AS "completedAt" FROM deploy_runs ORDER BY started_at DESC LIMIT ${max}`;
    },
  });

  const getRunRow = SqlSchema.findOneOption({
    Request: GetDeployRunInput,
    Result: DeployRunRow,
    execute: ({ runId }) =>
      sql`SELECT id,
          target_id AS "targetId",
          project_id AS "projectId",
          status,
          exit_code AS "exitCode",
          output,
          triggered_by AS "triggeredBy",
          started_at AS "startedAt",
          completed_at AS "completedAt" FROM deploy_runs WHERE id = ${runId}`,
  });

  const upsertTarget: DeployRepositoryShape["upsertTarget"] = (input) =>
    upsertTargetRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("DeployRepository.upsertTarget:query")),
    );

  const listTargets: DeployRepositoryShape["listTargets"] = (input) =>
    listTargetRows(input).pipe(
      Effect.mapError(toPersistenceSqlError("DeployRepository.listTargets:query")),
      Effect.map((rows) => rows.map(toDeployTarget)),
    );

  const getTarget: DeployRepositoryShape["getTarget"] = (input) =>
    getTargetRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("DeployRepository.getTarget:query")),
      Effect.map((row) => (Option.isSome(row) ? Option.some(toDeployTarget(row.value)) : row)),
    );

  const upsertRun: DeployRepositoryShape["upsertRun"] = (input) =>
    upsertRunRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("DeployRepository.upsertRun:query")),
    );

  const listRuns: DeployRepositoryShape["listRuns"] = (input) =>
    listRunRows(input).pipe(
      Effect.mapError(toPersistenceSqlError("DeployRepository.listRuns:query")),
      Effect.map((rows) => rows.map(toDeployRun)),
    );

  const getRun: DeployRepositoryShape["getRun"] = (input) =>
    getRunRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("DeployRepository.getRun:query")),
      Effect.map((row) => (Option.isSome(row) ? Option.some(toDeployRun(row.value)) : row)),
    );

  return {
    upsertTarget,
    listTargets,
    getTarget,
    upsertRun,
    listRuns,
    getRun,
  } satisfies DeployRepositoryShape;
});

function toDeployTarget(row: typeof DeployTargetRow.Type): DeployTarget {
  return {
    id: row.id,
    projectId: row.projectId,
    tenantId: row.tenantId,
    name: row.name,
    kind: row.kind,
    command: row.command,
    ssh: row.ssh,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    archivedAt: row.archivedAt,
  };
}

function toDeployRun(row: typeof DeployRunRow.Type): DeployRun {
  return {
    id: row.id,
    targetId: row.targetId,
    projectId: row.projectId,
    status: row.status,
    exitCode: row.exitCode,
    output: row.output,
    triggeredBy: row.triggeredBy,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
  };
}

export const DeployRepositoryLive: Layer.Layer<DeployRepository, never, SqlClient.SqlClient> =
  Layer.effect(DeployRepository, makeDeployRepository);
