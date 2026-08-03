import { TenantId } from "@t3tools/contracts";
import type { OrganizationListResult, Tenant, TenantInvite, Workspace } from "@t3tools/contracts";

import type { Project, SidebarThreadSummary } from "../types";

type ProjectOwnership = NonNullable<Project["ownership"]>;

export interface WorkspaceDashboardTenancySnapshot {
  readonly environmentId: Project["environmentId"];
  readonly environmentLabel: string;
  readonly snapshot: OrganizationListResult;
}

export interface WorkspaceDashboardMember {
  readonly id: string;
  readonly displayName: string;
  readonly email: string | null;
  readonly status: "active" | "invited" | "disabled" | "owner" | "unknown";
}

export interface WorkspaceDashboardProject {
  readonly project: Project;
  readonly workspaceKey: string;
  readonly threadCount: number;
  readonly activeThreadCount: number;
  readonly latestThread: SidebarThreadSummary | null;
  readonly latestActivityAt: string | null;
}

export interface WorkspaceDashboardWorkspace {
  readonly key: string;
  readonly environmentId: Project["environmentId"];
  readonly workspaceId: Workspace["id"] | null;
  readonly tenantId: Tenant["id"] | null;
  readonly organizationId: Workspace["organizationId"];
  readonly title: string;
  readonly scope: Workspace["kind"] | "local";
  readonly accessMode: Workspace["accessMode"] | "local";
  readonly tenantDisplayName: string | null;
  readonly organizationDisplayName: string | null;
  readonly ownerUserId: Workspace["ownerUserId"] | null;
  readonly ownerDisplayName: string | null;
  readonly createdAt: string | null;
  readonly projects: readonly WorkspaceDashboardProject[];
  readonly projectCount: number;
  readonly threadCount: number;
  readonly activeThreadCount: number;
  readonly latestThread: SidebarThreadSummary | null;
  readonly latestActivityAt: string | null;
  readonly members: readonly WorkspaceDashboardMember[];
  readonly pendingInviteCount: number;
  readonly ownership: ProjectOwnership | null;
}

export interface WorkspaceDashboardThread {
  readonly thread: SidebarThreadSummary;
  readonly project: Project | null;
  readonly workspaceKey: string | null;
  readonly workspaceTitle: string | null;
  readonly latestActivityAt: string;
  readonly isFavorite: boolean;
}

export interface WorkspaceDashboardModel {
  readonly workspaces: readonly WorkspaceDashboardWorkspace[];
  readonly recentThreads: readonly WorkspaceDashboardThread[];
  readonly archivedThreads: readonly WorkspaceDashboardThread[];
  readonly createTargets: readonly WorkspaceDashboardCreateTarget[];
  readonly hasFilter: boolean;
  readonly workspaceCount: number;
  readonly projectCount: number;
  readonly activeThreadCount: number;
  readonly archivedThreadCount: number;
  readonly totalThreadCount: number;
}

export interface WorkspaceDashboardCreateTarget {
  readonly environmentId: Project["environmentId"];
  readonly tenantId: Tenant["id"];
  readonly label: string;
  readonly organizationId: Tenant["organizationId"];
  readonly defaultKind: Workspace["kind"];
  readonly defaultAccessMode: Workspace["accessMode"];
}

interface MutableWorkspace {
  key: string;
  environmentId: Project["environmentId"];
  workspaceId: Workspace["id"] | null;
  tenantId: Tenant["id"] | null;
  organizationId: Workspace["organizationId"];
  title: string;
  scope: Workspace["kind"] | "local";
  accessMode: Workspace["accessMode"] | "local";
  tenantDisplayName: string | null;
  organizationDisplayName: string | null;
  ownerUserId: Workspace["ownerUserId"] | null;
  ownerDisplayName: string | null;
  createdAt: string | null;
  projects: WorkspaceDashboardProject[];
  members: WorkspaceDashboardMember[];
  pendingInviteCount: number;
  ownership: ProjectOwnership | null;
}

export function getThreadActivityAt(thread: SidebarThreadSummary): string {
  return thread.latestUserMessageAt ?? thread.updatedAt ?? thread.createdAt;
}

