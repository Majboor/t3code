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
import { cn } from "../../lib/utils";
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
          <div className="mt-3 grid gap-2">
            {visiblePresence.length > 0 ? (
              visiblePresence.map((entry) => (
                <div key={entry.userId} className="flex items-center gap-2 text-sm">
                  <span className="flex size-6 items-center justify-center rounded-full bg-muted text-[10px] font-medium">
                    {presenceInitials(entry)}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{entry.displayName}</span>
                  <span className="text-xs text-muted-foreground">{entry.status}</span>
                </div>
              ))
            ) : (
              <div className="text-sm text-muted-foreground">No one else is present.</div>
            )}
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
                    <div className="text-muted-foreground">
                      {activity.kind} · {formatTime(activity.createdAt)}
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
    </div>
  );
}
