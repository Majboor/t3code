import { Effect, Schema } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { resolveAuthenticatedUserId, ServerAuth } from "../auth/Services/ServerAuth.ts";
import { respondToAuthError } from "../auth/http.ts";
import { detectRegistrarHint } from "./registrarHint.ts";
import {
  ExternalIntegrations,
  IntegrationError,
  type ExternalIntegrationsShape,
} from "./Services/ExternalIntegrations.ts";

const respondToIntegrationError = (error: IntegrationError) =>
  Effect.gen(function* () {
    if (error.status >= 500) {
      yield* Effect.logError("integration route failed", { message: error.message, cause: error.cause });
    }
    return HttpServerResponse.jsonUnsafe({ error: error.message }, { status: error.status });
  });

type Provider = "github" | "cloudflare";

/** The `:provider` route segment, validated to one of the two supported providers. */
const providerFromRoute = HttpRouter.params.pipe(
  Effect.flatMap((params) => {
    const provider = params["provider"];
    return provider === "github" || provider === "cloudflare"
      ? Effect.succeed(provider as Provider)
      : Effect.fail(new IntegrationError({ message: `Unknown provider: ${provider}`, status: 400 }));
  }),
);

const CallbackQuery = Schema.Struct({ code: Schema.String, state: Schema.String });
const CreateRepoInput = Schema.Struct({ name: Schema.String, private: Schema.optional(Schema.Boolean) });
const PushFileInput = Schema.Struct({
  owner: Schema.String,
  repo: Schema.String,
  path: Schema.String,
  content: Schema.String,
  message: Schema.String,
});
const PagesProjectInput = Schema.Struct({ accountId: Schema.String, name: Schema.String });
const ConnectDomainInput = Schema.Struct({ accountId: Schema.String, domain: Schema.String });

export const integrationsStatusRouteLayer = HttpRouter.add(
  "GET",
  "/api/integrations/status",
  Effect.gen(function* () {
    const serverAuth = yield* ServerAuth;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const session = yield* serverAuth.authenticateHttpRequest(request);
    const integrations = yield* ExternalIntegrations;
    const status = yield* integrations.connectionStatus(resolveAuthenticatedUserId(session));
    return HttpServerResponse.jsonUnsafe(status, { status: 200 });
  }).pipe(
    Effect.catchTag("AuthError", (error) => respondToAuthError(error)),
    Effect.catchTag("IntegrationError", (error) => respondToIntegrationError(error)),
  ),
);

export const integrationsStartRouteLayer = HttpRouter.add(
  "GET",
  "/api/oauth/:provider/start",
  Effect.gen(function* () {
    const serverAuth = yield* ServerAuth;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const session = yield* serverAuth.authenticateHttpRequest(request);
    const provider = yield* providerFromRoute;
    const integrations = yield* ExternalIntegrations;
    const { url } = yield* integrations.startAuthorize(resolveAuthenticatedUserId(session), provider);
    return HttpServerResponse.empty({ status: 302, headers: { location: url } });
  }).pipe(
    Effect.catchTag("AuthError", (error) => respondToAuthError(error)),
    Effect.catchTag("IntegrationError", (error) => respondToIntegrationError(error)),
  ),
);

// Callback has no session — the user is arriving via a redirect from GitHub/Cloudflare,
// carrying only ?code&state in the URL. The stored OAuth state row (created by /start,
// while the user *was* authenticated) is what ties this back to a real userId.
export const integrationsCallbackRouteLayer = HttpRouter.add(
  "GET",
  "/api/oauth/:provider/callback",
  Effect.gen(function* () {
    const provider = yield* providerFromRoute;
    const { code, state } = yield* HttpServerRequest.schemaSearchParams(CallbackQuery).pipe(
      Effect.mapError((cause) => new IntegrationError({ message: "Missing code/state.", status: 400, cause })),
    );
    const integrations = yield* ExternalIntegrations;
    yield* integrations.handleCallback(provider, code, state);
    return HttpServerResponse.empty({
      status: 302,
      headers: { location: "/settings/connections?connected=" + provider },
    });
  }).pipe(Effect.catchTag("IntegrationError", (error) => respondToIntegrationError(error))),
);

