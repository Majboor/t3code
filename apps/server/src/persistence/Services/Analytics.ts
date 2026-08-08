import { Context, Option, Schema } from "effect";
import type { Effect } from "effect";

import {
  AnalyticsEvent,
  AnalyticsName,
  AnalyticsStream,
  AnalyticsStreamId,
  ProjectId,
} from "@t3tools/contracts";

import type { PersistenceSqlError } from "../Errors.ts";

export const UpsertAnalyticsStreamInput = AnalyticsStream;
export type UpsertAnalyticsStreamInput = typeof UpsertAnalyticsStreamInput.Type;

export const ListAnalyticsStreamsInput = Schema.Struct({
  projectId: Schema.optional(ProjectId),
});
export type ListAnalyticsStreamsInput = typeof ListAnalyticsStreamsInput.Type;

/** A deployment addresses a stream by project and name, never by id. */
export const FindAnalyticsStreamInput = Schema.Struct({
  projectId: ProjectId,
  name: AnalyticsName,
});
export type FindAnalyticsStreamInput = typeof FindAnalyticsStreamInput.Type;

export const AppendAnalyticsEventInput = AnalyticsEvent;
export type AppendAnalyticsEventInput = typeof AppendAnalyticsEventInput.Type;

/**
 * Events for one stream over a window. Aggregation happens above this, in the
 * service, so the repository stays a table and the arithmetic stays testable
 * without a database.
 */
export const ReadAnalyticsEventsInput = Schema.Struct({
  streamId: AnalyticsStreamId,
  since: Schema.optional(Schema.String),
  until: Schema.optional(Schema.String),
  limit: Schema.optional(Schema.Int),
});
export type ReadAnalyticsEventsInput = typeof ReadAnalyticsEventsInput.Type;

export interface AnalyticsRepositoryShape {
  readonly upsertStream: (
    input: UpsertAnalyticsStreamInput,
  ) => Effect.Effect<void, PersistenceSqlError>;
  readonly listStreams: (
    input: ListAnalyticsStreamsInput,
  ) => Effect.Effect<ReadonlyArray<AnalyticsStream>, PersistenceSqlError>;
  readonly findStream: (
    input: FindAnalyticsStreamInput,
  ) => Effect.Effect<Option.Option<AnalyticsStream>, PersistenceSqlError>;
  readonly appendEvent: (
    input: AppendAnalyticsEventInput,
  ) => Effect.Effect<void, PersistenceSqlError>;
  readonly readEvents: (
    input: ReadAnalyticsEventsInput,
  ) => Effect.Effect<ReadonlyArray<AnalyticsEvent>, PersistenceSqlError>;
}

export class AnalyticsRepository extends Context.Service<
  AnalyticsRepository,
  AnalyticsRepositoryShape
>()("t3/persistence/Services/Analytics/AnalyticsRepository") {}
