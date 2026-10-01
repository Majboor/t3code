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
  CloudSyncError,
  CollaborationError,
  CommandId,
  AnalyticsError,
  DeployError,
  type EnvironmentId,
  PackEnablementError,
  ServiceRegistryError,
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
  ProjectDeleteEntryError,
  ProjectListDirectoryError,
  ProjectReadFileError,
  ProjectRenameEntryError,
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
  ProviderKind,
  type ProviderSessionIsolation,
  ProviderSessionId,
  ProviderSharingError,
  ProviderUsageError,
  ShareLinkError,
  TenantId,
  TenantRuntimeId,
  type TenantPermission,
  type TenantRole,
  DEFAULT_TERMINAL_ID,
  TerminalCwdError,
  TerminalSessionLookupError,
  ThreadId,
  WorkspaceId,
  type TerminalEvent,
  WS_METHODS,
  WsRpcGroup,
  DEFAULT_PROVIDER,
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
import { decideProjectHostingRefusal } from "./workspaceHosting.ts";
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
import { ServiceRegistry } from "./environment/Services/ServiceRegistry.ts";
import {
  AuthError,
  type AuthenticatedSession,
  isMachineOwnerSession,
  isSoleOccupantSession,
  resolveAuthenticatedUserId,
  ServerAuth,
} from "./auth/Services/ServerAuth.ts";
import { BOX_HUB_TOKEN_ENV, HUB_DELEGATED_SESSION_TTL } from "./box/hubProtocol.ts";
import {
  BootstrapCredentialService,
  type BootstrapCredentialChange,
} from "./auth/Services/BootstrapCredentialService.ts";
import {
  SessionCredentialService,
  type SessionCredentialChange,
} from "./auth/Services/SessionCredentialService.ts";
import { respondToAuthError } from "./auth/http.ts";
import { CloudSyncService } from "./cloudSync/Services/CloudSyncService.ts";
import { CollaborationService } from "./collaboration/Services/CollaborationService.ts";
import { OrganizationService } from "./organizations/Services/OrganizationService.ts";
import { PackRegistryService } from "./packs/Services/PackRegistryService.ts";
import { ProviderSharingService } from "./providerSharing/Services/ProviderSharingService.ts";
import { ProviderUsageService } from "./providerUsage/Services/ProviderUsageService.ts";
import { ShareLinkService } from "./shareLinks/Services/ShareLinkService.ts";
import { TenancyRepository } from "./persistence/Services/Tenancy.ts";
import { DeployService } from "./deploy/Services/DeployService.ts";
import { DeploymentRegistry } from "./deploy/Services/DeploymentRegistry.ts";
import { AnalyticsStore } from "./analytics/Services/AnalyticsStore.ts";
import { PackEnablementService } from "./packEnablement/Services/PackEnablementService.ts";
import { isLoopbackHost, isWildcardHost } from "./startupAccess.ts";
import type { FilesystemBrowseResult } from "@t3tools/contracts";
import { OPERATOR_PROVIDED_MARKER } from "./providerAuth/store.ts";
import { LocalAuthAccountRepository } from "./persistence/Services/LocalAuthAccounts.ts";
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

/**
 * A thread only gets a row once its first message is sent, but its terminal is
 * openable long before that: a draft the person is still composing is an
 * ordinary state, not an error. `terminal.open` authorizes the directory it was
 * handed, so remember that directory here and let the rest of the terminal RPCs
 * authorize against it while the thread itself is still unwritten.
 *
 * Keyed by thread id and shared across connections on purpose — the same draft
 * is reachable from a second window, and each caller is re-checked against the
 * remembered root rather than being trusted because someone else opened it.
 */
const MAX_REMEMBERED_TERMINAL_WORKSPACE_ROOTS = 256;
const terminalWorkspaceRootsByThreadId = new Map<string, string>();

function rememberTerminalWorkspaceRoot(threadId: string, cwd: string): void {
  // Re-inserting moves the entry to the end, so the trim below drops the roots
  // nobody has opened a terminal in for the longest.
  terminalWorkspaceRootsByThreadId.delete(threadId);
  terminalWorkspaceRootsByThreadId.set(threadId, cwd);
  while (terminalWorkspaceRootsByThreadId.size > MAX_REMEMBERED_TERMINAL_WORKSPACE_ROOTS) {
    const oldest = terminalWorkspaceRootsByThreadId.keys().next();
    if (oldest.done === true) break;
    terminalWorkspaceRootsByThreadId.delete(oldest.value);
  }
}

function forgetTerminalWorkspaceRoot(threadId: string): void {
  terminalWorkspaceRootsByThreadId.delete(threadId);
}

function threadWorkingDirectoryUnavailableMessage(threadId: string): string {
  return `Thread ${threadId} has no working directory on this server yet. Send its first message, or open its terminal, and try again.`;
}

export const __testTerminalWorkspaceRoots = {
  remember: rememberTerminalWorkspaceRoot,
  read: (threadId: string) => terminalWorkspaceRootsByThreadId.get(threadId),
  reset: () => terminalWorkspaceRootsByThreadId.clear(),
};

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

/**
 * An identity an invite can be attached to and still mean something tomorrow.
 *
 * The machine owner is deliberately not one. It carries a tenant and a user id
 * now, but they name a machine rather than a person: an invite redeemed as
 * `auth:desktop-bootstrap` would be spent, unrecoverable by the person it was
 * addressed to, and inherited by whoever next opens the app on this computer.
 */
