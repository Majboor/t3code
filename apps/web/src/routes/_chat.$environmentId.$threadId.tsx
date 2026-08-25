import { createFileRoute, retainSearchParams, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import { cn } from "../lib/utils";
import { resolveDesktopLayoutModeDefinition } from "../desktopLayoutModes";

import ChatView from "../components/ChatView";
import { threadHasStarted } from "../components/ChatView.logic";
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
import { selectThreadTerminalState, useTerminalStateStore } from "../terminalStateStore";
import { resolveThreadRouteRef, buildThreadRouteParams } from "../threadRoutes";
import {
  useDesktopLayoutPanelPreferences,
  useProjectSidebarOpen,
} from "../components/AppSidebarLayout.logic";
import { RightPanelSheet } from "../components/RightPanelSheet";
import {
  COMPACT_CHAT_MIN_HEIGHT_PX,
  COMPACT_PANEL_MIN_HEIGHT_PX,
  LazyDiffPanel,
  LazyWorkspacePanel,
  ThreadRightPanelInlineSidebar,
  type RightPanelKind,
} from "../components/chat/RightPanelInlineSidebar";
import { useSettings, useUpdateSettings } from "../hooks/useSettings";
import { SidebarInset } from "~/components/ui/sidebar";

function ChatThreadRouteView() {
  const navigate = useNavigate();
  const desktopLayoutMode = useSettings((settings) => settings.desktopLayoutMode);
  const desktopLayoutDefinition = useSettings((settings) =>
    resolveDesktopLayoutModeDefinition(settings),
  );
  const { updateSettings } = useUpdateSettings();
  const { setPanelPreferenceForMode } = useDesktopLayoutPanelPreferences();
  const threadRef = Route.useParams({
    select: (params) => resolveThreadRouteRef(params),
  });
  const [projectSidebarOpen] = useProjectSidebarOpen(desktopLayoutMode);
  const terminalOpen = useTerminalStateStore(
    (state) => selectThreadTerminalState(state.terminalStateByThreadKey, threadRef).terminalOpen,
  );
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
  const [devTerminalHost, setDevTerminalHost] = useState<HTMLDivElement | null>(null);
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

  useEffect(() => {
    if (diffOpen) {
      markDiffOpened();
      return;
    }
    if (workspaceOpen) {
      markWorkspaceOpened();
    }
  }, [diffOpen, markDiffOpened, markWorkspaceOpened, workspaceOpen]);

  const closeDiff = useCallback(() => {
    if (!threadRef) {
      return;
    }
    setPanelPreferenceForMode(desktopLayoutMode, "none");
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(threadRef),
      search: (previous) => ({
        ...stripDiffSearchParams(previous),
        diff: undefined,
        diffFilePath: undefined,
        diffTurnId: undefined,
        workspace: undefined,
      }),
    });
  }, [desktopLayoutMode, navigate, setPanelPreferenceForMode, threadRef]);
  const closeWorkspace = useCallback(() => {
    if (!threadRef) {
      return;
    }
    setPanelPreferenceForMode(desktopLayoutMode, "none");
    if (desktopLayoutDefinition.layout === "dev") {
      updateSettings({ desktopLayoutMode: "vibe" });
    }
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(threadRef),
      search: (previous) => ({
        ...stripDiffSearchParams(previous),
        diff: undefined,
        diffFilePath: undefined,
        diffTurnId: undefined,
        workspace: undefined,
      }),
    });
  }, [
    desktopLayoutDefinition.layout,
    desktopLayoutMode,
    navigate,
    setPanelPreferenceForMode,
    threadRef,
    updateSettings,
  ]);
  const openDiff = useCallback(() => {
    if (!threadRef) {
      return;
    }
    markDiffOpened();
    setPanelPreferenceForMode(desktopLayoutMode, "diff");
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(threadRef),
      search: (previous) => {
        const rest = stripDiffSearchParams(previous);
        return {
          ...rest,
          diff: "1",
          diffFilePath: undefined,
          diffTurnId: undefined,
          workspace: undefined,
        };
      },
    });
  }, [desktopLayoutMode, markDiffOpened, navigate, setPanelPreferenceForMode, threadRef]);
  const openWorkspace = useCallback(() => {
    if (!threadRef) {
      return;
    }
    markWorkspaceOpened();
    setPanelPreferenceForMode(desktopLayoutMode, "workspace");
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(threadRef),
      search: (previous) => {
        const rest = stripDiffSearchParams(previous);
        return {
          ...rest,
          diff: undefined,
          diffFilePath: undefined,
          diffTurnId: undefined,
          workspace: "1",
        };
      },
    });
  }, [desktopLayoutMode, markWorkspaceOpened, navigate, setPanelPreferenceForMode, threadRef]);

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

  const shouldRenderDiffContent = diffOpen || hasOpenedDiff;
  const shouldRenderWorkspaceContent = workspaceOpen || hasOpenedWorkspace;
  const rightPanelOpen = diffOpen || workspaceOpen;
  const activePanel: RightPanelKind = diffOpen
    ? "diff"
    : workspaceOpen
      ? "workspace"
      : preferredPanel;
  const shouldUseCompactRightPanelLayout = shouldUseDiffSheet && rightPanelOpen;
  const threadIsRunning = serverThread?.session?.orchestrationStatus === "running";
  const compactPanelDefaultHeightVh =
    activePanel === "workspace" ? (threadIsRunning ? 42 : 56) : 48;
  const [compactPanelHeightVhByPanel, setCompactPanelHeightVhByPanel] = useState<
    Record<RightPanelKind, number>
  >({
    diff: 48,
    workspace: 56,
  });
  const compactPanelResizeRef = useRef<{
    pointerId: number;
    startY: number;
    startHeightPx: number;
  } | null>(null);
  const compactPanelHeightVh = compactPanelHeightVhByPanel[activePanel];
  const setCompactPanelHeightFromPx = useCallback((panel: RightPanelKind, nextHeightPx: number) => {
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
    const maxHeightPx = Math.max(
      COMPACT_PANEL_MIN_HEIGHT_PX,
      viewportHeight - COMPACT_CHAT_MIN_HEIGHT_PX,
    );
    const clampedHeightPx = Math.min(
      Math.max(nextHeightPx, COMPACT_PANEL_MIN_HEIGHT_PX),
      maxHeightPx,
    );
    const nextHeightVh = (clampedHeightPx / Math.max(viewportHeight, 1)) * 100;
    setCompactPanelHeightVhByPanel((current) => ({
      ...current,
      [panel]: Number(nextHeightVh.toFixed(2)),
    }));
  }, []);
  const startCompactPanelResize = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (!shouldUseCompactRightPanelLayout) {
        return;
      }
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
      compactPanelResizeRef.current = {
        pointerId: event.pointerId,
        startY: event.clientY,
        startHeightPx: (compactPanelHeightVh / 100) * viewportHeight,
      };
    },
    [compactPanelHeightVh, shouldUseCompactRightPanelLayout],
  );
  const moveCompactPanelResize = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      const resize = compactPanelResizeRef.current;
      if (!resize || resize.pointerId !== event.pointerId) {
        return;
      }
      setCompactPanelHeightFromPx(
        activePanel,
        resize.startHeightPx + event.clientY - resize.startY,
      );
    },
    [activePanel, setCompactPanelHeightFromPx],
  );
  const stopCompactPanelResize = useCallback((event: PointerEvent<HTMLDivElement>) => {
    const resize = compactPanelResizeRef.current;
    if (!resize || resize.pointerId !== event.pointerId) {
      return;
    }
    compactPanelResizeRef.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
  }, []);

  if (!threadRef || !bootstrapComplete || !routeThreadExists) {
    return null;
  }

  const inlinePanelSide = desktopLayoutDefinition.layout === "dev" ? "left" : "right";
  const isInlineDevLayout = !shouldUseDiffSheet && desktopLayoutDefinition.layout === "dev";
  const chatColumn = (
    <SidebarInset
      className={cn(
        "min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground",
        shouldUseCompactRightPanelLayout ? "h-full flex-1" : isInlineDevLayout ? "flex-1" : "h-dvh",
      )}
      data-layout-column="chat"
    >
      <ChatView
        environmentId={threadRef.environmentId}
        threadId={threadRef.threadId}
        onDiffPanelOpen={markDiffOpened}
        onWorkspacePanelOpen={markWorkspaceOpened}
        reserveTitleBarControlInset={!rightPanelOpen}
        routeKind="server"
        terminalPortalHost={isInlineDevLayout ? devTerminalHost : null}
        compactComposerWhenIdle={shouldUseCompactRightPanelLayout}
      />
    </SidebarInset>
  );
  const inlineWorkspaceColumn = (
    <ThreadRightPanelInlineSidebar
      open={rightPanelOpen}
      side={inlinePanelSide}
      preferredPanel={activePanel}
      onClose={activePanel === "workspace" ? closeWorkspace : closeDiff}
      onOpenPreferredPanel={activePanel === "workspace" ? openWorkspace : openDiff}
      renderDiffContent={shouldRenderDiffContent}
      renderWorkspaceContent={shouldRenderWorkspaceContent}
      projectSidebarOpen={projectSidebarOpen}
      revalidateWidthOn={
        desktopLayoutDefinition.layout === "dev" ? `${projectSidebarOpen}:${terminalOpen}` : null
      }
      terminalOpen={terminalOpen}
    />
  );

  if (shouldUseCompactRightPanelLayout) {
    return (
      <div className="flex h-dvh min-h-0 min-w-0 flex-1 flex-col bg-background">
        <div
          className="relative shrink-0 overflow-hidden border-b border-border bg-background transition-[height] duration-500 ease-out motion-reduce:transition-none"
          data-layout-column={activePanel}
          style={{
            height: `clamp(${COMPACT_PANEL_MIN_HEIGHT_PX}px, ${compactPanelHeightVh || compactPanelDefaultHeightVh}dvh, calc(100dvh - ${COMPACT_CHAT_MIN_HEIGHT_PX}px))`,
          }}
        >
          {activePanel === "diff" && shouldRenderDiffContent ? (
            <LazyDiffPanel mode="compact" onClose={closeDiff} />
          ) : null}
          {activePanel === "workspace" && shouldRenderWorkspaceContent ? (
            <LazyWorkspacePanel mode="compact" onClose={closeWorkspace} onOpenDiff={openDiff} />
          ) : null}
          <div
            role="separator"
            aria-label="Resize panel"
            aria-orientation="horizontal"
            className="absolute inset-x-0 bottom-[-5px] z-20 flex h-2 cursor-row-resize items-center justify-center"
            onPointerDown={startCompactPanelResize}
            onPointerMove={moveCompactPanelResize}
            onPointerUp={stopCompactPanelResize}
            onPointerCancel={stopCompactPanelResize}
          >
            <div className="h-px w-12 rounded-full bg-border transition-colors" />
          </div>
        </div>
        <div className="flex min-h-[14rem] min-w-0 flex-1 overflow-hidden">{chatColumn}</div>
      </div>
    );
  }

  if (!shouldUseDiffSheet) {
    if (desktopLayoutDefinition.layout === "dev") {
      return (
        <div className="flex h-dvh min-h-0 min-w-0 flex-1 flex-col" data-layout-column="dev-main">
          <div className="flex min-h-0 min-w-0 flex-1">
            {inlineWorkspaceColumn}
            {chatColumn}
          </div>
          <div
            ref={setDevTerminalHost}
            data-slot="dev-terminal-host"
            className="flex min-w-0 shrink-0 flex-col"
          />
        </div>
      );
    }
    return (
      <>
        {chatColumn}
        {inlineWorkspaceColumn}
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
      <RightPanelSheet
        open={rightPanelOpen}
        onClose={activePanel === "workspace" ? closeWorkspace : closeDiff}
      >
        {shouldRenderDiffContent && activePanel === "diff" ? (
          <LazyDiffPanel mode="sheet" onClose={closeDiff} />
        ) : null}
        {shouldRenderWorkspaceContent && activePanel === "workspace" ? (
          <LazyWorkspacePanel mode="sheet" onClose={closeWorkspace} />
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
