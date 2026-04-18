import { createFileRoute, retainSearchParams, useNavigate } from "@tanstack/react-router";
import { Suspense, lazy, useCallback, useEffect, useMemo, useState } from "react";

import ChatView from "../components/ChatView";
import { threadHasStarted } from "../components/ChatView.logic";
import { DiffWorkerPoolProvider } from "../components/DiffWorkerPoolProvider";
import {
  DiffPanelHeaderSkeleton,
  DiffPanelLoadingState,
  DiffPanelShell,
  type DiffPanelMode,
} from "../components/DiffPanelShell";
import {
  WorkspacePanelLoadingState,
  WorkspacePanelShell,
  type WorkspacePanelMode,
} from "../components/WorkspacePanelShell";
import { finalizePromotedDraftThreadByRef, useComposerDraftStore } from "../composerDraftStore";
import {
  type DiffRouteSearch,
  parseDiffRouteSearch,
  stripDiffSearchParams,
} from "../diffRouteSearch";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY } from "../rightPanelLayout";
import { selectEnvironmentState, selectThreadExistsByRef, useStore } from "../store";
import { createThreadSelectorByRef } from "../storeSelectors";
import { resolveThreadRouteRef, buildThreadRouteParams } from "../threadRoutes";
import { RightPanelSheet } from "../components/RightPanelSheet";
import { useSettings } from "../hooks/useSettings";
import { Sidebar, SidebarInset, SidebarProvider, SidebarRail } from "~/components/ui/sidebar";

const DiffPanel = lazy(() => import("../components/DiffPanel"));
const WorkspacePanel = lazy(() => import("../components/WorkspacePanel"));
const RIGHT_PANEL_INLINE_SIDEBAR_WIDTH_STORAGE_KEY = "chat_right_panel_sidebar_width";
const RIGHT_PANEL_INLINE_DEFAULT_WIDTH = "clamp(30rem,52vw,72rem)";
const RIGHT_PANEL_INLINE_SIDEBAR_MIN_WIDTH = 28 * 16;
const COMPOSER_COMPACT_MIN_LEFT_CONTROLS_WIDTH_PX = 208;
type RightPanelKind = "diff" | "workspace";

const DiffLoadingFallback = (props: { mode: DiffPanelMode }) => {
  return (
    <DiffPanelShell mode={props.mode} header={<DiffPanelHeaderSkeleton />}>
      <DiffPanelLoadingState label="Loading diff viewer..." />
    </DiffPanelShell>
  );
};

const LazyDiffPanel = (props: { mode: DiffPanelMode }) => {
  return (
    <DiffWorkerPoolProvider>
      <Suspense fallback={<DiffLoadingFallback mode={props.mode} />}>
        <DiffPanel mode={props.mode} />
      </Suspense>
    </DiffWorkerPoolProvider>
  );
};

