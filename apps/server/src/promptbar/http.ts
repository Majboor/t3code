import { Effect, Schema } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { resolveAuthenticatedUserId, ServerAuth } from "../auth/Services/ServerAuth.ts";
import { respondToAuthError } from "../auth/http.ts";
import { PromptbarClient, PromptbarError, type PromptbarResolveInput } from "./Services/PromptbarClient.ts";

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
