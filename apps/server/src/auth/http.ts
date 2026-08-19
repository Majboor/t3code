import {
  type AuthOnboardingStep,
  type AuthBearerBootstrapResult,
  type AuthOnboardingState,
  AuthBootstrapInput,
  AuthCreatePairingCredentialInput,
  AuthPasswordInput,
  AuthRevokeClientSessionInput,
  AuthRevokePairingLinkInput,
  AuthUpdateUserProfileInput,
  type AuthWebSocketTokenResult,
  type ServerAuthPolicy,
} from "@t3tools/contracts";
import { DateTime, Effect, Schema } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { ServerConfig } from "../config.ts";
import {
  authPolicyAutoIssuesOwnerSessions,
  isBasicAuthEnabled,
  resolveConfiguredAuthPolicy,
} from "./Layers/ServerAuthPolicy.ts";
import { AuthError, ServerAuth } from "./Services/ServerAuth.ts";
import { SessionCredentialService } from "./Services/SessionCredentialService.ts";
import { deriveAuthClientMetadata } from "./utils.ts";

export function resolveAuthOnboardingStep(
  tenantStatus: AuthOnboardingState["profile"]["tenantStatus"],
): AuthOnboardingStep {
  if (tenantStatus === "pending-membership") {
    return "accept-invite";
  }

  if (tenantStatus === "none") {
    return "create-workspace";
  }

  return "paired";
}

export const respondToAuthError = (error: AuthError) =>
  Effect.gen(function* () {
    if ((error.status ?? 500) >= 500) {
      yield* Effect.logError("auth route failed", {
        message: error.message,
        cause: error.cause,
      });
    }
    return HttpServerResponse.jsonUnsafe(
      {
        error: error.message,
      },
      { status: error.status ?? 500 },
    );
  });

/**
 * Header names that nothing but an intermediary puts on a request.
 *
 * A browser talking straight to this port sends none of them; a tunnel, reverse
 * proxy, or load balancer adds at least one, because that is how the real client
 * address survives the hop. Their presence is therefore evidence that the socket's
 * 127.0.0.1 belongs to the proxy and not to the person we would be handing an
 * owner session to.
 *
 * What this does NOT cover, stated plainly for whoever is deciding whether it is
 * safe to expose their laptop:
 * - Anything that can already open a TCP connection to this port — other local
 *   users, other processes, a browser tab on this machine following a link — can
 *   forge these headers. That only ever *costs* the forger a session, so the
 *   failure direction is safe, but do not read this list as an authenticator.
 * - A proxy configured to strip forwarding headers defeats it entirely. Nothing
 *   about such a request is distinguishable from a local browser, which is why
 *   `publishedBeyondLoopback` exists and why the desktop tunnel refuses to start
 *   in front of an auto-issuing policy instead of relying on this check.
 */
const PROXY_EVIDENCE_HEADERS = [
  "forwarded",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-real-ip",
  "x-original-forwarded-for",
  "cf-connecting-ip",
  "cf-ray",
  "cf-visitor",
] as const;

export const LOCAL_SESSION_REFUSED_HEADER = "x-t3-auth-local-session-refused";
export const LOCAL_SESSION_REFUSED_REASON_HEADER = "x-t3-auth-local-session-refused-reason";

export function detectForwardingProxyHeader(
  headers: Readonly<Record<string, string | undefined>>,
): string | null {
  for (const header of PROXY_EVIDENCE_HEADERS) {
    const value = headers[header];
    if (typeof value === "string" && value.trim().length > 0) {
      return header;
    }
  }
  return null;
}

export interface LocalOwnerSessionRefusal {
  readonly code: "server-published" | "request-forwarded";
  readonly message: string;
}

export type LocalOwnerSessionDecision =
  | { readonly issue: true }
  /** `refusal === null` means the policy never auto-issued; there is nothing to explain. */
  | { readonly issue: false; readonly refusal: LocalOwnerSessionRefusal | null };

/**
 * Decides whether this request may be handed an owner session on the strength of
 * looking local.
 *
 * The policy alone is not enough to answer that. `loopback-browser` and
 * `unsafe-no-auth` mean "the only thing that can reach this socket is the person
 * who started it", and the moment a tunnel or proxy is in front of the port that
 * sentence is false while every signal the socket offers still says 127.0.0.1.
 * So the policy states the intent and the two checks below test whether the
 * intent still holds.
 */
