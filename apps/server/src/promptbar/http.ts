/**
 * Promptbar telemetry, over HTTP.
 *
 * `POST /api/promptbar/resolve` (the hybrid retrieval pipeline itself) is a
 * different agent's work, laid out in `Services/PromptbarClient.ts` /
 * `Layers/PromptbarClient.ts`. This file is only the write side of the eval
 * loop: the composer posts one row per outcome — a candidate accepted,
 * dismissed, or abstained (ACTION intent, nothing good enough to show) — and
 * this route durably logs it. No aggregation here on purpose; a separate
 * eval-harness agent reads `promptbar_telemetry` directly to compute
 * recall/MRR/etc.
 *
 * Same shape as `integrations/http.ts`'s disconnect route: session-authenticated,
 * a small JSON body, a typed error mapped to a status code, `{ ok: true }` back.
 *
 * @module PromptbarHttp
 */
import { Data, Effect, Schema } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { resolveAuthenticatedUserId, ServerAuth } from "../auth/Services/ServerAuth.ts";
import { respondToAuthError } from "../auth/http.ts";
import {
  PromptbarTelemetryEvent,
  PromptbarTelemetryRepository,
} from "../persistence/Services/PromptbarTelemetry.ts";

export class PromptbarTelemetryError extends Data.TaggedError("PromptbarTelemetryError")<{
  readonly message: string;
  readonly status?: number;
  readonly cause?: unknown;
}> {}

const respondToPromptbarTelemetryError = (error: PromptbarTelemetryError) =>
  Effect.gen(function* () {
    const status = error.status ?? 500;
    if (status >= 500) {
      yield* Effect.logError("promptbar telemetry route failed", {
        message: error.message,
        cause: error.cause,
      });
    }
    return HttpServerResponse.jsonUnsafe({ error: error.message }, { status });
  });

const TelemetryInput = Schema.Struct({
  event: PromptbarTelemetryEvent,
  packId: Schema.optional(Schema.String),
  query: Schema.String,
});

export const promptbarTelemetryRouteLayer = HttpRouter.add(
  "POST",
  "/api/promptbar/telemetry",
  Effect.gen(function* () {
    const serverAuth = yield* ServerAuth;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const session = yield* serverAuth.authenticateHttpRequest(request);
    const input = yield* HttpServerRequest.schemaBodyJson(TelemetryInput).pipe(
      Effect.mapError(
        (cause) => new PromptbarTelemetryError({ message: "Invalid payload.", status: 400, cause }),
      ),
    );

    const telemetry = yield* PromptbarTelemetryRepository;
    yield* telemetry
      .record({
        id: crypto.randomUUID(),
        userId: resolveAuthenticatedUserId(session),
        event: input.event,
        packId: input.packId ?? null,
        query: input.query,
        createdAt: new Date().toISOString(),
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new PromptbarTelemetryError({ message: "Failed to record telemetry.", cause }),
        ),
      );

    return HttpServerResponse.jsonUnsafe({ ok: true }, { status: 200 });
  }).pipe(
    Effect.catchTag("AuthError", (error) => respondToAuthError(error)),
    Effect.catchTag("PromptbarTelemetryError", (error) => respondToPromptbarTelemetryError(error)),
  ),
);
