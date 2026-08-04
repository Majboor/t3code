import {
  EnvironmentId,
  MembershipId,
  OrganizationId,
  ProjectId,
  TenantId,
  TenantRuntimeId,
  ThreadId,
  UserId,
  WorkspaceId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  buildWorkspaceDashboardModel,
  formatProjectOwnershipLabel,
  getProjectActivityAt,
  getThreadActivityAt,
  humanizeUserId,
} from "./WorkspaceDashboard.logic";
import type { Project, SidebarThreadSummary } from "../types";

const LOCAL_ENVIRONMENT_ID = EnvironmentId.make("environment-local");

describe("WorkspaceDashboard.logic", () => {
  it("groups owned projects by workspace and orders workspaces by activity", () => {
    const staleProject = makeProject({
      id: "project-stale",
      name: "Stale",
      updatedAt: "2026-03-04T12:00:00.000Z",
      ownership: makeOwnership({
        workspaceId: "workspace-stale",
        workspaceTitle: "Stale Workspace",
      }),
    });
    const activeProject = makeProject({
      id: "project-active",
      name: "Active",
      updatedAt: "2026-03-04T12:01:00.000Z",
      ownership: makeOwnership({
        workspaceId: "workspace-active",
        workspaceTitle: "Active Workspace",
      }),
    });
    const model = buildWorkspaceDashboardModel({
      projects: [staleProject, activeProject],
      threads: [
        makeThread({
          id: "thread-stale",
          projectId: staleProject.id,
          title: "Stale thread",
          latestUserMessageAt: "2026-03-04T12:05:00.000Z",
        }),
        makeThread({
          id: "thread-active",
          projectId: activeProject.id,
          title: "Active thread",
          latestUserMessageAt: "2026-03-04T12:15:00.000Z",
        }),
      ],
    });

    expect(model.workspaces.map((entry) => entry.title)).toEqual([
      "Active Workspace",
      "Stale Workspace",
    ]);
    expect(model.workspaces[0]?.projects.map((entry) => entry.project.id)).toEqual([
      activeProject.id,
    ]);
    expect(model.workspaces[0]?.latestThread?.title).toBe("Active thread");
  });

  it("keeps multiple projects inside the same product workspace", () => {
    const ownership = makeOwnership({
      workspaceId: "workspace-product",
      workspaceTitle: "Product Workspace",
    });
    const apiProject = makeProject({ id: "project-api", name: "API", ownership });
    const webProject = makeProject({ id: "project-web", name: "Web", ownership });
    const model = buildWorkspaceDashboardModel({
      projects: [apiProject, webProject],
      threads: [
        makeThread({ id: "thread-api", projectId: apiProject.id }),
        makeThread({ id: "thread-web", projectId: webProject.id }),
      ],
    });

    expect(model.workspaceCount).toBe(1);
    expect(model.projectCount).toBe(2);
    expect(model.workspaces[0]?.title).toBe("Product Workspace");
    expect(model.workspaces[0]?.projects.map((entry) => entry.project.name)).toEqual([
      "API",
      "Web",
    ]);
  });

  it("shows persisted workspaces even before projects are attached", () => {
    const model = buildWorkspaceDashboardModel({
      projects: [],
      threads: [],
      tenancySnapshots: [
        {
          environmentId: LOCAL_ENVIRONMENT_ID,
          environmentLabel: "Local",
          snapshot: {
            organizations: [
              {
                id: OrganizationId.make("org-acme"),
                slug: "acme",
                displayName: "Acme Inc",
                createdAt: "2026-03-04T12:00:00.000Z",
                archivedAt: null,
              },
            ],
            tenants: [
              {
                id: TenantId.make("tenant-acme"),
                slug: "acme",
                displayName: "Acme",
                kind: "corporate",
                organizationId: OrganizationId.make("org-acme"),
                runtimeId: TenantRuntimeId.make("runtime-acme"),
                createdAt: "2026-03-04T12:00:00.000Z",
                archivedAt: null,
              },
            ],
            workspaces: [
              {
                id: WorkspaceId.make("workspace-product"),
                tenantId: TenantId.make("tenant-acme"),
                organizationId: OrganizationId.make("org-acme"),
                ownerUserId: UserId.make("user-ada"),
                kind: "corporate",
                accessMode: "organization",
                title: "Product Workspace",
                createdAt: "2026-03-04T12:00:00.000Z",
                archivedAt: null,
              },
            ],
            employees: [
              {
                membership: {
                  id: MembershipId.make("membership-ada"),
                  tenantId: TenantId.make("tenant-acme"),
                  userId: UserId.make("user-ada"),
                  organizationId: OrganizationId.make("org-acme"),
                  roles: ["owner"],
                  organizationRoles: ["owner"],
                  createdAt: "2026-03-04T12:00:00.000Z",
                  disabledAt: null,
                },
                email: "ada@example.test",
                displayName: "Ada Lovelace",
                status: "active",
              },
            ],
            invites: [],
            memberships: [],
            teams: [],
            departments: [],
            grants: [],
            reviews: [],
          },
        },
      ],
    });

    expect(model.workspaceCount).toBe(1);
    expect(model.workspaces[0]?.title).toBe("Product Workspace");
    expect(model.workspaces[0]?.projectCount).toBe(0);
    expect(model.workspaces[0]?.members[0]?.displayName).toBe("Ada Lovelace");
    expect(model.createTargets.map((target) => target.label)).toEqual(["Acme Inc (Local)"]);
  });

  it("falls back to project metadata when a workspace has no sessions", () => {
    const project = makeProject({
      id: "project-empty",
      updatedAt: "2026-03-04T13:00:00.000Z",
    });

    expect(getProjectActivityAt(project, [])).toBe("2026-03-04T13:00:00.000Z");
  });

  it("ignores archived sessions and caps recent sessions", () => {
    const project = makeProject({ id: "project-1" });
    const model = buildWorkspaceDashboardModel({
      projects: [project],
      recentThreadLimit: 2,
      threads: [
        makeThread({
          id: "thread-1",
          projectId: project.id,
          title: "Old",
          latestUserMessageAt: "2026-03-04T12:01:00.000Z",
        }),
        makeThread({
          id: "thread-2",
          projectId: project.id,
          title: "Newest",
          latestUserMessageAt: "2026-03-04T12:03:00.000Z",
        }),
        makeThread({
          id: "thread-3",
          projectId: project.id,
          title: "Middle",
          latestUserMessageAt: "2026-03-04T12:02:00.000Z",
        }),
        makeThread({
          id: "thread-4",
          projectId: project.id,
          title: "Archived",
          archivedAt: "2026-03-04T12:04:00.000Z",
          latestUserMessageAt: "2026-03-04T12:04:00.000Z",
        }),
      ],
    });

    expect(model.totalThreadCount).toBe(3);
    expect(model.recentThreads.map((entry) => entry.thread.title)).toEqual(["Newest", "Middle"]);
    expect(model.archivedThreadCount).toBe(1);
  });

  it("surfaces latest archived sessions separately from recent sessions", () => {
    const project = makeProject({ id: "project-1" });
    const model = buildWorkspaceDashboardModel({
      projects: [project],
      archivedThreadLimit: 1,
      threads: [
        makeThread({
          id: "thread-open",
          projectId: project.id,
          title: "Open",
          latestUserMessageAt: "2026-03-04T12:05:00.000Z",
        }),
        makeThread({
          id: "thread-archived-old",
          projectId: project.id,
          title: "Archived old",
          archivedAt: "2026-03-04T12:01:00.000Z",
        }),
        makeThread({
          id: "thread-archived-new",
          projectId: project.id,
          title: "Archived new",
          archivedAt: "2026-03-04T12:03:00.000Z",
        }),
      ],
    });

    expect(model.recentThreads.map((entry) => entry.thread.title)).toEqual(["Open"]);
    expect(model.archivedThreadCount).toBe(2);
    expect(model.archivedThreads.map((entry) => entry.thread.title)).toEqual(["Archived new"]);
  });

  it("keeps favorite sessions at the top before applying the recent session cap", () => {
    const project = makeProject({ id: "project-1" });
    const model = buildWorkspaceDashboardModel({
      projects: [project],
      favoriteThreadKeys: new Set([`${LOCAL_ENVIRONMENT_ID}:thread-old-favorite`]),
      recentThreadLimit: 2,
      threads: [
        makeThread({
          id: "thread-newest",
          projectId: project.id,
          title: "Newest",
          latestUserMessageAt: "2026-03-04T12:03:00.000Z",
        }),
        makeThread({
          id: "thread-old-favorite",
          projectId: project.id,
          title: "Old favorite",
          latestUserMessageAt: "2026-03-04T12:01:00.000Z",
        }),
        makeThread({
          id: "thread-middle",
          projectId: project.id,
          title: "Middle",
          latestUserMessageAt: "2026-03-04T12:02:00.000Z",
        }),
      ],
    });

    expect(model.recentThreads.map((entry) => [entry.thread.title, entry.isFavorite])).toEqual([
      ["Old favorite", true],
      ["Newest", false],
    ]);
  });

  it("treats server favorites as authoritative while keeping local favorites as fallback", () => {
    const project = makeProject({ id: "project-1" });
    const model = buildWorkspaceDashboardModel({
      projects: [project],
      favoriteThreadKeys: new Set([`${LOCAL_ENVIRONMENT_ID}:thread-local-favorite`]),
      threads: [
        makeThread({
          id: "thread-server-favorite",
          projectId: project.id,
          title: "Server favorite",
          favorite: true,
          latestUserMessageAt: "2026-03-04T12:01:00.000Z",
        }),
        makeThread({
          id: "thread-local-favorite",
          projectId: project.id,
          title: "Local favorite",
          latestUserMessageAt: "2026-03-04T12:03:00.000Z",
        }),
        makeThread({
          id: "thread-regular",
          projectId: project.id,
          title: "Regular",
          latestUserMessageAt: "2026-03-04T12:05:00.000Z",
        }),
      ],
    });

    expect(model.recentThreads.map((entry) => [entry.thread.title, entry.isFavorite])).toEqual([
      ["Local favorite", true],
      ["Server favorite", true],
      ["Regular", false],
    ]);
  });

  it("filters workspaces, recent sessions, and archived sessions before applying caps", () => {
    const docsProject = makeProject({
      id: "project-docs",
      name: "Docs Portal",
      ownership: makeOwnership({
        workspaceId: "workspace-docs",
        workspaceTitle: "Docs Workspace",
      }),
    });
    const appProject = makeProject({
      id: "project-app",
      name: "App Shell",
      ownership: makeOwnership({
        workspaceId: "workspace-app",
        workspaceTitle: "App Workspace",
      }),
    });
    const model = buildWorkspaceDashboardModel({
      projects: [docsProject, appProject],
      filterQuery: "docs",
      recentThreadLimit: 1,
      archivedThreadLimit: 1,
      threads: [
        makeThread({
          id: "thread-app",
          projectId: appProject.id,
          title: "App checklist",
          latestUserMessageAt: "2026-03-04T12:10:00.000Z",
        }),
        makeThread({
          id: "thread-docs",
          projectId: docsProject.id,
          title: "Release checklist",
          latestUserMessageAt: "2026-03-04T12:01:00.000Z",
        }),
        makeThread({
          id: "thread-archived-docs",
          projectId: appProject.id,
          title: "Archived Docs Notes",
          archivedAt: "2026-03-04T12:03:00.000Z",
        }),
      ],
    });

    expect(model.hasFilter).toBe(true);
    expect(model.workspaces.map((entry) => entry.title)).toEqual(["Docs Workspace"]);
    expect(model.workspaces[0]?.projects.map((entry) => entry.project.name)).toEqual([
      "Docs Portal",
    ]);
    expect(model.recentThreads.map((entry) => entry.thread.title)).toEqual(["Release checklist"]);
    expect(model.archivedThreads.map((entry) => entry.thread.title)).toEqual([
      "Archived Docs Notes",
    ]);
    expect(model.totalThreadCount).toBe(1);
    expect(model.archivedThreadCount).toBe(1);
  });

  it("counts sessions that need user attention as active", () => {
    const project = makeProject({ id: "project-1" });
    const model = buildWorkspaceDashboardModel({
      projects: [project],
      threads: [
        makeThread({ id: "thread-1", projectId: project.id, hasPendingUserInput: true }),
        makeThread({ id: "thread-2", projectId: project.id, sessionStatus: "running" }),
        makeThread({ id: "thread-3", projectId: project.id }),
      ],
    });

    expect(model.activeThreadCount).toBe(2);
    expect(model.workspaces[0]?.activeThreadCount).toBe(2);
  });

  it("prefers latest user-message activity over generic updates", () => {
    const thread = makeThread({
      id: "thread-1",
      projectId: "project-1",
      latestUserMessageAt: "2026-03-04T12:20:00.000Z",
      updatedAt: "2026-03-04T12:30:00.000Z",
    });

    expect(getThreadActivityAt(thread)).toBe("2026-03-04T12:20:00.000Z");
  });

  it("formats project ownership labels from workspace and organization metadata", () => {
    expect(
      formatProjectOwnershipLabel(
        makeProject({
          id: "project-owned",
          ownership: {
            tenantId: TenantId.make("tenant-acme"),
            tenantDisplayName: "Acme",
            workspaceId: WorkspaceId.make("workspace-product"),
            workspaceTitle: "Product Workspace",
            organizationId: OrganizationId.make("org-acme"),
            organizationDisplayName: "Acme Inc",
            ownerUserId: UserId.make("user-ada"),
            ownerDisplayName: "Ada Lovelace",
          },
        }),
        "Local environment",
      ),
    ).toBe("Product Workspace / Acme Inc");

    expect(formatProjectOwnershipLabel(makeProject({ id: "project-local" }), "Local")).toBe(
      "Local",
    );
  });
});