export function decideAutoIssuedOwnerSession(input: {
  readonly configuredPolicy: ServerAuthPolicy;
  readonly publishedBeyondLoopback: boolean;
  readonly basicAuthEnabled: boolean;
  readonly forwardedByHeader: string | null;
}): LocalOwnerSessionDecision {
  if (!authPolicyAutoIssuesOwnerSessions(input.configuredPolicy)) {
    return { issue: false, refusal: null };
  }

  // Basic auth is checked by middleware in front of every route, so a request
  // that got here proved it knows the password. Loopback is not what is trusted.
  if (input.basicAuthEnabled) {
    return { issue: true };
  }

  if (input.publishedBeyondLoopback) {
    return {
      issue: false,
      refusal: {
        code: "server-published",
        message:
          "This server was started as published beyond loopback, so it will not issue an owner session just because a request arrived from 127.0.0.1. Pair with a one-time token, or restart it without publishing it.",
      },
    };
  }

  if (input.forwardedByHeader) {
    return {
      issue: false,
      refusal: {
        code: "request-forwarded",
        message: `This request was relayed by a proxy (${input.forwardedByHeader}), so its loopback address is the proxy's and not proof that the caller is at this machine. Pair with a one-time token instead.`,
      },
    };
  }

  return { issue: true };
}

export const authSessionRouteLayer = HttpRouter.add(
  "GET",
  "/api/auth/session",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const config = yield* ServerConfig;
    const serverAuth = yield* ServerAuth;
    const sessions = yield* SessionCredentialService;
    const session = yield* serverAuth.getSessionState(request);
    if (session.authenticated || session.auth.localPassword || session.auth.supabase) {
      return HttpServerResponse.jsonUnsafe(session, { status: 200 });
    }

    // Read the posture from configuration rather than from the advertised
    // descriptor: a published server advertises `remote-reachable`, and that
    // rewrite would otherwise hide the reason this route is refusing.
    const configuredPolicy = resolveConfiguredAuthPolicy(config);
    const decision = decideAutoIssuedOwnerSession({
      configuredPolicy,
      publishedBeyondLoopback: config.publishedBeyondLoopback,
      basicAuthEnabled: isBasicAuthEnabled(config),
      forwardedByHeader: detectForwardingProxyHeader(request.headers),
    });

    if (!decision.issue) {
      if (!decision.refusal) {
        return HttpServerResponse.jsonUnsafe(session, { status: 200 });
      }

      yield* Effect.logWarning("refused to auto-issue a local owner session", {
        code: decision.refusal.code,
        configuredPolicy,
      });
      // Still 200 with the ordinary unauthenticated state so the client shows its
      // pairing screen; the headers say why the shortcut was declined, so this is
      // debuggable without reading the server log.
      return HttpServerResponse.jsonUnsafe(session, {
        status: 200,
        headers: {
          [LOCAL_SESSION_REFUSED_HEADER]: decision.refusal.code,
          [LOCAL_SESSION_REFUSED_REASON_HEADER]: decision.refusal.message,
        },
      });
    }

    const authEntryPath = request.headers["x-t3-auth-entry-path"];
    if (authEntryPath === "/invite" || authEntryPath === "/pair") {
      return HttpServerResponse.jsonUnsafe(session, { status: 200 });
    }

    const requestMetadata = deriveAuthClientMetadata({ request });
    const localSession =
      configuredPolicy === "unsafe-no-auth"
        ? yield* serverAuth.issueUnsafeNoAuthOwnerSession(requestMetadata)
        : yield* serverAuth.issueLoopbackOwnerSession(requestMetadata);

    return yield* HttpServerResponse.jsonUnsafe(
      {
        authenticated: true,
        auth: session.auth,
        role: localSession.response.role,
        sessionMethod: localSession.response.sessionMethod,
        expiresAt: localSession.response.expiresAt,
        tenantStatus: "none",
      },
      { status: 200 },
    ).pipe(
      HttpServerResponse.setCookie(sessions.cookieName, localSession.sessionToken, {
        expires: DateTime.toDate(localSession.response.expiresAt),
        httpOnly: true,
        path: "/",
        sameSite: "lax",
      }),
    );
  }),
);

