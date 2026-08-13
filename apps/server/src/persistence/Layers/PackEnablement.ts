import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { Effect, Layer, Schema } from "effect";

import {
  PackEnablementId,
  PackEnablementSetting,
  PackId,
  PackVersion,
  ProjectId,
} from "@t3tools/contracts";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  FindPackEnablementInput,
  ListPackEnablementsInput,
  PackEnablementRepository,
  type PackEnablementRepositoryShape,
  UpsertPackEnablementInput,
} from "../Services/PackEnablement.ts";

const PackEnablementRow = Schema.Struct({
  id: PackEnablementId,
  projectId: ProjectId,
  packId: PackId,
  version: PackVersion,
  packName: Schema.String,
  packSummary: Schema.String,
  settings: Schema.fromJsonString(Schema.Array(PackEnablementSetting)),
  enabledAt: Schema.String,
  disabledAt: Schema.NullOr(Schema.String),
});

const COLUMNS = `id,
  project_id AS "projectId",
  pack_id AS "packId",
  version,
  pack_name AS "packName",
  pack_summary AS "packSummary",
  settings_json AS "settings",
  enabled_at AS "enabledAt",
  disabled_at AS "disabledAt"`;

const makeRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertRow = SqlSchema.void({
    Request: UpsertPackEnablementInput,
    execute: (input) =>
      sql`
        INSERT INTO pack_enablements (
          id, project_id, pack_id, version, pack_name, pack_summary,
          settings_json, enabled_at, disabled_at
        )
        VALUES (
          ${input.id}, ${input.projectId}, ${input.packId}, ${input.version},
          ${input.packName}, ${input.packSummary}, ${JSON.stringify(input.settings)},
          ${input.enabledAt}, ${input.disabledAt}
        )
        ON CONFLICT (project_id, pack_id)
        DO UPDATE SET
          version = excluded.version,
          pack_name = excluded.pack_name,
          pack_summary = excluded.pack_summary,
          settings_json = excluded.settings_json,
          enabled_at = excluded.enabled_at,
          disabled_at = excluded.disabled_at
      `,
  });

  const listRows = SqlSchema.findAll({
    Request: ListPackEnablementsInput,
    Result: PackEnablementRow,
    execute: ({ projectId, includeDisabled }) =>
      includeDisabled === true
        ? sql`SELECT ${sql.literal(COLUMNS)} FROM pack_enablements
              WHERE project_id = ${projectId} ORDER BY enabled_at ASC`
        : sql`SELECT ${sql.literal(COLUMNS)} FROM pack_enablements
              WHERE project_id = ${projectId} AND disabled_at IS NULL ORDER BY enabled_at ASC`,
  });

  const findRow = SqlSchema.findOneOption({
    Request: FindPackEnablementInput,
    Result: PackEnablementRow,
    execute: ({ projectId, packId }) =>
      sql`SELECT ${sql.literal(COLUMNS)} FROM pack_enablements
          WHERE project_id = ${projectId} AND pack_id = ${packId}`,
  });

  return {
    upsert: (input) =>
      upsertRow(input).pipe(Effect.mapError(toPersistenceSqlError("upsertPackEnablement"))),
    list: (input) =>
      listRows(input).pipe(Effect.mapError(toPersistenceSqlError("listPackEnablements"))),
    find: (input) =>
      findRow(input).pipe(Effect.mapError(toPersistenceSqlError("findPackEnablement"))),
  } satisfies PackEnablementRepositoryShape;
});

export const PackEnablementRepositoryLive = Layer.effect(PackEnablementRepository, makeRepository);