function makeOwnership(input: {
  workspaceId: string;
  workspaceTitle: string;
  organizationId?: string | null;
  organizationDisplayName?: string | null;
}): NonNullable<Project["ownership"]> {
  return {
    tenantId: TenantId.make("tenant-acme"),
    tenantDisplayName: "Acme",
    workspaceId: WorkspaceId.make(input.workspaceId),
    workspaceTitle: input.workspaceTitle,
    organizationId:
      input.organizationId === undefined
        ? OrganizationId.make("org-acme")
        : input.organizationId === null
          ? null
          : OrganizationId.make(input.organizationId),
    organizationDisplayName:
      input.organizationDisplayName === undefined ? "Acme Inc" : input.organizationDisplayName,
    ownerUserId: UserId.make("user-ada"),
    ownerDisplayName: "Ada Lovelace",
  };
}

function makeProject(input: {
  id: string;
  name?: string;
  updatedAt?: string;
  createdAt?: string;
  ownership?: Project["ownership"];
}): Project {
  return {
    id: input.id as ProjectId,
    environmentId: LOCAL_ENVIRONMENT_ID,
    name: input.name ?? input.id,
    cwd: `/repo/${input.id}`,
    repositoryIdentity: null,
    defaultModelSelection: null,
    createdAt: input.createdAt ?? "2026-03-04T12:00:00.000Z",
    updatedAt: input.updatedAt ?? "2026-03-04T12:00:00.000Z",
    ownership: input.ownership ?? null,
    scripts: [],
  };
}

