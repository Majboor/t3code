import { UsersRoundIcon } from "lucide-react";
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
import { useProviderUsageRequests } from "../../hooks/useProviderUsageRequests";
import { useGitStatus } from "../../lib/gitStatusState";
import { cn } from "../../lib/utils";
import { selectProjectByRef, useStore } from "../../store";
import { CollaborationPanel } from "./CollaborationPanel";
import { presenceInitials } from "./collaborationPanel.logic";
import { useCollaborationRoster } from "./CollaborationPeople";
import { ProviderSharingDialog } from "./ProviderSharingDialog";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { toastManager } from "../ui/toast";

/**
 * How much shared history the panel keeps. Enough for the activity chart to
 * have a shape rather than two bars, and still one screenful when somebody
 * opens the section to read it.
 */
const ACTIVITY_LIMIT = 24;

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
  const [panelOpen, setPanelOpen] = useState(false);
  const [sharingDialogOpen, setSharingDialogOpen] = useState(false);

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
        limit: ACTIVITY_LIMIT,
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
          setActivities((current) => [event.activity, ...current].slice(0, ACTIVITY_LIMIT));
        }
      },
      { onResubscribe: () => void load() },
    );
  }, [environmentId, load, tenantId, threadId, workspaceId]);

  const visiblePresence = presence.filter((entry) => entry.status !== "offline").slice(0, 5);
  const governance = useCollaborationGovernance({ environmentId, tenantId, workspaceId });
  // Held here rather than inside the popover so the dialog keeps its data after
  // the popover that opened it has closed, and so the overview can summarise
  // sharing, the roster and the request list without opening their sections.
  const sharing = useProviderSharing({ environmentId, tenantId, workspaceId });
  // The roster and the request list are only summarised inside the popover, so
  // they are scoped to nothing until it opens: an unscoped hook does not call,
  // and every header on screen would otherwise buy two requests nobody reads.
  // Both keep what they last loaded, so reopening paints before it refetches.
  const panelScope = {
    environmentId,
    tenantId: panelOpen ? tenantId : null,
    workspaceId: panelOpen ? workspaceId : null,
  };
  const roster = useCollaborationRoster(panelScope);
  const usage = useProviderUsageRequests(panelScope);
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

  const shareActivity = useCallback(
    async (prompt: string) => {
      if (!tenantId || !workspaceId) return;
      const api = readEnvironmentApi(environmentId);
      if (!api) return;
      const result = await api.collaboration.recordSharedPrompt({
        tenantId,
        workspaceId,
        threadId,
        prompt,
      });
      setActivities((current) => [result.activity, ...current].slice(0, ACTIVITY_LIMIT));
    },
    [environmentId, tenantId, threadId, workspaceId],
  );

  const toggleActivityHidden = useCallback(
    (activity: CollaborationActivity) => {
      if (!tenantId || !workspaceId) return;
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
            current.map((entry) => (entry.id === result.activity.id ? result.activity : entry)),
          );
        })
        .catch((error: unknown) => {
          toastManager.add({
            type: "error",
            title: "Could not change what you share",
            description: error instanceof Error ? error.message : "The request failed.",
          });
        });
    },
    [environmentId, tenantId, workspaceId],
  );

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
          <CollaborationPanel
            activities={activities}
            baseBranch={baseBranch}
            environmentId={environmentId}
            governance={governance}
            presence={visiblePresence}
            presentCount={visiblePresence.length}
            roster={roster}
            sharing={sharing}
            usage={usage}
            workspaceRoot={project?.cwd ?? null}
            workspaceTitle={ownership?.workspaceTitle ?? project?.name ?? null}
            onManageSharing={() => {
              setPanelOpen(false);
              setSharingDialogOpen(true);
            }}
            onShareActivity={shareActivity}
            onToggleActivityHidden={toggleActivityHidden}
          />
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
