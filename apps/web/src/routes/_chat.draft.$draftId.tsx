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

  return (
    <>
      <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
        <ChatView
          draftId={draftId}
          environmentId={draftSession.environmentId}
          threadId={draftSession.threadId}
          routeKind="draft"
        />
      </SidebarInset>
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
