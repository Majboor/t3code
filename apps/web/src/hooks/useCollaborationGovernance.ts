import type {
  CollaborationApprovalMode,
  CollaborationBranchClaim,
  CollaborationFileTouch,
  CollaborationPromptApproval,
  CollaborationStreamEvent,
  CollaborationViewPreferences,
  CollaborationWorkspaceSettings,
  EnvironmentId,
  TenantId,
  WorkspaceId,
} from "@t3tools/contracts";
import { useCallback, useMemo, useSyncExternalStore } from "react";

import { readEnvironmentApi } from "../environmentApi";

export interface CollaborationGovernance {
  readonly settings: CollaborationWorkspaceSettings | null;
  /** Whether this person may change the approval mode or the approver list. */
  readonly canManage: boolean;
  readonly approvals: readonly CollaborationPromptApproval[];
  readonly pendingApprovals: readonly CollaborationPromptApproval[];
  readonly canDecide: boolean;
  readonly preferences: CollaborationViewPreferences | null;
  readonly branchClaims: readonly CollaborationBranchClaim[];
  /** This viewer's own branch, when they have claimed one. */
  readonly myBranchClaim: CollaborationBranchClaim | null;
  /** The viewer's own name, so a branch can be named after the right person. */
  readonly viewerDisplayName: string;
  /** Who the viewer is, so their own entries can be told apart. */
  readonly viewerUserId: string | null;
  readonly claimBranch: (input: {
    branch: string;
    baseBranch: string;
    worktreePath: string;
  }) => Promise<CollaborationBranchClaim>;
  /** Latest author per workspace-relative path. */
  readonly touchesByPath: ReadonlyMap<string, CollaborationFileTouch>;
  /**
   * The colour the workspace has agreed on for each member, which is the
   * roster's colour and so the only one an approver can change. Anywhere a
   * person is drawn outside the roster has to read it from here — deriving a
   * colour from the id instead is right until somebody is recoloured, and
   * silently wrong forever after.
   */
  readonly memberColorByUserId: ReadonlyMap<string, string>;
  /**
   * Every touch, unreduced. `touchesByPath` keeps only the latest per path,
   * which is exactly what throws away the fact that two people touched one.
   */
  readonly touches: readonly CollaborationFileTouch[];
  readonly loading: boolean;
  readonly refresh: () => void;
  readonly setApprovalMode: (mode: CollaborationApprovalMode) => Promise<void>;
  readonly setApprovers: (userIds: readonly string[]) => Promise<void>;
  readonly decide: (
    approvalId: CollaborationPromptApproval["id"],
    decision: "approved" | "rejected",
  ) => Promise<void>;
  readonly setViewPreferences: (input: {
    showOthersPrompts?: boolean;
    showOthersFiles?: boolean;
  }) => Promise<void>;
}

const NO_APPROVALS: readonly CollaborationPromptApproval[] = [];
const NO_CLAIMS: readonly CollaborationBranchClaim[] = [];
const NO_TOUCHES: readonly CollaborationFileTouch[] = [];

/** Everything the hook reads, kept in one object so a shared store can hand it out. */
interface CollaborationGovernanceSnapshot {
  readonly settings: CollaborationWorkspaceSettings | null;
  readonly canManage: boolean;
  readonly approvals: readonly CollaborationPromptApproval[];
  readonly canDecide: boolean;
  readonly preferences: CollaborationViewPreferences | null;
  readonly branchClaims: readonly CollaborationBranchClaim[];
  readonly myBranchClaim: CollaborationBranchClaim | null;
  readonly viewerDisplayName: string;
  readonly viewerUserId: string | null;
  readonly touches: readonly CollaborationFileTouch[];
  readonly memberColorByUserId: ReadonlyMap<string, string>;
  readonly loading: boolean;
}

const NO_MEMBER_COLORS: ReadonlyMap<string, string> = new Map();

const EMPTY_SNAPSHOT: CollaborationGovernanceSnapshot = {
  settings: null,
  canManage: false,
  approvals: NO_APPROVALS,
  canDecide: false,
  preferences: null,
  branchClaims: NO_CLAIMS,
  myBranchClaim: null,
  viewerDisplayName: "collaborator",
  viewerUserId: null,
  touches: NO_TOUCHES,
  memberColorByUserId: NO_MEMBER_COLORS,
  loading: false,
};

