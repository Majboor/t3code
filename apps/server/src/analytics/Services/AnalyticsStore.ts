import { Context } from "effect";
import type { Effect } from "effect";

import { AnalyticsError } from "@t3tools/contracts";
import type {
  AnalyticsDeclareStreamInput,
  AnalyticsDeclareStreamResult,
  AnalyticsListStreamsInput,
  AnalyticsListStreamsResult,
  AnalyticsQueryInput,
  AnalyticsQueryResult,
  AnalyticsRecordInput,
  AnalyticsRecordResult,
  AnalyticsStream,
  ProjectId,
} from "@t3tools/contracts";

export { AnalyticsError };

export interface AnalyticsStoreShape {
  /**
   * Declares a stream and returns its ingest key. The key is generated here and
   * handed back exactly once: it is stored hashed, so nothing can reproduce it
   * later, not even this service.
   */
  readonly declareStream: (
    input: AnalyticsDeclareStreamInput,
  ) => Effect.Effect<AnalyticsDeclareStreamResult, AnalyticsError>;

  /**
   * Mints a fresh ingest key for a stream that already exists and replaces the
   * stored digest with the new one.
   *
   * This is the only way a deployment can be handed a working key for a stream
   * somebody else declared, and it exists because the alternative is worse: the
   * key is stored hashed precisely so a leaked database cannot write to anyone's
   * numbers, and keeping a retrievable copy to hand out later would give that
   * up. The cost is that the previous key stops working, which is why the caller
   * has to establish that nothing else is still using it.
   */
  readonly reissueIngestKey: (input: {
    readonly projectId: ProjectId;
    readonly stream: AnalyticsDeclareStreamInput["name"];
  }) => Effect.Effect<
    { readonly stream: AnalyticsStream; readonly ingestKey: string },
    AnalyticsError
  >;

  readonly listStreams: (
    input: AnalyticsListStreamsInput,
  ) => Effect.Effect<AnalyticsListStreamsResult, AnalyticsError>;

  /**
   * Records one event from a deployment. The project is not taken from the
   * caller — it is whichever project's stream the key opens, so a deployment
   * cannot write into somebody else's numbers by claiming a different id.
   */
  readonly record: (
    input: AnalyticsRecordInput & { readonly projectId: ProjectId },
  ) => Effect.Effect<AnalyticsRecordResult, AnalyticsError>;

  readonly query: (
    input: AnalyticsQueryInput,
  ) => Effect.Effect<AnalyticsQueryResult, AnalyticsError>;
}

export class AnalyticsStore extends Context.Service<AnalyticsStore, AnalyticsStoreShape>()(
  "t3/analytics/Services/AnalyticsStore",
) {}
