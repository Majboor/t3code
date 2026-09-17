import { Context, Schema } from "effect";
import type { Effect } from "effect";

import type { PersistenceSqlError } from "../Errors.ts";

/**
 * The three outcomes the promptbar eval harness cares about: a candidate was
 * used (click or Tab), a shown candidate was waved away, or the resolve call
 * said ACTION and nothing good enough survived to show at all.
 */
export const PromptbarTelemetryEvent = Schema.Literals(["accepted", "dismissed", "abstained"]);
export type PromptbarTelemetryEvent = typeof PromptbarTelemetryEvent.Type;

export const RecordPromptbarTelemetryInput = Schema.Struct({
  id: Schema.String,
  userId: Schema.String,
  event: PromptbarTelemetryEvent,
  packId: Schema.NullOr(Schema.String),
  query: Schema.String,
  createdAt: Schema.String,
});
export type RecordPromptbarTelemetryInput = typeof RecordPromptbarTelemetryInput.Type;

export interface PromptbarTelemetryRepositoryShape {
  /**
   * Appends one outcome row. Durable storage only — no aggregation, no
   * read path here; a separate agent computes recall/MRR/etc. by reading
   * `promptbar_telemetry` directly.
   */
  readonly record: (
    input: RecordPromptbarTelemetryInput,
  ) => Effect.Effect<void, PersistenceSqlError>;
}

export class PromptbarTelemetryRepository extends Context.Service<
  PromptbarTelemetryRepository,
  PromptbarTelemetryRepositoryShape
>()("t3/persistence/Services/PromptbarTelemetry/PromptbarTelemetryRepository") {}
