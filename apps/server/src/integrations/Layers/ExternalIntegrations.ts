import { Config, DateTime, Effect, Layer, Option } from "effect";
import { randomBytes } from "node:crypto";

import type { UserId } from "@t3tools/contracts";

import {
  ExternalConnectionRepository,
  type ExternalConnectionProvider,
} from "../../persistence/Services/ExternalConnections.ts";
import {
  ExternalIntegrations,
  IntegrationError,
  type AuthorizeUrlResult,
  type ExternalIntegrationsShape,
  type PagesDeployResult,
  type RepoActionResult,
  type ZoneConnectResult,
} from "../Services/ExternalIntegrations.ts";

const IntegrationsEnvConfig = Config.all({
  publicBaseUrl: Config.url("T3CODE_INTEGRATIONS_BASE_URL").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  githubClientId: Config.string("T3CODE_GITHUB_CLIENT_ID").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  githubClientSecret: Config.string("T3CODE_GITHUB_CLIENT_SECRET").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  cloudflareClientId: Config.string("T3CODE_CLOUDFLARE_CLIENT_ID").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  cloudflareClientSecret: Config.string("T3CODE_CLOUDFLARE_CLIENT_SECRET").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
});

const GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GITHUB_API = "https://api.github.com";
const GITHUB_SCOPE = "repo read:user";

// Cloudflare's self-managed OAuth clients (dash.cloudflare.com/<account>/oauth-clients).
const CLOUDFLARE_AUTHORIZE_URL = "https://dash.cloudflare.com/oauth2/auth";
const CLOUDFLARE_TOKEN_URL = "https://dash.cloudflare.com/oauth2/token";
const CLOUDFLARE_API = "https://api.cloudflare.com/client/v4";

function fail(message: string, status = 502, cause?: unknown): Effect.Effect<never, IntegrationError> {
  return Effect.fail(new IntegrationError({ message, status, cause }));
}

