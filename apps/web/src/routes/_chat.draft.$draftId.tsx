import { createFileRoute, retainSearchParams, useNavigate } from "@tanstack/react-router";
import { Suspense, lazy, useCallback, useEffect, useMemo } from "react";
import ChatView from "../components/ChatView";
import { threadHasStarted } from "../components/ChatView.logic";
import { useComposerDraftStore, DraftId } from "../composerDraftStore";
import { SidebarInset } from "../components/ui/sidebar";
import { createThreadSelectorAcrossEnvironments } from "../storeSelectors";
import { useStore } from "../store";
import { buildThreadRouteParams } from "../threadRoutes";
import { RightPanelSheet } from "../components/RightPanelSheet";
import { WorkspacePanelLoadingState, WorkspacePanelShell } from "../components/WorkspacePanelShell";
import {
  type DiffRouteSearch,
  parseDiffRouteSearch,
  stripDiffSearchParams,
} from "../diffRouteSearch";
import { resolveDesktopLayoutModeDefinition } from "../desktopLayoutModes";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { useSettings } from "../hooks/useSettings";
import { RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY } from "../rightPanelLayout";
import { selectThreadTerminalState, useTerminalStateStore } from "../terminalStateStore";
import { useProjectSidebarOpen } from "../components/AppSidebarLayout.logic";
import { ThreadRightPanelInlineSidebar } from "../components/chat/RightPanelInlineSidebar";

const WorkspacePanel = lazy(() => import("../components/WorkspacePanel"));

const DraftWorkspaceLoadingFallback = () => {
  return (
    <WorkspacePanelShell
      mode="sheet"
      header={
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-foreground">Workspace</div>
          <div className="text-[11px] text-muted-foreground/70">Loading editor...</div>
        </div>
      }
    >
      <WorkspacePanelLoadingState label="Loading workspace editor..." />
    </WorkspacePanelShell>
  );
};

function DraftChatThreadRouteView() {
  const navigate = useNavigate();
  const search = Route.useSearch();
  const { draftId: rawDraftId } = Route.useParams();
  const draftId = DraftId.make(rawDraftId);
  const workspaceOpen = search.workspace === "1";
  const draftSession = useComposerDraftStore((store) => store.getDraftSession(draftId));
  const desktopLayoutMode = useSettings((settings) => settings.desktopLayoutMode);
  const desktopLayoutDefinition = useSettings((settings) =>
    resolveDesktopLayoutModeDefinition(settings),
  );
  const [projectSidebarOpen] = useProjectSidebarOpen(desktopLayoutMode);
  // Narrow windows still get the sheet: a column here would leave neither side
  // usable, which is the reason the sheet exists at all.
  const shouldUseSheet = useMediaQuery(RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY);
  const terminalOpen = useTerminalStateStore((state) =>
    draftSession
      ? selectThreadTerminalState(state.terminalStateByThreadKey, {
          environmentId: draftSession.environmentId,
          threadId: draftSession.threadId,
        }).terminalOpen
      : false,
  );
  const serverThread = useStore(
    useMemo(
      () => createThreadSelectorAcrossEnvironments(draftSession?.threadId ?? null),
      [draftSession?.threadId],
    ),
  );
  const serverThreadStarted = threadHasStarted(serverThread);
  const canonicalThreadRef = useMemo(
    () =>
      draftSession?.promotedTo
        ? serverThreadStarted
          ? draftSession.promotedTo
          : null
        : serverThread
          ? {
              environmentId: serverThread.environmentId,
              threadId: serverThread.id,
            }
          : null,
    [draftSession?.promotedTo, serverThread, serverThreadStarted],
  );

  useEffect(() => {
    if (!canonicalThreadRef) {
      return;
    }
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(canonicalThreadRef),
      replace: true,
      search: (previous) => ({
        ...stripDiffSearchParams((previous ?? {}) as Record<string, unknown>),
        ...(workspaceOpen ? { workspace: "1" as const } : {}),
      }),
    });
  }, [canonicalThreadRef, navigate, workspaceOpen]);

  useEffect(() => {
    if (draftSession || canonicalThreadRef) {
      return;
    }
    void navigate({ to: "/", replace: true });
  }, [canonicalThreadRef, draftSession, navigate]);

  const closeWorkspace = useCallback(() => {
    void navigate({
      to: "/draft/$draftId",
      params: { draftId },
      replace: true,
      search: (previous) => ({
        ...stripDiffSearchParams((previous ?? {}) as Record<string, unknown>),
        workspace: undefined,
      }),
    });
  }, [draftId, navigate]);

  const openWorkspace = useCallback(() => {
    void navigate({
      to: "/draft/$draftId",
      params: { draftId },
      replace: true,
      search: (previous) => ({
        ...stripDiffSearchParams((previous ?? {}) as Record<string, unknown>),
        workspace: "1" as const,
      }),
    });
  }, [draftId, navigate]);

  if (canonicalThreadRef) {
    return (
      <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
        <ChatView
          environmentId={canonicalThreadRef.environmentId}
          threadId={canonicalThreadRef.threadId}
          routeKind="server"
        />
      </SidebarInset>
    );
  }

  if (!draftSession) {
    return null;
  }

  const chatColumn = (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <ChatView
        draftId={draftId}
        environmentId={draftSession.environmentId}
        threadId={draftSession.threadId}
        routeKind="draft"
      />
    </SidebarInset>
  );

  const inlineWorkspaceColumn = (
    <ThreadRightPanelInlineSidebar
      open={workspaceOpen}
      side={desktopLayoutDefinition.layout === "dev" ? "left" : "right"}
      preferredPanel="workspace"
      onClose={closeWorkspace}
      onOpenPreferredPanel={openWorkspace}
      renderDiffContent={false}
      renderWorkspaceContent={workspaceOpen}
      projectSidebarOpen={projectSidebarOpen}
      terminalOpen={terminalOpen}
    />
  );

  if (!shouldUseSheet) {
    // Dev puts the files on the left and the chat beside them, the same way the
    // started thread does. A draft is the same workspace before the first turn.
    return desktopLayoutDefinition.layout === "dev" ? (
      <div className="flex h-dvh min-h-0 min-w-0 flex-1" data-layout-column="dev-main">
        {inlineWorkspaceColumn}
        {chatColumn}
      </div>
    ) : (
      <>
        {chatColumn}
        {inlineWorkspaceColumn}
      </>
    );
  }

  return (
    <>
      {chatColumn}
      <RightPanelSheet open={workspaceOpen} onClose={closeWorkspace}>
        <Suspense fallback={<DraftWorkspaceLoadingFallback />}>
          <WorkspacePanel mode="sheet" onClose={closeWorkspace} />
        </Suspense>
      </RightPanelSheet>
    </>
  );
}

export const Route = createFileRoute("/_chat/draft/$draftId")({
  validateSearch: (search) => parseDiffRouteSearch(search),
  search: {
    middlewares: [retainSearchParams<DiffRouteSearch>(["workspace"])],
  },
  component: DraftChatThreadRouteView,
});
