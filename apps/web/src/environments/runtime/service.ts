import {
  type AuthSessionRole,
  EnvironmentId,
  type OrchestrationEvent,
  type OrchestrationShellSnapshot,
  type OrchestrationShellStreamEvent,
  type ServerConfig,
  type TerminalEvent,
  ThreadId,
} from "@t3tools/contracts";
import { type QueryClient } from "@tanstack/react-query";
import { Throttler } from "@tanstack/react-pacer";
import {
  createKnownEnvironment,
  getKnownEnvironmentWsBaseUrl,
  scopedThreadKey,
  scopeThreadRef,
} from "@t3tools/client-runtime";

import {
  markPromotedDraftThreadByRef,
  markPromotedDraftThreadsByRef,
  useComposerDraftStore,
} from "~/composerDraftStore";
import { ensureLocalApi } from "~/localApi";
import { collectActiveTerminalThreadIds } from "~/lib/terminalStateCleanup";
import { deriveOrchestrationBatchEffects } from "~/orchestrationEventEffects";
import { projectQueryKeys } from "~/lib/projectReactQuery";
import { providerQueryKeys } from "~/lib/providerReactQuery";
import {
  createBrowserHandoffCredential,
  getPrimaryKnownEnvironment,
  resolveSupabasePrimaryWebSocketConnectionUrl,
  subscribeSupabaseBrowserSessionChanges,
} from "../primary";
import {
  bootstrapRemoteBearerSession,
  fetchRemoteEnvironmentDescriptor,
  fetchRemoteSessionState,
  resolveRemoteWebSocketConnectionUrl,
} from "../remote/api";
import { resolveRemotePairingTarget } from "../remote/target";
import {
  chooseEnvironmentTransport,
  relayAttachWsBaseUrl,
  type DirectReachability,
} from "./relayTransport";
import {
  getSavedEnvironmentRecord,
  hasSavedEnvironmentRegistryHydrated,
  listSavedEnvironmentRecords,
  persistSavedEnvironmentRecord,
  readSavedEnvironmentBearerToken,
  removeSavedEnvironmentBearerToken,
  type SavedEnvironmentRecord,
  useSavedEnvironmentRegistryStore,
  useSavedEnvironmentRuntimeStore,
  waitForSavedEnvironmentRegistryHydration,
  writeSavedEnvironmentBearerToken,
} from "./catalog";
import { createEnvironmentConnection, type EnvironmentConnection } from "./connection";
import {
  useStore,
  selectProjectsAcrossEnvironments,
  selectSidebarThreadSummaryByRef,
  selectThreadByRef,
  selectThreadsAcrossEnvironments,
} from "~/store";
import { useTerminalStateStore } from "~/terminalStateStore";
import { useUiStateStore } from "~/uiStateStore";
import { WsTransport } from "../../rpc/wsTransport";
import { subscribeWsConnected } from "../../rpc/wsConnectionState";
import { observeClientBuildId } from "../../rpc/clientBuildFreshness";
import { createWsRpcClient, type WsRpcClient } from "../../rpc/wsRpcClient";
import { derivePhysicalProjectKey } from "../../logicalProject";

type EnvironmentServiceState = {
  readonly queryClient: QueryClient;
  readonly queryInvalidationThrottler: Throttler<() => void>;
  refCount: number;
  stop: () => void;
};

type ThreadDetailSubscriptionEntry = {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  unsubscribe: () => void;
  unsubscribeConnectionListener: (() => void) | null;
  refCount: number;
  lastAccessedAt: number;
  evictionTimeoutId: ReturnType<typeof setTimeout> | null;
  /** Which connection generation this subscription was opened on. */
  attachedEpoch: number;
};

const environmentConnections = new Map<EnvironmentId, EnvironmentConnection>();
const environmentConnectionListeners = new Set<() => void>();
const threadDetailSubscriptions = new Map<string, ThreadDetailSubscriptionEntry>();
/**
 * Bumped every time the WebSocket (re)connects. A subscription opened on an
 * older generation is dead even though its unsubscribe handle still looks live,
 * so it has to be reopened — reopening also replays the server's thread
 * snapshot, which is what repairs a view that went stale while offline.
 */
let threadSubscriptionEpoch = 0;

let activeService: EnvironmentServiceState | null = null;
let needsProviderInvalidation = false;
let primaryEnvironmentRebindPromise: Promise<void> | null = null;

// Thread detail subscription cache policy:
// - Active consumers keep a subscription retained via refCount.
// - Released subscriptions stay warm for a longer idle TTL to avoid churn
//   while moving around the UI.
// - Threads with active work or pending user action are sticky and are never
//   evicted while they remain non-idle.
// - Capacity eviction only targets idle cached subscriptions.
const THREAD_DETAIL_SUBSCRIPTION_IDLE_EVICTION_MS = 15 * 60 * 1000;
const MAX_CACHED_THREAD_DETAIL_SUBSCRIPTIONS = 32;
const NOOP = () => undefined;

function getThreadDetailSubscriptionKey(environmentId: EnvironmentId, threadId: ThreadId): string {
  return scopedThreadKey(scopeThreadRef(environmentId, threadId));
}

function clearThreadDetailSubscriptionEviction(
  entry: ThreadDetailSubscriptionEntry,
): ThreadDetailSubscriptionEntry {
  if (entry.evictionTimeoutId !== null) {
    clearTimeout(entry.evictionTimeoutId);
    entry.evictionTimeoutId = null;
  }
  return entry;
}

