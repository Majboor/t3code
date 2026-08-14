import { scopedThreadKey, scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  ArchiveX,
  Building2Icon,
  ChartNoAxesColumnIcon,
  PackagePlusIcon,
  ServerIcon,
  ClockIcon,
  CopyIcon,
  FolderIcon,
  FolderPlusIcon,
  MessageSquareIcon,
  MonitorIcon,
  PlusIcon,
  SearchIcon,
  StarIcon,
  UserPlusIcon,
  UsersIcon,
  ZapIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";

import {
  buildWorkspaceDashboardModel,
  formatWorkspaceOwnershipLabel,
  type WorkspaceDashboardCreateTarget,
  type WorkspaceDashboardModel,
  type WorkspaceDashboardProject,
  type WorkspaceDashboardTenancySnapshot,
  type WorkspaceDashboardThread,
  type WorkspaceDashboardWorkspace,
} from "./WorkspaceDashboard.logic";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { SidebarInset, SidebarTrigger } from "./ui/sidebar";
import { toastManager } from "./ui/toast";
import { useCommandPaletteStore } from "../commandPaletteStore";
import { useCopyToClipboard } from "../hooks/useCopyToClipboard";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { useThreadActions } from "../hooks/useThreadActions";
import { PublishPackDialog } from "./packDashboard/PublishPackDialog";
import { readEnvironmentApi } from "../environmentApi";
import { readEnvironmentConnection } from "../environments/runtime";
import { cn, newCommandId } from "../lib/utils";
import {
  selectProjectsAcrossEnvironments,
  selectSidebarThreadsAcrossEnvironments,
  useStore,
} from "../store";
import { formatRelativeTimeLabel } from "../timestampFormat";
import { buildThreadRouteParams } from "../threadRoutes";
import { useUiStateStore } from "../uiStateStore";
import { readPrimaryEnvironmentDescriptor } from "~/environments/primary";
import { useSavedEnvironmentRuntimeStore } from "~/environments/runtime/catalog";
import { isElectron } from "~/env";

const RECENT_SESSION_LIMIT = 8;
const ARCHIVED_SESSION_LIMIT = 4;

export function WorkspaceDashboard() {
  const navigate = useNavigate();
  const projects = useStore(useShallow(selectProjectsAcrossEnvironments));
  const threads = useStore(useShallow(selectSidebarThreadsAcrossEnvironments));
  const openAddProject = useCommandPaletteStore((store) => store.openAddProject);
  const favoriteThreadKeys = useUiStateStore((store) => store.favoriteThreadKeys);
  const setThreadFavorite = useUiStateStore((store) => store.setThreadFavorite);
  const { defaultProjectRef, handleNewThread } = useHandleNewThread();
  const { unarchiveThread } = useThreadActions();
  const [filterQuery, setFilterQuery] = useState("");
  const [tenancySnapshotsByEnvironment, setTenancySnapshotsByEnvironment] = useState<
    Record<string, WorkspaceDashboardTenancySnapshot>
  >({});
  const [createWorkspaceOpen, setCreateWorkspaceOpen] = useState(false);
  const [inviteWorkspace, setInviteWorkspace] = useState<WorkspaceDashboardWorkspace | null>(null);
  const [createdInviteUrl, setCreatedInviteUrl] = useState<string | null>(null);
  const [createdSetupUrl, setCreatedSetupUrl] = useState<string | null>(null);
  const environmentRuntimeById = useSavedEnvironmentRuntimeStore((store) => store.byId);
  const primaryEnvironmentDescriptor = readPrimaryEnvironmentDescriptor();
  const getEnvironmentLabel = useCallback(
    (environmentId: EnvironmentId): string => {
      const runtimeLabel = environmentRuntimeById[environmentId]?.descriptor?.label;
      if (runtimeLabel) return runtimeLabel;
      if (primaryEnvironmentDescriptor?.environmentId === environmentId) {
        return primaryEnvironmentDescriptor.label;
      }
      return environmentId;
    },
    [environmentRuntimeById, primaryEnvironmentDescriptor],
  );
  const tenancyEnvironmentIds = useMemo(() => {
    const environmentIds = new Set<EnvironmentId>();
    if (primaryEnvironmentDescriptor?.environmentId) {
      environmentIds.add(primaryEnvironmentDescriptor.environmentId);
    }
    for (const project of projects) {
      environmentIds.add(project.environmentId);
    }
    for (const environmentId of Object.keys(environmentRuntimeById) as EnvironmentId[]) {
      environmentIds.add(environmentId);
    }
    return Array.from(environmentIds);
  }, [environmentRuntimeById, primaryEnvironmentDescriptor?.environmentId, projects]);
  const tenancySnapshots = useMemo(() => {
    const loadedSnapshots = Object.values(tenancySnapshotsByEnvironment).toSorted((left, right) =>
      left.environmentLabel.localeCompare(right.environmentLabel),
    );
    if (loadedSnapshots.length > 0) {
      return loadedSnapshots;
    }
    return tenancyEnvironmentIds.map((environmentId) =>
      makeEmptyTenancySnapshot(environmentId, getEnvironmentLabel(environmentId)),
    );
  }, [getEnvironmentLabel, tenancyEnvironmentIds, tenancySnapshotsByEnvironment]);
  const model = useMemo(
    () =>
      buildWorkspaceDashboardModel({
        projects,
        threads,
        tenancySnapshots,
        favoriteThreadKeys: new Set(
          Object.keys(favoriteThreadKeys).filter(
            (threadKey) => favoriteThreadKeys[threadKey] === true,
          ),
        ),
        filterQuery,
        recentThreadLimit: RECENT_SESSION_LIMIT,
        archivedThreadLimit: ARCHIVED_SESSION_LIMIT,
      }),
    [favoriteThreadKeys, filterQuery, projects, tenancySnapshots, threads],
  );

  const reloadTenancySnapshot = useCallback(
    async (environmentId: EnvironmentId) => {
      const api = readEnvironmentApi(environmentId);
      if (!api) {
        return;
      }
      try {
        const snapshot = await api.organizations.list();
        setTenancySnapshotsByEnvironment((previous) => ({
          ...previous,
          [environmentId]: {
            environmentId,
            environmentLabel: getEnvironmentLabel(environmentId),
            snapshot,
          },
        }));
      } catch (error) {
        setTenancySnapshotsByEnvironment((previous) => {
          const { [environmentId]: _removed, ...rest } = previous;
          return rest;
        });
        console.debug("Failed to load tenancy workspace metadata", error);
      }
    },
    [getEnvironmentLabel],
  );

  useEffect(() => {
    let cancelled = false;
    for (const environmentId of tenancyEnvironmentIds) {
      const api = readEnvironmentApi(environmentId);
      if (!api) {
        continue;
      }
      void api.organizations
        .list()
        .then((snapshot) => {
          if (cancelled) return;
          setTenancySnapshotsByEnvironment((previous) => ({
            ...previous,
            [environmentId]: {
              environmentId,
              environmentLabel: getEnvironmentLabel(environmentId),
              snapshot,
            },
          }));
        })
        .catch((error) => {
          if (cancelled) return;
          setTenancySnapshotsByEnvironment((previous) => {
            const { [environmentId]: _removed, ...rest } = previous;
            return rest;
          });
          console.debug("Failed to load tenancy workspace metadata", error);
        });
    }
    return () => {
      cancelled = true;
    };
  }, [getEnvironmentLabel, tenancyEnvironmentIds]);
  const handleToggleFavorite = useCallback(
    (entry: WorkspaceDashboardThread) => {
      const threadRef = scopeThreadRef(entry.thread.environmentId, entry.thread.id);
      const threadKey = scopedThreadKey(threadRef);
      const nextFavorite = !entry.isFavorite;
      setThreadFavorite(threadKey, nextFavorite);
      const api = readEnvironmentApi(entry.thread.environmentId);
      if (!api) {
        return;
      }
      void api.orchestration
        .dispatchCommand({
          type: "thread.meta.update",
          commandId: newCommandId(),
          threadId: entry.thread.id,
          favorite: nextFavorite,
        })
        .catch((error) => {
          setThreadFavorite(threadKey, entry.isFavorite);
          toastManager.add({
            type: "error",
            title: "Failed to update favorite",
            description: error instanceof Error ? error.message : "An error occurred.",
          });
        });
    },
    [setThreadFavorite],
  );
  const handleAddProjectToWorkspace = useCallback(
    (workspace: WorkspaceDashboardWorkspace) => {
      if (workspace.ownership) {
        openAddProject({
          environmentId: workspace.environmentId,
          ownership: workspace.ownership,
        });
        return;
      }
      openAddProject();
    },
    [openAddProject],
  );
  const handleOpenProjectSession = useCallback(
    async (entry: WorkspaceDashboardProject) => {
      if (entry.latestThread) {
        const threadRef = scopeThreadRef(entry.project.environmentId, entry.latestThread.id);
        await navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(threadRef),
        });
        return;
      }

      await handleNewThread(scopeProjectRef(entry.project.environmentId, entry.project.id));
    },
    [handleNewThread, navigate],
  );
  const handleCreateWorkspace = useCallback(
    async (target: WorkspaceDashboardCreateTarget, title: string) => {
      const client = readEnvironmentConnection(target.environmentId)?.client;
      if (!client?.workspaces) {
        throw new Error("Workspace creation is not available for this environment.");
      }
      await client.workspaces.create({
        tenantId: target.tenantId,
        title,
        kind: target.defaultKind,
        accessMode: target.defaultAccessMode,
      });
      await reloadTenancySnapshot(target.environmentId);
      toastManager.add({
        type: "success",
        title: "Workspace created",
        description: `${title} is ready for projects and collaborators.`,
      });
    },
    [reloadTenancySnapshot],
  );
  const handleCreateWorkspaceInvite = useCallback(
    async (workspace: WorkspaceDashboardWorkspace, email: string) => {
      if (!workspace.tenantId || !workspace.workspaceId) {
        throw new Error("Only saved tenant workspaces can invite collaborators.");
      }
      const api = readEnvironmentApi(workspace.environmentId);
      if (!api) {
        throw new Error("Environment API is not available.");
      }
      const result = await api.collaboration.createInvite({
        tenantId: workspace.tenantId,
        workspaceId: workspace.workspaceId,
        email,
        scope: "workspace",
        roles: ["developer"],
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      });
      const toAbsoluteUrl = (path: string) =>
        typeof window === "undefined" ? path : new URL(path, window.location.origin).toString();
      const inviteUrl = toAbsoluteUrl(result.acceptUrlPath);
      const setupUrl = toAbsoluteUrl(result.accountSetupUrlPath ?? result.acceptUrlPath);
      setCreatedInviteUrl(inviteUrl);
      setCreatedSetupUrl(setupUrl);
      await reloadTenancySnapshot(workspace.environmentId);
      toastManager.add({
        type: "success",
        title: "Workspace invite created",
        description: `${email} can join ${workspace.title}. Copy the setup link from the dialog.`,
      });
    },
    [reloadTenancySnapshot],
  );

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
        <DashboardHeader />
        <main
          className="min-h-0 flex-1 overflow-auto px-4 py-5 sm:px-6 lg:px-8"
          data-testid="workspace-dashboard"
        >
          <div className="mx-auto flex w-full max-w-7xl flex-col gap-5">
            <DashboardSummary model={model} />
            <DashboardActions
              canCreateWorkspace={model.createTargets.length > 0}
              canCreateSession={defaultProjectRef !== null}
              onCreateWorkspace={() => setCreateWorkspaceOpen(true)}
              onCreateSession={() => {
                if (!defaultProjectRef) {
                  return;
                }
                void handleNewThread(defaultProjectRef).catch((error) => {
                  toastManager.add({
                    type: "error",
                    title: "Failed to create session",
                    description: error instanceof Error ? error.message : "An error occurred.",
                  });
                });
              }}
            />
            <DashboardFilter query={filterQuery} onQueryChange={setFilterQuery} />

            {model.workspaceCount === 0 && !model.hasFilter ? (
              <EmptyDashboard
                canCreateWorkspace={model.createTargets.length > 0}
                onCreateWorkspace={() => setCreateWorkspaceOpen(true)}
                onAddProject={openAddProject}
              />
            ) : (
              <div className="grid min-h-0 gap-5 xl:grid-cols-[minmax(0,1fr)_24rem]">
                <section className="min-w-0 rounded-lg border border-border bg-card/35">
                  <SectionHeader
                    title="Workspaces"
                    description="Workspace containers with their projects, members, and access scope."
                  />
                  {model.workspaces.length > 0 ? (
                    <div className="divide-y divide-border/70" data-testid="dashboard-workspaces">
                      {model.workspaces.map((entry) => (
                        <WorkspaceRow
                          key={entry.key}
                          entry={entry}
                          ownershipLabel={formatWorkspaceOwnershipLabel(
                            entry,
                            getEnvironmentLabel(entry.environmentId),
                          )}
                          onAddProject={handleAddProjectToWorkspace}
                          onInvite={(workspace) => {
                            setCreatedInviteUrl(null);
                            setCreatedSetupUrl(null);
                            setInviteWorkspace(workspace);
                          }}
                          onOpenProject={(projectEntry) => {
                            void handleOpenProjectSession(projectEntry).catch((error) => {
                              toastManager.add({
                                type: "error",
                                title: "Failed to open project",
                                description:
                                  error instanceof Error ? error.message : "An error occurred.",
                              });
                            });
                          }}
                        />
                      ))}
                    </div>
                  ) : (
                    <DashboardEmptyResult label="No matching workspaces." />
                  )}
                </section>

                <div className="flex min-w-0 flex-col gap-5">
                  <section className="min-w-0 rounded-lg border border-border bg-card/35">
                    <SectionHeader
                      title="Recent Sessions"
                      description="Latest open sessions across workspaces."
                    />
                    {model.recentThreads.length > 0 ? (
                      <div className="divide-y divide-border/70" data-testid="dashboard-sessions">
                        {model.recentThreads.map((entry) => (
                          <SessionRow
                            key={`${entry.thread.environmentId}:${entry.thread.id}`}
                            entry={entry}
                            ownershipLabel={
                              entry.workspaceTitle ??
                              getEnvironmentLabel(entry.thread.environmentId)
                            }
                            onToggleFavorite={handleToggleFavorite}
                          />
                        ))}
                      </div>
                    ) : model.hasFilter ? (
                      <DashboardEmptyResult label="No matching active sessions." />
                    ) : (
                      <div className="px-4 py-8 text-sm text-muted-foreground">
                        No active sessions yet.
                      </div>
                    )}
                  </section>

                  {model.archivedThreadCount > 0 || model.hasFilter ? (
                    <section className="min-w-0 rounded-lg border border-border bg-card/35">
                      <SectionHeader
                        title="Archived Sessions"
                        description={`${formatCount(model.archivedThreadCount, "session")} ready to restore.`}
                      />
                      {model.archivedThreads.length > 0 ? (
                        <div
                          className="divide-y divide-border/70"
                          data-testid="dashboard-archived-sessions"
                        >
                          {model.archivedThreads.map((entry) => (
                            <ArchivedSessionRow
                              key={`${entry.thread.environmentId}:${entry.thread.id}`}
                              entry={entry}
                              ownershipLabel={
                                entry.workspaceTitle ??
                                getEnvironmentLabel(entry.thread.environmentId)
                              }
                              onRestore={unarchiveThread}
                            />
                          ))}
                        </div>
                      ) : (
                        <DashboardEmptyResult label="No matching archived sessions." />
                      )}
                    </section>
                  ) : null}
                </div>
              </div>
            )}
          </div>
        </main>
      </div>
      <CreateWorkspaceDialog
        open={createWorkspaceOpen}
        targets={model.createTargets}
        onOpenChange={setCreateWorkspaceOpen}
        onCreate={handleCreateWorkspace}
      />
      <WorkspaceInviteDialog
        workspace={inviteWorkspace}
        createdInviteUrl={createdInviteUrl}
        createdSetupUrl={createdSetupUrl}
        onOpenChange={(open) => {
          if (!open) {
            setInviteWorkspace(null);
            setCreatedInviteUrl(null);
            setCreatedSetupUrl(null);
          }
        }}
        onInvite={handleCreateWorkspaceInvite}
      />
    </SidebarInset>
  );
}

