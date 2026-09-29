import type {
  AuthBearerBootstrapResult,
  AuthBootstrapResult,
  AuthClientMetadata,
  AuthPasswordInput,
  AuthClientSession,
  AuthCreatePairingCredentialInput,
  AuthPairingLink,
  AuthPairingCredentialResult,
  AuthSessionId,
  AuthSessionState,
  AuthUpdateUserProfileInput,
  AuthUserProfile,
  CompleteOnboardingInput,
  ServerAuthDescriptor,
  ServerAuthSessionMethod,
  AuthWebSocketTokenResult,
  TenantSessionContext,
  UpdateUserPreferencesInput,
  UserPreferences,
} from "@t3tools/contracts";
import { UserId } from "@t3tools/contracts";
import { Data, DateTime, Context } from "effect";
import type { Duration, Effect } from "effect";
import type * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import type { SessionRole } from "./SessionCredentialService.ts";
import type { LocalAuthAccountRecord } from "../../persistence/Services/LocalAuthAccounts.ts";

export interface AuthenticatedSession {
  readonly sessionId: AuthSessionId;
  readonly subject: string;
  readonly method: ServerAuthSessionMethod;
  readonly role: SessionRole;
  readonly client: AuthClientMetadata;
  readonly userId?: UserId;
  /**
   * The address the identity provider says this session belongs to, when it
   * says anything at all.
   *
   * Present for a session established from a Supabase token, whose claims
   * carry one. Absent for a local-account session — that address lives in the
   * account record and is read with `resolveLocalAccount` — and absent for the
   * loopback owner, who is a machine rather than a person.
   *
   * Whatever reads this must treat "absent" as "this session cannot prove an
   * address", never as "any address will do". `shareLinks` is the first caller
   * and refuses an email-scoped link outright when it finds nothing here and
   * nothing on the account.
   */
  readonly email?: string;
  readonly expiresAt?: DateTime.DateTime;
  readonly tenantSessionContext?: TenantSessionContext;
}

export const LOOPBACK_OWNER_SUBJECT = "loopback-local-owner";
export const UNSAFE_NO_AUTH_OWNER_SUBJECT = "unsafe-no-auth-owner";
export const DESKTOP_BOOTSTRAP_SUBJECT = "desktop-bootstrap";

/**
 * The subjects that mean "whoever is at this machine", as opposed to somebody
 * who signed up. They own the install, so they get a personal tenant the same
 * way a signed-up account does.
 *
 * This list lives here rather than beside the code that provisions the tenant
 * because two places have to agree about it: whoever hands these sessions a
 * tenant, and everything that has to keep treating them as the owner of the
 * machine afterwards. When those two lists drifted, the desktop app's own
 * window became a guest on its own server.
 */
const MACHINE_OWNER_SUBJECTS: ReadonlySet<string> = new Set([
  DESKTOP_BOOTSTRAP_SUBJECT,
  LOOPBACK_OWNER_SUBJECT,
  UNSAFE_NO_AUTH_OWNER_SUBJECT,
]);

/**
 * Whether this session is the machine's own owner rather than a guest.
 *
 * A machine owner carries a personal tenant, because owning the install has to
 * mean owning something nameable. That tenant is an identity, not a lease on
 * somebody else's server: the quotas, the provider-account isolation and the
 * tenant scoping all exist to keep strangers apart on a shared host, and none
 * of them should switch on because the desktop app finally has a tenant id.
 *
 * So anything asking "is this a guest?" must ask it here. Asking
 * `session.tenantSessionContext === undefined` used to mean the same thing and
 * no longer does.
 */
export function isMachineOwnerSession(session: AuthenticatedSession): boolean {
  return MACHINE_OWNER_SUBJECTS.has(session.subject);
}

export function isMachineOwnerSubject(subject: string): boolean {
  return MACHINE_OWNER_SUBJECTS.has(subject);
}

/** The subject a local password account signs in as. */
export const LOCAL_ACCOUNT_SUBJECT_PREFIX = "local-user:";