interface CollaborationGovernanceScope {
  readonly tenantId: TenantId;
  readonly workspaceId: WorkspaceId;
}

interface SharedCollaborationGovernance {
  readonly environmentId: EnvironmentId;
  readonly scope: CollaborationGovernanceScope;
  readonly listeners: Set<() => void>;
  refCount: number;
  requestSequence: number;
  /** The load this instance has already retried, so a failure is asked twice, not forever. */
  retriedSequence: number;
  /** How many times this instance has waited for an environment client to exist. */
  attachAttempts: number;
  snapshot: CollaborationGovernanceSnapshot;
  streamAttached: boolean;
  unsubscribeStream: () => void;
}

/** Long enough for a socket to finish authorising, short enough to beat a reader. */
const GOVERNANCE_RETRY_DELAY_MS = 1_500;
/** Thirty seconds of waiting for a client, after which there is not going to be one. */
const GOVERNANCE_ATTACH_ATTEMPTS = 20;
/** How often to re-read the workspace when the stream has gone quiet. */
const GOVERNANCE_POLL_INTERVAL_MS = 30_000;

/** The map key an instance is filed under, so a retry can tell it is still the live one. */
function governanceKey(entry: { environmentId: EnvironmentId; scope: CollaborationGovernanceScope }): string {
  return `${entry.environmentId}:${entry.scope.tenantId}:${entry.scope.workspaceId}`;
}

/**
 * One governance instance per workspace, not per mount.
 *
 * The collaboration popover in the header and the authorship marks in the
 * workspace tree ask the same six questions about the same workspace, and both
 * are on screen at once — so every mount and every stream reconnect bought two
 * of everything: 12 requests instead of 6, and two subscriptions instead of
 * one. Ref-counting the instance halves that, and is the same idiom
 * `lib/gitStatusState.ts` uses to share one git status subscription.
 */
const sharedGovernanceByKey = new Map<string, SharedCollaborationGovernance>();

function updateSharedGovernance(
  entry: SharedCollaborationGovernance,
  patch: Partial<CollaborationGovernanceSnapshot>,
): void {
  entry.snapshot = { ...entry.snapshot, ...patch };
  for (const listener of entry.listeners) {
    listener();
  }
}

function refreshSharedGovernance(entry: SharedCollaborationGovernance): void {
  const api = readEnvironmentApi(entry.environmentId);
  if (!api) {
    return;
  }

  // A slow earlier load must not overwrite the results of a later one.
  entry.requestSequence += 1;
  const sequence = entry.requestSequence;
  updateSharedGovernance(entry, { loading: true });

  const scope = entry.scope;
  void (async () =>
    Promise.all([
      api.collaboration.getSettings(scope),
      api.collaboration.listApprovals(scope),
      api.collaboration.getViewPreferences(scope),
      api.collaboration.listBranchClaims(scope),
      api.collaboration.listFileTouches(scope),
      api.collaboration.listMembers(scope),
    ]))()
    .then(
      ([
        settingsResult,
        approvalsResult,
        viewResult,
        claimsResult,
        touchesResult,
        membersResult,
      ]) => {
        if (sequence !== entry.requestSequence) {
          return;
        }
        updateSharedGovernance(entry, {
          settings: settingsResult.settings,
          canManage: settingsResult.canManage,
          approvals: approvalsResult.approvals,
          canDecide: approvalsResult.canDecide,
          preferences: viewResult.preferences,
          branchClaims: claimsResult.claims,
          myBranchClaim: claimsResult.mine,
          viewerDisplayName: claimsResult.viewerDisplayName,
          touches: touchesResult.touches,
          viewerUserId: membersResult.viewerUserId,
          memberColorByUserId: new Map(
            membersResult.members.map((member) => [member.userId, member.color]),
          ),
        });
      },
    )
    /**
     * A load that failed is retried, once, a moment later.
     *
     * The six calls go out as soon as a workspace is known, which on a fresh
     * page is while the socket is still being authorised — and a rejection here
     * used to be swallowed and never asked again. Everything then depended on a
     * stream event arriving to fill the store, so the state that changed *after*
     * the load worked and the state that was already there stayed invisible: a
     * file somebody else had touched before you opened the page carried no
     * author, for as long as the page stayed open, while a file they touched
     * while you watched carried one immediately.
     *
     * Once, and only when nothing newer is already in flight, so a failing
     * server is asked twice rather than forever.
     */
    .catch(() => {
      if (sequence !== entry.requestSequence || entry.retriedSequence === sequence) {
        return;
      }
      entry.retriedSequence = sequence;
      setTimeout(() => {
        if (sequence === entry.requestSequence) {
          refreshSharedGovernance(entry);
        }
      }, GOVERNANCE_RETRY_DELAY_MS);
    })
    .finally(() => {
      if (sequence === entry.requestSequence && entry.snapshot.loading) {
        updateSharedGovernance(entry, { loading: false });
      }
    });
}

