import {
  type AuthBearerBootstrapResult,
  type AuthClientSession,
  type AuthClientMetadata,
  type AuthBootstrapResult,
  type AuthPasswordInput,
  type AuthPairingCredentialResult,
  type AuthSessionState,
  type AuthUpdateUserProfileInput,
  type AuthUserProfile,
  AuthSessionId,
  type TenantSessionContext,
  type Tenant,
  TenantId,
  type TenantMembership,
  MembershipId,
  TenantRuntimeId,
  type TenantRole,
  type Workspace,
  WorkspaceId,
  UserId,
  type AuthWebSocketTokenResult,
  AUTH_AVATAR_IMAGE_MIME_TYPES,
  AUTH_AVATAR_MAX_DECODED_BYTES,
} from "@t3tools/contracts";
import { randomBytes, scrypt as nodeScrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { DateTime, Effect, Layer, Option } from "effect";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";

import { ServerConfig } from "../../config.ts";
import { TenancyRepositoryLive } from "../../persistence/Layers/Tenancy.ts";
import { TenancyRepository } from "../../persistence/Services/Tenancy.ts";
import { AuthUserProfileRepositoryLive } from "../../persistence/Layers/AuthUserProfiles.ts";
import { AuthUserProfileRepository } from "../../persistence/Services/AuthUserProfiles.ts";
import { LocalAuthAccountRepositoryLive } from "../../persistence/Layers/LocalAuthAccounts.ts";
import { LocalAuthAccountRepository } from "../../persistence/Services/LocalAuthAccounts.ts";
import { AuthControlPlane } from "../Services/AuthControlPlane.ts";
import { ServerAuthPolicyLive } from "./ServerAuthPolicy.ts";
import { BootstrapCredentialService } from "../Services/BootstrapCredentialService.ts";
import { BootstrapCredentialError } from "../Services/BootstrapCredentialService.ts";
import { ServerAuthPolicy } from "../Services/ServerAuthPolicy.ts";
import {
  ServerAuth,
  type AuthenticatedSession,
  AuthError,
  type ServerAuthShape,
} from "../Services/ServerAuth.ts";
import {
  SessionCredentialError,
  SessionCredentialService,
} from "../Services/SessionCredentialService.ts";
import { AuthControlPlaneLive, AuthCoreLive } from "./AuthControlPlane.ts";
import { deriveAuthClientMetadata } from "../utils.ts";
import {
  authenticateSupabaseBearerTokenWithRemoteJwks,
  mapSupabaseIdentityToTenantSessionContext,
  readSupabaseActiveWorkspaceIdClaim,
  readSupabaseTenantIdClaim,
  resolveSupabaseAuthBridgeConfig,
  SupabaseAuthBridgeError,
} from "../supabaseAuthBridge.ts";

type BootstrapExchangeResult = {
  readonly response: AuthBootstrapResult;
  readonly sessionToken: string;
};

const LOOPBACK_OWNER_SUBJECT = "loopback-local-owner";
const UNSAFE_NO_AUTH_OWNER_SUBJECT = "unsafe-no-auth-owner";
const DESKTOP_BOOTSTRAP_SUBJECT = "desktop-bootstrap";
const LOCAL_USER_SUBJECT_PREFIX = "local-user:";

/**
 * The subjects that mean "whoever is at this machine", as opposed to somebody
 * who signed up. They own the install, so they get a personal tenant the same
 * way a signed-up account does.
 */
const MACHINE_OWNER_SUBJECTS: ReadonlySet<string> = new Set([
  DESKTOP_BOOTSTRAP_SUBJECT,
  LOOPBACK_OWNER_SUBJECT,
  UNSAFE_NO_AUTH_OWNER_SUBJECT,
]);

const AVATAR_DATA_URL_PATTERN = /^data:([\w.+-]+\/[\w.+-]+);base64,([A-Za-z0-9+/]+={0,2})$/;

const AUTHORIZATION_PREFIX = "Bearer ";
const WEBSOCKET_TOKEN_QUERY_PARAM = "wsToken";
const scryptAsync = promisify(nodeScrypt);
const invalidEmailPassword = Effect.fail(
  new AuthError({
    message: "Invalid email or password.",
    status: 401,
  }),
);

export function toBootstrapExchangeAuthError(cause: BootstrapCredentialError): AuthError {
  if (cause.status === 500) {
    return new AuthError({
      message: "Failed to validate bootstrap credential.",
      status: 500,
      cause,
    });
  }

  return new AuthError({
    message: "Invalid bootstrap credential.",
    status: 401,
    cause,
  });
}

function parseBearerToken(request: HttpServerRequest.HttpServerRequest): string | null {
  const header = request.headers["authorization"];
  if (typeof header !== "string" || !header.startsWith(AUTHORIZATION_PREFIX)) {
    return null;
  }
  const token = header.slice(AUTHORIZATION_PREFIX.length).trim();
  return token.length > 0 ? token : null;
}

export const makeServerAuth = Effect.gen(function* () {
  const policy = yield* ServerAuthPolicy;
  const bootstrapCredentials = yield* BootstrapCredentialService;
  const authControlPlane = yield* AuthControlPlane;
  const sessions = yield* SessionCredentialService;
  const tenancyRepository = yield* TenancyRepository;
  const userProfiles = yield* AuthUserProfileRepository;
  const localAccounts = yield* LocalAuthAccountRepository;
  const serverConfig = yield* ServerConfig;
  const descriptor = yield* policy.getDescriptor();
  const supabaseConfig = resolveSupabaseAuthBridgeConfig(serverConfig);

  const localUserIdFromSubject = (subject: string): UserId | undefined => {
    if (subject.startsWith(LOCAL_USER_SUBJECT_PREFIX)) {
      return UserId.make(subject.slice(LOCAL_USER_SUBJECT_PREFIX.length));
    }
    return undefined;
  };

  /**
   * The user id a session acts as, including the ones that never signed up.
   *
   * A machine's own owner — the desktop app letting its window in, the CLI on
   * loopback, a server started with authentication off — has no email and so no
   * local account, and until now had no user id and no tenant either. Everything
   * scoped to a workspace was therefore dead for them: publishing a pack, an
   * invite, anything reading `organizations.list()`. That is not a policy about
   * single-user installs, it is an omission — the desktop app has exactly one
   * person in it and that person owns the machine.
   *
   * The id is the one those sessions already appear under everywhere else
   * (`toAuthUserProfile` falls back to `auth:<subject>`), so giving them a
   * tenant re-uses the identity their existing threads and provider logins are
   * already filed under rather than minting a second one beside it.
   */
  const sessionUserIdFromSubject = (subject: string): UserId | undefined => {
    const localUserId = localUserIdFromSubject(subject);
    if (localUserId) {
      return localUserId;
    }
    return MACHINE_OWNER_SUBJECTS.has(subject) ? UserId.make(`auth:${subject}`) : undefined;
  };

  const uniqueTenantRoles = (
    memberships: readonly TenantMembership[],
  ): [TenantRole, ...TenantRole[]] | null => {
    const roles = Array.from(new Set(memberships.flatMap((membership) => membership.roles)));
    return roles.length > 0 ? (roles as [TenantRole, ...TenantRole[]]) : null;
  };

  const tenancyLoadError = (cause: unknown): AuthError =>
    new AuthError({
      message: "Failed to load tenant memberships.",
      status: 500,
      cause,
    });

  const provisionPersonalTenant = (input: {
    readonly userId: UserId;
    readonly displayName: string;
  }): Effect.Effect<TenantMembership, AuthError> =>
    Effect.gen(function* () {
      const [organizations, collaboration, workspaces] = yield* Effect.all([
        tenancyRepository.loadOrganizations(),
        tenancyRepository.loadCollaboration(),
        tenancyRepository.loadWorkspaces(),
      ]).pipe(Effect.mapError(tenancyLoadError));
      const existing = [...organizations.memberships, ...collaboration.memberships].find(
        (membership) => membership.userId === input.userId && membership.disabledAt === null,
      );
      if (existing) {
        return existing;
      }
      const now = yield* DateTime.now;
      const createdAt = DateTime.formatIso(DateTime.toUtc(now));
      const suffix = crypto.randomUUID();
      const displayName = input.displayName.trim() || "Personal";
      const tenant: Tenant = {
        id: TenantId.make(`tenant:personal-${suffix}`),
        slug: `personal-${suffix}`,
        displayName,
        kind: "personal",
        organizationId: null,
        runtimeId: TenantRuntimeId.make(`runtime:personal-${suffix}`),
        createdAt,
        archivedAt: null,
      };
      const membership: TenantMembership = {
        id: MembershipId.make(`membership:${crypto.randomUUID()}`),
        tenantId: tenant.id,
        userId: input.userId,
        organizationId: null,
        roles: ["owner"],
        createdAt,
        disabledAt: null,
      };
      const workspace: Workspace = {
        id: WorkspaceId.make(`workspace:${crypto.randomUUID()}`),
        tenantId: tenant.id,
        organizationId: null,
        ownerUserId: input.userId,
        kind: "personal",
        accessMode: "invite-only",
        title: `${displayName}'s Workspace`,
        createdAt,
        archivedAt: null,
      };
      const persistError = (cause: unknown): AuthError =>
        new AuthError({
          message: "Failed to provision personal workspace.",
          status: 500,
          cause,
        });
      yield* tenancyRepository
        .saveOrganizations({
          ...organizations,
          tenants: [...organizations.tenants, tenant],
        })
        .pipe(Effect.mapError(persistError));
      yield* tenancyRepository
        .saveCollaboration({
          ...collaboration,
          memberships: [...collaboration.memberships, membership],
        })
        .pipe(Effect.mapError(persistError));
      yield* tenancyRepository
        .saveWorkspaces({
          workspaces: [...workspaces.workspaces, workspace],
        })
        .pipe(Effect.mapError(persistError));
      yield* Effect.logInfo("auth.onboarding.personal-tenant-provisioned").pipe(
        Effect.annotateLogs({
          userId: input.userId,
          tenantId: tenant.id,
          workspaceId: workspace.id,
        }),
      );
      return membership;
    });

  const resolveLocalTenantSessionContext = (input: {
    readonly sessionId: AuthSessionId;
    readonly subject: string;
    readonly expiresAt?: DateTime.DateTime;
  }): Effect.Effect<TenantSessionContext | undefined, AuthError> =>
    Effect.gen(function* () {
      const userId = sessionUserIdFromSubject(input.subject);
      if (!userId) {
        return undefined;
      }
      const [organizations, collaboration] = yield* Effect.all([
        tenancyRepository.loadOrganizations(),
        tenancyRepository.loadCollaboration(),
      ]).pipe(
        Effect.mapError(
          (cause) =>
            new AuthError({
              message: "Failed to load local tenant memberships.",
              status: 500,
              cause,
            }),
        ),
      );
      let activeMemberships = [...organizations.memberships, ...collaboration.memberships].filter(
        (membership) => membership.userId === userId && membership.disabledAt === null,
      );
      if (activeMemberships.length === 0) {
        const account = yield* localAccounts.getByUserId({ userId }).pipe(
          Effect.map((entry) => (Option.isSome(entry) ? entry.value : undefined)),
          Effect.mapError(tenancyLoadError),
        );
        // A machine owner has no local account to be named after, but may well
        // have named themselves in Settings, and the workspace is going to
        // carry that name from here on.
        const profile = account
          ? undefined
          : yield* userProfiles.getBySubject({ subject: input.subject }).pipe(
              Effect.map((entry) => (Option.isSome(entry) ? entry.value : undefined)),
              Effect.mapError(tenancyLoadError),
            );
        const provisioned = yield* provisionPersonalTenant({
          userId,
          displayName: account?.displayName ?? profile?.displayName ?? "Personal",
        });
        activeMemberships = [provisioned];
      }
      const firstMembership = activeMemberships[0];
      if (!firstMembership) {
        return undefined;
      }
      const tenantMemberships = activeMemberships.filter(
        (membership) => membership.tenantId === firstMembership.tenantId,
      );
      const roles = uniqueTenantRoles(tenantMemberships);
      if (!roles) {
        return undefined;
      }
      const issuedAt = yield* DateTime.now;
      const expiresAt =
        input.expiresAt ??
        DateTime.add(issuedAt, {
          milliseconds: 30 * 24 * 60 * 60 * 1000,
        });
      return {
        authSessionId: input.sessionId,
        userId,
        tenantId: firstMembership.tenantId,
        organizationId:
          tenantMemberships.find((membership) => membership.organizationId !== null)
            ?.organizationId ?? null,
        membershipIds: Array.from(tenantMemberships, (membership) => membership.id),
        roles,
        activeWorkspaceId: null,
        issuedAt: DateTime.formatIso(DateTime.toUtc(issuedAt)),
        expiresAt: DateTime.formatIso(DateTime.toUtc(expiresAt)),
      };
    });

  const authenticateToken = (token: string): Effect.Effect<AuthenticatedSession, AuthError> =>
    sessions.verify(token).pipe(
      Effect.tapError((cause: SessionCredentialError) =>
        Effect.logWarning("Rejected authenticated session credential.").pipe(
          Effect.annotateLogs({
            reason: cause.message,
          }),
        ),
      ),
      Effect.flatMap((session) =>
        Effect.gen(function* () {
          const localUserId = localUserIdFromSubject(session.subject);
          const tenantSessionContext: TenantSessionContext | undefined =
            session.tenantSessionContext ??
            (yield* resolveLocalTenantSessionContext({
              sessionId: session.sessionId,
              subject: session.subject,
              ...(session.expiresAt ? { expiresAt: session.expiresAt } : {}),
            }));
          return {
            sessionId: session.sessionId,
            subject: session.subject,
            method: session.method,
            role: session.role,
            client: session.client,
            ...(tenantSessionContext?.userId
              ? { userId: tenantSessionContext.userId }
              : session.userId
                ? { userId: session.userId }
                : localUserId
                  ? { userId: localUserId }
                  : {}),
            ...(session.expiresAt ? { expiresAt: session.expiresAt } : {}),
            ...(tenantSessionContext
              ? { tenantSessionContext }
              : session.tenantSessionContext
                ? { tenantSessionContext: session.tenantSessionContext }
                : {}),
          };
        }),
      ),
      Effect.mapError(
        (cause) =>
          new AuthError({
            message: "Unauthorized request.",
            status: 401,
            cause,
          }),
      ),
    );

  const toBootstrapExchangeResult = (session: {
    readonly token: string;
    readonly role: "owner" | "client";
    readonly method: "browser-session-cookie" | "bearer-session-token";
    readonly expiresAt: DateTime.DateTime;
  }): BootstrapExchangeResult => ({
    response: {
      authenticated: true,
      role: session.role,
      sessionMethod: session.method,
      expiresAt: DateTime.toUtc(session.expiresAt),
    } satisfies AuthBootstrapResult,
    sessionToken: session.token,
  });

  const issueBrowserSession = ({
    role,
    subject,
    requestMetadata,
  }: {
    readonly role: "owner" | "client";
    readonly subject: string;
    readonly requestMetadata: AuthClientMetadata;
  }) =>
    sessions
      .issue({
        method: "browser-session-cookie",
        subject,
        role,
        client: requestMetadata,
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new AuthError({
              message: "Failed to issue authenticated session.",
              cause,
            }),
        ),
        Effect.map(toBootstrapExchangeResult),
      );

  const issueOwnerBrowserSession = (
    subject: string,
    requestMetadata: AuthClientMetadata,
  ): Effect.Effect<BootstrapExchangeResult, AuthError> =>
    issueBrowserSession({
      role: "owner",
      subject,
      requestMetadata,
    });

  const authenticateSupabaseBearerToken = (
    token: string,
    request: HttpServerRequest.HttpServerRequest,
  ): Effect.Effect<AuthenticatedSession, AuthError> =>
    Effect.gen(function* () {
      if (!supabaseConfig) {
        return yield* new AuthError({
          message: "Unauthorized request.",
          status: 401,
        });
      }
      const identity = yield* Effect.tryPromise({
        try: () =>
          authenticateSupabaseBearerTokenWithRemoteJwks({
            token,
            config: supabaseConfig,
          }),
        catch: (cause) =>
          cause instanceof SupabaseAuthBridgeError
            ? new AuthError({
                message: cause.message,
                ...(cause.status ? { status: cause.status } : {}),
                cause,
              })
            : new AuthError({
                message: "Unauthorized request.",
                status: 401,
                cause,
              }),
      });
      if (typeof identity.claims.exp !== "number") {
        return yield* new AuthError({
          message: "Supabase JWT is missing expiration.",
          status: 401,
        });
      }
      const [organizations, collaboration] = yield* Effect.all([
        tenancyRepository.loadOrganizations(),
        tenancyRepository.loadCollaboration(),
      ]).pipe(
        Effect.mapError(
          (cause) =>
            new AuthError({
              message: "Failed to load Supabase tenant memberships.",
              status: 500,
              cause,
            }),
        ),
      );
      const issuedAt = yield* DateTime.now;
      const expiresAt = DateTime.fromDateUnsafe(new Date(identity.claims.exp * 1000));
      const mapTenantSessionContext = (memberships: readonly TenantMembership[]) =>
        Effect.try({
          try: () =>
            mapSupabaseIdentityToTenantSessionContext({
              authSessionId: AuthSessionId.make(`supabase:${identity.subject}`),
              identity,
              memberships,
              ...(readSupabaseTenantIdClaim(identity.claims)
                ? { tenantId: readSupabaseTenantIdClaim(identity.claims) }
                : {}),
              ...(readSupabaseActiveWorkspaceIdClaim(identity.claims)
                ? { activeWorkspaceId: readSupabaseActiveWorkspaceIdClaim(identity.claims) }
                : {}),
              issuedAt: DateTime.formatIso(DateTime.toUtc(issuedAt)),
              expiresAt: DateTime.formatIso(DateTime.toUtc(expiresAt)),
            }),
          catch: (cause): SupabaseAuthBridgeError =>
            cause instanceof SupabaseAuthBridgeError
              ? cause
              : new SupabaseAuthBridgeError({
                  message: "Failed to map Supabase tenant session.",
                  status: 500,
                  cause,
                }),
        });
      const bridgeAuthError = (cause: SupabaseAuthBridgeError): AuthError =>
        new AuthError({
          message: cause.message,
          ...(cause.status ? { status: cause.status } : {}),
          cause,
        });
      const tenantSessionContext = yield* mapTenantSessionContext([
        ...organizations.memberships,
        ...collaboration.memberships,
      ]).pipe(
        Effect.catchTag("SupabaseAuthBridgeError", (cause) =>
          cause.message === "Supabase user is not a member of any tenant."
            ? provisionPersonalTenant({
                userId: identity.userId,
                displayName: identity.displayName,
              }).pipe(
                Effect.flatMap((membership) => mapTenantSessionContext([membership])),
                Effect.catchTag("SupabaseAuthBridgeError", (mapCause) =>
                  Effect.fail(bridgeAuthError(mapCause)),
                ),
              )
            : Effect.fail(bridgeAuthError(cause)),
        ),
      );
      const client = deriveAuthClientMetadata({
        request,
        label: identity.displayName,
      });
      return {
        sessionId:
          tenantSessionContext?.authSessionId ?? AuthSessionId.make(`supabase:${identity.subject}`),
        subject: identity.subject,
        method: "bearer-session-token",
        role: "client",
        client,
        userId: identity.userId,
        expiresAt,
        ...(tenantSessionContext ? { tenantSessionContext } : {}),
      };
    });

  const authenticateRequest = (request: HttpServerRequest.HttpServerRequest) => {
    const cookieToken = request.cookies[sessions.cookieName];
    const bearerToken = parseBearerToken(request);
    if (!cookieToken && !bearerToken) {
      return Effect.fail(
        new AuthError({
          message: "Authentication required.",
          status: 401,
        }),
      );
    }
    // Explicit bearer identity wins over the ambient cookie session so that a
    // signed-in cloud user is not silently downgraded to the loopback owner.
    if (bearerToken) {
      return authenticateToken(bearerToken).pipe(
        Effect.catchTag("AuthError", () =>
          authenticateSupabaseBearerToken(bearerToken, request).pipe(
            Effect.catchTag("AuthError", (error) =>
              cookieToken ? authenticateToken(cookieToken) : Effect.fail(error),
            ),
          ),
        ),
      );
    }
    return authenticateToken(cookieToken!);
  };

  const getSessionState: ServerAuthShape["getSessionState"] = (request) =>
    authenticateRequest(request).pipe(
      Effect.map((session) => {
        const tenantState = resolveAuthenticatedSessionTenantState(session);
        return {
          authenticated: true,
          auth: descriptor,
          role: session.role,
          sessionMethod: session.method,
          ...(session.expiresAt ? { expiresAt: DateTime.toUtc(session.expiresAt) } : {}),
          tenantStatus: tenantState.tenantStatus,
          ...(tenantState.tenantSession ? { tenantSession: tenantState.tenantSession } : {}),
        } satisfies AuthSessionState;
      }),
      Effect.catchTag("AuthError", () =>
        Effect.succeed({
          authenticated: false,
          auth: descriptor,
        } satisfies AuthSessionState),
      ),
    );

  const resolveUserProfile: ServerAuthShape["resolveUserProfile"] = (session) =>
    userProfiles.getBySubject({ subject: session.subject }).pipe(
      Effect.map((profile) =>
        toAuthUserProfile(session, Option.isSome(profile) ? profile.value : undefined),
      ),
      Effect.mapError(
        (cause) =>
          new AuthError({
            message: "Failed to load account profile.",
            status: 500,
            cause,
          }),
      ),
    );

  const resolveLocalAccount: ServerAuthShape["resolveLocalAccount"] = (session) => {
    const userId = localUserIdFromSubject(session.subject);
    if (!userId) {
      return Effect.void.pipe(Effect.as(undefined));
    }

    return localAccounts.getByUserId({ userId }).pipe(
      Effect.map((account) => (Option.isSome(account) ? account.value : undefined)),
      Effect.mapError(
        (cause) =>
          new AuthError({
            message: "Failed to load local account.",
            status: 500,
            cause,
          }),
      ),
    );
  };

  const getUserProfile: ServerAuthShape["getUserProfile"] = (request) =>
    authenticateRequest(request).pipe(Effect.flatMap(resolveUserProfile));

  const updateUserProfile: ServerAuthShape["updateUserProfile"] = (request, input) =>
    authenticateRequest(request).pipe(
      Effect.flatMap((session) =>
        Effect.gen(function* () {
          const normalizedProfile = normalizeProfileUpdate(input);
          const avatarDataUrl = normalizedProfile.avatarDataUrl
            ? yield* validateAvatarDataUrl(normalizedProfile.avatarDataUrl)
            : undefined;
          const updatedAt = yield* DateTime.now;
          yield* userProfiles.upsert({
            subject: session.subject,
            displayName: normalizedProfile.displayName,
            avatarInitials: normalizedProfile.avatarInitials,
            avatarDataUrl: avatarDataUrl ?? null,
            updatedAt: DateTime.toUtc(updatedAt),
          });
          return toAuthUserProfile(session, {
            displayName: normalizedProfile.displayName,
            avatarInitials: normalizedProfile.avatarInitials,
            ...(avatarDataUrl ? { avatarDataUrl } : {}),
          });
        }),
      ),
      Effect.mapError((cause) =>
        cause instanceof AuthError
          ? cause
          : new AuthError({
              message: "Failed to update account profile.",
              status: 500,
              cause,
            }),
      ),
    );

  const issueLoopbackOwnerSession: ServerAuthShape["issueLoopbackOwnerSession"] = (
    requestMetadata,
  ) => issueOwnerBrowserSession(LOOPBACK_OWNER_SUBJECT, requestMetadata);

  const issueUnsafeNoAuthOwnerSession: ServerAuthShape["issueUnsafeNoAuthOwnerSession"] = (
    requestMetadata,
  ) => issueOwnerBrowserSession(UNSAFE_NO_AUTH_OWNER_SUBJECT, requestMetadata);

  const issueLocalAccountSession = (input: {
    readonly userId: UserId;
    readonly displayName: string;
    readonly requestMetadata: AuthClientMetadata;
  }) =>
    issueBrowserSession({
      role: "client",
      subject: `${LOCAL_USER_SUBJECT_PREFIX}${input.userId}`,
      requestMetadata: {
        ...input.requestMetadata,
        label: input.displayName,
      },
    });

  const authenticatePassword: ServerAuthShape["authenticatePassword"] = (input, requestMetadata) =>
    Effect.gen(function* () {
      if (!serverConfig.localPasswordAuth) {
        return yield* new AuthError({
          message: "Local password auth is not enabled.",
          status: 403,
        });
      }

      const email = normalizeEmail(input.email);
      const existing = yield* localAccounts.getByEmail({ email }).pipe(
        Effect.mapError(
          (cause) =>
            new AuthError({
              message: "Failed to load local account.",
              status: 500,
              cause,
            }),
        ),
      );

      if (input.mode === "login") {
        if (Option.isNone(existing) || existing.value.disabledAt !== null) {
          return yield* invalidEmailPassword;
        }
        const passwordValid = yield* verifyPassword({
          password: input.password,
          salt: existing.value.passwordSalt,
          expectedHash: existing.value.passwordHash,
        });
        if (!passwordValid) {
          return yield* invalidEmailPassword;
        }
        return yield* issueLocalAccountSession({
          userId: existing.value.userId,
          displayName: existing.value.displayName,
          requestMetadata,
        });
      }

      if (Option.isSome(existing)) {
        return yield* new AuthError({
          message: "A local account already exists for this email.",
          status: 403,
        });
      }

      const now = yield* DateTime.now;
      const displayName = normalizeLocalDisplayName(input);
      const salt = randomBytes(18).toString("base64url");
      const passwordHash = yield* hashPassword({ password: input.password, salt });
      const userId = UserId.make(`local:${crypto.randomUUID()}`);
      yield* localAccounts
        .upsert({
          userId,
          email,
          passwordHash,
          passwordSalt: salt,
          displayName,
          avatarInitials: resolveAvatarInitials(displayName),
          createdAt: DateTime.toUtc(now),
          updatedAt: DateTime.toUtc(now),
          disabledAt: null,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new AuthError({
                message: "Failed to create local account.",
                status: 500,
                cause,
              }),
          ),
        );

      return yield* issueLocalAccountSession({
        userId,
        displayName,
        requestMetadata,
      });
    });

  const exchangeBootstrapCredential: ServerAuthShape["exchangeBootstrapCredential"] = (
    credential,
    requestMetadata,
  ) =>
    bootstrapCredentials.consume(credential).pipe(
      Effect.mapError(toBootstrapExchangeAuthError),
      Effect.flatMap((grant) =>
        issueBrowserSession({
          role: grant.role,
          subject: grant.subject,
          requestMetadata: {
            ...requestMetadata,
            ...(grant.label ? { label: grant.label } : {}),
          },
        }),
      ),
    );

  const exchangeBootstrapCredentialForBearerSession: ServerAuthShape["exchangeBootstrapCredentialForBearerSession"] =
    (credential, requestMetadata) =>
      bootstrapCredentials.consume(credential).pipe(
        Effect.mapError(toBootstrapExchangeAuthError),
        Effect.flatMap((grant) =>
          sessions
            .issue({
              method: "bearer-session-token",
              subject: grant.subject,
              role: grant.role,
              client: {
                ...requestMetadata,
                ...(grant.label ? { label: grant.label } : {}),
              },
            })
            .pipe(
              Effect.mapError(
                (cause) =>
                  new AuthError({
                    message: "Failed to issue authenticated session.",
                    cause,
                  }),
              ),
            ),
        ),
        Effect.map(
          (session) =>
            ({
              authenticated: true,
              role: session.role,
              sessionMethod: "bearer-session-token",
              expiresAt: DateTime.toUtc(session.expiresAt),
              sessionToken: session.token,
            }) satisfies AuthBearerBootstrapResult,
        ),
      );

  const issuePairingCredential: ServerAuthShape["issuePairingCredential"] = (input) =>
    authControlPlane
      .createPairingLink({
        role: input?.role ?? "client",
        subject:
          input?.subject ??
          (input?.role === "owner" ? "owner-bootstrap" : `paired-client:${crypto.randomUUID()}`),
        ...(input?.label ? { label: input.label } : {}),
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new AuthError({
              message: "Failed to issue pairing credential.",
              cause,
            }),
        ),
        Effect.map(
          (issued) =>
            ({
              id: issued.id,
              credential: issued.credential,
              ...(issued.label ? { label: issued.label } : {}),
              expiresAt: issued.expiresAt,
            }) satisfies AuthPairingCredentialResult,
        ),
      );

  const listPairingLinks: ServerAuthShape["listPairingLinks"] = () =>
    authControlPlane
      .listPairingLinks({
        role: "client",
        excludeSubjects: ["owner-bootstrap"],
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new AuthError({
              message: "Failed to load pairing links.",
              cause,
            }),
        ),
      );

  const revokePairingLink: ServerAuthShape["revokePairingLink"] = (id) =>
    authControlPlane.revokePairingLink(id).pipe(
      Effect.mapError(
        (cause) =>
          new AuthError({
            message: "Failed to revoke pairing link.",
            cause,
          }),
      ),
    );

  const listClientSessions: ServerAuthShape["listClientSessions"] = (currentSessionId) =>
    authControlPlane.listSessions().pipe(
      Effect.mapError(
        (cause) =>
          new AuthError({
            message: "Failed to load paired clients.",
            cause,
          }),
      ),
      Effect.map((clientSessions) =>
        clientSessions.map(
          (clientSession): AuthClientSession => ({
            ...clientSession,
            current: clientSession.sessionId === currentSessionId,
          }),
        ),
      ),
    );

  const revokeClientSession: ServerAuthShape["revokeClientSession"] = (
    currentSessionId,
    targetSessionId,
  ) =>
    Effect.gen(function* () {
      if (currentSessionId === targetSessionId) {
        return yield* new AuthError({
          message: "Use revoke other clients to keep the current owner session active.",
          status: 403,
        });
      }
      return yield* authControlPlane.revokeSession(targetSessionId).pipe(
        Effect.mapError(
          (cause) =>
            new AuthError({
              message: "Failed to revoke client session.",
              cause,
            }),
        ),
      );
    });

  const revokeOtherClientSessions: ServerAuthShape["revokeOtherClientSessions"] = (
    currentSessionId,
  ) =>
    authControlPlane.revokeOtherSessionsExcept(currentSessionId).pipe(
      Effect.mapError(
        (cause) =>
          new AuthError({
            message: "Failed to revoke other client sessions.",
            cause,
          }),
      ),
    );

  const issueStartupPairingUrl: ServerAuthShape["issueStartupPairingUrl"] = (baseUrl) =>
    issuePairingCredential({ role: "owner" }).pipe(
      Effect.map((issued) => {
        const url = new URL(baseUrl);
        url.pathname = "/pair";
        url.searchParams.delete("token");
        url.hash = new URLSearchParams([["token", issued.credential]]).toString();
        return url.toString();
      }),
    );

  const issueWebSocketToken: ServerAuthShape["issueWebSocketToken"] = (session) =>
    sessions
      .issueWebSocketToken(session.sessionId, {
        sessionSnapshot: {
          subject: session.subject,
          method: session.method,
          role: session.role,
          client: session.client,
          ...(session.expiresAt ? { expiresAt: session.expiresAt } : {}),
          ...(session.userId ? { userId: session.userId } : {}),
          ...(session.tenantSessionContext
            ? { tenantSessionContext: session.tenantSessionContext }
            : {}),
        },
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new AuthError({
              message: "Failed to issue websocket token.",
              cause,
            }),
        ),
        Effect.map(
          (issued) =>
            ({
              token: issued.token,
              expiresAt: DateTime.toUtc(issued.expiresAt),
            }) satisfies AuthWebSocketTokenResult,
        ),
      );

  const authenticateWebSocketUpgrade: ServerAuthShape["authenticateWebSocketUpgrade"] = (request) =>
    Effect.gen(function* () {
      const requestUrl = HttpServerRequest.toURL(request);
      if (Option.isSome(requestUrl)) {
        const websocketToken = requestUrl.value.searchParams.get(WEBSOCKET_TOKEN_QUERY_PARAM);
        if (websocketToken && websocketToken.trim().length > 0) {
          return yield* sessions.verifyWebSocketToken(websocketToken).pipe(
            Effect.mapError(
              (cause) =>
                new AuthError({
                  message: "Unauthorized request.",
                  status: 401,
                  cause,
                }),
            ),
            // Websocket tokens carry no tenant context of their own, so resolve
            // it the same way an HTTP session would.
            Effect.flatMap((session) =>
              Effect.map(
                session.tenantSessionContext
                  ? Effect.succeed(session.tenantSessionContext)
                  : resolveLocalTenantSessionContext({
                      sessionId: session.sessionId,
                      subject: session.subject,
                      ...(session.expiresAt ? { expiresAt: session.expiresAt } : {}),
                    }),
                (tenantSessionContext) => ({
                  sessionId: session.sessionId,
                  subject: session.subject,
                  method: session.method,
                  role: session.role,
                  client: session.client,
                  ...(tenantSessionContext?.userId
                    ? { userId: tenantSessionContext.userId }
                    : session.userId
                      ? { userId: session.userId }
                      : {}),
                  ...(session.expiresAt ? { expiresAt: session.expiresAt } : {}),
                  ...(tenantSessionContext ? { tenantSessionContext } : {}),
                }),
              ),
            ),
          );
        }
      }

      return yield* authenticateRequest(request);
    });

  return {
    getDescriptor: () => Effect.succeed(descriptor),
    getSessionState,
    getUserProfile,
    resolveUserProfile,
    resolveLocalAccount,
    updateUserProfile,
    issueLoopbackOwnerSession,
    issueUnsafeNoAuthOwnerSession,
    authenticatePassword,
    exchangeBootstrapCredential,
    exchangeBootstrapCredentialForBearerSession,
    issuePairingCredential,
    listPairingLinks,
    revokePairingLink,
    listClientSessions,
    revokeClientSession,
    revokeOtherClientSessions,
    authenticateHttpRequest: authenticateRequest,
    authenticateWebSocketUpgrade,
    issueWebSocketToken,
    issueStartupPairingUrl,
  } satisfies ServerAuthShape;
});

function toAuthUserProfile(
  session: AuthenticatedSession,
  profile?: {
    readonly displayName: string;
    readonly avatarInitials: string;
    readonly avatarDataUrl?: string | null;
  },
): AuthUserProfile {
  const subject = session.subject.trim() || "authenticated-user";
  const displayName =
    profile?.displayName ??
    resolveDisplayName({
      subject,
      label: session.client.label,
    });
  const tenantState = resolveAuthenticatedSessionTenantState(session);
  return {
    userId:
      session.tenantSessionContext?.userId ?? session.userId ?? UserId.make(`auth:${subject}`),
    subject,
    displayName,
    avatarInitials: profile?.avatarInitials ?? resolveAvatarInitials(displayName),
    ...(profile?.avatarDataUrl ? { avatarDataUrl: profile.avatarDataUrl } : {}),
    role: session.role,
    sessionId: session.sessionId,
    sessionMethod: session.method,
    client: session.client,
    ...(session.expiresAt ? { expiresAt: DateTime.toUtc(session.expiresAt) } : {}),
    tenantStatus: tenantState.tenantStatus,
    ...(tenantState.tenantSession ? { tenantSession: tenantState.tenantSession } : {}),
  };
}

function normalizeProfileUpdate(input: AuthUpdateUserProfileInput): AuthUpdateUserProfileInput {
  const avatarDataUrl = input.avatarDataUrl?.trim();
  return {
    displayName: input.displayName.trim(),
    avatarInitials: input.avatarInitials.trim().toUpperCase(),
    ...(avatarDataUrl ? { avatarDataUrl } : {}),
  };
}

function decodedBase64ByteLength(base64: string): number {
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return (base64.length / 4) * 3 - padding;
}

/**
 * The browser downscales before uploading, but an avatar can also arrive from a
 * scripted client, so the media type and the decoded size are re-checked here
 * rather than trusted from the caller.
 */
function validateAvatarDataUrl(value: string): Effect.Effect<string, AuthError> {
  const match = AVATAR_DATA_URL_PATTERN.exec(value);
  const mediaType = match?.[1];
  const base64 = match?.[2];
  if (mediaType === undefined || base64 === undefined || base64.length % 4 !== 0) {
    return Effect.fail(
      new AuthError({
        message: "Avatar image must be a base64 data URL.",
        status: 400,
      }),
    );
  }
  if (!AUTH_AVATAR_IMAGE_MIME_TYPES.some((allowed) => allowed === mediaType)) {
    return Effect.fail(
      new AuthError({
        message: `Avatar image must be one of ${AUTH_AVATAR_IMAGE_MIME_TYPES.join(", ")}.`,
        status: 400,
      }),
    );
  }
  if (decodedBase64ByteLength(base64) > AUTH_AVATAR_MAX_DECODED_BYTES) {
    return Effect.fail(
      new AuthError({
        message: `Avatar image must be at most ${Math.floor(AUTH_AVATAR_MAX_DECODED_BYTES / 1024)}KB.`,
        status: 400,
      }),
    );
  }
  return Effect.succeed(value);
}

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeLocalDisplayName(input: AuthPasswordInput): string {
  const explicit = input.displayName?.trim();
  if (explicit) {
    return explicit;
  }
  const emailLocalPart = normalizeEmail(input.email).split("@")[0]?.trim();
  const cleaned = emailLocalPart?.replace(/[-_.]+/g, " ").trim();
  return cleaned ? cleaned.replace(/\b\w/g, (letter) => letter.toUpperCase()) : "Local User";
}

function hashPassword(input: { readonly password: string; readonly salt: string }) {
  return Effect.promise(async () => {
    const derived = (await scryptAsync(input.password, input.salt, 64)) as Buffer;
    return derived.toString("base64url");
  });
}

function verifyPassword(input: {
  readonly password: string;
  readonly salt: string;
  readonly expectedHash: string;
}) {
  return hashPassword({ password: input.password, salt: input.salt }).pipe(
    Effect.map((actualHash) => {
      const actual = Buffer.from(actualHash, "base64url");
      const expected = Buffer.from(input.expectedHash, "base64url");
      return actual.length === expected.length && timingSafeEqual(actual, expected);
    }),
  );
}

function resolveAuthenticatedSessionTenantState(
  session: AuthenticatedSession,
): Pick<AuthUserProfile, "tenantStatus" | "tenantSession"> {
  if (session.tenantSessionContext) {
    return {
      tenantStatus: "active",
      tenantSession: session.tenantSessionContext,
    };
  }
  if (session.userId) {
    return {
      tenantStatus: "pending-membership",
    };
  }
  return {
    tenantStatus: "none",
  };
}

function resolveDisplayName(input: { subject: string; label: string | undefined }): string {
  const label = input.label?.trim();
  if (label) {
    return label;
  }

  const cleaned = input.subject
    .replace(/^auth:/, "")
    .replace(/[-_.]+/g, " ")
    .trim();
  if (!cleaned) {
    return "Authenticated user";
  }
  return cleaned.replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function resolveAvatarInitials(displayName: string): string {
  const parts = displayName
    .split(/\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
  const initials =
    parts.length >= 2 ? `${parts[0]?.[0] ?? ""}${parts[1]?.[0] ?? ""}` : displayName.slice(0, 2);
  return initials.toUpperCase() || "U";
}

export const ServerAuthLive = Layer.effect(ServerAuth, makeServerAuth).pipe(
  Layer.provideMerge(AuthControlPlaneLive),
  Layer.provideMerge(AuthCoreLive),
  Layer.provideMerge(AuthUserProfileRepositoryLive),
  Layer.provideMerge(LocalAuthAccountRepositoryLive),
  Layer.provideMerge(TenancyRepositoryLive),
  Layer.provideMerge(ServerAuthPolicyLive),
);