function isNonIdleThreadDetailSubscription(entry: ThreadDetailSubscriptionEntry): boolean {
  const threadRef = scopeThreadRef(entry.environmentId, entry.threadId);
  const state = useStore.getState();
  const sidebarThread = selectSidebarThreadSummaryByRef(state, threadRef);

  // Prefer shell/sidebar state first because it carries the coarse thread
  // readiness flags used throughout the UI (pending approvals/input/plan).
  if (sidebarThread) {
    if (
      sidebarThread.hasPendingApprovals ||
      sidebarThread.hasPendingUserInput ||
      sidebarThread.hasActionableProposedPlan
    ) {
      return true;
    }

    const orchestrationStatus = sidebarThread.session?.orchestrationStatus;
    if (
      orchestrationStatus &&
      orchestrationStatus !== "idle" &&
      orchestrationStatus !== "stopped"
    ) {
      return true;
    }

    if (sidebarThread.latestTurn?.state === "running") {
      return true;
    }
  }

  const thread = selectThreadByRef(state, threadRef);
  if (!thread) {
    return false;
  }

  const orchestrationStatus = thread.session?.orchestrationStatus;
  return (
    Boolean(
      orchestrationStatus && orchestrationStatus !== "idle" && orchestrationStatus !== "stopped",
    ) ||
    thread.latestTurn?.state === "running" ||
    thread.pendingSourceProposedPlan !== undefined
  );
}

function shouldEvictThreadDetailSubscription(entry: ThreadDetailSubscriptionEntry): boolean {
  return entry.refCount === 0 && !isNonIdleThreadDetailSubscription(entry);
}

function attachThreadDetailSubscription(entry: ThreadDetailSubscriptionEntry): boolean {
  if (entry.unsubscribeConnectionListener !== null) {
    entry.unsubscribeConnectionListener();
    entry.unsubscribeConnectionListener = null;
  }
  if (entry.unsubscribe !== NOOP) {
    if (entry.attachedEpoch === threadSubscriptionEpoch) {
      return true;
    }
    // Opened on a previous connection: drop the dead handle and reopen so the
    // server sends a fresh snapshot for everything missed while disconnected.
    try {
      entry.unsubscribe();
    } catch {
      // the old socket is gone; nothing to clean up
    }
    entry.unsubscribe = NOOP;
  }

  const connection = readEnvironmentConnection(entry.environmentId);
  if (!connection) {
    return false;
  }

  entry.attachedEpoch = threadSubscriptionEpoch;
  entry.unsubscribe = connection.client.orchestration.subscribeThread(
    { threadId: entry.threadId },
    (item) => {
      if (item.kind === "snapshot") {
        useStore.getState().syncServerThreadDetail(item.snapshot.thread, entry.environmentId);
        return;
      }
      applyEnvironmentThreadDetailEvent(item.event, entry.environmentId);
    },
  );
  return true;
}

function watchThreadDetailSubscriptionConnection(entry: ThreadDetailSubscriptionEntry): void {
  if (entry.unsubscribeConnectionListener !== null) {
    return;
  }

  entry.unsubscribeConnectionListener = subscribeEnvironmentConnections(() => {
    if (attachThreadDetailSubscription(entry)) {
      entry.lastAccessedAt = Date.now();
    }
  });
  attachThreadDetailSubscription(entry);
}

function disposeThreadDetailSubscriptionByKey(key: string): boolean {
  const entry = threadDetailSubscriptions.get(key);
  if (!entry) {
    return false;
  }

  clearThreadDetailSubscriptionEviction(entry);
  entry.unsubscribeConnectionListener?.();
  entry.unsubscribeConnectionListener = null;
  threadDetailSubscriptions.delete(key);
  entry.unsubscribe();
  entry.unsubscribe = NOOP;
  return true;
}

function disposeThreadDetailSubscriptionsForEnvironment(environmentId: EnvironmentId): void {
  for (const [key, entry] of threadDetailSubscriptions) {
    if (entry.environmentId === environmentId) {
      disposeThreadDetailSubscriptionByKey(key);
    }
  }
}

function reconcileThreadDetailSubscriptionsForEnvironment(
  environmentId: EnvironmentId,
  threadIds: ReadonlyArray<ThreadId>,
): void {
  const activeThreadIds = new Set(threadIds);
  for (const [key, entry] of threadDetailSubscriptions) {
    if (entry.environmentId === environmentId && !activeThreadIds.has(entry.threadId)) {
      disposeThreadDetailSubscriptionByKey(key);
    }
  }
}

function scheduleThreadDetailSubscriptionEviction(entry: ThreadDetailSubscriptionEntry): void {
  clearThreadDetailSubscriptionEviction(entry);
  if (!shouldEvictThreadDetailSubscription(entry)) {
    return;
  }

  entry.evictionTimeoutId = setTimeout(() => {
    const currentEntry = threadDetailSubscriptions.get(
      getThreadDetailSubscriptionKey(entry.environmentId, entry.threadId),
    );
    if (!currentEntry) {
      return;
    }

    currentEntry.evictionTimeoutId = null;
    if (!shouldEvictThreadDetailSubscription(currentEntry)) {
      return;
    }
    disposeThreadDetailSubscriptionByKey(
      getThreadDetailSubscriptionKey(entry.environmentId, entry.threadId),
    );
  }, THREAD_DETAIL_SUBSCRIPTION_IDLE_EVICTION_MS);
}