export function getProjectActivityAt(
  project: Project,
  threads: readonly SidebarThreadSummary[],
): string | null {
  const latestThreadActivityAt = threads.reduce<string | null>((latest, thread) => {
    const activityAt = getThreadActivityAt(thread);
    if (!latest || compareIsoDesc(activityAt, latest) < 0) {
      return activityAt;
    }
    return latest;
  }, null);

  return latestThreadActivityAt ?? project.updatedAt ?? project.createdAt ?? null;
}

export function formatProjectOwnershipLabel(
  project: Pick<Project, "ownership">,
  fallbackLabel: string,
): string {
  const ownership = project.ownership;
  if (!ownership) {
    return fallbackLabel;
  }

  const ownerLabel =
    ownership.organizationDisplayName ?? ownership.ownerDisplayName ?? ownership.tenantDisplayName;
  if (ownerLabel === ownership.workspaceTitle) {
    return ownership.workspaceTitle;
  }
  return `${ownership.workspaceTitle} / ${ownerLabel}`;
}

export function formatWorkspaceOwnershipLabel(
  workspace: Pick<
    WorkspaceDashboardWorkspace,
    "title" | "organizationDisplayName" | "ownerDisplayName" | "tenantDisplayName"
  >,
  fallbackLabel: string,
): string {
  const ownerLabel =
    workspace.organizationDisplayName ?? workspace.ownerDisplayName ?? workspace.tenantDisplayName;
  if (!ownerLabel) {
    return fallbackLabel;
  }
  if (ownerLabel === workspace.title) {
    return workspace.title;
  }
  return `${workspace.title} / ${ownerLabel}`;
}