export const integrationsDisconnectRouteLayer = HttpRouter.add(
  "POST",
  "/api/integrations/:provider/disconnect",
  Effect.gen(function* () {
    const serverAuth = yield* ServerAuth;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const session = yield* serverAuth.authenticateHttpRequest(request);
    const provider = yield* providerFromRoute;
    const integrations = yield* ExternalIntegrations;
    yield* integrations.disconnect(resolveAuthenticatedUserId(session), provider);
    return HttpServerResponse.jsonUnsafe({ ok: true }, { status: 200 });
  }).pipe(
    Effect.catchTag("AuthError", (error) => respondToAuthError(error)),
    Effect.catchTag("IntegrationError", (error) => respondToIntegrationError(error)),
  ),
);

export const githubCreateRepoRouteLayer = HttpRouter.add(
  "POST",
  "/api/integrations/github/repos",
  Effect.gen(function* () {
    const serverAuth = yield* ServerAuth;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const session = yield* serverAuth.authenticateHttpRequest(request);
    const input = yield* HttpServerRequest.schemaBodyJson(CreateRepoInput).pipe(
      Effect.mapError((cause) => new IntegrationError({ message: "Invalid payload.", status: 400, cause })),
    );
    const integrations = yield* ExternalIntegrations;
    const result = yield* integrations.githubCreateRepo(
      resolveAuthenticatedUserId(session),
      input.name,
      input.private ?? true,
    );
    return HttpServerResponse.jsonUnsafe(result, { status: 201 });
  }).pipe(
    Effect.catchTag("AuthError", (error) => respondToAuthError(error)),
    Effect.catchTag("IntegrationError", (error) => respondToIntegrationError(error)),
  ),
);

export const githubPushFileRouteLayer = HttpRouter.add(
  "POST",
  "/api/integrations/github/files",
  Effect.gen(function* () {
    const serverAuth = yield* ServerAuth;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const session = yield* serverAuth.authenticateHttpRequest(request);
    const input = yield* HttpServerRequest.schemaBodyJson(PushFileInput).pipe(
      Effect.mapError((cause) => new IntegrationError({ message: "Invalid payload.", status: 400, cause })),
    );
    const integrations = yield* ExternalIntegrations;
    yield* integrations.githubPushFile(
      resolveAuthenticatedUserId(session),
      input.owner,
      input.repo,
      input.path,
      input.content,
      input.message,
    );
    return HttpServerResponse.jsonUnsafe({ ok: true }, { status: 200 });
  }).pipe(
    Effect.catchTag("AuthError", (error) => respondToAuthError(error)),
    Effect.catchTag("IntegrationError", (error) => respondToIntegrationError(error)),
  ),
);

export const cloudflarePagesProjectRouteLayer = HttpRouter.add(
  "POST",
  "/api/integrations/cloudflare/pages-projects",
  Effect.gen(function* () {
    const serverAuth = yield* ServerAuth;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const session = yield* serverAuth.authenticateHttpRequest(request);
    const input = yield* HttpServerRequest.schemaBodyJson(PagesProjectInput).pipe(
      Effect.mapError((cause) => new IntegrationError({ message: "Invalid payload.", status: 400, cause })),
    );
    const integrations = yield* ExternalIntegrations;
    const result = yield* integrations.cloudflareCreatePagesProject(
      resolveAuthenticatedUserId(session),
      input.accountId,
      input.name,
    );
    return HttpServerResponse.jsonUnsafe(result, { status: 201 });
  }).pipe(
    Effect.catchTag("AuthError", (error) => respondToAuthError(error)),
    Effect.catchTag("IntegrationError", (error) => respondToIntegrationError(error)),
  ),
);

export const cloudflareConnectDomainRouteLayer = HttpRouter.add(
  "POST",
  "/api/integrations/cloudflare/domains",
  Effect.gen(function* () {
    const serverAuth = yield* ServerAuth;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const session = yield* serverAuth.authenticateHttpRequest(request);
    const input = yield* HttpServerRequest.schemaBodyJson(ConnectDomainInput).pipe(
      Effect.mapError((cause) => new IntegrationError({ message: "Invalid payload.", status: 400, cause })),
    );
    const integrations = yield* ExternalIntegrations;
    // Read before the zone exists: this is the only moment the domain's
    // *current* nameservers (the ones naming its registrar) are still live.
    const hint = yield* Effect.promise(() => detectRegistrarHint(input.domain));
    const result = yield* integrations.cloudflareConnectDomain(
      resolveAuthenticatedUserId(session),
      input.accountId,
      input.domain,
    );
    return HttpServerResponse.jsonUnsafe({ ...result, registrarHint: hint.registrar }, { status: 201 });
  }).pipe(
    Effect.catchTag("AuthError", (error) => respondToAuthError(error)),
    Effect.catchTag("IntegrationError", (error) => respondToIntegrationError(error)),
  ),
);