function evictIdleThreadDetailSubscriptionsToCapacity(): void {
  if (threadDetailSubscriptions.size <= MAX_CACHED_THREAD_DETAIL_SUBSCRIPTIONS) {
    return;
  }

  const idleEntries = [...threadDetailSubscriptions.entries()]
    .filter(([, entry]) => shouldEvictThreadDetailSubscription(entry))
    .toSorted(([, left], [, right]) => left.lastAccessedAt - right.lastAccessedAt);

  for (const [key] of idleEntries) {
    if (threadDetailSubscriptions.size <= MAX_CACHED_THREAD_DETAIL_SUBSCRIPTIONS) {
      return;
    }
    disposeThreadDetailSubscriptionByKey(key);
  }

  // The ceiling was not a ceiling. `shouldEvictThreadDetailSubscription`
  // refuses to evict a thread whose session is still doing something, so a
  // person moving between more than `MAX_CACHED_THREAD_DETAIL_SUBSCRIPTIONS`
  // busy threads accumulated live subscriptions and their store state without
  // any bound — the reported "long chats, you jump between them again and
  // again, it crashes and you get disconnected". The cap has to hold even when
  // every candidate is busy.
  //
  // Only entries nobody is holding (`refCount === 0`) are taken, least recently
  // used first: a thread on screen is never dropped out from under its viewer.
  // What a dropped background thread loses is live updates while it is closed,
  // and reopening it resubscribes and takes a fresh snapshot — which is the
  // same recovery a reconnect already performs, so the path is well travelled.
  const releasedEntries = [...threadDetailSubscriptions.entries()]
    .filter(([, entry]) => entry.refCount === 0)
    .toSorted(([, left], [, right]) => left.lastAccessedAt - right.lastAccessedAt);

  for (const [key] of releasedEntries) {
    if (threadDetailSubscriptions.size <= MAX_CACHED_THREAD_DETAIL_SUBSCRIPTIONS) {
      return;
    }
    disposeThreadDetailSubscriptionByKey(key);
  }
}

function reconcileThreadDetailSubscriptionEvictionState(
  entry: ThreadDetailSubscriptionEntry,
): void {
  clearThreadDetailSubscriptionEviction(entry);
  if (!shouldEvictThreadDetailSubscription(entry)) {
    return;
  }

  scheduleThreadDetailSubscriptionEviction(entry);
}

function reconcileThreadDetailSubscriptionEvictionForThread(
  environmentId: EnvironmentId,
  threadId: ThreadId,
): void {
  const entry = threadDetailSubscriptions.get(
    getThreadDetailSubscriptionKey(environmentId, threadId),
  );
  if (!entry) {
    return;
  }

  reconcileThreadDetailSubscriptionEvictionState(entry);
}

function reconcileThreadDetailSubscriptionEvictionForEnvironment(
  environmentId: EnvironmentId,
): void {
  for (const entry of threadDetailSubscriptions.values()) {
    if (entry.environmentId === environmentId) {
      reconcileThreadDetailSubscriptionEvictionState(entry);
    }
  }
  evictIdleThreadDetailSubscriptionsToCapacity();
}

export function retainThreadDetailSubscription(
  environmentId: EnvironmentId,
  threadId: ThreadId,
): () => void {
  const key = getThreadDetailSubscriptionKey(environmentId, threadId);
  const existing = threadDetailSubscriptions.get(key);
  if (existing) {
    clearThreadDetailSubscriptionEviction(existing);
    existing.refCount += 1;
    existing.lastAccessedAt = Date.now();
    if (!attachThreadDetailSubscription(existing)) {
      watchThreadDetailSubscriptionConnection(existing);
    }
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      existing.refCount = Math.max(0, existing.refCount - 1);
      existing.lastAccessedAt = Date.now();
      if (existing.refCount === 0) {
        reconcileThreadDetailSubscriptionEvictionState(existing);
        evictIdleThreadDetailSubscriptionsToCapacity();
      }
    };
  }

  const entry: ThreadDetailSubscriptionEntry = {
    environmentId,
    threadId,
    unsubscribe: NOOP,
    unsubscribeConnectionListener: null,
    refCount: 1,
    lastAccessedAt: Date.now(),
    evictionTimeoutId: null,
    attachedEpoch: -1,
  };
  threadDetailSubscriptions.set(key, entry);
  if (!attachThreadDetailSubscription(entry)) {
    watchThreadDetailSubscriptionConnection(entry);
  }
  evictIdleThreadDetailSubscriptionsToCapacity();

  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    entry.refCount = Math.max(0, entry.refCount - 1);
    entry.lastAccessedAt = Date.now();
    if (entry.refCount === 0) {
      reconcileThreadDetailSubscriptionEvictionState(entry);
      evictIdleThreadDetailSubscriptionsToCapacity();
    }
  };
}

function emitEnvironmentConnectionRegistryChange() {
  for (const listener of environmentConnectionListeners) {
    listener();
  }
}

function getRuntimeErrorFields(error: unknown) {
  return {
    lastError: error instanceof Error ? error.message : String(error),
    lastErrorAt: new Date().toISOString(),
  } as const;
}

function isoNow(): string {
  return new Date().toISOString();
}

function setRuntimeConnecting(environmentId: EnvironmentId) {
  useSavedEnvironmentRuntimeStore.getState().patch(environmentId, {
    connectionState: "connecting",
    lastError: null,
    lastErrorAt: null,
  });
}

function setRuntimeConnected(environmentId: EnvironmentId) {
  const connectedAt = isoNow();
  useSavedEnvironmentRuntimeStore.getState().patch(environmentId, {
    connectionState: "connected",
    authState: "authenticated",
    connectedAt,
    disconnectedAt: null,
    lastError: null,
    lastErrorAt: null,
  });
  useSavedEnvironmentRegistryStore.getState().markConnected(environmentId, connectedAt);
}

function setRuntimeDisconnected(environmentId: EnvironmentId, reason?: string | null) {
  useSavedEnvironmentRuntimeStore.getState().patch(environmentId, {
    connectionState: "disconnected",
    disconnectedAt: isoNow(),
    ...(reason && reason.trim().length > 0
      ? {
          lastError: reason,
          lastErrorAt: isoNow(),
        }
      : {}),
  });
}

function setRuntimeError(environmentId: EnvironmentId, error: unknown) {
  useSavedEnvironmentRuntimeStore.getState().patch(environmentId, {
    connectionState: "error",
    ...getRuntimeErrorFields(error),
  });
}