function DashboardActions({
  canCreateWorkspace,
  canCreateSession,
  onCreateWorkspace,
  onCreateSession,
}: {
  canCreateWorkspace: boolean;
  canCreateSession: boolean;
  onCreateWorkspace: () => void;
  onCreateSession: () => void;
}) {
  return (
    <section
      className="flex flex-col gap-2 rounded-lg border border-border bg-card/35 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
      aria-label="Workspace dashboard actions"
    >
      <div className="min-w-0">
        <h2 className="text-sm font-medium text-foreground">Manage workspaces and sessions</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Create a workspace, attach projects, and invite collaborators.
        </p>
      </div>
      <div className="flex shrink-0 flex-wrap gap-2">
        <button
          type="button"
          className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-background px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:border-ring focus-visible:text-foreground focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:text-muted-foreground"
          data-testid="dashboard-add-workspace"
          disabled={!canCreateWorkspace}
          onClick={onCreateWorkspace}
        >
          <PlusIcon className="size-3.5" />
          <span>Create Workspace</span>
        </button>
        <button
          type="button"
          className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-background px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:border-ring focus-visible:text-foreground focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:text-muted-foreground"
          data-testid="dashboard-new-session"
          disabled={!canCreateSession}
          onClick={onCreateSession}
        >
          <MessageSquareIcon className="size-3.5" />
          <span>New Session</span>
        </button>
      </div>
    </section>
  );
}