export function buildWorkspaceDashboardModel(input: {
  readonly projects: readonly Project[];
  readonly threads: readonly SidebarThreadSummary[];
  readonly tenancySnapshots?: readonly WorkspaceDashboardTenancySnapshot[];
  readonly favoriteThreadKeys?: ReadonlySet<string>;
  readonly filterQuery?: string;
  readonly recentThreadLimit?: number;
  readonly archivedThreadLimit?: number;
}): WorkspaceDashboardModel {
  const normalizedFilterQuery = normalizeFilterQuery(input.filterQuery);
  const projectsByKey = new Map(input.projects.map((project) => [projectKey(project), project]));
  const visibleThreads = input.threads.filter((thread) => thread.archivedAt === null);
  const archivedThreads = input.threads.filter((thread) => thread.archivedAt !== null);
  const threadsByProjectKey = new Map<string, SidebarThreadSummary[]>();

  for (const thread of visibleThreads) {
    const key = threadProjectKey(thread);
    const projectThreads = threadsByProjectKey.get(key);
    if (projectThreads) {
      projectThreads.push(thread);
    } else {
      threadsByProjectKey.set(key, [thread]);
    }
  }

  const tenancyByEnvironment = new Map<Project["environmentId"], WorkspaceDashboardTenancySnapshot>(
    (input.tenancySnapshots ?? []).map((source) => [source.environmentId, source]),
  );
  const workspaceGroups = new Map<string, MutableWorkspace>();
  const projectWorkspaceKeyByProjectKey = new Map<string, string>();

  for (const source of input.tenancySnapshots ?? []) {
    for (const workspace of source.snapshot.workspaces ?? []) {
      if (workspace.archivedAt !== null) {
        continue;
      }
      const workspaceKey = persistedWorkspaceKey(source.environmentId, workspace.id);
      ensureWorkspace(workspaceGroups, workspaceKey, () =>
        workspaceFromPersisted(source, workspace),
      );
    }
  }

  for (const project of input.projects) {
    const projectThreads = threadsByProjectKey.get(projectKey(project)) ?? [];
    const sortedThreads = projectThreads.toSorted(compareThreadsByActivity);
    const latestThread = sortedThreads[0] ?? null;
    const source = tenancyByEnvironment.get(project.environmentId);
    const workspaceKey = workspaceKeyForProject(project);
    const projectEntry: WorkspaceDashboardProject = {
      project,
      workspaceKey,
      threadCount: projectThreads.length,
      activeThreadCount: projectThreads.filter(isActiveThread).length,
      latestThread,
      latestActivityAt: getProjectActivityAt(project, projectThreads),
    };
    projectWorkspaceKeyByProjectKey.set(projectKey(project), workspaceKey);

    const workspace = ensureWorkspace(workspaceGroups, workspaceKey, () =>
      workspaceFromProject(project, source?.environmentLabel ?? project.environmentId),
    );
    workspace.projects.push(projectEntry);
  }

  const allWorkspaces = Array.from(workspaceGroups.values())
    .map(finalizeWorkspace)
    .toSorted(compareWorkspacesByActivity);
  const workspaceByKey = new Map(allWorkspaces.map((workspace) => [workspace.key, workspace]));
  const filteredWorkspaces = allWorkspaces.filter((entry) =>
    matchesWorkspaceEntry(entry, normalizedFilterQuery),
  );

  const recentThreads = visibleThreads
    .map((thread) =>
      toDashboardThread(
        thread,
        projectsByKey,
        workspaceByKey,
        projectWorkspaceKeyByProjectKey,
        input.favoriteThreadKeys,
      ),
    )
    .filter((entry) => matchesThreadEntry(entry, normalizedFilterQuery))
    .toSorted(compareRecentThreads);
  const sortedArchivedThreads = archivedThreads
    .map((thread) =>
      toDashboardThread(
        thread,
        projectsByKey,
        workspaceByKey,
        projectWorkspaceKeyByProjectKey,
        input.favoriteThreadKeys,
      ),
    )
    .filter((entry) => matchesThreadEntry(entry, normalizedFilterQuery))
    .toSorted(compareArchivedThreads);

  return {
    workspaces: filteredWorkspaces,
    recentThreads:
      input.recentThreadLimit === undefined
        ? recentThreads
        : recentThreads.slice(0, input.recentThreadLimit),
    archivedThreads:
      input.archivedThreadLimit === undefined
        ? sortedArchivedThreads
        : sortedArchivedThreads.slice(0, input.archivedThreadLimit),
    createTargets: buildCreateTargets(input.tenancySnapshots ?? []),
    hasFilter: normalizedFilterQuery.length > 0,
    workspaceCount: filteredWorkspaces.length,
    projectCount: filteredWorkspaces.reduce(
      (count, workspace) => count + workspace.projectCount,
      0,
    ),
    activeThreadCount: recentThreads.filter((entry) => isActiveThread(entry.thread)).length,
    archivedThreadCount: sortedArchivedThreads.length,
    totalThreadCount: recentThreads.length,
  };
}

function workspaceFromPersisted(
  source: WorkspaceDashboardTenancySnapshot,
  workspace: Workspace,
): MutableWorkspace {
  const tenant = source.snapshot.tenants.find((entry) => entry.id === workspace.tenantId) ?? null;
  const organization =
    workspace.organizationId === null
      ? null
      : (source.snapshot.organizations.find((entry) => entry.id === workspace.organizationId) ??
        null);
  const owner = source.snapshot.employees.find(
    (employee) => employee.membership.userId === workspace.ownerUserId,
  );

  return {
    key: persistedWorkspaceKey(source.environmentId, workspace.id),
    environmentId: source.environmentId,
    workspaceId: workspace.id,
    tenantId: workspace.tenantId,
    organizationId: workspace.organizationId,
    title: workspace.title,
    scope: workspace.kind,
    accessMode: workspace.accessMode,
    tenantDisplayName: tenant?.displayName ?? null,
    organizationDisplayName: organization?.displayName ?? null,
    ownerUserId: workspace.ownerUserId,
    ownerDisplayName: owner?.displayName ?? null,
    createdAt: workspace.createdAt,
    projects: [],
    members: [...membersForWorkspace(source, workspace)],
    pendingInviteCount: pendingInvitesForWorkspace(source.snapshot.invites, workspace).length,
    ownership: {
      tenantId: workspace.tenantId,
      tenantDisplayName: tenant?.displayName ?? String(workspace.tenantId),
      workspaceId: workspace.id,
      workspaceTitle: workspace.title,
      organizationId: workspace.organizationId,
      organizationDisplayName: organization?.displayName ?? null,
      ownerUserId: workspace.ownerUserId,
      ownerDisplayName: owner?.displayName ?? null,
    },
  };
}