function applyGovernanceEvent(
  entry: SharedCollaborationGovernance,
  event: CollaborationStreamEvent,
): void {
  const snapshot = entry.snapshot;
  switch (event.type) {
    case "settings-updated":
      updateSharedGovernance(entry, { settings: event.settings });
      break;
    case "approval-requested":
    case "approval-decided":
      updateSharedGovernance(entry, {
        approvals: [
          event.approval,
          ...snapshot.approvals.filter((entryValue) => entryValue.id !== event.approval.id),
        ],
      });
      break;
    case "branch-claimed":
      updateSharedGovernance(entry, {
        branchClaims: [
          event.claim,
          ...snapshot.branchClaims.filter((entryValue) => entryValue.userId !== event.claim.userId),
        ],
      });
      break;
    case "branch-released":
      updateSharedGovernance(entry, {
        branchClaims: snapshot.branchClaims.filter(
          (entryValue) => entryValue.userId !== event.userId,
        ),
        myBranchClaim:
          snapshot.myBranchClaim?.userId === event.userId ? null : snapshot.myBranchClaim,
      });
      break;
    case "files-touched": {
      // Replace this person's touch of a path, not everybody's. Keying on path
      // alone dropped the previous author, so two people in one file looked
      // exactly like one person in it twice.
      const replaced = new Set(event.touches.map((touch) => `${touch.path}:${touch.userId}`));
      updateSharedGovernance(entry, {
        touches: [
          ...event.touches,
          ...snapshot.touches.filter(
            (entryValue) => !replaced.has(`${entryValue.path}:${entryValue.userId}`),
          ),
        ],
      });
      break;
    }
    default:
      break;
  }
}

/**
 * Subscribes and loads, once.
 *
 * The environment may not have a client yet when the first consumer mounts.
 * "A later consumer gets to try again" was the whole of the answer, and it is
 * not one: on a fresh page both consumers — the popover and the tree — mount in
 * the same tick, so if the client is not there yet neither is anybody left to
 * try. The instance then has no stream and no load for as long as the page is
 * open, which is exactly the state where a file somebody touched before you
 * arrived shows no author while one they touch in front of you shows one.
 *
 * So keep asking until there is a client, on the same short beat as the retry
 * below and capped so a browser with no environment at all stops asking.
 */
