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
  ServerAuthDescriptor,
  ServerAuthSessionMethod,
  AuthWebSocketTokenResult,
  TenantSessionContext,
  UserId,
} from "@t3tools/contracts";
import { Data, DateTime, Context } from "effect";
import type { Effect } from "effect";
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
  readonly expiresAt?: DateTime.DateTime;
  readonly tenantSessionContext?: TenantSessionContext;
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
}

export class ServerAuth extends Context.Service<ServerAuth, ServerAuthShape>()(
  "t3/auth/Services/ServerAuth",
) {}
