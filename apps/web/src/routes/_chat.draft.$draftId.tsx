import { createFileRoute, retainSearchParams, useNavigate } from "@tanstack/react-router";
import { Suspense, lazy, useCallback, useEffect, useMemo } from "react";
import ChatView from "../components/ChatView";
import { threadHasStarted } from "../components/ChatView.logic";
import { useComposerDraftStore, DraftId } from "../composerDraftStore";
import { SidebarInset } from "../components/ui/sidebar";
import { createThreadSelectorAcrossEnvironments } from "../storeSelectors";
import { type AppState, selectEnvironmentState, useStore } from "../store";
import { type ThreadId } from "@t3tools/contracts";
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
import { useSettings, useUpdateSettings } from "../hooks/useSettings";
import { RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY } from "../rightPanelLayout";
import { selectThreadTerminalState, useTerminalStateStore } from "../terminalStateStore";
import {
  useDesktopLayoutPanelPreferences,
  useProjectSidebarOpen,
} from "../components/AppSidebarLayout.logic";
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
  const { updateSettings } = useUpdateSettings();
  const { setPanelPreferenceForMode } = useDesktopLayoutPanelPreferences();
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

  // A shared project's conversation is one place. Two people who walk in from
  // the dashboard before anyone has spoken each get an empty draft, and the
  // second one to send used to grow a second thread that the dashboard, and
  // everybody else, then never opened. So while this draft is still empty and
  // somebody else starts the project's thread, join theirs instead.
  //
  // "Theirs" is a thread this draft had never seen: the ones already listed
  // when the draft came up stay untouched, so a session opened deliberately
  // beside older threads keeps its own. A server thread inherits its draft's
  // creation time, so the other person's thread can carry an *earlier*
  // timestamp than this draft — hence membership, not age, is the test, with a
  // ten-minute window so a page reload cannot drag an empty draft into some
  // months-old conversation that merely arrived late from the server.
  // Returns the id rather than an object so the store subscription settles.
  const sharedThreadIdToJoin = useStore(
    useMemo(() => {
      if (!draftSession) {
        return () => null;
      }
      const { environmentId, projectId, createdAt } = draftSession;
      const notBefore = Date.parse(createdAt) - 10 * 60 * 1000;
      let knownAtMount: Set<ThreadId> | null = null;
      return (state: AppState): ThreadId | null => {
        const environmentState = selectEnvironmentState(state, environmentId);
        const threadIds = environmentState.threadIdsByProjectId[projectId] ?? [];
        if (knownAtMount === null) {
          knownAtMount = new Set(threadIds);
          return null;
        }
        if (!environmentState.projectById[projectId]?.ownership) {
          return null;
        }
        let newestId: ThreadId | null = null;
        let newestCreatedAt = 0;
        for (const threadId of threadIds) {
          if (knownAtMount.has(threadId)) {
            continue;
          }
          const shell = environmentState.threadShellById[threadId];
          if (!shell || shell.archivedAt) {
            continue;
          }
          const shellCreatedAt = Date.parse(shell.createdAt);
          if (Number.isNaN(shellCreatedAt) || shellCreatedAt < notBefore) {
            continue;
          }
          if (shellCreatedAt >= newestCreatedAt) {
            newestId = shell.id;
            newestCreatedAt = shellCreatedAt;
          }
        }
        return newestId;
      };
    }, [draftSession?.environmentId, draftSession?.projectId, draftSession?.createdAt]),
  );

  useEffect(() => {
    if (!draftSession || canonicalThreadRef || !sharedThreadIdToJoin) {
      return;
    }
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams({
        environmentId: draftSession.environmentId,
        threadId: sharedThreadIdToJoin,
      }),
      replace: true,
      search: (previous) => ({
        ...stripDiffSearchParams((previous ?? {}) as Record<string, unknown>),
        ...(workspaceOpen ? { workspace: "1" as const } : {}),
      }),
    });
  }, [canonicalThreadRef, draftSession, navigate, sharedThreadIdToJoin, workspaceOpen]);

  const closeWorkspace = useCallback(() => {
    // Clearing the URL alone isn't enough: ChatView's auto-open effect reads
    // panelPreferenceByMode and re-navigates to reopen the panel whenever the
    // URL says closed but the mode's own preference still says "workspace" —
    // so the preference has to be cleared here too, or the close is undone on
    // the very next render.
    setPanelPreferenceForMode(desktopLayoutMode, "none");
    if (desktopLayoutDefinition.layout === "dev") {
      updateSettings({ desktopLayoutMode: "vibe" });
    }
    void navigate({
      to: "/draft/$draftId",
      params: { draftId },
      replace: true,
      search: (previous) => ({
        ...stripDiffSearchParams((previous ?? {}) as Record<string, unknown>),
        workspace: undefined,
      }),
    });
  }, [
    desktopLayoutDefinition.layout,
    desktopLayoutMode,
    draftId,
    navigate,
    setPanelPreferenceForMode,
    updateSettings,
  ]);

  const openWorkspace = useCallback(() => {
    setPanelPreferenceForMode(desktopLayoutMode, "workspace");
    void navigate({
      to: "/draft/$draftId",
      params: { draftId },
      replace: true,
      search: (previous) => ({
        ...stripDiffSearchParams((previous ?? {}) as Record<string, unknown>),
        workspace: "1" as const,
      }),
    });
  }, [desktopLayoutMode, draftId, navigate, setPanelPreferenceForMode]);

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