function workspaceFromProject(project: Project, environmentLabel: string): MutableWorkspace {
  const ownership = project.ownership ?? null;
  if (!ownership) {
    return {
      key: localWorkspaceKey(project.environmentId),
      environmentId: project.environmentId,
      workspaceId: null,
      tenantId: null,
      organizationId: null,
      title: `${environmentLabel} Personal Workspace`,
      scope: "local",
      accessMode: "local",
      tenantDisplayName: environmentLabel,
      organizationDisplayName: null,
      ownerUserId: null,
      ownerDisplayName: null,
      createdAt: null,
      projects: [],
      members: [],
      pendingInviteCount: 0,
      ownership: null,
    };
  }

  return {
    key: persistedWorkspaceKey(project.environmentId, ownership.workspaceId),
    environmentId: project.environmentId,
    workspaceId: ownership.workspaceId,
    tenantId: ownership.tenantId,
    organizationId: ownership.organizationId,
    title: ownership.workspaceTitle,
    scope: ownership.organizationId === null ? "personal" : "corporate",
    accessMode: ownership.organizationId === null ? "private" : "organization",
    tenantDisplayName: ownership.tenantDisplayName,
    organizationDisplayName: ownership.organizationDisplayName,
    ownerUserId: ownership.ownerUserId,
    ownerDisplayName: ownership.ownerDisplayName,
    createdAt: null,
    projects: [],
    members: ownership.ownerDisplayName
      ? [
          {
            id: String(ownership.ownerUserId),
            displayName: ownership.ownerDisplayName,
            email: null,
            status: "owner",
          },
        ]
      : [],
    pendingInviteCount: 0,
    ownership,
  };
}

function ensureWorkspace(
  workspaces: Map<string, MutableWorkspace>,
  key: string,
  create: () => MutableWorkspace,
): MutableWorkspace {
  const existing = workspaces.get(key);
  if (existing) {
    return existing;
  }
  const workspace = create();
  workspaces.set(key, workspace);
  return workspace;
}

function finalizeWorkspace(workspace: MutableWorkspace): WorkspaceDashboardWorkspace {
  const latestProject = workspace.projects
    .filter((project) => project.latestActivityAt !== null)
    .toSorted((left, right) =>
      compareIsoDesc(left.latestActivityAt ?? "", right.latestActivityAt ?? ""),
    )[0];
  const latestActivityAt =
    latestProject?.latestActivityAt ??
    workspace.createdAt ??
    workspace.projects[0]?.project.createdAt ??
    null;

  return {
    ...workspace,
    projects: workspace.projects.toSorted(compareProjectsByActivity),
    projectCount: workspace.projects.length,
    threadCount: workspace.projects.reduce((count, project) => count + project.threadCount, 0),
    activeThreadCount: workspace.projects.reduce(
      (count, project) => count + project.activeThreadCount,
      0,
    ),
    latestThread: latestProject?.latestThread ?? null,
    latestActivityAt,
  };
}

function toDashboardThread(
  thread: SidebarThreadSummary,
  projectsByKey: ReadonlyMap<string, Project>,
  workspaceByKey: ReadonlyMap<string, WorkspaceDashboardWorkspace>,
  projectWorkspaceKeyByProjectKey: ReadonlyMap<string, string>,
  favoriteThreadKeys: ReadonlySet<string> | undefined,
): WorkspaceDashboardThread {
  const project = projectsByKey.get(threadProjectKey(thread)) ?? null;
  const workspaceKey = projectWorkspaceKeyByProjectKey.get(threadProjectKey(thread)) ?? null;
  const workspace = workspaceKey ? (workspaceByKey.get(workspaceKey) ?? null) : null;
  return {
    thread,
    project,
    workspaceKey,
    workspaceTitle: workspace?.title ?? null,
    latestActivityAt: getThreadActivityAt(thread),
    isFavorite: thread.favorite || (favoriteThreadKeys?.has(threadKey(thread)) ?? false),
  };
}