function DashboardFilter({
  query,
  onQueryChange,
}: {
  query: string;
  onQueryChange: (query: string) => void;
}) {
  return (
    <section
      className="rounded-lg border border-border bg-card/35 px-4 py-3"
      aria-label="Workspace dashboard filter"
    >
      <label className="relative block">
        <span className="sr-only">Filter dashboard</span>
        <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground/60" />
        <input
          type="search"
          value={query}
          aria-label="Filter dashboard"
          className="h-8 w-full rounded-md border border-border bg-background px-8 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground/60 focus:border-ring"
          data-testid="dashboard-filter"
          onChange={(event) => onQueryChange(event.currentTarget.value)}
          placeholder="Filter workspaces and sessions..."
        />
      </label>
    </section>
  );
}

function DashboardHeader() {
  return (
    <header
      className={cn(
        "border-b border-border px-3 sm:px-5",
        isElectron
          ? "drag-region flex h-[52px] items-center wco:h-[env(titlebar-area-height)]"
          : "py-2 sm:py-3",
      )}
    >
      <div className="flex w-full min-w-0 items-center gap-2">
        <SidebarTrigger
          className={cn("size-7 shrink-0 md:hidden", isElectron && "[-webkit-app-region:no-drag]")}
        />
        <div className="min-w-0">
          <h1 className="truncate text-sm font-medium text-foreground">Workspace Dashboard</h1>
          <p className="hidden text-xs text-muted-foreground/70 sm:block">
            Workspaces, recent sessions, and activity at a glance.
          </p>
        </div>
      </div>
    </header>
  );
}

