import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { CloudAlertIcon, CloudIcon, CloudOffIcon, RefreshCwIcon } from "lucide-react";
import { useState } from "react";

import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { cloudSyncWaitBadgeLabel, describeCloudSyncHeadline } from "./cloudSync.logic";
import { CloudSyncPanel } from "./CloudSyncPanel";
import { useCloudSync } from "./useCloudSync";
import { useProjectCloudSyncScope } from "./useProjectCloudSyncScope";

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

  // A project outside a shared workspace has nowhere to sync to.
  if (!scope.tenantId || !scope.workspaceId || !scope.projectId) {
    return null;
  }

  const headline = describeCloudSyncHeadline(state.sync);
  const waitBadge = cloudSyncWaitBadgeLabel(state.wait);
  const conflicts = state.sync?.conflictCount ?? 0;

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
        <CloudSyncPanel state={state} />
      </PopoverPopup>
    </Popover>
  );
}