function coalesceOrchestrationUiEvents(
  events: ReadonlyArray<OrchestrationEvent>,
): OrchestrationEvent[] {
  if (events.length < 2) {
    return [...events];
  }

  const coalesced: OrchestrationEvent[] = [];
  for (const event of events) {
    const previous = coalesced.at(-1);
    if (
      previous?.type === "thread.message-sent" &&
      event.type === "thread.message-sent" &&
      previous.payload.threadId === event.payload.threadId &&
      previous.payload.messageId === event.payload.messageId
    ) {
      coalesced[coalesced.length - 1] = {
        ...event,
        payload: {
          ...event.payload,
          attachments: event.payload.attachments ?? previous.payload.attachments,
          createdAt: previous.payload.createdAt,
          text:
            !event.payload.streaming && event.payload.text.length > 0
              ? event.payload.text
              : previous.payload.text + event.payload.text,
        },
      };
      continue;
    }

    coalesced.push(event);
  }

  return coalesced;
}

function syncProjectUiFromStore() {
  const projects = selectProjectsAcrossEnvironments(useStore.getState());
  useUiStateStore.getState().syncProjects(
    projects.map((project) => ({
      key: derivePhysicalProjectKey(project),
      cwd: project.cwd,
    })),
  );
}

function syncThreadUiFromStore() {
  const threads = selectThreadsAcrossEnvironments(useStore.getState());
  useUiStateStore.getState().syncThreads(
    threads.map((thread) => ({
      key: scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
      seedVisitedAt: thread.updatedAt ?? thread.createdAt,
    })),
  );
  markPromotedDraftThreadsByRef(
    threads.map((thread) => scopeThreadRef(thread.environmentId, thread.id)),
  );
}

function reconcileSnapshotDerivedState() {
  syncProjectUiFromStore();
  syncThreadUiFromStore();

  const threads = selectThreadsAcrossEnvironments(useStore.getState());
  const activeThreadKeys = collectActiveTerminalThreadIds({
    snapshotThreads: threads.map((thread) => ({
      key: scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
      deletedAt: null,
      archivedAt: thread.archivedAt,
    })),
    draftThreadKeys: useComposerDraftStore.getState().listDraftThreadKeys(),
  });
  useTerminalStateStore.getState().removeOrphanedTerminalStates(activeThreadKeys);
}

export function shouldApplyTerminalEvent(input: {
  serverThreadArchivedAt: string | null | undefined;
  hasDraftThread: boolean;
}): boolean {
  if (input.serverThreadArchivedAt !== undefined) {
    return input.serverThreadArchivedAt === null;
  }

  return input.hasDraftThread;
}

function applyRecoveredEventBatch(
  events: ReadonlyArray<OrchestrationEvent>,
  environmentId: EnvironmentId,
) {
  if (events.length === 0) {
    return;
  }

  const batchEffects = deriveOrchestrationBatchEffects(events);
  const uiEvents = coalesceOrchestrationUiEvents(events);
  const needsProjectUiSync = events.some(
    (event) =>
      event.type === "project.created" ||
      event.type === "project.meta-updated" ||
      event.type === "project.deleted",
  );

  if (batchEffects.needsProviderInvalidation) {
    needsProviderInvalidation = true;
    void activeService?.queryInvalidationThrottler.maybeExecute();
  }

  useStore.getState().applyOrchestrationEvents(uiEvents, environmentId);
  if (needsProjectUiSync) {
    const projects = selectProjectsAcrossEnvironments(useStore.getState());
    useUiStateStore.getState().syncProjects(
      projects.map((project) => ({
        key: derivePhysicalProjectKey(project),
        cwd: project.cwd,
      })),
    );
  }

  const needsThreadUiSync = events.some(
    (event) => event.type === "thread.created" || event.type === "thread.deleted",
  );
  if (needsThreadUiSync) {
    const threads = selectThreadsAcrossEnvironments(useStore.getState());
    useUiStateStore.getState().syncThreads(
      threads.map((thread) => ({
        key: scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
        seedVisitedAt: thread.updatedAt ?? thread.createdAt,
      })),
    );
  }

  const draftStore = useComposerDraftStore.getState();
  for (const threadId of batchEffects.promoteDraftThreadIds) {
    markPromotedDraftThreadByRef(scopeThreadRef(environmentId, threadId));
  }
  for (const threadId of batchEffects.clearDeletedThreadIds) {
    draftStore.clearDraftThread(scopeThreadRef(environmentId, threadId));
    useUiStateStore
      .getState()
      .clearThreadUi(scopedThreadKey(scopeThreadRef(environmentId, threadId)));
  }
  for (const threadId of batchEffects.removeTerminalStateThreadIds) {
    useTerminalStateStore.getState().removeTerminalState(scopeThreadRef(environmentId, threadId));
  }

  reconcileThreadDetailSubscriptionEvictionForEnvironment(environmentId);
}

export function applyEnvironmentThreadDetailEvent(
  event: OrchestrationEvent,
  environmentId: EnvironmentId,
) {
  applyRecoveredEventBatch([event], environmentId);
}

