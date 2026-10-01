import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { CloudAlertIcon, CloudIcon, CloudOffIcon, RefreshCwIcon } from "lucide-react";
import { useState } from "react";

import { cn } from "../../lib/utils";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { isWorkspaceShareLive } from "../workspaceSharing/workspaceSharing.logic";
import { useWorkspaceShareState } from "../workspaceSharing/useWorkspaceShareState";
import {
  CLOUD_SYNC_OFFLINE_QUESTION,
  cloudSyncWaitBadgeLabel,
  describeCloudSyncHeadline,
  describeOfflineReachability,
  type CloudSyncOfflineReachability,
} from "./cloudSync.logic";
import { CloudSyncPanel } from "./CloudSyncPanel";
import { useCloudSync } from "./useCloudSync";
import { useProjectCloudSyncScope } from "./useProjectCloudSyncScope";

const REACH_BADGE = {
  ok: "success",
  pending: "info",
  warning: "warning",
} as const satisfies Record<CloudSyncOfflineReachability["tone"], string>;

/**
 * The sync button, beside the other project-level controls in the header.
 *
 * Status is read whether or not the panel is open, unlike the usage report next
 * to it: the badge is the only warning a collaborator gets that the project
 * they are looking at has not finished arriving, and a badge that only appears
 * once somebody opens the panel warns nobody. Only a pass that is actually
 * moving polls; a settled sync costs one request per mount.
 */
export function CloudSyncBar({
  environmentId,
  projectId,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId | null;
}) {
  const [open, setOpen] = useState(false);
  const scope = useProjectCloudSyncScope(environmentId, projectId);
  const state = useCloudSync({ ...scope, enabled: true });
  /*
   * The tunnel is read here even though this control never starts one, because
   * it is the input that makes the honest answer different from the obvious
   * one: a live quick tunnel is the state in which a person is most certain
   * this project is reachable and most wrong about it.
   */
  const share = useWorkspaceShareState();

  // A project outside a shared workspace has nowhere to sync to.
  if (!scope.tenantId || !scope.workspaceId || !scope.projectId) {
    return null;
  }

  const headline = describeCloudSyncHeadline(state.sync);
  const waitBadge = cloudSyncWaitBadgeLabel(state.wait);
  const conflicts = state.sync?.conflictCount ?? 0;
  const reachability = describeOfflineReachability({
    sync: state.sync,
    liveLinkRunning: isWorkspaceShareLive(share.state.status),
  });
  /*
   * Withheld until the first read lands. A null `sync` before it means "not
   * asked yet" and after it means "nobody ever synced this", and the two would
   * render the same confident "no" — a wrong answer shown first is the one a
   * person remembers.
   */
  const showReachability = state.loaded && !state.readError;

  const Icon = state.sync
    ? headline.tone === "error"
      ? CloudAlertIcon
      : headline.tone === "busy"
        ? RefreshCwIcon
        : CloudIcon
    : CloudOffIcon;

  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger
        render={
          <Button
            size="xs"
            variant="outline"
            aria-label={open ? "Close cloud sync panel" : "Open cloud sync panel"}
            data-testid="cloud-sync-trigger"
            data-status={state.sync?.status ?? "none"}
            data-offline-reach={showReachability ? reachability.answer : "unknown"}
          />
        }
      >
        <Icon className={headline.tone === "busy" ? "size-3.5 animate-spin" : "size-3.5"} />
        <span className="hidden @2xl/header-actions:inline">Cloud</span>
        {waitBadge ? (
          <Badge size="sm" variant="warning" data-testid="cloud-sync-wait-badge">
            {waitBadge}
          </Badge>
        ) : conflicts > 0 ? (
          <Badge size="sm" variant="warning" data-testid="cloud-sync-trigger-conflicts">
            {conflicts}
          </Badge>
        ) : null}
      </PopoverTrigger>
      <PopoverPopup
        align="end"
        side="bottom"
        sideOffset={8}
        className="w-[min(26rem,calc(100vw-2rem))] p-3"
      >
        <div className="flex flex-col gap-3">
          {showReachability ? (
            <section
              className={cn(
                "rounded-md border p-2",
                reachability.reachable
                  ? "border-border bg-muted/30"
                  : "border-amber-500/40 bg-amber-500/8",
              )}
              data-testid="cloud-sync-offline-reach"
              data-answer={reachability.answer}
            >
              <div className="flex items-start justify-between gap-2">
                <span className="text-[10px] text-muted-foreground">
                  {CLOUD_SYNC_OFFLINE_QUESTION}
                </span>
                <Badge size="sm" variant={REACH_BADGE[reachability.tone]}>
                  {reachability.short}
                </Badge>
              </div>
              <div className="mt-1 text-xs font-medium text-foreground">{reachability.title}</div>
              <p className="mt-0.5 text-[10px] text-muted-foreground">{reachability.detail}</p>
            </section>
          ) : null}
          <CloudSyncPanel state={state} />
        </div>
      </PopoverPopup>
    </Popover>
  );
}
