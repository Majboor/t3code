import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { Effect, Layer, Schema } from "effect";

import {
  AnalyticsEventId,
  AnalyticsName,
  AnalyticsProperty,
  AnalyticsStreamId,
  AnalyticsValue,
  ProjectId,
} from "@t3tools/contracts";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  AnalyticsRepository,
  type AnalyticsRepositoryShape,
  AppendAnalyticsEventInput,
  FindAnalyticsStreamInput,
  ListAnalyticsStreamsInput,
  ReadAnalyticsEventsInput,
  UpsertAnalyticsStreamInput,
} from "../Services/Analytics.ts";

const AnalyticsStreamRow = Schema.Struct({
  id: AnalyticsStreamId,
  projectId: ProjectId,
  name: AnalyticsName,
  purpose: Schema.String,
  properties: Schema.fromJsonString(Schema.Array(AnalyticsProperty)),
  ingestKeyName: Schema.String,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  archivedAt: Schema.NullOr(Schema.String),
});

const AnalyticsEventRow = Schema.Struct({
  id: AnalyticsEventId,
  streamId: AnalyticsStreamId,
  projectId: ProjectId,
  occurredAt: Schema.String,
  receivedAt: Schema.String,
  properties: Schema.fromJsonString(Schema.Record(Schema.String, AnalyticsValue)),
});

const STREAM_COLUMNS = `id,
  project_id AS "projectId",
  name,
  purpose,
  properties_json AS "properties",
  ingest_key_name AS "ingestKeyName",
  created_at AS "createdAt",
  updated_at AS "updatedAt",
  archived_at AS "archivedAt"`;

const EVENT_COLUMNS = `id,
  stream_id AS "streamId",
  project_id AS "projectId",
  occurred_at AS "occurredAt",
  received_at AS "receivedAt",
  properties_json AS "properties"`;

const makeAnalyticsRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertStreamRow = SqlSchema.void({
    Request: UpsertAnalyticsStreamInput,
    execute: (input) =>
      sql`
        INSERT INTO analytics_streams (
          id, project_id, name, purpose, properties_json,
          ingest_key_name, created_at, updated_at, archived_at
        )
        VALUES (
          ${input.id}, ${input.projectId}, ${input.name}, ${input.purpose},
          ${JSON.stringify(input.properties)}, ${input.ingestKeyName},
          ${input.createdAt}, ${input.updatedAt}, ${input.archivedAt}
        )
        ON CONFLICT (id)
        DO UPDATE SET
          purpose = excluded.purpose,
          properties_json = excluded.properties_json,
          -- Reissuing is the only thing that updates an existing row, and a
          -- new key is the whole point of it. Left out, the caller was handed a
          -- key whose digest was never stored: the deploy carried it into the
          -- process, every event was refused 403, and because the route will
          -- not say which of project, stream or key was wrong, it looked
          -- exactly like reporting silently doing nothing.
          ingest_key_name = excluded.ingest_key_name,
          updated_at = excluded.updated_at,
          archived_at = excluded.archived_at
      `,
  });

  const listStreamRows = SqlSchema.findAll({
    Request: ListAnalyticsStreamsInput,
    Result: AnalyticsStreamRow,
    execute: ({ projectId }) =>
      projectId === undefined
        ? sql`SELECT ${sql.literal(STREAM_COLUMNS)} FROM analytics_streams
              WHERE archived_at IS NULL ORDER BY created_at ASC`
        : sql`SELECT ${sql.literal(STREAM_COLUMNS)} FROM analytics_streams
              WHERE archived_at IS NULL AND project_id = ${projectId} ORDER BY created_at ASC`,
  });

  const findStreamRow = SqlSchema.findOneOption({
    Request: FindAnalyticsStreamInput,
    Result: AnalyticsStreamRow,
    execute: ({ projectId, name }) =>
      sql`SELECT ${sql.literal(STREAM_COLUMNS)} FROM analytics_streams
          WHERE archived_at IS NULL AND project_id = ${projectId} AND name = ${name}`,
  });

  const appendEventRow = SqlSchema.void({
    Request: AppendAnalyticsEventInput,
    execute: (input) =>
      sql`
        INSERT INTO analytics_events (
          id, stream_id, project_id, occurred_at, received_at, properties_json
        )
        VALUES (
          ${input.id}, ${input.streamId}, ${input.projectId},
          ${input.occurredAt}, ${input.receivedAt}, ${JSON.stringify(input.properties)}
        )
        ON CONFLICT (id) DO NOTHING
      `,
  });

  const readEventRows = SqlSchema.findAll({
    Request: ReadAnalyticsEventsInput,
    Result: AnalyticsEventRow,
    execute: ({ streamId, since, until, limit }) =>
      sql`SELECT ${sql.literal(EVENT_COLUMNS)} FROM analytics_events
          WHERE stream_id = ${streamId}
            AND (${since ?? null} IS NULL OR occurred_at >= ${since ?? null})
            AND (${until ?? null} IS NULL OR occurred_at <= ${until ?? null})
          ORDER BY occurred_at ASC
          LIMIT ${limit ?? 100_000}`,
  });

  return {
    upsertStream: (input) =>
      upsertStreamRow(input).pipe(Effect.mapError(toPersistenceSqlError("upsertAnalyticsStream"))),
    listStreams: (input) =>
      listStreamRows(input).pipe(Effect.mapError(toPersistenceSqlError("listAnalyticsStreams"))),
    findStream: (input) =>
      findStreamRow(input).pipe(Effect.mapError(toPersistenceSqlError("findAnalyticsStream"))),
    appendEvent: (input) =>
      appendEventRow(input).pipe(Effect.mapError(toPersistenceSqlError("appendAnalyticsEvent"))),
    readEvents: (input) =>
      readEventRows(input).pipe(Effect.mapError(toPersistenceSqlError("readAnalyticsEvents"))),
  } satisfies AnalyticsRepositoryShape;
});

export const AnalyticsRepositoryLive = Layer.effect(AnalyticsRepository, makeAnalyticsRepository);
