import { CheckIcon, EyeIcon, ShieldCheckIcon, UserMinusIcon } from "lucide-react";
import type { CollaborationMember, EnvironmentId, TenantId, WorkspaceId } from "@t3tools/contracts";
import { useCallback, useEffect, useState } from "react";

import { readEnvironmentApi } from "../../environmentApi";
import { formatContextWindowTokens } from "../../lib/contextWindow";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";

/** The palette a lead can pick from when overriding someone's colour. */
const MEMBER_COLORS = [
  "hsl(4 74% 58%)",
  "hsl(28 82% 55%)",
  "hsl(45 85% 50%)",
  "hsl(142 55% 45%)",
  "hsl(190 70% 45%)",
  "hsl(215 80% 58%)",
  "hsl(265 65% 62%)",
  "hsl(320 60% 58%)",
] as const;

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
  member: Pick<CollaborationMember, "displayName" | "avatarInitials" | "color" | "status">;
  size?: "xs" | "sm" | "md";
  showStatus?: boolean;
}) {
  const dimension = size === "xs" ? "size-5 text-[9px]" : size === "md" ? "size-8 text-xs" : "size-6 text-[10px]";

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
            {member.isLead ? "Lead" : readOnly ? "Read-only" : member.isApprover ? "Can approve" : "Member"}
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

/**
 * Everyone in the workspace, with the controls a lead needs: recolour someone,
 * hand them approval rights, or remove them.
 */
export function CollaborationPeople({
  environmentId,
  tenantId,
  workspaceId,
}: {
  environmentId: EnvironmentId | null;
  tenantId: TenantId | null;
  workspaceId: WorkspaceId | null;
}) {
  const [members, setMembers] = useState<readonly CollaborationMember[]>([]);
  const [canManage, setCanManage] = useState(false);
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
      })
      .catch(() => undefined);
  }, [environmentId, tenantId, workspaceId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

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
        if (
          event.type === "member-updated" ||
          event.type === "member-removed" ||
          event.type === "presence-upserted"
        ) {
          refresh();
        }
      },
      { onResubscribe: refresh },
    );
  }, [environmentId, refresh, tenantId, workspaceId]);

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

  if (!tenantId || !workspaceId || members.length === 0) {
    return null;
  }

  return (
    <div className="border-t border-border pt-3">
      <div className="mb-2 flex items-center justify-between">
        <div className="text-xs font-medium text-muted-foreground">People</div>
        <div className="text-[10px] text-muted-foreground">{members.length}</div>
      </div>
      <div className="grid gap-1">
        {members.map((member) => (
          <MemberRow
            key={member.userId}
            member={member}
            canManage={canManage}
            isViewer={member.userId === viewerUserId}
            onSetColor={(color) => {
              void mutate((api) =>
                api.collaboration.updateMember({
                  tenantId,
                  workspaceId,
                  userId: member.userId,
                  color,
                }),
              );
            }}
            onToggleApprover={() => {
              void mutate((api) =>
                api.collaboration.updateMember({
                  tenantId,
                  workspaceId,
                  userId: member.userId,
                  isApprover: !member.isApprover,
                }),
              );
            }}
            onToggleReadOnly={() => {
              void mutate((api) =>
                api.collaboration.updateMember({
                  tenantId,
                  workspaceId,
                  userId: member.userId,
                  readOnly: !isReadOnly(member),
                }),
              );
            }}
            onRemove={() => {
              void mutate((api) =>
                api.collaboration.removeMember({
                  tenantId,
                  workspaceId,
                  userId: member.userId,
                }),
              );
            }}
          />
        ))}
      </div>
    </div>
  );
}