function applyShellEvent(event: OrchestrationShellStreamEvent, environmentId: EnvironmentId) {
  const threadId =
    event.kind === "thread-upserted"
      ? event.thread.id
      : event.kind === "thread-removed"
        ? event.threadId
        : null;
  const threadRef = threadId ? scopeThreadRef(environmentId, threadId) : null;
  const previousThread = threadRef ? selectThreadByRef(useStore.getState(), threadRef) : undefined;

  useStore.getState().applyShellEvent(event, environmentId);

  switch (event.kind) {
    case "project-upserted":
    case "project-removed":
      syncProjectUiFromStore();
      return;
    case "thread-upserted":
      syncThreadUiFromStore();
      if (!previousThread && threadRef) {
        markPromotedDraftThreadByRef(threadRef);
      }
      if (previousThread?.archivedAt === null && event.thread.archivedAt !== null && threadRef) {
        useTerminalStateStore.getState().removeTerminalState(threadRef);
      }
      reconcileThreadDetailSubscriptionEvictionForThread(environmentId, event.thread.id);
      evictIdleThreadDetailSubscriptionsToCapacity();
      return;
    case "thread-removed":
      if (threadRef) {
        disposeThreadDetailSubscriptionByKey(scopedThreadKey(threadRef));
        useComposerDraftStore.getState().clearDraftThread(threadRef);
        useUiStateStore.getState().clearThreadUi(scopedThreadKey(threadRef));
        useTerminalStateStore.getState().removeTerminalState(threadRef);
      }
      syncThreadUiFromStore();
      return;
  }
}

function createEnvironmentConnectionHandlers() {
  return {
    applyShellEvent,
    syncShellSnapshot: (snapshot: OrchestrationShellSnapshot, environmentId: EnvironmentId) => {
      useStore.getState().syncServerShellSnapshot(snapshot, environmentId);
      reconcileThreadDetailSubscriptionsForEnvironment(
        environmentId,
        snapshot.threads.map((thread) => thread.id),
      );
      reconcileThreadDetailSubscriptionEvictionForEnvironment(environmentId);
      reconcileSnapshotDerivedState();
    },
    applyTerminalEvent: (event: TerminalEvent, environmentId: EnvironmentId) => {
      const threadRef = scopeThreadRef(environmentId, ThreadId.make(event.threadId));
      const serverThread = selectThreadByRef(useStore.getState(), threadRef);
      const hasDraftThread =
        useComposerDraftStore.getState().getDraftThreadByRef(threadRef) !== null;
      if (
        !shouldApplyTerminalEvent({
          serverThreadArchivedAt: serverThread?.archivedAt,
          hasDraftThread,
        })
      ) {
        return;
      }
      useTerminalStateStore.getState().applyTerminalEvent(threadRef, event);
    },
  };
}

function createPrimaryEnvironmentClient(
  knownEnvironment: ReturnType<typeof getPrimaryKnownEnvironment>,
) {
  const wsBaseUrl = getKnownEnvironmentWsBaseUrl(knownEnvironment);
  if (!wsBaseUrl) {
    throw new Error(
      `Unable to resolve websocket URL for ${knownEnvironment?.label ?? "primary environment"}.`,
    );
  }

  return createWsRpcClient(
    new WsTransport(() => resolveSupabasePrimaryWebSocketConnectionUrl(wsBaseUrl)),
  );
}

/**
 * Which way to reach this environment, decided fresh on every socket.
 *
 * Re-decided rather than captured once because reconnection is exactly when the
 * answer changes: the laptop that was on the same LAN this morning is on a
 * train now. `chooseEnvironmentTransport` owns the rule; this owns only the
 * probe it needs and the bookkeeping afterwards.
 *
 * An environment with no relay never reaches the probe at all, so nothing about
 * the direct path — which is every environment that exists today — gains a
 * request or a failure mode it did not have.
 */
async function resolveSavedEnvironmentSocketUrl(
  record: SavedEnvironmentRecord,
  bearerToken: string,
): Promise<string> {
  const relay = record.relay ? { ...record.relay, environmentId: record.environmentId } : null;
  // A machine enrolled through the portal has no address of its own: its record
  // carries the hub as a placeholder. Probing the hub would find the hub — and
  // connect to the wrong environment — so such a record is relayed only.
  const direct =
    relay !== null && record.httpBaseUrl === relay.hubHttpBaseUrl
      ? null
      : { httpBaseUrl: record.httpBaseUrl, wsBaseUrl: record.wsBaseUrl };

  const chosen = chooseEnvironmentTransport({
    direct,
    relay,
    directReachability:
      relay === null
        ? // Nothing to fall back to, so nothing is learned by asking. The probe
          // would only add a round trip in front of every connection this app
          // has ever made.
          "unknown"
        : await probeDirectEnvironment(record.httpBaseUrl),
  });

  if (chosen.outcome === "unreachable") {
    throw new Error(`Saved environment ${record.label} has no address and no relay.`);
  }

  useSavedEnvironmentRuntimeStore.getState().patch(record.environmentId, {
    transport: chosen.transport,
  });

  return resolveRemoteWebSocketConnectionUrl({
    wsBaseUrl:
      chosen.transport === "relayed" && relay !== null
        ? relayAttachWsBaseUrl(relay)
        : record.wsBaseUrl,
    // A relayed connection authenticates to the hub, so its websocket token has
    // to be minted there. Minting it against an address that does not answer is
    // how a fallback ends up failing for the reason it was meant to route around.
    httpBaseUrl:
      chosen.transport === "relayed" && relay !== null ? relay.hubHttpBaseUrl : record.httpBaseUrl,
    bearerToken,
  });
}

/**
 * Whether the environment answers on its own address, right now.
 *
 * Deliberately cheap and deliberately unauthenticated: `/.well-known/t3/environment`
 * is the one endpoint that exists to say "something is here", and the question
 * being asked is only whether a direct socket is worth attempting. A failure is
 * "unreachable" and never an error — falling back is the entire point.
 */
async function probeDirectEnvironment(httpBaseUrl: string): Promise<DirectReachability> {
  try {
    await fetchRemoteEnvironmentDescriptor({ httpBaseUrl });
    return "reachable";
  } catch {
    return "unreachable";
  }
}