/**
 * Whether this session is the only person who could be here.
 *
 * A local password account is issued the `client` role, which is right on a
 * server that holds accounts for other people and wrong on a desktop install,
 * where the person who signed in is the person who owns the machine. Left as a
 * guest they get the rationing written for strangers sharing a host — 120 RPCs
 * a minute, and a workspace panel that cannot finish listing its own files.
 *
 * Three things have to be true, and loopback is deliberately not one of them: a
 * proxy connects from 127.0.0.1 exactly like the owner's browser does. This
 * server has to be the one holding the projects, whoever started it has to have
 * declared that nothing in front of it carries strangers here, and there has to
 * be nobody else who could sign in.
 *
 * That last one used to be missing, and its absence was the whole bug: the
 * predicate asked whether the INSTALL looked single-occupant and never whether
 * the ACCOUNT was alone on it. `publishedBeyondLoopback` defaults to false and
 * is only ever set by an opt-in env var, so on an ordinary `bun run dev` with
 * local password auth every account satisfied it at once. Each of them then
 * read as the machine's owner: tenant filtering skipped entirely, permission
 * checks returning immediately, and two people signed up on one server each
 * seeing and writing all of the other's projects.
 *
 * `localAccountCount` is required rather than optional on purpose. An optional
 * count is one a caller can forget, and a caller that forgets it gets the old
 * behaviour silently — the failure mode this function exists to prevent,
 * reintroduced by omission. Required, the typechecker names every site that
 * has to answer the question.
 */
export function isSoleOccupantSession(
  session: AuthenticatedSession,
  install: {
    readonly workspaceSource: "this-server" | "paired-environment";
    readonly publishedBeyondLoopback: boolean;
    /** Local password accounts that can currently sign in. */
    readonly localAccountCount: number;
  },
): boolean {
  if (isMachineOwnerSession(session)) {
    return true;
  }
  return (
    session.subject.startsWith(LOCAL_ACCOUNT_SUBJECT_PREFIX) &&
    install.workspaceSource === "this-server" &&
    !install.publishedBeyondLoopback &&
    // One account is the desktop case this allowance was written for. Two is a
    // server with guests on it, whatever it was started as.
    install.localAccountCount <= 1
  );
}

/**
 * The one rule for which user a session belongs to.
 *
 * Every entry point that records who did something has to reach the same
 * answer, or the same person is two people depending on how they connected.
 */
export function resolveAuthenticatedUserId(session: AuthenticatedSession): UserId {
  return (
    session.tenantSessionContext?.userId ??
    session.userId ??
    UserId.make(`auth:${session.subject.trim() || session.sessionId}`)
  );
}

export class AuthError extends Data.TaggedError("AuthError")<{
  readonly message: string;
  readonly status?: 400 | 401 | 403 | 429 | 500;
  readonly cause?: unknown;
}> {}

