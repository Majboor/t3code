/**
 * GitHub / Cloudflare OAuth connections + real actions on a user's behalf
 * (create/push a repo, deploy a Cloudflare Pages project, connect a custom
 * domain). Config-gated the same way as LogicPacksGateway — absent client
 * id/secret env vars means every method is a no-op / typed "not configured"
 * error, so the same build runs everywhere with this off except where the
 * four env vars are set.
 */
import { Context, Option } from "effect";
import type { Effect } from "effect";

import type { UserId } from "@t3tools/contracts";

export class IntegrationError extends Error {
  readonly _tag = "IntegrationError";
  readonly status: number;
  constructor(args: { message: string; status?: number; cause?: unknown }) {
    super(args.message, { cause: args.cause });
    this.status = args.status ?? 500;
  }
}

export interface AuthorizeUrlResult {
  readonly url: string;
  readonly state: string;
}

export interface RepoActionResult {
  readonly htmlUrl: string;
  readonly defaultBranch: string;
}

export interface PagesDeployResult {
  readonly deploymentUrl: string;
  readonly projectName: string;
}

export interface ZoneConnectResult {
  readonly zoneId: string;
  readonly nameServers: ReadonlyArray<string>;
  readonly registrarHint: string | null;
  readonly status: string;
}

export interface ExternalIntegrationsShape {
  readonly isConfigured: (provider: "github" | "cloudflare") => boolean;
  readonly startAuthorize: (
    userId: UserId,
    provider: "github" | "cloudflare",
  ) => Effect.Effect<AuthorizeUrlResult, IntegrationError>;
  readonly handleCallback: (
    provider: "github" | "cloudflare",
    code: string,
    state: string,
  ) => Effect.Effect<UserId, IntegrationError>;
  readonly connectionStatus: (
    userId: UserId,
  ) => Effect.Effect<
    { github: { connected: boolean; label: string | null }; cloudflare: { connected: boolean; label: string | null } },
    IntegrationError
  >;
  readonly disconnect: (
    userId: UserId,
    provider: "github" | "cloudflare",
  ) => Effect.Effect<void, IntegrationError>;

  readonly githubCreateRepo: (
    userId: UserId,
    name: string,
    isPrivate: boolean,
  ) => Effect.Effect<RepoActionResult, IntegrationError>;
  readonly githubPushFile: (
    userId: UserId,
    owner: string,
    repo: string,
    path: string,
    content: string,
    message: string,
  ) => Effect.Effect<void, IntegrationError>;
  readonly githubListBranches: (
    userId: UserId,
    owner: string,
    repo: string,
  ) => Effect.Effect<ReadonlyArray<string>, IntegrationError>;

  readonly cloudflareCreatePagesProject: (
    userId: UserId,
    accountId: string,
    name: string,
  ) => Effect.Effect<{ subdomain: string }, IntegrationError>;
  readonly cloudflareDeployPages: (
    userId: UserId,
    accountId: string,
    projectName: string,
    files: ReadonlyMap<string, string>,
  ) => Effect.Effect<PagesDeployResult, IntegrationError>;
  readonly cloudflareConnectDomain: (
    userId: UserId,
    accountId: string,
    domain: string,
  ) => Effect.Effect<ZoneConnectResult, IntegrationError>;
  readonly cloudflareZoneStatus: (
    userId: UserId,
    zoneId: string,
  ) => Effect.Effect<string, IntegrationError>;
  readonly cloudflarePurgeCache: (
    userId: UserId,
    zoneId: string,
  ) => Effect.Effect<void, IntegrationError>;
  readonly cloudflareZoneAnalytics: (
    userId: UserId,
    zoneId: string,
  ) => Effect.Effect<{ requests: number; uniqueVisitors: number }, IntegrationError>;

  /** For per-session agent CLI injection — the raw token, if connected. */
  readonly getRawToken: (
    userId: UserId,
    provider: "github" | "cloudflare",
  ) => Effect.Effect<Option.Option<string>, IntegrationError>;
}

export class ExternalIntegrations extends Context.Service<
  ExternalIntegrations,
  ExternalIntegrationsShape
>()("t3/integrations/Services/ExternalIntegrations") {}