function attachSharedGovernanceStream(entry: SharedCollaborationGovernance): void {
  if (entry.streamAttached) {
    return;
  }
  const api = readEnvironmentApi(entry.environmentId);
  if (!api) {
    if (entry.attachAttempts < GOVERNANCE_ATTACH_ATTEMPTS) {
      entry.attachAttempts += 1;
      setTimeout(() => {
        if (sharedGovernanceByKey.get(governanceKey(entry)) === entry) {
          attachSharedGovernanceStream(entry);
        }
      }, GOVERNANCE_RETRY_DELAY_MS);
    }
    return;
  }
  entry.streamAttached = true;
  const unsubscribe = api.collaboration.subscribe(
    entry.scope,
    (event) => applyGovernanceEvent(entry, event),
    { onResubscribe: () => refreshSharedGovernance(entry) },
  );

  /**
   * Ask again on a slow beat, because the stream is not a promise.
   *
   * Everything here was built to arrive on the collaboration stream, and it
   * does — until the socket goes. A browser sitting on a project while somebody
   * else works loses its socket to a 1006 close and the subscription dies with
   * it; no event ever arrives again, and nothing notices, because a stream that
   * has stopped looks exactly like a workspace where nothing is happening.
   *
   * Measured rather than supposed: one browser watched another create a file
   * and showed no author for it at all, while a reload of the same page named
   * the author immediately — and its console carried four SocketCloseError
   * 1006s. So the mark was right, the fetch was right, and the only broken part
   * was the assumption that a subscription made once stays made.
   *
   * Half a minute is slow enough to be nearly free — six small reads per
   * workspace, and only while somebody has that workspace open — and quick
   * enough that a colleague's work is not invisible for the rest of a working
   * session.
   *
   * It does not pause for a hidden tab. A background tab is exactly where the
   * stream has had the longest to die, and it is what somebody comes back to;
   * skipping it saves six reads a minute and hands the reader a stale tree at
   * the moment they look at it.
   */
  const poll = setInterval(() => refreshSharedGovernance(entry), GOVERNANCE_POLL_INTERVAL_MS);

  // A tab coming back to the front is the moment somebody is about to read it,
  // and the cheapest time to be right.
  const onVisible = () => {
    if (document.visibilityState === "visible") {
      refreshSharedGovernance(entry);
    }
  };
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", onVisible);
  }

  entry.unsubscribeStream = () => {
    clearInterval(poll);
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", onVisible);
    }
    unsubscribe();
  };
  refreshSharedGovernance(entry);
}

function acquireSharedGovernance(
  key: string,
  environmentId: EnvironmentId,
  scope: CollaborationGovernanceScope,
): SharedCollaborationGovernance {
  const existing = sharedGovernanceByKey.get(key);
  if (existing) {
    existing.refCount += 1;
    attachSharedGovernanceStream(existing);
    return existing;
  }

  const entry: SharedCollaborationGovernance = {
    environmentId,
    scope,
    listeners: new Set(),
    refCount: 1,
    requestSequence: 0,
    retriedSequence: -1,
    attachAttempts: 0,
    snapshot: EMPTY_SNAPSHOT,
    streamAttached: false,
    unsubscribeStream: () => undefined,
  };
  sharedGovernanceByKey.set(key, entry);
  attachSharedGovernanceStream(entry);
  return entry;
}

function releaseSharedGovernance(key: string): void {
  const entry = sharedGovernanceByKey.get(key);
  if (!entry) {
    return;
  }
  entry.refCount -= 1;
  if (entry.refCount > 0) {
    return;
  }
  entry.unsubscribeStream();
  sharedGovernanceByKey.delete(key);
}

/**
 * Workspace governance for the collaboration UI: the approval mode and queue,
 * this person's own view filter, who is on which branch, and who last touched
 * each file. Everything refreshes from the collaboration stream, so a decision
 * made in one browser lands in the others without a reload. Mounting it twice
 * is free — every mount for a workspace reads the one shared instance above.
 */
