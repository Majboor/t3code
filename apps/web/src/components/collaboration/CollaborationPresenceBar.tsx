import { MessageSquarePlusIcon, UsersRoundIcon } from "lucide-react";
import {
  WorkspaceId,
  type CollaborationActivity,
  type CollaborationPresence,
  type EnvironmentId,
  type OrchestrationProjectOwnership,
  type ProjectId,
  type Tenant,
  type ThreadId,
} from "@t3tools/contracts";
import { useCallback, useEffect, useState } from "react";

import { readEnvironmentApi } from "../../environmentApi";
import { useCollaborationGovernance } from "../../hooks/useCollaborationGovernance";
import { useProviderSharing } from "../../hooks/useProviderSharing";
import { useGitStatus } from "../../lib/gitStatusState";
import { cn } from "../../lib/utils";
import { selectProjectByRef, useStore } from "../../store";
import { CollaborationBranchSection } from "./CollaborationBranchSection";
import { CollaborationPeople } from "./CollaborationPeople";
import {
  CollaborationGovernancePanel,
  CollaborationWorkingPills,
} from "./CollaborationGovernancePanel";
import { ProviderSharingDialog } from "./ProviderSharingDialog";
import { ProviderSharingSection } from "./ProviderSharingSection";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

function presenceInitials(entry: CollaborationPresence): string {
  const savedInitials = entry.avatarInitials?.trim();
  return savedInitials || initials(entry.displayName) || "U";
}

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function pickTenantForProject(tenants: readonly Tenant[]): Tenant | null {
  return tenants[0] ?? null;
}