export const authSessionSignOutRouteLayer = HttpRouter.add(
  "POST",
  "/api/auth/session/sign-out",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const sessions = yield* SessionCredentialService;
    const token = request.cookies[sessions.cookieName];
    if (token) {
      yield* sessions.verify(token).pipe(
        Effect.flatMap((session) => sessions.revoke(session.sessionId)),
        Effect.catch(() => Effect.void),
      );
    }

    return yield* HttpServerResponse.jsonUnsafe({ signedOut: true }, { status: 200 }).pipe(
      HttpServerResponse.setCookie(sessions.cookieName, "", {
        expires: new Date(0),
        httpOnly: true,
        path: "/",
        sameSite: "lax",
      }),
    );
  }),
);

export const authProfileRouteLayer = HttpRouter.add(
  "GET",
  "/api/auth/profile",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const serverAuth = yield* ServerAuth;
    const profile = yield* serverAuth.getUserProfile(request);
    return HttpServerResponse.jsonUnsafe(profile, { status: 200 });
  }).pipe(Effect.catchTag("AuthError", (error) => respondToAuthError(error))),
);

export const authProfileUpdateRouteLayer = HttpRouter.add(
  "PATCH",
  "/api/auth/profile",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const serverAuth = yield* ServerAuth;
    const payload = yield* HttpServerRequest.schemaBodyJson(AuthUpdateUserProfileInput).pipe(
      Effect.mapError(
        (cause) =>
          new AuthError({
            message: "Invalid account profile update.",
            status: 400,
            cause,
          }),
      ),
    );
    const profile = yield* serverAuth.updateUserProfile(request, payload);
    return HttpServerResponse.jsonUnsafe(profile, { status: 200 });
  }).pipe(Effect.catchTag("AuthError", (error) => respondToAuthError(error))),
);

export const authOnboardingRouteLayer = HttpRouter.add(
  "GET",
  "/api/auth/onboarding",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const serverAuth = yield* ServerAuth;
    const profile = yield* serverAuth.getUserProfile(request);
    return HttpServerResponse.jsonUnsafe(
      {
        authenticated: true,
        profile,
        nextStep: resolveAuthOnboardingStep(profile.tenantStatus),
      } satisfies AuthOnboardingState,
      { status: 200 },
    );
  }).pipe(Effect.catchTag("AuthError", (error) => respondToAuthError(error))),
);

const PairingCredentialRequestHeaders = Schema.Struct({
  "content-length": Schema.optionalKey(Schema.String),
  "content-type": Schema.optionalKey(Schema.String),
  "transfer-encoding": Schema.optionalKey(Schema.String),
});

function hasRequestBody(headers: typeof PairingCredentialRequestHeaders.Type) {
  const contentLengthHeader = headers["content-length"];
  if (typeof contentLengthHeader === "string") {
    const contentLength = Number.parseInt(contentLengthHeader, 10);
    if (Number.isFinite(contentLength)) {
      return contentLength > 0;
    }
  }
  return typeof headers["transfer-encoding"] === "string";
}

export const authBootstrapRouteLayer = HttpRouter.add(
  "POST",
  "/api/auth/bootstrap",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const serverAuth = yield* ServerAuth;
    const sessions = yield* SessionCredentialService;
    const payload = yield* HttpServerRequest.schemaBodyJson(AuthBootstrapInput).pipe(
      Effect.mapError(
        (cause) =>
          new AuthError({
            message: "Invalid bootstrap payload.",
            status: 400,
            cause,
          }),
      ),
    );
    const result = yield* serverAuth.exchangeBootstrapCredential(
      payload.credential,
      deriveAuthClientMetadata({ request }),
    );

    return yield* HttpServerResponse.jsonUnsafe(result.response, { status: 200 }).pipe(
      HttpServerResponse.setCookie(sessions.cookieName, result.sessionToken, {
        expires: DateTime.toDate(result.response.expiresAt),
        httpOnly: true,
        path: "/",
        sameSite: "lax",
      }),
    );
  }).pipe(Effect.catchTag("AuthError", (error) => respondToAuthError(error))),
);

export const authPasswordRouteLayer = HttpRouter.add(
  "POST",
  "/api/auth/password",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const serverAuth = yield* ServerAuth;
    const sessions = yield* SessionCredentialService;
    const payload = yield* HttpServerRequest.schemaBodyJson(AuthPasswordInput).pipe(
      Effect.mapError(
        (cause) =>
          new AuthError({
            message: "Invalid password auth payload.",
            status: 400,
            cause,
          }),
      ),
    );
    const result = yield* serverAuth.authenticatePassword(
      payload,
      deriveAuthClientMetadata({ request, label: payload.email }),
    );

    return yield* HttpServerResponse.jsonUnsafe(result.response, { status: 200 }).pipe(
      HttpServerResponse.setCookie(sessions.cookieName, result.sessionToken, {
        expires: DateTime.toDate(result.response.expiresAt),
        httpOnly: true,
        path: "/",
        sameSite: "lax",
      }),
    );
  }).pipe(Effect.catchTag("AuthError", (error) => respondToAuthError(error))),
);