function makeThread(input: {
  id: string;
  projectId: string | ProjectId;
  title?: string;
  archivedAt?: string | null;
  updatedAt?: string;
  latestUserMessageAt?: string | null;
  favorite?: boolean;
  hasPendingUserInput?: boolean;
  sessionStatus?: NonNullable<SidebarThreadSummary["session"]>["status"];
}): SidebarThreadSummary {
  return {
    id: input.id as ThreadId,
    environmentId: LOCAL_ENVIRONMENT_ID,
    projectId: input.projectId as ProjectId,
    title: input.title ?? input.id,
    interactionMode: "default",
    session: {
      provider: "codex",
      status: input.sessionStatus ?? "ready",
      orchestrationStatus: input.sessionStatus === "running" ? "running" : "ready",
      activeTurnId: undefined,
      createdAt: "2026-03-04T12:00:00.000Z",
      updatedAt: input.updatedAt ?? "2026-03-04T12:00:00.000Z",
    },
    createdAt: "2026-03-04T12:00:00.000Z",
    favorite: input.favorite ?? false,
    archivedAt: input.archivedAt ?? null,
    updatedAt: input.updatedAt ?? "2026-03-04T12:00:00.000Z",
    latestTurn: null,
    branch: null,
    worktreePath: null,
    latestUserMessageAt: input.latestUserMessageAt ?? null,
    hasPendingApprovals: false,
    hasPendingUserInput: input.hasPendingUserInput ?? false,
    hasActionableProposedPlan: false,
  };
}

describe("humanizeUserId", () => {
  it("strips provider prefixes from user ids", () => {
    expect(humanizeUserId("supabase:fdc0efa3-dc89-4788")).toBe("fdc0efa3 dc89 4788");
    expect(humanizeUserId("local:8496f94e")).toBe("8496f94e");
    expect(humanizeUserId("auth:loopback-local-owner")).toBe("loopback local owner");
  });

  it("keeps ids that carry no provider prefix", () => {
    expect(humanizeUserId("plain-owner")).toBe("plain owner");
  });
});