export interface ServerAuthShape {
  readonly getDescriptor: () => Effect.Effect<ServerAuthDescriptor>;
  readonly getSessionState: (
    request: HttpServerRequest.HttpServerRequest,
  ) => Effect.Effect<AuthSessionState, never>;
  readonly getUserProfile: (
    request: HttpServerRequest.HttpServerRequest,
  ) => Effect.Effect<AuthUserProfile, AuthError>;
  readonly resolveUserProfile: (
    session: AuthenticatedSession,
  ) => Effect.Effect<AuthUserProfile, AuthError>;
  readonly resolveLocalAccount: (
    session: AuthenticatedSession,
  ) => Effect.Effect<LocalAuthAccountRecord | undefined, AuthError>;
  readonly updateUserProfile: (
    request: HttpServerRequest.HttpServerRequest,
    input: AuthUpdateUserProfileInput,
  ) => Effect.Effect<AuthUserProfile, AuthError>;
  readonly getUserPreferences: (
    request: HttpServerRequest.HttpServerRequest,
  ) => Effect.Effect<UserPreferences, AuthError>;
  readonly completeOnboarding: (
    request: HttpServerRequest.HttpServerRequest,
    input: CompleteOnboardingInput,
  ) => Effect.Effect<UserPreferences, AuthError>;
  readonly updateUserPreferences: (
    request: HttpServerRequest.HttpServerRequest,
    input: UpdateUserPreferencesInput,
  ) => Effect.Effect<UserPreferences, AuthError>;
  readonly issueLoopbackOwnerSession: (requestMetadata: AuthClientMetadata) => Effect.Effect<
    {
      readonly response: AuthBootstrapResult;
      readonly sessionToken: string;
    },
    AuthError
  >;
  readonly issueUnsafeNoAuthOwnerSession: (requestMetadata: AuthClientMetadata) => Effect.Effect<
    {
      readonly response: AuthBootstrapResult;
      readonly sessionToken: string;
    },
    AuthError
  >;
  readonly exchangeBootstrapCredential: (
    credential: string,
    requestMetadata: AuthClientMetadata,
  ) => Effect.Effect<
    {
      readonly response: AuthBootstrapResult;
      readonly sessionToken: string;
    },
    AuthError
  >;
  readonly authenticatePassword: (
    input: AuthPasswordInput,
    requestMetadata: AuthClientMetadata,
  ) => Effect.Effect<
    {
      readonly response: AuthBootstrapResult;
      readonly sessionToken: string;
    },
    AuthError
  >;
  readonly exchangeBootstrapCredentialForBearerSession: (
    credential: string,
    requestMetadata: AuthClientMetadata,
  ) => Effect.Effect<AuthBearerBootstrapResult, AuthError>;
  readonly issuePairingCredential: (
    input?: AuthCreatePairingCredentialInput & {
      readonly role?: SessionRole;
      readonly subject?: string;
    },
  ) => Effect.Effect<AuthPairingCredentialResult, AuthError>;
  readonly listPairingLinks: () => Effect.Effect<ReadonlyArray<AuthPairingLink>, AuthError>;
  readonly revokePairingLink: (id: string) => Effect.Effect<boolean, AuthError>;
  readonly listClientSessions: (
    currentSessionId: AuthSessionId,
  ) => Effect.Effect<ReadonlyArray<AuthClientSession>, AuthError>;
  readonly revokeClientSession: (
    currentSessionId: AuthSessionId,
    targetSessionId: AuthSessionId,
  ) => Effect.Effect<boolean, AuthError>;
  readonly revokeOtherClientSessions: (
    currentSessionId: AuthSessionId,
  ) => Effect.Effect<number, AuthError>;
  readonly authenticateHttpRequest: (
    request: HttpServerRequest.HttpServerRequest,
  ) => Effect.Effect<AuthenticatedSession, AuthError>;
  readonly authenticateWebSocketUpgrade: (
    request: HttpServerRequest.HttpServerRequest,
  ) => Effect.Effect<AuthenticatedSession, AuthError>;
  readonly issueWebSocketToken: (
    session: AuthenticatedSession,
  ) => Effect.Effect<AuthWebSocketTokenResult, AuthError>;
  readonly issueStartupPairingUrl: (baseUrl: string) => Effect.Effect<string, AuthError>;
  /**
   * A bearer token that acts as a person, for something the server starts on
   * their behalf and hands to a process rather than to them.
   *
   * It exists because an agent in a turn had no credential at all: `t3 box run`
   * from inside a turn refused before it reached a machine, which made the
   * whole box chain end one link short of the thing it was built for. Handing
   * over the person's own live session instead would have been fewer moving
   * parts and the wrong shape — that session belongs to a browser tab, outlives
   * the work, and cannot be revoked without signing them out of everything.
   *
   * The `userId` is the whole point: every account-scoped check downstream
   * (which boxes are yours, whose provider account pays) reads the identity off
   * the session, so a token that authenticates as *somebody* but not as *this
   * person* would be worse than none — it would fail as "no such box".
   */
  readonly issueDelegatedUserSession: (input: {
    readonly userId: UserId;
    /** Shown in `t3 auth session list`, so a person can tell what asked for it. */
    readonly label: string;
    readonly ttl: Duration.Duration;
  }) => Effect.Effect<
    {
      readonly sessionId: AuthSessionId;
      readonly token: string;
      readonly expiresAt: DateTime.DateTime;
    },
    AuthError
  >;
}

export class ServerAuth extends Context.Service<ServerAuth, ServerAuthShape>()(
  "t3/auth/Services/ServerAuth",
) {}
