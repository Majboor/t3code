import {
  WorkspaceId,
  type EnvironmentId,
  type OrchestrationProjectOwnership,
  type ProjectId,
} from "@t3tools/contracts";
import { GaugeIcon } from "lucide-react";
import { useState } from "react";

import { useCollaborationUsage } from "../../hooks/useCollaborationUsage";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { UsagePanel } from "./usage/UsagePanel";
import { useUsagePanelSettings } from "./usage/usagePanel.logic";

/**
 * The sibling of the Collab button: what this workspace has spent, rather than
 * who is in it. Kept out of the collaboration popover because the two answer
 * different questions and the usage report costs a request the other does not.
 */
export function CollaborationUsageBar({
  environmentId,
  ownership,
  projectId,
}: {
  environmentId: EnvironmentId;
  ownership?: OrchestrationProjectOwnership | null | undefined;
  projectId: ProjectId | null;
}) {
  const [open, setOpen] = useState(false);
  const [settings] = useUsagePanelSettings();

  const workspaceId = ownership?.workspaceId ?? (projectId ? WorkspaceId.make(projectId) : null);
  const tenantId = ownership?.tenantId ?? null;

  // Fetched only while the panel is open, and held for long enough that
  // reopening it is free. Nothing here runs on a timer.
  const usage = useCollaborationUsage({
    environmentId,
    tenantId,
    workspaceId,
    enabled: open,
  });

  if (!settings.enabled || !tenantId || !workspaceId || !projectId) {
    return null;
  }

  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger
        render={
          <Button
            size="xs"
            variant="outline"
            aria-label={open ? "Close usage panel" : "Open usage panel"}
            data-testid="collaboration-usage-trigger"
          />
        }
      >
        <GaugeIcon className="size-3.5" />
        <span className="hidden @2xl/header-actions:inline">Usage</span>
      </PopoverTrigger>
      <PopoverPopup
        align="end"
        side="bottom"
        sideOffset={8}
        className="w-[min(24rem,calc(100vw-2rem))]"
      >
        <UsagePanel
          usage={usage.data}
          loading={usage.isPending}
          error={usage.error instanceof Error ? usage.error : null}
          onRefresh={() => void usage.refetch()}
          refreshing={usage.isFetching}
        />
      </PopoverPopup>
    </Popover>
  );
}