function buildCreateTargets(
  sources: readonly WorkspaceDashboardTenancySnapshot[],
): readonly WorkspaceDashboardCreateTarget[] {
  const targets = sources
    .flatMap((source) =>
      source.snapshot.tenants.map((tenant): WorkspaceDashboardCreateTarget => {
        const organization =
          tenant.organizationId === null
            ? null
            : (source.snapshot.organizations.find(
                (candidate) => candidate.id === tenant.organizationId,
              ) ?? null);
        return {
          environmentId: source.environmentId,
          tenantId: tenant.id,
          label: organization
            ? `${organization.displayName} (${source.environmentLabel})`
            : `${tenant.displayName} (${source.environmentLabel})`,
          organizationId: tenant.organizationId,
          defaultKind: tenant.organizationId === null ? "personal" : "corporate",
          defaultAccessMode: tenant.organizationId === null ? "private" : "organization",
        };
      }),
    )
    .toSorted((left, right) => left.label.localeCompare(right.label));
  if (targets.length > 0) {
    return targets;
  }
  return sources.map((source) => ({
    environmentId: source.environmentId,
    tenantId: TenantId.make("tenant-local-personal"),
    label: `Local Personal (${source.environmentLabel})`,
    organizationId: null,
    defaultKind: "personal",
    defaultAccessMode: "private",
  }));
}

function membersForWorkspace(
  source: WorkspaceDashboardTenancySnapshot,
  workspace: Workspace,
): readonly WorkspaceDashboardMember[] {
  const activeWorkspaceGrants = source.snapshot.grants.filter(
    (grant) =>
      grant.revokedAt === null &&
      grant.organizationId === workspace.organizationId &&
      grant.scope.type === "workspace" &&
      grant.scope.workspaceId === workspace.id,
  );
  const grantedMembershipIds = new Set(activeWorkspaceGrants.map((grant) => grant.membershipId));
  const employees = source.snapshot.employees.filter((employee) => {
    if (employee.membership.tenantId !== workspace.tenantId) {
      return false;
    }
    if (workspace.accessMode === "organization") {
      return (
        workspace.organizationId !== null &&
        employee.membership.organizationId === workspace.organizationId
      );
    }
    return (
      employee.membership.userId === workspace.ownerUserId ||
      grantedMembershipIds.has(employee.membership.id)
    );
  });
  const members = employees.map(
    (employee): WorkspaceDashboardMember => ({
      id: String(employee.membership.id),
      displayName: employee.displayName,
      email: employee.email,
      status:
        employee.membership.userId === workspace.ownerUserId
          ? "owner"
          : employee.status === "active"
            ? "active"
            : employee.status,
    }),
  );
  if (members.length > 0) {
    return members;
  }
  return [
    {
      id: String(workspace.ownerUserId),
      displayName: String(workspace.ownerUserId),
      email: null,
      status: "owner",
    },
  ];
}

function pendingInvitesForWorkspace(
  invites: readonly TenantInvite[],
  workspace: Workspace,
): readonly TenantInvite[] {
  return invites.filter(
    (invite) =>
      invite.workspaceId === workspace.id &&
      invite.acceptedAt === null &&
      invite.revokedAt === null &&
      new Date(invite.expiresAt).getTime() > Date.now(),
  );
}

function isActiveThread(thread: SidebarThreadSummary): boolean {
  return (
    thread.hasPendingApprovals ||
    thread.hasPendingUserInput ||
    thread.hasActionableProposedPlan ||
    thread.session?.status === "running" ||
    thread.session?.status === "connecting"
  );
}

function matchesWorkspaceEntry(entry: WorkspaceDashboardWorkspace, query: string): boolean {
  if (query.length === 0) {
    return true;
  }
  return includesFilterText(
    query,
    entry.title,
    entry.tenantDisplayName,
    entry.organizationDisplayName,
    entry.ownerDisplayName,
    entry.accessMode,
    entry.scope,
    entry.latestThread?.title,
    ...entry.members.flatMap((member) => [member.displayName, member.email]),
    ...entry.projects.flatMap((project) => [
      project.project.name,
      project.project.cwd,
      project.latestThread?.title,
      project.latestThread?.branch,
    ]),
  );
}