const WorkspaceLoadingFallback = (props: { mode: WorkspacePanelMode }) => {
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

const LazyWorkspacePanel = (props: { mode: WorkspacePanelMode }) => {
  return (
    <Suspense fallback={<WorkspaceLoadingFallback mode={props.mode} />}>
      <WorkspacePanel mode={props.mode} />
    </Suspense>
  );
};

const ThreadRightPanelInlineSidebar = (props: {
  open: boolean;
  side: "left" | "right";
  preferredPanel: RightPanelKind;
  onClose: () => void;
  onOpenPreferredPanel: () => void;
  renderDiffContent: boolean;
  renderWorkspaceContent: boolean;
}) => {
  const {
    open,
    onClose,
    onOpenPreferredPanel,
    preferredPanel,
    renderDiffContent,
    renderWorkspaceContent,
    side,
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
    ({ nextWidth, wrapper }: { nextWidth: number; wrapper: HTMLElement }) => {
      const composerForm = document.querySelector<HTMLElement>("[data-chat-composer-form='true']");
      if (!composerForm) return true;
      const composerViewport = composerForm.parentElement;
      if (!composerViewport) return true;
      const previousSidebarWidth = wrapper.style.getPropertyValue("--sidebar-width");
      wrapper.style.setProperty("--sidebar-width", `${nextWidth}px`);

      const viewportStyle = window.getComputedStyle(composerViewport);
      const viewportPaddingLeft = Number.parseFloat(viewportStyle.paddingLeft) || 0;
      const viewportPaddingRight = Number.parseFloat(viewportStyle.paddingRight) || 0;
      const viewportContentWidth = Math.max(
        0,
        composerViewport.clientWidth - viewportPaddingLeft - viewportPaddingRight,
      );
      const formRect = composerForm.getBoundingClientRect();
      const composerFooter = composerForm.querySelector<HTMLElement>(
        "[data-chat-composer-footer='true']",
      );
      const composerRightActions = composerForm.querySelector<HTMLElement>(
        "[data-chat-composer-actions='right']",
      );
      const composerRightActionsWidth = composerRightActions?.getBoundingClientRect().width ?? 0;
      const composerFooterGap = composerFooter
        ? Number.parseFloat(window.getComputedStyle(composerFooter).columnGap) ||
          Number.parseFloat(window.getComputedStyle(composerFooter).gap) ||
          0
        : 0;
      const minimumComposerWidth =
        COMPOSER_COMPACT_MIN_LEFT_CONTROLS_WIDTH_PX + composerRightActionsWidth + composerFooterGap;
      const hasComposerOverflow = composerForm.scrollWidth > composerForm.clientWidth + 0.5;
      const overflowsViewport = formRect.width > viewportContentWidth + 0.5;
      const violatesMinimumComposerWidth = composerForm.clientWidth + 0.5 < minimumComposerWidth;

      if (previousSidebarWidth.length > 0) {
        wrapper.style.setProperty("--sidebar-width", previousSidebarWidth);
      } else {
        wrapper.style.removeProperty("--sidebar-width");
      }

      return !hasComposerOverflow && !overflowsViewport && !violatesMinimumComposerWidth;
    },
    [],
  );

  return (
    <SidebarProvider
      defaultOpen={false}
      open={open}
      onOpenChange={onOpenChange}
      className="w-auto min-h-0 flex-none bg-transparent"
      data-layout-column="workspace"
      style={{ "--sidebar-width": RIGHT_PANEL_INLINE_DEFAULT_WIDTH } as React.CSSProperties}
    >
      <Sidebar
        side={side}
        collapsible="offcanvas"
        className={`${side === "left" ? "border-r" : "border-l"} border-border bg-card text-foreground`}
        resizable={{
          minWidth: RIGHT_PANEL_INLINE_SIDEBAR_MIN_WIDTH,
          shouldAcceptWidth: shouldAcceptInlineSidebarWidth,
          storageKey: RIGHT_PANEL_INLINE_SIDEBAR_WIDTH_STORAGE_KEY,
        }}
      >
        {renderDiffContent && preferredPanel === "diff" ? <LazyDiffPanel mode="sidebar" /> : null}
        {renderWorkspaceContent && preferredPanel === "workspace" ? (
          <LazyWorkspacePanel mode="sidebar" />
        ) : null}
        <SidebarRail />
      </Sidebar>
    </SidebarProvider>
  );
};

function ChatThreadRouteView() {
  const navigate = useNavigate();
  const desktopLayoutMode = useSettings((settings) => settings.desktopLayoutMode);
  const threadRef = Route.useParams({
    select: (params) => resolveThreadRouteRef(params),
  });
  const search = Route.useSearch();
  const bootstrapComplete = useStore(
    (store) => selectEnvironmentState(store, threadRef?.environmentId ?? null).bootstrapComplete,
  );
  const serverThread = useStore(useMemo(() => createThreadSelectorByRef(threadRef), [threadRef]));
  const threadExists = useStore((store) => selectThreadExistsByRef(store, threadRef));
  const environmentHasServerThreads = useStore(
    (store) => selectEnvironmentState(store, threadRef?.environmentId ?? null).threadIds.length > 0,
  );
  const draftThreadExists = useComposerDraftStore((store) =>
    threadRef ? store.getDraftThreadByRef(threadRef) !== null : false,
  );
  const draftThread = useComposerDraftStore((store) =>
    threadRef ? store.getDraftThreadByRef(threadRef) : null,
  );
  const environmentHasDraftThreads = useComposerDraftStore((store) => {
    if (!threadRef) {
      return false;
    }
    return store.hasDraftThreadsInEnvironment(threadRef.environmentId);
  });
  const routeThreadExists = threadExists || draftThreadExists;
  const serverThreadStarted = threadHasStarted(serverThread);
  const environmentHasAnyThreads = environmentHasServerThreads || environmentHasDraftThreads;
  const workspaceOpen = search.workspace === "1";
  const diffOpen = search.diff === "1";
  const shouldUseDiffSheet = useMediaQuery(RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY);
  const currentThreadKey = threadRef ? `${threadRef.environmentId}:${threadRef.threadId}` : null;
  const [diffPanelMountState, setDiffPanelMountState] = useState(() => ({
    threadKey: currentThreadKey,
    hasOpenedDiff: diffOpen,
    hasOpenedWorkspace: workspaceOpen,
    lastOpenedPanel: (workspaceOpen ? "workspace" : "diff") as RightPanelKind,
  }));
  const hasOpenedDiff =
    diffPanelMountState.threadKey === currentThreadKey
      ? diffPanelMountState.hasOpenedDiff
      : diffOpen;
  const hasOpenedWorkspace =
    diffPanelMountState.threadKey === currentThreadKey
      ? diffPanelMountState.hasOpenedWorkspace
      : workspaceOpen;
  const preferredPanel =
    diffPanelMountState.threadKey === currentThreadKey
      ? diffPanelMountState.lastOpenedPanel
      : workspaceOpen
        ? "workspace"
        : "diff";
  const markRightPanelOpened = useCallback(
    (panel: RightPanelKind) => {
      setDiffPanelMountState((previous) => {
        if (
          previous.threadKey === currentThreadKey &&
          previous.lastOpenedPanel === panel &&
          ((panel === "diff" && previous.hasOpenedDiff) ||
            (panel === "workspace" && previous.hasOpenedWorkspace))
        ) {
          return previous;
        }
        return {
          threadKey: currentThreadKey,
          hasOpenedDiff:
            previous.threadKey === currentThreadKey
              ? previous.hasOpenedDiff || panel === "diff"
              : panel === "diff",
          hasOpenedWorkspace:
            previous.threadKey === currentThreadKey
              ? previous.hasOpenedWorkspace || panel === "workspace"
              : panel === "workspace",
          lastOpenedPanel: panel,
        };
      });
    },
    [currentThreadKey],
  );
  const markDiffOpened = useCallback(() => {
    markRightPanelOpened("diff");
  }, [markRightPanelOpened]);
  const markWorkspaceOpened = useCallback(() => {
    markRightPanelOpened("workspace");
  }, [markRightPanelOpened]);
  const closeDiff = useCallback(() => {
    if (!threadRef) {
      return;
    }
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(threadRef),
      search: stripDiffSearchParams,
    });
  }, [navigate, threadRef]);
  const openDiff = useCallback(() => {
    if (!threadRef) {
      return;
    }
    markDiffOpened();
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(threadRef),
      search: (previous) => {
        const rest = stripDiffSearchParams(previous);
        return { ...rest, diff: "1" };
      },
    });
  }, [markDiffOpened, navigate, threadRef]);
  const openWorkspace = useCallback(() => {
    if (!threadRef) {
      return;
    }
    markWorkspaceOpened();
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(threadRef),
      search: (previous) => {
        const rest = stripDiffSearchParams(previous);
        return { ...rest, workspace: "1" };
      },
    });
  }, [markWorkspaceOpened, navigate, threadRef]);

  useEffect(() => {
    if (!threadRef || !bootstrapComplete) {
      return;
    }

    if (!routeThreadExists && environmentHasAnyThreads) {
      void navigate({ to: "/", replace: true });
    }
  }, [bootstrapComplete, environmentHasAnyThreads, navigate, routeThreadExists, threadRef]);

  useEffect(() => {
    if (!threadRef || !serverThreadStarted || !draftThread?.promotedTo) {
      return;
    }
    finalizePromotedDraftThreadByRef(threadRef);
  }, [draftThread?.promotedTo, serverThreadStarted, threadRef]);

  if (!threadRef || !bootstrapComplete || !routeThreadExists) {
    return null;
  }

  const shouldRenderDiffContent = diffOpen || hasOpenedDiff;
  const shouldRenderWorkspaceContent = workspaceOpen || hasOpenedWorkspace;
  const rightPanelOpen = diffOpen || workspaceOpen;
  const inlinePanelSide = desktopLayoutMode === "dev" ? "left" : "right";
  const chatColumn = (
    <SidebarInset
      className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground"
      data-layout-column="chat"
    >
      <ChatView
        environmentId={threadRef.environmentId}
        threadId={threadRef.threadId}
        onDiffPanelOpen={markDiffOpened}
        onWorkspacePanelOpen={markWorkspaceOpened}
        reserveTitleBarControlInset={!rightPanelOpen}
        routeKind="server"
      />
    </SidebarInset>
  );
  const inlineWorkspaceColumn = (
    <ThreadRightPanelInlineSidebar
      open={rightPanelOpen}
      side={inlinePanelSide}
      preferredPanel={preferredPanel}
      onClose={closeDiff}
      onOpenPreferredPanel={preferredPanel === "workspace" ? openWorkspace : openDiff}
      renderDiffContent={shouldRenderDiffContent}
      renderWorkspaceContent={shouldRenderWorkspaceContent}
    />
  );

  if (!shouldUseDiffSheet) {
    return (
      <>
        {desktopLayoutMode === "dev" ? inlineWorkspaceColumn : chatColumn}
        {desktopLayoutMode === "dev" ? chatColumn : inlineWorkspaceColumn}
      </>
    );
  }

  return (
    <>
      <SidebarInset
        className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground"
        data-layout-column="chat"
      >
        <ChatView
          environmentId={threadRef.environmentId}
          threadId={threadRef.threadId}
          onDiffPanelOpen={markDiffOpened}
          onWorkspacePanelOpen={markWorkspaceOpened}
          routeKind="server"
        />
      </SidebarInset>
      <RightPanelSheet open={rightPanelOpen} onClose={closeDiff}>
        {shouldRenderDiffContent && preferredPanel === "diff" ? (
          <LazyDiffPanel mode="sheet" />
        ) : null}
        {shouldRenderWorkspaceContent && preferredPanel === "workspace" ? (
          <LazyWorkspacePanel mode="sheet" />
        ) : null}
      </RightPanelSheet>
    </>
  );
}

export const Route = createFileRoute("/_chat/$environmentId/$threadId")({
  validateSearch: (search) => parseDiffRouteSearch(search),
  search: {
    middlewares: [retainSearchParams<DiffRouteSearch>(["diff", "workspace"])],
  },
  component: ChatThreadRouteView,
});
