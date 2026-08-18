import type {
  ServerAuthDescriptor,
  ServerAuthPolicy as ServerAuthPolicyName,
} from "@t3tools/contracts";
import { Effect, Layer } from "effect";

import { ServerConfig, type ServerConfigShape } from "../../config.ts";
import { ServerAuthPolicy, type ServerAuthPolicyShape } from "../Services/ServerAuthPolicy.ts";
import { resolveSessionCookieName } from "../utils.ts";
import { isLoopbackHost, isWildcardHost } from "../../startupAccess.ts";

/**
 * The slice of configuration that decides the auth posture. Narrowed so callers
 * that only want the policy — the session route, tests — do not have to build a
 * whole server config to ask.
 */
export type ServerAuthPolicyConfig = Pick<
  ServerConfigShape,
  | "host"
  | "mode"
  | "unsafeNoAuth"
  | "basicAuthUsername"
  | "basicAuthPassword"
  | "publishedBeyondLoopback"
>;

export const isBasicAuthEnabled = (config: ServerAuthPolicyConfig): boolean =>
  config.basicAuthUsername !== undefined && config.basicAuthPassword !== undefined;

/**
 * These two policies let `GET /api/auth/session` mint an owner session for any
 * caller, on the theory that only the person at the keyboard can open the socket.
 * Everything that publishes a server has to know which policies carry that
 * assumption, so the list lives here rather than being re-typed at each use.
 */
export const authPolicyAutoIssuesOwnerSessions = (policy: ServerAuthPolicyName): boolean =>
  policy === "loopback-browser" || policy === "unsafe-no-auth";

/**
 * The posture implied by how the server was started, ignoring whether it was
 * later published. This is what the operator asked for.
 */
export function resolveConfiguredAuthPolicy(config: ServerAuthPolicyConfig): ServerAuthPolicyName {
  const isRemoteReachable = isWildcardHost(config.host) || !isLoopbackHost(config.host);

  return isBasicAuthEnabled(config) || config.unsafeNoAuth
    ? "unsafe-no-auth"
    : config.mode === "desktop"
      ? isRemoteReachable
        ? "remote-reachable"
        : "desktop-managed-local"
      : isRemoteReachable
        ? "remote-reachable"
        : "loopback-browser";
}

/**
 * The posture the server is willing to tell clients about.
 *
 * A published server that would otherwise auto-issue owner sessions is advertised
 * as `remote-reachable` instead, because that is now the truth: strangers can
 * reach it and they have to pair like any other remote device. Advertising it
 * also hands clients the pairing UI they need, rather than a login screen that
 * silently never appears.
 *
 * Basic auth is the exception. It keeps the `unsafe-no-auth` policy name, but the
 * middleware in front of every route has already proved the caller knows the
 * password, so loopback is not what is being trusted there.
 */
export function resolveAdvertisedAuthPolicy(config: ServerAuthPolicyConfig): ServerAuthPolicyName {
  const configured = resolveConfiguredAuthPolicy(config);
  if (!config.publishedBeyondLoopback) return configured;
  if (isBasicAuthEnabled(config)) return configured;
  return authPolicyAutoIssuesOwnerSessions(configured) ? "remote-reachable" : configured;
}

export const makeServerAuthPolicy = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const policy = resolveAdvertisedAuthPolicy(config);

  const bootstrapMethods: ServerAuthDescriptor["bootstrapMethods"] =
    policy === "unsafe-no-auth"
      ? []
      : policy === "desktop-managed-local"
        ? ["desktop-bootstrap"]
        : config.mode === "desktop" && policy === "remote-reachable"
          ? ["desktop-bootstrap", "one-time-token"]
          : ["one-time-token"];
  const supabasePublicConfig: ServerAuthDescriptor["supabase"] =
    config.supabaseProjectUrl && config.supabaseAnonKey
      ? {
          projectUrl: config.supabaseProjectUrl.toString(),
          anonKey: config.supabaseAnonKey,
          ...(config.supabaseJwtAudience ? { audience: config.supabaseJwtAudience } : {}),
        }
      : undefined;
  const localPasswordConfig: ServerAuthDescriptor["localPassword"] = config.localPasswordAuth
    ? { enabled: true }
    : undefined;

  const descriptor: ServerAuthDescriptor = {
    policy,
    bootstrapMethods,
    sessionMethods: ["browser-session-cookie", "bearer-session-token"],
    sessionCookieName: resolveSessionCookieName({
      mode: config.mode,
      port: config.port,
    }),
    ...(supabasePublicConfig ? { supabase: supabasePublicConfig } : {}),
    ...(localPasswordConfig ? { localPassword: localPasswordConfig } : {}),
  };

  return {
    getDescriptor: () => Effect.succeed(descriptor),
  } satisfies ServerAuthPolicyShape;
});

export const ServerAuthPolicyLive = Layer.effect(ServerAuthPolicy, makeServerAuthPolicy);