export function CollaborationPresenceBar({
  environmentId,
  ownership,
  projectId,
  threadId,
}: {
  environmentId: EnvironmentId;
  ownership?: OrchestrationProjectOwnership | null | undefined;
  projectId: ProjectId | null;
  threadId: ThreadId;
}) {
  const workspaceId = ownership?.workspaceId ?? (projectId ? WorkspaceId.make(projectId) : null);
  const [tenantId, setTenantId] = useState<Tenant["id"] | null>(ownership?.tenantId ?? null);
  const [presence, setPresence] = useState<readonly CollaborationPresence[]>([]);
  const [activities, setActivities] = useState<readonly CollaborationActivity[]>([]);
  const [prompt, setPrompt] = useState("");
  const [panelOpen, setPanelOpen] = useState(false);
  const [sharingDialogOpen, setSharingDialogOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!workspaceId) return;
    const api = readEnvironmentApi(environmentId);
    if (!api) return;
    const nextTenantId =
      ownership?.tenantId ?? pickTenantForProject((await api.organizations.list()).tenants)?.id;
    setTenantId(nextTenantId ?? null);
    if (!nextTenantId) return;
    const [presenceResult, activityResult] = await Promise.all([
      api.collaboration.listPresence({
        tenantId: nextTenantId,
        workspaceId,
        threadId,
      }),
      api.collaboration.listActivity({
        tenantId: nextTenantId,
        workspaceId,
        threadId,
        limit: 12,
      }),
    ]);
    setPresence(presenceResult.users);
    setActivities(activityResult.activities);
    await api.collaboration.upsertPresence({
      tenantId: nextTenantId,
      workspaceId,
      threadId,
      status: "active",
    });
  }, [environmentId, ownership?.tenantId, threadId, workspaceId]);

  useEffect(() => {
    let disposed = false;
    load().catch(() => undefined);
    const interval = window.setInterval(() => {
      if (!disposed) {
        load().catch(() => undefined);
      }
    }, 30_000);
    return () => {
      disposed = true;
      window.clearInterval(interval);
    };
  }, [load]);

  useEffect(() => {
    if (!tenantId || !workspaceId) return;
    const api = readEnvironmentApi(environmentId);
    if (!api) return;
    return api.collaboration.subscribe(
      { tenantId, workspaceId, threadId },
      (event) => {
        if (event.type === "presence-upserted") {
          setPresence((current) => {
            const existing = current.filter((entry) => entry.userId !== event.presence.userId);
            return [event.presence, ...existing].slice(0, 8);
          });
        }
        if (event.type === "activity-appended") {
          setActivities((current) => [event.activity, ...current].slice(0, 12));
        }
      },
      { onResubscribe: () => void load() },
    );
  }, [environmentId, load, tenantId, threadId, workspaceId]);

  const visiblePresence = presence.filter((entry) => entry.status !== "offline").slice(0, 5);
  const governance = useCollaborationGovernance({ environmentId, tenantId, workspaceId });
  // Held here rather than inside the popover so the dialog keeps its data after
  // the popover that opened it has closed.
  const sharing = useProviderSharing({ environmentId, tenantId, workspaceId });
  const project = useStore((store) =>
    selectProjectByRef(store, projectId ? { environmentId, projectId } : null),
  );
  const gitStatus = useGitStatus({ environmentId, cwd: project?.cwd ?? null });
  // Whichever branch this person is on now is the shared one they would branch
  // away from.
  const baseBranch = gitStatus.data?.branch ?? null;
  const pendingCount = governance.pendingApprovals.length;
  // Only an approver can clear the queue, so only they get nagged about it.
  const showPendingBadge = governance.canDecide && pendingCount > 0;

  if (!tenantId || !workspaceId || !projectId) {
    return null;
  }

  return (
    <div className="relative flex shrink-0 items-center gap-1.5">
      {visiblePresence.length > 0 ? (
        <div className="hidden items-center -space-x-1 @xl/header-actions:flex">
          {visiblePresence.map((entry) => (
            <span
              key={entry.userId}
              title={`${entry.displayName} · ${entry.status}`}
              className={cn(
                "flex size-6 items-center justify-center rounded-full border border-background bg-muted text-[10px] font-medium text-foreground",
                entry.status === "idle" && "text-muted-foreground",
              )}
            >
              {presenceInitials(entry)}
            </span>
          ))}
        </div>
      ) : null}
      <Popover onOpenChange={setPanelOpen} open={panelOpen}>
        <PopoverTrigger
          render={
            <Button
              size="xs"
              variant="outline"
              aria-label={panelOpen ? "Close collaboration panel" : "Open collaboration panel"}
            />
          }
        >
          <UsersRoundIcon className="size-3.5" />
          <span className="hidden @2xl/header-actions:inline">Collab</span>
          {showPendingBadge ? (
            <span
              data-testid="collaboration-pending-badge"
              className="ml-1 flex size-4 items-center justify-center rounded-full bg-primary text-[9px] font-medium text-primary-foreground"
            >
              {pendingCount}
            </span>
          ) : null}
        </PopoverTrigger>
        <PopoverPopup
          align="end"
          side="bottom"
          sideOffset={8}
          className="w-[min(22rem,calc(100vw-2rem))]"
        >
          <div className="flex items-center justify-between gap-2">
            <div className="text-sm font-medium">Collaboration</div>
            <div className="text-xs text-muted-foreground">{visiblePresence.length} present</div>
          </div>
          <div className="mt-3">
            <CollaborationWorkingPills presence={visiblePresence} />
          </div>
          <div className="mt-3">
            <CollaborationBranchSection
              environmentId={environmentId}
              governance={governance}
              workspaceRoot={project?.cwd ?? null}
              baseBranch={baseBranch}
              displayName={governance.viewerDisplayName}
            />
          </div>
          <div className="mt-3">
            <CollaborationPeople
              environmentId={environmentId}
              tenantId={tenantId}
              workspaceId={workspaceId}
            />
          </div>
          <div className="mt-3">
            <CollaborationGovernancePanel
              governance={governance}
              environmentId={environmentId}
              workspaceRoot={project?.cwd ?? null}
            />
          </div>
          <div className="mt-3">
            <ProviderSharingSection
              sharing={sharing}
              environmentId={environmentId}
              tenantId={tenantId}
              workspaceId={workspaceId}
              workspaceTitle={ownership?.workspaceTitle ?? project?.name ?? null}
              onManage={() => {
                setPanelOpen(false);
                setSharingDialogOpen(true);
              }}
            />
          </div>
          <div className="mt-3 border-t border-border pt-3">
            <Textarea
              size="sm"
              value={prompt}
              placeholder="Share a prompt with this thread"
              onChange={(event) => setPrompt(event.currentTarget.value)}
            />
            <div className="mt-2 flex justify-end">
              <Button
                size="xs"
                disabled={busy || prompt.trim().length === 0}
                onClick={() => {
                  const api = readEnvironmentApi(environmentId);
                  if (!api) return;
                  setBusy(true);
                  api.collaboration
                    .recordSharedPrompt({
                      tenantId,
                      workspaceId,
                      threadId,
                      prompt: prompt.trim(),
                    })
                    .then((result) => {
                      setActivities((current) => [result.activity, ...current].slice(0, 12));
                      setPrompt("");
                    })
                    .catch((error: unknown) => {
                      toastManager.add({
                        type: "error",
                        title: "Could not share prompt",
                        description: error instanceof Error ? error.message : "The request failed.",
                      });
                    })
                    .finally(() => setBusy(false));
                }}
              >
                <MessageSquarePlusIcon className="size-3.5" />
                Share
              </Button>
            </div>
          </div>
          <div className="mt-3 border-t border-border pt-3">
            <div className="mb-2 text-xs font-medium text-muted-foreground">Activity</div>
            <div className="grid max-h-48 gap-2 overflow-auto pr-1">
              {activities.length > 0 ? (
                activities.map((activity) => (
                  <div
                    key={`${activity.createdAt}:${activity.userId}:${activity.kind}:${activity.summary}`}
                    className="text-xs"
                  >
                    <div className="text-foreground">{activity.summary}</div>
                    <div className="flex items-center gap-1.5 text-muted-foreground">
                      <span>
                        {activity.kind} · {formatTime(activity.createdAt)}
                      </span>
                      {activity.userId === governance.viewerUserId ? (
                        <button
                          type="button"
                          data-testid="collaboration-activity-visibility"
                          className="rounded px-1 text-[10px] underline-offset-2 hover:underline"
                          onClick={() => {
                            const api = readEnvironmentApi(environmentId);
                            if (!api) return;
                            api.collaboration
                              .setActivityVisibility({
                                tenantId,
                                workspaceId,
                                activityId: activity.id,
                                hidden: activity.hiddenAt === null,
                              })
                              .then((result) => {
                                setActivities((current) =>
                                  current.map((entry) =>
                                    entry.id === result.activity.id ? result.activity : entry,
                                  ),
                                );
                              })
                              .catch((error: unknown) => {
                                toastManager.add({
                                  type: "error",
                                  title: "Could not change what you share",
                                  description:
                                    error instanceof Error ? error.message : "The request failed.",
                                });
                              });
                          }}
                        >
                          {activity.hiddenAt === null ? "Hide from others" : "Hidden — show again"}
                        </button>
                      ) : null}
                    </div>
                  </div>
                ))
              ) : (
                <div className="text-xs text-muted-foreground">No shared activity yet.</div>
              )}
            </div>
          </div>
        </PopoverPopup>
      </Popover>
      <ProviderSharingDialog
        environmentId={environmentId}
        tenantId={tenantId}
        workspaceId={workspaceId}
        workspaceTitle={ownership?.workspaceTitle ?? project?.name ?? null}
        sharing={sharing}
        open={sharingDialogOpen}
        onOpenChange={setSharingDialogOpen}
      />
    </div>
  );
}