const makeExternalIntegrations = Effect.gen(function* () {
  const env = yield* IntegrationsEnvConfig;
  const repo = yield* ExternalConnectionRepository;

  const redirectUri = (provider: ExternalConnectionProvider) =>
    `${env.publicBaseUrl ?? "https://glm-logicpacks.techrealm.online"}/api/oauth/${provider}/callback`;

  const isConfigured: ExternalIntegrationsShape["isConfigured"] = (provider) =>
    provider === "github"
      ? env.githubClientId !== undefined && env.githubClientSecret !== undefined
      : env.cloudflareClientId !== undefined && env.cloudflareClientSecret !== undefined;

  const requireConfigured = (provider: ExternalConnectionProvider) =>
    isConfigured(provider)
      ? Effect.void
      : fail(`${provider} integration is not configured on this instance.`, 501);

  const startAuthorize: ExternalIntegrationsShape["startAuthorize"] = (userId, provider) =>
    Effect.gen(function* () {
      yield* requireConfigured(provider);
      const state = randomBytes(24).toString("hex");
      const now = yield* DateTime.now;
      yield* repo
        .insertOAuthState({ state, userId, provider, createdAt: DateTime.toUtc(now) })
        .pipe(Effect.mapError((cause) => new IntegrationError({ message: "Failed to start OAuth flow.", cause })));

      if (provider === "github") {
        const url = new URL(GITHUB_AUTHORIZE_URL);
        url.searchParams.set("client_id", env.githubClientId!);
        url.searchParams.set("redirect_uri", redirectUri("github"));
        url.searchParams.set("scope", GITHUB_SCOPE);
        url.searchParams.set("state", state);
        return { url: url.toString(), state } satisfies AuthorizeUrlResult;
      }

      const url = new URL(CLOUDFLARE_AUTHORIZE_URL);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("client_id", env.cloudflareClientId!);
      url.searchParams.set("redirect_uri", redirectUri("cloudflare"));
      url.searchParams.set("state", state);
      return { url: url.toString(), state } satisfies AuthorizeUrlResult;
    });

  const handleCallback: ExternalIntegrationsShape["handleCallback"] = (provider, code, state) =>
    Effect.gen(function* () {
      yield* requireConfigured(provider);
      const stateRow = yield* repo
        .consumeOAuthState({ state })
        .pipe(Effect.mapError((cause) => new IntegrationError({ message: "State lookup failed.", cause })));
      if (Option.isNone(stateRow) || stateRow.value.provider !== provider) {
        return yield* fail("Invalid or expired OAuth state — the login attempt may have expired, try again.", 400);
      }
      const userId = stateRow.value.userId;

      if (provider === "github") {
        const res = yield* Effect.tryPromise({
          try: () =>
            fetch(GITHUB_TOKEN_URL, {
              method: "POST",
              headers: { "content-type": "application/json", accept: "application/json" },
              body: JSON.stringify({
                client_id: env.githubClientId,
                client_secret: env.githubClientSecret,
                code,
                redirect_uri: redirectUri("github"),
              }),
            }),
          catch: (cause) => new IntegrationError({ message: "GitHub token exchange failed.", cause }),
        });
        const body = (yield* Effect.tryPromise({
          try: () => res.json() as Promise<{ access_token?: string; scope?: string; error?: string; error_description?: string }>,
          catch: (cause) => new IntegrationError({ message: "GitHub returned an unreadable response.", cause }),
        }));
        if (!res.ok || !body.access_token) {
          return yield* fail(`GitHub authorization failed: ${body.error_description ?? body.error ?? res.statusText}`, 502);
        }

        const userRes = yield* Effect.tryPromise({
          try: () =>
            fetch(`${GITHUB_API}/user`, {
              headers: { authorization: `Bearer ${body.access_token}`, accept: "application/vnd.github+json" },
            }),
          catch: (cause) => new IntegrationError({ message: "Failed to read GitHub user.", cause }),
        });
        const ghUser = (yield* Effect.tryPromise({
          try: () => userRes.json() as Promise<{ login?: string; id?: number }>,
          catch: (cause) => new IntegrationError({ message: "Unreadable GitHub user response.", cause }),
        }));

        const now = yield* DateTime.now;
        yield* repo
          .upsert({
            userId,
            provider: "github",
            accessToken: body.access_token,
            refreshToken: null,
            expiresAt: null,
            accountId: ghUser.id ? String(ghUser.id) : null,
            accountLabel: ghUser.login ?? null,
            scope: body.scope ?? null,
            createdAt: DateTime.toUtc(now),
            updatedAt: DateTime.toUtc(now),
          })
          .pipe(Effect.mapError((cause) => new IntegrationError({ message: "Failed to store GitHub connection.", cause })));
        return userId;
      }

      // cloudflare
      const res = yield* Effect.tryPromise({
        try: () =>
          fetch(CLOUDFLARE_TOKEN_URL, {
            method: "POST",
            headers: {
              "content-type": "application/x-www-form-urlencoded",
              authorization: `Basic ${Buffer.from(`${env.cloudflareClientId}:${env.cloudflareClientSecret}`).toString("base64")}`,
            },
            body: new URLSearchParams({
              grant_type: "authorization_code",
              code,
              redirect_uri: redirectUri("cloudflare"),
            }),
          }),
        catch: (cause) => new IntegrationError({ message: "Cloudflare token exchange failed.", cause }),
      });
      const body = (yield* Effect.tryPromise({
        try: () => res.json() as Promise<{ access_token?: string; refresh_token?: string; expires_in?: number; scope?: string; error?: string; error_description?: string }>,
        catch: (cause) => new IntegrationError({ message: "Cloudflare returned an unreadable response.", cause }),
      }));
      if (!res.ok || !body.access_token) {
        return yield* fail(`Cloudflare authorization failed: ${body.error_description ?? body.error ?? res.statusText}`, 502);
      }

      const acctRes = yield* Effect.tryPromise({
        try: () => fetch(`${CLOUDFLARE_API}/accounts`, { headers: { authorization: `Bearer ${body.access_token}` } }),
        catch: (cause) => new IntegrationError({ message: "Failed to read Cloudflare accounts.", cause }),
      });
      const acctBody = (yield* Effect.tryPromise({
        try: () => acctRes.json() as Promise<{ result?: Array<{ id: string; name: string }> }>,
        catch: (cause) => new IntegrationError({ message: "Unreadable Cloudflare accounts response.", cause }),
      }));
      const firstAccount = acctBody.result?.[0];

      const now = yield* DateTime.now;
      yield* repo
        .upsert({
          userId,
          provider: "cloudflare",
          accessToken: body.access_token,
          refreshToken: body.refresh_token ?? null,
          expiresAt: body.expires_in ? DateTime.toUtc(DateTime.add(now, { seconds: body.expires_in })) : null,
          accountId: firstAccount?.id ?? null,
          accountLabel: firstAccount?.name ?? null,
          scope: body.scope ?? null,
          createdAt: DateTime.toUtc(now),
          updatedAt: DateTime.toUtc(now),
        })
        .pipe(Effect.mapError((cause) => new IntegrationError({ message: "Failed to store Cloudflare connection.", cause })));
      return userId;
    });

  const connectionStatus: ExternalIntegrationsShape["connectionStatus"] = (userId) =>
    Effect.gen(function* () {
      const gh = yield* repo
        .getByUserAndProvider({ userId, provider: "github" })
        .pipe(Effect.mapError((cause) => new IntegrationError({ message: "Lookup failed.", cause })));
      const cf = yield* repo
        .getByUserAndProvider({ userId, provider: "cloudflare" })
        .pipe(Effect.mapError((cause) => new IntegrationError({ message: "Lookup failed.", cause })));
      return {
        github: { connected: Option.isSome(gh), label: Option.isSome(gh) ? gh.value.accountLabel : null },
        cloudflare: { connected: Option.isSome(cf), label: Option.isSome(cf) ? cf.value.accountLabel : null },
      };
    });

  const disconnect: ExternalIntegrationsShape["disconnect"] = (userId, provider) =>
    repo
      .delete({ userId, provider })
      .pipe(Effect.mapError((cause) => new IntegrationError({ message: "Failed to disconnect.", cause })));

  const getRawToken: ExternalIntegrationsShape["getRawToken"] = (userId, provider) =>
    repo
      .getByUserAndProvider({ userId, provider })
      .pipe(
        Effect.mapError((cause) => new IntegrationError({ message: "Lookup failed.", cause })),
        Effect.map((row) => (Option.isSome(row) ? Option.some(row.value.accessToken) : Option.none())),
      );

  const requireToken = (userId: UserId, provider: ExternalConnectionProvider) =>
    getRawToken(userId, provider).pipe(
      Effect.flatMap((tok) =>
        Option.isSome(tok) ? Effect.succeed(tok.value) : fail(`No ${provider} account connected for this user.`, 400),
      ),
    );

  const githubCreateRepo: ExternalIntegrationsShape["githubCreateRepo"] = (userId, name, isPrivate) =>
    Effect.gen(function* () {
      const token = yield* requireToken(userId, "github");
      const res = yield* Effect.tryPromise({
        try: () =>
          fetch(`${GITHUB_API}/user/repos`, {
            method: "POST",
            headers: {
              authorization: `Bearer ${token}`,
              accept: "application/vnd.github+json",
              "content-type": "application/json",
            },
            body: JSON.stringify({ name, private: isPrivate, auto_init: true }),
          }),
        catch: (cause) => new IntegrationError({ message: "GitHub repo creation request failed.", cause }),
      });
      const body = (yield* Effect.tryPromise({
        try: () => res.json() as Promise<{ html_url?: string; default_branch?: string; message?: string }>,
        catch: (cause) => new IntegrationError({ message: "Unreadable GitHub response.", cause }),
      }));
      if (!res.ok || !body.html_url) {
        return yield* fail(`GitHub repo creation failed: ${body.message ?? res.statusText}`, res.status);
      }
      return { htmlUrl: body.html_url, defaultBranch: body.default_branch ?? "main" } satisfies RepoActionResult;
    });

  const githubPushFile: ExternalIntegrationsShape["githubPushFile"] = (userId, owner, repoName, path, content, message) =>
    Effect.gen(function* () {
      const token = yield* requireToken(userId, "github");
      // Contents API upsert: GET current sha (if exists) then PUT.
      const getRes = yield* Effect.tryPromise({
        try: () =>
          fetch(`${GITHUB_API}/repos/${owner}/${repoName}/contents/${path}`, {
            headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" },
          }),
        catch: (cause) => new IntegrationError({ message: "GitHub file lookup failed.", cause }),
      });
      let sha: string | undefined;
      if (getRes.ok) {
        const existing = (yield* Effect.tryPromise({
          try: () => getRes.json() as Promise<{ sha?: string }>,
          catch: (cause) => new IntegrationError({ message: "Unreadable GitHub response.", cause }),
        }));
        sha = existing.sha;
      }
      const putRes = yield* Effect.tryPromise({
        try: () =>
          fetch(`${GITHUB_API}/repos/${owner}/${repoName}/contents/${path}`, {
            method: "PUT",
            headers: {
              authorization: `Bearer ${token}`,
              accept: "application/vnd.github+json",
              "content-type": "application/json",
            },
            body: JSON.stringify({
              message,
              content: Buffer.from(content, "utf8").toString("base64"),
              ...(sha ? { sha } : {}),
            }),
          }),
        catch: (cause) => new IntegrationError({ message: "GitHub file write failed.", cause }),
      });
      if (!putRes.ok) {
        const parsed: { message?: string } | undefined = yield* Effect.tryPromise({
          try: () => putRes.json() as Promise<{ message?: string }>,
          catch: () => undefined,
        }).pipe(Effect.catch(() => Effect.succeed(undefined as { message?: string } | undefined)));
        return yield* fail(`GitHub file write failed: ${parsed?.message ?? putRes.statusText}`, putRes.status);
      }
    });

  const githubListBranches: ExternalIntegrationsShape["githubListBranches"] = (userId, owner, repoName) =>
    Effect.gen(function* () {
      const token = yield* requireToken(userId, "github");
      const res = yield* Effect.tryPromise({
        try: () =>
          fetch(`${GITHUB_API}/repos/${owner}/${repoName}/branches`, {
            headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" },
          }),
        catch: (cause) => new IntegrationError({ message: "GitHub branch list failed.", cause }),
      });
      const body = (yield* Effect.tryPromise({
        try: () => res.json() as Promise<Array<{ name: string }> | { message?: string }>,
        catch: (cause) => new IntegrationError({ message: "Unreadable GitHub response.", cause }),
      }));
      if (!res.ok || !Array.isArray(body)) {
        const msg = !Array.isArray(body) ? body.message : undefined;
        return yield* fail(`GitHub branch list failed: ${msg ?? res.statusText}`, res.status);
      }
      return body.map((b) => b.name);
    });

  const cfFetch = (userId: UserId, path: string, init?: RequestInit) =>
    Effect.gen(function* () {
      const token = yield* requireToken(userId, "cloudflare");
      const res = yield* Effect.tryPromise({
        try: () =>
          fetch(`${CLOUDFLARE_API}${path}`, {
            ...init,
            headers: { authorization: `Bearer ${token}`, ...(init?.headers ?? {}) },
          }),
        catch: (cause) => new IntegrationError({ message: `Cloudflare request failed: ${path}`, cause }),
      });
      return res;
    });

  const cloudflareCreatePagesProject: ExternalIntegrationsShape["cloudflareCreatePagesProject"] = (
    userId,
    accountId,
    name,
  ) =>
    Effect.gen(function* () {
      const res = yield* cfFetch(userId, `/accounts/${accountId}/pages/projects`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, production_branch: "main" }),
      });
      const body = (yield* Effect.tryPromise({
        try: () => res.json() as Promise<{ success: boolean; result?: { subdomain: string }; errors?: Array<{ message: string }> }>,
        catch: (cause) => new IntegrationError({ message: "Unreadable Cloudflare response.", cause }),
      }));
      if (!body.success || !body.result) {
        return yield* fail(`Cloudflare Pages project creation failed: ${body.errors?.[0]?.message ?? "unknown error"}`, res.status);
      }
      return { subdomain: body.result.subdomain };
    });

  const cloudflareDeployPages: ExternalIntegrationsShape["cloudflareDeployPages"] = (
    userId,
    accountId,
    projectName,
    files,
  ) =>
    Effect.gen(function* () {
      const token = yield* requireToken(userId, "cloudflare");
      const form = new FormData();
      for (const [path, content] of files) {
        form.append(path.replace(/^\/+/, ""), new Blob([content]), path.replace(/^\/+/, ""));
      }
      const res = yield* Effect.tryPromise({
        try: () =>
          fetch(`${CLOUDFLARE_API}/accounts/${accountId}/pages/projects/${projectName}/deployments`, {
            method: "POST",
            headers: { authorization: `Bearer ${token}` },
            body: form,
          }),
        catch: (cause) => new IntegrationError({ message: "Cloudflare Pages deploy request failed.", cause }),
      });
      const body = (yield* Effect.tryPromise({
        try: () => res.json() as Promise<{ success: boolean; result?: { url: string }; errors?: Array<{ message: string }> }>,
        catch: (cause) => new IntegrationError({ message: "Unreadable Cloudflare response.", cause }),
      }));
      if (!body.success || !body.result) {
        return yield* fail(`Cloudflare Pages deploy failed: ${body.errors?.[0]?.message ?? "unknown error"}`, res.status);
      }
      return { deploymentUrl: body.result.url, projectName } satisfies PagesDeployResult;
    });

  const cloudflareConnectDomain: ExternalIntegrationsShape["cloudflareConnectDomain"] = (
    userId,
    accountId,
    domain,
  ) =>
    Effect.gen(function* () {
      const res = yield* cfFetch(userId, `/zones`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: domain, account: { id: accountId } }),
      });
      const body = (yield* Effect.tryPromise({
        try: () =>
          res.json() as Promise<{
            success: boolean;
            result?: { id: string; name_servers: string[]; status: string };
            errors?: Array<{ message: string }>;
          }>,
        catch: (cause) => new IntegrationError({ message: "Unreadable Cloudflare response.", cause }),
      }));
      if (!body.success || !body.result) {
        return yield* fail(`Zone creation failed: ${body.errors?.[0]?.message ?? "unknown error"}`, res.status);
      }
      // Best-effort registrar hint via a plain DNS lookup of the domain's current NS records
      // is left to the caller (frontend/route layer) — this service just returns Cloudflare's
      // own zone data; no external WHOIS dependency belongs in this module.
      return {
        zoneId: body.result.id,
        nameServers: body.result.name_servers,
        registrarHint: null,
        status: body.result.status,
      } satisfies ZoneConnectResult;
    });

  const cloudflareZoneStatus: ExternalIntegrationsShape["cloudflareZoneStatus"] = (userId, zoneId) =>
    Effect.gen(function* () {
      const res = yield* cfFetch(userId, `/zones/${zoneId}`);
      const body = (yield* Effect.tryPromise({
        try: () => res.json() as Promise<{ success: boolean; result?: { status: string } }>,
        catch: (cause) => new IntegrationError({ message: "Unreadable Cloudflare response.", cause }),
      }));
      if (!body.success || !body.result) return yield* fail("Zone status lookup failed.", res.status);
      return body.result.status;
    });

  const cloudflarePurgeCache: ExternalIntegrationsShape["cloudflarePurgeCache"] = (userId, zoneId) =>
    Effect.gen(function* () {
      const res = yield* cfFetch(userId, `/zones/${zoneId}/purge_cache`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ purge_everything: true }),
      });
      const body = (yield* Effect.tryPromise({
        try: () => res.json() as Promise<{ success: boolean; errors?: Array<{ message: string }> }>,
        catch: (cause) => new IntegrationError({ message: "Unreadable Cloudflare response.", cause }),
      }));
      if (!body.success) return yield* fail(`Cache purge failed: ${body.errors?.[0]?.message ?? "unknown error"}`, res.status);
    });

  const cloudflareZoneAnalytics: ExternalIntegrationsShape["cloudflareZoneAnalytics"] = (userId, zoneId) =>
    Effect.gen(function* () {
      const res = yield* cfFetch(userId, `/zones/${zoneId}/analytics/dashboard?since=-1440&until=0`);
      const body = (yield* Effect.tryPromise({
        try: () =>
          res.json() as Promise<{
            success: boolean;
            result?: { totals?: { requests?: { all?: number }; uniques?: { all?: number } } };
          }>,
        catch: (cause) => new IntegrationError({ message: "Unreadable Cloudflare response.", cause }),
      }));
      if (!body.success) return yield* fail("Zone analytics lookup failed.", res.status);
      return {
        requests: body.result?.totals?.requests?.all ?? 0,
        uniqueVisitors: body.result?.totals?.uniques?.all ?? 0,
      };
    });

  return {
    isConfigured,
    startAuthorize,
    handleCallback,
    connectionStatus,
    disconnect,
    githubCreateRepo,
    githubPushFile,
    githubListBranches,
    cloudflareCreatePagesProject,
    cloudflareDeployPages,
    cloudflareConnectDomain,
    cloudflareZoneStatus,
    cloudflarePurgeCache,
    cloudflareZoneAnalytics,
    getRawToken,
  } satisfies ExternalIntegrationsShape;
});

export const ExternalIntegrationsLive = Layer.effect(ExternalIntegrations, makeExternalIntegrations);
