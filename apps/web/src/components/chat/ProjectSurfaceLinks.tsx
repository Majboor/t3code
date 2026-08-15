import { ChartNoAxesColumnIcon, ServerIcon } from "lucide-react";
import type { ProjectId } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";

import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/**
 * Infrastructure and analytics, reachable from the thread.
 *
 * Both pages already existed and both were linked only from the workspace
 * dashboard. Someone deploying a pack does it from a thread and stays there, so
 * the numbers their deployment reports were a page they had to know existed and
 * navigate away to find.
 */
export function ProjectSurfaceLinks({ projectId }: { projectId: ProjectId }) {
  return (
    <div className="flex shrink-0 items-center gap-0.5">
      <Tooltip>
        <TooltipTrigger
          render={
            <Link
              to="/infra/$projectId"
              params={{ projectId }}
              aria-label="Infrastructure for this project"
              data-testid="chat-header-infra-link"
              className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none"
            />
          }
        >
          <ServerIcon className="size-3.5" />
        </TooltipTrigger>
        <TooltipPopup>Infrastructure — what this project has turned on and deployed</TooltipPopup>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={
            <Link
              to="/analytics/$projectId"
              params={{ projectId }}
              aria-label="Analytics for this project"
              data-testid="chat-header-analytics-link"
              className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none"
            />
          }
        >
          <ChartNoAxesColumnIcon className="size-3.5" />
        </TooltipTrigger>
        <TooltipPopup>Analytics — what its live deployments are reporting</TooltipPopup>
      </Tooltip>
    </div>
  );
}