function createSavedEnvironmentClient(
  record: SavedEnvironmentRecord,
  bearerToken: string,
): WsRpcClient {
  useSavedEnvironmentRuntimeStore.getState().ensure(record.environmentId);

  return createWsRpcClient(
    new WsTransport(() => resolveSavedEnvironmentSocketUrl(record, bearerToken), {
      onAttempt: () => {
        setRuntimeConnecting(record.environmentId);
      },
      onOpen: () => {
        setRuntimeConnected(record.environmentId);
      },
      onError: (message: string) => {
        useSavedEnvironmentRuntimeStore.getState().patch(record.environmentId, {
          connectionState: "error",
          lastError: message,
          lastErrorAt: isoNow(),
        });
      },
      onClose: (details: { readonly code: number; readonly reason: string }) => {
        setRuntimeDisconnected(record.environmentId, details.reason);
      },
    }),
  );
}

async function refreshSavedEnvironmentMetadata(
  record: SavedEnvironmentRecord,
  bearerToken: string,
  client: WsRpcClient,
  roleHint?: AuthSessionRole | null,
  configHint?: ServerConfig | null,
): Promise<void> {
  const [serverConfig, sessionState] = await Promise.all([
    configHint ? Promise.resolve(configHint) : client.server.getConfig(),
    fetchRemoteSessionState({
      httpBaseUrl: record.httpBaseUrl,
      bearerToken,
    }),
  ]);

  useSavedEnvironmentRuntimeStore.getState().patch(record.environmentId, {
    authState: sessionState.authenticated ? "authenticated" : "requires-auth",
    descriptor: serverConfig.environment,
    serverConfig,
    role: sessionState.authenticated ? (sessionState.role ?? roleHint ?? null) : null,
  });
}

function registerConnection(connection: EnvironmentConnection): EnvironmentConnection {
  const existing = environmentConnections.get(connection.environmentId);
  if (existing && existing !== connection) {
    throw new Error(`Environment ${connection.environmentId} already has an active connection.`);
  }
  environmentConnections.set(connection.environmentId, connection);
  emitEnvironmentConnectionRegistryChange();
  return connection;
}

async function removeConnection(environmentId: EnvironmentId): Promise<boolean> {
  const connection = environmentConnections.get(environmentId);
  if (!connection) {
    return false;
  }

  disposeThreadDetailSubscriptionsForEnvironment(environmentId);
  environmentConnections.delete(environmentId);
  emitEnvironmentConnectionRegistryChange();
  await connection.dispose();
  return true;
}

function createPrimaryEnvironmentConnection(): EnvironmentConnection {
  const knownEnvironment = getPrimaryKnownEnvironment();
  if (!knownEnvironment?.environmentId) {
    throw new Error("Unable to resolve the primary environment.");
  }

  const existing = environmentConnections.get(knownEnvironment.environmentId);
  if (existing) {
    return existing;
  }

  return registerConnection(
    createEnvironmentConnection({
      kind: "primary",
      knownEnvironment,
      client: createPrimaryEnvironmentClient(knownEnvironment),
      onConfigSnapshot: (config) => {
        observeClientBuildId(config.environment.clientBuildId);
      },
      ...createEnvironmentConnectionHandlers(),
    }),
  );
}

async function ensureSavedEnvironmentConnection(
  record: SavedEnvironmentRecord,
  options?: {
    readonly client?: WsRpcClient;
    readonly bearerToken?: string;
    readonly role?: AuthSessionRole | null;
    readonly serverConfig?: ServerConfig | null;
  },
): Promise<EnvironmentConnection> {
  const existing = environmentConnections.get(record.environmentId);
  if (existing) {
    return existing;
  }

  const bearerToken =
    options?.bearerToken ?? (await readSavedEnvironmentBearerToken(record.environmentId));
  if (!bearerToken) {
    useSavedEnvironmentRuntimeStore.getState().patch(record.environmentId, {
      authState: "requires-auth",
      role: null,
      connectionState: "disconnected",
      lastError: "Saved environment is missing its saved credential. Pair it again.",
      lastErrorAt: isoNow(),
    });
    throw new Error("Saved environment is missing its saved credential.");
  }

  const client = options?.client ?? createSavedEnvironmentClient(record, bearerToken);
  const knownEnvironment = createKnownEnvironment({
    id: record.environmentId,
    label: record.label,
    source: "manual",
    target: {
      httpBaseUrl: record.httpBaseUrl,
      wsBaseUrl: record.wsBaseUrl,
    },
  });
  const connection = createEnvironmentConnection({
    kind: "saved",
    knownEnvironment: {
      ...knownEnvironment,
      environmentId: record.environmentId,
    },
    client,
    refreshMetadata: async () => {
      await refreshSavedEnvironmentMetadata(record, bearerToken, client);
    },
    onConfigSnapshot: (config) => {
      observeClientBuildId(config.environment.clientBuildId);
      useSavedEnvironmentRuntimeStore.getState().patch(record.environmentId, {
        descriptor: config.environment,
        serverConfig: config,
      });
    },
    onWelcome: (payload) => {
      useSavedEnvironmentRuntimeStore.getState().patch(record.environmentId, {
        descriptor: payload.environment,
      });
    },
    ...createEnvironmentConnectionHandlers(),
  });

  registerConnection(connection);

  try {
    await refreshSavedEnvironmentMetadata(
      record,
      bearerToken,
      client,
      options?.role ?? null,
      options?.serverConfig ?? null,
    );
    return connection;
  } catch (error) {
    setRuntimeError(record.environmentId, error);
    await removeConnection(record.environmentId).catch(() => false);
    throw error;
  }
}