export function useCollaborationGovernance(input: {
  environmentId: EnvironmentId | null;
  tenantId: TenantId | null;
  workspaceId: WorkspaceId | null;
}): CollaborationGovernance {
  const { environmentId, tenantId, workspaceId } = input;
  const key =
    environmentId && tenantId && workspaceId ? `${environmentId}:${tenantId}:${workspaceId}` : null;

  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      if (key === null || environmentId === null || tenantId === null || workspaceId === null) {
        return () => undefined;
      }
      const entry = acquireSharedGovernance(key, environmentId, { tenantId, workspaceId });
      entry.listeners.add(onStoreChange);
      return () => {
        entry.listeners.delete(onStoreChange);
        releaseSharedGovernance(key);
      };
    },
    [environmentId, key, tenantId, workspaceId],
  );

  const getSnapshot = useCallback(
    () =>
      key === null ? EMPTY_SNAPSHOT : (sharedGovernanceByKey.get(key)?.snapshot ?? EMPTY_SNAPSHOT),
    [key],
  );

  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  const refresh = useCallback(() => {
    const entry = key === null ? undefined : sharedGovernanceByKey.get(key);
    if (entry) {
      refreshSharedGovernance(entry);
    }
  }, [key]);

  const touchesByPath = useMemo(() => {
    const byPath = new Map<string, CollaborationFileTouch>();
    for (const touch of snapshot.touches) {
      const existing = byPath.get(touch.path);
      if (!existing || existing.touchedAt < touch.touchedAt) {
        byPath.set(touch.path, touch);
      }
    }
    return byPath;
  }, [snapshot.touches]);

  const pendingApprovals = useMemo(
    () => snapshot.approvals.filter((approval) => approval.status === "pending"),
    [snapshot.approvals],
  );

  const callSettingsUpdate = useCallback(
    async (patch: {
      approvalMode?: CollaborationApprovalMode;
      approverUserIds?: readonly string[];
    }) => {
      const entry = key === null ? undefined : sharedGovernanceByKey.get(key);
      if (!entry) {
        return;
      }
      const api = readEnvironmentApi(entry.environmentId);
      if (!api) {
        return;
      }
      const result = await api.collaboration.updateSettings({ ...entry.scope, ...patch } as never);
      updateSharedGovernance(entry, {
        settings: result.settings,
        canManage: result.canManage,
      });
    },
    [key],
  );

  const setApprovalMode = useCallback(
    (mode: CollaborationApprovalMode) => callSettingsUpdate({ approvalMode: mode }),
    [callSettingsUpdate],
  );

  const setApprovers = useCallback(
    (userIds: readonly string[]) => callSettingsUpdate({ approverUserIds: userIds }),
    [callSettingsUpdate],
  );

  const decide = useCallback(
    async (approvalId: CollaborationPromptApproval["id"], decision: "approved" | "rejected") => {
      const entry = key === null ? undefined : sharedGovernanceByKey.get(key);
      if (!entry) {
        return;
      }
      const api = readEnvironmentApi(entry.environmentId);
      if (!api) {
        return;
      }
      const result = await api.collaboration.decideApproval({
        ...entry.scope,
        approvalId,
        decision,
      });
      updateSharedGovernance(entry, {
        approvals: entry.snapshot.approvals.map((approval) =>
          approval.id === result.approval.id ? result.approval : approval,
        ),
      });
    },
    [key],
  );

  const claimBranch = useCallback(
    async (patch: { branch: string; baseBranch: string; worktreePath: string }) => {
      const entry = key === null ? undefined : sharedGovernanceByKey.get(key);
      if (!entry) {
        throw new Error("This workspace is not shared.");
      }
      const api = readEnvironmentApi(entry.environmentId);
      if (!api) {
        throw new Error("Environment is unavailable.");
      }
      const result = await api.collaboration.claimBranch({ ...entry.scope, ...patch });
      // The stream also delivers this, but the offer should disappear the
      // instant the button is pressed rather than a round trip later.
      updateSharedGovernance(entry, {
        myBranchClaim: result.claim,
        branchClaims: [
          result.claim,
          ...entry.snapshot.branchClaims.filter((claim) => claim.userId !== result.claim.userId),
        ],
      });
      return result.claim;
    },
    [key],
  );

  const setViewPreferences = useCallback(
    async (patch: { showOthersPrompts?: boolean; showOthersFiles?: boolean }) => {
      const entry = key === null ? undefined : sharedGovernanceByKey.get(key);
      if (!entry) {
        return;
      }
      const api = readEnvironmentApi(entry.environmentId);
      if (!api) {
        return;
      }
      const result = await api.collaboration.updateViewPreferences({
        ...entry.scope,
        ...patch,
      } as never);
      updateSharedGovernance(entry, { preferences: result.preferences });
    },
    [key],
  );

  return {
    settings: snapshot.settings,
    canManage: snapshot.canManage,
    approvals: snapshot.approvals,
    pendingApprovals,
    canDecide: snapshot.canDecide,
    preferences: snapshot.preferences,
    branchClaims: snapshot.branchClaims,
    myBranchClaim: snapshot.myBranchClaim,
    viewerDisplayName: snapshot.viewerDisplayName,
    viewerUserId: snapshot.viewerUserId,
    claimBranch,
    touchesByPath,
    memberColorByUserId: snapshot.memberColorByUserId,
    /** Unreduced, so contention between two people is still visible in it. */
    touches: snapshot.touches,
    loading: snapshot.loading,
    refresh,
    setApprovalMode,
    setApprovers,
    decide,
    setViewPreferences,
  };
}
