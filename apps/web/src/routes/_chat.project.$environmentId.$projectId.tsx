import { createFileRoute } from "@tanstack/react-router";
import { Suspense, lazy } from "react";

import { WorkspacePanelLoadingState, WorkspacePanelShell } from "../components/WorkspacePanelShell";
import { SidebarInset } from "~/components/ui/sidebar";

const WorkspacePanel = lazy(() => import("../components/WorkspacePanel"));

const WorkspaceLoadingFallback = () => {
  return (
    <WorkspacePanelShell
      mode="inline"
      header={
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-foreground">Workspace</div>
          <div className="text-[11px] text-muted-foreground/70">Loading editor…</div>
        </div>
      }
    >
      <WorkspacePanelLoadingState label="Loading workspace editor..." />
    </WorkspacePanelShell>
  );
};

function ProjectWorkspaceRouteView() {
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <Suspense fallback={<WorkspaceLoadingFallback />}>
        <WorkspacePanel mode="inline" />
      </Suspense>
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_chat/project/$environmentId/$projectId")({
  component: ProjectWorkspaceRouteView,
});
