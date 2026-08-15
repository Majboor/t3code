import {
  Cause,
  Duration,
  Effect,
  FileSystem,
  Layer,
  Option,
  Queue,
  Ref,
  Schema,
  Stream,
} from "effect";
import path from "node:path";
import os from "node:os";
import {
  type AuthAccessStreamEvent,
  AuthSessionId,
  CollaborationError,
  CommandId,
  AnalyticsError,
  DeployError,
  PackEnablementError,
  type DeployTargetId,
  type ProjectId,
  EventId,
  FilesystemBrowseError,
  GitCommandError,
  type GitManagerServiceError,
  NonNegativeInt,
  type OrchestrationCommand,
  type GitActionProgressEvent,
  OrchestrationDispatchCommandError,
  type OrchestrationEvent,
  type OrchestrationShellSnapshot,
  type OrchestrationShellStreamEvent,
  OrchestrationGetFullThreadDiffError,
  OrchestrationGetSnapshotError,
  type OrchestrationThread,
  type ThreadTokenUsageSnapshot,
  type OrchestrationProjectShell,
  type OrchestrationThreadShell,
  OrchestrationGetTurnDiffError,
  ORCHESTRATION_WS_METHODS,
  type OrchestrationProjectOwnership,
  ProjectCreateEntryError,
  ProjectListDirectoryError,
  ProjectReadFileError,
  ProjectSearchEntriesError,
  ProjectWriteFileError,
  OrchestrationReplayEventsError,
  OpenError,
  type OrganizationAuditEventKind,
  OrganizationError,
  type OrganizationId,
  PackError,
  type OrganizationPermission,
  type OrganizationListResult,
  ProviderAccountError,
  ProviderAccountId,
  type ProviderAccount,
  type ProviderAccountConnectScope,
  type ProviderAccountSummary,
  type ProviderKind,
  type ProviderSessionIsolation,
  ProviderSessionId,
  TenantId,
  TenantRuntimeId,
  type TenantPermission,
  type TenantRole,
  TerminalCwdError,
  ThreadId,
  WorkspaceId,
  type TerminalEvent,
  WS_METHODS,
  WsRpcGroup,
} from "@t3tools/contracts";
import {
  DEFAULT_PUBLIC_ACCESS_LIMITS,
  deriveProviderAccountConnectionPlan,
  deriveProviderAccountHomeLayout,
  deriveProviderLaunchEnvironment,
  deriveTenantRuntimeDirectoryLayout,
  evaluateProviderAccountAccess,
  hasOrganizationPermission,
  hasTenantPermission,
} from "@t3tools/shared/tenancy";
import { clamp } from "effect/Number";
import { HttpRouter, HttpServerRequest } from "effect/unstable/http";
import { RpcSerialization, RpcServer } from "effect/unstable/rpc";

import { CheckpointDiffQuery } from "./checkpointing/Services/CheckpointDiffQuery.ts";
import { ServerConfig } from "./config.ts";
import { GitCore } from "./git/Services/GitCore.ts";
import { GitManager } from "./git/Services/GitManager.ts";
import { GitStatusBroadcaster } from "./git/Services/GitStatusBroadcaster.ts";
import { Keybindings } from "./keybindings.ts";
import { Open, resolveAvailableEditors } from "./open.ts";
import { normalizeDispatchCommand } from "./orchestration/Normalizer.ts";
import { OrchestrationEngineService } from "./orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  observeRpcEffect,
  observeRpcStream,
  observeRpcStreamEffect,
} from "./observability/RpcInstrumentation.ts";
import { recordPublicAccessLimitRejection } from "./observability/Metrics.ts";
import { ProviderRegistry } from "./provider/Services/ProviderRegistry.ts";
import { ServerLifecycleEvents } from "./serverLifecycleEvents.ts";
import { ServerRuntimeStartup } from "./serverRuntimeStartup.ts";
import { ServerSettingsService } from "./serverSettings.ts";
import { TerminalManager } from "./terminal/Services/Manager.ts";
import { WorkspaceEntries } from "./workspace/Services/WorkspaceEntries.ts";
import { WorkspaceFileSystem } from "./workspace/Services/WorkspaceFileSystem.ts";
import { WorkspacePathOutsideRootError } from "./workspace/Services/WorkspacePaths.ts";
import { ProjectSetupScriptRunner } from "./project/Services/ProjectSetupScriptRunner.ts";
import { RepositoryIdentityResolver } from "./project/Services/RepositoryIdentityResolver.ts";
import { ServerEnvironment } from "./environment/Services/ServerEnvironment.ts";
import {
  AuthError,
  type AuthenticatedSession,
  resolveAuthenticatedUserId,
  ServerAuth,
} from "./auth/Services/ServerAuth.ts";
import {
  BootstrapCredentialService,
  type BootstrapCredentialChange,
} from "./auth/Services/BootstrapCredentialService.ts";
import {
  SessionCredentialService,
  type SessionCredentialChange,
} from "./auth/Services/SessionCredentialService.ts";
import { respondToAuthError } from "./auth/http.ts";
import { CollaborationService } from "./collaboration/Services/CollaborationService.ts";
import { OrganizationService } from "./organizations/Services/OrganizationService.ts";
import { PackRegistryService } from "./packs/Services/PackRegistryService.ts";
import { TenancyRepository } from "./persistence/Services/Tenancy.ts";
import { DeployService } from "./deploy/Services/DeployService.ts";
import { DeploymentRegistry } from "./deploy/Services/DeploymentRegistry.ts";
import { AnalyticsStore } from "./analytics/Services/AnalyticsStore.ts";
import { PackEnablementService } from "./packEnablement/Services/PackEnablementService.ts";
import { isLoopbackHost, isWildcardHost } from "./startupAccess.ts";
import { ProjectionThreadPreferenceRepository } from "./persistence/Services/ProjectionThreadPreferences.ts";

const WS_RPC_RATE_LIMIT_WINDOW_MS = 60_000;
const WS_RPC_MAX_REQUESTS_PER_WINDOW = 300;
const LOCAL_THREAD_PREFERENCE_TENANT_ID = TenantId.make("local");

type RpcRateBucket = {
  readonly windowStartedAt: number;
  readonly count: number;
};

type ProviderConnectFailureBucket = {
  readonly windowStartedAt: number;
  readonly count: number;
  readonly lockedUntil: number | null;
};

type HostedLimitRejection = {
  readonly limit: string;
  readonly operation: string;
  readonly current: number;
  readonly maximum: number;
  readonly message: string;
};

const hostedRpcRateBuckets = new Map<string, RpcRateBucket>();
const providerConnectFailureBuckets = new Map<string, ProviderConnectFailureBucket>();
const activeWebSocketConnections = new Map<string, number>();

type ActiveWebSocketConnectionSlot = {
  readonly keys: readonly string[];
};

function incrementActiveWebSocketConnection(key: string): number {
  const next = (activeWebSocketConnections.get(key) ?? 0) + 1;
  activeWebSocketConnections.set(key, next);
  return next;
}

function decrementActiveWebSocketConnection(key: string): void {
  const next = (activeWebSocketConnections.get(key) ?? 1) - 1;
  if (next <= 0) {
    activeWebSocketConnections.delete(key);
    return;
  }
  activeWebSocketConnections.set(key, next);
}

function normalizeRemoteAddress(value: string | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    return "unknown";
  }
  return trimmed.startsWith("::ffff:") ? trimmed.slice("::ffff:".length) : trimmed;
}

function isImplicitLocalOwnerSession(session: AuthenticatedSession): boolean {
  return session.subject === "loopback-local-owner" || session.subject === "unsafe-no-auth-owner";
}

function hasDurableInviteIdentity(session: AuthenticatedSession, inviteId: string): boolean {
  void inviteId;
  return Boolean(session.tenantSessionContext || session.userId);
}

function inviteAccountSetupUrlPath(input: {
  readonly inviteId: string;
  readonly credential?: string;
}): string {
  const search = new URLSearchParams([["inviteId", input.inviteId]]);
  const path = `/invite?${search.toString()}`;
  if (!input.credential) {
    return path;
  }
  const hash = new URLSearchParams([["token", input.credential]]);
  return `${path}#${hash.toString()}`;
}

function withThreadFavoritePreference<
  Thread extends OrchestrationThreadShell | OrchestrationThread,
>(thread: Thread, favorites: ReadonlyMap<string, boolean>): Thread {
  const favorite = favorites.get(thread.id);
  return favorite === undefined ? thread : { ...thread, favorite };
}

const releaseActiveWebSocketConnectionSlot = (slot: ActiveWebSocketConnectionSlot) =>
  Effect.sync(() => {
    for (const key of slot.keys) {
      decrementActiveWebSocketConnection(key);
    }
  });

const rejectWebSocketConnectionLimit = (
  rejection: HostedLimitRejection,
  session: AuthenticatedSession,
) =>
  recordPublicAccessLimitRejection({
    limit: rejection.limit,
    operation: rejection.operation,
    current: rejection.current,
    maximum: rejection.maximum,
    tenantId: session.tenantSessionContext?.tenantId,
    userId: resolveAuthenticatedUserId(session),
  }).pipe(
    Effect.flatMap(() =>
      Effect.fail(
        new AuthError({
          message: rejection.message,
          status: 429,
        }),
      ),
    ),
  );

const acquireActiveWebSocketConnectionSlot = (
  request: HttpServerRequest.HttpServerRequest,
  session: AuthenticatedSession,
): Effect.Effect<ActiveWebSocketConnectionSlot, AuthError> =>
  Effect.gen(function* () {
    const acquiredKeys: string[] = [];
    const rollback = () => {
      for (const key of acquiredKeys.toReversed()) {
        decrementActiveWebSocketConnection(key);
      }
    };
    const acquireOrReject = (input: {
      readonly key: string;
      readonly limit: string;
      readonly operation: string;
      readonly maximum: number;
      readonly message: (current: number) => string;
    }) =>
      Effect.gen(function* () {
        const current = incrementActiveWebSocketConnection(input.key);
        acquiredKeys.push(input.key);
        if (current <= input.maximum) {
          return;
        }
        rollback();
        return yield* rejectWebSocketConnectionLimit(
          {
            limit: input.limit,
            operation: input.operation,
            current,
            maximum: input.maximum,
            message: input.message(current),
          },
          session,
        );
      });

    const remoteAddress = normalizeRemoteAddress(Option.getOrUndefined(request.remoteAddress));
    yield* acquireOrReject({
      key: `ip:${remoteAddress}`,
      limit: "webSocketConnectionsForIp",
      operation: "websocket.connect",
      maximum: DEFAULT_PUBLIC_ACCESS_LIMITS.maxWebSocketConnectionsPerIp,
      message: (current) =>
        `WebSocket connection limit exceeded: ${current} active connections for this IP, ${DEFAULT_PUBLIC_ACCESS_LIMITS.maxWebSocketConnectionsPerIp} allowed.`,
    });

    const userId = resolveAuthenticatedUserId(session);
    yield* acquireOrReject({
      key: `user:${userId}`,
      limit: "webSocketConnectionsForUser",
      operation: "websocket.connect",
      maximum: DEFAULT_PUBLIC_ACCESS_LIMITS.maxWebSocketConnectionsPerUser,
      message: (current) =>
        `WebSocket connection limit exceeded: ${current} active connections for this user, ${DEFAULT_PUBLIC_ACCESS_LIMITS.maxWebSocketConnectionsPerUser} allowed.`,
    });

    const tenantSession = session.tenantSessionContext;
    if (tenantSession) {
      yield* acquireOrReject({
        key: `tenant:${tenantSession.tenantId}`,
        limit: "webSocketConnectionsForTenant",
        operation: "websocket.connect",
        maximum: DEFAULT_PUBLIC_ACCESS_LIMITS.maxWebSocketConnectionsPerTenant,
        message: (current) =>
          `WebSocket connection limit exceeded: ${current} active connections for this tenant, ${DEFAULT_PUBLIC_ACCESS_LIMITS.maxWebSocketConnectionsPerTenant} allowed.`,
      });
    }

    return { keys: acquiredKeys };
  });

export const __testWebSocketConnectionLimits = {
  acquireActiveWebSocketConnectionSlot,
  releaseActiveWebSocketConnectionSlot,
  reset: () => activeWebSocketConnections.clear(),
};

function incrementRpcRateBucket(input: { readonly key: string; readonly now: number }): number {
  for (const [key, bucket] of hostedRpcRateBuckets) {
    if (input.now - bucket.windowStartedAt >= WS_RPC_RATE_LIMIT_WINDOW_MS) {
      hostedRpcRateBuckets.delete(key);
    }
  }

  const existing = hostedRpcRateBuckets.get(input.key);
  const current =
    existing && input.now - existing.windowStartedAt < WS_RPC_RATE_LIMIT_WINDOW_MS
      ? existing
      : { windowStartedAt: input.now, count: 0 };
  const next = { ...current, count: current.count + 1 };
  hostedRpcRateBuckets.set(input.key, next);
  return next.count;
}

function providerConnectFailureKey(input: {
  readonly tenantSession: NonNullable<AuthenticatedSession["tenantSessionContext"]>;
  readonly provider: ProviderKind;
}): string {
  return `provider-connect:${input.provider}:${input.tenantSession.tenantId}:${input.tenantSession.userId}`;
}

function resolveProviderConnectLockout(input: {
  readonly tenantSession: NonNullable<AuthenticatedSession["tenantSessionContext"]>;
  readonly provider: ProviderKind;
  readonly now: number;
}): HostedLimitRejection | undefined {
  const key = providerConnectFailureKey(input);
  const bucket = providerConnectFailureBuckets.get(key);
  if (!bucket) {
    return undefined;
  }

  if (
    bucket.lockedUntil === null &&
    input.now - bucket.windowStartedAt >=
      DEFAULT_PUBLIC_ACCESS_LIMITS.providerConnectFailureWindowMs
  ) {
    providerConnectFailureBuckets.delete(key);
    return undefined;
  }

  if (bucket.lockedUntil !== null && input.now >= bucket.lockedUntil) {
    providerConnectFailureBuckets.delete(key);
    return undefined;
  }

  if (bucket.lockedUntil === null) {
    return undefined;
  }

  const retryAfterSeconds = Math.max(1, Math.ceil((bucket.lockedUntil - input.now) / 1000));
  return {
    limit: "providerConnectFailuresForUser",
    operation: "provider.connect.confirm",
    current: bucket.count,
    maximum: DEFAULT_PUBLIC_ACCESS_LIMITS.maxProviderConnectFailuresPerUser,
    message: `Provider connect confirmation is temporarily locked after repeated failed attempts. Try again in ${retryAfterSeconds} seconds.`,
  };
}

function clearProviderConnectFailures(input: {
  readonly tenantSession: NonNullable<AuthenticatedSession["tenantSessionContext"]>;
  readonly provider: ProviderKind;
}): void {
  providerConnectFailureBuckets.delete(providerConnectFailureKey(input));
}

function recordProviderConnectFailure(input: {
  readonly tenantSession: NonNullable<AuthenticatedSession["tenantSessionContext"]>;
  readonly provider: ProviderKind;
  readonly now: number;
}): HostedLimitRejection | undefined {
  const key = providerConnectFailureKey(input);
  const existing = providerConnectFailureBuckets.get(key);
  const current =
    existing &&
    existing.lockedUntil === null &&
    input.now - existing.windowStartedAt <
      DEFAULT_PUBLIC_ACCESS_LIMITS.providerConnectFailureWindowMs
      ? existing
      : { windowStartedAt: input.now, count: 0, lockedUntil: null };
  const nextCount = current.count + 1;
  const lockedUntil =
    nextCount >= DEFAULT_PUBLIC_ACCESS_LIMITS.maxProviderConnectFailuresPerUser
      ? input.now + DEFAULT_PUBLIC_ACCESS_LIMITS.providerConnectLockoutMs
      : null;
  providerConnectFailureBuckets.set(key, {
    windowStartedAt: current.windowStartedAt,
    count: nextCount,
    lockedUntil,
  });

  if (lockedUntil === null) {
    return undefined;
  }

  return {
    limit: "providerConnectFailuresForUser",
    operation: "provider.connect.confirm",
    current: nextCount,
    maximum: DEFAULT_PUBLIC_ACCESS_LIMITS.maxProviderConnectFailuresPerUser,
    message: `Provider connect confirmation is temporarily locked after repeated failed attempts. Try again in ${Math.ceil(DEFAULT_PUBLIC_ACCESS_LIMITS.providerConnectLockoutMs / 1000)} seconds.`,
  };
}

function fileWriteSizeBytes(input: {
  readonly contents: string;
  readonly encoding?: string | undefined;
}): number {
  return input.encoding === "base64"
    ? Buffer.byteLength(input.contents, "base64")
    : Buffer.byteLength(input.contents, "utf8");
}

function utf8SizeBytes(input: string): number {
  return Buffer.byteLength(input, "utf8");
}

function rpcPayloadSizeBytes(input: unknown): number {
  const serialized = JSON.stringify(input);
  return serialized === undefined ? 0 : utf8SizeBytes(serialized);
}

function isThreadDetailEvent(event: OrchestrationEvent): event is Extract<
  OrchestrationEvent,
  {
    type:
      | "thread.message-sent"
      | "thread.proposed-plan-upserted"
      | "thread.activity-appended"
      | "thread.turn-diff-completed"
      | "thread.reverted"
      | "thread.session-set";
  }
> {
  return (
    event.type === "thread.message-sent" ||
    event.type === "thread.proposed-plan-upserted" ||
    event.type === "thread.activity-appended" ||
    event.type === "thread.turn-diff-completed" ||
    event.type === "thread.reverted" ||
    event.type === "thread.session-set"
  );
}

const PROVIDER_STATUS_DEBOUNCE_MS = 200;

function toAuthAccessStreamEvent(
  change: BootstrapCredentialChange | SessionCredentialChange,
  revision: number,
  currentSessionId: AuthSessionId,
): AuthAccessStreamEvent {
  switch (change.type) {
    case "pairingLinkUpserted":
      return {
        version: 1,
        revision,
        type: "pairingLinkUpserted",
        payload: change.pairingLink,
      };
    case "pairingLinkRemoved":
      return {
        version: 1,
        revision,
        type: "pairingLinkRemoved",
        payload: { id: change.id },
      };
    case "clientUpserted":
      return {
        version: 1,
        revision,
        type: "clientUpserted",
        payload: {
          ...change.clientSession,
          current: change.clientSession.sessionId === currentSessionId,
        },
      };
    case "clientRemoved":
      return {
        version: 1,
        revision,
        type: "clientRemoved",
        payload: { sessionId: change.sessionId },
      };
  }
}

function resolveCollaborationDisplayName(session: AuthenticatedSession): string {
  const label = session.client.label?.trim();
  if (label) {
    return label;
  }

  return session.subject.trim() || "Authenticated user";
}

function forbiddenMessage(permission: string): string {
  return `Forbidden: authenticated session does not have ${permission}.`;
}