function hasDurableInviteIdentity(session: AuthenticatedSession, inviteId: string): boolean {
  void inviteId;
  if (isMachineOwnerSession(session)) {
    return false;
  }
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

/**
 * How long a live subscription may keep running on a permission that was
 * checked a while ago. Short enough that a removal takes effect while the
 * person who did it is still looking at the roster.
 */
const LIVE_ACCESS_RECHECK_INTERVAL_MS = 10_000;

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

/**
 * Which projects a session may see, as one answer both a list RPC and an event
 * replay can ask.
 *
 * `null` means "unscoped" — the machine's own owner, or a legacy paired client
 * with no tenant at all. Every path on that machine is genuinely theirs, so
 * narrowing their view would be a bug rather than a fix. Everybody else gets a
 * set, and a set is a set of ids they hold a membership behind.
 */
export type VisibleProjectIds = ReadonlySet<string> | null;

/**
 * Whether a project is one this session may see at all.
 *
 * One rule, in one place, because three different readers ask it: the shell
 * snapshot, the event replay, and every list RPC that used to answer "no
 * filter given" with "everything". A project with no ownership stamp predates
 * tenancy; on a desktop install it is the owner's own and must stay reachable,
 * and on a server published to other people it is the host's and belongs on
 * nobody else's dashboard.
 */
export function isProjectOwnershipVisible(input: {
  readonly ownership: OrchestrationProjectOwnership | null | undefined;
  readonly visibleTenantIds: ReadonlySet<TenantId> | null;
  readonly unownedProjectsAreShared: boolean;
}): boolean {
  if (input.visibleTenantIds === null) {
    return true;
  }
  if (input.ownership === undefined || input.ownership === null) {
    return input.unownedProjectsAreShared;
  }
  return input.visibleTenantIds.has(input.ownership.tenantId);
}

/**
 * Keeps the rows belonging to projects this session may see.
 *
 * Written as a filter and never as "skip the check when no filter was given",
 * which is the shape that leaked: `deploy.listTargets`, `deploy.listRuns`,
 * `deploy.listDeployments` and `analytics.listStreams` all authorized on an
 * OPTIONAL `projectId`, so omitting the field skipped authorization entirely
 * and the repository's no-filter branch then returned every tenant's rows —
 * SSH hosts, identity-file paths, secret names, deploy command output. Leaving
 * a filter out must narrow a result, never widen it.
 *
 * A row naming a project this session cannot see is dropped rather than
 * reported, including a row whose project has since disappeared from the read
 * model: a project we cannot resolve is one we cannot say belongs to the
 * caller.
 */
export function keepRowsInVisibleProjects<Row extends { readonly projectId: string }>(
  rows: ReadonlyArray<Row>,
  visibleProjectIds: VisibleProjectIds,
): ReadonlyArray<Row> {
  if (visibleProjectIds === null) {
    return rows;
  }
  return rows.filter((row) => visibleProjectIds.has(row.projectId));
}

/**
 * Whether one replayed orchestration event belongs to this session.
 *
 * `orchestration.replayEvents` used to hand back `eventStore.readFromSequence`
 * unfiltered — the whole instance's append-only log, from sequence 0, to any
 * signed-in account. Every `project.created` payload carries a `workspaceRoot`,
 * every `thread.message-sent` payload carries the full `text` of a prompt or a
 * reply and its attachment ids, so one RPC read every other tenant's
 * conversations and directory layout. Three separate auditors found it
 * independently.
 *
 * The rule is the one `subscribeShell` already streams by: a project event is
 * visible when its project is, and a thread event is visible when the project
 * the thread hangs off is. A thread whose project cannot be resolved is
 * dropped — an event we cannot attribute is not an event we can say is theirs.
 */
export function isOrchestrationEventVisible(
  event: Pick<OrchestrationEvent, "aggregateKind" | "aggregateId">,
  scope: {
    readonly visibleProjectIds: VisibleProjectIds;
    readonly projectIdByThreadId: ReadonlyMap<string, string>;
  },
): boolean {
  if (scope.visibleProjectIds === null) {
    return true;
  }
  if (event.aggregateKind === "project") {
    return scope.visibleProjectIds.has(event.aggregateId);
  }
  const projectId = scope.projectIdByThreadId.get(event.aggregateId);
  return projectId !== undefined && scope.visibleProjectIds.has(projectId);
}

/**
 * Directories a hosted tenant may never claim as a project root.
 *
 * `project.create` only ever checked that the path did not overlap another
 * tenant's project, so a signed-in account could claim `~/.codex`, `~/.ssh` or
 * the server's own state directory — none of which any tenant had registered —
 * and the project it got back then made that directory readable and writable
 * through every cwd-gated RPC. `auth.json`, the sqlite projections and the
 * tenancy tables all sit behind exactly that.
 *
 * Deliberately a deny-list of the machine's own furniture rather than an
 * allow-list of the tenant's runtime tree: this box already has years of
 * different tenants' projects sitting as flat subfolders of one home
 * directory, and confining new claims to a per-tenant tree would refuse every
 * legitimate first project on it. The rule here refuses the places that are
 * never a project and always a credential store.
 *
 * The machine's own owner never reaches this — on their computer every path is
 * theirs, including their own dotfiles.
 */
export function isWorkspaceRootOffLimits(input: {
  readonly workspaceRoot: string;
  readonly protectedRoots: ReadonlyArray<string>;
}): boolean {
  const candidate = input.workspaceRoot.replaceAll("\\", "/").replace(/\/+$/, "");
  if (input.protectedRoots.some((root) => isPathInsideRoot(candidate, root))) {
    return true;
  }
  // A hidden directory is a place a program keeps its own state, not a place a
  // person keeps a project: `~/.codex`, `~/.claude`, `~/.ssh`, `~/.config` and
  // every per-tool credential store live behind exactly one leading dot, and
  // naming them one by one would leave the next one out.
  return candidate
    .split("/")
    .some((segment) => segment.length > 1 && segment.startsWith(".") && segment !== "..");
}

/**
 * Where a thread's agent is allowed to be told to run.
 *
 * `worktreePath` arrives on `thread.create`, on a turn's `bootstrap.createThread`
 * and on `thread.meta.update`, and it becomes the cwd the provider process is
 * launched in. Only the `projectId` beside it was ever authorized, so a caller
 * holding `session.create` on one project of their own could start a turn with
 * `worktreePath: "/root"` and get an agent with read and write over the whole
 * box — and the provider-isolation row the turn then wrote made plain
 * `projects.readFile` accept every unowned path under it afterwards.
 *
 * A worktree is either inside the project it belongs to or inside the server's
 * own worktrees directory, which is where `prepareWorktree` puts one. Nothing
 * else is a worktree, whoever is asking.
 */
export function isThreadWorktreePathAllowed(input: {
  readonly worktreePath: string;
  readonly projectWorkspaceRoot: string | undefined;
  readonly worktreesDir: string;
}): boolean {
  if (isPathInsideRoot(input.worktreePath, input.worktreesDir)) {
    return true;
  }
  // No project to measure against is not a reason to allow: a thread whose
  // project we cannot resolve is a thread we cannot place.
  return (
    input.projectWorkspaceRoot !== undefined &&
    isPathInsideRoot(input.worktreePath, input.projectWorkspaceRoot)
  );
}

/**
 * The directory a browse actually reads, which is not always the one it was
 * handed.
 *
 * `filesystem.browse` resolves `partialPath` to a target and then lists the
 * target's PARENT whenever the text has no trailing separator, using the last
 * segment as a name prefix — that is how type-ahead works. The tenant check ran
 * against the resolved target, so `partialPath: "/root/victim-app/a"` was
 * checked against `/root/victim-app/a` (which nobody owns, so it passed) and
 * then listed `/root/victim-app` (which somebody does). One trailing character
 * walked around the exact-match guard, and iterating the prefix recovered the
 * whole directory.
 *
 * This mirrors WorkspaceEntries.browse's own parent/prefix split on purpose.
 * The duplication is the cost of authorizing the directory that will really be
 * read; the alternative is a guard that keeps checking somewhere else.
 */
export function resolveBrowseListingDirectory(input: {
  readonly partialPath: string;
  readonly resolvedTarget: string;
}): string {
  const endsWithSeparator = /[\\/]$/.test(input.partialPath) || input.partialPath === "~";
  return endsWithSeparator ? input.resolvedTarget : path.dirname(input.resolvedTarget);
}

/**
 * What one machine's service row looks like to somebody who did not start it.
 *
 * `environment.services.list` reported every listening socket on a shared VPS
 * to any signed-in account: the pid, the full command line — which routinely
 * carries tokens passed as flags — and who started it. The port and the state
 * are what the caller legitimately needs (a port in use is a port they cannot
 * bind), and the process behind it is not.
 *
 * Rows T3 started for this caller keep everything. Everything else reports the
 * socket and stays quiet about the process.
 */
export function redactForeignService<
  Service extends {
    readonly ownership: string;
    readonly pid: number | null;
    readonly command: string | null;
    readonly startedBy: string | null;
    readonly name: string | null;
    readonly ownershipReason: string;
    readonly canManage: boolean;
  },
>(service: Service, viewerUserId: string): Service {
  // Your own service, in full.
  if (service.ownership === "ours" && service.startedBy === viewerUserId) {
    return service;
  }

  // A service T3 started for somebody else.
  //
  // Cutting this down to nothing was the first attempt, and it was the wrong
  // axis: the leak is other people's processes on a shared host, not a
  // colleague's dev server, and blanking a workspace-mate's row leaves a port
  // occupied by an anonymous nobody. The command line is the part that has to
  // go — it routinely carries tokens passed as flags — and the rest is what
  // makes a shared workspace legible.
  if (service.ownership === "ours") {
    return { ...service, command: null, pid: null, canManage: false };
  }

  // Not ours at all: an arbitrary process on the machine. The port and its
  // state are what a caller legitimately needs, since a port in use is a port
  // they cannot bind. Everything identifying the process goes, `ownershipReason`
  // included — it is prose about how the process was recognised and it named
  // paths and flags of its own.
  return {
    ...service,
    pid: null,
    command: null,
    startedBy: null,
    name: null,
    ownershipReason: "",
    canManage: false,
  };
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

  // `claude auth login` is not the command for this. It prints a sign-in link
  // and then offers nowhere to put the code the browser hands back, so the flow
  // it describes cannot be finished. `setup-token` is the one with the prompt,
  // and what it produces is a token belonging to a person rather than a login
  // belonging to the machine — which is also the shape per-user access needs.
  //
  // Note that `claude auth status` is not the check here, and saying so matters:
  // it reads a shared credential file that `setup-token` never writes, so it
  // answers "not logged in" about a login that worked.
  return {
    provider,
    authCommand: "claude setup-token",
    statusCommand: "claude setup-token",
    verificationHint:
      "Run the command in the isolated hosted provider shell, open the printed URL, and paste the code from the browser back into the prompt. It prints a token — paste that token here. Do not use `claude auth status`; it reports on a file this login does not write.",
    steps: [
      "Open a hosted provider shell for this account.",
      "Run `claude setup-token`.",
      "Open the printed URL and authorize, then paste the returned code into the prompt.",
      "Copy the token it prints and confirm it in T3 Code.",
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

  // What `claude setup-token` produces is the token itself, so the token is the
  // proof. Checked before the "not logged in" wording below, because the same
  // paste can carry both: the CLI prints the token under a shared-credential
  // notice that says, wrongly for this flow, that nobody is logged in.
  if (/sk-ant-[A-Za-z0-9_-]+/.test(output)) {
    return { authenticated: true };
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
      const providerSharing = yield* ProviderSharingService;
      const providerUsage = yield* ProviderUsageService;
      const shareLinks = yield* ShareLinkService;
      const cloudSync = yield* CloudSyncService;
      const organizations = yield* OrganizationService;
      const packRegistry = yield* PackRegistryService;
      const tenancyRepository = yield* TenancyRepository;
      const deployService = yield* DeployService;
      const analyticsStore = yield* AnalyticsStore;
      const deploymentRegistry = yield* DeploymentRegistry;
      const serviceRegistry = yield* ServiceRegistry;
      const packEnablement = yield* PackEnablementService;
      const threadPreferences = yield* ProjectionThreadPreferenceRepository;
      const localAuthAccounts = yield* LocalAuthAccountRepository;
      const rateLimitRef = yield* Ref.make({
        windowStartedAt: Date.now(),
        count: 0,
      });
      // Token reports reach every watcher of a thread, so only the connection
      // that asked for the turn is allowed to attribute them to its own user.
      const turnsStartedHereRef = yield* Ref.make(new Set<string>());
      // Read once per connection rather than per call: it decides how this
      // whole connection is metered and scoped, and a number that changed
      // underneath a live session would move the boundary mid-conversation.
      // Fail closed — a count we could not read must not promote a guest.
      const localAccountCount = yield* localAuthAccounts
        .countEnabled()
        .pipe(Effect.catch(() => Effect.succeed(Number.POSITIVE_INFINITY)));
      const machineOwnerSession = isSoleOccupantSession(session, {
        workspaceSource: config.workspaceSource,
        publishedBeyondLoopback: config.publishedBeyondLoopback,
        localAccountCount,
      });
      /**
       * The tenant this connection is a *guest* of, which is not the same
       * question as which tenant it belongs to.
       *
       * Everything below that meters, caps or isolates was written when the
       * machine's own owner had no tenant at all, so `tenantSessionContext`
       * being present was a serviceable stand-in for "somebody else's server".
       * It stopped being one the moment the owner was given a personal tenant:
       * left alone, the desktop app would start rationing its own machine —
       * 120 RPCs a minute instead of 300, two concurrent turns, a 2MB ceiling
       * on reading its own files — and would route every turn through
       * provider-account isolation built for tenants sharing a host.
       *
       * A machine owner is a guest of nobody, so this is undefined for them.
       * Use `session.tenantSessionContext` where the question really is "which
       * tenant does this act belong to" — ownership, membership, attribution.
       */
      const hostedTenantSession = machineOwnerSession ? undefined : session.tenantSessionContext;
      const collaborationActor = {
        userId: resolveAuthenticatedUserId(session),
        displayName: resolveCollaborationDisplayName(session),
      };
      /**
       * Who this connection acts as in the collaboration service, including the
       * address it can prove.
       *
       * The address matters because `acceptInvite` refuses only on a POSITIVE
       * mismatch between the invite's email and the actor's. `resolveLocalAccount`
       * answers for a local password account and returns nothing for anybody
       * signed in through Supabase, so on a hosted instance every actor arrived
       * with no email and that check never ran at all — an invite id was
       * redeemable by whoever held it, including a member who had just been
       * removed and kept one from the roster panel.
       *
       * The identity provider's own claim is the fallback, and "absent" still
       * means "this session cannot prove an address" rather than "any address
       * will do" — the rule `shareLinks` already follows.
       */
      const resolveCollaborationActor = serverAuth.resolveUserProfile(session).pipe(
        Effect.flatMap((profile) =>
          serverAuth.resolveLocalAccount(session).pipe(
            Effect.map((localAccount) => {
              const provableEmail = localAccount?.email ?? session.email;
              return {
                userId: profile.userId,
                displayName: profile.displayName,
                avatarInitials: profile.avatarInitials,
                ...(provableEmail ? { email: provableEmail } : {}),
              };
            }),
          ),
        ),
        Effect.catchTag("AuthError", () => Effect.succeed(collaborationActor)),
      );
      /**
       * The hub credential a person's own shell gets, so a terminal in the app
       * can do what the agent beside it can.
       *
       * The agent in a turn is handed one of these, and without this a terminal
       * opened two panes away would be the one place in the product where
       * `t3 box` says "no credential" — the person watching an agent drive their
       * box could not type the same command themselves. Nothing about that
       * asymmetry was ever decided; it fell out of the agent path being built
       * first.
       *
       * Minted here rather than passed through from the connection: the session
       * on this socket is a browser session, and putting it in a shell's
       * environment would leave a credential that outlives the tab in every
       * process that shell ever starts. This one acts as the same person, is
       * labelled as a terminal, and expires on its own.
       *
       * The key is stripped from whatever the client sent before ours is added.
       * `env` on the open input is client-supplied, so a caller could otherwise
       * name a credential rather than be given one — and the entire point of a
       * hub token is that it says who you are.
       */
      const withHubCredential = <T extends { readonly env?: Record<string, string> | undefined }>(
        input: T,
      ): Effect.Effect<T> =>
        serverAuth
          .issueDelegatedUserSession({
            userId: collaborationActor.userId,
            label: "terminal",
            ttl: HUB_DELEGATED_SESSION_TTL,
          })
          .pipe(
            Effect.map((issued) => issued.token),
            // A terminal that opens without one is a terminal where `t3 box`
            // says what it said before. Refusing to open the shell at all would
            // be a much worse trade.
            Effect.catch((error) =>
              Effect.logWarning("could not mint a hub credential for a terminal", {
                reason: error.message,
              }).pipe(Effect.as(null)),
            ),
            Effect.map((token) => {
              const { [BOX_HUB_TOKEN_ENV]: _supplied, ...requested } = input.env ?? {};
              return {
                ...input,
                env: token === null ? requested : { ...requested, [BOX_HUB_TOKEN_ENV]: token },
              };
            }),
          );

      const requireInviteAcceptingIdentity = <E>(
        inviteId: string,
        toError: (message: string) => E,
      ): Effect.Effect<void, E> =>
        hasDurableInviteIdentity(session, inviteId)
          ? Effect.void
          : Effect.fail(
              toError(
                machineOwnerSession
                  ? "Open the employee setup link or sign in with the invited account before accepting this invite."
                  : "Sign in with the invited account before accepting this invite.",
              ),
            );
      const issueInviteSetupUrlPath = (input: {
        readonly inviteId: string;
      }): Effect.Effect<string, AuthError> =>
        Effect.succeed(inviteAccountSetupUrlPath({ inviteId: input.inviteId }));
      // Deliberately the hosted tenant and not the session's own: a machine
      // owner's favorites were filed under the local scope before they had a
      // tenant, and re-scoping them to a freshly minted tenant id would hide
      // every star the person had already placed.
      const threadPreferenceScope = {
        tenantId: hostedTenantSession?.tenantId ?? LOCAL_THREAD_PREFERENCE_TENANT_ID,
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
        command: Extract<OrchestrationCommand, { type: "project.create" | "project.meta.update" }>,
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
              // `project.meta.update` may carry no title at all, where
              // `project.create` always does — and the workspace's own title is
              // the better answer either way.
              workspaceTitle: workspace?.title ?? command.title ?? String(targetWorkspaceId),
              organizationId: tenantSession.organizationId,
              organizationDisplayName: organization?.displayName ?? null,
              ownerUserId: tenantSession.userId,
              ownerDisplayName: employee?.displayName ?? collaborationActor.displayName,
            });
          }),
        );
      };

      /**
       * Refuses to create a project on a server that exists to hold accounts.
       *
       * Without this the `paired-environment` setting is decorative: the web
       * app stops *offering* to make a project here, but the command still
       * works, so anything speaking the protocol directly — the CLI, an old
       * build of the browser app, a reconnecting tab that cached the old
       * capability — quietly puts someone's project on the shared box. The
       * setting has to be enforced where the work would actually be done.
       */
      const refuseHostingWhenPairedEnvironment = (
        // Runs before normalization, so this sees the client's command shape
        // rather than the normalized one. Only the discriminant is read, and
        // narrowing to that keeps the two shapes from having to agree.
        command: {
          readonly type: string;
        },
      ): Effect.Effect<void, OrchestrationDispatchCommandError> => {
        const refusal = decideProjectHostingRefusal({
          workspaceSource: config.workspaceSource,
          command,
        });
        return refusal === null
          ? Effect.void
          : Effect.fail(new OrchestrationDispatchCommandError({ message: refusal }));
      };

      /**
       * Replaces whatever ownership the client sent with ownership derived
       * from their own session.
       *
       * `ownership` is a denormalized snapshot — tenant, workspace, owner and
       * all their display names — and it is what every later check reads to
       * decide who a project belongs to. It travelled on `project.meta.update`
       * as well as `project.create`, and only the create path was ever
       * re-derived, so an edit could write any tenant id and any owner name
       * into a project's stamp: hand your own project to somebody else's
       * tenant, or forge the owner the UI shows for it.
       *
       * `project.meta.update` only re-derives when the client actually sent an
       * ownership, because deriving one unasked would re-home a project to
       * whoever happened to rename it.
       */
      const attachProjectOwnership = (
        command: OrchestrationCommand,
      ): Effect.Effect<OrchestrationCommand, OrchestrationDispatchCommandError> => {
        if (command.type !== "project.create" && command.type !== "project.meta.update") {
          return Effect.succeed(command);
        }
        if (command.type === "project.meta.update" && command.ownership === undefined) {
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
          const tenantSession = hostedTenantSession;
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

      /**
       * Whether the credential this socket was authenticated with has since
       * been revoked.
       *
       * Authentication happens once, at the upgrade, and the session object is
       * then closed over for as long as the socket lives. `revoke` marks the
       * row, clears the connected map and tells the UI — and interrupts
       * nothing here, so a laptop the owner had just pressed Disconnect on
       * kept the entire RPC surface (reading any file under the workspace
       * roots, writing them, opening terminals, starting turns, every live
       * subscription) until the socket happened to drop on its own.
       *
       * Watched once per connection rather than re-verified per call: a
       * lookup on every RPC would put a database read in front of every
       * keystroke, and this arrives on the same stream the settings panel
       * already listens to.
       */
      const sessionRevokedRef = yield* Ref.make(false);
      yield* Effect.forkScoped(
        sessions.streamChanges.pipe(
          Stream.filter(
            (change) => change.type === "clientRemoved" && change.sessionId === currentSessionId,
          ),
          Stream.take(1),
          Stream.runDrain,
          Effect.flatMap(() => Ref.set(sessionRevokedRef, true)),
          // A watcher that died must not leave the socket looking valid
          // forever: treat losing the stream as "assume revoked" is too harsh
          // for a transient hiccup, so it is logged and the socket keeps its
          // existing checks.
          Effect.ignoreCause({ log: true }),
        ),
      );

      const ensureSessionNotRevoked = <E>(
        toError: (message: string) => E,
      ): Effect.Effect<void, E> =>
        Ref.get(sessionRevokedRef).pipe(
          Effect.flatMap((revoked) =>
            revoked
              ? Effect.fail(toError("This session has been revoked. Sign in again to continue."))
              : Effect.void,
          ),
        );

      // Every rate-limited method runs this, which is every method that can
      // read or change anything, so the revocation check rides along with it
      // rather than being remembered at ~200 call sites.
      const checkRateLimit = <E>(toError: (message: string) => E): Effect.Effect<void, E> =>
        ensureSessionNotRevoked(toError).pipe(
          Effect.flatMap(() =>
            hostedTenantSession ? checkHostedRateLimit(toError) : checkLocalRateLimit(toError),
          ),
        );

      const ensureHostedFileWriteLimit = <E>(
        input: { readonly contents: string; readonly encoding?: string | undefined },
        toError: (message: string) => E,
      ): Effect.Effect<void, E> => {
        if (!hostedTenantSession) {
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
        if (!hostedTenantSession) {
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
        if (!hostedTenantSession) {
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
        if (!hostedTenantSession) {
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
        if (!hostedTenantSession) {
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
        const tenantSession = hostedTenantSession;
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

      /**
       * Keeps asking whether a live subscription is still allowed to be one.
       *
       * Every stream here authorized once, at subscribe, and then ran for as
       * long as the socket did. Removing somebody from a workspace, or revoking
       * their session, interrupted nothing: a removed member kept receiving the
       * workspace's shared prompts, notes, approvals and invites, and kept
       * watching a thread's agent output arrive — live, on the socket they
       * already held. `subscribeTerminalEvents` was the one exception, and it
       * re-checks per event.
       *
       * Per event is too often for a token stream (a thread event is a few
       * characters, and the check costs a read-model load and a membership
       * read), so this re-checks on the first event after the interval has
       * passed. Removal takes effect within it, which is the property that
       * matters; nothing in between costs anything.
       *
       * A refusal FAILS the stream rather than silently dropping events: a
       * client told nothing would sit there looking connected forever, while a
       * failed stream is one the browser re-subscribes and gets a clean
       * refusal for.
       */
      const withLiveAccessRecheck = <A, E, R, RecheckError>(
        stream: Stream.Stream<A, E, R>,
        recheck: Effect.Effect<void, RecheckError>,
      ): Stream.Stream<A, E | RecheckError, R> =>
        Stream.unwrap(
          Ref.make(Date.now() + LIVE_ACCESS_RECHECK_INTERVAL_MS).pipe(
            Effect.map((recheckDueAtRef) =>
              stream.pipe(
                Stream.tap(() =>
                  Ref.get(recheckDueAtRef).pipe(
                    Effect.flatMap((recheckDueAt) =>
                      Date.now() < recheckDueAt
                        ? Effect.void
                        : recheck.pipe(
                            Effect.flatMap(() =>
                              Ref.set(
                                recheckDueAtRef,
                                Date.now() + LIVE_ACCESS_RECHECK_INTERVAL_MS,
                              ),
                            ),
                          ),
                    ),
                  ),
                ),
              ),
            ),
          ),
        );

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

      // Returns null for unscoped local sessions — the machine's own owner, or
      // a legacy paired client with no tenant — and the set of member tenant
      // ids otherwise.
      //
      // The owner is unscoped on purpose: every project on this computer is
      // theirs whether or not it was ever stamped with a tenant, and the app's
      // own window must not see a different machine than the CLI on loopback
      // sees. Before the owner had a tenant, both arrived here through the
      // first branch; they still have to leave through the same door.
      const sessionVisibleTenantIds = (): Effect.Effect<
        ReadonlySet<TenantId> | null,
        OrganizationError
      > => {
        if (!session.tenantSessionContext || machineOwnerSession) {
          return Effect.succeed(null);
        }
        return actorMemberships().pipe(
          Effect.map(
            (memberships) => new Set(memberships.map((membership) => membership.tenantId)),
          ),
        );
      };

      /**
       * The set of project ids this session may see, or `null` for a session
       * that is scoped to nothing — the machine's own owner, or a legacy
       * paired client.
       *
       * Exists so that "the caller named no project" can mean "every project
       * of theirs" instead of "every project on the instance", which is what
       * the deploy and analytics list RPCs meant before. An optional filter
       * must narrow a result; it must never be the thing that decides whether
       * a check runs at all.
       *
       * Fails closed to the empty set: memberships we could not read make
       * nobody a member of anything, and an empty list is the safe answer to
       * give somebody we cannot place.
       */
      const sessionVisibleProjectIds = (): Effect.Effect<VisibleProjectIds, never> =>
        sessionVisibleTenantIds().pipe(
          Effect.flatMap((visibleTenantIds) => {
            if (visibleTenantIds === null) {
              return Effect.succeed<VisibleProjectIds>(null);
            }
            // On a server published to other people an unowned project is the
            // host's own, and showing it to a tenant would hand them the
            // host's files; on a desktop install it is the owner's and has to
            // stay reachable. Same rule `subscribeShell` streams by.
            const unownedProjectsAreShared = !config.publishedBeyondLoopback;
            return orchestrationEngine.getReadModel().pipe(
              Effect.map(
                (readModel): VisibleProjectIds =>
                  new Set(
                    readModel.projects
                      .filter((project) =>
                        isProjectOwnershipVisible({
                          ownership: project.ownership,
                          visibleTenantIds,
                          unownedProjectsAreShared,
                        }),
                      )
                      .map((project) => project.id as string),
                  ),
              ),
            );
          }),
          Effect.catchCause(() => Effect.succeed<VisibleProjectIds>(new Set<string>())),
        );

      /**
       * Thread id to the project it hangs off, for scoping a replay.
       *
       * A thread missing from the read model is simply absent from the map,
       * and an event we cannot attribute to a project is an event nobody is
       * shown.
       */
      const projectIdByThreadId = (): Effect.Effect<ReadonlyMap<string, string>, never> =>
        orchestrationEngine.getReadModel().pipe(
          Effect.map(
            (readModel) =>
              new Map(
                readModel.threads.map((thread) => [
                  thread.id as string,
                  thread.projectId as string,
                ]),
              ),
          ),
          Effect.catchCause(() => Effect.succeed(new Map<string, string>())),
        );

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

      /**
       * The coarse half of the gate: may this session touch this workspace at
       * all. Whether the caller may speak for other people's accounts is the
       * service's own `canManage` check, which this deliberately does not
       * duplicate — one of the two would eventually drift.
       */
      const ensureTenantPermissionForProviderSharing = (
        tenantId: TenantId,
        permission: TenantPermission,
      ): Effect.Effect<void, ProviderSharingError> =>
        ensureTenantPermission(tenantId, permission).pipe(
          Effect.mapError(
            () =>
              new ProviderSharingError({
                code: "forbidden",
                message: forbiddenMessage(permission),
              }),
          ),
        );

      /**
       * The same coarse gate as sharing's, in this group's error vocabulary: an
       * `Effect` failing with `ProviderSharingError` cannot be piped into a
       * handler that must fail with `ProviderUsageError`, and widening either
       * error to serve both would make every sharing caller narrow past codes
       * about a request lifecycle it can never raise.
       */
      const ensureTenantPermissionForProviderUsage = (
        tenantId: TenantId,
        permission: TenantPermission,
      ): Effect.Effect<void, ProviderUsageError> =>
        ensureTenantPermission(tenantId, permission).pipe(
          Effect.mapError(
            () =>
              new ProviderUsageError({
                code: "forbidden",
                message: forbiddenMessage(permission),
              }),
          ),
        );

      /**
       * The coarse gate for share links, in this group's vocabulary. Whether
       * the caller is a member of the particular workspace is the service's own
       * roster check, which this deliberately does not duplicate.
       */
      const ensureTenantPermissionForShareLinks = (
        tenantId: TenantId,
        permission: TenantPermission,
      ): Effect.Effect<void, ShareLinkError> =>
        ensureTenantPermission(tenantId, permission).pipe(
          Effect.mapError(
            () =>
              new ShareLinkError({
                code: "forbidden",
                message: forbiddenMessage(permission),
              }),
          ),
        );

      /**
       * The coarse gate for cloud sync, in this group's vocabulary. An `Effect`
       * failing with `ShareLinkError` cannot be piped into a handler that must
       * fail with `CloudSyncError`, and widening either to serve both would
       * make every share-link caller narrow past codes about base revisions it
       * can never raise.
       *
       * Whether the caller belongs to the particular workspace is the service's
       * own roster check, which this deliberately does not duplicate.
       */
      const ensureTenantPermissionForCloudSync = (
        tenantId: TenantId,
        permission: TenantPermission,
      ): Effect.Effect<void, CloudSyncError> =>
        ensureTenantPermission(tenantId, permission).pipe(
          Effect.mapError(
            () =>
              new CloudSyncError({
                code: "forbidden",
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

      /**
       * The directory a thread's connection runs in.
       *
       * A thread that has been started answers with its worktree or its
       * project's root. A draft has neither yet, so fall back to the directory
       * its terminal was opened in — which `terminal.open` already authorized —
       * rather than treating a perfectly ordinary unsent thread as a missing
       * one. Only when there is no directory at all does this refuse, and it
       * says what to do about it.
       */
      const resolveThreadConnectionCwd = (
        threadId: ThreadId,
      ): Effect.Effect<string, ProviderAccountError> =>
        projectionSnapshotQuery.getThreadShellById(threadId).pipe(
          Effect.mapError(() =>
            providerAccountError("forbidden", threadWorkingDirectoryUnavailableMessage(threadId)),
          ),
          Effect.flatMap((thread) =>
            orchestrationEngine.getReadModel().pipe(
              Effect.flatMap((readModel) => {
                const threadShell = Option.isSome(thread)
                  ? thread.value
                  : readModel.threads.find((candidate) => candidate.id === threadId);
                const cwd =
                  threadShell === undefined
                    ? terminalWorkspaceRootsByThreadId.get(threadId)
                    : (threadShell.worktreePath ??
                      readModel.projects.find((candidate) => candidate.id === threadShell.projectId)
                        ?.workspaceRoot);
                if (!cwd) {
                  return Effect.fail(
                    providerAccountError(
                      "forbidden",
                      threadWorkingDirectoryUnavailableMessage(threadId),
                    ),
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

      /**
       * Narrows the tenancy snapshot to what this actor is a member of.
       *
       * There used to be an escape hatch here for a machine owner holding no
       * tenant, because filtering by memberships they could not have handed
       * them an empty dashboard. They hold one now, so the hatch is gone and
       * they are filtered like anybody else — which is the point: the one
       * tenant that comes back is the one the workspace dashboard then offers
       * to create workspaces in.
       */
      const filterOrganizationSnapshotForActor = (
        snapshot: OrganizationListResult,
      ): Effect.Effect<OrganizationListResult, never> =>
        actorMemberships().pipe(
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
        // Authorization is the membership check below: `ensureTenantPermission`
        // confirms this user is a member of `input.tenantId` with
        // `workspace.edit`, looking across every tenant they belong to. An
        // earlier guard here also refused whenever the session's *cached*
        // active tenant differed from the target, which rejected legitimate
        // creates after the tenant list changed or the token aged (the
        // recurring "only create in your active tenant" error) even though the
        // person plainly had the right. The membership check is the real gate,
        // so the redundant active-tenant guard is gone.

        /**
         * The bootstrap tenant is created on demand a few lines below, so
         * nobody can hold a membership in it yet and requiring one refuses
         * everybody. It is reached by the only clients left that hold no tenant
         * at all — a browser paired with a one-time token — for whom the
         * workspace dashboard, seeing an empty tenant list, synthesises this id.
         *
         * The machine's own owner is deliberately not one of them any more.
         * They have a personal tenant, the dashboard offers that tenant's real
         * id, and letting them through here as well would mean a session scoped
         * to one tenant creating a workspace in another — `tenant-local-personal`
         * is a real tenant with real members wherever the local seed has run,
         * not a private scratch id. So the two conditions still agree, and they
         * agree on the guard above rather than around it.
         */
        const isBootstrappingLocalPersonal =
          !tenantSession && input.tenantId === TenantId.make("tenant-local-personal");
        const permissionCheck = isBootstrappingLocalPersonal
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
      /**
       * Who this path answers to, keeping two very different answers apart.
       *
       * This used to return `null` for both "no tenant owns this path" and "a
       * tenant owns it and you are nobody there", and the caller read `null` as
       * the first one — falling through to the permissive provider-session
       * branch for somebody who had just been told, in effect, that the path
       * was not theirs. A member removed from a workspace kept file access to
       * its project roots that way, because removal leaves exactly that state:
       * the project still has ownership, and they no longer have a role in it.
       *
       * The same conflation was fixed in `workspace/fileHttp.ts`, where the
       * comment calls it out as a deliberate divergence from this function.
       * This is that divergence closed.
       */
      type WorkspaceRootTenancy =
        /** No tenant claims this path; provider-session isolation decides. */
        | { readonly _tag: "unowned" }
        /** A tenant claims it, and these are the caller's roles there — possibly none. */
        | { readonly _tag: "owned"; readonly roles: ReadonlyArray<TenantRole> };

      const resolveWorkspaceRootTenancy = (
        cwd: string,
      ): Effect.Effect<WorkspaceRootTenancy, never> =>
        Effect.all({
          readModel: orchestrationEngine.getReadModel(),
          memberships: actorMemberships(),
        }).pipe(
          Effect.map(({ readModel, memberships }): WorkspaceRootTenancy => {
            const owningTenantIds = new Set(
              readModel.projects
                .filter(
                  (project) =>
                    project.ownership !== undefined && isPathInsideRoot(cwd, project.workspaceRoot),
                )
                .map((project) => project.ownership!.tenantId),
            );
            if (owningTenantIds.size === 0) {
              return { _tag: "unowned" };
            }
            return {
              _tag: "owned",
              roles: memberships
                .filter((membership) => owningTenantIds.has(membership.tenantId))
                .flatMap((membership) => membership.roles),
            };
          }),
          // A read model we could not load must not widen anything: claim
          // ownership by nobody-in-particular so the caller refuses rather than
          // falling through to the permissive branch.
          Effect.catchCause(() =>
            Effect.succeed<WorkspaceRootTenancy>({ _tag: "owned", roles: [] }),
          ),
        );

      const ensureTenantWorkspacePermission = <E>(
        cwd: string,
        permission: TenantPermission,
        toError: (message: string) => E,
      ): Effect.Effect<void, E> => {
        // Every path on this machine belongs to the person sitting at it. The
        // rest of this function decides which of several tenants a path answers
        // to, which is a question a single-owner install does not have.
        if (machineOwnerSession) {
          return Effect.void;
        }

        const tenantSession = hostedTenantSession;
        if (tenantSession) {
          return resolveWorkspaceRootTenancy(cwd).pipe(
            Effect.flatMap((tenancy) => {
              if (tenancy._tag === "owned") {
                // Owned by a tenant. The caller's roles *there* decide, and no
                // roles means no, rather than dropping through to the branch
                // below — which is how a removed member kept their access.
                return hasTenantPermission({ roles: tenancy.roles, permission })
                  ? Effect.void
                  : Effect.fail(toError(forbiddenMessage(permission)));
              }
              // Genuinely unowned: fall back to provider-session isolation.
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
                providerSession.tenantId !== hostedTenantSession?.tenantId ||
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
                    tenantSession: hostedTenantSession,
                  }).allowed
                : false;
            });
            if (matchingProviderSession) {
              return Effect.void;
            }
            /**
             * No provider sessions exist at all, so there is nothing to be
             * isolated from.
             *
             * This gate assumes a hosted deployment where a tenant reaches a
             * path only through a provider session it owns. A project
             * registered before tenancy — its ownership still null — fell
             * through to here and was refused `project.view` against its own
             * owner. The visible symptom was a send button that did nothing,
             * plus git failing on the same path, for the only person on the
             * machine.
             *
             * This allowance is the second line of defence for that, not the
             * first: a machine owner never reaches this function at all, which
             * matters because turns on such an install do now create provider
             * sessions, and the count above stops being zero after the first
             * one.
             *
             * The permission itself was already checked by the caller; this
             * only declines to add a second gate that cannot be satisfied.
             */
            if (snapshot.providerSessions.length === 0) {
              return Effect.void;
            }
            return Effect.fail(toError(forbiddenMessage(permission)));
          }),
        );

      const ensureAnyTenantWorkspacePermission = <E>(
        roots: readonly string[],
        permission: TenantPermission,
        toError: (message: string) => E,
      ): Effect.Effect<void, E> => {
        if (machineOwnerSession || (!session.tenantSessionContext && !session.userId)) {
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

      /**
       * The account a registry write is attributed to.
       *
       * Taken from the session and never from a payload, because two of the
       * registry's rules turn on it: only the holder may release a port claim,
       * and a service is recorded as started *for* somebody. An agent has no
       * account of its own and always arrives carrying the id of whoever asked
       * for the turn, which is the same attribution the file-touch marks use.
       */
      const serviceRegistryActor = resolveAuthenticatedUserId(session);

      /**
       * Which machine a registry call is about.
       *
       * This connection is attached to exactly one, and its sockets are the only
       * ones anything here can see. An id naming a different environment is
       * refused rather than quietly answered about this one: a caller told
       * ":5432 is free" about the wrong machine would bind into a collision and
       * have been told the truth about somewhere else.
       */
      const resolveServiceRegistryEnvironment = (
        requested: EnvironmentId | undefined,
      ): Effect.Effect<EnvironmentId, ServiceRegistryError> =>
        serverEnvironment.getEnvironmentId.pipe(
          Effect.flatMap((environmentId) =>
            requested === undefined || requested === environmentId
              ? Effect.succeed(environmentId)
              : Effect.fail(
                  new ServiceRegistryError({
                    code: "forbidden",
                    message: `This connection is attached to ${environmentId} and cannot report what is running on ${requested}.`,
                  }),
                ),
          ),
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

      /**
       * Authorize every id a deploy or analytics list RPC was handed, and say
       * what the answer may still contain.
       *
       * These four methods — `deploy.listTargets`, `deploy.listRuns`,
       * `deploy.listDeployments`, `analytics.listStreams` — all took an
       * OPTIONAL `projectId` and authorized with a ternary: present, check it;
       * absent, skip the check. The repositories' no-filter branch is "every
       * row on the instance", so leaving the field out was a read of every
       * tenant's SSH hosts, identity-file paths, secret names, deploy command
       * output and live deployment URLs. Two of them also forwarded a
       * caller-supplied `targetId` that nothing ever authorized, which turned
       * one harvested id into a targeted read of somebody else's deploy logs.
       *
       * So: every id the caller supplies is authorized, and an absent id
       * narrows to what this session may see rather than widening to
       * everything. The returned scope is `null` only when an explicit id was
       * checked — the rows are already confined to that project — and
       * otherwise is the caller's visible project set, which `keepRowsInVisibleProjects`
       * applies to the rows themselves.
       */
      const resolveDeployListScope = (input: {
        readonly projectId?: ProjectId | undefined;
        readonly targetId?: DeployTargetId | undefined;
      }): Effect.Effect<VisibleProjectIds, DeployError> =>
        Effect.all(
          [
            input.projectId === undefined
              ? Effect.void
              : ensureDeployProjectAccess(input.projectId, "project.view"),
            input.targetId === undefined
              ? Effect.void
              : resolveDeployTargetProject(input.targetId).pipe(
                  Effect.flatMap((project) =>
                    ensureDeployProjectAccess(project.id, "project.view"),
                  ),
                ),
          ],
          { discard: true },
        ).pipe(
          Effect.flatMap(() =>
            input.projectId === undefined && input.targetId === undefined
              ? sessionVisibleProjectIds()
              : Effect.succeed<VisibleProjectIds>(null),
          ),
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

      const terminalThreadIsKnown = (threadId: string): Effect.Effect<boolean> =>
        projectionSnapshotQuery.getThreadShellById(ThreadId.make(threadId)).pipe(
          Effect.map(Option.isSome),
          Effect.catchCause(() => Effect.succeed(false)),
          Effect.flatMap((known) =>
            known
              ? Effect.succeed(true)
              : orchestrationEngine.getReadModel().pipe(
                  Effect.map((readModel) =>
                    readModel.threads.some((candidate) => candidate.id === threadId),
                  ),
                  Effect.catchCause(() => Effect.succeed(false)),
                ),
          ),
        );

      /**
       * Authorize a terminal RPC for a thread that may not have a row yet.
       *
       * A started thread authorizes through its own worktree and project, as
       * everything else does. A draft has neither, so it authorizes through the
       * directory `terminal.open` already checked for it — the same check, run
       * again for whoever is asking now. A thread with no row and no terminal
       * ever opened here is an id this server has never heard of: that is a
       * lookup failure, not a directory failure, and it says so.
       */
      const ensureTerminalThreadAccess = (
        input: { readonly threadId: string; readonly terminalId?: string | undefined },
        permission: TenantPermission,
      ): Effect.Effect<void, TerminalCwdError | TerminalSessionLookupError> => {
        const toError = (message: string) => terminalRpcError(input.threadId, message);
        return terminalThreadIsKnown(input.threadId).pipe(
          Effect.flatMap(
            (known): Effect.Effect<void, TerminalCwdError | TerminalSessionLookupError> => {
              if (known) {
                return ensureThreadAccess(input.threadId, permission, toError);
              }
              const openedRoot = terminalWorkspaceRootsByThreadId.get(input.threadId);
              if (openedRoot !== undefined) {
                return ensureWorkspaceRoot(openedRoot, permission, toError);
              }
              return Effect.fail(
                new TerminalSessionLookupError({
                  threadId: input.threadId,
                  terminalId: input.terminalId ?? DEFAULT_TERMINAL_ID,
                }),
              );
            },
          ),
        );
      };

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

      /**
       * Rejects claiming, or browsing into, a path that overlaps — in either
       * direction — with a project some OTHER tenant already owns.
       *
       * Deliberately narrower than routing through `ensureWorkspaceRoot`'s
       * full tenant-permission chain: that chain's "unowned path" fallback
       * (`ensureProviderSessionGrantsWorkspaceRoot`) only allows a path
       * through when precisely zero provider sessions exist anywhere on the
       * whole machine — a condition meant for a project registered before
       * tenancy existed, not for "a brand-new tenant's first-ever project on
       * an already-active server". Verified live: this box already has real
       * sessions running for other tenants, so that fallback would reject
       * every legitimate new account's very first project too, alongside
       * the malicious case it also happens to catch. This check instead
       * looks only at whether the path is *already claimed by someone
       * else* — a genuinely new, unclaimed path is never gated here at all.
       *
       * Fixes a real, live-reproduced gap: a freshly created hosted account,
       * with zero projects and zero memberships anywhere, could browse the
       * server's literal home directory (see `filesystemBrowse` below) and
       * then successfully call `project.create` against another tenant's
       * existing project directory (or a parent of one) — ownership then got
       * stamped to the new tenant regardless of whose files were actually at
       * that path, handing them real, persistent read/write access.
       *
       * One direction of that overlap check — "the new path sits *inside* an
       * existing other-tenant claim" — has to skip claims rooted exactly at
       * the machine's home directory. A legacy project can end up rooted
       * there (itself a symptom of the very leak this closes, from before it
       * was fixed), and left unguarded that turns into every other path on
       * the box being "inside" it — blocking every other tenant from ever
       * creating a project again. The exact-path case is still always
       * blocked below regardless of this exemption, so browsing or claiming
       * the home directory itself remains forbidden either way; only a
       * *proper descendant* of it is allowed to fall through to the
       * per-project overlap checks instead of being vetoed by the home
       * directory's mere existence as a claim.
       *
       * `mode` controls how far that overlap check reaches, because
       * "claiming" and "merely browsing" carry very different blast radii:
       *
       * - `"full"` (used by `project.create`) blocks exact matches plus both
       *   ancestor/descendant directions — claiming a path hands the caller
       *   real, persistent read/write access, so any overlap at all with
       *   another tenant's project must be refused.
       * - `"exactMatchOnly"` (used by `filesystemBrowse`) blocks only an
       *   exact match with another tenant's project root — i.e. actually
       *   landing inside their tracked directory and seeing its real
       *   contents. It deliberately does *not* block browsing a shared
       *   ancestor folder just because some unrelated tenant also happens to
       *   have a project nested somewhere underneath it. This box has years
       *   of different tenants' projects sitting as flat, unisolated
       *   subfolders of the same home directory (e.g. `/root/Desktop`), so
       *   the `"full"` ancestor check applied to read-only browsing made
       *   *every* shared parent folder permanently unbrowsable — new
       *   accounts could not navigate anywhere to create their first
       *   project at all. Read-only name enumeration of sibling folders is
       *   a real but much smaller disclosure than the exact-match case, and
       *   accepting it is what keeps onboarding working on this
       *   already-populated, non-isolated filesystem.
       */
      const ensureWorkspaceRootNotClaimedByOtherTenant = <E>(
        cwd: string,
        permission: TenantPermission,
        toError: (message: string) => E,
        mode: "full" | "exactMatchOnly" = "full",
      ): Effect.Effect<void, E> => {
        const tenantSession = hostedTenantSession;
        if (machineOwnerSession || !tenantSession) {
          return Effect.void;
        }
        const homeDir = os.homedir();
        return orchestrationEngine.getReadModel().pipe(
          Effect.mapError(() => toError(forbiddenMessage(permission))),
          Effect.flatMap((readModel) => {
            const conflicting = readModel.projects.some((project) => {
              if (
                project.ownership === undefined ||
                project.ownership.tenantId === tenantSession.tenantId
              ) {
                return false;
              }
              const isExactMatch =
                isPathInsideRoot(cwd, project.workspaceRoot) &&
                isPathInsideRoot(project.workspaceRoot, cwd);
              if (isExactMatch || mode === "exactMatchOnly") {
                return isExactMatch;
              }
              const claimIsDegenerateHomeDir = project.workspaceRoot === homeDir;
              return (
                (!claimIsDegenerateHomeDir && isPathInsideRoot(cwd, project.workspaceRoot)) ||
                isPathInsideRoot(project.workspaceRoot, cwd)
              );
            });
            return conflicting ? Effect.fail(toError(forbiddenMessage(permission))) : Effect.void;
          }),
        );
      };

      /**
       * Hides other tenants' project directories from a browse listing.
       *
       * Blocking entry into someone else's project root was never the whole
       * story: the folder NAME is disclosure too, and a hosted account with no
       * projects of its own browses the server's home directory to find
       * somewhere to start — which on a shared host lists everybody's work.
       * Reported from a live instance, where opening the picker showed the
       * server's own `Desktop`, `runs` and `t3code-src`.
       *
       * Filtering rather than refusing is the point. The stricter rule tried
       * before — veto any directory that so much as contains another tenant's
       * project — made every shared parent unbrowsable, so new accounts could
       * not reach anywhere to create a first project and onboarding stopped.
       * Removing the individual entries keeps the parent navigable, keeps a
       * person's own folders and unclaimed folders visible, and gives up only
       * the names that were never theirs to see.
       *
       * The machine's own owner is exempt: on their computer every path is
       * theirs, and a picker that hid their own directories would be a bug.
       */
      const withoutOtherTenantsProjects = (
        result: FilesystemBrowseResult,
      ): Effect.Effect<FilesystemBrowseResult, never> => {
        const tenantSession = hostedTenantSession;
        if (machineOwnerSession || !tenantSession) {
          return Effect.succeed(result);
        }
        return orchestrationEngine.getReadModel().pipe(
          // A read model we could not load must not widen the listing: fail
          // closed to "show nothing but the parent" rather than showing
          // everything.
          Effect.map((readModel) => {
            const otherTenantRoots = readModel.projects.flatMap((project) =>
              project.ownership !== undefined &&
              project.ownership.tenantId !== tenantSession.tenantId
                ? [project.workspaceRoot]
                : [],
            );
            if (otherTenantRoots.length === 0) {
              return result;
            }
            return {
              ...result,
              entries: result.entries.filter(
                (entry) =>
                  !otherTenantRoots.some(
                    (root) =>
                      isPathInsideRoot(entry.fullPath, root) &&
                      isPathInsideRoot(root, entry.fullPath),
                  ),
              ),
            };
          }),
          Effect.catchCause(() => Effect.succeed({ ...result, entries: [] })),
        );
      };

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
                  DEFAULT_PROVIDER,
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
                DEFAULT_PROVIDER,
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
        // GLM's credential is a LogicPacks gateway API key (LogicPacksGateway),
        // never a local operator-home file — nothing to seed, so this list is
        // always empty and the operator-fallback path becomes a safe no-op if
        // ever reached for "glm".
        glm: [],
      } as const satisfies Record<ProviderKind, ReadonlyArray<string>>;

      const operatorProviderHome = (provider: ProviderKind): string =>
        provider === "codex"
          ? (process.env["CODEX_HOME"] ?? path.join(os.homedir(), ".codex"))
          : path.join(os.homedir(), ".claude");

      const seedProviderHomeFromOperator = (
        provider: ProviderKind,
        authHomeDir: string,
      ): Effect.Effect<void, never> => {
        // Only the operator's own machine. A published host never lends.
        //
        // Seeding copies the operator's Codex or Claude credential into
        // somebody else's provider home, and on their own computer that is
        // simply their login reaching their own isolated homes. On a host with
        // other people on it, it is a durable copy of one subscription handed
        // to every account: one instance ended up with 390 byte-identical
        // copies of a single OpenAI credential, with the operator's address
        // shown to all of them as "your account".
        //
        // The flag that used to allow it on a published host is no longer
        // honoured, because the product it existed for is gone. LogicPacks
        // gives every account GLM free — a per-user gateway key minted at
        // signup, with nothing to connect and nothing shared — and Codex and
        // Claude are logins people bring themselves. Lending the operator's is
        // not a fallback any more, just a leak.
        if (!isSingleMachineServer) {
          if (config.operatorProviderFallback === true) {
            return Effect.logWarning(
              "ignoring T3CODE_OPERATOR_PROVIDER_FALLBACK on a published host",
              {
                detail:
                  "Lending the operator's Codex/Claude login to every account is no longer supported. Accounts get GLM free through the LogicPacks gateway, and connect their own Codex or Claude.",
              },
            );
          }
          return Effect.void;
        }
        const sourceHome = operatorProviderHome(provider);
        // Claude Code reads its credentials from `CLAUDE_CONFIG_DIR` (the
        // account's `config/` directory) or `$HOME/.claude`, not from the home
        // itself, so a copy at the home root alone left every turn "Not logged
        // in". Seed the places the CLI actually looks as well.
        const targetDirs =
          provider === "claudeAgent"
            ? [authHomeDir, path.join(authHomeDir, "config"), path.join(authHomeDir, ".claude")]
            : [authHomeDir];
        return Effect.forEach(
          targetDirs.flatMap((dir) =>
            OPERATOR_PROVIDER_CREDENTIAL_FILES[provider].map(
              (fileName) => [dir, fileName] as const,
            ),
          ),
          ([dir, fileName]) =>
            Effect.gen(function* () {
              const target = path.join(dir, fileName);
              if (yield* fileSystem.exists(target)) {
                return;
              }
              const source = path.join(sourceHome, fileName);
              if (!(yield* fileSystem.exists(source))) {
                return;
              }
              yield* fileSystem.makeDirectory(dir, { recursive: true });
              yield* fileSystem.copyFile(source, target);
              yield* fileSystem.chmod(target, 0o600);
              // Say, on disk, that this was lent rather than connected.
              //
              // A copied credential is otherwise indistinguishable from one the
              // person logged in with, and everything downstream believed it:
              // settings called it their account and showed the operator's
              // email, the account index recorded it as theirs, and the roster
              // offered it as something they could lend onward. One instance
              // had 390 users each holding a byte-identical copy of a single
              // OpenAI credential on exactly that misunderstanding.
              yield* fileSystem
                .writeFileString(
                  path.join(dir, OPERATOR_PROVIDED_MARKER),
                  "Seeded from the operator's own login by T3CODE_OPERATOR_PROVIDER_FALLBACK.\n",
                )
                .pipe(Effect.ignore);
            }).pipe(Effect.ignore),
          { discard: true },
        );
      };

      const persistHostedProviderConnectionForTurnStart = (
        command: Extract<OrchestrationCommand, { type: "thread.turn.start" }>,
      ): Effect.Effect<void, OrchestrationDispatchCommandError> => {
        // Isolation keeps one tenant's provider credentials out of another
        // tenant's reach. On a machine with a single owner there is no other
        // tenant, and routing their turns through it would put the provider's
        // home somewhere their existing login is not.
        const tenantSession = hostedTenantSession;
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
            // GLM's credential is the calling user's own LogicPacks gateway API
            // key (`LogicPacksGateway`, Phase A), not an OAuth account isolated
            // into a home/config/secrets directory — there is nothing to
            // persist here. `GlmAdapter.startSession` resolves the real
            // credential itself via `T3CODE_GLM_USER_ID` (see
            // `ProviderCommandReactor.ts`'s `resolveProviderCredentialEnvironment`).
            if (target.provider === "glm") {
              return Effect.void;
            }

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
       * Says out loud that a turn is starting on top of somebody's open file.
       *
       * This is the last moment the loss is preventable, which is the whole
       * reason it lives on the dispatch path rather than in a panel: an agent
       * replaces a file instead of merging into it, so an editor holding
       * unsaved edits loses them silently the moment the turn writes.
       *
       * It records and never refuses. A workspace where a colleague's open
       * editor could block everybody's turns would be a worse product than one
       * that warns, and the warning reaches every browser on the collaboration
       * stream the instant it is written.
       *
       * It deliberately does not claim to know which files the turn will write.
       * Nothing does, before the turn runs — the file list only exists once a
       * diff does — and a guess presented as a prediction would be worse than
       * naming the real risk.
       */
      const warnTurnStartOverOpenFiles = (
        command: Extract<OrchestrationCommand, { type: "thread.turn.start" }>,
      ): Effect.Effect<void> =>
        Effect.gen(function* () {
          const ownership = yield* resolveTurnStartOwnership(command);
          if (!ownership) {
            return;
          }
          const actor = yield* resolveCollaborationActor;
          yield* collaboration.warnBeforeAgentWrites(actor.userId, {
            tenantId: ownership.tenantId,
            workspaceId: ownership.workspaceId,
          });
        }).pipe(
          // A warning that failed must never be the reason a turn did not run.
          Effect.catchCause(() => Effect.void),
        );

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

      /**
       * Directories on this machine that are nobody's project, whoever asks.
       *
       * `project.create` only ever asked whether another tenant had already
       * claimed the path, so anything unclaimed was claimable — including the
       * server's own state directory (the sqlite projections, the tenancy
       * tables, the session credentials), the provider homes under it, and the
       * operator's `~/.ssh` and `~/.codex`. Claiming one stamped it with the
       * caller's tenant, and from then on every cwd-gated RPC read and wrote
       * inside it quite legitimately.
       */
      const protectedWorkspaceRoots = (): ReadonlyArray<string> => [
        config.baseDir,
        config.stateDir,
        config.secretsDir,
        hostedTenantRuntimeRootDir,
        path.join(os.homedir(), ".ssh"),
      ];

      /**
       * Refuses a project root that is the machine's own furniture.
       *
       * The machine's owner is exempt, as everywhere else: on their computer
       * their dotfiles are theirs, and a desktop install that refused to open
       * a folder the person picked would be the bug.
       */
      const ensureWorkspaceRootClaimable = <E>(
        workspaceRoot: string,
        toError: (message: string) => E,
      ): Effect.Effect<void, E> => {
        if (machineOwnerSession || !hostedTenantSession) {
          return Effect.void;
        }
        return isWorkspaceRootOffLimits({
          workspaceRoot,
          protectedRoots: protectedWorkspaceRoots(),
        })
          ? Effect.fail(
              toError(
                "That directory belongs to the server itself and cannot be registered as a project.",
              ),
            )
          : Effect.void;
      };

      /**
       * Pins a thread's worktree to the project it claims to belong to.
       *
       * `worktreePath` travels on `thread.create`, on a turn's
       * `bootstrap.createThread` and on `thread.meta.update`, and it becomes
       * the cwd the agent process is launched in — but only the `projectId`
       * beside it was ever authorized. Anybody holding `session.create` on one
       * project of their own could therefore start a turn with
       * `worktreePath: "/root"` and get an agent reading and writing across the
       * whole box; worse, the provider-isolation row that turn then wrote made
       * plain `projects.readFile` accept every unowned path underneath it
       * afterwards.
       *
       * Fails closed: a project we cannot resolve is a project we cannot
       * measure the path against, and an unmeasurable path is refused.
       */
      const ensureThreadWorktreePathAllowed = (input: {
        readonly worktreePath: string | null | undefined;
        readonly projectId?: ProjectId | undefined;
        readonly threadId?: ThreadId | undefined;
      }): Effect.Effect<void, OrchestrationDispatchCommandError> => {
        const worktreePath = input.worktreePath;
        if (worktreePath === null || worktreePath === undefined || worktreePath.length === 0) {
          return Effect.void;
        }
        // Every path on this machine is the owner's own, and a desktop install
        // has no second tenant to keep them out of.
        if (machineOwnerSession || !hostedTenantSession) {
          return Effect.void;
        }
        const refuse = Effect.fail(
          new OrchestrationDispatchCommandError({
            message:
              "A thread worktree must sit inside its own project or the server's worktrees directory.",
          }),
        );
        return orchestrationEngine.getReadModel().pipe(
          Effect.map((readModel) => {
            const projectId =
              input.projectId ??
              readModel.threads.find((thread) => thread.id === input.threadId)?.projectId;
            return Option.fromUndefinedOr(
              readModel.projects.find((project) => project.id === projectId)?.workspaceRoot,
            );
          }),
          // A read model we could not load must not widen anything.
          Effect.catchCause(() => Effect.succeed(Option.none<string>())),
          Effect.flatMap((projectWorkspaceRoot) =>
            isThreadWorktreePathAllowed({
              worktreePath,
              projectWorkspaceRoot: Option.getOrUndefined(projectWorkspaceRoot),
              worktreesDir: config.worktreesDir,
            })
              ? Effect.void
              : refuse,
          ),
        );
      };

      const ensureOrchestrationCommandAuthorized = (
        command: OrchestrationCommand,
      ): Effect.Effect<void, OrchestrationDispatchCommandError> => {
        switch (command.type) {
          case "project.create":
            return checkRateLimit(
              (message) => new OrchestrationDispatchCommandError({ message }),
            ).pipe(
              Effect.flatMap(() =>
                ensureWorkspaceRootClaimable(
                  command.workspaceRoot,
                  (message) => new OrchestrationDispatchCommandError({ message }),
                ),
              ),
              Effect.flatMap(() =>
                ensureWorkspaceRootNotClaimedByOtherTenant(
                  command.workspaceRoot,
                  "project.create",
                  (message) => new OrchestrationDispatchCommandError({ message }),
                ),
              ),
            );
          case "project.meta.update": {
            // `ensureProjectAccess` authorizes the project's CURRENT root,
            // which says nothing about the one this command is about to put
            // there. So `project.edit` on one project of your own was enough to
            // repoint it at another tenant's directory, or at the server's own
            // home, or at `/` — and a project root is the thing every other
            // check measures a path against, so afterwards the file routes, the
            // browse listing and `ensureWorkspaceRoot` all agreed the caller
            // reached it. The same two checks `project.create` makes about a
            // path it is claiming apply to a path being claimed later; this is
            // the project-root twin of what `ensureThreadWorktreePathAllowed`
            // already does for a thread's worktree.
            const nextRoot = command.workspaceRoot;
            return checkRateLimit(
              (message) => new OrchestrationDispatchCommandError({ message }),
            ).pipe(
              Effect.flatMap(() => ensureProjectAccess(command.projectId, "project.edit")),
              Effect.flatMap(() =>
                nextRoot === undefined
                  ? Effect.void
                  : ensureWorkspaceRootClaimable(
                      nextRoot,
                      (message) => new OrchestrationDispatchCommandError({ message }),
                    ).pipe(
                      Effect.flatMap(() =>
                        ensureWorkspaceRootNotClaimedByOtherTenant(
                          nextRoot,
                          "project.edit",
                          (message) => new OrchestrationDispatchCommandError({ message }),
                        ),
                      ),
                    ),
              ),
            );
          }
          case "project.delete":
            return checkRateLimit(
              (message) => new OrchestrationDispatchCommandError({ message }),
            ).pipe(Effect.flatMap(() => ensureProjectAccess(command.projectId, "project.edit")));
          case "thread.create":
            return checkRateLimit(
              (message) => new OrchestrationDispatchCommandError({ message }),
            ).pipe(
              Effect.flatMap(() => ensureProjectAccess(command.projectId, "session.create")),
              // The cwd the agent will be launched in is a path parameter, not
              // metadata, so it is authorized like one.
              Effect.flatMap(() =>
                ensureThreadWorktreePathAllowed({
                  worktreePath: command.worktreePath,
                  projectId: command.projectId,
                }),
              ),
            );
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
                    ensureThreadWorktreePathAllowed({
                      worktreePath: command.bootstrap.createThread.worktreePath,
                      projectId: command.bootstrap.createThread.projectId,
                    }),
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
              // Last, so a turn that was refused never warns about a write it
              // was never going to make.
              Effect.tap(() => warnTurnStartOverOpenFiles(command)),
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
          case "thread.meta.update":
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
              // Repointing an existing thread's worktree moves where its next
              // turn runs, so it is the same path parameter as on create and
              // gets the same check — without it, `session.view` on one thread
              // was enough to aim an agent anywhere on the box.
              Effect.flatMap(() =>
                ensureThreadWorktreePathAllowed({
                  worktreePath: command.worktreePath,
                  threadId: command.threadId,
                }),
              ),
            );
          case "thread.delete":
          case "thread.archive":
          case "thread.unarchive":
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

      const resolveDefaultProviderOverride = (): ProviderKind | undefined => {
        const raw = process.env.T3CODE_DEFAULT_PROVIDER;
        return raw !== undefined && Schema.is(ProviderKind)(raw) ? raw : undefined;
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
          // Instance-scoped default-provider override for new projects/threads,
          // config-gated on `T3CODE_DEFAULT_PROVIDER` (only ever set on a single
          // test instance) — every other instance sends `undefined` here and
          // frontend callers fall back to the compile-time `DEFAULT_PROVIDER`
          // constant unchanged.
          defaultProviderOverride: resolveDefaultProviderOverride(),
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
              // Before normalization, which creates the workspace directory
              // when asked: refusing afterwards would leave a folder behind on
              // a server that just said it does not host projects.
              yield* refuseHostingWhenPairedEnvironment(command);
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
              // The replay is the raw append-only log for the whole instance,
              // so it is scoped here or it is not scoped anywhere: a
              // `project.created` payload carries a workspace root and a
              // `thread.message-sent` payload carries the text of a prompt.
              // Scope resolved before the rows are read, and the filter
              // applied before enrichment, so another tenant's project never
              // costs this caller two git spawns either.
              Effect.all({
                visibleProjectIds: sessionVisibleProjectIds(),
                threadProjects: projectIdByThreadId(),
              }).pipe(
                Effect.flatMap(({ visibleProjectIds, threadProjects }) =>
                  Stream.runCollect(
                    orchestrationEngine.readEvents(
                      clamp(input.fromSequenceExclusive, {
                        maximum: Number.MAX_SAFE_INTEGER,
                        minimum: 0,
                      }),
                    ),
                  ).pipe(
                    Effect.map((events) =>
                      Array.from(events).filter((event) =>
                        isOrchestrationEventVisible(event, {
                          visibleProjectIds,
                          projectIdByThreadId: threadProjects,
                        }),
                      ),
                    ),
                  ),
                ),
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
              const visibleTenantIds = yield* sessionVisibleTenantIds().pipe(
                Effect.mapError(
                  (cause) =>
                    new OrchestrationGetSnapshotError({
                      message: "Failed to resolve tenant visibility for this session.",
                      cause,
                    }),
                ),
              );
              /**
               * A project with no ownership was never scoped to a tenant, so
               * there is nobody it can be shown to by matching one — and hiding
               * it from everybody makes it unreachable rather than private.
               *
               * That is what happened to projects registered before tenancy: on
               * a desktop install they vanished from the dashboard, could not be
               * re-added because the workspace root was already taken, and left
               * a thread whose project never resolved, which reads as a send
               * button that hangs. A hosted deployment always stamps ownership
               * at creation, so an absent one means a local project that
               * predates the concept. `ShareLinkService.readProject` makes the
               * same allowance for the same reason.
               */
              // On a server published to other people, an unowned project is
              // the host's own (the cwd it was started from, a CLI-added path)
              // and belongs on nobody else's dashboard: showing it handed every
              // fresh account a second project with the host's files behind it.
              const unownedProjectsAreShared = !config.publishedBeyondLoopback;
              const isOwnershipVisible = (
                ownership: OrchestrationProjectShell["ownership"] | null | undefined,
              ): boolean =>
                isProjectOwnershipVisible({
                  ownership,
                  visibleTenantIds,
                  unownedProjectsAreShared,
                });
              const isVisibleProject = (project: OrchestrationProjectShell): boolean =>
                isOwnershipVisible(project.ownership);
              // Computed before the snapshot query itself so it can skip
              // resolving repository identity (two `git` subprocess spawns
              // each) for every project on the server this session cannot
              // see — see ProjectionSnapshotQuery.getShellSnapshot's doc.
              const snapshot = yield* projectionSnapshotQuery
                .getShellSnapshot({ isProjectVisible: isOwnershipVisible })
                .pipe(
                  Effect.mapError(
                    (cause) =>
                      new OrchestrationGetSnapshotError({
                        message: "Failed to load orchestration shell snapshot",
                        cause,
                      }),
                  ),
                );
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

              const liveStream = withLiveAccessRecheck(
                orchestrationEngine.streamDomainEvents.pipe(
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
                ),
                // The thread's agent output is the substance of somebody's
                // work. Access to it was checked once above and never again,
                // so removal from the owning tenant left the stream running.
                ensureThreadAccess(
                  input.threadId,
                  "session.view",
                  (message) => new OrchestrationGetSnapshotError({ message }),
                ),
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
                Effect.flatMap(() => resolveCollaborationActor),
                Effect.flatMap((actor) => collaboration.listPresence(actor, input)),
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
                Effect.flatMap(() => resolveCollaborationActor),
                Effect.flatMap((actor) => collaboration.listInvites(actor, input)),
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
        [WS_METHODS.collaborationSharedPromptCreate]: (input) =>
          observeRpcEffect(
            WS_METHODS.collaborationSharedPromptCreate,
            withRateLimit(
              ensureTenantPermissionForCollaboration(input.tenantId, "session.prompt").pipe(
                Effect.flatMap(() => resolveCollaborationActor),
                Effect.flatMap((actor) => collaboration.createSharedPrompt(actor, input)),
              ),
              (message) => new CollaborationError({ code: "invalid-membership-rule", message }),
            ),
            { "rpc.aggregate": "collaboration" },
          ),
        [WS_METHODS.collaborationSharedPromptList]: (input) =>
          observeRpcEffect(
            WS_METHODS.collaborationSharedPromptList,
            withRateLimit(
              ensureTenantPermissionForCollaboration(input.tenantId, "workspace.view").pipe(
                Effect.flatMap(() => resolveCollaborationActor),
                Effect.flatMap((actor) => collaboration.listSharedPrompts(actor, input)),
              ),
              (message) => new CollaborationError({ code: "invalid-membership-rule", message }),
            ),
            { "rpc.aggregate": "collaboration" },
          ),
        [WS_METHODS.collaborationNoteCreate]: (input) =>
          observeRpcEffect(
            WS_METHODS.collaborationNoteCreate,
            withRateLimit(
              ensureTenantPermissionForCollaboration(input.tenantId, "session.prompt").pipe(
                Effect.flatMap(() => resolveCollaborationActor),
                Effect.flatMap((actor) => collaboration.createNote(actor, input)),
              ),
              (message) => new CollaborationError({ code: "invalid-membership-rule", message }),
            ),
            { "rpc.aggregate": "collaboration" },
          ),
        [WS_METHODS.collaborationNoteList]: (input) =>
          observeRpcEffect(
            WS_METHODS.collaborationNoteList,
            withRateLimit(
              ensureTenantPermissionForCollaboration(input.tenantId, "workspace.view").pipe(
                Effect.flatMap(() => resolveCollaborationActor),
                Effect.flatMap((actor) => collaboration.listNotesForTarget(actor, input)),
              ),
              (message) => new CollaborationError({ code: "invalid-membership-rule", message }),
            ),
            { "rpc.aggregate": "collaboration" },
          ),
        [WS_METHODS.collaborationNoteResolve]: (input) =>
          observeRpcEffect(
            WS_METHODS.collaborationNoteResolve,
            withRateLimit(
              // The service checks that the caller is the sharing prompt's own
              // author; this gate only keeps non-members out of the workspace
              // entirely, same as collaborationApprovalsDecide.
              ensureTenantPermissionForCollaboration(input.tenantId, "workspace.view").pipe(
                Effect.flatMap(() => resolveCollaborationActor),
                Effect.flatMap((actor) => collaboration.resolveNote(actor, input)),
              ),
              (message) => new CollaborationError({ code: "invalid-membership-rule", message }),
            ),
            { "rpc.aggregate": "collaboration" },
          ),
        [WS_METHODS.collaborationDirectMessageList]: (input) =>
          observeRpcEffect(
            WS_METHODS.collaborationDirectMessageList,
            withRateLimit(
              ensureTenantPermissionForCollaboration(input.tenantId, "workspace.view").pipe(
                Effect.flatMap(() => resolveCollaborationActor),
                Effect.flatMap((actor) => collaboration.listDirectMessages(actor, input)),
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
                Effect.flatMap(() => resolveCollaborationActor),
                Effect.flatMap((actor) => collaboration.listFileTouches(actor, input)),
              ),
              (message) => new CollaborationError({ code: "invalid-membership-rule", message }),
            ),
            { "rpc.aggregate": "collaboration" },
          ),
        /**
         * "I have these files open." The kind is not on the wire: the server
         * stamps `person` because this arrived over somebody's session, and an
         * agent's claim is filed by the reactor and never comes through here.
         */
        [WS_METHODS.collaborationFilesPresenceMark]: (input) =>
          observeRpcEffect(
            WS_METHODS.collaborationFilesPresenceMark,
            withRateLimit(
              ensureTenantPermissionForCollaboration(input.tenantId, "workspace.edit").pipe(
                Effect.flatMap(() => resolveCollaborationActor),
                Effect.flatMap((actor) => collaboration.markFilePresence(actor, input)),
              ),
              (message) => new CollaborationError({ code: "invalid-membership-rule", message }),
            ),
            { "rpc.aggregate": "collaboration" },
          ),
        [WS_METHODS.collaborationFilesPresenceRelease]: (input) =>
          observeRpcEffect(
            WS_METHODS.collaborationFilesPresenceRelease,
            withRateLimit(
              ensureTenantPermissionForCollaboration(input.tenantId, "workspace.edit").pipe(
                Effect.flatMap(() => resolveCollaborationActor),
                Effect.flatMap((actor) => collaboration.releaseFilePresence(actor, input)),
              ),
              (message) => new CollaborationError({ code: "invalid-membership-rule", message }),
            ),
            { "rpc.aggregate": "collaboration" },
          ),
        [WS_METHODS.collaborationFilesPresenceList]: (input) =>
          observeRpcEffect(
            WS_METHODS.collaborationFilesPresenceList,
            withRateLimit(
              ensureTenantPermissionForCollaboration(input.tenantId, "workspace.view").pipe(
                Effect.flatMap(() => resolveCollaborationActor),
                Effect.flatMap((actor) => collaboration.listFilePresence(actor, input)),
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
                  Effect.flatMap(() => resolveCollaborationActor),
                  Effect.map((actor) =>
                    // `collaboration.stream` filters on the tenant and
                    // workspace ids the CLIENT supplied, so the re-check is
                    // what stands between a removed member and the
                    // workspace's shared prompts, notes, approvals and invites
                    // continuing to arrive on their open socket. The tenant
                    // permission alone was not enough: an invite scoped to one
                    // workspace mints a tenant-wide membership, so the stream
                    // also has to keep agreeing that the actor reaches THIS
                    // workspace, which is what `stream` now checks.
                    withLiveAccessRecheck(
                      collaboration.stream(actor, input),
                      ensureTenantPermissionForCollaboration(input.tenantId, "workspace.view").pipe(
                        Effect.flatMap(() => collaboration.ensureWorkspaceAccess(actor, input)),
                      ),
                    ),
                  ),
                ),
              ),
              (message) => new CollaborationError({ code: "invalid-membership-rule", message }),
            ),
            {
              "rpc.aggregate": "collaboration",
            },
          ),
        [WS_METHODS.providerSharingOverviewGet]: (input) =>
          observeRpcEffect(
            WS_METHODS.providerSharingOverviewGet,
            withRateLimit(
              ensureTenantPermissionForProviderSharing(input.tenantId, "workspace.view").pipe(
                Effect.flatMap(() => resolveCollaborationActor),
                Effect.flatMap((actor) => providerSharing.getOverview(actor, input)),
              ),
              (message) => new ProviderSharingError({ code: "forbidden", message }),
            ),
            { "rpc.aggregate": "provider-sharing" },
          ),
        [WS_METHODS.providerSharingShareUpdate]: (input) =>
          observeRpcEffect(
            WS_METHODS.providerSharingShareUpdate,
            withRateLimit(
              // Lending an account is a statement about the caller's own
              // credential, so it needs no more than the right to be in the
              // workspace; the service takes the owner from the session.
              ensureTenantPermissionForProviderSharing(input.tenantId, "workspace.view").pipe(
                Effect.flatMap(() => resolveCollaborationActor),
                Effect.flatMap((actor) => providerSharing.updateShare(actor, input)),
              ),
              (message) => new ProviderSharingError({ code: "forbidden", message }),
            ),
            { "rpc.aggregate": "provider-sharing" },
          ),
        [WS_METHODS.providerSharingPolicyUpdate]: (input) =>
          observeRpcEffect(
            WS_METHODS.providerSharingPolicyUpdate,
            withRateLimit(
              ensureTenantPermissionForProviderSharing(input.tenantId, "workspace.edit").pipe(
                Effect.flatMap(() => resolveCollaborationActor),
                Effect.flatMap((actor) => providerSharing.updatePolicy(actor, input)),
              ),
              (message) => new ProviderSharingError({ code: "forbidden", message }),
            ),
            { "rpc.aggregate": "provider-sharing" },
          ),
        [WS_METHODS.providerSharingMemberUpdate]: (input) =>
          observeRpcEffect(
            WS_METHODS.providerSharingMemberUpdate,
            withRateLimit(
              ensureTenantPermissionForProviderSharing(input.tenantId, "membership.manage").pipe(
                Effect.flatMap(() => resolveCollaborationActor),
                Effect.flatMap((actor) => providerSharing.updateMemberAccess(actor, input)),
              ),
              (message) => new ProviderSharingError({ code: "forbidden", message }),
            ),
            { "rpc.aggregate": "provider-sharing" },
          ),
        [WS_METHODS.providerUsageRequestCreate]: (input) =>
          observeRpcEffect(
            WS_METHODS.providerUsageRequestCreate,
            withRateLimit(
              // Asking is a statement about the caller's own situation, so it
              // needs no more than the right to be in the workspace; the
              // service takes the requester from the session and checks the
              // roster itself.
              ensureTenantPermissionForProviderUsage(input.tenantId, "workspace.view").pipe(
                Effect.flatMap(() => resolveCollaborationActor),
                Effect.flatMap((actor) => providerUsage.createRequest(actor, input)),
              ),
              (message) => new ProviderUsageError({ code: "forbidden", message }),
            ),
            { "rpc.aggregate": "provider-usage" },
          ),
        [WS_METHODS.providerUsageRequestList]: (input) =>
          observeRpcEffect(
            WS_METHODS.providerUsageRequestList,
            withRateLimit(
              ensureTenantPermissionForProviderUsage(input.tenantId, "workspace.view").pipe(
                Effect.flatMap(() => resolveCollaborationActor),
                Effect.flatMap((actor) => providerUsage.listRequests(actor, input)),
              ),
              (message) => new ProviderUsageError({ code: "forbidden", message }),
            ),
            { "rpc.aggregate": "provider-usage" },
          ),
        [WS_METHODS.providerUsageRequestRespond]: (input) =>
          observeRpcEffect(
            WS_METHODS.providerUsageRequestRespond,
            withRateLimit(
              // Lending your own account is not a workspace-admin act, so this
              // asks for no more than membership either; whether the caller
              // actually owns the account being granted is the service's check.
              ensureTenantPermissionForProviderUsage(input.tenantId, "workspace.view").pipe(
                Effect.flatMap(() => resolveCollaborationActor),
                Effect.flatMap((actor) => providerUsage.respondToRequest(actor, input)),
              ),
              (message) => new ProviderUsageError({ code: "forbidden", message }),
            ),
            { "rpc.aggregate": "provider-usage" },
          ),
        [WS_METHODS.providerUsageRequestWithdraw]: (input) =>
          observeRpcEffect(
            WS_METHODS.providerUsageRequestWithdraw,
            withRateLimit(
              ensureTenantPermissionForProviderUsage(input.tenantId, "workspace.view").pipe(
                Effect.flatMap(() => resolveCollaborationActor),
                Effect.flatMap((actor) => providerUsage.withdrawRequest(actor, input)),
              ),
              (message) => new ProviderUsageError({ code: "forbidden", message }),
            ),
            { "rpc.aggregate": "provider-usage" },
          ),
        [WS_METHODS.shareLinksCreate]: (input) =>
          observeRpcEffect(
            WS_METHODS.shareLinksCreate,
            withRateLimit(
              // `workspace.edit`, not `workspace.view`. Minting one of these
              // publishes a workspace's files to anyone the URL reaches, which
              // is a change to what the workspace is, not a read of it — a
              // viewer-only role must not be able to make one.
              ensureTenantPermissionForShareLinks(input.tenantId, "workspace.edit").pipe(
                Effect.flatMap(() => resolveCollaborationActor),
                Effect.flatMap((actor) => shareLinks.create(actor, input)),
              ),
              (message) => new ShareLinkError({ code: "forbidden", message }),
            ),
            { "rpc.aggregate": "share-links" },
          ),
        [WS_METHODS.shareLinksList]: (input) =>
          observeRpcEffect(
            WS_METHODS.shareLinksList,
            withRateLimit(
              ensureTenantPermissionForShareLinks(input.tenantId, "workspace.view").pipe(
                Effect.flatMap(() => resolveCollaborationActor),
                Effect.flatMap((actor) => shareLinks.list(actor, input)),
              ),
              (message) => new ShareLinkError({ code: "forbidden", message }),
            ),
            { "rpc.aggregate": "share-links" },
          ),
        [WS_METHODS.shareLinksRevoke]: (input) =>
          observeRpcEffect(
            WS_METHODS.shareLinksRevoke,
            withRateLimit(
              // Deliberately no stricter than creating. Switching a link off is
              // the safe direction, and anyone who can be trusted to hand out
              // access has to be able to take it back without finding an admin.
              ensureTenantPermissionForShareLinks(input.tenantId, "workspace.edit").pipe(
                Effect.flatMap(() => resolveCollaborationActor),
                Effect.flatMap((actor) => shareLinks.revoke(actor, input)),
              ),
              (message) => new ShareLinkError({ code: "forbidden", message }),
            ),
            { "rpc.aggregate": "share-links" },
          ),
        [WS_METHODS.cloudSyncStatusGet]: (input) =>
          observeRpcEffect(
            WS_METHODS.cloudSyncStatusGet,
            withRateLimit(
              ensureTenantPermissionForCloudSync(input.tenantId, "workspace.view").pipe(
                Effect.flatMap(() => resolveCollaborationActor),
                Effect.flatMap((actor) => cloudSync.getStatus(actor, input)),
              ),
              (message) => new CloudSyncError({ code: "forbidden", message }),
            ),
            { "rpc.aggregate": "cloud-sync" },
          ),
        [WS_METHODS.cloudSyncStart]: (input) =>
          observeRpcEffect(
            WS_METHODS.cloudSyncStart,
            withRateLimit(
              // `workspace.edit`, not `workspace.view`. Starting a sync
              // replicates a laptop's files into a workspace and, in `mirror`,
              // lets a local delete remove a file from the cloud copy everybody
              // else is working on. That is a change to what the workspace is.
              ensureTenantPermissionForCloudSync(input.tenantId, "workspace.edit").pipe(
                Effect.flatMap(() => resolveCollaborationActor),
                Effect.flatMap((actor) => cloudSync.start(actor, input)),
              ),
              (message) => new CloudSyncError({ code: "forbidden", message }),
            ),
            { "rpc.aggregate": "cloud-sync" },
          ),
        [WS_METHODS.cloudSyncPause]: (input) =>
          observeRpcEffect(
            WS_METHODS.cloudSyncPause,
            withRateLimit(
              // Deliberately no stricter than starting. Stopping the flow of
              // bytes is the safe direction, and anyone trusted to begin a sync
              // has to be able to halt one without finding an admin.
              ensureTenantPermissionForCloudSync(input.tenantId, "workspace.edit").pipe(
                Effect.flatMap(() => resolveCollaborationActor),
                Effect.flatMap((actor) => cloudSync.pause(actor, input)),
              ),
              (message) => new CloudSyncError({ code: "forbidden", message }),
            ),
            { "rpc.aggregate": "cloud-sync" },
          ),
        [WS_METHODS.cloudSyncStop]: (input) =>
          observeRpcEffect(
            WS_METHODS.cloudSyncStop,
            withRateLimit(
              ensureTenantPermissionForCloudSync(input.tenantId, "workspace.edit").pipe(
                Effect.flatMap(() => resolveCollaborationActor),
                Effect.flatMap((actor) => cloudSync.stop(actor, input)),
              ),
              (message) => new CloudSyncError({ code: "forbidden", message }),
            ),
            { "rpc.aggregate": "cloud-sync" },
          ),
        [WS_METHODS.cloudSyncConflictsList]: (input) =>
          observeRpcEffect(
            WS_METHODS.cloudSyncConflictsList,
            withRateLimit(
              ensureTenantPermissionForCloudSync(input.tenantId, "workspace.view").pipe(
                Effect.flatMap(() => resolveCollaborationActor),
                Effect.flatMap((actor) => cloudSync.listConflicts(actor, input)),
              ),
              (message) => new CloudSyncError({ code: "forbidden", message }),
            ),
            { "rpc.aggregate": "cloud-sync" },
          ),
        [WS_METHODS.cloudSyncConflictsResolve]: (input) =>
          observeRpcEffect(
            WS_METHODS.cloudSyncConflictsResolve,
            withRateLimit(
              // `workspace.edit` even though nothing is deleted and no side is
              // chosen: this is the call that stops the badge nagging, and
              // someone who may only read the workspace must not be able to
              // clear a warning about two copies of a file that are still
              // sitting on somebody's disk.
              ensureTenantPermissionForCloudSync(input.tenantId, "workspace.edit").pipe(
                Effect.flatMap(() => resolveCollaborationActor),
                Effect.flatMap((actor) => cloudSync.resolveConflict(actor, input)),
              ),
              (message) => new CloudSyncError({ code: "forbidden", message }),
            ),
            { "rpc.aggregate": "cloud-sync" },
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
              resolveDeployListScope(input).pipe(
                Effect.mapError(
                  (error) => new AnalyticsError({ code: "storage-failed", message: error.message }),
                ),
                Effect.flatMap((visibleProjectIds) =>
                  analyticsStore
                    .listStreams(
                      input.projectId !== undefined ? { projectId: input.projectId } : {},
                    )
                    .pipe(
                      Effect.map((result) => ({
                        ...result,
                        streams: keepRowsInVisibleProjects(result.streams, visibleProjectIds),
                      })),
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
              resolveDeployListScope(input).pipe(
                Effect.flatMap((visibleProjectIds) =>
                  deployService
                    .listTargets(
                      input.projectId !== undefined ? { projectId: input.projectId } : {},
                    )
                    .pipe(
                      Effect.map((targets) =>
                        keepRowsInVisibleProjects(targets, visibleProjectIds),
                      ),
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
              resolveDeployListScope(input).pipe(
                Effect.flatMap((visibleProjectIds) =>
                  deployService
                    .listRuns({
                      ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
                      ...(input.targetId !== undefined ? { targetId: input.targetId } : {}),
                      ...(input.limit !== undefined ? { limit: input.limit } : {}),
                    })
                    .pipe(Effect.map((runs) => keepRowsInVisibleProjects(runs, visibleProjectIds))),
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
              resolveDeployListScope(input).pipe(
                Effect.flatMap((visibleProjectIds) =>
                  deploymentRegistry
                    .list({
                      ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
                      ...(input.targetId !== undefined ? { targetId: input.targetId } : {}),
                    })
                    .pipe(
                      Effect.map((deployments) =>
                        keepRowsInVisibleProjects(deployments, visibleProjectIds),
                      ),
                    ),
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
        [WS_METHODS.environmentServicesList]: (input) =>
          observeRpcEffect(
            WS_METHODS.environmentServicesList,
            withRateLimit(
              // The environment id in the payload is a filter and not an
              // instruction. This connection is attached to one machine, and
              // reporting another's ports would be reporting sockets nothing
              // here can see.
              resolveServiceRegistryEnvironment(input.environmentId).pipe(
                Effect.flatMap((environmentId) => serviceRegistry.list({ environmentId })),
                // The registry takes no actor and filters by nobody, so every
                // row on a shared host came back whole: the pid, the full
                // command line — which routinely carries a token passed as a
                // flag — who started it, and every other person's port claims.
                // A caller legitimately needs to know a port is taken; they do
                // not need the process behind it. The machine's own owner sees
                // everything, because on their computer every process is
                // theirs.
                Effect.map((result) =>
                  machineOwnerSession
                    ? result
                    : {
                        ...result,
                        services: result.services.map((service) =>
                          redactForeignService(service, serviceRegistryActor),
                        ),
                        claims: result.claims.filter(
                          (claim) => claim.claimedBy === serviceRegistryActor,
                        ),
                      },
                ),
              ),
              (message) => new ServiceRegistryError({ code: "forbidden", message }),
            ),
            { "rpc.aggregate": "environment" },
          ),
        [WS_METHODS.environmentServicesRegister]: (input) =>
          observeRpcEffect(
            WS_METHODS.environmentServicesRegister,
            withRateLimit(
              resolveServiceRegistryEnvironment(undefined).pipe(
                Effect.flatMap((environmentId) =>
                  serviceRegistry.register({
                    ...input,
                    environmentId,
                    asking: serviceRegistryActor,
                  }),
                ),
              ),
              (message) => new ServiceRegistryError({ code: "forbidden", message }),
            ),
            { "rpc.aggregate": "environment" },
          ),
        [WS_METHODS.environmentServicesRelease]: (input) =>
          observeRpcEffect(
            WS_METHODS.environmentServicesRelease,
            withRateLimit(
              resolveServiceRegistryEnvironment(undefined).pipe(
                Effect.flatMap((environmentId) =>
                  serviceRegistry.release({
                    environmentId,
                    serviceId: input.serviceId,
                    asking: serviceRegistryActor,
                  }),
                ),
              ),
              (message) => new ServiceRegistryError({ code: "forbidden", message }),
            ),
            { "rpc.aggregate": "environment" },
          ),
        [WS_METHODS.environmentPortsCheck]: (input) =>
          observeRpcEffect(
            WS_METHODS.environmentPortsCheck,
            withRateLimit(
              resolveServiceRegistryEnvironment(undefined).pipe(
                Effect.flatMap((environmentId) =>
                  serviceRegistry.checkPort({
                    environmentId,
                    port: input.port,
                    asking: serviceRegistryActor,
                  }),
                ),
                // The same redaction its sibling `environment.services.list`
                // runs. This route hands back a verdict carrying the whole
                // service that holds the port, so leaving it alone meant the
                // pid and command line walked straight out of the route next
                // door to the one that was fixed.
                Effect.map((result) =>
                  machineOwnerSession || !result.verdict.service
                    ? result
                    : {
                        ...result,
                        verdict: {
                          ...result.verdict,
                          service: redactForeignService(
                            result.verdict.service,
                            serviceRegistryActor,
                          ),
                        },
                      },
                ),
              ),
              (message) => new ServiceRegistryError({ code: "forbidden", message }),
            ),
            { "rpc.aggregate": "environment" },
          ),
        [WS_METHODS.environmentPortsClaim]: (input) =>
          observeRpcEffect(
            WS_METHODS.environmentPortsClaim,
            withRateLimit(
              resolveServiceRegistryEnvironment(undefined).pipe(
                Effect.flatMap((environmentId) =>
                  // The holder is the session and never the payload. A claim
                  // that could name its own owner is a claim one connection
                  // could take on another's behalf, and then release.
                  serviceRegistry.claimPort({
                    ...input,
                    environmentId,
                    asking: serviceRegistryActor,
                  }),
                ),
              ),
              (message) => new ServiceRegistryError({ code: "forbidden", message }),
            ),
            { "rpc.aggregate": "environment" },
          ),
        [WS_METHODS.environmentPortsRelease]: (input) =>
          observeRpcEffect(
            WS_METHODS.environmentPortsRelease,
            withRateLimit(
              resolveServiceRegistryEnvironment(undefined).pipe(
                Effect.flatMap((environmentId) =>
                  serviceRegistry.releasePort({
                    environmentId,
                    port: input.port,
                    asking: serviceRegistryActor,
                  }),
                ),
              ),
              (message) => new ServiceRegistryError({ code: "forbidden", message }),
            ),
            { "rpc.aggregate": "environment" },
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
                          const providerSession = {
                            id: ProviderSessionId.make(
                              `provider-session:${result.membership.id}:${account.provider}`,
                            ),
                            tenantId: result.membership.tenantId,
                            userId: result.membership.userId,
                            providerAccountId: account.id,
                            provider: account.provider,
                            // The account's own home, not a per-user subdirectory of it.
                            //
                            // This used to append a segment derived from the
                            // member's user id, and nothing anywhere creates
                            // that directory — not this handler, not the
                            // provider-auth flow, not the runtime. So accepting
                            // an organization invite pinned the member to a
                            // path that does not exist, and every Codex turn
                            // they ran in that project failed with the login
                            // missing, while the same account worked everywhere
                            // else. The sibling that mints a provider session
                            // for a connected account (the provider-auth
                            // terminal above) has always used the home
                            // directly; this is the odd one out, and being the
                            // odd one out is the whole defect.
                            //
                            // Per-member isolation under a shared account is a
                            // real thing to want, but it has to be built —
                            // seeded credentials and all — rather than implied
                            // by a path.
                            providerHomeDir: account.authHomeDir,
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
        [WS_METHODS.projectsDeleteEntry]: (input) =>
          observeRpcEffect(
            WS_METHODS.projectsDeleteEntry,
            withRateLimit(
              ensureWorkspaceRoot(
                input.cwd,
                "file.write",
                (message) => new ProjectDeleteEntryError({ message }),
              ).pipe(
                Effect.flatMap(() =>
                  workspaceFileSystem.deleteEntry(input).pipe(
                    Effect.mapError((cause) => {
                      const message = Schema.is(WorkspacePathOutsideRootError)(cause)
                        ? "Workspace file path must stay within the project root."
                        : "Failed to delete workspace entry";
                      return new ProjectDeleteEntryError({
                        message,
                        cause,
                      });
                    }),
                  ),
                ),
              ),
              (message) => new ProjectDeleteEntryError({ message }),
            ),
            { "rpc.aggregate": "workspace" },
          ),
        [WS_METHODS.projectsRenameEntry]: (input) =>
          observeRpcEffect(
            WS_METHODS.projectsRenameEntry,
            withRateLimit(
              ensureWorkspaceRoot(
                input.cwd,
                "file.write",
                (message) => new ProjectRenameEntryError({ message }),
              ).pipe(
                Effect.flatMap(() =>
                  workspaceFileSystem.renameEntry(input).pipe(
                    Effect.mapError((cause) => {
                      const message = Schema.is(WorkspacePathOutsideRootError)(cause)
                        ? "Workspace file path must stay within the project root."
                        : "Failed to rename workspace entry";
                      return new ProjectRenameEntryError({
                        message,
                        cause,
                      });
                    }),
                  ),
                ),
              ),
              (message) => new ProjectRenameEntryError({ message }),
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
              // The tenant check used to run only `if (input.cwd)` — but a
              // `partialPath` like "~/" needs no `cwd` to resolve, so a
              // brand-new hosted account with zero projects (and so no
              // `cwd` to send) walked straight past the check and browsed
              // the server's literal home directory, seeing every other
              // tenant's project directory names. Resolving the real target
              // first — the same resolution `browse` itself does — closes
              // that gap regardless of whether the client happened to send
              // a `cwd`.
              workspaceEntries.resolveBrowseTarget(input).pipe(
                Effect.mapError(
                  (cause) => new FilesystemBrowseError({ message: cause.detail, cause }),
                ),
                Effect.flatMap((resolvedTarget) =>
                  // Authorize the directory that will actually be READ, which
                  // is the resolved target's parent whenever the typed text has
                  // no trailing separator — that last segment is a name prefix,
                  // not a directory. Checking the target itself let one
                  // trailing character walk around the exact-match guard:
                  // "/root/victim-app/a" is nobody's project root, so it
                  // passed, and then the listing came back from
                  // "/root/victim-app", which is somebody's. Iterating the
                  // prefix recovered their whole directory.
                  ensureWorkspaceRootNotClaimedByOtherTenant(
                    resolveBrowseListingDirectory({
                      partialPath: input.partialPath,
                      resolvedTarget,
                    }),
                    "file.read",
                    (message) => new FilesystemBrowseError({ message }),
                    "exactMatchOnly",
                  ),
                ),
                Effect.flatMap(() =>
                  input.cwd
                    ? ensureWorkspaceRoot(
                        input.cwd,
                        "file.read",
                        (message) => new FilesystemBrowseError({ message }),
                      )
                    : Effect.void,
                ),
                Effect.flatMap(() =>
                  workspaceEntries.browse(input).pipe(
                    Effect.mapError(
                      (cause) =>
                        new FilesystemBrowseError({
                          message: cause.detail,
                          cause,
                        }),
                    ),
                    Effect.flatMap(withoutOtherTenantsProjects),
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
        [WS_METHODS.gitResolveConflicts]: (input) =>
          observeRpcEffect(
            WS_METHODS.gitResolveConflicts,
            withRateLimit(
              ensureWorkspaceRoot(input.cwd, "project.edit", (message) =>
                gitRpcError(input.cwd, message),
              ).pipe(
                Effect.flatMap(() =>
                  git.resolveConflicts(input).pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
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
              ).pipe(
                Effect.tap(() =>
                  Effect.sync(() => rememberTerminalWorkspaceRoot(input.threadId, input.cwd)),
                ),
                Effect.flatMap(() => withHubCredential(input)),
                Effect.flatMap((opened) => terminalManager.open(opened)),
              ),
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
                Effect.flatMap(() => ensureTerminalThreadAccess(input, "session.prompt")),
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
              ensureTerminalThreadAccess(input, "session.view").pipe(
                Effect.flatMap(() => terminalManager.resize(input)),
              ),
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
              ensureTerminalThreadAccess(input, "session.view").pipe(
                Effect.flatMap(() => terminalManager.clear(input)),
              ),
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
              ).pipe(
                Effect.tap(() =>
                  Effect.sync(() => rememberTerminalWorkspaceRoot(input.threadId, input.cwd)),
                ),
                // A restart respawns the shell, so it needs its own fresh one —
                // the token the terminal was opened with may have expired under
                // it, and a restart is exactly when a person expects things to
                // work again.
                Effect.flatMap(() => withHubCredential(input)),
                Effect.flatMap((restarted) => terminalManager.restart(restarted)),
              ),
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
              ensureTerminalThreadAccess(input, "session.view").pipe(
                Effect.flatMap(() => terminalManager.close(input)),
                Effect.tap(() =>
                  Effect.sync(() => {
                    // Closing the last terminal for a thread ends the reason to
                    // remember where its terminals were opened.
                    if (input.terminalId === undefined) {
                      forgetTerminalWorkspaceRoot(input.threadId);
                    }
                  }),
                ),
              ),
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
                      ensureTerminalThreadAccess(event, "session.view").pipe(
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
              // This is every active session on the instance: each one's
              // subject, role, issue and expiry times, and the client block
              // with its IP address, user agent, OS, browser and the person's
              // display name — plus every pairing link, and a live feed of each
              // new sign-in as it happens. Nothing here was ever checked: the
              // only gate was the settings panel declining to subscribe unless
              // `currentSessionRole === "owner"`, which is a decision taken in
              // the browser and therefore no decision at all.
              //
              // Gated on what the UI already gated on, so nothing that works
              // today stops working: the machine's owner, and an owner-role
              // session.
              if (!machineOwnerSession && session.role !== "owner") {
                // This RPC declares no error channel — its snapshot loader
                // already `orDie`s — so a refusal travels as a failed
                // subscription rather than a typed error.
                return yield* Effect.die(
                  new AuthError({
                    message: forbiddenMessage("auth.access.view"),
                    status: 403,
                  }),
                );
              }
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
        const upgradeStartedAt = Date.now();
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
        // A browser aborts a handshake that takes too long and reports only
        // "closed before the connection is established"; say here how long
        // the server side took when it was the slow party.
        const upgradeMs = Date.now() - upgradeStartedAt;
        if (upgradeMs > 2_000) {
          yield* Effect.logWarning("websocket upgrade slow").pipe(
            Effect.annotateLogs({ upgradeMs, userId: resolveAuthenticatedUserId(session) }),
          );
        }
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
