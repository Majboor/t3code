/**
 * Product analytics for what a project deploys.
 *
 * This is not the telemetry T3 Code emits about itself. It is the surface a
 * deployed thing reports to: a web app recording page views, a PDF recording
 * how far somebody read, a TUI recording which command was run. A deployment
 * posts events; the workspace asks questions of them.
 *
 * Two ideas carry the whole contract:
 *
 * - An **event stream** is declared before it is used, so a chart can be drawn
 *   from the declaration rather than guessed from whatever arrived first. The
 *   declaration is what an agent reads to know which questions are answerable.
 * - **Properties are typed and named up front.** An event whose shape drifts
 *   silently is worse than no event, because every chart over it keeps drawing.
 *
 * @module analytics
 */
import { Schema } from "effect";

import {
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

export const AnalyticsStreamId = Schema.String.pipe(Schema.brand("AnalyticsStreamId"));
export type AnalyticsStreamId = typeof AnalyticsStreamId.Type;

export const AnalyticsEventId = Schema.String.pipe(Schema.brand("AnalyticsEventId"));
export type AnalyticsEventId = typeof AnalyticsEventId.Type;

/**
 * A slug the deployment sends and a chart refers to. Constrained because it
 * ends up in URLs, in generated code and in chart titles.
 */
export const AnalyticsName = TrimmedNonEmptyString.check(
  Schema.isMaxLength(64),
  Schema.isPattern(/^[a-z][a-z0-9_.-]*$/),
);

/**
 * What a property holds. Deliberately small: these are the types a chart can
 * do something with, and anything richer belongs in its own event.
 */
export const AnalyticsPropertyType = Schema.Literals(["string", "number", "boolean"]);
export type AnalyticsPropertyType = typeof AnalyticsPropertyType.Type;

export const AnalyticsProperty = Schema.Struct({
  name: AnalyticsName,
  type: AnalyticsPropertyType,
  /** What it means, for whoever draws the chart — human or agent. */
  purpose: TrimmedNonEmptyString.check(Schema.isMaxLength(240)),
  required: Schema.Boolean,
});
export type AnalyticsProperty = typeof AnalyticsProperty.Type;

/**
 * A declared event stream. `ingestKeyName` names a secret rather than carrying
 * one: the key lets a deployment write, so it must never travel in a
 * projection or sit in a manifest.
 */
export const AnalyticsStream = Schema.Struct({
  id: AnalyticsStreamId,
  projectId: ProjectId,
  name: AnalyticsName,
  purpose: TrimmedNonEmptyString.check(Schema.isMaxLength(240)),
  properties: Schema.Array(AnalyticsProperty),
  ingestKeyName: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  archivedAt: Schema.NullOr(IsoDateTime),
});
export type AnalyticsStream = typeof AnalyticsStream.Type;

/** A property value as it arrives from a deployment. */
export const AnalyticsValue = Schema.Union([Schema.String, Schema.Number, Schema.Boolean]);
export type AnalyticsValue = typeof AnalyticsValue.Type;

export const AnalyticsEvent = Schema.Struct({
  id: AnalyticsEventId,
  streamId: AnalyticsStreamId,
  projectId: ProjectId,
  /** When the deployment says it happened, which is not when it arrived. */
  occurredAt: IsoDateTime,
  receivedAt: IsoDateTime,
  properties: Schema.Record(Schema.String, AnalyticsValue),
});
export type AnalyticsEvent = typeof AnalyticsEvent.Type;

// ── declaring a stream ──────────────────────────────────────────────────────

export const AnalyticsDeclareStreamInput = Schema.Struct({
  projectId: ProjectId,
  name: AnalyticsName,
  purpose: TrimmedNonEmptyString.check(Schema.isMaxLength(240)),
  properties: Schema.Array(AnalyticsProperty),
});
export type AnalyticsDeclareStreamInput = typeof AnalyticsDeclareStreamInput.Type;

export const AnalyticsDeclareStreamResult = Schema.Struct({
  stream: AnalyticsStream,
  /**
   * Returned once, at declaration. Reading a stream later gives the key's name
   * and never its value, so this is the only moment it can be captured.
   */
  ingestKey: TrimmedNonEmptyString,
});
export type AnalyticsDeclareStreamResult = typeof AnalyticsDeclareStreamResult.Type;

export const AnalyticsListStreamsInput = Schema.Struct({
  projectId: Schema.optional(ProjectId),
});
export type AnalyticsListStreamsInput = typeof AnalyticsListStreamsInput.Type;

export const AnalyticsListStreamsResult = Schema.Struct({
  streams: Schema.Array(AnalyticsStream),
});
export type AnalyticsListStreamsResult = typeof AnalyticsListStreamsResult.Type;

// ── recording ───────────────────────────────────────────────────────────────

/**
 * What a deployment posts. The stream is named rather than referenced by id so
 * the deployed code carries something a person can read, and the key proves it
 * may write to that project's streams.
 */
export const AnalyticsRecordInput = Schema.Struct({
  stream: AnalyticsName,
  ingestKey: TrimmedNonEmptyString,
  occurredAt: Schema.optional(IsoDateTime),
  properties: Schema.Record(Schema.String, AnalyticsValue),
});
export type AnalyticsRecordInput = typeof AnalyticsRecordInput.Type;

export const AnalyticsRecordResult = Schema.Struct({
  eventId: AnalyticsEventId,
});
export type AnalyticsRecordResult = typeof AnalyticsRecordResult.Type;

// ── asking questions ────────────────────────────────────────────────────────

/**
 * How the numbers are rolled up. `count` needs no property; the rest are only
 * meaningful over a numeric one, which the service checks against the
 * declaration rather than trusting the caller.
 */
export const AnalyticsAggregate = Schema.Literals(["count", "sum", "avg", "min", "max"]);
export type AnalyticsAggregate = typeof AnalyticsAggregate.Type;

export const AnalyticsQueryInput = Schema.Struct({
  projectId: ProjectId,
  stream: AnalyticsName,
  aggregate: AnalyticsAggregate,
  /** The numeric property being aggregated. Required for everything but count. */
  valueProperty: Schema.optional(AnalyticsName),
  /** Split the result by this property, which is what makes a chart a chart. */
  groupBy: Schema.optional(AnalyticsName),
  since: Schema.optional(IsoDateTime),
  until: Schema.optional(IsoDateTime),
  limit: Schema.optional(NonNegativeInt),
});
export type AnalyticsQueryInput = typeof AnalyticsQueryInput.Type;

export const AnalyticsQueryBucket = Schema.Struct({
  /** Null when the query did not group, so one bucket covers everything. */
  group: Schema.NullOr(Schema.String),
  value: Schema.Number,
  events: NonNegativeInt,
});
export type AnalyticsQueryBucket = typeof AnalyticsQueryBucket.Type;

export const AnalyticsQueryResult = Schema.Struct({
  stream: AnalyticsName,
  aggregate: AnalyticsAggregate,
  buckets: Schema.Array(AnalyticsQueryBucket),
});
export type AnalyticsQueryResult = typeof AnalyticsQueryResult.Type;

export const AnalyticsErrorCode = Schema.Literals([
  "stream-not-found",
  "stream-already-declared",
  "invalid-key",
  "invalid-properties",
  "invalid-query",
  "storage-failed",
]);
export type AnalyticsErrorCode = typeof AnalyticsErrorCode.Type;