async function syncSavedEnvironmentConnections(
  records: ReadonlyArray<SavedEnvironmentRecord>,
): Promise<void> {
  const expectedEnvironmentIds = new Set(records.map((record) => record.environmentId));
  const staleEnvironmentIds = [...environmentConnections.values()]
    .filter((connection) => connection.kind === "saved")
    .map((connection) => connection.environmentId)
    .filter((environmentId) => !expectedEnvironmentIds.has(environmentId));

  await Promise.all(
    staleEnvironmentIds.map((environmentId) => disconnectSavedEnvironment(environmentId)),
  );
  await Promise.all(
    records.map((record) => ensureSavedEnvironmentConnection(record).catch(() => undefined)),
  );
}

function stopActiveService() {
  activeService?.stop();
  activeService = null;
}

export function subscribeEnvironmentConnections(listener: () => void): () => void {
  environmentConnectionListeners.add(listener);
  return () => {
    environmentConnectionListeners.delete(listener);
  };
}

export function listEnvironmentConnections(): ReadonlyArray<EnvironmentConnection> {
  return [...environmentConnections.values()];
}

export function readEnvironmentConnection(
  environmentId: EnvironmentId,
): EnvironmentConnection | null {
  return environmentConnections.get(environmentId) ?? null;
}

export function requireEnvironmentConnection(environmentId: EnvironmentId): EnvironmentConnection {
  const connection = readEnvironmentConnection(environmentId);
  if (!connection) {
    throw new Error(`No websocket client registered for environment ${environmentId}.`);
  }
  return connection;
}

export function getPrimaryEnvironmentConnection(): EnvironmentConnection {
  return createPrimaryEnvironmentConnection();
}

export function rebindPrimaryEnvironmentConnection(): Promise<void> {
  if (primaryEnvironmentRebindPromise) {
    return primaryEnvironmentRebindPromise;
  }

  const rebindPromise = (async () => {
    const knownEnvironment = getPrimaryKnownEnvironment();
    if (!knownEnvironment?.environmentId) {
      throw new Error("Unable to resolve the primary environment.");
    }

    await removeConnection(knownEnvironment.environmentId).catch(() => false);
    createPrimaryEnvironmentConnection();
  })();

  const trackedPromise = rebindPromise.finally(() => {
    if (primaryEnvironmentRebindPromise === trackedPromise) {
      primaryEnvironmentRebindPromise = null;
    }
  });
  primaryEnvironmentRebindPromise = trackedPromise;

  return primaryEnvironmentRebindPromise;
}

export async function disconnectSavedEnvironment(environmentId: EnvironmentId): Promise<void> {
  const connection = environmentConnections.get(environmentId);
  if (connection?.kind !== "saved") {
    return;
  }

  useSavedEnvironmentRuntimeStore.getState().clear(environmentId);
  await removeConnection(environmentId).catch(() => false);
}

export async function reconnectSavedEnvironment(environmentId: EnvironmentId): Promise<void> {
  const record = getSavedEnvironmentRecord(environmentId);
  if (!record) {
    throw new Error("Saved environment not found.");
  }

  const connection = environmentConnections.get(environmentId);
  if (!connection) {
    await ensureSavedEnvironmentConnection(record);
    return;
  }

  setRuntimeConnecting(environmentId);
  try {
    await connection.reconnect();
  } catch (error) {
    setRuntimeError(environmentId, error);
    throw error;
  }
}

export async function removeSavedEnvironment(environmentId: EnvironmentId): Promise<void> {
  useSavedEnvironmentRegistryStore.getState().remove(environmentId);
  await removeSavedEnvironmentBearerToken(environmentId);
  await disconnectSavedEnvironment(environmentId);
}

export async function addSavedEnvironment(input: {
  readonly label: string;
  readonly pairingUrl?: string;
  readonly host?: string;
  readonly pairingCode?: string;
}): Promise<SavedEnvironmentRecord> {
  const resolvedTarget = resolveRemotePairingTarget({
    ...(input.pairingUrl !== undefined ? { pairingUrl: input.pairingUrl } : {}),
    ...(input.host !== undefined ? { host: input.host } : {}),
    ...(input.pairingCode !== undefined ? { pairingCode: input.pairingCode } : {}),
  });
  const descriptor = await fetchRemoteEnvironmentDescriptor({
    httpBaseUrl: resolvedTarget.httpBaseUrl,
  });
  const environmentId = descriptor.environmentId;

  if (environmentConnections.has(environmentId)) {
    throw new Error("This environment is already connected.");
  }

  const bearerSession = await bootstrapRemoteBearerSession({
    httpBaseUrl: resolvedTarget.httpBaseUrl,
    credential: resolvedTarget.credential,
  });

  const record: SavedEnvironmentRecord = {
    environmentId,
    label: input.label.trim() || descriptor.label,
    wsBaseUrl: resolvedTarget.wsBaseUrl,
    httpBaseUrl: resolvedTarget.httpBaseUrl,
    createdAt: isoNow(),
    lastConnectedAt: isoNow(),
  };

  await persistSavedEnvironmentRecord(record);
  const didPersistBearerToken = await writeSavedEnvironmentBearerToken(
    environmentId,
    bearerSession.sessionToken,
  );
  if (!didPersistBearerToken) {
    await ensureLocalApi().persistence.setSavedEnvironmentRegistry(
      listSavedEnvironmentRecords().map((entry) => ({
        environmentId: entry.environmentId,
        label: entry.label,
        httpBaseUrl: entry.httpBaseUrl,
        wsBaseUrl: entry.wsBaseUrl,
        createdAt: entry.createdAt,
        lastConnectedAt: entry.lastConnectedAt,
      })),
    );
    throw new Error("Unable to persist saved environment credentials.");
  }
  await ensureSavedEnvironmentConnection(record, {
    bearerToken: bearerSession.sessionToken,
    role: bearerSession.role,
  });
  useSavedEnvironmentRegistryStore.getState().upsert(record);
  return record;
}

