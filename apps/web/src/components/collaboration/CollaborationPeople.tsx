import { CheckIcon, EyeIcon, ShieldCheckIcon, UserMinusIcon } from "lucide-react";
import type { CollaborationMember, EnvironmentId, TenantId, WorkspaceId } from "@t3tools/contracts";
import { useCallback, useEffect, useRef, useState } from "react";

import { readEnvironmentApi } from "../../environmentApi";
import { formatContextWindowTokens } from "../../lib/contextWindow";
import { cn } from "../../lib/utils";
import {
  applyPresenceToRoster,
  MEMBER_COLORS,
  ROSTER_REFRESH_DEBOUNCE_MS,
} from "./collaborationRoster.logic";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";

/**
 * Someone who can watch but not prompt. Mirrors the server's rule rather than
 * reading a flag, so the roster and the turn check cannot disagree.
 */
function isReadOnly(member: Pick<CollaborationMember, "roles">): boolean {
  return member.roles.length > 0 && member.roles.every((role) => role === "viewer");
}

/**
 * A person, drawn as their colour and initials. Everything that mentions a
 * collaborator uses this so the same person always looks the same.
 */
export function CollaborationAvatar({
  member,
  size = "sm",
  showStatus = false,
}: {
  // Status is only read when `showStatus` asks for it, and the transcript draws
  // people the roster may never have listed — so it is optional here rather
  // than something every caller has to invent an answer for.
  member: Pick<CollaborationMember, "displayName" | "avatarInitials" | "color"> & {
    status?: CollaborationMember["status"] | undefined;
  };
  size?: "xs" | "sm" | "md";
  showStatus?: boolean;
}) {
  const dimension =
    size === "xs" ? "size-5 text-[9px]" : size === "md" ? "size-8 text-xs" : "size-6 text-[10px]";

  return (
    <span className="relative inline-flex shrink-0" title={member.displayName}>
      <span
        className={cn(
          "inline-flex items-center justify-center rounded-full font-medium text-white",
          dimension,
        )}
        style={{ backgroundColor: member.color }}
        data-testid="collaboration-avatar"
        data-member={member.displayName}
      >
        {member.avatarInitials}
      </span>
      {showStatus ? (
        <span
          className={cn(
            "absolute -right-0.5 -bottom-0.5 size-2 rounded-full border border-background",
            member.status === "active"
              ? "bg-emerald-500"
              : member.status === "idle"
                ? "bg-amber-500"
                : "bg-muted-foreground/50",
          )}
        />
      ) : null}
    </span>
  );
}