function isPathInsideRoot(candidate: string, root: string): boolean {
  const normalizedCandidate = candidate.replaceAll("\\", "/").replace(/\/+$/, "");
  const normalizedRoot = root.replaceAll("\\", "/").replace(/\/+$/, "");
  return (
    normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}/`)
  );
}

function summarizeProviderAccount(
  account: ProviderAccount,
  providerSessions: ReadonlyArray<ProviderSessionIsolation>,
): ProviderAccountSummary {
  return {
    id: account.id,
    provider: account.provider,
    tenantId: account.tenantId,
    owner: account.owner,
    sharing: account.sharing,
    status: account.disabledAt === null ? "connected" : "disabled",
    createdAt: account.createdAt,
    disabledAt: account.disabledAt,
    activeSessionCount: providerSessions.filter(
      (providerSession) =>
        providerSession.providerAccountId === account.id && providerSession.endedAt === null,
    ).length,
  };
}

function canViewProviderAccount(
  account: ProviderAccount,
  tenantSession: NonNullable<AuthenticatedSession["tenantSessionContext"]>,
): boolean {
  if (account.tenantId !== tenantSession.tenantId) {
    return false;
  }
  switch (account.owner.type) {
    case "user":
      return account.owner.userId === tenantSession.userId;
    case "tenant":
      return (
        account.owner.tenantId === tenantSession.tenantId && account.sharing === "tenant-shared"
      );
    case "organization":
      return (
        tenantSession.organizationId !== null &&
        account.owner.organizationId === tenantSession.organizationId &&
        account.sharing === "tenant-shared"
      );
  }
}

function canOwnerDisconnectProviderAccount(
  account: ProviderAccount,
  tenantSession: NonNullable<AuthenticatedSession["tenantSessionContext"]>,
): boolean {
  return (
    account.owner.type === "user" &&
    account.owner.userId === tenantSession.userId &&
    account.tenantId === tenantSession.tenantId
  );
}

function resolveProviderAccountOwnerForScope(
  tenantSession: NonNullable<AuthenticatedSession["tenantSessionContext"]>,
  accountScope: ProviderAccountConnectScope | undefined,
): ProviderAccount["owner"] {
  if (accountScope === "organization") {
    if (tenantSession.organizationId === null) {
      return { type: "tenant", tenantId: tenantSession.tenantId };
    }
    return { type: "organization", organizationId: tenantSession.organizationId };
  }
  return { type: "user", userId: tenantSession.userId };
}

function isSharedProviderAccount(account: ProviderAccount): boolean {
  return account.owner.type !== "user" && account.sharing === "tenant-shared";
}

function buildProviderConnectInstructions(provider: ProviderKind) {
  if (provider === "codex") {
    return {
      provider,
      authCommand: "codex login --device-auth",
      statusCommand: "codex login status",
      verificationHint:
        "Run the command in the isolated hosted provider shell, open the printed device URL, enter the short-lived code, then start a hosted turn to verify the account.",
      steps: [
        "Open a hosted provider shell for this account.",
        "Run `codex login --device-auth`.",
        "Open the printed device URL and enter the one-time code before it expires.",
        "Run `codex login status`, then confirm the successful status in T3 Code.",
      ],
    } as const;
  }

  return {
    provider,
    authCommand: "claude auth login",
    statusCommand: "claude auth status --json",
    verificationHint:
      "Run the command in the isolated hosted provider shell, complete the Claude prompts in order, then confirm `loggedIn: true` from the JSON status output.",
    steps: [
      "Open a hosted provider shell for this account.",
      "Run `claude auth login`.",
      "Complete terminal theme, login method, OAuth URL, browser code, and workspace trust prompts in order.",
      "Run `claude auth status --json` and confirm `loggedIn: true`.",
    ],
  } as const;
}

function parseProviderAuthConfirmation(input: {
  readonly provider: ProviderKind;
  readonly statusOutput: string;
}): { readonly authenticated: true } | { readonly authenticated: false; readonly reason: string } {
  const output = input.statusOutput.trim();
  if (output.length === 0) {
    return {
      authenticated: false,
      reason: "Provider status output was empty.",
    };
  }

  if (input.provider === "codex") {
    const lower = output.toLowerCase();
    if (lower.includes("not logged in") || lower.includes("not authenticated")) {
      return {
        authenticated: false,
        reason: "Codex status reported that the account is not logged in.",
      };
    }
    if (lower.includes("logged in") || lower.includes("authenticated")) {
      return { authenticated: true };
    }
    return {
      authenticated: false,
      reason: "Codex status output did not report an authenticated account.",
    };
  }

  try {
    const parsed = JSON.parse(output) as unknown;
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      "loggedIn" in parsed &&
      (parsed as { readonly loggedIn?: unknown }).loggedIn === true
    ) {
      return { authenticated: true };
    }
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      "authenticated" in parsed &&
      (parsed as { readonly authenticated?: unknown }).authenticated === true
    ) {
      return { authenticated: true };
    }
  } catch {
    // Fall back to text matching for older CLI output.
  }

  const lower = output.toLowerCase();
  if (lower.includes("not logged in") || lower.includes('loggedin":false')) {
    return {
      authenticated: false,
      reason: "Claude status reported that the account is not logged in.",
    };
  }
  if (lower.includes("logged in") || lower.includes("authenticated")) {
    return { authenticated: true };
  }
  return {
    authenticated: false,
    reason: "Claude status output did not report an authenticated account.",
  };
}

const makeWsRpcLayer = (session: AuthenticatedSession) =>
  WsRpcGroup.toLayer(
    Effect.gen(function* () {
      const currentSessionId = session.sessionId;
      const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
      const orchestrationEngine = yield* OrchestrationEngineService;
      const checkpointDiffQuery = yield* CheckpointDiffQuery;
      const keybindings = yield* Keybindings;
      const open = yield* Open;
      const gitManager = yield* GitManager;
      const git = yield* GitCore;
      const gitStatusBroadcaster = yield* GitStatusBroadcaster;
      const terminalManager = yield* TerminalManager;
      const fileSystem = yield* FileSystem.FileSystem;
      const providerRegistry = yield* ProviderRegistry;
      const config = yield* ServerConfig;
      const lifecycleEvents = yield* ServerLifecycleEvents;
      const serverSettings = yield* ServerSettingsService;
      const startup = yield* ServerRuntimeStartup;
      const workspaceEntries = yield* WorkspaceEntries;
      const workspaceFileSystem = yield* WorkspaceFileSystem;
      const projectSetupScriptRunner = yield* ProjectSetupScriptRunner;
      const repositoryIdentityResolver = yield* RepositoryIdentityResolver;
      const serverEnvironment = yield* ServerEnvironment;
      const serverAuth = yield* ServerAuth;
      const bootstrapCredentials = yield* BootstrapCredentialService;
      const sessions = yield* SessionCredentialService;
      const collaboration = yield* CollaborationService;
      const organizations = yield* OrganizationService;
      const packRegistry = yield* PackRegistryService;
      const tenancyRepository = yield* TenancyRepository;
      const deployService = yield* DeployService;
      const analyticsStore = yield* AnalyticsStore;
      const deploymentRegistry = yield* DeploymentRegistry;
      const packEnablement = yield* PackEnablementService;
      const threadPreferences = yield* ProjectionThreadPreferenceRepository;
      const rateLimitRef = yield* Ref.make({
        windowStartedAt: Date.now(),
        count: 0,
      });
      // Token reports reach every watcher of a thread, so only the connection
      // that asked for the turn is allowed to attribute them to its own user.
      const turnsStartedHereRef = yield* Ref.make(new Set<string>());
      const collaborationActor = {
        userId: resolveAuthenticatedUserId(session),
        displayName: resolveCollaborationDisplayName(session),
      };
      const resolveCollaborationActor = serverAuth.resolveUserProfile(session).pipe(
        Effect.flatMap((profile) =>
          serverAuth.resolveLocalAccount(session).pipe(
            Effect.map((localAccount) => ({
              userId: profile.userId,
              displayName: profile.displayName,
              avatarInitials: profile.avatarInitials,
              ...(localAccount ? { email: localAccount.email } : {}),
            })),
          ),
        ),
        Effect.catchTag("AuthError", () => Effect.succeed(collaborationActor)),
      );
      const requireInviteAcceptingIdentity = <E>(
        inviteId: string,
        toError: (message: string) => E,
      ): Effect.Effect<void, E> =>
        hasDurableInviteIdentity(session, inviteId)
          ? Effect.void
          : Effect.fail(
              toError(
                isImplicitLocalOwnerSession(session)
                  ? "Open the employee setup link or sign in with the invited account before accepting this invite."
                  : "Sign in with the invited account before accepting this invite.",
              ),
            );
      const issueInviteSetupUrlPath = (input: {
        readonly inviteId: string;
      }): Effect.Effect<string, AuthError> =>
        Effect.succeed(inviteAccountSetupUrlPath({ inviteId: input.inviteId }));
      const threadPreferenceScope = {
        tenantId: session.tenantSessionContext?.tenantId ?? LOCAL_THREAD_PREFERENCE_TENANT_ID,
        userId: resolveAuthenticatedUserId(session),
      };
      const loadThreadFavoritePreferences = threadPreferences
        .listByUser(threadPreferenceScope)
        .pipe(
          Effect.map(
            (preferences) =>
              new Map(
                preferences.map((preference) => [preference.threadId, preference.favorite > 0]),
              ),
          ),
        );
      const withShellFavoritePreferences = (
        snapshot: OrchestrationShellSnapshot,
      ): Effect.Effect<OrchestrationShellSnapshot, never> =>
        loadThreadFavoritePreferences.pipe(
          Effect.map((favorites) => ({
            ...snapshot,
            threads: snapshot.threads.map((thread) =>
              withThreadFavoritePreference(thread, favorites),
            ),
          })),
          Effect.catch(() => Effect.succeed(snapshot)),
        );
      const withThreadDetailFavoritePreference = (
        thread: OrchestrationThread,
      ): Effect.Effect<OrchestrationThread, never> =>
        loadThreadFavoritePreferences.pipe(
          Effect.map((favorites) => withThreadFavoritePreference(thread, favorites)),
          Effect.catch(() => Effect.succeed(thread)),
        );
      const withThreadShellFavoritePreference = (
        thread: OrchestrationThreadShell,
      ): Effect.Effect<OrchestrationThreadShell, never> =>
        loadThreadFavoritePreferences.pipe(
          Effect.map((favorites) => withThreadFavoritePreference(thread, favorites)),
          Effect.catch(() => Effect.succeed(thread)),
        );
      const persistThreadFavoritePreference = (
        command: Extract<OrchestrationCommand, { type: "thread.meta.update" }>,
      ) =>
        command.favorite === undefined
          ? Effect.void
          : threadPreferences.upsert({
              ...threadPreferenceScope,
              threadId: command.threadId,
              favorite: command.favorite ? 1 : 0,
              updatedAt: new Date().toISOString(),
            });
      const stripUserPreferenceOnlyFavorite = (
        command: OrchestrationCommand,
      ): OrchestrationCommand | null => {
        if (command.type !== "thread.meta.update" || command.favorite === undefined) {
          return command;
        }

        const { favorite: _favorite, ...rest } = command;
        const hasSharedMetadata =
          command.title !== undefined ||
          command.modelSelection !== undefined ||
          command.branch !== undefined ||
          command.worktreePath !== undefined;
        return hasSharedMetadata ? (rest as OrchestrationCommand) : null;
      };
      const serverCommandId = (tag: string) =>
        CommandId.make(`server:${tag}:${crypto.randomUUID()}`);

      const deriveProjectOwnershipForCommand = (
        command: Extract<OrchestrationCommand, { type: "project.create" }>,
      ): Effect.Effect<
        OrchestrationProjectOwnership | undefined,
        OrchestrationDispatchCommandError
      > => {
        const tenantSession = session.tenantSessionContext;
        const activeWorkspaceId = tenantSession?.activeWorkspaceId;
        if (!tenantSession) {
          return Effect.succeed(command.ownership);
        }
        const requestedOwnership = command.ownership;
        if (requestedOwnership && requestedOwnership.tenantId !== tenantSession.tenantId) {
          return Effect.fail(
            new OrchestrationDispatchCommandError({
              message: "Project workspace ownership must belong to the active tenant.",
            }),
          );
        }
        const requestedWorkspaceId = requestedOwnership?.workspaceId ?? activeWorkspaceId;

        return Effect.all({
          organizations: tenancyRepository.loadOrganizations(),
          workspaces: tenancyRepository.loadWorkspaces(),
        }).pipe(
          Effect.mapError(
            (cause) =>
              new OrchestrationDispatchCommandError({
                message: "Failed to load tenant ownership metadata for project creation.",
                cause,
              }),
          ),
          Effect.flatMap(({ organizations: snapshot, workspaces }) => {
            // Without an explicit target, land the project in the tenant's own
            // workspace so members keep access to the files they just added.
            const targetWorkspaceId =
              requestedWorkspaceId ??
              workspaces.workspaces.find(
                (entry) => entry.tenantId === tenantSession.tenantId && entry.archivedAt === null,
              )?.id;
            if (targetWorkspaceId === null || targetWorkspaceId === undefined) {
              return Effect.succeed(command.ownership);
            }
            const tenant = snapshot.tenants.find((entry) => entry.id === tenantSession.tenantId);
            const organization =
              tenantSession.organizationId === null
                ? undefined
                : snapshot.organizations.find((entry) => entry.id === tenantSession.organizationId);
            const employee = snapshot.employees.find(
              (entry) =>
                entry.membership.tenantId === tenantSession.tenantId &&
                entry.membership.userId === tenantSession.userId &&
                entry.membership.disabledAt === null,
            );
            const workspace = workspaces.workspaces.find(
              (entry) =>
                entry.id === targetWorkspaceId &&
                entry.tenantId === tenantSession.tenantId &&
                entry.archivedAt === null,
            );
            if (requestedOwnership && !workspace) {
              return Effect.fail(
                new OrchestrationDispatchCommandError({
                  message: "Requested workspace was not found in the active tenant.",
                }),
              );
            }

            return Effect.succeed({
              tenantId: tenantSession.tenantId,
              tenantDisplayName: tenant?.displayName ?? String(tenantSession.tenantId),
              workspaceId: targetWorkspaceId,
              workspaceTitle: workspace?.title ?? command.title,
              organizationId: tenantSession.organizationId,
              organizationDisplayName: organization?.displayName ?? null,
              ownerUserId: tenantSession.userId,
              ownerDisplayName: employee?.displayName ?? collaborationActor.displayName,
            });
          }),
        );
      };

      const attachProjectOwnership = (
        command: OrchestrationCommand,
      ): Effect.Effect<OrchestrationCommand, OrchestrationDispatchCommandError> => {
        if (command.type !== "project.create") {
          return Effect.succeed(command);
        }
        return deriveProjectOwnershipForCommand(command).pipe(
          Effect.map((ownership) =>
            ownership === undefined
              ? command
              : {
                  ...command,
                  ownership,
                },
          ),
        );
      };

      /**
       * Signs a message with the identity of the connection that sent it.
       *
       * This is the only place an author is decided. The value comes from the
       * authenticated session and replaces whatever the command arrived with,
       * so a client cannot claim to be a colleague — attribution that a sender
       * can choose is worth less than none, because the transcript would then
       * read as authoritative while being forgeable.
       */
      const attachMessageAuthor = (command: OrchestrationCommand): OrchestrationCommand => {
        if (command.type !== "thread.turn.start") {
          return command;
        }
        return {
          ...command,
          message: {
            ...command.message,
            authorUserId: collaborationActor.userId,
          },
        };
      };

      const persistProjectWorkspaceMetadata = (
        command: OrchestrationCommand,
      ): Effect.Effect<void, OrchestrationDispatchCommandError> => {
        if (command.type !== "project.create") {
          return Effect.void;
        }
        const tenantSession = session.tenantSessionContext;
        const activeWorkspaceId = tenantSession?.activeWorkspaceId;
        const targetWorkspaceId = command.ownership?.workspaceId ?? activeWorkspaceId;
        if (!tenantSession || targetWorkspaceId === null || targetWorkspaceId === undefined) {
          return Effect.void;
        }

        return tenancyRepository.loadWorkspaces().pipe(
          Effect.mapError(
            (cause) =>
              new OrchestrationDispatchCommandError({
                message: "Failed to load hosted workspace metadata for project creation.",
                cause,
              }),
          ),
          Effect.flatMap((snapshot) => {
            const existingWorkspace = snapshot.workspaces.find(
              (workspace) =>
                workspace.id === targetWorkspaceId && workspace.tenantId === tenantSession.tenantId,
            );
            if (existingWorkspace) {
              return Effect.void;
            }
            return tenancyRepository
              .saveWorkspaces({
                workspaces: [
                  ...snapshot.workspaces,
                  {
                    id: targetWorkspaceId,
                    tenantId: tenantSession.tenantId,
                    organizationId:
                      command.ownership?.organizationId ?? tenantSession.organizationId,
                    ownerUserId: command.ownership?.ownerUserId ?? tenantSession.userId,
                    kind: tenantSession.organizationId === null ? "personal" : "corporate",
                    accessMode: tenantSession.organizationId === null ? "private" : "organization",
                    title: command.ownership?.workspaceTitle ?? command.title,
                    createdAt: command.createdAt,
                    archivedAt: null,
                  },
                ],
              })
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new OrchestrationDispatchCommandError({
                      message: "Failed to persist hosted workspace metadata for project creation.",
                      cause,
                    }),
                ),
              );
          }),
        );
      };

      const loadAuthAccessSnapshot = () =>
        Effect.all({
          pairingLinks: serverAuth.listPairingLinks().pipe(Effect.orDie),
          clientSessions: serverAuth.listClientSessions(currentSessionId).pipe(Effect.orDie),
        });

      const appendSetupScriptActivity = (input: {
        readonly threadId: ThreadId;
        readonly kind: "setup-script.requested" | "setup-script.started" | "setup-script.failed";
        readonly summary: string;
        readonly createdAt: string;
        readonly payload: Record<string, unknown>;
        readonly tone: "info" | "error";
      }) =>
        orchestrationEngine.dispatch({
          type: "thread.activity.append",
          commandId: serverCommandId("setup-script-activity"),
          threadId: input.threadId,
          activity: {
            id: EventId.make(crypto.randomUUID()),
            tone: input.tone,
            kind: input.kind,
            summary: input.summary,
            payload: input.payload,
            turnId: null,
            createdAt: input.createdAt,
          },
          createdAt: input.createdAt,
        });

      const toDispatchCommandError = (cause: unknown, fallbackMessage: string) =>
        Schema.is(OrchestrationDispatchCommandError)(cause)
          ? cause
          : new OrchestrationDispatchCommandError({
              message: cause instanceof Error ? cause.message : fallbackMessage,
              cause,
            });

      const rejectHostedLimit = <E>(
        rejection: HostedLimitRejection,
        toError: (message: string) => E,
      ): Effect.Effect<never, E> => {
        const tenantSession = session.tenantSessionContext;
        return recordPublicAccessLimitRejection({
          limit: rejection.limit,
          operation: rejection.operation,
          current: rejection.current,
          maximum: rejection.maximum,
          tenantId: tenantSession?.tenantId,
          userId: tenantSession?.userId,
        }).pipe(Effect.flatMap(() => Effect.fail(toError(rejection.message))));
      };

      const checkHostedRateLimit = <E>(toError: (message: string) => E): Effect.Effect<void, E> =>
        Effect.sync(() => {
          const tenantSession = session.tenantSessionContext;
          if (!tenantSession) return null;

          const now = Date.now();
          const userCount = incrementRpcRateBucket({
            key: `user:${tenantSession.userId}`,
            now,
          });
          const userMaximum = DEFAULT_PUBLIC_ACCESS_LIMITS.maxRpcRequestsPerMinutePerUser;
          if (userCount > userMaximum) {
            return {
              limit: "rpcRequestsThisMinuteForUser",
              operation: "rpc.dispatch",
              current: userCount,
              maximum: userMaximum,
              message: `Rate limit exceeded: ${userMaximum} RPC requests per minute are allowed for this user.`,
            } satisfies HostedLimitRejection;
          }

          const tenantCount = incrementRpcRateBucket({
            key: `tenant:${tenantSession.tenantId}`,
            now,
          });
          const tenantMaximum = DEFAULT_PUBLIC_ACCESS_LIMITS.maxRpcRequestsPerMinutePerTenant;
          if (tenantCount > tenantMaximum) {
            return {
              limit: "rpcRequestsThisMinuteForTenant",
              operation: "rpc.dispatch",
              current: tenantCount,
              maximum: tenantMaximum,
              message: `Rate limit exceeded: ${tenantMaximum} RPC requests per minute are allowed for this tenant.`,
            } satisfies HostedLimitRejection;
          }

          return null;
        }).pipe(
          Effect.flatMap((rejection) =>
            rejection ? rejectHostedLimit(rejection, toError) : Effect.void,
          ),
        );

      const checkLocalRateLimit = <E>(toError: (message: string) => E): Effect.Effect<void, E> =>
        Ref.modify(rateLimitRef, (state) => {
          const now = Date.now();
          const current =
            now - state.windowStartedAt >= WS_RPC_RATE_LIMIT_WINDOW_MS
              ? { windowStartedAt: now, count: 0 }
              : state;
          if (current.count >= WS_RPC_MAX_REQUESTS_PER_WINDOW) {
            return [false, current];
          }
          return [true, { ...current, count: current.count + 1 }];
        }).pipe(
          Effect.flatMap((allowed) =>
            allowed
              ? Effect.void
              : Effect.fail(
                  toError(
                    `Rate limit exceeded: ${WS_RPC_MAX_REQUESTS_PER_WINDOW} RPC requests per minute are allowed for this session.`,
                  ),
                ),
          ),
        );

      const checkRateLimit = <E>(toError: (message: string) => E): Effect.Effect<void, E> =>
        session.tenantSessionContext ? checkHostedRateLimit(toError) : checkLocalRateLimit(toError);

      const ensureHostedFileWriteLimit = <E>(
        input: { readonly contents: string; readonly encoding?: string | undefined },
        toError: (message: string) => E,
      ): Effect.Effect<void, E> => {
        if (!session.tenantSessionContext) {
          return Effect.void;
        }
        const sizeBytes = fileWriteSizeBytes(input);
        const maximum = DEFAULT_PUBLIC_ACCESS_LIMITS.maxFileUploadBytes;
        return sizeBytes <= maximum
          ? Effect.void
          : rejectHostedLimit(
              {
                limit: "fileUploadBytes",
                operation: "file.upload",
                current: sizeBytes,
                maximum,
                message: `File write exceeds public upload limit: ${sizeBytes} bytes requested, ${maximum} bytes allowed.`,
              },
              toError,
            );
      };

      const ensureHostedRpcRequestLimit = <E>(
        method: string,
        input: unknown,
        toError: (message: string) => E,
      ): Effect.Effect<void, E> => {
        if (!session.tenantSessionContext) {
          return Effect.void;
        }
        const sizeBytes = rpcPayloadSizeBytes(input);
        const maximum = DEFAULT_PUBLIC_ACCESS_LIMITS.maxRpcRequestBytes;
        return sizeBytes <= maximum
          ? Effect.void
          : rejectHostedLimit(
              {
                limit: "rpcRequestBytes",
                operation: method,
                current: sizeBytes,
                maximum,
                message: `${method} request exceeds public payload limit: ${sizeBytes} bytes requested, ${maximum} bytes allowed.`,
              },
              toError,
            );
      };

      const ensureHostedFileReadLimit = <E>(
        sizeBytes: number,
        toError: (message: string) => E,
      ): Effect.Effect<void, E> => {
        if (!session.tenantSessionContext) {
          return Effect.void;
        }
        const maximum = DEFAULT_PUBLIC_ACCESS_LIMITS.maxFileReadBytes;
        return sizeBytes <= maximum
          ? Effect.void
          : rejectHostedLimit(
              {
                limit: "fileReadBytes",
                operation: "file.read",
                current: sizeBytes,
                maximum,
                message: `File read exceeds public read limit: ${sizeBytes} bytes requested, ${maximum} bytes allowed.`,
              },
              toError,
            );
      };

      const ensureHostedDirectoryEntryLimit = <E>(
        entryCount: number,
        toError: (message: string) => E,
      ): Effect.Effect<void, E> => {
        if (!session.tenantSessionContext) {
          return Effect.void;
        }
        const maximum = DEFAULT_PUBLIC_ACCESS_LIMITS.maxDirectoryEntries;
        return entryCount <= maximum
          ? Effect.void
          : rejectHostedLimit(
              {
                limit: "directoryEntries",
                operation: "file.listDirectory",
                current: entryCount,
                maximum,
                message: `Directory listing exceeds public entry limit: ${entryCount} entries requested, ${maximum} entries allowed.`,
              },
              toError,
            );
      };

      const ensureHostedDiffLimit = <E>(
        diff: string,
        toError: (message: string) => E,
      ): Effect.Effect<void, E> => {
        if (!session.tenantSessionContext) {
          return Effect.void;
        }
        const sizeBytes = utf8SizeBytes(diff);
        const maximum = DEFAULT_PUBLIC_ACCESS_LIMITS.maxDiffBytes;
        return sizeBytes <= maximum
          ? Effect.void
          : rejectHostedLimit(
              {
                limit: "diffBytes",
                operation: "file.diff",
                current: sizeBytes,
                maximum,
                message: `Diff response exceeds public size limit: ${sizeBytes} bytes requested, ${maximum} bytes allowed.`,
              },
              toError,
            );
      };

      const ensureHostedRuntimeConcurrencyLimits = <E>(
        toError: (message: string) => E,
      ): Effect.Effect<void, E> => {
        const tenantSession = session.tenantSessionContext;
        if (!tenantSession) {
          return Effect.void;
        }

        return Effect.all({
          readModel: orchestrationEngine.getReadModel(),
          providerIsolation: tenancyRepository.loadProviderIsolation(),
        }).pipe(
          Effect.mapError(() =>
            toError("Failed to load hosted runtime concurrency state for this tenant."),
          ),
          Effect.flatMap(({ readModel, providerIsolation }) => {
            const activeProviderSessions = providerIsolation.providerSessions.filter(
              (providerSession) =>
                providerSession.endedAt === null &&
                providerSession.tenantId === tenantSession.tenantId,
            );
            const activeProviderSessionsForUser = activeProviderSessions.filter(
              (providerSession) => providerSession.userId === tenantSession.userId,
            );
            if (
              activeProviderSessionsForUser.length >=
              DEFAULT_PUBLIC_ACCESS_LIMITS.maxActiveProviderSessionsPerUser
            ) {
              return rejectHostedLimit(
                {
                  limit: "activeProviderSessionsForUser",
                  operation: "provider.session.start",
                  current: activeProviderSessionsForUser.length,
                  maximum: DEFAULT_PUBLIC_ACCESS_LIMITS.maxActiveProviderSessionsPerUser,
                  message: `Active provider session limit exceeded: ${activeProviderSessionsForUser.length} active provider sessions for this user, ${DEFAULT_PUBLIC_ACCESS_LIMITS.maxActiveProviderSessionsPerUser} allowed.`,
                },
                toError,
              );
            }

            if (
              activeProviderSessions.length >=
              DEFAULT_PUBLIC_ACCESS_LIMITS.maxActiveProviderSessionsPerTenant
            ) {
              return rejectHostedLimit(
                {
                  limit: "activeProviderSessionsForTenant",
                  operation: "provider.session.start",
                  current: activeProviderSessions.length,
                  maximum: DEFAULT_PUBLIC_ACCESS_LIMITS.maxActiveProviderSessionsPerTenant,
                  message: `Active provider session limit exceeded: ${activeProviderSessions.length} active provider sessions for this tenant, ${DEFAULT_PUBLIC_ACCESS_LIMITS.maxActiveProviderSessionsPerTenant} allowed.`,
                },
                toError,
              );
            }

            const projectRootById = new Map(
              readModel.projects.map((project) => [project.id, project.workspaceRoot] as const),
            );
            const isHostedThreadActive = (thread: (typeof readModel.threads)[number]) => {
              if (thread.latestTurn?.state !== "running") {
                return false;
              }
              const roots = [thread.worktreePath, projectRootById.get(thread.projectId)].filter(
                (root): root is string => typeof root === "string" && root.length > 0,
              );
              return activeProviderSessions.some((providerSession) =>
                roots.some((root) => isPathInsideRoot(root, providerSession.cwd)),
              );
            };
            const activeHostedThreads = readModel.threads.filter(isHostedThreadActive);
            const activeTurnsForTenant = activeHostedThreads.length;
            const activeTurnsForUser = activeHostedThreads.filter((thread) => {
              const roots = [thread.worktreePath, projectRootById.get(thread.projectId)].filter(
                (root): root is string => typeof root === "string" && root.length > 0,
              );
              return activeProviderSessionsForUser.some((providerSession) =>
                roots.some((root) => isPathInsideRoot(root, providerSession.cwd)),
              );
            }).length;

            if (activeTurnsForUser >= DEFAULT_PUBLIC_ACCESS_LIMITS.maxActiveTurnsPerUser) {
              return rejectHostedLimit(
                {
                  limit: "activeTurnsForUser",
                  operation: "provider.turn.start",
                  current: activeTurnsForUser,
                  maximum: DEFAULT_PUBLIC_ACCESS_LIMITS.maxActiveTurnsPerUser,
                  message: `Active turn limit exceeded: ${activeTurnsForUser} active turns for this user, ${DEFAULT_PUBLIC_ACCESS_LIMITS.maxActiveTurnsPerUser} allowed.`,
                },
                toError,
              );
            }

            if (activeTurnsForTenant >= DEFAULT_PUBLIC_ACCESS_LIMITS.maxActiveTurnsPerTenant) {
              return rejectHostedLimit(
                {
                  limit: "activeTurnsForTenant",
                  operation: "provider.turn.start",
                  current: activeTurnsForTenant,
                  maximum: DEFAULT_PUBLIC_ACCESS_LIMITS.maxActiveTurnsPerTenant,
                  message: `Active turn limit exceeded: ${activeTurnsForTenant} active turns for this tenant, ${DEFAULT_PUBLIC_ACCESS_LIMITS.maxActiveTurnsPerTenant} allowed.`,
                },
                toError,
              );
            }

            return Effect.void;
          }),
        );
      };

      const withRateLimit = <A, E, R>(
        effect: Effect.Effect<A, E, R>,
        toError: (message: string) => E,
      ) => checkRateLimit(toError).pipe(Effect.flatMap(() => effect));

      const withRateLimitedStream = <A, E, R>(
        stream: Stream.Stream<A, E, R>,
        toError: (message: string) => E,
      ) => Stream.unwrap(checkRateLimit(toError).pipe(Effect.as(stream)));

      const organizationSnapshot = (): Effect.Effect<OrganizationListResult, OrganizationError> =>
        organizations.listOrganizations();

      const actorMemberships = () =>
        Effect.all({
          organizations: organizationSnapshot(),
          collaboration: tenancyRepository.loadCollaboration().pipe(
            Effect.mapError(
              (cause) =>
                new OrganizationError({
                  code: "invalid-role",
                  message: "Failed to load collaboration memberships.",
                  cause,
                }),
            ),
          ),
        }).pipe(
          Effect.map(({ organizations, collaboration }) =>
            [...organizations.memberships, ...collaboration.memberships].filter(
              (membership) =>
                membership.userId === collaborationActor.userId && membership.disabledAt === null,
            ),
          ),
        );

      // Returns null for unscoped local sessions (implicit loopback owner or
      // legacy paired clients) and the set of member tenant ids otherwise.
      const sessionVisibleTenantIds = (): Effect.Effect<
        ReadonlySet<TenantId> | null,
        OrganizationError
      > => {
        if (!session.tenantSessionContext) {
          return Effect.succeed(null);
        }
        if (isImplicitLocalOwnerSession(session)) {
          return Effect.succeed(null);
        }
        return actorMemberships().pipe(
          Effect.map(
            (memberships) => new Set(memberships.map((membership) => membership.tenantId)),
          ),
        );
      };

      const ensureTenantPermission = (
        tenantId: TenantId,
        permission: TenantPermission,
      ): Effect.Effect<void, OrganizationError> =>
        actorMemberships().pipe(
          Effect.flatMap((memberships) => {
            const roles = memberships
              .filter((membership) => membership.tenantId === tenantId)
              .flatMap((membership) => membership.roles);
            if (hasTenantPermission({ roles, permission })) {
              return Effect.void;
            }
            return Effect.fail(
              new OrganizationError({
                code: "invalid-role",
                message: forbiddenMessage(permission),
              }),
            );
          }),
        );

      const ensureTenantPermissionForCollaboration = (
        tenantId: TenantId,
        permission: TenantPermission,
      ): Effect.Effect<void, CollaborationError> =>
        ensureTenantPermission(tenantId, permission).pipe(
          Effect.mapError(
            () =>
              new CollaborationError({
                code: "invalid-membership-rule",
                message: forbiddenMessage(permission),
              }),
          ),
        );

      const ensureTenantPermissionForPacks = (
        tenantId: TenantId,
        permission: TenantPermission,
      ): Effect.Effect<void, PackError> =>
        ensureTenantPermission(tenantId, permission).pipe(
          Effect.mapError(
            () =>
              new PackError({
                code: "visibility-forbidden",
                message: forbiddenMessage(permission),
              }),
          ),
        );

      /**
       * Which organizations a pack read may look through. Taken from the
       * session's own memberships and never from the payload: an organization
       * id that arrives on the wire is a claim, and a caller free to make it
       * could read every pack anybody has listed to an organization.
       */
      const sessionOrganizationIds = (): Effect.Effect<ReadonlyArray<OrganizationId>, PackError> =>
        actorMemberships().pipe(
          Effect.map((memberships) => [
            ...new Set(
              memberships
                .map((membership) => membership.organizationId)
                .filter(
                  (organizationId): organizationId is OrganizationId => organizationId !== null,
                ),
            ),
          ]),
          Effect.mapError(
            (cause) =>
              new PackError({
                code: "visibility-forbidden",
                message: "Failed to resolve the organizations this session belongs to.",
                cause,
              }),
          ),
        );

      const resolvePackViewerScope = (scope: {
        readonly tenantId: TenantId;
        readonly workspaceId: WorkspaceId;
      }) =>
        ensureTenantPermissionForPacks(scope.tenantId, "workspace.view").pipe(
          Effect.flatMap(() => sessionOrganizationIds()),
          Effect.map((organizationIds) => ({
            tenantId: scope.tenantId,
            workspaceId: scope.workspaceId,
            organizationIds,
          })),
        );

      const providerAccountError = (
        code: ProviderAccountError["code"],
        message: string,
        cause?: unknown,
      ) =>
        new ProviderAccountError({
          code,
          message,
          cause,
        });

      const recordProviderAccountAuditEvent = (
        tenantSession: NonNullable<AuthenticatedSession["tenantSessionContext"]>,
        kind: OrganizationAuditEventKind,
        summary: string,
      ): Effect.Effect<void, ProviderAccountError> => {
        if (tenantSession.organizationId === null) {
          return Effect.void;
        }
        return organizations
          .recordAuditEvent(collaborationActor, {
            organizationId: tenantSession.organizationId,
            kind,
            summary,
          })
          .pipe(
            Effect.mapError((cause) =>
              providerAccountError(
                "forbidden",
                "Failed to record provider account audit event.",
                cause,
              ),
            ),
            Effect.asVoid,
          );
      };

      const recordProviderAccountLaunchAuditEvents = (
        tenantSession: NonNullable<AuthenticatedSession["tenantSessionContext"]>,
        input: {
          readonly provider: string;
          readonly providerAccountId: string;
          readonly createdAccount: boolean;
          readonly cwd: string;
        },
      ): Effect.Effect<void, OrchestrationDispatchCommandError> => {
        if (tenantSession.organizationId === null) {
          return Effect.void;
        }
        const effects: Array<Effect.Effect<void, ProviderAccountError>> = [];
        if (input.createdAccount) {
          effects.push(
            recordProviderAccountAuditEvent(
              tenantSession,
              "provider-account-created",
              `${collaborationActor.displayName} created a ${input.provider} provider account for this organization tenant.`,
            ),
          );
        }
        effects.push(
          recordProviderAccountAuditEvent(
            tenantSession,
            "provider-account-launch-used",
            `${collaborationActor.displayName} launched ${input.provider} with provider account ${input.providerAccountId} in ${input.cwd}.`,
          ),
        );
        return Effect.all(effects, { discard: true }).pipe(
          Effect.mapError(
            (cause) =>
              new OrchestrationDispatchCommandError({
                message: "Failed to record hosted provider account audit event.",
                cause,
              }),
          ),
        );
      };

      const ensureHostedProviderAccountSession = (): Effect.Effect<
        NonNullable<AuthenticatedSession["tenantSessionContext"]>,
        ProviderAccountError
      > => {
        const tenantSession = session.tenantSessionContext;
        return tenantSession
          ? Effect.succeed(tenantSession)
          : Effect.fail(
              providerAccountError(
                "unauthenticated",
                "Provider account operations require a hosted tenant session.",
              ),
            );
      };

      const actorHasProviderAccountPermission = (
        tenantId: TenantId,
        permission: TenantPermission,
      ): Effect.Effect<boolean, ProviderAccountError> =>
        actorMemberships().pipe(
          Effect.mapError((cause) =>
            providerAccountError(
              "forbidden",
              `Failed to load memberships for ${permission}.`,
              cause,
            ),
          ),
          Effect.map((memberships) =>
            hasTenantPermission({
              roles: memberships
                .filter((membership) => membership.tenantId === tenantId)
                .flatMap((membership) => membership.roles),
              permission,
            }),
          ),
        );

      const hostedTenantRuntimeRootDir = path.join(config.baseDir, "tenant-runtimes");
      const secureProviderDirectories = (
        directories: readonly string[],
        failureMessage: string,
      ): Effect.Effect<void, ProviderAccountError> =>
        Effect.all(
          directories.map((directory) =>
            fileSystem.makeDirectory(directory, { recursive: true }).pipe(
              Effect.andThen(fileSystem.chmod(directory, 0o700)),
              Effect.mapError((cause) => providerAccountError("forbidden", failureMessage, cause)),
            ),
          ),
          { discard: true },
        );

      const resolveThreadConnectionCwd = (
        threadId: ThreadId,
      ): Effect.Effect<string, ProviderAccountError> =>
        projectionSnapshotQuery.getThreadShellById(threadId).pipe(
          Effect.mapError(() =>
            providerAccountError("forbidden", `Thread ${threadId} was not found.`),
          ),
          Effect.flatMap((thread) =>
            orchestrationEngine.getReadModel().pipe(
              Effect.flatMap((readModel) => {
                const threadShell = Option.isSome(thread)
                  ? thread.value
                  : readModel.threads.find((candidate) => candidate.id === threadId);
                if (!threadShell) {
                  return Effect.fail(
                    providerAccountError("forbidden", `Thread ${threadId} was not found.`),
                  );
                }
                const project = readModel.projects.find(
                  (candidate) => candidate.id === threadShell.projectId,
                );
                const cwd = threadShell.worktreePath ?? project?.workspaceRoot;
                if (!cwd) {
                  return Effect.fail(
                    providerAccountError("forbidden", `Thread ${threadId} project was not found.`),
                  );
                }
                return Effect.succeed(cwd);
              }),
            ),
          ),
        );

      const listProviderAccounts = () =>
        ensureHostedProviderAccountSession().pipe(
          Effect.flatMap((tenantSession) =>
            actorHasProviderAccountPermission(tenantSession.tenantId, "provider.use").pipe(
              Effect.flatMap((hasPermission) =>
                hasPermission
                  ? tenancyRepository.loadProviderIsolation().pipe(
                      Effect.mapError((cause) =>
                        providerAccountError(
                          "forbidden",
                          "Failed to load provider account status.",
                          cause,
                        ),
                      ),
                      Effect.map((snapshot) => ({
                        accounts: snapshot.providerAccounts
                          .filter((account) => canViewProviderAccount(account, tenantSession))
                          .map((account) =>
                            summarizeProviderAccount(account, snapshot.providerSessions),
                          ),
                      })),
                      Effect.tap((result) =>
                        recordProviderAccountAuditEvent(
                          tenantSession,
                          "provider-account-status-checked",
                          `${collaborationActor.displayName} checked ${result.accounts.length} provider account status record${result.accounts.length === 1 ? "" : "s"}.`,
                        ),
                      ),
                    )
                  : Effect.fail(
                      providerAccountError("forbidden", forbiddenMessage("provider.use")),
                    ),
              ),
            ),
          ),
        );

      const ensureProviderAccountConnectScopeAllowed = (
        tenantSession: NonNullable<AuthenticatedSession["tenantSessionContext"]>,
        accountScope: ProviderAccountConnectScope | undefined,
      ): Effect.Effect<void, ProviderAccountError> =>
        actorHasProviderAccountPermission(
          tenantSession.tenantId,
          accountScope === "organization" ? "provider.manage" : "provider.connect",
        ).pipe(
          Effect.flatMap((hasPermission) => {
            if (hasPermission) {
              return Effect.void;
            }
            return Effect.fail(
              providerAccountError(
                "forbidden",
                forbiddenMessage(
                  accountScope === "organization" ? "provider.manage" : "provider.connect",
                ),
              ),
            );
          }),
        );

      const connectProviderAccount = (input: {
        readonly provider: ProviderKind;
        readonly accountScope?: ProviderAccountConnectScope | undefined;
      }) =>
        ensureHostedProviderAccountSession().pipe(
          Effect.flatMap((tenantSession) =>
            ensureProviderAccountConnectScopeAllowed(tenantSession, input.accountScope).pipe(
              Effect.as({
                instructions: buildProviderConnectInstructions(input.provider),
              }),
            ),
          ),
        );

      const openProviderAccountAuthTerminal = (input: {
        readonly provider: ProviderKind;
        readonly threadId: ThreadId;
        readonly terminalId?: string | undefined;
        readonly accountScope?: ProviderAccountConnectScope | undefined;
      }) =>
        ensureHostedProviderAccountSession().pipe(
          Effect.flatMap((tenantSession) =>
            ensureProviderAccountConnectScopeAllowed(tenantSession, input.accountScope).pipe(
              Effect.flatMap(() => {
                if (
                  !hasTenantPermission({
                    roles: tenantSession.roles,
                    permission: "session.create",
                  })
                ) {
                  return Effect.fail(
                    providerAccountError("forbidden", forbiddenMessage("session.create")),
                  );
                }

                return resolveThreadConnectionCwd(input.threadId).pipe(Effect.asVoid);
              }),
              Effect.flatMap(() =>
                tenancyRepository
                  .loadProviderIsolation()
                  .pipe(
                    Effect.mapError((cause) =>
                      providerAccountError(
                        "forbidden",
                        "Failed to load provider account status.",
                        cause,
                      ),
                    ),
                  ),
              ),
              Effect.flatMap((snapshot) => {
                const runtimeLayout = deriveTenantRuntimeDirectoryLayout({
                  tenantId: tenantSession.tenantId,
                  rootDir: hostedTenantRuntimeRootDir,
                });
                const accountOwner = resolveProviderAccountOwnerForScope(
                  tenantSession,
                  input.accountScope,
                );
                const accountLayout = deriveProviderAccountHomeLayout({
                  runtimeLayout,
                  userId: tenantSession.userId,
                  provider: input.provider,
                  accountSegment:
                    accountOwner.type === "user"
                      ? accountOwner.userId
                      : accountOwner.type === "organization"
                        ? `organization-${accountOwner.organizationId}`
                        : `tenant-${accountOwner.tenantId}`,
                });
                const now = new Date().toISOString();
                const existingAccount = snapshot.providerAccounts.find(
                  (candidate) =>
                    candidate.provider === input.provider &&
                    candidate.tenantId === tenantSession.tenantId &&
                    candidate.owner.type === accountOwner.type &&
                    (candidate.owner.type === "user"
                      ? accountOwner.type === "user" &&
                        candidate.owner.userId === accountOwner.userId
                      : candidate.owner.type === "organization"
                        ? accountOwner.type === "organization" &&
                          candidate.owner.organizationId === accountOwner.organizationId
                        : accountOwner.type === "tenant" &&
                          candidate.owner.tenantId === accountOwner.tenantId),
                );
                const account: ProviderAccount = {
                  id: ProviderAccountId.make(
                    existingAccount?.id ??
                      `provider-account:${tenantSession.tenantId}:${
                        accountOwner.type === "user"
                          ? accountOwner.userId
                          : accountOwner.type === "organization"
                            ? `organization-${accountOwner.organizationId}`
                            : `tenant-${accountOwner.tenantId}`
                      }:${input.provider}`,
                  ),
                  provider: input.provider,
                  tenantId: tenantSession.tenantId,
                  owner: accountOwner,
                  sharing: accountOwner.type === "user" ? "private" : "tenant-shared",
                  authHomeDir: accountLayout.providerHomeDir,
                  configDir: accountLayout.configDir,
                  secretsDir: accountLayout.secretsDir,
                  createdAt: now,
                  disabledAt: null,
                };
                const providerSession: ProviderSessionIsolation = {
                  id: ProviderSessionId.make(
                    `provider-auth-terminal:${tenantSession.tenantId}:${tenantSession.userId}:${input.provider}`,
                  ),
                  tenantId: tenantSession.tenantId,
                  userId: tenantSession.userId,
                  providerAccountId: account.id,
                  provider: input.provider,
                  providerHomeDir: account.authHomeDir,
                  cwd: account.authHomeDir,
                  createdAt: now,
                  endedAt: null,
                };
                const launchEnvironment = deriveProviderLaunchEnvironment({
                  account,
                  providerSession,
                  tenantSession,
                  runtimeLayout,
                  baseEnv: process.env,
                });
                if (!launchEnvironment.allowed) {
                  return Effect.fail(
                    providerAccountError(
                      "forbidden",
                      `Provider account auth terminal denied: ${launchEnvironment.reason}`,
                    ),
                  );
                }

                const instructions = buildProviderConnectInstructions(input.provider);
                const terminalId = input.terminalId ?? `provider-auth-${input.provider}`;

                return secureProviderDirectories(
                  [account.authHomeDir, account.configDir, account.secretsDir],
                  "Failed to prepare isolated provider auth directory.",
                ).pipe(
                  Effect.flatMap(() =>
                    terminalManager.open({
                      threadId: input.threadId,
                      terminalId,
                      cwd: account.authHomeDir,
                      cols: 100,
                      rows: 24,
                      env: launchEnvironment.env,
                    }),
                  ),
                  Effect.tap(() =>
                    terminalManager.write({
                      threadId: input.threadId,
                      terminalId,
                      data: `${instructions.authCommand}\n`,
                    }),
                  ),
                  Effect.mapError((cause) =>
                    Schema.is(ProviderAccountError)(cause)
                      ? cause
                      : providerAccountError(
                          "forbidden",
                          "Failed to open provider auth terminal.",
                          cause,
                        ),
                  ),
                  Effect.map((terminal) => ({ instructions, terminal })),
                );
              }),
            ),
          ),
        );

      const confirmProviderAccount = (input: {
        readonly provider: ProviderKind;
        readonly threadId: ThreadId;
        readonly statusOutput: string;
        readonly accountScope?: ProviderAccountConnectScope | undefined;
      }) =>
        ensureHostedProviderAccountSession().pipe(
          Effect.flatMap((tenantSession) =>
            ensureProviderAccountConnectScopeAllowed(tenantSession, input.accountScope).pipe(
              Effect.flatMap(() => {
                if (
                  !hasTenantPermission({
                    roles: tenantSession.roles,
                    permission: "session.create",
                  })
                ) {
                  return Effect.fail(
                    providerAccountError("forbidden", forbiddenMessage("session.create")),
                  );
                }

                const locked = resolveProviderConnectLockout({
                  tenantSession,
                  provider: input.provider,
                  now: Date.now(),
                });
                if (locked) {
                  return rejectHostedLimit(locked, (message) =>
                    providerAccountError("rate-limited", message),
                  );
                }

                const confirmation = parseProviderAuthConfirmation(input);
                if (!confirmation.authenticated) {
                  const rejection = recordProviderConnectFailure({
                    tenantSession,
                    provider: input.provider,
                    now: Date.now(),
                  });
                  return Effect.all(
                    [
                      recordProviderAccountAuditEvent(
                        tenantSession,
                        "provider-account-connect-failed",
                        `${collaborationActor.displayName} failed to confirm ${input.provider} provider account authentication: ${confirmation.reason}`,
                      ),
                      rejection
                        ? recordPublicAccessLimitRejection({
                            limit: rejection.limit,
                            operation: rejection.operation,
                            current: rejection.current,
                            maximum: rejection.maximum,
                            tenantId: tenantSession.tenantId,
                            userId: tenantSession.userId,
                          })
                        : Effect.void,
                    ],
                    { discard: true },
                  ).pipe(
                    Effect.andThen(
                      Effect.fail(providerAccountError("not-authenticated", confirmation.reason)),
                    ),
                  );
                }

                return Effect.all({
                  cwd: resolveThreadConnectionCwd(input.threadId),
                  snapshot: tenancyRepository
                    .loadProviderIsolation()
                    .pipe(
                      Effect.mapError((cause) =>
                        providerAccountError(
                          "forbidden",
                          "Failed to load provider account status.",
                          cause,
                        ),
                      ),
                    ),
                }).pipe(
                  Effect.flatMap(({ cwd, snapshot }) => {
                    const now = new Date().toISOString();
                    const runtimeLayout = deriveTenantRuntimeDirectoryLayout({
                      tenantId: tenantSession.tenantId,
                      rootDir: hostedTenantRuntimeRootDir,
                    });
                    const plan = deriveProviderAccountConnectionPlan({
                      snapshot,
                      runtimeLayout,
                      tenantSession,
                      provider: input.provider,
                      cwd,
                      now,
                      accountOwner: resolveProviderAccountOwnerForScope(
                        tenantSession,
                        input.accountScope,
                      ),
                      baseEnv: process.env,
                    });
                    if (!plan.allowed) {
                      return Effect.fail(
                        providerAccountError(
                          "forbidden",
                          `Provider account confirmation denied: ${plan.reason}`,
                        ),
                      );
                    }
                    if (!plan.account || !plan.providerSession) {
                      return Effect.fail(
                        providerAccountError(
                          "forbidden",
                          "Provider account confirmation did not produce a launchable session.",
                        ),
                      );
                    }

                    const account = plan.account;
                    return secureProviderDirectories(
                      [account.authHomeDir, account.configDir, account.secretsDir],
                      "Failed to prepare confirmed provider account directories.",
                    ).pipe(
                      Effect.andThen(
                        tenancyRepository
                          .saveProviderIsolation(plan.snapshot)
                          .pipe(
                            Effect.mapError((cause) =>
                              providerAccountError(
                                "forbidden",
                                "Failed to persist confirmed provider account.",
                                cause,
                              ),
                            ),
                          ),
                      ),
                      Effect.tap(() =>
                        Effect.all(
                          [
                            plan.createdAccount
                              ? recordProviderAccountAuditEvent(
                                  tenantSession,
                                  "provider-account-created",
                                  `${collaborationActor.displayName} created a ${account.provider} provider account for this organization tenant.`,
                                )
                              : Effect.void,
                            recordProviderAccountAuditEvent(
                              tenantSession,
                              "provider-account-connect-confirmed",
                              `${collaborationActor.displayName} confirmed ${account.provider} provider account authentication for ${account.id}.`,
                            ),
                            Effect.sync(() =>
                              clearProviderConnectFailures({
                                tenantSession,
                                provider: input.provider,
                              }),
                            ),
                          ],
                          { discard: true },
                        ),
                      ),
                      Effect.map(() => ({
                        account: summarizeProviderAccount(account, plan.snapshot.providerSessions),
                      })),
                    );
                  }),
                );
              }),
            ),
          ),
        );

      const disconnectProviderAccount = (input: { readonly providerAccountId: string }) =>
        ensureHostedProviderAccountSession().pipe(
          Effect.flatMap((tenantSession) =>
            tenancyRepository.loadProviderIsolation().pipe(
              Effect.mapError((cause) =>
                providerAccountError("forbidden", "Failed to load provider account status.", cause),
              ),
              Effect.flatMap((snapshot) => {
                const account = snapshot.providerAccounts.find(
                  (candidate) =>
                    candidate.id === input.providerAccountId &&
                    canViewProviderAccount(candidate, tenantSession),
                );
                if (!account) {
                  return Effect.fail(
                    providerAccountError("not-found", "Provider account was not found."),
                  );
                }

                return actorHasProviderAccountPermission(
                  tenantSession.tenantId,
                  canOwnerDisconnectProviderAccount(account, tenantSession)
                    ? "provider.connect"
                    : "provider.manage",
                ).pipe(
                  Effect.flatMap((hasPermission) => {
                    if (!hasPermission) {
                      return Effect.fail(
                        providerAccountError(
                          "forbidden",
                          forbiddenMessage(
                            canOwnerDisconnectProviderAccount(account, tenantSession)
                              ? "provider.connect"
                              : "provider.manage",
                          ),
                        ),
                      );
                    }

                    const disconnectedAt = new Date().toISOString();
                    const providerAccounts = snapshot.providerAccounts.map((candidate) =>
                      candidate.id === account.id
                        ? { ...candidate, disabledAt: candidate.disabledAt ?? disconnectedAt }
                        : candidate,
                    );
                    const providerSessions = snapshot.providerSessions.map((providerSession) =>
                      providerSession.providerAccountId === account.id &&
                      providerSession.endedAt === null
                        ? { ...providerSession, endedAt: disconnectedAt }
                        : providerSession,
                    );
                    const updatedAccount =
                      providerAccounts.find((candidate) => candidate.id === account.id) ?? account;

                    return tenancyRepository
                      .saveProviderIsolation({ providerAccounts, providerSessions })
                      .pipe(
                        Effect.mapError((cause) =>
                          providerAccountError(
                            "forbidden",
                            "Failed to disconnect provider account.",
                            cause,
                          ),
                        ),
                        Effect.tap(() =>
                          recordProviderAccountAuditEvent(
                            tenantSession,
                            "provider-account-disconnected",
                            `${collaborationActor.displayName} disconnected ${updatedAccount.provider} provider account ${updatedAccount.id}.`,
                          ),
                        ),
                        Effect.as({
                          account: summarizeProviderAccount(updatedAccount, providerSessions),
                        }),
                      );
                  }),
                );
              }),
            ),
          ),
        );

      const ensureOrganizationPermission = (
        organizationId: OrganizationId,
        permission: OrganizationPermission,
      ): Effect.Effect<void, OrganizationError> =>
        actorMemberships().pipe(
          Effect.flatMap((memberships) => {
            const roles = memberships
              .filter((membership) => membership.organizationId === organizationId)
              .flatMap((membership) => membership.organizationRoles ?? []);
            if (hasOrganizationPermission({ roles, permission })) {
              return Effect.void;
            }
            return Effect.fail(
              new OrganizationError({
                code: "invalid-role",
                message: forbiddenMessage(permission),
              }),
            );
          }),
        );

      const filterOrganizationSnapshotForActor = (
        snapshot: OrganizationListResult,
      ): Effect.Effect<OrganizationListResult, never> => {
        if (!session.tenantSessionContext && isImplicitLocalOwnerSession(session)) {
          return Effect.succeed(snapshot);
        }
        return actorMemberships().pipe(
          Effect.map((memberships) => {
            const organizationIds = new Set(
              memberships
                .map((membership) => membership.organizationId)
                .filter(
                  (organizationId): organizationId is OrganizationId => organizationId !== null,
                ),
            );
            const tenantIds = new Set(memberships.map((membership) => membership.tenantId));
            const membershipIds = new Set(memberships.map((membership) => membership.id));
            return {
              organizations: snapshot.organizations.filter((organization) =>
                organizationIds.has(organization.id),
              ),
              tenants: snapshot.tenants.filter((tenant) => tenantIds.has(tenant.id)),
              employees: snapshot.employees.filter((employee) =>
                membershipIds.has(employee.membership.id),
              ),
              invites: snapshot.invites.filter((invite) => tenantIds.has(invite.tenantId)),
              memberships: snapshot.memberships.filter((membership) =>
                membershipIds.has(membership.id),
              ),
              teams: snapshot.teams.filter((team) => organizationIds.has(team.organizationId)),
              departments: snapshot.departments.filter((department) =>
                organizationIds.has(department.organizationId),
              ),
              grants: snapshot.grants.filter((grant) => organizationIds.has(grant.organizationId)),
              reviews: snapshot.reviews.filter((review) =>
                organizationIds.has(review.organizationId),
              ),
              ...(snapshot.workspaces
                ? {
                    workspaces: snapshot.workspaces.filter((workspace) =>
                      tenantIds.has(workspace.tenantId),
                    ),
                  }
                : {}),
            };
          }),
          Effect.orDie,
        );
      };

      const listOrganizationSnapshotForActor = (): Effect.Effect<
        OrganizationListResult,
        OrganizationError
      > =>
        organizations.listOrganizations().pipe(
          Effect.flatMap(filterOrganizationSnapshotForActor),
          Effect.flatMap((snapshot) =>
            tenancyRepository.loadWorkspaces().pipe(
              Effect.mapError(
                (cause) =>
                  new OrganizationError({
                    code: "organization-not-found",
                    message: "Failed to load workspace metadata.",
                    cause,
                  }),
              ),
              Effect.map((workspaceSnapshot) => {
                const visibleTenantIds = new Set(snapshot.tenants.map((tenant) => tenant.id));
                return {
                  ...snapshot,
                  workspaces: workspaceSnapshot.workspaces.filter(
                    (workspace) =>
                      workspace.archivedAt === null && visibleTenantIds.has(workspace.tenantId),
                  ),
                } satisfies OrganizationListResult;
              }),
            ),
          ),
        );

      const createTenantWorkspace = (input: {
        readonly tenantId: TenantId;
        readonly title: string;
        readonly kind?: "personal" | "shared" | "corporate" | "support";
        readonly accessMode?: "private" | "invite-only" | "organization";
      }) => {
        const tenantSession = session.tenantSessionContext;
        if (tenantSession && tenantSession.tenantId !== input.tenantId) {
          return Effect.fail(
            new OrganizationError({
              code: "invalid-role",
              message: "You can only create workspaces in your active tenant.",
            }),
          );
        }

        // The bootstrap tenant is created on demand a few lines below, so nobody
        // can hold a membership in it yet — and requiring one made a signed-in
        // person on their own machine hit "does not have workspace.edit" against
        // a tenant that did not exist. The two conditions have to agree, and the
        // one that matters is the same either way: a session scoped to some
        // other tenant may not reach this.
        const isBootstrappingLocalPersonal =
          !tenantSession && input.tenantId === TenantId.make("tenant-local-personal");
        const permissionCheck =
          isBootstrappingLocalPersonal || (!tenantSession && isImplicitLocalOwnerSession(session))
            ? Effect.void
            : ensureTenantPermission(input.tenantId, "workspace.edit");

        return permissionCheck.pipe(
          Effect.flatMap(() =>
            Effect.all({
              organizations: tenancyRepository.loadOrganizations(),
              workspaces: tenancyRepository.loadWorkspaces(),
            }).pipe(
              Effect.mapError(
                (cause) =>
                  new OrganizationError({
                    code: "organization-not-found",
                    message: "Failed to load tenant workspace metadata.",
                    cause,
                  }),
              ),
            ),
          ),
          Effect.flatMap(({ organizations: snapshot, workspaces }) => {
            let tenant = snapshot.tenants.find(
              (entry) => entry.id === input.tenantId && entry.archivedAt === null,
            );
            if (!tenant) {
              if (tenantSession || input.tenantId !== TenantId.make("tenant-local-personal")) {
                return Effect.fail(
                  new OrganizationError({
                    code: "organization-not-found",
                    message: "Tenant was not found.",
                  }),
                );
              }
              const createdAt = new Date().toISOString();
              tenant = {
                id: input.tenantId,
                slug: "local-personal",
                displayName: "Local Personal",
                kind: "personal",
                organizationId: null,
                runtimeId: TenantRuntimeId.make("runtime-local-personal"),
                createdAt,
                archivedAt: null,
              };
            }
            const accessMode =
              input.accessMode ?? (tenant.organizationId === null ? "private" : "organization");
            if (accessMode === "organization" && tenant.organizationId === null) {
              return Effect.fail(
                new OrganizationError({
                  code: "invalid-scope",
                  message: "Organization access requires an organization tenant.",
                }),
              );
            }
            const workspace = {
              id: WorkspaceId.make(`workspace:${crypto.randomUUID()}`),
              tenantId: tenant.id,
              organizationId: tenant.organizationId,
              ownerUserId: tenantSession?.userId ?? collaborationActor.userId,
              kind: input.kind ?? (tenant.organizationId === null ? "personal" : "corporate"),
              accessMode,
              title: input.title,
              createdAt: new Date().toISOString(),
              archivedAt: null,
            };
            const persistLocalTenant = snapshot.tenants.some((entry) => entry.id === tenant.id)
              ? Effect.void
              : tenancyRepository.saveOrganizations({
                  ...snapshot,
                  tenants: [...snapshot.tenants, tenant],
                });
            return persistLocalTenant.pipe(
              Effect.flatMap(() =>
                tenancyRepository.saveWorkspaces({
                  workspaces: [...workspaces.workspaces, workspace],
                }),
              ),
              Effect.mapError(
                (cause) =>
                  new OrganizationError({
                    code: "organization-not-found",
                    message: "Failed to save workspace metadata.",
                    cause,
                  }),
              ),
              Effect.as({ workspace }),
            );
          }),
        );
      };

      const knownWorkspaceRoots = () =>
        orchestrationEngine
          .getReadModel()
          .pipe(
            Effect.map((readModel) =>
              [
                ...readModel.projects.map((project) => project.workspaceRoot),
                ...readModel.threads.flatMap((thread) =>
                  thread.worktreePath ? [thread.worktreePath] : [],
                ),
              ].filter((value, index, values) => values.indexOf(value) === index),
            ),
          );

      const ensureWorkspaceRoot = <E>(
        cwd: string,
        permission: TenantPermission,
        toError: (message: string) => E,
      ): Effect.Effect<void, E> =>
        knownWorkspaceRoots().pipe(
          Effect.flatMap((roots) => {
            if (roots.length === 0 || roots.some((root) => isPathInsideRoot(cwd, root))) {
              return ensureTenantWorkspacePermission(cwd, permission, toError);
            }
            return Effect.fail(toError(forbiddenMessage(permission)));
          }),
        );

      // A collaborator can belong to several tenants at once — their own personal
      // tenant plus every workspace they were invited into. Authorize against the
      // roles they hold in the tenant that actually owns the path, not just the
      // tenant that happens to be active on the session.
      const resolveWorkspaceRootTenantRoles = (
        cwd: string,
      ): Effect.Effect<ReadonlyArray<TenantRole> | null, never> =>
        Effect.all({
          readModel: orchestrationEngine.getReadModel(),
          memberships: actorMemberships(),
        }).pipe(
          Effect.map(({ readModel, memberships }) => {
            const owningTenantIds = new Set(
              readModel.projects
                .filter(
                  (project) =>
                    project.ownership !== undefined && isPathInsideRoot(cwd, project.workspaceRoot),
                )
                .map((project) => project.ownership!.tenantId),
            );
            if (owningTenantIds.size === 0) {
              return null;
            }
            const roles = memberships
              .filter((membership) => owningTenantIds.has(membership.tenantId))
              .flatMap((membership) => membership.roles);
            return roles.length > 0 ? roles : null;
          }),
          Effect.catchCause(() => Effect.succeed(null)),
        );

      const ensureTenantWorkspacePermission = <E>(
        cwd: string,
        permission: TenantPermission,
        toError: (message: string) => E,
      ): Effect.Effect<void, E> => {
        const tenantSession = session.tenantSessionContext;
        if (tenantSession) {
          return resolveWorkspaceRootTenantRoles(cwd).pipe(
            Effect.flatMap((owningRoles) => {
              if (owningRoles !== null) {
                return hasTenantPermission({ roles: owningRoles, permission })
                  ? Effect.void
                  : Effect.fail(toError(forbiddenMessage(permission)));
              }
              // Unowned path: fall back to provider-session isolation.
              return hasTenantPermission({ roles: tenantSession.roles, permission })
                ? ensureProviderSessionGrantsWorkspaceRoot(cwd, permission, toError)
                : Effect.fail(toError(forbiddenMessage(permission)));
            }),
          );
        }

        if (session.userId) {
          return Effect.fail(toError(forbiddenMessage(permission)));
        }

        return Effect.void;
      };

      const ensureProviderSessionGrantsWorkspaceRoot = <E>(
        cwd: string,
        permission: TenantPermission,
        toError: (message: string) => E,
      ): Effect.Effect<void, E> =>
        tenancyRepository.loadProviderIsolation().pipe(
          Effect.mapError(() => toError(forbiddenMessage(permission))),
          Effect.flatMap((snapshot) => {
            const matchingProviderSession = snapshot.providerSessions.find((providerSession) => {
              if (
                providerSession.endedAt !== null ||
                providerSession.tenantId !== session.tenantSessionContext?.tenantId ||
                !isPathInsideRoot(cwd, providerSession.cwd)
              ) {
                return false;
              }
              const providerAccount = snapshot.providerAccounts.find(
                (account) => account.id === providerSession.providerAccountId,
              );
              return providerAccount
                ? evaluateProviderAccountAccess({
                    account: providerAccount,
                    providerSession,
                    tenantSession: session.tenantSessionContext,
                  }).allowed
                : false;
            });
            return matchingProviderSession
              ? Effect.void
              : Effect.fail(toError(forbiddenMessage(permission)));
          }),
        );

      const ensureAnyTenantWorkspacePermission = <E>(
        roots: readonly string[],
        permission: TenantPermission,
        toError: (message: string) => E,
      ): Effect.Effect<void, E> => {
        if (!session.tenantSessionContext && !session.userId) {
          return Effect.void;
        }

        return Effect.forEach(roots, (root) =>
          ensureTenantWorkspacePermission(root, permission, toError).pipe(Effect.option),
        ).pipe(
          Effect.flatMap((results) =>
            results.some(Option.isSome)
              ? Effect.void
              : Effect.fail(toError(forbiddenMessage(permission))),
          ),
        );
      };

      const ensureThreadAccess = <E>(
        threadId: ThreadId | string,
        permission: TenantPermission,
        toError: (message: string) => E,
      ): Effect.Effect<void, E> =>
        projectionSnapshotQuery.getThreadShellById(ThreadId.make(threadId)).pipe(
          Effect.mapError(() => toError(`Thread ${threadId} was not found.`)),
          Effect.flatMap((thread) => {
            return Effect.gen(function* () {
              const readModel = yield* orchestrationEngine.getReadModel();
              const threadShell = Option.isSome(thread)
                ? thread.value
                : readModel.threads.find((candidate) => candidate.id === threadId);
              if (!threadShell) {
                return yield* Effect.fail(toError(`Thread ${threadId} was not found.`));
              }
              const project = readModel.projects.find(
                (candidate) => candidate.id === threadShell.projectId,
              );
              const roots = [threadShell.worktreePath, project?.workspaceRoot].filter(
                (root): root is string => typeof root === "string" && root.length > 0,
              );
              if (roots.length === 0) {
                return yield* Effect.fail(toError(`Thread ${threadId} project was not found.`));
              }
              return yield* ensureAnyTenantWorkspacePermission(roots, permission, toError);
            }).pipe(Effect.mapError((error) => error as E));
          }),
        );

      const ensureDeployProjectAccess = (
        projectId: ProjectId,
        permission: TenantPermission,
      ): Effect.Effect<void, DeployError> =>
        orchestrationEngine.getReadModel().pipe(
          Effect.mapError(
            () =>
              new DeployError({
                code: "project-not-found",
                message: `Project ${projectId} was not found.`,
              }),
          ),
          Effect.flatMap((readModel) => {
            const project = readModel.projects.find((candidate) => candidate.id === projectId);
            if (!project) {
              return Effect.fail(
                new DeployError({
                  code: "project-not-found",
                  message: `Project ${projectId} was not found.`,
                }),
              );
            }
            return ensureWorkspaceRoot(
              project.workspaceRoot,
              permission,
              (message) => new DeployError({ code: "forbidden", message }),
            );
          }),
        );

      const resolveDeployTargetProject = (
        targetId: DeployTargetId,
      ): Effect.Effect<{ readonly id: ProjectId; readonly workspaceRoot: string }, DeployError> =>
        deployService.listTargets({}).pipe(
          Effect.flatMap((targets) => {
            const target = targets.find((candidate) => candidate.id === targetId);
            if (!target) {
              return Effect.fail(
                new DeployError({
                  code: "target-not-found",
                  message: `Deploy target ${targetId} was not found.`,
                }),
              );
            }
            return orchestrationEngine.getReadModel().pipe(
              Effect.mapError(
                () =>
                  new DeployError({
                    code: "project-not-found",
                    message: `Project ${target.projectId} was not found.`,
                  }),
              ),
              Effect.flatMap((readModel) => {
                const project = readModel.projects.find(
                  (candidate) => candidate.id === target.projectId,
                );
                return project
                  ? Effect.succeed({ id: project.id, workspaceRoot: project.workspaceRoot })
                  : Effect.fail(
                      new DeployError({
                        code: "project-not-found",
                        message: `Project ${target.projectId} was not found.`,
                      }),
                    );
              }),
            );
          }),
        );

      const gitRpcError = (cwd: string, message: string): GitCommandError =>
        new GitCommandError({
          operation: "authorize",
          command: "websocket-rpc",
          cwd,
          detail: message,
        });

      const terminalRpcError = (cwd: string, message: string): TerminalCwdError =>
        new TerminalCwdError({
          cwd,
          reason: "statFailed",
          cause: { message },
        });

      const ensureProjectAccess = (
        projectId: string,
        permission: TenantPermission,
      ): Effect.Effect<void, OrchestrationDispatchCommandError> =>
        orchestrationEngine.getReadModel().pipe(
          Effect.flatMap((readModel) => {
            const project = readModel.projects.find((candidate) => candidate.id === projectId);
            if (!project) {
              return Effect.fail(
                new OrchestrationDispatchCommandError({
                  message: `Project ${projectId} was not found.`,
                }),
              );
            }
            return ensureWorkspaceRoot(
              project.workspaceRoot,
              permission,
              (message) =>
                new OrchestrationDispatchCommandError({
                  message,
                }),
            );
          }),
        );

      const resolveTurnStartProviderConnectionTarget = (
        command: Extract<OrchestrationCommand, { type: "thread.turn.start" }>,
      ) =>
        orchestrationEngine.getReadModel().pipe(
          Effect.flatMap((readModel) => {
            const projectById = new Map(
              readModel.projects.map((project) => [project.id, project] as const),
            );
            const provider =
              command.modelSelection?.provider ??
              command.bootstrap?.createThread?.modelSelection.provider;

            if (command.bootstrap?.prepareWorktree) {
              return Effect.succeed({
                provider:
                  provider ?? command.bootstrap.createThread?.modelSelection.provider ?? "codex",
                cwd: command.bootstrap.prepareWorktree.projectCwd,
              });
            }

            if (command.bootstrap?.createThread) {
              const project = projectById.get(command.bootstrap.createThread.projectId);
              const cwd = command.bootstrap.createThread.worktreePath ?? project?.workspaceRoot;
              if (!cwd) {
                return Effect.fail(
                  new OrchestrationDispatchCommandError({
                    message: `Project ${command.bootstrap.createThread.projectId} was not found.`,
                  }),
                );
              }
              return Effect.succeed({
                provider:
                  provider ??
                  command.bootstrap.createThread.modelSelection.provider ??
                  project?.defaultModelSelection?.provider ??
                  "codex",
                cwd,
              });
            }

            const thread = readModel.threads.find((candidate) => candidate.id === command.threadId);
            if (!thread) {
              return Effect.fail(
                new OrchestrationDispatchCommandError({
                  message: `Thread ${command.threadId} was not found.`,
                }),
              );
            }
            const project = projectById.get(thread.projectId);
            const cwd = thread.worktreePath ?? project?.workspaceRoot;
            if (!cwd) {
              return Effect.fail(
                new OrchestrationDispatchCommandError({
                  message: `Thread ${command.threadId} project was not found.`,
                }),
              );
            }

            return Effect.succeed({
              provider:
                provider ??
                thread.modelSelection.provider ??
                project?.defaultModelSelection?.provider ??
                "codex",
              cwd,
            });
          }),
        );

      // Loopback-bound servers serve a single operator machine; remote-reachable
      // deployments are treated as multi-tenant and always isolate providers.
      const isSingleMachineServer = isLoopbackHost(config.host) && !isWildcardHost(config.host);

      // On a single operator machine a freshly isolated provider home has no
      // credentials, which leaves the CLI unable to initialize. Seed it once from
      // the operator's own login so local tenants work before linking an account.
      const OPERATOR_PROVIDER_CREDENTIAL_FILES = {
        codex: ["auth.json", "config.toml"],
        claudeAgent: [".credentials.json", "settings.json"],
      } as const satisfies Record<ProviderKind, ReadonlyArray<string>>;

      const operatorProviderHome = (provider: ProviderKind): string =>
        provider === "codex"
          ? (process.env["CODEX_HOME"] ?? path.join(os.homedir(), ".codex"))
          : path.join(os.homedir(), ".claude");

      const seedProviderHomeFromOperator = (
        provider: ProviderKind,
        authHomeDir: string,
      ): Effect.Effect<void, never> => {
        if (!isSingleMachineServer) {
          return Effect.void;
        }
        const sourceHome = operatorProviderHome(provider);
        return Effect.forEach(
          OPERATOR_PROVIDER_CREDENTIAL_FILES[provider],
          (fileName) =>
            Effect.gen(function* () {
              const target = path.join(authHomeDir, fileName);
              if (yield* fileSystem.exists(target)) {
                return;
              }
              const source = path.join(sourceHome, fileName);
              if (!(yield* fileSystem.exists(source))) {
                return;
              }
              yield* fileSystem.copyFile(source, target);
              yield* fileSystem.chmod(target, 0o600);
            }).pipe(Effect.ignore),
          { discard: true },
        );
      };

      const persistHostedProviderConnectionForTurnStart = (
        command: Extract<OrchestrationCommand, { type: "thread.turn.start" }>,
      ): Effect.Effect<void, OrchestrationDispatchCommandError> => {
        const tenantSession = session.tenantSessionContext;
        if (!tenantSession) {
          return Effect.void;
        }
        if (!hasTenantPermission({ roles: tenantSession.roles, permission: "provider.use" })) {
          return Effect.fail(
            new OrchestrationDispatchCommandError({
              message: forbiddenMessage("provider.use"),
            }),
          );
        }

        return Effect.all({
          snapshot: tenancyRepository.loadProviderIsolation(),
          target: resolveTurnStartProviderConnectionTarget(command),
          canConnectPersonalAccount: actorHasProviderAccountPermission(
            tenantSession.tenantId,
            "provider.connect",
          ),
        }).pipe(
          Effect.mapError((cause) =>
            Schema.is(OrchestrationDispatchCommandError)(cause)
              ? cause
              : new OrchestrationDispatchCommandError({
                  message: "Failed to prepare hosted provider account isolation.",
                  cause,
                }),
          ),
          Effect.flatMap(({ snapshot, target, canConnectPersonalAccount }) => {
            const reusableAccount = snapshot.providerAccounts
              .filter(
                (account) =>
                  account.provider === target.provider &&
                  account.disabledAt === null &&
                  canViewProviderAccount(account, tenantSession),
              )
              .toSorted((left, right) => {
                const leftShared = isSharedProviderAccount(left) ? 0 : 1;
                const rightShared = isSharedProviderAccount(right) ? 0 : 1;
                return leftShared - rightShared;
              })[0];

            if (!reusableAccount && !canConnectPersonalAccount) {
              return Effect.fail(
                new OrchestrationDispatchCommandError({
                  message:
                    "No shared organization provider account is available, and this user cannot create a personal provider account.",
                }),
              );
            }

            const plan = deriveProviderAccountConnectionPlan({
              snapshot,
              runtimeLayout: deriveTenantRuntimeDirectoryLayout({
                tenantId: tenantSession.tenantId,
                rootDir: hostedTenantRuntimeRootDir,
              }),
              tenantSession,
              provider: target.provider,
              cwd: target.cwd,
              now: command.createdAt,
              ...(reusableAccount ? { providerAccountId: reusableAccount.id } : {}),
              baseEnv: process.env,
            });
            if (!plan.allowed) {
              return Effect.fail(
                new OrchestrationDispatchCommandError({
                  message: `Provider account isolation denied: ${plan.reason}`,
                }),
              );
            }
            if (!plan.account || !plan.providerSession) {
              return Effect.fail(
                new OrchestrationDispatchCommandError({
                  message: "Provider account isolation did not produce a launchable session.",
                }),
              );
            }
            const planAccount = plan.account;
            const planProviderSession = plan.providerSession;
            // The provider is launched with these directories as its home; create
            // them up front or the CLI exits before it can complete initialize.
            return Effect.all(
              [planAccount.authHomeDir, planAccount.configDir, planAccount.secretsDir].map(
                (directory) =>
                  fileSystem
                    .makeDirectory(directory, { recursive: true })
                    .pipe(Effect.andThen(fileSystem.chmod(directory, 0o700))),
              ),
              { discard: true },
            )
              .pipe(
                Effect.andThen(
                  seedProviderHomeFromOperator(planAccount.provider, planAccount.authHomeDir),
                ),
                Effect.mapError(
                  (cause) =>
                    new OrchestrationDispatchCommandError({
                      message: "Failed to prepare the isolated provider home directory.",
                      cause,
                    }),
                ),
                Effect.flatMap(() => tenancyRepository.saveProviderIsolation(plan.snapshot)),
              )
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new OrchestrationDispatchCommandError({
                      message: "Failed to persist hosted provider account isolation.",
                      cause,
                    }),
                ),
                Effect.tap(() =>
                  recordProviderAccountLaunchAuditEvents(tenantSession, {
                    provider: planAccount.provider,
                    providerAccountId: planAccount.id,
                    createdAccount: plan.createdAccount,
                    cwd: planProviderSession.cwd,
                  }),
                ),
              );
          }),
        );
      };

      /** The shared workspace a turn answers to, or null when it answers to none. */
      const resolveTurnStartOwnership = (
        command: Extract<OrchestrationCommand, { type: "thread.turn.start" }>,
      ) =>
        orchestrationEngine.getReadModel().pipe(
          Effect.map((readModel) => {
            const projectId =
              command.bootstrap?.createThread?.projectId ??
              readModel.threads.find((thread) => thread.id === command.threadId)?.projectId ??
              null;
            return projectId
              ? (readModel.projects.find((project) => project.id === projectId)?.ownership ?? null)
              : null;
          }),
        );

      /**
       * Holds a turn back when the workspace reviews prompts and this person is
       * not an approver. The browser asks the same question before dispatching,
       * but that is a courtesy to the author — this is what actually enforces it.
       */
      const ensureTurnStartApproved = (
        command: Extract<OrchestrationCommand, { type: "thread.turn.start" }>,
      ): Effect.Effect<void, OrchestrationDispatchCommandError> =>
        Effect.gen(function* () {
          const mayRun = yield* Effect.gen(function* () {
            const ownership = yield* resolveTurnStartOwnership(command);
            // A project outside any shared workspace has nobody to answer to.
            if (!ownership) {
              return true;
            }

            const actor = yield* resolveCollaborationActor;
            const decision = yield* collaboration.consumeApprovalForTurn(actor, {
              tenantId: ownership.tenantId,
              workspaceId: ownership.workspaceId,
            });
            return decision.mayRun;
          }).pipe(
            // Only a refusal should stop a turn. Failing to read the settings
            // must not take prompting down for every unshared project too.
            Effect.catchCause(() => Effect.succeed(true)),
          );

          if (!mayRun) {
            return yield* new OrchestrationDispatchCommandError({
              message:
                "This workspace reviews prompts before they run. Yours is waiting for the workspace lead.",
            });
          }
        });

      /**
       * Refuses a turn from someone the workspace only lets watch. `viewer` is a
       * role the roster already hands out, so this is what makes it mean
       * something rather than being a label.
       */
      const ensureTurnStartWritable = (
        command: Extract<OrchestrationCommand, { type: "thread.turn.start" }>,
      ): Effect.Effect<void, OrchestrationDispatchCommandError> =>
        Effect.gen(function* () {
          const mayRun = yield* Effect.gen(function* () {
            const ownership = yield* resolveTurnStartOwnership(command);
            if (!ownership) {
              return true;
            }

            const actor = yield* resolveCollaborationActor;
            const decision = yield* collaboration.checkWriteAccessForTurn(actor, {
              tenantId: ownership.tenantId,
              workspaceId: ownership.workspaceId,
            });
            return decision.mayRun;
          }).pipe(
            // As with approvals, a failed read must not stop everyone working.
            Effect.catchCause(() => Effect.succeed(true)),
          );

          if (!mayRun) {
            return yield* new OrchestrationDispatchCommandError({
              message: "This workspace is read-only for you.",
            });
          }
        });

      /**
       * Attributes a thread's tokens to whoever asked for the turn. Providers
       * report a running total many times over, so the collaboration service
       * keeps the highest figure rather than summing what it is sent, and
       * derives the change since the last report for the usage series.
       *
       * The whole snapshot is forwarded, not just `usedTokens`: the token split
       * is what makes a cost estimate possible, and the thread lookup below is
       * already being done for ownership, so the model it is running costs
       * nothing extra to read.
       */
      const recordThreadTokenUsage = (event: OrchestrationEvent): Effect.Effect<void> =>
        Effect.gen(function* () {
          if (event.type !== "thread.activity-appended") {
            return;
          }
          const activity = event.payload.activity;
          if (activity.kind !== "context-window.updated") {
            return;
          }
          const usage = activity.payload as Partial<ThreadTokenUsageSnapshot> | null;
          const usedTokens = usage?.usedTokens;
          if (typeof usedTokens !== "number" || usedTokens <= 0) {
            return;
          }

          const threadId = event.payload.threadId;
          const turnsStartedHere = yield* Ref.get(turnsStartedHereRef);
          if (!turnsStartedHere.has(threadId)) {
            return;
          }

          const readModel = yield* orchestrationEngine.getReadModel();
          const thread = readModel.threads.find((candidate) => candidate.id === threadId) ?? null;
          const projectId = thread?.projectId ?? null;
          const ownership = projectId
            ? (readModel.projects.find((project) => project.id === projectId)?.ownership ?? null)
            : null;
          if (!ownership) {
            return;
          }

          // A non-negative whole number of tokens, or nothing. A provider that
          // omits an axis must not be turned into a confident zero delta, which
          // is why these stay undefined rather than defaulting.
          const tokenCount = (value: unknown): number | undefined =>
            typeof value === "number" && Number.isFinite(value) && value >= 0
              ? NonNegativeInt.make(Math.trunc(value))
              : undefined;

          const actor = yield* resolveCollaborationActor;
          yield* collaboration.recordUsage(actor, {
            tenantId: ownership.tenantId,
            workspaceId: ownership.workspaceId,
            threadId,
            totalTokens: NonNegativeInt.make(Math.trunc(usedTokens)),
            inputTokens: tokenCount(usage?.inputTokens),
            cachedInputTokens: tokenCount(usage?.cachedInputTokens),
            outputTokens: tokenCount(usage?.outputTokens),
            reasoningOutputTokens: tokenCount(usage?.reasoningOutputTokens),
            turnId: activity.turnId ?? undefined,
            // Raw provider and model ids, kept exactly as the thread declares
            // them. Labelling is the UI's business, and a renamed label should
            // not rewrite what history says was spent.
            provider: thread?.modelSelection.provider,
            model: thread?.modelSelection.model,
          });
        }).pipe(
          // Bookkeeping must never disturb the stream someone is watching their
          // own turn on.
          Effect.catchCause(() => Effect.void),
        );

      const ensureOrchestrationCommandAuthorized = (
        command: OrchestrationCommand,
      ): Effect.Effect<void, OrchestrationDispatchCommandError> => {
        switch (command.type) {
          case "project.create":
            return checkRateLimit((message) => new OrchestrationDispatchCommandError({ message }));
          case "project.meta.update":
          case "project.delete":
            return checkRateLimit(
              (message) => new OrchestrationDispatchCommandError({ message }),
            ).pipe(Effect.flatMap(() => ensureProjectAccess(command.projectId, "project.edit")));
          case "thread.create":
            return checkRateLimit(
              (message) => new OrchestrationDispatchCommandError({ message }),
            ).pipe(Effect.flatMap(() => ensureProjectAccess(command.projectId, "session.create")));
          case "thread.turn.start":
            return checkRateLimit(
              (message) => new OrchestrationDispatchCommandError({ message }),
            ).pipe(
              Effect.flatMap(() =>
                ensureHostedRuntimeConcurrencyLimits(
                  (message) => new OrchestrationDispatchCommandError({ message }),
                ),
              ),
              Effect.flatMap(() => persistHostedProviderConnectionForTurnStart(command)),
              Effect.flatMap(() => {
                const checks: Array<Effect.Effect<void, OrchestrationDispatchCommandError>> = [];
                if (command.bootstrap?.createThread) {
                  checks.push(
                    ensureProjectAccess(command.bootstrap.createThread.projectId, "session.create"),
                  );
                }
                if (command.bootstrap?.prepareWorktree && !command.bootstrap.createThread) {
                  checks.push(
                    ensureWorkspaceRoot(
                      command.bootstrap.prepareWorktree.projectCwd,
                      "session.create",
                      (message) => new OrchestrationDispatchCommandError({ message }),
                    ),
                  );
                }
                if (checks.length > 0) {
                  return Effect.all(checks, { discard: true });
                }
                return ensureThreadAccess(
                  command.threadId,
                  "session.prompt",
                  (message) => new OrchestrationDispatchCommandError({ message }),
                );
              }),
              Effect.flatMap(() => ensureTurnStartWritable(command)),
              Effect.flatMap(() => ensureTurnStartApproved(command)),
            );
          case "thread.turn.interrupt":
          case "thread.approval.respond":
          case "thread.user-input.respond":
          case "thread.checkpoint.revert":
          case "thread.session.stop":
            return checkRateLimit(
              (message) => new OrchestrationDispatchCommandError({ message }),
            ).pipe(
              Effect.flatMap(() =>
                ensureThreadAccess(
                  command.threadId,
                  "session.prompt",
                  (message) => new OrchestrationDispatchCommandError({ message }),
                ),
              ),
            );
          case "thread.delete":
          case "thread.archive":
          case "thread.unarchive":
          case "thread.meta.update":
          case "thread.interaction-mode.set":
            return checkRateLimit(
              (message) => new OrchestrationDispatchCommandError({ message }),
            ).pipe(
              Effect.flatMap(() =>
                ensureThreadAccess(
                  command.threadId,
                  "session.view",
                  (message) => new OrchestrationDispatchCommandError({ message }),
                ),
              ),
            );
          case "thread.runtime-mode.set":
            return checkRateLimit(
              (message) => new OrchestrationDispatchCommandError({ message }),
            ).pipe(
              Effect.flatMap(() =>
                ensureThreadAccess(
                  command.threadId,
                  "runtime.manage",
                  (message) => new OrchestrationDispatchCommandError({ message }),
                ),
              ),
            );
          default:
            return checkRateLimit(
              (message) => new OrchestrationDispatchCommandError({ message }),
            ).pipe(
              Effect.flatMap(() =>
                Effect.fail(
                  new OrchestrationDispatchCommandError({
                    message: "Unsupported orchestration command.",
                  }),
                ),
              ),
            );
        }
      };

      const toBootstrapDispatchCommandCauseError = (cause: Cause.Cause<unknown>) => {
        const error = Cause.squash(cause);
        return Schema.is(OrchestrationDispatchCommandError)(error)
          ? error
          : new OrchestrationDispatchCommandError({
              message:
                error instanceof Error ? error.message : "Failed to bootstrap thread turn start.",
              cause,
            });
      };

      const enrichProjectEvent = (
        event: OrchestrationEvent,
      ): Effect.Effect<OrchestrationEvent, never, never> => {
        switch (event.type) {
          case "project.created":
            return repositoryIdentityResolver.resolve(event.payload.workspaceRoot).pipe(
              Effect.map((repositoryIdentity) => ({
                ...event,
                payload: {
                  ...event.payload,
                  repositoryIdentity,
                },
              })),
            );
          case "project.meta-updated":
            return Effect.gen(function* () {
              const workspaceRoot =
                event.payload.workspaceRoot ??
                (yield* orchestrationEngine.getReadModel()).projects.find(
                  (project) => project.id === event.payload.projectId,
                )?.workspaceRoot ??
                null;
              if (workspaceRoot === null) {
                return event;
              }

              const repositoryIdentity = yield* repositoryIdentityResolver.resolve(workspaceRoot);
              return {
                ...event,
                payload: {
                  ...event.payload,
                  repositoryIdentity,
                },
              } satisfies OrchestrationEvent;
            });
          default:
            return Effect.succeed(event);
        }
      };

      const enrichOrchestrationEvents = (events: ReadonlyArray<OrchestrationEvent>) =>
        Effect.forEach(events, enrichProjectEvent, { concurrency: 4 });

      const toShellStreamEvent = (
        event: OrchestrationEvent,
      ): Effect.Effect<Option.Option<OrchestrationShellStreamEvent>, never, never> => {
        switch (event.type) {
          case "project.created":
          case "project.meta-updated":
            return projectionSnapshotQuery.getProjectShellById(event.payload.projectId).pipe(
              Effect.map((project) =>
                Option.map(project, (nextProject) => ({
                  kind: "project-upserted" as const,
                  sequence: event.sequence,
                  project: nextProject,
                })),
              ),
              Effect.catch(() => Effect.succeed(Option.none())),
            );
          case "project.deleted":
            return Effect.succeed(
              Option.some({
                kind: "project-removed" as const,
                sequence: event.sequence,
                projectId: event.payload.projectId,
              }),
            );
          case "thread.deleted":
            return Effect.succeed(
              Option.some({
                kind: "thread-removed" as const,
                sequence: event.sequence,
                threadId: event.payload.threadId,
              }),
            );
          default:
            if (event.aggregateKind !== "thread") {
              return Effect.succeed(Option.none());
            }
            return projectionSnapshotQuery
              .getThreadShellById(ThreadId.make(event.aggregateId))
              .pipe(
                Effect.flatMap((thread) =>
                  Option.isSome(thread)
                    ? withThreadShellFavoritePreference(thread.value).pipe(Effect.map(Option.some))
                    : Effect.succeed(thread),
                ),
                Effect.map((thread) =>
                  Option.map(thread, (nextThread) => ({
                    kind: "thread-upserted" as const,
                    sequence: event.sequence,
                    thread: nextThread,
                  })),
                ),
                Effect.catch(() => Effect.succeed(Option.none())),
              );
        }
      };

      const dispatchBootstrapTurnStart = (
        command: Extract<OrchestrationCommand, { type: "thread.turn.start" }>,
      ): Effect.Effect<{ readonly sequence: number }, OrchestrationDispatchCommandError> =>
        Effect.gen(function* () {
          const bootstrap = command.bootstrap;
          const { bootstrap: _bootstrap, ...finalTurnStartCommand } = command;
          let createdThread = false;
          let targetProjectId = bootstrap?.createThread?.projectId;
          let targetProjectCwd = bootstrap?.prepareWorktree?.projectCwd;
          let targetWorktreePath = bootstrap?.createThread?.worktreePath ?? null;

          const cleanupCreatedThread = () =>
            createdThread
              ? orchestrationEngine
                  .dispatch({
                    type: "thread.delete",
                    commandId: serverCommandId("bootstrap-thread-delete"),
                    threadId: command.threadId,
                  })
                  .pipe(Effect.ignoreCause({ log: true }))
              : Effect.void;

          const recordSetupScriptLaunchFailure = (input: {
            readonly error: unknown;
            readonly requestedAt: string;
            readonly worktreePath: string;
          }) => {
            const detail =
              input.error instanceof Error ? input.error.message : "Unknown setup failure.";
            return appendSetupScriptActivity({
              threadId: command.threadId,
              kind: "setup-script.failed",
              summary: "Setup script failed to start",
              createdAt: input.requestedAt,
              payload: {
                detail,
                worktreePath: input.worktreePath,
              },
              tone: "error",
            }).pipe(
              Effect.ignoreCause({ log: false }),
              Effect.flatMap(() =>
                Effect.logWarning("bootstrap turn start failed to launch setup script", {
                  threadId: command.threadId,
                  worktreePath: input.worktreePath,
                  detail,
                }),
              ),
            );
          };

          const recordSetupScriptStarted = (input: {
            readonly requestedAt: string;
            readonly worktreePath: string;
            readonly scriptId: string;
            readonly scriptName: string;
            readonly terminalId: string;
          }) => {
            const payload = {
              scriptId: input.scriptId,
              scriptName: input.scriptName,
              terminalId: input.terminalId,
              worktreePath: input.worktreePath,
            };
            return Effect.all([
              appendSetupScriptActivity({
                threadId: command.threadId,
                kind: "setup-script.requested",
                summary: "Starting setup script",
                createdAt: input.requestedAt,
                payload,
                tone: "info",
              }),
              appendSetupScriptActivity({
                threadId: command.threadId,
                kind: "setup-script.started",
                summary: "Setup script started",
                createdAt: new Date().toISOString(),
                payload,
                tone: "info",
              }),
            ]).pipe(
              Effect.asVoid,
              Effect.catch((error) =>
                Effect.logWarning(
                  "bootstrap turn start launched setup script but failed to record setup activity",
                  {
                    threadId: command.threadId,
                    worktreePath: input.worktreePath,
                    scriptId: input.scriptId,
                    terminalId: input.terminalId,
                    detail: error.message,
                  },
                ),
              ),
            );
          };

          const runSetupProgram = () =>
            bootstrap?.runSetupScript && targetWorktreePath
              ? (() => {
                  const worktreePath = targetWorktreePath;
                  const requestedAt = new Date().toISOString();
                  return projectSetupScriptRunner
                    .runForThread({
                      threadId: command.threadId,
                      ...(targetProjectId ? { projectId: targetProjectId } : {}),
                      ...(targetProjectCwd ? { projectCwd: targetProjectCwd } : {}),
                      worktreePath,
                    })
                    .pipe(
                      Effect.matchEffect({
                        onFailure: (error) =>
                          recordSetupScriptLaunchFailure({
                            error,
                            requestedAt,
                            worktreePath,
                          }),
                        onSuccess: (setupResult) => {
                          if (setupResult.status !== "started") {
                            return Effect.void;
                          }
                          return recordSetupScriptStarted({
                            requestedAt,
                            worktreePath,
                            scriptId: setupResult.scriptId,
                            scriptName: setupResult.scriptName,
                            terminalId: setupResult.terminalId,
                          });
                        },
                      }),
                    );
                })()
              : Effect.void;

          const bootstrapProgram = Effect.gen(function* () {
            if (bootstrap?.createThread) {
              yield* orchestrationEngine.dispatch({
                type: "thread.create",
                commandId: serverCommandId("bootstrap-thread-create"),
                threadId: command.threadId,
                projectId: bootstrap.createThread.projectId,
                title: bootstrap.createThread.title,
                modelSelection: bootstrap.createThread.modelSelection,
                runtimeMode: bootstrap.createThread.runtimeMode,
                interactionMode: bootstrap.createThread.interactionMode,
                branch: bootstrap.createThread.branch,
                worktreePath: bootstrap.createThread.worktreePath,
                createdAt: bootstrap.createThread.createdAt,
              });
              createdThread = true;
            }

            if (bootstrap?.prepareWorktree) {
              const worktree = yield* git.createWorktree({
                cwd: bootstrap.prepareWorktree.projectCwd,
                branch: bootstrap.prepareWorktree.baseBranch,
                newBranch: bootstrap.prepareWorktree.branch,
                path: null,
              });
              targetWorktreePath = worktree.worktree.path;
              yield* orchestrationEngine.dispatch({
                type: "thread.meta.update",
                commandId: serverCommandId("bootstrap-thread-meta-update"),
                threadId: command.threadId,
                branch: worktree.worktree.branch,
                worktreePath: targetWorktreePath,
              });
              yield* refreshGitStatus(targetWorktreePath);
            }

            yield* runSetupProgram();

            return yield* orchestrationEngine.dispatch(finalTurnStartCommand);
          });

          return yield* bootstrapProgram.pipe(
            Effect.catchCause((cause) => {
              const dispatchError = toBootstrapDispatchCommandCauseError(cause);
              if (Cause.hasInterruptsOnly(cause)) {
                return Effect.fail(dispatchError);
              }
              return cleanupCreatedThread().pipe(Effect.flatMap(() => Effect.fail(dispatchError)));
            }),
          );
        });

      const dispatchNormalizedCommand = (
        normalizedCommand: OrchestrationCommand,
      ): Effect.Effect<{ readonly sequence: number }, OrchestrationDispatchCommandError> => {
        const dispatchEffect =
          normalizedCommand.type === "thread.turn.start" && normalizedCommand.bootstrap
            ? dispatchBootstrapTurnStart(normalizedCommand)
            : orchestrationEngine
                .dispatch(normalizedCommand)
                .pipe(
                  Effect.mapError((cause) =>
                    toDispatchCommandError(cause, "Failed to dispatch orchestration command"),
                  ),
                );

        return startup
          .enqueueCommand(dispatchEffect)
          .pipe(
            Effect.mapError((cause) =>
              toDispatchCommandError(cause, "Failed to dispatch orchestration command"),
            ),
          );
      };

      const loadServerConfig = Effect.gen(function* () {
        const keybindingsConfig = yield* keybindings.loadConfigState;
        const providers = yield* providerRegistry.getProviders;
        const settings = yield* serverSettings.getSettings;
        const environment = yield* serverEnvironment.getDescriptor;
        const auth = yield* serverAuth.getDescriptor();

        return {
          environment,
          auth,
          cwd: config.cwd,
          keybindingsConfigPath: config.keybindingsConfigPath,
          keybindings: keybindingsConfig.keybindings,
          issues: keybindingsConfig.issues,
          providers,
          availableEditors: resolveAvailableEditors(),
          observability: {
            logsDirectoryPath: config.logsDir,
            localTracingEnabled: true,
            ...(config.otlpTracesUrl !== undefined ? { otlpTracesUrl: config.otlpTracesUrl } : {}),
            otlpTracesEnabled: config.otlpTracesUrl !== undefined,
            ...(config.otlpMetricsUrl !== undefined
              ? { otlpMetricsUrl: config.otlpMetricsUrl }
              : {}),
            otlpMetricsEnabled: config.otlpMetricsUrl !== undefined,
          },
          settings,
        };
      });

      const refreshGitStatus = (cwd: string) =>
        gitStatusBroadcaster
          .refreshStatus(cwd)
          .pipe(Effect.ignoreCause({ log: true }), Effect.forkDetach, Effect.asVoid);

      return WsRpcGroup.of({
        [ORCHESTRATION_WS_METHODS.dispatchCommand]: (command) =>
          observeRpcEffect(
            ORCHESTRATION_WS_METHODS.dispatchCommand,
            Effect.gen(function* () {
              yield* ensureHostedRpcRequestLimit(
                ORCHESTRATION_WS_METHODS.dispatchCommand,
                command,
                (message) => new OrchestrationDispatchCommandError({ message }),
              );
              const normalizedCommand = attachMessageAuthor(
                yield* normalizeDispatchCommand(command),
              );
              const commandForDispatch = yield* attachProjectOwnership(normalizedCommand);
              yield* ensureOrchestrationCommandAuthorized(commandForDispatch);
              if (commandForDispatch.type === "thread.meta.update") {
                yield* persistThreadFavoritePreference(commandForDispatch);
              }
              const sharedCommandForDispatch = stripUserPreferenceOnlyFavorite(commandForDispatch);
              if (!sharedCommandForDispatch) {
                return yield* orchestrationEngine
                  .getReadModel()
                  .pipe(Effect.map((readModel) => ({ sequence: readModel.snapshotSequence })));
              }
              const shouldStopSessionAfterArchive =
                sharedCommandForDispatch.type === "thread.archive"
                  ? yield* projectionSnapshotQuery
                      .getThreadShellById(sharedCommandForDispatch.threadId)
                      .pipe(
                        Effect.map(
                          Option.match({
                            onNone: () => false,
                            onSome: (thread) =>
                              thread.session !== null && thread.session.status !== "stopped",
                          }),
                        ),
                        Effect.catch(() => Effect.succeed(false)),
                      )
                  : false;
              const result = yield* dispatchNormalizedCommand(sharedCommandForDispatch);
              if (sharedCommandForDispatch.type === "thread.turn.start") {
                yield* Ref.update(turnsStartedHereRef, (threadIds) =>
                  new Set(threadIds).add(sharedCommandForDispatch.threadId),
                );
              }
              yield* persistProjectWorkspaceMetadata(sharedCommandForDispatch);
              if (sharedCommandForDispatch.type === "thread.archive") {
                if (shouldStopSessionAfterArchive) {
                  yield* Effect.gen(function* () {
                    const stopCommand = yield* normalizeDispatchCommand({
                      type: "thread.session.stop",
                      commandId: CommandId.make(
                        `session-stop-for-archive:${sharedCommandForDispatch.commandId}`,
                      ),
                      threadId: sharedCommandForDispatch.threadId,
                      createdAt: new Date().toISOString(),
                    });

                    yield* dispatchNormalizedCommand(stopCommand);
                  }).pipe(
                    Effect.catchCause((cause) =>
                      Effect.logWarning("failed to stop provider session during archive", {
                        threadId: sharedCommandForDispatch.threadId,
                        cause,
                      }),
                    ),
                  );
                }

                yield* terminalManager.close({ threadId: sharedCommandForDispatch.threadId }).pipe(
                  Effect.catch((error) =>
                    Effect.logWarning("failed to close thread terminals after archive", {
                      threadId: sharedCommandForDispatch.threadId,
                      error: error.message,
                    }),
                  ),
                );
              }
              return result;
            }).pipe(
              Effect.mapError((cause) =>
                Schema.is(OrchestrationDispatchCommandError)(cause)
                  ? cause
                  : new OrchestrationDispatchCommandError({
                      message: "Failed to dispatch orchestration command",
                      cause,
                    }),
              ),
            ),
            { "rpc.aggregate": "orchestration" },
          ),
        [ORCHESTRATION_WS_METHODS.getTurnDiff]: (input) =>
          observeRpcEffect(
            ORCHESTRATION_WS_METHODS.getTurnDiff,
            withRateLimit(
              ensureThreadAccess(
                input.threadId,
                "file.read",
                (message) => new OrchestrationGetTurnDiffError({ message }),
              ).pipe(
                Effect.flatMap(() =>
                  checkpointDiffQuery.getTurnDiff(input).pipe(
                    Effect.tap((result) =>
                      ensureHostedDiffLimit(
                        result.diff,
                        (message) => new OrchestrationGetTurnDiffError({ message }),
                      ),
                    ),
                    Effect.mapError((cause) =>
                      Schema.is(OrchestrationGetTurnDiffError)(cause)
                        ? cause
                        : new OrchestrationGetTurnDiffError({
                            message: "Failed to load turn diff",
                            cause,
                          }),
                    ),
                  ),
                ),
              ),
              (message) => new OrchestrationGetTurnDiffError({ message }),
            ),
            { "rpc.aggregate": "orchestration" },
          ),
        [ORCHESTRATION_WS_METHODS.getFullThreadDiff]: (input) =>
          observeRpcEffect(
            ORCHESTRATION_WS_METHODS.getFullThreadDiff,
            withRateLimit(
              ensureThreadAccess(
                input.threadId,
                "file.read",
                (message) => new OrchestrationGetFullThreadDiffError({ message }),
              ).pipe(
                Effect.flatMap(() =>
                  checkpointDiffQuery.getFullThreadDiff(input).pipe(
                    Effect.tap((result) =>
                      ensureHostedDiffLimit(
                        result.diff,
                        (message) => new OrchestrationGetFullThreadDiffError({ message }),
                      ),
                    ),
                    Effect.mapError((cause) =>
                      Schema.is(OrchestrationGetFullThreadDiffError)(cause)
                        ? cause
                        : new OrchestrationGetFullThreadDiffError({
                            message: "Failed to load full thread diff",
                            cause,
                          }),
                    ),
                  ),
                ),
              ),
              (message) => new OrchestrationGetFullThreadDiffError({ message }),
            ),
            { "rpc.aggregate": "orchestration" },
          ),
        [ORCHESTRATION_WS_METHODS.replayEvents]: (input) =>
          observeRpcEffect(
            ORCHESTRATION_WS_METHODS.replayEvents,
            withRateLimit(
              Stream.runCollect(
                orchestrationEngine.readEvents(
                  clamp(input.fromSequenceExclusive, {
                    maximum: Number.MAX_SAFE_INTEGER,
                    minimum: 0,
                  }),
                ),
              ).pipe(
                Effect.map((events) => Array.from(events)),
                Effect.flatMap(enrichOrchestrationEvents),
                Effect.mapError(
                  (cause) =>
                    new OrchestrationReplayEventsError({
                      message: "Failed to replay orchestration events",
                      cause,
                    }),
                ),
              ),
              (message) => new OrchestrationReplayEventsError({ message }),
            ),
            { "rpc.aggregate": "orchestration" },
          ),
        [ORCHESTRATION_WS_METHODS.subscribeShell]: (_input) =>
          observeRpcStreamEffect(
            ORCHESTRATION_WS_METHODS.subscribeShell,
            Effect.gen(function* () {
              yield* checkRateLimit((message) => new OrchestrationGetSnapshotError({ message }));
              const snapshot = yield* projectionSnapshotQuery.getShellSnapshot().pipe(
                Effect.mapError(
                  (cause) =>
                    new OrchestrationGetSnapshotError({
                      message: "Failed to load orchestration shell snapshot",
                      cause,
                    }),
                ),
              );
              const visibleTenantIds = yield* sessionVisibleTenantIds().pipe(
                Effect.mapError(
                  (cause) =>
                    new OrchestrationGetSnapshotError({
                      message: "Failed to resolve tenant visibility for this session.",
                      cause,
                    }),
                ),
              );
              const isVisibleProject = (project: OrchestrationProjectShell): boolean =>
                visibleTenantIds === null ||
                (project.ownership !== undefined &&
                  visibleTenantIds.has(project.ownership.tenantId));
              const visibleProjectIds = new Set(
                snapshot.projects.filter(isVisibleProject).map((project) => project.id),
              );
              const scopedSnapshot =
                visibleTenantIds === null
                  ? snapshot
                  : {
                      ...snapshot,
                      projects: snapshot.projects.filter((project) =>
                        visibleProjectIds.has(project.id),
                      ),
                      threads: snapshot.threads.filter((thread) =>
                        visibleProjectIds.has(thread.projectId),
                      ),
                    };
              const sessionSnapshot = yield* withShellFavoritePreferences(scopedSnapshot);

              const isVisibleStreamEvent = (event: OrchestrationShellStreamEvent): boolean => {
                if (visibleTenantIds === null) {
                  return true;
                }
                switch (event.kind) {
                  case "project-upserted": {
                    const visible = isVisibleProject(event.project);
                    if (visible) {
                      visibleProjectIds.add(event.project.id);
                    } else {
                      visibleProjectIds.delete(event.project.id);
                    }
                    return visible;
                  }
                  case "project-removed":
                    return visibleProjectIds.delete(event.projectId);
                  case "thread-upserted":
                    return visibleProjectIds.has(event.thread.projectId);
                  case "thread-removed":
                    return true;
                }
              };

              const liveStream = orchestrationEngine.streamDomainEvents.pipe(
                Stream.mapEffect(toShellStreamEvent),
                Stream.flatMap((event) =>
                  Option.isSome(event) && isVisibleStreamEvent(event.value)
                    ? Stream.succeed(event.value)
                    : Stream.empty,
                ),
              );

              return Stream.concat(
                Stream.make({
                  kind: "snapshot" as const,
                  snapshot: sessionSnapshot,
                }),
                liveStream,
              );
            }),
            { "rpc.aggregate": "orchestration" },
          ),
        [ORCHESTRATION_WS_METHODS.subscribeThread]: (input) =>
          observeRpcStreamEffect(
            ORCHESTRATION_WS_METHODS.subscribeThread,
            Effect.gen(function* () {
              yield* checkRateLimit((message) => new OrchestrationGetSnapshotError({ message }));
              yield* ensureThreadAccess(
                input.threadId,
                "session.view",
                (message) => new OrchestrationGetSnapshotError({ message }),
              );
              const [threadDetail, snapshotSequence] = yield* Effect.all([
                projectionSnapshotQuery.getThreadDetailById(input.threadId).pipe(
                  Effect.mapError(
                    (cause) =>
                      new OrchestrationGetSnapshotError({
                        message: `Failed to load thread ${input.threadId}`,
                        cause,
                      }),
                  ),
                ),
                orchestrationEngine
                  .getReadModel()
                  .pipe(Effect.map((readModel) => readModel.snapshotSequence)),
              ]);

              if (Option.isNone(threadDetail)) {
                return yield* new OrchestrationGetSnapshotError({
                  message: `Thread ${input.threadId} was not found`,
                  cause: input.threadId,
                });
              }
              const sessionThreadDetail = yield* withThreadDetailFavoritePreference(
                threadDetail.value,
              );

              const liveStream = orchestrationEngine.streamDomainEvents.pipe(
                Stream.filter(
                  (event) =>
                    event.aggregateKind === "thread" &&
                    event.aggregateId === input.threadId &&
                    isThreadDetailEvent(event),
                ),
                Stream.tap(recordThreadTokenUsage),
                Stream.map((event) => ({
                  kind: "event" as const,
                  event,
                })),
              );

              return Stream.concat(
                Stream.make({
                  kind: "snapshot" as const,
                  snapshot: {
                    snapshotSequence,
                    thread: sessionThreadDetail,
                  },
                }),
                liveStream,
              );
            }),
            { "rpc.aggregate": "orchestration" },
          ),
        [WS_METHODS.serverGetConfig]: (_input) =>
          observeRpcEffect(WS_METHODS.serverGetConfig, loadServerConfig, {
            "rpc.aggregate": "server",
          }),
        [WS_METHODS.serverRefreshProviders]: (_input) =>
          observeRpcEffect(
            WS_METHODS.serverRefreshProviders,
            providerRegistry.refresh().pipe(Effect.map((providers) => ({ providers }))),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.serverUpsertKeybinding]: (rule) =>
          observeRpcEffect(
            WS_METHODS.serverUpsertKeybinding,
            Effect.gen(function* () {
              const keybindingsConfig = yield* keybindings.upsertKeybindingRule(rule);
              return { keybindings: keybindingsConfig, issues: [] };
            }),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.serverGetSettings]: (_input) =>
          observeRpcEffect(WS_METHODS.serverGetSettings, serverSettings.getSettings, {
            "rpc.aggregate": "server",
          }),
        [WS_METHODS.serverUpdateSettings]: ({ patch }) =>
          observeRpcEffect(WS_METHODS.serverUpdateSettings, serverSettings.updateSettings(patch), {
            "rpc.aggregate": "server",
          }),
        [WS_METHODS.providerAccountsList]: (_input) =>
          observeRpcEffect(
            WS_METHODS.providerAccountsList,
            withRateLimit(listProviderAccounts(), (message) =>
              providerAccountError("rate-limited", message),
            ),
            { "rpc.aggregate": "provider-account" },
          ),
        [WS_METHODS.providerAccountsConnect]: (input) =>
          observeRpcEffect(
            WS_METHODS.providerAccountsConnect,
            withRateLimit(connectProviderAccount(input), (message) =>
              providerAccountError("rate-limited", message),
            ),
            { "rpc.aggregate": "provider-account" },
          ),
        [WS_METHODS.providerAccountsOpenAuthTerminal]: (input) =>
          observeRpcEffect(
            WS_METHODS.providerAccountsOpenAuthTerminal,
            withRateLimit(openProviderAccountAuthTerminal(input), (message) =>
              providerAccountError("rate-limited", message),
            ),
            { "rpc.aggregate": "provider-account" },
          ),
        [WS_METHODS.providerAccountsConfirm]: (input) =>
          observeRpcEffect(
            WS_METHODS.providerAccountsConfirm,
            withRateLimit(confirmProviderAccount(input), (message) =>
              providerAccountError("rate-limited", message),
            ),
            { "rpc.aggregate": "provider-account" },
          ),
        [WS_METHODS.providerAccountsDisconnect]: (input) =>
          observeRpcEffect(
            WS_METHODS.providerAccountsDisconnect,
            withRateLimit(disconnectProviderAccount(input), (message) =>
              providerAccountError("rate-limited", message),
            ),
            { "rpc.aggregate": "provider-account" },
          ),
        [WS_METHODS.collaborationPresenceUpsert]: (input) =>
          observeRpcEffect(
            WS_METHODS.collaborationPresenceUpsert,
            withRateLimit(
              ensureTenantPermissionForCollaboration(input.tenantId, "workspace.view").pipe(
                Effect.flatMap(() => resolveCollaborationActor),
                Effect.flatMap((actor) => collaboration.upsertPresence(actor, input)),
              ),
              (message) => new CollaborationError({ code: "invalid-membership-rule", message }),
            ),
            { "rpc.aggregate": "collaboration" },
          ),
        [WS_METHODS.collaborationPresenceList]: (input) =>
          observeRpcEffect(
            WS_METHODS.collaborationPresenceList,
            withRateLimit(
              ensureTenantPermissionForCollaboration(input.tenantId, "workspace.view").pipe(
                Effect.flatMap(() => collaboration.listPresence(input)),
              ),
              (message) => new CollaborationError({ code: "invalid-membership-rule", message }),
            ),
            { "rpc.aggregate": "collaboration" },
          ),
        [WS_METHODS.collaborationInvitesCreate]: (input) =>
          observeRpcEffect(
            WS_METHODS.collaborationInvitesCreate,
            withRateLimit(
              ensureTenantPermissionForCollaboration(input.tenantId, "workspace.invite").pipe(
                Effect.flatMap(() => resolveCollaborationActor),
                Effect.flatMap((actor) => collaboration.createInvite(actor, input)),
                // One link, not two: the invite page accepts it whether or not
                // the visitor already has an account.
                Effect.map((result) => ({
                  ...result,
                  accountSetupUrlPath: result.acceptUrlPath,
                })),
              ),
              (message) => new CollaborationError({ code: "invalid-membership-rule", message }),
            ),
            { "rpc.aggregate": "collaboration" },
          ),
        [WS_METHODS.collaborationInvitesList]: (input) =>
          observeRpcEffect(
            WS_METHODS.collaborationInvitesList,
            withRateLimit(
              ensureTenantPermissionForCollaboration(input.tenantId, "workspace.invite").pipe(
                Effect.flatMap(() => collaboration.listInvites(input)),
              ),
              (message) => new CollaborationError({ code: "invalid-membership-rule", message }),
            ),
            {
              "rpc.aggregate": "collaboration",
            },
          ),
        [WS_METHODS.collaborationInvitesAccept]: (input) =>
          observeRpcEffect(
            WS_METHODS.collaborationInvitesAccept,
            withRateLimit(
              requireInviteAcceptingIdentity(
                input.inviteId,
                (message) => new CollaborationError({ code: "invalid-membership-rule", message }),
              ).pipe(
                Effect.flatMap(() => resolveCollaborationActor),
                Effect.flatMap((actor) => collaboration.acceptInvite(actor, input)),
              ),
              (message) => new CollaborationError({ code: "invalid-membership-rule", message }),
            ),
            { "rpc.aggregate": "collaboration" },
          ),
        [WS_METHODS.collaborationInvitesRevoke]: (input) =>
          observeRpcEffect(
            WS_METHODS.collaborationInvitesRevoke,
            withRateLimit(
              ensureTenantPermissionForCollaboration(input.tenantId, "workspace.invite").pipe(
                Effect.flatMap(() => resolveCollaborationActor),
                Effect.flatMap((actor) => collaboration.revokeInvite(actor, input)),
              ),
              (message) => new CollaborationError({ code: "invalid-membership-rule", message }),
            ),
            { "rpc.aggregate": "collaboration" },
          ),
        [WS_METHODS.collaborationSharedPromptRecord]: (input) =>
          observeRpcEffect(
            WS_METHODS.collaborationSharedPromptRecord,
            withRateLimit(
              ensureHostedRpcRequestLimit(
                WS_METHODS.collaborationSharedPromptRecord,
                input,
                (message) => new CollaborationError({ code: "invalid-membership-rule", message }),
              ).pipe(
                Effect.flatMap(() =>
                  ensureTenantPermissionForCollaboration(input.tenantId, "session.prompt"),
                ),
                Effect.flatMap(() => resolveCollaborationActor),
                Effect.flatMap((actor) => collaboration.recordSharedPrompt(actor, input)),
              ),
              (message) => new CollaborationError({ code: "invalid-membership-rule", message }),
            ),
            { "rpc.aggregate": "collaboration" },
          ),
        [WS_METHODS.collaborationActivityList]: (input) =>
          observeRpcEffect(
            WS_METHODS.collaborationActivityList,
            withRateLimit(
              ensureTenantPermissionForCollaboration(input.tenantId, "workspace.view").pipe(
                Effect.flatMap(() => resolveCollaborationActor),
                Effect.flatMap((actor) => collaboration.listActivity(actor, input)),
              ),
              (message) => new CollaborationError({ code: "invalid-membership-rule", message }),
            ),
            { "rpc.aggregate": "collaboration" },
          ),
        [WS_METHODS.collaborationActivityVisibility]: (input) =>
          observeRpcEffect(
            WS_METHODS.collaborationActivityVisibility,
            withRateLimit(
              ensureTenantPermissionForCollaboration(input.tenantId, "workspace.view").pipe(
                Effect.flatMap(() => resolveCollaborationActor),
                Effect.flatMap((actor) => collaboration.setActivityVisibility(actor, input)),
              ),
              (message) => new CollaborationError({ code: "invalid-membership-rule", message }),
            ),
            { "rpc.aggregate": "collaboration" },
          ),
        [WS_METHODS.collaborationSettingsGet]: (input) =>
          observeRpcEffect(
            WS_METHODS.collaborationSettingsGet,
            withRateLimit(
              ensureTenantPermissionForCollaboration(input.tenantId, "workspace.view").pipe(
                Effect.flatMap(() => resolveCollaborationActor),
                Effect.flatMap((actor) => collaboration.getSettings(actor, input)),
              ),
              (message) => new CollaborationError({ code: "invalid-membership-rule", message }),
            ),
            { "rpc.aggregate": "collaboration" },
          ),
        [WS_METHODS.collaborationSettingsUpdate]: (input) =>
          observeRpcEffect(
            WS_METHODS.collaborationSettingsUpdate,
            withRateLimit(
              // The service does the approver check; the permission gate here
              // only keeps non-members out of the workspace entirely.
              ensureTenantPermissionForCollaboration(input.tenantId, "workspace.edit").pipe(
                Effect.flatMap(() => resolveCollaborationActor),
                Effect.flatMap((actor) => collaboration.updateSettings(actor, input)),
              ),
              (message) => new CollaborationError({ code: "invalid-membership-rule", message }),
            ),
            { "rpc.aggregate": "collaboration" },
          ),
        [WS_METHODS.collaborationApprovalsSubmit]: (input) =>
          observeRpcEffect(
            WS_METHODS.collaborationApprovalsSubmit,
            withRateLimit(
              ensureTenantPermissionForCollaboration(input.tenantId, "session.prompt").pipe(
                Effect.flatMap(() => resolveCollaborationActor),
                Effect.flatMap((actor) => collaboration.submitPromptForApproval(actor, input)),
              ),
              (message) => new CollaborationError({ code: "invalid-membership-rule", message }),
            ),
            { "rpc.aggregate": "collaboration" },
          ),
        [WS_METHODS.collaborationApprovalsList]: (input) =>
          observeRpcEffect(
            WS_METHODS.collaborationApprovalsList,
            withRateLimit(
              ensureTenantPermissionForCollaboration(input.tenantId, "workspace.view").pipe(
                Effect.flatMap(() => resolveCollaborationActor),
                Effect.flatMap((actor) => collaboration.listApprovals(actor, input)),
              ),
              (message) => new CollaborationError({ code: "invalid-membership-rule", message }),
            ),
            { "rpc.aggregate": "collaboration" },
          ),
        [WS_METHODS.collaborationApprovalsDecide]: (input) =>
          observeRpcEffect(
            WS_METHODS.collaborationApprovalsDecide,
            withRateLimit(
              ensureTenantPermissionForCollaboration(input.tenantId, "workspace.view").pipe(
                Effect.flatMap(() => resolveCollaborationActor),
                Effect.flatMap((actor) => collaboration.decideApproval(actor, input)),
              ),
              (message) => new CollaborationError({ code: "invalid-membership-rule", message }),
            ),
            { "rpc.aggregate": "collaboration" },
          ),
        [WS_METHODS.collaborationViewGet]: (input) =>
          observeRpcEffect(
            WS_METHODS.collaborationViewGet,
            withRateLimit(
              ensureTenantPermissionForCollaboration(input.tenantId, "workspace.view").pipe(
                Effect.flatMap(() => resolveCollaborationActor),
                Effect.flatMap((actor) => collaboration.getViewPreferences(actor, input)),
              ),
              (message) => new CollaborationError({ code: "invalid-membership-rule", message }),
            ),
            { "rpc.aggregate": "collaboration" },
          ),
        [WS_METHODS.collaborationViewUpdate]: (input) =>
          observeRpcEffect(
            WS_METHODS.collaborationViewUpdate,
            withRateLimit(
              ensureTenantPermissionForCollaboration(input.tenantId, "workspace.view").pipe(
                Effect.flatMap(() => resolveCollaborationActor),
                Effect.flatMap((actor) => collaboration.updateViewPreferences(actor, input)),
              ),
              (message) => new CollaborationError({ code: "invalid-membership-rule", message }),
            ),
            { "rpc.aggregate": "collaboration" },
          ),
        [WS_METHODS.collaborationBranchClaim]: (input) =>
          observeRpcEffect(
            WS_METHODS.collaborationBranchClaim,
            withRateLimit(
              ensureTenantPermissionForCollaboration(input.tenantId, "workspace.edit").pipe(
                Effect.flatMap(() => resolveCollaborationActor),
                Effect.flatMap((actor) => collaboration.claimBranch(actor, input)),
              ),
              (message) => new CollaborationError({ code: "invalid-membership-rule", message }),
            ),
            { "rpc.aggregate": "collaboration" },
          ),
        [WS_METHODS.collaborationBranchList]: (input) =>
          observeRpcEffect(
            WS_METHODS.collaborationBranchList,
            withRateLimit(
              ensureTenantPermissionForCollaboration(input.tenantId, "workspace.view").pipe(
                Effect.flatMap(() => resolveCollaborationActor),
                Effect.flatMap((actor) => collaboration.listBranchClaims(actor, input)),
              ),
              (message) => new CollaborationError({ code: "invalid-membership-rule", message }),
            ),
            { "rpc.aggregate": "collaboration" },
          ),
        [WS_METHODS.collaborationBranchRelease]: (input) =>
          observeRpcEffect(
            WS_METHODS.collaborationBranchRelease,
            withRateLimit(
              ensureTenantPermissionForCollaboration(input.tenantId, "workspace.edit").pipe(
                Effect.flatMap(() => resolveCollaborationActor),
                Effect.flatMap((actor) => collaboration.releaseBranch(actor, input)),
              ),
              (message) => new CollaborationError({ code: "invalid-membership-rule", message }),
            ),
            { "rpc.aggregate": "collaboration" },
          ),
        [WS_METHODS.collaborationFilesTouch]: (input) =>
          observeRpcEffect(
            WS_METHODS.collaborationFilesTouch,
            withRateLimit(
              ensureTenantPermissionForCollaboration(input.tenantId, "workspace.edit").pipe(
                Effect.flatMap(() => resolveCollaborationActor),
                Effect.flatMap((actor) => collaboration.touchFiles(actor, input)),
              ),
              (message) => new CollaborationError({ code: "invalid-membership-rule", message }),
            ),
            { "rpc.aggregate": "collaboration" },
          ),
        [WS_METHODS.collaborationFilesTouchList]: (input) =>
          observeRpcEffect(
            WS_METHODS.collaborationFilesTouchList,
            withRateLimit(
              ensureTenantPermissionForCollaboration(input.tenantId, "workspace.view").pipe(
                Effect.flatMap(() => collaboration.listFileTouches(input)),
              ),
              (message) => new CollaborationError({ code: "invalid-membership-rule", message }),
            ),
            { "rpc.aggregate": "collaboration" },
          ),
        [WS_METHODS.collaborationMembersList]: (input) =>
          observeRpcEffect(
            WS_METHODS.collaborationMembersList,
            withRateLimit(
              ensureTenantPermissionForCollaboration(input.tenantId, "workspace.view").pipe(
                Effect.flatMap(() => resolveCollaborationActor),
                Effect.flatMap((actor) => collaboration.listMembers(actor, input)),
              ),
              (message) => new CollaborationError({ code: "invalid-membership-rule", message }),
            ),
            { "rpc.aggregate": "collaboration" },
          ),
        [WS_METHODS.collaborationMembersUpdate]: (input) =>
          observeRpcEffect(
            WS_METHODS.collaborationMembersUpdate,
            withRateLimit(
              ensureTenantPermissionForCollaboration(input.tenantId, "workspace.edit").pipe(
                Effect.flatMap(() => resolveCollaborationActor),
                Effect.flatMap((actor) => collaboration.updateMember(actor, input)),
              ),
              (message) => new CollaborationError({ code: "invalid-membership-rule", message }),
            ),
            { "rpc.aggregate": "collaboration" },
          ),
        [WS_METHODS.collaborationMembersRemove]: (input) =>
          observeRpcEffect(
            WS_METHODS.collaborationMembersRemove,
            withRateLimit(
              ensureTenantPermissionForCollaboration(input.tenantId, "membership.manage").pipe(
                Effect.flatMap(() => resolveCollaborationActor),
                Effect.flatMap((actor) => collaboration.removeMember(actor, input)),
              ),
              (message) => new CollaborationError({ code: "invalid-membership-rule", message }),
            ),
            { "rpc.aggregate": "collaboration" },
          ),
        [WS_METHODS.collaborationUsageRecord]: (input) =>
          observeRpcEffect(
            WS_METHODS.collaborationUsageRecord,
            withRateLimit(
              ensureTenantPermissionForCollaboration(input.tenantId, "workspace.view").pipe(
                Effect.flatMap(() => resolveCollaborationActor),
                Effect.flatMap((actor) => collaboration.recordUsage(actor, input)),
              ),
              (message) => new CollaborationError({ code: "invalid-membership-rule", message }),
            ),
            { "rpc.aggregate": "collaboration" },
          ),
        [WS_METHODS.collaborationUsageQuery]: (input) =>
          observeRpcEffect(
            WS_METHODS.collaborationUsageQuery,
            withRateLimit(
              // Reading what a workspace spent is a workspace read, gated the
              // same way the member list is; the per-member consent filter is
              // applied inside the service, not here.
              ensureTenantPermissionForCollaboration(input.tenantId, "workspace.view").pipe(
                Effect.flatMap(() => resolveCollaborationActor),
                Effect.flatMap((actor) => collaboration.queryUsage(actor, input)),
              ),
              (message) => new CollaborationError({ code: "invalid-membership-rule", message }),
            ),
            { "rpc.aggregate": "collaboration" },
          ),
        [WS_METHODS.collaborationConsentGet]: (input) =>
          observeRpcEffect(
            WS_METHODS.collaborationConsentGet,
            withRateLimit(
              ensureTenantPermissionForCollaboration(input.tenantId, "workspace.view").pipe(
                Effect.flatMap(() => resolveCollaborationActor),
                Effect.flatMap((actor) => collaboration.getConsent(actor, input)),
              ),
              (message) => new CollaborationError({ code: "invalid-membership-rule", message }),
            ),
            { "rpc.aggregate": "collaboration" },
          ),
        [WS_METHODS.collaborationConsentUpdate]: (input) =>
          observeRpcEffect(
            WS_METHODS.collaborationConsentUpdate,
            withRateLimit(
              ensureTenantPermissionForCollaboration(input.tenantId, "workspace.view").pipe(
                Effect.flatMap(() => resolveCollaborationActor),
                Effect.flatMap((actor) => collaboration.updateConsent(actor, input)),
              ),
              (message) => new CollaborationError({ code: "invalid-membership-rule", message }),
            ),
            { "rpc.aggregate": "collaboration" },
          ),
        [WS_METHODS.subscribeCollaboration]: (input) =>
          observeRpcStream(
            WS_METHODS.subscribeCollaboration,
            withRateLimitedStream(
              Stream.unwrap(
                ensureTenantPermissionForCollaboration(input.tenantId, "workspace.view").pipe(
                  Effect.as(collaboration.stream(input)),
                ),
              ),
              (message) => new CollaborationError({ code: "invalid-membership-rule", message }),
            ),
            {
              "rpc.aggregate": "collaboration",
            },
          ),
        [WS_METHODS.packsPublish]: (input) =>
          observeRpcEffect(
            WS_METHODS.packsPublish,
            withRateLimit(
              ensureTenantPermissionForPacks(input.tenantId, "workspace.edit").pipe(
                Effect.flatMap(() => resolveCollaborationActor),
                Effect.flatMap((actor) => packRegistry.publish(actor, input)),
              ),
              (message) => new PackError({ code: "visibility-forbidden", message }),
            ),
            { "rpc.aggregate": "packs" },
          ),
        [WS_METHODS.packsRecordVersion]: (input) =>
          observeRpcEffect(
            WS_METHODS.packsRecordVersion,
            withRateLimit(
              ensureTenantPermissionForPacks(input.tenantId, "workspace.edit").pipe(
                Effect.flatMap(() => resolveCollaborationActor),
                Effect.flatMap((actor) => packRegistry.recordVersion(actor, input)),
              ),
              (message) => new PackError({ code: "visibility-forbidden", message }),
            ),
            { "rpc.aggregate": "packs" },
          ),
        [WS_METHODS.packsSearch]: (input) =>
          observeRpcEffect(
            WS_METHODS.packsSearch,
            withRateLimit(
              resolvePackViewerScope(input).pipe(
                Effect.flatMap((viewer) =>
                  packRegistry.search(viewer, {
                    ...(input.query === undefined ? {} : { query: input.query }),
                    ...(input.limit === undefined ? {} : { limit: input.limit }),
                  }),
                ),
              ),
              (message) => new PackError({ code: "visibility-forbidden", message }),
            ),
            { "rpc.aggregate": "packs" },
          ),
        [WS_METHODS.packsGet]: (input) =>
          observeRpcEffect(
            WS_METHODS.packsGet,
            withRateLimit(
              resolvePackViewerScope(input).pipe(
                Effect.flatMap((viewer) =>
                  packRegistry.get(viewer, {
                    packId: input.packId,
                    ...(input.version === undefined ? {} : { version: input.version }),
                  }),
                ),
              ),
              (message) => new PackError({ code: "visibility-forbidden", message }),
            ),
            { "rpc.aggregate": "packs" },
          ),
        [WS_METHODS.packsListVersions]: (input) =>
          observeRpcEffect(
            WS_METHODS.packsListVersions,
            withRateLimit(
              resolvePackViewerScope(input).pipe(
                Effect.flatMap((viewer) =>
                  packRegistry.listVersions(viewer, { packId: input.packId }),
                ),
              ),
              (message) => new PackError({ code: "visibility-forbidden", message }),
            ),
            { "rpc.aggregate": "packs" },
          ),
        [WS_METHODS.packsSetVisibility]: (input) =>
          observeRpcEffect(
            WS_METHODS.packsSetVisibility,
            withRateLimit(
              ensureTenantPermissionForPacks(input.tenantId, "workspace.edit").pipe(
                Effect.flatMap(() => resolveCollaborationActor),
                Effect.flatMap((actor) => packRegistry.setVisibility(actor, input)),
              ),
              (message) => new PackError({ code: "visibility-forbidden", message }),
            ),
            { "rpc.aggregate": "packs" },
          ),
        [WS_METHODS.subscribePacks]: (input) =>
          observeRpcStream(
            WS_METHODS.subscribePacks,
            withRateLimitedStream(
              Stream.unwrap(
                resolvePackViewerScope(input).pipe(
                  Effect.map((viewer) => packRegistry.stream(viewer)),
                ),
              ),
              (message) => new PackError({ code: "visibility-forbidden", message }),
            ),
            { "rpc.aggregate": "packs" },
          ),
        [WS_METHODS.organizationsCreate]: (input) =>
          observeRpcEffect(
            WS_METHODS.organizationsCreate,
            withRateLimit(
              organizations.createOrganization(collaborationActor, input),
              (message) => new OrganizationError({ code: "invalid-role", message }),
            ),
            { "rpc.aggregate": "organization" },
          ),
        [WS_METHODS.organizationsList]: (_input) =>
          observeRpcEffect(
            WS_METHODS.organizationsList,
            withRateLimit(
              listOrganizationSnapshotForActor(),
              (message) => new OrganizationError({ code: "invalid-role", message }),
            ),
            {
              "rpc.aggregate": "organization",
            },
          ),
        [WS_METHODS.workspacesCreate]: (input) =>
          observeRpcEffect(
            WS_METHODS.workspacesCreate,
            withRateLimit(
              createTenantWorkspace(input),
              (message) => new OrganizationError({ code: "invalid-role", message }),
            ),
            { "rpc.aggregate": "workspace" },
          ),
        [WS_METHODS.packsEnable]: (input) =>
          observeRpcEffect(
            WS_METHODS.packsEnable,
            withRateLimit(
              ensureDeployProjectAccess(input.projectId, "project.edit").pipe(
                Effect.mapError(
                  (error) =>
                    new PackEnablementError({ code: "storage-failed", message: error.message }),
                ),
                Effect.flatMap(() => packEnablement.enable(input)),
              ),
              (message) => new PackEnablementError({ code: "storage-failed", message }),
            ),
            { "rpc.aggregate": "packs" },
          ),
        [WS_METHODS.packsDisable]: (input) =>
          observeRpcEffect(
            WS_METHODS.packsDisable,
            withRateLimit(
              ensureDeployProjectAccess(input.projectId, "project.edit").pipe(
                Effect.mapError(
                  (error) =>
                    new PackEnablementError({ code: "storage-failed", message: error.message }),
                ),
                Effect.flatMap(() => packEnablement.disable(input)),
              ),
              (message) => new PackEnablementError({ code: "storage-failed", message }),
            ),
            { "rpc.aggregate": "packs" },
          ),
        [WS_METHODS.packsListEnablements]: (input) =>
          observeRpcEffect(
            WS_METHODS.packsListEnablements,
            withRateLimit(
              ensureDeployProjectAccess(input.projectId, "project.view").pipe(
                Effect.mapError(
                  (error) =>
                    new PackEnablementError({ code: "storage-failed", message: error.message }),
                ),
                Effect.flatMap(() => packEnablement.list(input)),
              ),
              (message) => new PackEnablementError({ code: "storage-failed", message }),
            ),
            { "rpc.aggregate": "packs" },
          ),
        [WS_METHODS.analyticsListStreams]: (input) =>
          observeRpcEffect(
            WS_METHODS.analyticsListStreams,
            withRateLimit(
              (input.projectId === undefined
                ? Effect.void
                : ensureDeployProjectAccess(input.projectId, "project.view").pipe(
                    Effect.mapError(
                      (error) =>
                        new AnalyticsError({ code: "storage-failed", message: error.message }),
                    ),
                  )
              ).pipe(
                Effect.flatMap(() =>
                  analyticsStore.listStreams(
                    input.projectId !== undefined ? { projectId: input.projectId } : {},
                  ),
                ),
              ),
              (message) => new AnalyticsError({ code: "storage-failed", message }),
            ),
            { "rpc.aggregate": "analytics" },
          ),
        [WS_METHODS.analyticsDeclareStream]: (input) =>
          observeRpcEffect(
            WS_METHODS.analyticsDeclareStream,
            withRateLimit(
              // Declaring opens a write path into a project's numbers, so it
              // asks for edit rather than the view the read methods take.
              ensureDeployProjectAccess(input.projectId, "project.edit").pipe(
                Effect.mapError(
                  (error) => new AnalyticsError({ code: "storage-failed", message: error.message }),
                ),
                Effect.flatMap(() => analyticsStore.declareStream(input)),
              ),
              (message) => new AnalyticsError({ code: "storage-failed", message }),
            ),
            { "rpc.aggregate": "analytics" },
          ),
        [WS_METHODS.analyticsQuery]: (input) =>
          observeRpcEffect(
            WS_METHODS.analyticsQuery,
            withRateLimit(
              ensureDeployProjectAccess(input.projectId, "project.view").pipe(
                Effect.mapError(
                  (error) => new AnalyticsError({ code: "storage-failed", message: error.message }),
                ),
                Effect.flatMap(() => analyticsStore.query(input)),
              ),
              (message) => new AnalyticsError({ code: "storage-failed", message }),
            ),
            { "rpc.aggregate": "analytics" },
          ),
        [WS_METHODS.deployListTargets]: (input) =>
          observeRpcEffect(
            WS_METHODS.deployListTargets,
            withRateLimit(
              (input.projectId === undefined
                ? Effect.void
                : ensureDeployProjectAccess(input.projectId, "project.view")
              ).pipe(
                Effect.flatMap(() =>
                  deployService.listTargets(
                    input.projectId !== undefined ? { projectId: input.projectId } : {},
                  ),
                ),
                Effect.map((targets) => ({ targets })),
              ),
              (message) => new DeployError({ code: "forbidden", message }),
            ),
            { "rpc.aggregate": "deploy" },
          ),
        [WS_METHODS.deployCreateTarget]: (input) =>
          observeRpcEffect(
            WS_METHODS.deployCreateTarget,
            withRateLimit(
              ensureDeployProjectAccess(input.projectId, "project.edit").pipe(
                Effect.flatMap(() => deployService.createTarget(input)),
                Effect.map((target) => ({ target })),
              ),
              (message) => new DeployError({ code: "forbidden", message }),
            ),
            { "rpc.aggregate": "deploy" },
          ),
        [WS_METHODS.deployDeleteTarget]: (input) =>
          observeRpcEffect(
            WS_METHODS.deployDeleteTarget,
            withRateLimit(
              resolveDeployTargetProject(input.targetId).pipe(
                Effect.flatMap((project) => ensureDeployProjectAccess(project.id, "project.edit")),
                Effect.flatMap(() => deployService.deleteTarget(input)),
              ),
              (message) => new DeployError({ code: "forbidden", message }),
            ),
            { "rpc.aggregate": "deploy" },
          ),
        [WS_METHODS.deployRun]: (input) =>
          observeRpcEffect(
            WS_METHODS.deployRun,
            withRateLimit(
              resolveDeployTargetProject(input.targetId).pipe(
                Effect.flatMap((project) =>
                  ensureDeployProjectAccess(project.id, "project.edit").pipe(
                    Effect.flatMap(() =>
                      deployService.run({
                        targetId: input.targetId,
                        actor: { label: collaborationActor.displayName },
                        workspaceRoot: project.workspaceRoot,
                        ...(input.analytics !== undefined ? { analytics: input.analytics } : {}),
                      }),
                    ),
                  ),
                ),
                Effect.map((run) => ({ run })),
              ),
              (message) => new DeployError({ code: "forbidden", message }),
            ),
            { "rpc.aggregate": "deploy" },
          ),
        [WS_METHODS.deployListRuns]: (input) =>
          observeRpcEffect(
            WS_METHODS.deployListRuns,
            withRateLimit(
              (input.projectId === undefined
                ? Effect.void
                : ensureDeployProjectAccess(input.projectId, "project.view")
              ).pipe(
                Effect.flatMap(() =>
                  deployService.listRuns({
                    ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
                    ...(input.targetId !== undefined ? { targetId: input.targetId } : {}),
                    ...(input.limit !== undefined ? { limit: input.limit } : {}),
                  }),
                ),
                Effect.map((runs) => ({ runs })),
              ),
              (message) => new DeployError({ code: "forbidden", message }),
            ),
            { "rpc.aggregate": "deploy" },
          ),
        [WS_METHODS.deployListDeployments]: (input) =>
          observeRpcEffect(
            WS_METHODS.deployListDeployments,
            withRateLimit(
              (input.projectId === undefined
                ? Effect.void
                : ensureDeployProjectAccess(input.projectId, "project.view")
              ).pipe(
                Effect.flatMap(() =>
                  deploymentRegistry.list({
                    ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
                    ...(input.targetId !== undefined ? { targetId: input.targetId } : {}),
                  }),
                ),
                Effect.map((deployments) => ({ deployments })),
              ),
              (message) => new DeployError({ code: "forbidden", message }),
            ),
            { "rpc.aggregate": "deploy" },
          ),
        [WS_METHODS.deployRegisterDeployment]: (input) =>
          observeRpcEffect(
            WS_METHODS.deployRegisterDeployment,
            withRateLimit(
              // Registering says what a project is serving and which streams it
              // writes to, so it asks for edit rather than view.
              ensureDeployProjectAccess(input.projectId, "project.edit").pipe(
                Effect.flatMap(() => deploymentRegistry.register(input)),
                Effect.map((deployment) => ({ deployment })),
              ),
              (message) => new DeployError({ code: "forbidden", message }),
            ),
            { "rpc.aggregate": "deploy" },
          ),
        [WS_METHODS.deployUpdateDeployment]: (input) =>
          observeRpcEffect(
            WS_METHODS.deployUpdateDeployment,
            withRateLimit(
              deploymentRegistry.projectOf({ deploymentId: input.deploymentId }).pipe(
                Effect.flatMap((projectId) => ensureDeployProjectAccess(projectId, "project.edit")),
                Effect.flatMap(() => deploymentRegistry.update(input)),
                Effect.map((deployment) => ({ deployment })),
              ),
              (message) => new DeployError({ code: "forbidden", message }),
            ),
            { "rpc.aggregate": "deploy" },
          ),
        [WS_METHODS.deployArchiveDeployment]: (input) =>
          observeRpcEffect(
            WS_METHODS.deployArchiveDeployment,
            withRateLimit(
              deploymentRegistry.projectOf({ deploymentId: input.deploymentId }).pipe(
                Effect.flatMap((projectId) => ensureDeployProjectAccess(projectId, "project.edit")),
                Effect.flatMap(() => deploymentRegistry.archive(input)),
              ),
              (message) => new DeployError({ code: "forbidden", message }),
            ),
            { "rpc.aggregate": "deploy" },
          ),
        [WS_METHODS.organizationEmployeesInvite]: (input) =>
          observeRpcEffect(
            WS_METHODS.organizationEmployeesInvite,
            withRateLimit(
              ensureOrganizationPermission(input.organizationId, "employee.invite").pipe(
                Effect.flatMap(() => organizations.inviteEmployee(collaborationActor, input)),
                Effect.flatMap((result) =>
                  issueInviteSetupUrlPath({
                    inviteId: result.invite.id,
                  }).pipe(
                    Effect.mapError(
                      (cause) =>
                        new OrganizationError({
                          code: "invalid-role",
                          message: "Failed to create employee setup link.",
                          cause,
                        }),
                    ),
                    Effect.map((accountSetupUrlPath) => ({
                      ...result,
                      accountSetupUrlPath,
                    })),
                  ),
                ),
              ),
              (message) => new OrganizationError({ code: "invalid-role", message }),
            ),
            { "rpc.aggregate": "organization" },
          ),
        [WS_METHODS.organizationEmployeesAcceptInvite]: (input) =>
          observeRpcEffect(
            WS_METHODS.organizationEmployeesAcceptInvite,
            withRateLimit(
              requireInviteAcceptingIdentity(
                input.inviteId,
                (message) => new OrganizationError({ code: "invalid-invite", message }),
              ).pipe(
                Effect.flatMap(() => resolveCollaborationActor),
                Effect.flatMap((actor) =>
                  organizations.acceptEmployeeInvite(actor, input).pipe(
                    Effect.tap((result) =>
                      Effect.all({
                        providerIsolation: tenancyRepository.loadProviderIsolation(),
                        readModel: orchestrationEngine.getReadModel(),
                      }).pipe(
                        Effect.flatMap(({ providerIsolation, readModel }) => {
                          const account = providerIsolation.providerAccounts.find(
                            (candidate) =>
                              candidate.tenantId === result.membership.tenantId &&
                              candidate.sharing === "tenant-shared" &&
                              candidate.disabledAt === null,
                          );
                          const project = readModel.projects.find(
                            (candidate) =>
                              candidate.ownership?.tenantId === result.membership.tenantId,
                          );
                          if (!account || !project) {
                            return Effect.void;
                          }
                          const providerHomeSegment = result.membership.userId.replaceAll(
                            /[^a-zA-Z0-9._-]+/g,
                            "-",
                          );
                          const providerSession = {
                            id: ProviderSessionId.make(
                              `provider-session:${result.membership.id}:${account.provider}`,
                            ),
                            tenantId: result.membership.tenantId,
                            userId: result.membership.userId,
                            providerAccountId: account.id,
                            provider: account.provider,
                            providerHomeDir: `${account.authHomeDir}/${providerHomeSegment}`,
                            cwd: project.workspaceRoot,
                            createdAt: new Date().toISOString(),
                            endedAt: null,
                          } satisfies ProviderSessionIsolation;
                          const providerSessions = [
                            ...providerIsolation.providerSessions.filter(
                              (candidate) => candidate.id !== providerSession.id,
                            ),
                            providerSession,
                          ];
                          return tenancyRepository.saveProviderIsolation({
                            providerAccounts: providerIsolation.providerAccounts,
                            providerSessions,
                          });
                        }),
                        Effect.catch(() => Effect.void),
                      ),
                    ),
                  ),
                ),
              ),
              (message) => new OrganizationError({ code: "invalid-invite", message }),
            ),
            { "rpc.aggregate": "organization" },
          ),
        [WS_METHODS.organizationEmployeesList]: (input) =>
          observeRpcEffect(
            WS_METHODS.organizationEmployeesList,
            withRateLimit(
              ensureOrganizationPermission(input.organizationId, "organization.read").pipe(
                Effect.flatMap(() => organizations.listEmployees(input)),
              ),
              (message) => new OrganizationError({ code: "invalid-role", message }),
            ),
            { "rpc.aggregate": "organization" },
          ),
        [WS_METHODS.organizationEmployeesUpdate]: (input) =>
          observeRpcEffect(
            WS_METHODS.organizationEmployeesUpdate,
            withRateLimit(
              ensureOrganizationPermission(input.organizationId, "employee.update").pipe(
                Effect.flatMap(() => organizations.updateEmployee(collaborationActor, input)),
              ),
              (message) => new OrganizationError({ code: "invalid-role", message }),
            ),
            { "rpc.aggregate": "organization" },
          ),
        [WS_METHODS.organizationEmployeesDisable]: (input) =>
          observeRpcEffect(
            WS_METHODS.organizationEmployeesDisable,
            withRateLimit(
              ensureOrganizationPermission(input.organizationId, "employee.disable").pipe(
                Effect.flatMap(() => organizations.disableEmployee(collaborationActor, input)),
              ),
              (message) => new OrganizationError({ code: "invalid-role", message }),
            ),
            { "rpc.aggregate": "organization" },
          ),
        [WS_METHODS.organizationTeamsCreate]: (input) =>
          observeRpcEffect(
            WS_METHODS.organizationTeamsCreate,
            withRateLimit(
              ensureOrganizationPermission(input.organizationId, "team.manage").pipe(
                Effect.flatMap(() => organizations.createTeam(collaborationActor, input)),
              ),
              (message) => new OrganizationError({ code: "invalid-role", message }),
            ),
            { "rpc.aggregate": "organization" },
          ),
        [WS_METHODS.organizationDepartmentsCreate]: (input) =>
          observeRpcEffect(
            WS_METHODS.organizationDepartmentsCreate,
            withRateLimit(
              ensureOrganizationPermission(input.organizationId, "department.manage").pipe(
                Effect.flatMap(() => organizations.createDepartment(collaborationActor, input)),
              ),
              (message) => new OrganizationError({ code: "invalid-role", message }),
            ),
            { "rpc.aggregate": "organization" },
          ),
        [WS_METHODS.organizationAccessGrant]: (input) =>
          observeRpcEffect(
            WS_METHODS.organizationAccessGrant,
            withRateLimit(
              ensureOrganizationPermission(input.organizationId, "access.grant").pipe(
                Effect.flatMap(() => organizations.grantAccess(collaborationActor, input)),
              ),
              (message) => new OrganizationError({ code: "invalid-role", message }),
            ),
            { "rpc.aggregate": "organization" },
          ),
        [WS_METHODS.organizationAccessRevoke]: (input) =>
          observeRpcEffect(
            WS_METHODS.organizationAccessRevoke,
            withRateLimit(
              ensureOrganizationPermission(input.organizationId, "access.revoke").pipe(
                Effect.flatMap(() => organizations.revokeAccess(collaborationActor, input)),
              ),
              (message) => new OrganizationError({ code: "invalid-role", message }),
            ),
            { "rpc.aggregate": "organization" },
          ),
        [WS_METHODS.organizationAccessReviewCreate]: (input) =>
          observeRpcEffect(
            WS_METHODS.organizationAccessReviewCreate,
            withRateLimit(
              ensureOrganizationPermission(input.organizationId, "access.review").pipe(
                Effect.flatMap(() => organizations.createAccessReview(collaborationActor, input)),
              ),
              (message) => new OrganizationError({ code: "invalid-role", message }),
            ),
            { "rpc.aggregate": "organization" },
          ),
        [WS_METHODS.organizationAccessReviewComplete]: (input) =>
          observeRpcEffect(
            WS_METHODS.organizationAccessReviewComplete,
            withRateLimit(
              ensureOrganizationPermission(input.organizationId, "access.review").pipe(
                Effect.flatMap(() => organizations.completeAccessReview(collaborationActor, input)),
              ),
              (message) => new OrganizationError({ code: "invalid-role", message }),
            ),
            { "rpc.aggregate": "organization" },
          ),
        [WS_METHODS.organizationAuditList]: (input) =>
          observeRpcEffect(
            WS_METHODS.organizationAuditList,
            withRateLimit(
              ensureOrganizationPermission(input.organizationId, "audit.view").pipe(
                Effect.flatMap(() => organizations.listAuditEvents(input)),
              ),
              (message) => new OrganizationError({ code: "invalid-role", message }),
            ),
            {
              "rpc.aggregate": "organization",
            },
          ),
        [WS_METHODS.projectsSearchEntries]: (input) =>
          observeRpcEffect(
            WS_METHODS.projectsSearchEntries,
            withRateLimit(
              ensureWorkspaceRoot(
                input.cwd,
                "project.view",
                (message) => new ProjectSearchEntriesError({ message }),
              ).pipe(
                Effect.flatMap(() =>
                  workspaceEntries.search(input).pipe(
                    Effect.mapError(
                      (cause) =>
                        new ProjectSearchEntriesError({
                          message: `Failed to search workspace entries: ${cause.detail}`,
                          cause,
                        }),
                    ),
                  ),
                ),
              ),
              (message) => new ProjectSearchEntriesError({ message }),
            ),
            { "rpc.aggregate": "workspace" },
          ),
        [WS_METHODS.projectsListDirectory]: (input) =>
          observeRpcEffect(
            WS_METHODS.projectsListDirectory,
            withRateLimit(
              ensureWorkspaceRoot(
                input.cwd,
                "file.read",
                (message) => new ProjectListDirectoryError({ message }),
              ).pipe(
                Effect.flatMap(() =>
                  workspaceEntries.listDirectory(input).pipe(
                    Effect.tap((result) =>
                      ensureHostedDirectoryEntryLimit(
                        result.entries.length,
                        (message) => new ProjectListDirectoryError({ message }),
                      ),
                    ),
                    Effect.mapError((cause) =>
                      Schema.is(ProjectListDirectoryError)(cause)
                        ? cause
                        : new ProjectListDirectoryError({
                            message: `Failed to list workspace directory: ${cause.detail}`,
                            cause,
                          }),
                    ),
                  ),
                ),
              ),
              (message) => new ProjectListDirectoryError({ message }),
            ),
            { "rpc.aggregate": "workspace" },
          ),
        [WS_METHODS.projectsReadFile]: (input) =>
          observeRpcEffect(
            WS_METHODS.projectsReadFile,
            withRateLimit(
              ensureWorkspaceRoot(
                input.cwd,
                "file.read",
                (message) => new ProjectReadFileError({ message }),
              ).pipe(
                Effect.flatMap(() =>
                  workspaceFileSystem.readFile(input).pipe(
                    Effect.tap((result) =>
                      ensureHostedFileReadLimit(
                        result.sizeBytes,
                        (message) => new ProjectReadFileError({ message }),
                      ),
                    ),
                    Effect.mapError((cause) => {
                      const message = Schema.is(ProjectReadFileError)(cause)
                        ? cause.message
                        : Schema.is(WorkspacePathOutsideRootError)(cause)
                          ? "Workspace file path must stay within the project root."
                          : "Failed to read workspace file";
                      return new ProjectReadFileError({
                        message,
                        cause,
                      });
                    }),
                  ),
                ),
              ),
              (message) => new ProjectReadFileError({ message }),
            ),
            { "rpc.aggregate": "workspace" },
          ),
        [WS_METHODS.projectsWriteFile]: (input) =>
          observeRpcEffect(
            WS_METHODS.projectsWriteFile,
            withRateLimit(
              ensureHostedRpcRequestLimit(
                WS_METHODS.projectsWriteFile,
                input,
                (message) => new ProjectWriteFileError({ message }),
              ).pipe(
                Effect.flatMap(() =>
                  ensureWorkspaceRoot(
                    input.cwd,
                    "file.write",
                    (message) => new ProjectWriteFileError({ message }),
                  ),
                ),
                Effect.flatMap(() =>
                  ensureHostedFileWriteLimit(
                    {
                      contents: input.contents,
                      encoding: input.encoding,
                    },
                    (message) => new ProjectWriteFileError({ message }),
                  ),
                ),
                Effect.flatMap(() =>
                  workspaceFileSystem.writeFile(input).pipe(
                    Effect.mapError((cause) => {
                      const message = Schema.is(WorkspacePathOutsideRootError)(cause)
                        ? "Workspace file path must stay within the project root."
                        : "Failed to write workspace file";
                      return new ProjectWriteFileError({
                        message,
                        cause,
                      });
                    }),
                  ),
                ),
              ),
              (message) => new ProjectWriteFileError({ message }),
            ),
            { "rpc.aggregate": "workspace" },
          ),
        [WS_METHODS.projectsCreateEntry]: (input) =>
          observeRpcEffect(
            WS_METHODS.projectsCreateEntry,
            withRateLimit(
              ensureWorkspaceRoot(
                input.cwd,
                "file.write",
                (message) => new ProjectCreateEntryError({ message }),
              ).pipe(
                Effect.flatMap(() =>
                  workspaceFileSystem.createEntry(input).pipe(
                    Effect.mapError((cause) => {
                      const message = Schema.is(WorkspacePathOutsideRootError)(cause)
                        ? "Workspace file path must stay within the project root."
                        : "Failed to create workspace entry";
                      return new ProjectCreateEntryError({
                        message,
                        cause,
                      });
                    }),
                  ),
                ),
              ),
              (message) => new ProjectCreateEntryError({ message }),
            ),
            { "rpc.aggregate": "workspace" },
          ),
        [WS_METHODS.shellOpenInEditor]: (input) =>
          observeRpcEffect(
            WS_METHODS.shellOpenInEditor,
            withRateLimit(
              ensureWorkspaceRoot(
                input.cwd,
                "file.read",
                (message) => new OpenError({ message }),
              ).pipe(Effect.flatMap(() => open.openInEditor(input))),
              (message) => new OpenError({ message }),
            ),
            {
              "rpc.aggregate": "workspace",
            },
          ),
        [WS_METHODS.filesystemBrowse]: (input) =>
          observeRpcEffect(
            WS_METHODS.filesystemBrowse,
            withRateLimit(
              (input.cwd
                ? ensureWorkspaceRoot(
                    input.cwd,
                    "file.read",
                    (message) => new FilesystemBrowseError({ message }),
                  )
                : Effect.void
              ).pipe(
                Effect.flatMap(() =>
                  workspaceEntries.browse(input).pipe(
                    Effect.mapError(
                      (cause) =>
                        new FilesystemBrowseError({
                          message: cause.detail,
                          cause,
                        }),
                    ),
                  ),
                ),
              ),
              (message) => new FilesystemBrowseError({ message }),
            ),
            { "rpc.aggregate": "workspace" },
          ),
        [WS_METHODS.subscribeGitStatus]: (input) =>
          observeRpcStream(
            WS_METHODS.subscribeGitStatus,
            withRateLimitedStream(
              Stream.unwrap(
                ensureWorkspaceRoot(input.cwd, "project.view", (message) =>
                  gitRpcError(input.cwd, message),
                ).pipe(Effect.as(gitStatusBroadcaster.streamStatus(input))),
              ),
              (message) => gitRpcError(input.cwd, message),
            ),
            {
              "rpc.aggregate": "git",
            },
          ),
        [WS_METHODS.gitRefreshStatus]: (input) =>
          observeRpcEffect(
            WS_METHODS.gitRefreshStatus,
            withRateLimit(
              ensureWorkspaceRoot(input.cwd, "project.view", (message) =>
                gitRpcError(input.cwd, message),
              ).pipe(Effect.flatMap(() => gitStatusBroadcaster.refreshStatus(input.cwd))),
              (message) => gitRpcError(input.cwd, message),
            ),
            {
              "rpc.aggregate": "git",
            },
          ),
        [WS_METHODS.gitGetWorkingTreeDiff]: (input) =>
          observeRpcEffect(
            WS_METHODS.gitGetWorkingTreeDiff,
            withRateLimit(
              ensureWorkspaceRoot(input.cwd, "file.read", (message) =>
                gitRpcError(input.cwd, message),
              ).pipe(Effect.flatMap(() => git.getWorkingTreeDiff(input))),
              (message) => gitRpcError(input.cwd, message),
            ),
            {
              "rpc.aggregate": "git",
            },
          ),
        [WS_METHODS.gitPull]: (input) =>
          observeRpcEffect(
            WS_METHODS.gitPull,
            withRateLimit(
              ensureWorkspaceRoot(input.cwd, "project.edit", (message) =>
                gitRpcError(input.cwd, message),
              ).pipe(
                Effect.flatMap(() =>
                  git.pullCurrentBranch(input.cwd).pipe(
                    Effect.matchCauseEffect({
                      onFailure: (cause) => Effect.failCause(cause),
                      onSuccess: (result) =>
                        refreshGitStatus(input.cwd).pipe(
                          Effect.ignore({ log: true }),
                          Effect.as(result),
                        ),
                    }),
                  ),
                ),
              ),
              (message) => gitRpcError(input.cwd, message),
            ),
            { "rpc.aggregate": "git" },
          ),
        [WS_METHODS.gitRunStackedAction]: (input) =>
          observeRpcStream(
            WS_METHODS.gitRunStackedAction,
            withRateLimitedStream(
              Stream.unwrap(
                ensureWorkspaceRoot(input.cwd, "project.edit", (message) =>
                  gitRpcError(input.cwd, message),
                ).pipe(
                  Effect.as(
                    Stream.callback<GitActionProgressEvent, GitManagerServiceError>((queue) =>
                      gitManager
                        .runStackedAction(input, {
                          actionId: input.actionId,
                          progressReporter: {
                            publish: (event) => Queue.offer(queue, event).pipe(Effect.asVoid),
                          },
                        })
                        .pipe(
                          Effect.matchCauseEffect({
                            onFailure: (cause) => Queue.failCause(queue, cause),
                            onSuccess: () =>
                              refreshGitStatus(input.cwd).pipe(
                                Effect.andThen(Queue.end(queue).pipe(Effect.asVoid)),
                              ),
                          }),
                        ),
                    ),
                  ),
                ),
              ),
              (message) => gitRpcError(input.cwd, message),
            ),
            { "rpc.aggregate": "git" },
          ),
        [WS_METHODS.gitResolvePullRequest]: (input) =>
          observeRpcEffect(
            WS_METHODS.gitResolvePullRequest,
            withRateLimit(
              ensureWorkspaceRoot(input.cwd, "project.view", (message) =>
                gitRpcError(input.cwd, message),
              ).pipe(Effect.flatMap(() => gitManager.resolvePullRequest(input))),
              (message) => gitRpcError(input.cwd, message),
            ),
            {
              "rpc.aggregate": "git",
            },
          ),
        [WS_METHODS.gitPreparePullRequestThread]: (input) =>
          observeRpcEffect(
            WS_METHODS.gitPreparePullRequestThread,
            withRateLimit(
              ensureWorkspaceRoot(input.cwd, "project.edit", (message) =>
                gitRpcError(input.cwd, message),
              ).pipe(
                Effect.flatMap(() =>
                  gitManager
                    .preparePullRequestThread(input)
                    .pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
                ),
              ),
              (message) => gitRpcError(input.cwd, message),
            ),
            { "rpc.aggregate": "git" },
          ),
        [WS_METHODS.gitListBranches]: (input) =>
          observeRpcEffect(
            WS_METHODS.gitListBranches,
            withRateLimit(
              ensureWorkspaceRoot(input.cwd, "project.view", (message) =>
                gitRpcError(input.cwd, message),
              ).pipe(Effect.flatMap(() => git.listBranches(input))),
              (message) => gitRpcError(input.cwd, message),
            ),
            {
              "rpc.aggregate": "git",
            },
          ),
        [WS_METHODS.gitCreateWorktree]: (input) =>
          observeRpcEffect(
            WS_METHODS.gitCreateWorktree,
            withRateLimit(
              ensureWorkspaceRoot(input.cwd, "project.edit", (message) =>
                gitRpcError(input.cwd, message),
              ).pipe(
                Effect.flatMap(() =>
                  git.createWorktree(input).pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
                ),
              ),
              (message) => gitRpcError(input.cwd, message),
            ),
            { "rpc.aggregate": "git" },
          ),
        [WS_METHODS.gitRemoveWorktree]: (input) =>
          observeRpcEffect(
            WS_METHODS.gitRemoveWorktree,
            withRateLimit(
              ensureWorkspaceRoot(input.cwd, "project.edit", (message) =>
                gitRpcError(input.cwd, message),
              ).pipe(
                Effect.flatMap(() =>
                  git.removeWorktree(input).pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
                ),
              ),
              (message) => gitRpcError(input.cwd, message),
            ),
            { "rpc.aggregate": "git" },
          ),
        [WS_METHODS.gitCreateBranch]: (input) =>
          observeRpcEffect(
            WS_METHODS.gitCreateBranch,
            withRateLimit(
              ensureWorkspaceRoot(input.cwd, "project.edit", (message) =>
                gitRpcError(input.cwd, message),
              ).pipe(
                Effect.flatMap(() =>
                  git.createBranch(input).pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
                ),
              ),
              (message) => gitRpcError(input.cwd, message),
            ),
            { "rpc.aggregate": "git" },
          ),
        [WS_METHODS.gitCheckout]: (input) =>
          observeRpcEffect(
            WS_METHODS.gitCheckout,
            withRateLimit(
              ensureWorkspaceRoot(input.cwd, "project.edit", (message) =>
                gitRpcError(input.cwd, message),
              ).pipe(
                Effect.flatMap(() =>
                  Effect.scoped(git.checkoutBranch(input)).pipe(
                    Effect.tap(() => refreshGitStatus(input.cwd)),
                  ),
                ),
              ),
              (message) => gitRpcError(input.cwd, message),
            ),
            { "rpc.aggregate": "git" },
          ),
        [WS_METHODS.gitInit]: (input) =>
          observeRpcEffect(
            WS_METHODS.gitInit,
            withRateLimit(
              ensureWorkspaceRoot(input.cwd, "project.edit", (message) =>
                gitRpcError(input.cwd, message),
              ).pipe(
                Effect.flatMap(() =>
                  git.initRepo(input).pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
                ),
              ),
              (message) => gitRpcError(input.cwd, message),
            ),
            { "rpc.aggregate": "git" },
          ),
        [WS_METHODS.gitMergeBranch]: (input) =>
          observeRpcEffect(
            WS_METHODS.gitMergeBranch,
            withRateLimit(
              ensureWorkspaceRoot(input.cwd, "project.edit", (message) =>
                gitRpcError(input.cwd, message),
              ).pipe(
                Effect.flatMap(() =>
                  git.mergeBranch(input).pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
                ),
              ),
              (message) => gitRpcError(input.cwd, message),
            ),
            { "rpc.aggregate": "git" },
          ),
        [WS_METHODS.gitCompareBranches]: (input) =>
          observeRpcEffect(
            WS_METHODS.gitCompareBranches,
            withRateLimit(
              ensureWorkspaceRoot(input.cwd, "project.view", (message) =>
                gitRpcError(input.cwd, message),
              ).pipe(Effect.flatMap(() => git.compareBranches(input))),
              (message) => gitRpcError(input.cwd, message),
            ),
            { "rpc.aggregate": "git" },
          ),
        [WS_METHODS.gitGetMergeState]: (input) =>
          observeRpcEffect(
            WS_METHODS.gitGetMergeState,
            withRateLimit(
              ensureWorkspaceRoot(input.cwd, "project.view", (message) =>
                gitRpcError(input.cwd, message),
              ).pipe(Effect.flatMap(() => git.getMergeState(input.cwd))),
              (message) => gitRpcError(input.cwd, message),
            ),
            { "rpc.aggregate": "git" },
          ),
        [WS_METHODS.gitAbortMerge]: (input) =>
          observeRpcEffect(
            WS_METHODS.gitAbortMerge,
            withRateLimit(
              ensureWorkspaceRoot(input.cwd, "project.edit", (message) =>
                gitRpcError(input.cwd, message),
              ).pipe(
                Effect.flatMap(() =>
                  git.abortMerge(input.cwd).pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
                ),
              ),
              (message) => gitRpcError(input.cwd, message),
            ),
            { "rpc.aggregate": "git" },
          ),
        [WS_METHODS.terminalOpen]: (input) =>
          observeRpcEffect(
            WS_METHODS.terminalOpen,
            withRateLimit(
              ensureWorkspaceRoot(input.cwd, "session.create", (message) =>
                terminalRpcError(input.cwd, message),
              ).pipe(Effect.flatMap(() => terminalManager.open(input))),
              (message) => terminalRpcError(input.cwd, message),
            ),
            {
              "rpc.aggregate": "terminal",
            },
          ),
        [WS_METHODS.terminalWrite]: (input) =>
          observeRpcEffect(
            WS_METHODS.terminalWrite,
            withRateLimit(
              ensureHostedRpcRequestLimit(WS_METHODS.terminalWrite, input, (message) =>
                terminalRpcError(input.threadId, message),
              ).pipe(
                Effect.flatMap(() =>
                  ensureThreadAccess(input.threadId, "session.prompt", (message) =>
                    terminalRpcError(input.threadId, message),
                  ),
                ),
                Effect.flatMap(() => terminalManager.write(input)),
              ),
              (message) => terminalRpcError(input.threadId, message),
            ),
            {
              "rpc.aggregate": "terminal",
            },
          ),
        [WS_METHODS.terminalResize]: (input) =>
          observeRpcEffect(
            WS_METHODS.terminalResize,
            withRateLimit(
              ensureThreadAccess(input.threadId, "session.view", (message) =>
                terminalRpcError(input.threadId, message),
              ).pipe(Effect.flatMap(() => terminalManager.resize(input))),
              (message) => terminalRpcError(input.threadId, message),
            ),
            {
              "rpc.aggregate": "terminal",
            },
          ),
        [WS_METHODS.terminalClear]: (input) =>
          observeRpcEffect(
            WS_METHODS.terminalClear,
            withRateLimit(
              ensureThreadAccess(input.threadId, "session.view", (message) =>
                terminalRpcError(input.threadId, message),
              ).pipe(Effect.flatMap(() => terminalManager.clear(input))),
              (message) => terminalRpcError(input.threadId, message),
            ),
            {
              "rpc.aggregate": "terminal",
            },
          ),
        [WS_METHODS.terminalRestart]: (input) =>
          observeRpcEffect(
            WS_METHODS.terminalRestart,
            withRateLimit(
              ensureWorkspaceRoot(input.cwd, "session.create", (message) =>
                terminalRpcError(input.cwd, message),
              ).pipe(Effect.flatMap(() => terminalManager.restart(input))),
              (message) => terminalRpcError(input.cwd, message),
            ),
            {
              "rpc.aggregate": "terminal",
            },
          ),
        [WS_METHODS.terminalClose]: (input) =>
          observeRpcEffect(
            WS_METHODS.terminalClose,
            withRateLimit(
              ensureThreadAccess(input.threadId, "session.view", (message) =>
                terminalRpcError(input.threadId, message),
              ).pipe(Effect.flatMap(() => terminalManager.close(input))),
              (message) => terminalRpcError(input.threadId, message),
            ),
            {
              "rpc.aggregate": "terminal",
            },
          ),
        [WS_METHODS.subscribeTerminalEvents]: (_input) =>
          observeRpcStream(
            WS_METHODS.subscribeTerminalEvents,
            Stream.unwrap(
              checkRateLimit((message) => terminalRpcError("terminal-events", message)).pipe(
                Effect.as(
                  Stream.callback<TerminalEvent>((queue) =>
                    Effect.acquireRelease(
                      terminalManager.subscribe((event) => Queue.offer(queue, event)),
                      (unsubscribe) => Effect.sync(unsubscribe),
                    ),
                  ).pipe(
                    Stream.filterEffect((event) =>
                      ensureThreadAccess(event.threadId, "session.view", (message) =>
                        terminalRpcError(event.threadId, message),
                      ).pipe(
                        Effect.as(true),
                        Effect.catch(() => Effect.succeed(false)),
                      ),
                    ),
                  ),
                ),
                Effect.catch(() => Effect.succeed(Stream.empty)),
              ),
            ),
            { "rpc.aggregate": "terminal" },
          ),
        [WS_METHODS.subscribeServerConfig]: (_input) =>
          observeRpcStreamEffect(
            WS_METHODS.subscribeServerConfig,
            Effect.gen(function* () {
              const keybindingsUpdates = keybindings.streamChanges.pipe(
                Stream.map((event) => ({
                  version: 1 as const,
                  type: "keybindingsUpdated" as const,
                  payload: {
                    issues: event.issues,
                  },
                })),
              );
              const providerStatuses = providerRegistry.streamChanges.pipe(
                Stream.map((providers) => ({
                  version: 1 as const,
                  type: "providerStatuses" as const,
                  payload: { providers },
                })),
                Stream.debounce(Duration.millis(PROVIDER_STATUS_DEBOUNCE_MS)),
              );
              const settingsUpdates = serverSettings.streamChanges.pipe(
                Stream.map((settings) => ({
                  version: 1 as const,
                  type: "settingsUpdated" as const,
                  payload: { settings },
                })),
              );

              yield* Effect.all(
                [providerRegistry.refresh("codex"), providerRegistry.refresh("claudeAgent")],
                {
                  concurrency: "unbounded",
                  discard: true,
                },
              ).pipe(Effect.ignoreCause({ log: true }), Effect.forkScoped);

              const liveUpdates = Stream.merge(
                keybindingsUpdates,
                Stream.merge(providerStatuses, settingsUpdates),
              );

              return Stream.concat(
                Stream.make({
                  version: 1 as const,
                  type: "snapshot" as const,
                  config: yield* loadServerConfig,
                }),
                liveUpdates,
              );
            }),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.subscribeServerLifecycle]: (_input) =>
          observeRpcStreamEffect(
            WS_METHODS.subscribeServerLifecycle,
            Effect.gen(function* () {
              const snapshot = yield* lifecycleEvents.snapshot;
              const snapshotEvents = Array.from(snapshot.events).toSorted(
                (left, right) => left.sequence - right.sequence,
              );
              const liveEvents = lifecycleEvents.stream.pipe(
                Stream.filter((event) => event.sequence > snapshot.sequence),
              );
              return Stream.concat(Stream.fromIterable(snapshotEvents), liveEvents);
            }),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.subscribeAuthAccess]: (_input) =>
          observeRpcStreamEffect(
            WS_METHODS.subscribeAuthAccess,
            Effect.gen(function* () {
              const initialSnapshot = yield* loadAuthAccessSnapshot();
              const revisionRef = yield* Ref.make(1);
              const accessChanges: Stream.Stream<
                BootstrapCredentialChange | SessionCredentialChange
              > = Stream.merge(bootstrapCredentials.streamChanges, sessions.streamChanges);

              const liveEvents: Stream.Stream<AuthAccessStreamEvent> = accessChanges.pipe(
                Stream.mapEffect((change) =>
                  Ref.updateAndGet(revisionRef, (revision) => revision + 1).pipe(
                    Effect.map((revision) =>
                      toAuthAccessStreamEvent(change, revision, currentSessionId),
                    ),
                  ),
                ),
              );

              return Stream.concat(
                Stream.make({
                  version: 1 as const,
                  revision: 1,
                  type: "snapshot" as const,
                  payload: initialSnapshot,
                }),
                liveEvents,
              );
            }),
            { "rpc.aggregate": "auth" },
          ),
      });
    }),
  );

export const websocketRpcRouteLayer = Layer.unwrap(
  Effect.succeed(
    HttpRouter.add(
      "GET",
      "/ws",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const serverAuth = yield* ServerAuth;
        const sessions = yield* SessionCredentialService;
        const session = yield* serverAuth.authenticateWebSocketUpgrade(request);
        const rpcWebSocketHttpEffect = yield* RpcServer.toHttpEffectWebsocket(WsRpcGroup, {
          spanPrefix: "ws.rpc",
          spanAttributes: {
            "rpc.transport": "websocket",
            "rpc.system": "effect-rpc",
          },
        }).pipe(
          Effect.provide(
            makeWsRpcLayer(session).pipe(Layer.provideMerge(RpcSerialization.layerJson)),
          ),
        );
        const connectionSlot = yield* acquireActiveWebSocketConnectionSlot(request, session);
        return yield* Effect.acquireUseRelease(
          sessions.markConnected(session.sessionId).pipe(Effect.as(connectionSlot)),
          () => rpcWebSocketHttpEffect,
          (slot) =>
            sessions
              .markDisconnected(session.sessionId)
              .pipe(Effect.flatMap(() => releaseActiveWebSocketConnectionSlot(slot))),
        );
      }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
    ),
  ),
);
