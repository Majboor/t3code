/**
 * The right-hand panel, as a column rather than a sheet.
 *
 * This lived inside the thread route, which is why a draft thread never had it:
 * that route rendered the workspace as a sheet and nothing else, so the panel
 * covered the chat no matter how wide the window was. Both routes now choose
 * between the same column and the same sheet.
 *
 * @module components/chat/RightPanelInlineSidebar
 */
import { Suspense, lazy, useCallback } from "react";

import { DiffWorkerPoolProvider } from "../DiffWorkerPoolProvider";
import {
  DiffPanelHeaderSkeleton,
  DiffPanelLoadingState,
  DiffPanelShell,
  type DiffPanelMode,
} from "../DiffPanelShell";
import {
  WorkspacePanelLoadingState,
  WorkspacePanelShell,
  type WorkspacePanelMode,
} from "../WorkspacePanelShell";
import { WORKSPACE_INLINE_SIDEBAR_WIDTH_STORAGE_KEY } from "../AppSidebarLayout.logic";
import { canAcceptInlineWorkspaceSidebarWidth } from "../../lib/inlineWorkspaceSidebarLayout";
import { Sidebar, SidebarProvider, SidebarRail } from "~/components/ui/sidebar";

const DiffPanel = lazy(() => import("../DiffPanel"));
const WorkspacePanel = lazy(() => import("../WorkspacePanel"));
export const RIGHT_PANEL_INLINE_DEFAULT_WIDTH = "clamp(22rem,52vw,72rem)";
export const RIGHT_PANEL_INLINE_SIDEBAR_MIN_WIDTH = 20 * 16;
export const COMPACT_PANEL_MIN_HEIGHT_PX = 180;
export const COMPACT_CHAT_MIN_HEIGHT_PX = 220;
export type RightPanelKind = "diff" | "workspace";

export const DiffLoadingFallback = (props: { mode: DiffPanelMode }) => {
  return (
    <DiffPanelShell mode={props.mode} header={<DiffPanelHeaderSkeleton />}>
      <DiffPanelLoadingState label="Loading diff viewer..." />
    </DiffPanelShell>
  );
};

export const LazyDiffPanel = (props: { mode: DiffPanelMode; onClose?: () => void }) => {
  return (
    <DiffWorkerPoolProvider>
      <Suspense fallback={<DiffLoadingFallback mode={props.mode} />}>
        <DiffPanel mode={props.mode} {...(props.onClose ? { onClose: props.onClose } : {})} />
      </Suspense>
    </DiffWorkerPoolProvider>
  );
};

export const WorkspaceLoadingFallback = (props: { mode: WorkspacePanelMode }) => {
  return (
    <WorkspacePanelShell
      mode={props.mode}
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

export const LazyWorkspacePanel = (props: {
  mode: WorkspacePanelMode;
  onClose?: () => void;
  onOpenDiff?: () => void;
}) => {
  return (
    <Suspense fallback={<WorkspaceLoadingFallback mode={props.mode} />}>
      <WorkspacePanel
        mode={props.mode}
        {...(props.onClose ? { onClose: props.onClose } : {})}
        {...(props.onOpenDiff ? { onOpenDiff: props.onOpenDiff } : {})}
      />
    </Suspense>
  );
};

export const ThreadRightPanelInlineSidebar = (props: {
  open: boolean;
  side: "left" | "right";
  preferredPanel: RightPanelKind;
  onClose: () => void;
  onOpenPreferredPanel: () => void;
  renderDiffContent: boolean;
  renderWorkspaceContent: boolean;
  projectSidebarOpen: boolean;
  revalidateWidthOn?: unknown;
  terminalOpen: boolean;
}) => {
  const {
    open,
    onClose,
    onOpenPreferredPanel,
    preferredPanel,
    projectSidebarOpen,
    renderDiffContent,
    renderWorkspaceContent,
    revalidateWidthOn,
    side,
    terminalOpen,
  } = props;
  const onOpenChange = useCallback(
    (open: boolean) => {
      if (open) {
        onOpenPreferredPanel();
        return;
      }
      onClose();
    },
    [onClose, onOpenPreferredPanel],
  );
  const shouldAcceptInlineSidebarWidth = useCallback(
    ({
      currentWidth,
      nextWidth,
      phase,
      wrapper,
    }: {
      currentWidth: number;
      nextWidth: number;
      phase: "drag" | "guard";
      wrapper: HTMLElement;
    }) => {
      return canAcceptInlineWorkspaceSidebarWidth({
        currentWidth,
        measureWithoutMutatingLayout: phase === "guard",
        nextWidth,
        projectsSidebarOpen: projectSidebarOpen,
        terminalOpen,
        wrapper,
      });
    },
    [projectSidebarOpen, terminalOpen],
  );

  return (
    <SidebarProvider
      defaultOpen={false}
      open={open}
      onOpenChange={onOpenChange}
      className="w-auto min-h-0 flex-none bg-transparent transition-[width] duration-500 ease-out motion-reduce:transition-none"
      data-layout-column={preferredPanel}
      style={{ "--sidebar-width": RIGHT_PANEL_INLINE_DEFAULT_WIDTH } as React.CSSProperties}
    >
      <Sidebar
        side={side}
        collapsible="offcanvas"
        desktopPosition="inline"
        className={`${side === "left" ? "border-r" : "border-l"} border-border bg-card text-foreground`}
        revalidateWidthOn={revalidateWidthOn}
        resizable={{
          minWidth: RIGHT_PANEL_INLINE_SIDEBAR_MIN_WIDTH,
          shouldAcceptWidth: shouldAcceptInlineSidebarWidth,
          storageKey: WORKSPACE_INLINE_SIDEBAR_WIDTH_STORAGE_KEY,
        }}
      >
        {renderDiffContent && preferredPanel === "diff" ? (
          <LazyDiffPanel mode="sidebar" onClose={onClose} />
        ) : null}
        {renderWorkspaceContent && preferredPanel === "workspace" ? (
          <LazyWorkspacePanel mode="sidebar" onClose={onClose} />
        ) : null}
        <SidebarRail />
      </Sidebar>
    </SidebarProvider>
  );
};