function MemberRow({
  member,
  canManage,
  isViewer,
  onSetColor,
  onToggleApprover,
  onToggleReadOnly,
  onRemove,
}: {
  member: CollaborationMember;
  canManage: boolean;
  isViewer: boolean;
  onSetColor: (color: string) => void;
  onToggleApprover: () => void;
  onToggleReadOnly: () => void;
  onRemove: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const readOnly = isReadOnly(member);

  return (
    <div className="rounded-md border border-border/70" data-testid="collaboration-member-row">
      <button
        type="button"
        className="flex w-full items-center gap-2 px-2 py-1.5 text-left"
        onClick={() => setExpanded((current) => !current)}
      >
        <CollaborationAvatar member={member} showStatus />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs text-foreground">{member.displayName}</span>
          <span className="block truncate text-[10px] text-muted-foreground">
            {member.isLead
              ? "Lead"
              : readOnly
                ? "Read-only"
                : member.isApprover
                  ? "Can approve"
                  : "Member"}
            {member.email ? ` · ${member.email}` : ""}
          </span>
        </span>
      </button>

      {expanded ? (
        <div className="border-t border-border/70 px-2 py-2">
          <div className="text-[10px] text-muted-foreground">
            {member.tokensUsed === null ? (
              // Not a gap in the data — they simply have not agreed to share it.
              <>Usage not shared</>
            ) : (
              <>
                {member.promptCount ?? 0} prompts · {member.pendingApprovalCount ?? 0} waiting ·{" "}
                {formatContextWindowTokens(member.tokensUsed)} tokens
              </>
            )}
          </div>

          {canManage ? (
            <>
              <div className="mt-2 flex flex-wrap gap-1" data-testid="collaboration-color-picker">
                {MEMBER_COLORS.map((color) => (
                  <button
                    key={color}
                    type="button"
                    aria-label={`Use this colour for ${member.displayName}`}
                    className={cn(
                      "flex size-5 items-center justify-center rounded-full border",
                      member.color === color ? "border-foreground" : "border-transparent",
                    )}
                    style={{ backgroundColor: color }}
                    onClick={() => onSetColor(color)}
                  >
                    {member.color === color ? <CheckIcon className="size-3 text-white" /> : null}
                  </button>
                ))}
              </div>

              {!member.isLead ? (
                <div className="mt-2 flex flex-wrap gap-1">
                  <Button size="xs" variant="outline" onClick={onToggleApprover}>
                    <ShieldCheckIcon className="size-3.5" />
                    {member.isApprover ? "Remove approver" : "Make approver"}
                  </Button>
                  <Button
                    size="xs"
                    variant="outline"
                    data-testid="collaboration-read-only-toggle"
                    onClick={onToggleReadOnly}
                  >
                    <EyeIcon className="size-3.5" />
                    {readOnly ? "Restore write access" : "Make read-only"}
                  </Button>
                  {!isViewer ? (
                    <Button size="xs" variant="outline" onClick={onRemove}>
                      <UserMinusIcon className="size-3.5" />
                      Remove
                    </Button>
                  ) : null}
                </div>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export interface CollaborationRoster {
  readonly members: readonly CollaborationMember[];
  /** Whether this person may recolour, promote, demote or remove anybody. */
  readonly canManage: boolean;
  readonly viewerUserId: string | null;
  /**
   * False until the first read lands. An empty roster and an unanswered one are
   * the same array, and only one of them is worth telling somebody about.
   */
  readonly loaded: boolean;
  readonly refresh: () => void;
  readonly updateMember: (
    userId: CollaborationMember["userId"],
    patch: { color?: string; isApprover?: boolean; readOnly?: boolean },
  ) => void;
  readonly removeMember: (userId: CollaborationMember["userId"]) => void;
}

/**
 * The workspace roster, and the four things a lead can do to it.
 *
 * Lifted out of the list it draws because the collaboration popover now
 * summarises the roster before anybody opens it — "3 of 5 here" needs the same
 * members the list needs, and fetching them twice would double what opening the
 * panel costs for a sentence.
 */
export function useCollaborationRoster({
  environmentId,
  tenantId,
  workspaceId,
}: {
  environmentId: EnvironmentId | null;
  tenantId: TenantId | null;
  workspaceId: WorkspaceId | null;
}): CollaborationRoster {
  const [members, setMembers] = useState<readonly CollaborationMember[]>([]);
  const [canManage, setCanManage] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [viewerUserId, setViewerUserId] = useState<string | null>(null);

  const refresh = useCallback(() => {
    if (!environmentId || !tenantId || !workspaceId) {
      return;
    }
    const api = readEnvironmentApi(environmentId);
    if (!api) {
      return;
    }
    api.collaboration
      .listMembers({ tenantId, workspaceId })
      .then((result) => {
        setMembers(result.members);
        setCanManage(result.canManage);
        setViewerUserId(result.viewerUserId);
        setLoaded(true);
      })
      .catch(() => undefined);
  }, [environmentId, tenantId, workspaceId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  const membersRef = useRef(members);
  membersRef.current = members;
  const pendingRefreshRef = useRef<number | null>(null);

  // Several people joining at once is still one roster to fetch.
  const scheduleRefresh = useCallback(() => {
    if (pendingRefreshRef.current !== null) {
      return;
    }
    pendingRefreshRef.current = window.setTimeout(() => {
      pendingRefreshRef.current = null;
      refreshRef.current();
    }, ROSTER_REFRESH_DEBOUNCE_MS);
  }, []);

  useEffect(
    () => () => {
      if (pendingRefreshRef.current !== null) {
        window.clearTimeout(pendingRefreshRef.current);
      }
    },
    [],
  );

  useEffect(() => {
    if (!environmentId || !tenantId || !workspaceId) {
      return;
    }
    const api = readEnvironmentApi(environmentId);
    if (!api) {
      return;
    }
    return api.collaboration.subscribe(
      { tenantId, workspaceId },
      (event) => {
        // A membership change is what it says it is, and rare enough to answer
        // straight away.
        if (event.type === "member-updated" || event.type === "member-removed") {
          refreshRef.current();
          return;
        }
        if (event.type !== "presence-upserted") {
          return;
        }
        // A heartbeat is not a roster change: everybody emits one every ~30s,
        // and it carries the presence it announces, so a familiar person's dot
        // moves for free. Only a stranger means the roster itself has moved.
        const outcome = applyPresenceToRoster(membersRef.current, event.presence);
        if (outcome.members !== membersRef.current) {
          membersRef.current = outcome.members;
          setMembers(outcome.members);
        }
        if (!outcome.isKnownMember) {
          scheduleRefresh();
        }
      },
      { onResubscribe: () => refreshRef.current() },
    );
  }, [environmentId, scheduleRefresh, tenantId, workspaceId]);

  const mutate = useCallback(
    async (run: (api: NonNullable<ReturnType<typeof readEnvironmentApi>>) => Promise<unknown>) => {
      if (!environmentId) {
        return;
      }
      const api = readEnvironmentApi(environmentId);
      if (!api) {
        return;
      }
      try {
        await run(api);
        refresh();
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Could not update the workspace",
          description: error instanceof Error ? error.message : "The request failed.",
        });
      }
    },
    [environmentId, refresh],
  );

  const updateMember = useCallback<CollaborationRoster["updateMember"]>(
    (userId, patch) => {
      if (!tenantId || !workspaceId) {
        return;
      }
      void mutate((api) =>
        api.collaboration.updateMember({ tenantId, workspaceId, userId, ...patch }),
      );
    },
    [mutate, tenantId, workspaceId],
  );

  const removeMember = useCallback<CollaborationRoster["removeMember"]>(
    (userId) => {
      if (!tenantId || !workspaceId) {
        return;
      }
      void mutate((api) => api.collaboration.removeMember({ tenantId, workspaceId, userId }));
    },
    [mutate, tenantId, workspaceId],
  );

  return { members, canManage, viewerUserId, loaded, refresh, updateMember, removeMember };
}

/**
 * Everyone in the workspace, with the controls a lead needs: recolour someone,
 * hand them approval rights, make them read-only, or remove them.
 */
export function CollaborationPeople({ roster }: { roster: CollaborationRoster }) {
  const { members, canManage, viewerUserId } = roster;

  if (members.length === 0) {
    return (
      <p className="text-[11px] text-muted-foreground" data-testid="collaboration-people-empty">
        {roster.loaded
          ? "Nobody has been added to this workspace yet."
          : "Loading the workspace roster…"}
      </p>
    );
  }

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <div className="text-xs font-medium text-muted-foreground">Members</div>
        <div className="text-[10px] text-muted-foreground">{members.length}</div>
      </div>
      <div className="grid gap-1">
        {members.map((member) => (
          <MemberRow
            key={member.userId}
            member={member}
            canManage={canManage}
            isViewer={member.userId === viewerUserId}
            onSetColor={(color) => roster.updateMember(member.userId, { color })}
            onToggleApprover={() =>
              roster.updateMember(member.userId, { isApprover: !member.isApprover })
            }
            onToggleReadOnly={() =>
              roster.updateMember(member.userId, { readOnly: !isReadOnly(member) })
            }
            onRemove={() => roster.removeMember(member.userId)}
          />
        ))}
      </div>
    </div>
  );
}
