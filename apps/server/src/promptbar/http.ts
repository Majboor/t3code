/**
 * Promptbar routes, over HTTP.
 *
 * `promptbarResolveRouteLayer` (`POST /api/promptbar/resolve`) is the hybrid
 * retrieval pipeline itself, backed by `Services/PromptbarClient.ts` /
 * `Layers/PromptbarClient.ts`.
 *
 * `promptbarTelemetryRouteLayer` (`POST /api/promptbar/telemetry`) is the
 * write side of the eval loop: the composer posts one row per outcome — a
 * candidate accepted, dismissed, or abstained (ACTION intent, nothing good
 * enough to show) — and this route durably logs it. No aggregation here on
 * purpose; a separate eval-harness reads `promptbar_telemetry` directly to
 * compute recall/MRR/etc.
 *
 * Both follow the same shape as `integrations/http.ts`'s disconnect route:
 * session-authenticated, a small JSON body, a typed error mapped to a status
 * code.
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
import { PromptbarClient, PromptbarError, type PromptbarResolveInput } from "./Services/PromptbarClient.ts";

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

const respondToPromptbarError = (error: PromptbarError) =>
  Effect.gen(function* () {
    const status = error.status ?? 502;
    if (status >= 500) {
      yield* Effect.logError("promptbar route failed", { message: error.message });
    }
    return HttpServerResponse.jsonUnsafe({ error: error.message }, { status });
  });

const PromptbarResolveRequest = Schema.Struct({
  text: Schema.String,
  isFirstMessageInSession: Schema.Boolean,
  k: Schema.optional(Schema.Number),
});

export const promptbarResolveRouteLayer = HttpRouter.add(
  "POST",
  "/api/promptbar/resolve",
  Effect.gen(function* () {
    const serverAuth = yield* ServerAuth;
    const request = yield* HttpServerRequest.HttpServerRequest;
    // Authenticated purely to keep this endpoint behind a session like every
    // other authenticated route in this app — the resolution itself carries
    // nothing user-specific (see PromptbarResolveInput), so `userId` is not
    // otherwise used here.
    const session = yield* serverAuth.authenticateHttpRequest(request);
    resolveAuthenticatedUserId(session);

    const body = yield* HttpServerRequest.schemaBodyJson(PromptbarResolveRequest).pipe(
      Effect.mapError(() => new PromptbarError({ message: "Invalid payload.", status: 400 })),
    );
    // Rebuilt rather than passed through as-is: `schemaBodyJson`'s decoded
    // `k?: number` is really `k: number | undefined` once JSON-decoded, which
    // `exactOptionalPropertyTypes` (on) treats as a different, incompatible
    // shape from `PromptbarResolveInput`'s `k?: number`.
    const input: PromptbarResolveInput =
      body.k === undefined
        ? { text: body.text, isFirstMessageInSession: body.isFirstMessageInSession }
        : { text: body.text, isFirstMessageInSession: body.isFirstMessageInSession, k: body.k };

    const promptbar = yield* PromptbarClient;
    const resolution = yield* promptbar.resolve(input);
    return HttpServerResponse.jsonUnsafe(resolution, { status: 200 });
  }).pipe(
    Effect.catchTag("AuthError", (error) => respondToAuthError(error)),
    Effect.catchTag("PromptbarError", (error) => respondToPromptbarError(error)),
  ),
);

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