export const authBearerBootstrapRouteLayer = HttpRouter.add(
  "POST",
  "/api/auth/bootstrap/bearer",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const serverAuth = yield* ServerAuth;
    const payload = yield* HttpServerRequest.schemaBodyJson(AuthBootstrapInput).pipe(
      Effect.mapError(
        (cause) =>
          new AuthError({
            message: "Invalid bootstrap payload.",
            status: 400,
            cause,
          }),
      ),
    );
    const result = yield* serverAuth.exchangeBootstrapCredentialForBearerSession(
      payload.credential,
      deriveAuthClientMetadata({ request }),
    );
    return HttpServerResponse.jsonUnsafe(result satisfies AuthBearerBootstrapResult, {
      status: 200,
    });
  }).pipe(Effect.catchTag("AuthError", (error) => respondToAuthError(error))),
);

export const authWebSocketTokenRouteLayer = HttpRouter.add(
  "POST",
  "/api/auth/ws-token",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const serverAuth = yield* ServerAuth;
    const session = yield* serverAuth.authenticateHttpRequest(request);
    const result = yield* serverAuth.issueWebSocketToken(session);
    return HttpServerResponse.jsonUnsafe(result satisfies AuthWebSocketTokenResult, {
      status: 200,
    });
  }).pipe(Effect.catchTag("AuthError", (error) => respondToAuthError(error))),
);

export const authPairingCredentialRouteLayer = HttpRouter.add(
  "POST",
  "/api/auth/pairing-token",
  Effect.gen(function* () {
    const serverAuth = yield* ServerAuth;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const session = yield* serverAuth.authenticateHttpRequest(request);
    if (session.role !== "owner") {
      return yield* new AuthError({
        message: "Only owner sessions can create pairing credentials.",
        status: 403,
      });
    }
    const headers = yield* HttpServerRequest.schemaHeaders(PairingCredentialRequestHeaders).pipe(
      Effect.mapError(
        (cause) =>
          new AuthError({
            message: "Invalid pairing credential request headers.",
            status: 400,
            cause,
          }),
      ),
    );
    const payload = hasRequestBody(headers)
      ? yield* HttpServerRequest.schemaBodyJson(AuthCreatePairingCredentialInput).pipe(
          Effect.mapError(
            (cause) =>
              new AuthError({
                message: "Invalid pairing credential payload.",
                status: 400,
                cause,
              }),
          ),
        )
      : {};
    const result = yield* serverAuth.issuePairingCredential(payload);
    return HttpServerResponse.jsonUnsafe(result, { status: 200 });
  }).pipe(Effect.catchTag("AuthError", (error) => respondToAuthError(error))),
);

/**
 * The label a handed-off browser session carries into the Connections list, so a
 * session that appeared without anyone typing a token is identifiable there.
 */
export const BROWSER_HANDOFF_PAIRING_LABEL = "Opened in browser";

/**
 * Mints a pairing credential for the caller's *own* identity, so a client that
 * already holds an owner session can hand that session to a second user agent on
 * the same machine — the system browser, which shares no cookie jar with the
 * desktop renderer.
 *
 * Deliberately a separate route from `POST /api/auth/pairing-token` rather than a
 * flag on it:
 * - That route mints `client`-role credentials under a fresh
 *   `paired-client:<uuid>` subject. Subject is what a user id is derived from when
 *   a session carries no local or tenant account, so a browser paired through it
 *   arrives as a *different person* — a lesser role, and none of the provider
 *   logins the owner connected. It cannot express "the same person".
 * - It is also the route the Connections screen uses to pair other people's
 *   devices. Teaching it to mint owner-role credentials on request would turn
 *   every device-pairing link into an account hand-over, which is a much worse
 *   trade than one extra route.
 *
 * It takes no body and no parameters: role and subject are read off the
 * authenticated caller, so the credential it returns can never grant more than the
 * session that asked for it. The credential itself is the ordinary one-time
 * pairing credential — single use, minutes-long TTL — and nothing here consults or
 * changes the auth policy. `desktop-managed-local` still refuses to auto-issue for
 * anyone who merely reaches the port; this only lets someone who is already inside
 * carry their own session across.
 */