function DashboardSummary({ model }: { model: WorkspaceDashboardModel }) {
  return (
    <div className="grid gap-3 sm:grid-cols-3" aria-label="Workspace dashboard summary">
      <SummaryMetric icon={FolderIcon} label="Workspaces" value={model.workspaceCount} />
      <SummaryMetric icon={MessageSquareIcon} label="Sessions" value={model.totalThreadCount} />
      <SummaryMetric icon={ZapIcon} label="Need Attention" value={model.activeThreadCount} />
    </div>
  );
}

function SummaryMetric({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof FolderIcon;
  label: string;
  value: number;
}) {
  return (
    <div className="flex min-w-0 items-center gap-3 rounded-lg border border-border bg-card/35 px-4 py-3">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border bg-background text-muted-foreground">
        <Icon className="size-4" />
      </span>
      <div className="min-w-0">
        <div className="text-lg font-semibold leading-none text-foreground">{value}</div>
        <div className="mt-1 truncate text-xs text-muted-foreground">{label}</div>
      </div>
    </div>
  );
}

function SectionHeader({ title, description }: { title: string; description: string }) {
  return (
    <div className="border-b border-border/70 px-4 py-3">
      <h2 className="text-sm font-medium text-foreground">{title}</h2>
      <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
    </div>
  );
}

