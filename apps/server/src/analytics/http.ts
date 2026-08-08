import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { Effect, Schema } from "effect";

import { AnalyticsRecordInput, ProjectId } from "@t3tools/contracts";

import { AnalyticsStore } from "./Services/AnalyticsStore.ts";

export const ANALYTICS_INGEST_PATH = "/api/analytics/events";

/**
 * What a deployment posts. The project is named alongside the stream because a
 * deployment holds a key, not a session — the key still has to open that
 * project's stream, so naming the wrong project fails rather than writing
 * somewhere else.
 */
const IngestBody = Schema.Struct({
  projectId: ProjectId,
  ...AnalyticsRecordInput.fields,
});

const decodeBody = Schema.decodeUnknownEffect(IngestBody);

/**
 * The one route in the server a deployed thing may call without a session. It
 * authenticates with the stream's ingest key and nothing else, so it is
 * deliberately narrow: one verb, one shape, and an error that never says
 * whether it was the project, the stream or the key that was wrong.
 */
export const analyticsIngestRouteLayer = HttpRouter.add(
  "POST",
  ANALYTICS_INGEST_PATH,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const analytics = yield* Effect.service(AnalyticsStore);

    const body = yield* decodeBody(yield* request.json).pipe(
      Effect.mapError(() => "malformed" as const),
    );

    return yield* analytics.record(body).pipe(
      Effect.map((result) => HttpServerResponse.jsonUnsafe(result, { status: 202 })),
      // A deployment is on the far side of the internet, so the reply says
      // whether it may write and not which of the three things was wrong.
      Effect.catch((error) =>
        Effect.succeed(
          HttpServerResponse.jsonUnsafe(
            { error: error.code === "invalid-properties" ? error.message : "rejected" },
            { status: error.code === "invalid-properties" ? 422 : 403 },
          ),
        ),
      ),
    );
  }).pipe(
    Effect.catch((cause) =>
      Effect.succeed(
        HttpServerResponse.jsonUnsafe(
          { error: cause === "malformed" ? "malformed body" : "rejected" },
          { status: 400 },
        ),
      ),
    ),
  ),
);
