import type {
  CollaborationApprovalMode,
  CollaborationBranchClaim,
  CollaborationFileTouch,
  CollaborationPromptApproval,
  CollaborationViewPreferences,
  CollaborationWorkspaceSettings,
  EnvironmentId,
  TenantId,
  WorkspaceId,
} from "@t3tools/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

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

/**
 * Workspace governance for the collaboration UI: the approval mode and queue,
 * this person's own view filter, who is on which branch, and who last touched
 * each file. Everything refreshes from the collaboration stream, so a decision
 * made in one browser lands in the others without a reload.
 */
export function useCollaborationGovernance(input: {
  environmentId: EnvironmentId | null;
  tenantId: TenantId | null;
  workspaceId: WorkspaceId | null;
}): CollaborationGovernance {
  const { environmentId, tenantId, workspaceId } = input;
  const [settings, setSettings] = useState<CollaborationWorkspaceSettings | null>(null);
  const [canManage, setCanManage] = useState(false);
  const [approvals, setApprovals] = useState<readonly CollaborationPromptApproval[]>(NO_APPROVALS);
  const [canDecide, setCanDecide] = useState(false);
  const [preferences, setPreferences] = useState<CollaborationViewPreferences | null>(null);
  const [branchClaims, setBranchClaims] = useState<readonly CollaborationBranchClaim[]>(NO_CLAIMS);
  const [myBranchClaim, setMyBranchClaim] = useState<CollaborationBranchClaim | null>(null);
  const [viewerDisplayName, setViewerDisplayName] = useState("collaborator");
  const [viewerUserId, setViewerUserId] = useState<string | null>(null);
  const [touches, setTouches] = useState<readonly CollaborationFileTouch[]>([]);
  const [loading, setLoading] = useState(false);
  const requestSequenceRef = useRef(0);

  const scope = useMemo(
    () => (tenantId && workspaceId ? { tenantId, workspaceId } : null),
    [tenantId, workspaceId],
  );

  const refresh = useCallback(() => {
    if (!environmentId || !scope) {
      return;
    }
    const api = readEnvironmentApi(environmentId);
    if (!api) {
      return;
    }

    // A slow earlier load must not overwrite the results of a later one.
    requestSequenceRef.current += 1;
    const sequence = requestSequenceRef.current;
    setLoading(true);

    Promise.all([
      api.collaboration.getSettings(scope),
      api.collaboration.listApprovals(scope),
      api.collaboration.getViewPreferences(scope),
      api.collaboration.listBranchClaims(scope),
      api.collaboration.listFileTouches(scope),
      api.collaboration.listMembers(scope),
    ])
      .then(
        ([
          settingsResult,
          approvalsResult,
          viewResult,
          claimsResult,
          touchesResult,
          membersResult,
        ]) => {
          if (sequence !== requestSequenceRef.current) {
            return;
          }
          setSettings(settingsResult.settings);
          setCanManage(settingsResult.canManage);
          setApprovals(approvalsResult.approvals);
          setCanDecide(approvalsResult.canDecide);
          setPreferences(viewResult.preferences);
          setBranchClaims(claimsResult.claims);
          setMyBranchClaim(claimsResult.mine);
          setViewerDisplayName(claimsResult.viewerDisplayName);
          setTouches(touchesResult.touches);
          setViewerUserId(membersResult.viewerUserId);
        },
      )
      .catch(() => undefined)
      .finally(() => {
        if (sequence === requestSequenceRef.current) {
          setLoading(false);
        }
      });
  }, [environmentId, scope]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    if (!environmentId || !scope) {
      return;
    }
    const api = readEnvironmentApi(environmentId);
    if (!api) {
      return;
    }

    return api.collaboration.subscribe(
      scope,
      (event) => {
        switch (event.type) {
          case "settings-updated":
            setSettings(event.settings);
            break;
          case "approval-requested":
          case "approval-decided":
            setApprovals((current) => [
              event.approval,
              ...current.filter((entry) => entry.id !== event.approval.id),
            ]);
            break;
          case "branch-claimed":
            setBranchClaims((current) => [
              event.claim,
              ...current.filter((entry) => entry.userId !== event.claim.userId),
            ]);
            break;
          case "branch-released":
            setBranchClaims((current) => current.filter((entry) => entry.userId !== event.userId));
            setMyBranchClaim((current) => (current?.userId === event.userId ? null : current));
            break;
          case "files-touched":
            setTouches((current) => {
              // Replace this person's touch of a path, not everybody's. Keying
              // on path alone dropped the previous author, so two people in one
              // file looked exactly like one person in it twice.
              const replaced = new Set(
                event.touches.map((touch) => `${touch.path}:${touch.userId}`),
              );
              return [
                ...event.touches,
                ...current.filter((entry) => !replaced.has(`${entry.path}:${entry.userId}`)),
              ];
            });
            break;
          default:
            break;
        }
      },
      { onResubscribe: refresh },
    );
  }, [environmentId, refresh, scope]);

  const touchesByPath = useMemo(() => {
    const byPath = new Map<string, CollaborationFileTouch>();
    for (const touch of touches) {
      const existing = byPath.get(touch.path);
      if (!existing || existing.touchedAt < touch.touchedAt) {
        byPath.set(touch.path, touch);
      }
    }
    return byPath;
  }, [touches]);

  const pendingApprovals = useMemo(
    () => approvals.filter((approval) => approval.status === "pending"),
    [approvals],
  );

  const callSettingsUpdate = useCallback(
    async (patch: {
      approvalMode?: CollaborationApprovalMode;
      approverUserIds?: readonly string[];
    }) => {
      if (!environmentId || !scope) {
        return;
      }
      const api = readEnvironmentApi(environmentId);
      if (!api) {
        return;
      }
      const result = await api.collaboration.updateSettings({ ...scope, ...patch } as never);
      setSettings(result.settings);
      setCanManage(result.canManage);
    },
    [environmentId, scope],
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
      if (!environmentId || !scope) {
        return;
      }
      const api = readEnvironmentApi(environmentId);
      if (!api) {
        return;
      }
      const result = await api.collaboration.decideApproval({ ...scope, approvalId, decision });
      setApprovals((current) =>
        current.map((entry) => (entry.id === result.approval.id ? result.approval : entry)),
      );
    },
    [environmentId, scope],
  );

  const claimBranch = useCallback(
    async (patch: { branch: string; baseBranch: string; worktreePath: string }) => {
      if (!environmentId || !scope) {
        throw new Error("This workspace is not shared.");
      }
      const api = readEnvironmentApi(environmentId);
      if (!api) {
        throw new Error("Environment is unavailable.");
      }
      const result = await api.collaboration.claimBranch({ ...scope, ...patch });
      // The stream also delivers this, but the offer should disappear the
      // instant the button is pressed rather than a round trip later.
      setMyBranchClaim(result.claim);
      setBranchClaims((current) => [
        result.claim,
        ...current.filter((entry) => entry.userId !== result.claim.userId),
      ]);
      return result.claim;
    },
    [environmentId, scope],
  );

  const setViewPreferences = useCallback(
    async (patch: { showOthersPrompts?: boolean; showOthersFiles?: boolean }) => {
      if (!environmentId || !scope) {
        return;
      }
      const api = readEnvironmentApi(environmentId);
      if (!api) {
        return;
      }
      const result = await api.collaboration.updateViewPreferences({ ...scope, ...patch } as never);
      setPreferences(result.preferences);
    },
    [environmentId, scope],
  );

  return {
    settings,
    canManage,
    approvals,
    pendingApprovals,
    canDecide,
    preferences,
    branchClaims,
    myBranchClaim,
    viewerDisplayName,
    viewerUserId,
    claimBranch,
    touchesByPath,
    /** Unreduced, so contention between two people is still visible in it. */
    touches,
    loading,
    refresh,
    setApprovalMode,
    setApprovers,
    decide,
    setViewPreferences,
  };
}