function DashboardEmptyResult({ label }: { label: string }) {
  return <div className="px-4 py-8 text-sm text-muted-foreground">{label}</div>;
}

function WorkspaceRow({
  entry,
  ownershipLabel,
  onAddProject,
  onInvite,
  onOpenProject,
}: {
  entry: WorkspaceDashboardWorkspace;
  ownershipLabel: string;
  onAddProject: (entry: WorkspaceDashboardWorkspace) => void;
  onInvite: (entry: WorkspaceDashboardWorkspace) => void;
  onOpenProject: (entry: WorkspaceDashboardProject) => void;
}) {
  const canInvite = entry.workspaceId !== null && entry.tenantId !== null;
  const navigate = useNavigate();
  const [publishingProject, setPublishingProject] = useState<WorkspaceDashboardProject | null>(
    null,
  );

  return (
    <div className="px-4 py-3" data-testid="dashboard-workspace-row">
      <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-start">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-md border border-border bg-background text-muted-foreground">
            {entry.organizationId ? (
              <Building2Icon className="size-4" />
            ) : (
              <FolderIcon className="size-4" />
            )}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
              <span className="truncate text-sm font-medium text-foreground">{entry.title}</span>
              <span className="rounded-sm border border-border bg-background px-1.5 py-0.5 text-[11px] text-muted-foreground">
                {entry.scope === "local" ? "personal" : entry.scope}
              </span>
              <span className="rounded-sm border border-border bg-background px-1.5 py-0.5 text-[11px] text-muted-foreground">
                {entry.accessMode === "local" ? "local" : entry.accessMode}
              </span>
            </div>
            <div className="mt-1 truncate text-xs text-muted-foreground">{ownershipLabel}</div>
            <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground/80">
              <span>{formatCount(entry.projectCount, "project")}</span>
              <span>{formatCount(entry.threadCount, "session")}</span>
              <span>{formatCount(entry.members.length, "member")}</span>
              {entry.pendingInviteCount > 0 ? (
                <span>{formatCount(entry.pendingInviteCount, "pending invite")}</span>
              ) : null}
              {entry.latestActivityAt ? (
                <span>Updated {formatRelativeTimeLabel(entry.latestActivityAt)}</span>
              ) : null}
            </div>
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2 sm:justify-end">
          <button
            type="button"
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-background px-2 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:border-ring focus-visible:text-foreground focus-visible:outline-none"
            onClick={() => onAddProject(entry)}
          >
            <FolderPlusIcon className="size-3.5" />
            <span>Add project</span>
          </button>
          <button
            type="button"
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-background px-2 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:border-ring focus-visible:text-foreground focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:text-muted-foreground"
            disabled={!canInvite}
            onClick={() => onInvite(entry)}
          >
            <UserPlusIcon className="size-3.5" />
            <span>Invite</span>
          </button>
        </div>
      </div>

      {entry.members.length > 0 ? (
        <div className="mt-3 flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
          <UsersIcon className="size-3.5 shrink-0" />
          <div className="flex min-w-0 flex-wrap gap-1.5">
            {entry.members.slice(0, 4).map((member) => (
              <span
                key={member.id}
                className="max-w-40 truncate rounded-sm border border-border bg-background px-1.5 py-0.5"
                title={member.email ?? member.displayName}
              >
                {member.displayName}
              </span>
            ))}
            {entry.members.length > 4 ? <span>+{entry.members.length - 4} more</span> : null}
          </div>
        </div>
      ) : null}

      {publishingProject ? (
        <PublishPackDialog
          environmentId={publishingProject.project.environmentId}
          projectName={publishingProject.project.name}
          open
          onOpenChange={(next) => {
            if (!next) setPublishingProject(null);
          }}
          onPublished={(packId) => {
            void navigate({ to: "/pack/$packId", params: { packId } });
          }}
        />
      ) : null}

      {entry.projects.length > 0 ? (
        <div className="mt-3 grid gap-2">
          {entry.projects.slice(0, 4).map((projectEntry) => (
            <div
              key={`${projectEntry.project.environmentId}:${projectEntry.project.id}`}
              className="group flex min-w-0 items-center gap-2 rounded-md border border-border/70 bg-background/70 pr-1.5 text-xs transition-colors hover:bg-accent/70"
            >
              <button
                type="button"
                className="flex min-w-0 flex-1 items-center gap-2 px-2.5 py-2 text-left focus-visible:outline-none"
                data-testid="dashboard-workspace-project-link"
                onClick={() => onOpenProject(projectEntry)}
              >
                <FolderIcon className="size-3.5 shrink-0 text-muted-foreground group-hover:text-foreground" />
                <span className="min-w-0 flex-1 truncate text-foreground">
                  {projectEntry.project.name}
                </span>
                <span className="shrink-0 text-muted-foreground">
                  {projectEntry.threadCount > 0
                    ? formatCount(projectEntry.threadCount, "session")
                    : "Start session"}
                </span>
              </button>
              {/* Labelled rather than an icon alone: publishing was reachable
                  only from this row, by a 14px glyph whose sole label was a
                  tooltip, and nobody found it. */}
              <button
                type="button"
                aria-label={`Publish ${projectEntry.project.name} as a pack`}
                title="Publish as a pack"
                className="flex shrink-0 items-center gap-1 rounded-sm border border-border/70 px-1.5 py-1 text-[11px] text-muted-foreground transition-colors hover:border-border hover:text-foreground focus-visible:outline-none"
                data-testid="dashboard-workspace-publish-pack"
                onClick={(event) => {
                  event.stopPropagation();
                  setPublishingProject(projectEntry);
                }}
              >
                <PackagePlusIcon className="size-3.5" />
                Publish
              </button>
              <Link
                to="/infra/$projectId"
                params={{ projectId: projectEntry.project.id }}
                aria-label={`Infrastructure for ${projectEntry.project.name}`}
                title="Infrastructure"
                className="shrink-0 rounded-sm p-1 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none"
                data-testid="dashboard-workspace-infra-link"
                onClick={(event) => event.stopPropagation()}
              >
                <ServerIcon className="size-3.5" />
              </Link>
              {/* Reachable from the project it belongs to, or nobody finds it. */}
              <Link
                to="/analytics/$projectId"
                params={{ projectId: projectEntry.project.id }}
                aria-label={`Analytics for ${projectEntry.project.name}`}
                title="Analytics"
                className="shrink-0 rounded-sm p-1 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none"
                data-testid="dashboard-workspace-analytics-link"
                onClick={(event) => event.stopPropagation()}
              >
                <ChartNoAxesColumnIcon className="size-3.5" />
              </Link>
            </div>
          ))}
          {entry.projects.length > 4 ? (
            <div className="px-2.5 text-xs text-muted-foreground">
              +{entry.projects.length - 4} more projects
            </div>
          ) : null}
        </div>
      ) : (
        <div className="mt-3 rounded-md border border-dashed border-border px-3 py-4 text-xs text-muted-foreground">
          No projects attached yet.
        </div>
      )}
    </div>
  );
}