function matchesThreadEntry(entry: WorkspaceDashboardThread, query: string): boolean {
  if (query.length === 0) {
    return true;
  }
  return includesFilterText(
    query,
    entry.thread.title,
    entry.thread.branch,
    entry.workspaceTitle,
    entry.project?.name,
    entry.project?.cwd,
    entry.project?.ownership?.workspaceTitle,
    entry.project?.ownership?.organizationDisplayName,
    entry.project?.ownership?.ownerDisplayName,
    entry.project?.ownership?.tenantDisplayName,
  );
}

function includesFilterText(query: string, ...values: Array<string | null | undefined>): boolean {
  return values.some(
    (value) => value !== null && value !== undefined && normalizeFilterQuery(value).includes(query),
  );
}

function normalizeFilterQuery(value: string | null | undefined): string {
  return (value ?? "").trim().toLocaleLowerCase();
}

function compareWorkspacesByActivity(
  left: WorkspaceDashboardWorkspace,
  right: WorkspaceDashboardWorkspace,
): number {
  const activityCompare = compareNullableIsoDesc(left.latestActivityAt, right.latestActivityAt);
  if (activityCompare !== 0) return activityCompare;
  return left.title.localeCompare(right.title);
}

function compareProjectsByActivity(
  left: WorkspaceDashboardProject,
  right: WorkspaceDashboardProject,
): number {
  const activityCompare = compareNullableIsoDesc(left.latestActivityAt, right.latestActivityAt);
  if (activityCompare !== 0) return activityCompare;
  return left.project.name.localeCompare(right.project.name);
}

function compareRecentThreads(
  left: WorkspaceDashboardThread,
  right: WorkspaceDashboardThread,
): number {
  if (left.isFavorite !== right.isFavorite) {
    return left.isFavorite ? -1 : 1;
  }
  const activityCompare = compareIsoDesc(left.latestActivityAt, right.latestActivityAt);
  if (activityCompare !== 0) return activityCompare;
  return left.thread.title.localeCompare(right.thread.title);
}

function compareArchivedThreads(
  left: WorkspaceDashboardThread,
  right: WorkspaceDashboardThread,
): number {
  const leftArchivedAt = left.thread.archivedAt ?? left.thread.createdAt;
  const rightArchivedAt = right.thread.archivedAt ?? right.thread.createdAt;
  const archivedCompare = compareIsoDesc(leftArchivedAt, rightArchivedAt);
  if (archivedCompare !== 0) return archivedCompare;
  return left.thread.title.localeCompare(right.thread.title);
}

function compareThreadsByActivity(left: SidebarThreadSummary, right: SidebarThreadSummary): number {
  const activityCompare = compareIsoDesc(getThreadActivityAt(left), getThreadActivityAt(right));
  if (activityCompare !== 0) return activityCompare;
  return left.title.localeCompare(right.title);
}

function compareNullableIsoDesc(left: string | null, right: string | null): number {
  if (left === right) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return compareIsoDesc(left, right);
}

function compareIsoDesc(left: string, right: string): number {
  return right.localeCompare(left);
}

function workspaceKeyForProject(project: Project): string {
  const ownership = project.ownership;
  if (!ownership) {
    return localWorkspaceKey(project.environmentId);
  }
  return persistedWorkspaceKey(project.environmentId, ownership.workspaceId);
}

function persistedWorkspaceKey(
  environmentId: Project["environmentId"],
  workspaceId: string,
): string {
  return `${environmentId}:workspace:${workspaceId}`;
}

function localWorkspaceKey(environmentId: Project["environmentId"]): string {
  return `${environmentId}:local-workspace`;
}

function projectKey(project: Project): string {
  return `${project.environmentId}:${project.id}`;
}

function threadProjectKey(thread: SidebarThreadSummary): string {
  return `${thread.environmentId}:${thread.projectId}`;
}

function threadKey(thread: SidebarThreadSummary): string {
  return `${thread.environmentId}:${thread.id}`;
}