export const authSelfPairingCredentialRouteLayer = HttpRouter.add(
  "POST",
  "/api/auth/pairing-token/self",
  Effect.gen(function* () {
    const serverAuth = yield* ServerAuth;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const session = yield* serverAuth.authenticateHttpRequest(request);
    if (session.role !== "owner") {
      return yield* new AuthError({
        message: "Only owner sessions can hand this session to a browser.",
        status: 403,
      });
    }
    const result = yield* serverAuth.issuePairingCredential({
      role: session.role,
      subject: session.subject,
      label: BROWSER_HANDOFF_PAIRING_LABEL,
    });
    return HttpServerResponse.jsonUnsafe(result, { status: 200 });
  }).pipe(Effect.catchTag("AuthError", (error) => respondToAuthError(error))),
);

const authenticateOwnerSession = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const serverAuth = yield* ServerAuth;
  const session = yield* serverAuth.authenticateHttpRequest(request);
  if (session.role !== "owner") {
    return yield* new AuthError({
      message: "Only owner sessions can manage network access.",
      status: 403,
    });
  }
  return { serverAuth, session } as const;
});

export const authPairingLinksRouteLayer = HttpRouter.add(
  "GET",
  "/api/auth/pairing-links",
  Effect.gen(function* () {
    const { serverAuth } = yield* authenticateOwnerSession;
    const pairingLinks = yield* serverAuth.listPairingLinks();
    return HttpServerResponse.jsonUnsafe(pairingLinks, { status: 200 });
  }).pipe(Effect.catchTag("AuthError", (error) => respondToAuthError(error))),
);

export const authPairingLinksRevokeRouteLayer = HttpRouter.add(
  "POST",
  "/api/auth/pairing-links/revoke",
  Effect.gen(function* () {
    const { serverAuth } = yield* authenticateOwnerSession;
    const payload = yield* HttpServerRequest.schemaBodyJson(AuthRevokePairingLinkInput).pipe(
      Effect.mapError(
        (cause) =>
          new AuthError({
            message: "Invalid revoke pairing link payload.",
            status: 400,
            cause,
          }),
      ),
    );
    const revoked = yield* serverAuth.revokePairingLink(payload.id);
    return HttpServerResponse.jsonUnsafe({ revoked }, { status: 200 });
  }).pipe(Effect.catchTag("AuthError", (error) => respondToAuthError(error))),
);

export const authClientsRouteLayer = HttpRouter.add(
  "GET",
  "/api/auth/clients",
  Effect.gen(function* () {
    const { serverAuth, session } = yield* authenticateOwnerSession;
    const clients = yield* serverAuth.listClientSessions(session.sessionId);
    return HttpServerResponse.jsonUnsafe(clients, { status: 200 });
  }).pipe(Effect.catchTag("AuthError", (error) => respondToAuthError(error))),
);

export const authClientsRevokeRouteLayer = HttpRouter.add(
  "POST",
  "/api/auth/clients/revoke",
  Effect.gen(function* () {
    const { serverAuth, session } = yield* authenticateOwnerSession;
    const payload = yield* HttpServerRequest.schemaBodyJson(AuthRevokeClientSessionInput).pipe(
      Effect.mapError(
        (cause) =>
          new AuthError({
            message: "Invalid revoke client payload.",
            status: 400,
            cause,
          }),
      ),
    );
    const revoked = yield* serverAuth.revokeClientSession(session.sessionId, payload.sessionId);
    return HttpServerResponse.jsonUnsafe({ revoked }, { status: 200 });
  }).pipe(Effect.catchTag("AuthError", (error) => respondToAuthError(error))),
);

export const authClientsRevokeOthersRouteLayer = HttpRouter.add(
  "POST",
  "/api/auth/clients/revoke-others",
  Effect.gen(function* () {
    const { serverAuth, session } = yield* authenticateOwnerSession;
    const revokedCount = yield* serverAuth.revokeOtherClientSessions(session.sessionId);
    return HttpServerResponse.jsonUnsafe({ revokedCount }, { status: 200 });
  }).pipe(Effect.catchTag("AuthError", (error) => respondToAuthError(error))),
);