function SessionRow({
  entry,
  ownershipLabel,
  onToggleFavorite,
}: {
  entry: WorkspaceDashboardThread;
  ownershipLabel: string;
  onToggleFavorite: (entry: WorkspaceDashboardThread) => void;
}) {
  const threadRef = scopeThreadRef(entry.thread.environmentId, entry.thread.id);
  const favoriteLabel = entry.isFavorite
    ? `Unfavorite session ${entry.thread.title}`
    : `Favorite session ${entry.thread.title}`;

  return (
    <div className="group flex min-w-0 items-start gap-2 px-4 py-3 transition-colors hover:bg-accent/70 focus-within:bg-accent/70">
      <Link
        className="flex min-w-0 flex-1 items-start gap-3 focus-visible:outline-none"
        data-testid="dashboard-session-link"
        params={buildThreadRouteParams(threadRef)}
        to="/$environmentId/$threadId"
      >
        <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md border border-border bg-background text-muted-foreground group-hover:text-foreground">
          <MessageSquareIcon className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-foreground">{entry.thread.title}</div>
          <div className="mt-1 flex min-w-0 flex-wrap gap-x-2 gap-y-1 text-xs text-muted-foreground">
            <span className="truncate">{entry.project?.name ?? "Unknown project"}</span>
            {entry.thread.branch ? <span className="truncate">#{entry.thread.branch}</span> : null}
            <span className="truncate">{ownershipLabel}</span>
          </div>
          <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground/80">
            <ClockIcon className="size-3.5" />
            <span>{formatRelativeTimeLabel(entry.latestActivityAt)}</span>
          </div>
        </div>
      </Link>
      <button
        aria-label={favoriteLabel}
        aria-pressed={entry.isFavorite}
        className={cn(
          "mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md border border-transparent text-muted-foreground transition-colors hover:border-border hover:bg-background hover:text-foreground focus-visible:border-ring focus-visible:bg-background focus-visible:text-foreground focus-visible:outline-none",
          entry.isFavorite && "text-amber-500 hover:text-amber-500 focus-visible:text-amber-500",
        )}
        data-testid={`dashboard-session-favorite-${entry.thread.id}`}
        onClick={() => onToggleFavorite(entry)}
        title={favoriteLabel}
        type="button"
      >
        <StarIcon className={cn("size-4", entry.isFavorite && "fill-current")} />
      </button>
    </div>
  );
}

function ArchivedSessionRow({
  entry,
  ownershipLabel,
  onRestore,
}: {
  entry: WorkspaceDashboardThread;
  ownershipLabel: string;
  onRestore: ReturnType<typeof useThreadActions>["unarchiveThread"];
}) {
  const threadRef = scopeThreadRef(entry.thread.environmentId, entry.thread.id);
  const restoreLabel = `Restore session ${entry.thread.title}`;

  return (
    <div className="group flex min-w-0 items-start gap-2 px-4 py-3 transition-colors hover:bg-accent/70 focus-within:bg-accent/70">
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md border border-border bg-background text-muted-foreground group-hover:text-foreground">
          <ArchiveX className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-foreground">{entry.thread.title}</div>
          <div className="mt-1 flex min-w-0 flex-wrap gap-x-2 gap-y-1 text-xs text-muted-foreground">
            <span className="truncate">{entry.project?.name ?? "Unknown project"}</span>
            {entry.thread.branch ? <span className="truncate">#{entry.thread.branch}</span> : null}
            <span className="truncate">{ownershipLabel}</span>
          </div>
          <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground/80">
            <ClockIcon className="size-3.5" />
            <span>
              Archived {formatRelativeTimeLabel(entry.thread.archivedAt ?? entry.latestActivityAt)}
            </span>
          </div>
        </div>
      </div>
      <button
        aria-label={restoreLabel}
        className="mt-0.5 flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-border bg-background px-2 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:border-ring focus-visible:text-foreground focus-visible:outline-none"
        data-testid={`dashboard-session-restore-${entry.thread.id}`}
        onClick={() =>
          void onRestore(threadRef).catch((error) => {
            toastManager.add({
              type: "error",
              title: "Failed to restore session",
              description: error instanceof Error ? error.message : "An error occurred.",
            });
          })
        }
        title={restoreLabel}
        type="button"
      >
        <ArchiveX className="size-3.5" />
        <span>Restore</span>
      </button>
    </div>
  );
}

function EmptyDashboard({
  canCreateWorkspace,
  onCreateWorkspace,
  onAddProject,
}: {
  canCreateWorkspace: boolean;
  onCreateWorkspace: () => void;
  onAddProject: () => void;
}) {
  return (
    <section className="flex min-h-72 items-center justify-center rounded-lg border border-border bg-card/35 px-6 py-10 text-center">
      <div className="max-w-sm">
        <div className="mx-auto flex size-10 items-center justify-center rounded-md border border-border bg-background text-muted-foreground">
          <MonitorIcon className="size-5" />
        </div>
        <h2 className="mt-4 text-base font-medium text-foreground">No workspaces yet</h2>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          Create a workspace for projects and collaborators, or add a local project.
        </p>
        <div className="mt-4 flex justify-center gap-2">
          <button
            type="button"
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-background px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:border-ring focus-visible:text-foreground focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:text-muted-foreground"
            data-testid="dashboard-empty-add-workspace"
            disabled={!canCreateWorkspace}
            onClick={onCreateWorkspace}
          >
            <PlusIcon className="size-3.5" />
            <span>Create Workspace</span>
          </button>
          <button
            type="button"
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-background px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:border-ring focus-visible:text-foreground focus-visible:outline-none"
            onClick={onAddProject}
          >
            <FolderPlusIcon className="size-3.5" />
            <span>Add Project</span>
          </button>
        </div>
      </div>
    </section>
  );
}

function CreateWorkspaceDialog({
  open,
  targets,
  onOpenChange,
  onCreate,
}: {
  open: boolean;
  targets: readonly WorkspaceDashboardCreateTarget[];
  onOpenChange: (open: boolean) => void;
  onCreate: (target: WorkspaceDashboardCreateTarget, title: string) => Promise<void>;
}) {
  const [title, setTitle] = useState("");
  const [targetKey, setTargetKey] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const selectedTarget = targets.find((target) => createTargetKey(target) === targetKey) ?? null;

  useEffect(() => {
    if (!open) return;
    setTitle("");
    setErrorMessage(null);
    setTargetKey(targets[0] ? createTargetKey(targets[0]) : "");
  }, [open, targets]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-lg">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const trimmedTitle = title.trim();
            if (!selectedTarget || trimmedTitle.length === 0) return;
            setSubmitting(true);
            setErrorMessage(null);
            void onCreate(selectedTarget, trimmedTitle)
              .then(() => onOpenChange(false))
              .catch((error) => {
                setErrorMessage(
                  error instanceof Error ? error.message : "Workspace creation failed.",
                );
              })
              .finally(() => setSubmitting(false));
          }}
        >
          <DialogHeader>
            <DialogTitle>Create Workspace</DialogTitle>
            <DialogDescription>
              Workspaces group projects and collaborator access inside a tenant.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-4">
            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-muted-foreground">Name</span>
              <input
                autoFocus
                className="h-9 w-full rounded-md border border-border bg-background px-3 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground/60 focus:border-ring"
                value={title}
                maxLength={120}
                onChange={(event) => setTitle(event.currentTarget.value)}
                placeholder="Product Workspace"
              />
            </label>
            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-muted-foreground">Tenant</span>
              <select
                className="h-9 w-full rounded-md border border-border bg-background px-3 text-sm text-foreground outline-none transition-colors focus:border-ring"
                value={targetKey}
                onChange={(event) => setTargetKey(event.currentTarget.value)}
              >
                {targets.map((target) => (
                  <option key={createTargetKey(target)} value={createTargetKey(target)}>
                    {target.label}
                  </option>
                ))}
              </select>
            </label>
            {selectedTarget ? (
              <div className="rounded-md border border-border bg-background px-3 py-2 text-xs text-muted-foreground">
                {selectedTarget.organizationId ? "Organization workspace" : "Personal workspace"} ·{" "}
                {selectedTarget.defaultAccessMode}
              </div>
            ) : null}
            {errorMessage ? <p className="text-sm text-destructive">{errorMessage}</p> : null}
          </DialogPanel>
          <DialogFooter>
            <button
              type="button"
              className="inline-flex h-8 items-center justify-center rounded-md border border-border bg-background px-3 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:border-ring focus-visible:text-foreground focus-visible:outline-none"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="inline-flex h-8 items-center justify-center rounded-md border border-primary bg-primary px-3 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:border-ring focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60"
              disabled={!selectedTarget || title.trim().length === 0 || submitting}
            >
              {submitting ? "Creating..." : "Create"}
            </button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

function WorkspaceInviteDialog({
  workspace,
  createdInviteUrl,
  createdSetupUrl,
  onOpenChange,
  onInvite,
}: {
  workspace: WorkspaceDashboardWorkspace | null;
  createdInviteUrl: string | null;
  createdSetupUrl: string | null;
  onOpenChange: (open: boolean) => void;
  onInvite: (workspace: WorkspaceDashboardWorkspace, email: string) => Promise<void>;
}) {
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const { copyToClipboard } = useCopyToClipboard<string>({
    onCopy: () => {
      toastManager.add({ type: "success", title: "Invite link copied" });
    },
    onError: (error) => {
      toastManager.add({
        type: "error",
        title: "Could not copy invite link",
        description: error.message,
      });
    },
  });

  useEffect(() => {
    if (!workspace) return;
    setEmail("");
    setErrorMessage(null);
  }, [workspace]);

  return (
    <Dialog open={workspace !== null} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-lg">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const trimmedEmail = email.trim();
            if (!workspace || trimmedEmail.length === 0) return;
            setSubmitting(true);
            setErrorMessage(null);
            void onInvite(workspace, trimmedEmail)
              .catch((error) => {
                setErrorMessage(error instanceof Error ? error.message : "Invite creation failed.");
              })
              .finally(() => setSubmitting(false));
          }}
        >
          <DialogHeader>
            <DialogTitle>Invite Collaborator</DialogTitle>
            <DialogDescription>
              {workspace ? `Create a workspace invite for ${workspace.title}.` : "Create invite."}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-4">
            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-muted-foreground">Email</span>
              <input
                autoFocus
                className="h-9 w-full rounded-md border border-border bg-background px-3 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground/60 focus:border-ring"
                type="email"
                value={email}
                onChange={(event) => setEmail(event.currentTarget.value)}
                placeholder="teammate@example.com"
              />
            </label>
            {createdSetupUrl ? (
              <div className="rounded-md border border-border bg-background p-3">
                <div className="text-xs font-medium text-foreground">Invite link</div>
                <p className="mt-1 text-xs text-muted-foreground">
                  One link for everyone. It signs them in if they already have an account, and sets
                  one up if they do not.
                </p>
                <div className="mt-2 flex min-w-0 items-center gap-2">
                  <code className="min-w-0 flex-1 truncate rounded-md bg-muted px-2 py-1 text-[11px] text-muted-foreground">
                    {createdSetupUrl}
                  </code>
                  <button
                    type="button"
                    className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-background px-2 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:border-ring focus-visible:text-foreground focus-visible:outline-none"
                    onClick={() => copyToClipboard(createdSetupUrl, createdSetupUrl)}
                  >
                    <CopyIcon className="size-3.5" />
                    <span>Copy</span>
                  </button>
                </div>
                {createdInviteUrl && createdInviteUrl !== createdSetupUrl ? (
                  <div className="mt-3 border-t border-border/70 pt-3">
                    <div className="text-xs font-medium text-muted-foreground">
                      Existing account link
                    </div>
                    <div className="mt-2 flex min-w-0 items-center gap-2">
                      <code className="min-w-0 flex-1 truncate rounded-md bg-muted px-2 py-1 text-[11px] text-muted-foreground">
                        {createdInviteUrl}
                      </code>
                      <button
                        type="button"
                        className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-background px-2 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:border-ring focus-visible:text-foreground focus-visible:outline-none"
                        onClick={() => copyToClipboard(createdInviteUrl, createdInviteUrl)}
                      >
                        <CopyIcon className="size-3.5" />
                        <span>Copy</span>
                      </button>
                    </div>
                  </div>
                ) : null}
              </div>
            ) : null}
            {errorMessage ? <p className="text-sm text-destructive">{errorMessage}</p> : null}
          </DialogPanel>
          <DialogFooter>
            <button
              type="button"
              className="inline-flex h-8 items-center justify-center rounded-md border border-border bg-background px-3 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:border-ring focus-visible:text-foreground focus-visible:outline-none"
              onClick={() => onOpenChange(false)}
            >
              Close
            </button>
            <button
              type="submit"
              className="inline-flex h-8 items-center justify-center rounded-md border border-primary bg-primary px-3 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:border-ring focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60"
              disabled={!workspace || email.trim().length === 0 || submitting}
            >
              {submitting ? "Creating..." : "Create invite"}
            </button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

function createTargetKey(target: WorkspaceDashboardCreateTarget): string {
  return `${target.environmentId}:${target.tenantId}`;
}

function makeEmptyTenancySnapshot(
  environmentId: EnvironmentId,
  environmentLabel: string,
): WorkspaceDashboardTenancySnapshot {
  return {
    environmentId,
    environmentLabel,
    snapshot: {
      organizations: [],
      tenants: [],
      workspaces: [],
      employees: [],
      invites: [],
      memberships: [],
      teams: [],
      departments: [],
      grants: [],
      reviews: [],
    },
  };
}

function formatCount(value: number, noun: string): string {
  return `${value} ${noun}${value === 1 ? "" : "s"}`;
}