/**
 * Saves and connects a machine that reaches this browser only through the
 * portal's relay: one enrolled from the Connect page, which claimed
 * `environmentId` when its app dialled in. The browser authenticates to the
 * hub with a credential standing in for its own session, so nothing is typed.
 */
export async function addRelayedEnvironment(input: {
  readonly environmentId: string;
  readonly label: string;
  readonly hubHttpBaseUrl: string;
}): Promise<SavedEnvironmentRecord> {
  const environmentId = EnvironmentId.make(input.environmentId);
  if (environmentConnections.has(environmentId)) {
    throw new Error("This environment is already connected.");
  }
  const hub = new URL(input.hubHttpBaseUrl);
  const hubWs = new URL(hub.toString());
  hubWs.protocol = hubWs.protocol === "https:" ? "wss:" : "ws:";
  const handoff = await createBrowserHandoffCredential();
  const bearerSession = await bootstrapRemoteBearerSession({
    httpBaseUrl: hub.origin,
    credential: handoff.credential,
  });
  const record: SavedEnvironmentRecord = {
    environmentId,
    label: input.label.trim() || environmentId,
    // The hub as placeholder marks the record relay-only; see `resolveSavedEnvironmentWsUrl`.
    httpBaseUrl: hub.origin,
    wsBaseUrl: hubWs.origin,
    createdAt: isoNow(),
    lastConnectedAt: null,
    relay: { hubHttpBaseUrl: hub.origin },
  };
  await persistSavedEnvironmentRecord(record);
  const didPersistBearerToken = await writeSavedEnvironmentBearerToken(
    environmentId,
    bearerSession.sessionToken,
  );
  if (!didPersistBearerToken) {
    throw new Error("Unable to persist saved environment credentials.");
  }
  await ensureSavedEnvironmentConnection(record, {
    bearerToken: bearerSession.sessionToken,
    role: bearerSession.role,
  });
  useSavedEnvironmentRegistryStore.getState().upsert(record);
  return record;
}

export async function ensureEnvironmentConnectionBootstrapped(
  environmentId: EnvironmentId,
): Promise<void> {
  await environmentConnections.get(environmentId)?.ensureBootstrapped();
}

export function startEnvironmentConnectionService(queryClient: QueryClient): () => void {
  if (activeService?.queryClient === queryClient) {
    activeService.refCount += 1;
    return () => {
      if (!activeService || activeService.queryClient !== queryClient) {
        return;
      }
      activeService.refCount -= 1;
      if (activeService.refCount === 0) {
        stopActiveService();
      }
    };
  }

  stopActiveService();
  needsProviderInvalidation = false;
  const queryInvalidationThrottler = new Throttler(
    () => {
      if (!needsProviderInvalidation) {
        return;
      }
      needsProviderInvalidation = false;
      void queryClient.invalidateQueries({ queryKey: providerQueryKeys.all });
      void queryClient.invalidateQueries({ queryKey: projectQueryKeys.all });
    },
    {
      wait: 100,
      leading: false,
      trailing: true,
    },
  );

  createPrimaryEnvironmentConnection();

  const unsubscribeWsConnected = subscribeWsConnected(() => {
    threadSubscriptionEpoch += 1;
    for (const entry of [...threadDetailSubscriptions.values()]) {
      attachThreadDetailSubscription(entry);
    }
    // The primary `subscribeShell` subscription (session.orchestrationStatus,
    // latestTurn, the fields the "Working…" indicator is actually keyed off)
    // gets the exact same treatment as thread-detail subscriptions above —
    // otherwise a raw socket reconnect that this subscription's own stream
    // didn't independently notice leaves a turn that finished while offline
    // showing "Still waiting" forever, even though the assistant's message
    // itself already arrived correctly via the (already-hardened) detail
    // subscription. Confirmed live: exactly this split was observed in
    // production — real response persisted, banner never cleared.
    for (const connection of [...environmentConnections.values()]) {
      connection.resubscribeShell();
      connection.resubscribeConfig();
    }
    needsProviderInvalidation = true;
    void queryInvalidationThrottler.maybeExecute();
  });

  const unsubscribeSavedEnvironments = useSavedEnvironmentRegistryStore.subscribe(() => {
    if (!hasSavedEnvironmentRegistryHydrated()) {
      return;
    }
    void syncSavedEnvironmentConnections(listSavedEnvironmentRecords());
  });
  const unsubscribeSupabaseBrowserSessionChanges = subscribeSupabaseBrowserSessionChanges(() => {
    void rebindPrimaryEnvironmentConnection()
      .then(() => {
        void queryClient.invalidateQueries({ queryKey: providerQueryKeys.all });
        void queryClient.invalidateQueries({ queryKey: projectQueryKeys.all });
      })
      .catch(() => undefined);
  });

  void waitForSavedEnvironmentRegistryHydration()
    .then(() => syncSavedEnvironmentConnections(listSavedEnvironmentRecords()))
    .catch(() => undefined);

  activeService = {
    queryClient,
    queryInvalidationThrottler,
    refCount: 1,
    stop: () => {
      unsubscribeWsConnected();
      unsubscribeSavedEnvironments();
      unsubscribeSupabaseBrowserSessionChanges();
      queryInvalidationThrottler.cancel();
    },
  };

  return () => {
    if (!activeService || activeService.queryClient !== queryClient) {
      return;
    }
    activeService.refCount -= 1;
    if (activeService.refCount === 0) {
      stopActiveService();
    }
  };
}

export async function resetEnvironmentServiceForTests(): Promise<void> {
  stopActiveService();
  for (const key of Array.from(threadDetailSubscriptions.keys())) {
    disposeThreadDetailSubscriptionByKey(key);
  }
  await Promise.all(
    [...environmentConnections.keys()].map((environmentId) => removeConnection(environmentId)),
  );
  primaryEnvironmentRebindPromise = null;
}
