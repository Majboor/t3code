import { Effect, Option, Schema } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { AuthError, resolveAuthenticatedUserId, ServerAuth } from "../auth/Services/ServerAuth.ts";
import { GatewayError, LogicPacksGateway } from "./Services/LogicPacksGateway.ts";
import { respondToAuthError } from "../auth/http.ts";

const respondToGatewayError = (error: GatewayError) =>
  Effect.gen(function* () {
    if ((error.status ?? 502) >= 500) {
      yield* Effect.logError("gateway route failed", { message: error.message, cause: error.cause });
    }
    return HttpServerResponse.jsonUnsafe({ error: error.message }, { status: error.status ?? 502 });
  });

const GatewayRedeemInput = Schema.Struct({
  code: Schema.String,
});

export const gatewayUsageRouteLayer = HttpRouter.add(
  "GET",
  "/api/gateway/usage",
  Effect.gen(function* () {
    const serverAuth = yield* ServerAuth;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const session = yield* serverAuth.authenticateHttpRequest(request);
    const gateway = yield* LogicPacksGateway;
    const usage = yield* gateway.fetchUsage(resolveAuthenticatedUserId(session));
    return HttpServerResponse.jsonUnsafe(usage, { status: 200 });
  }).pipe(
    Effect.catchTag("AuthError", (error) => respondToAuthError(error)),
    Effect.catchTag("GatewayError", (error) => respondToGatewayError(error)),
  ),
);

export const gatewayRedeemRouteLayer = HttpRouter.add(
  "POST",
  "/api/gateway/redeem",
  Effect.gen(function* () {
    const serverAuth = yield* ServerAuth;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const session = yield* serverAuth.authenticateHttpRequest(request);
    const { code } = yield* HttpServerRequest.schemaBodyJson(GatewayRedeemInput).pipe(
      Effect.mapError(
        (cause) => new AuthError({ message: "Invalid redeem payload.", status: 400, cause }),
      ),
    );
    const gateway = yield* LogicPacksGateway;
    const result = yield* gateway.redeemCode(resolveAuthenticatedUserId(session), code);
    return HttpServerResponse.jsonUnsafe(result, { status: 200 });
  }).pipe(
    Effect.catchTag("AuthError", (error) => respondToAuthError(error)),
    Effect.catchTag("GatewayError", (error) => respondToGatewayError(error)),
  ),
);

export const gatewayKeyRouteLayer = HttpRouter.add(
  "GET",
  "/api/gateway/key",
  Effect.gen(function* () {
    const serverAuth = yield* ServerAuth;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const session = yield* serverAuth.authenticateHttpRequest(request);
    const gateway = yield* LogicPacksGateway;
    const apiKey = yield* gateway.getApiKey(resolveAuthenticatedUserId(session));
    return HttpServerResponse.jsonUnsafe(
      { api_key: Option.getOrNull(apiKey) },
      { status: 200 },
    );
  }).pipe(
    Effect.catchTag("AuthError", (error) => respondToAuthError(error)),
    Effect.catchTag("GatewayError", (error) => respondToGatewayError(error)),
  ),
);
