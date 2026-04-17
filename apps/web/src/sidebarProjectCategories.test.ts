import { describe, expect, it } from "vitest";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";

import {
  buildSidebarProjectCategoryTree,
  canAssignSidebarProjectCategoryParent,
  resolveSidebarProjectCategoryId,
  type SidebarProjectCategory,
} from "./sidebarProjectCategories";
import type { SidebarProjectSnapshot } from "./sidebarProjectGrouping";

const primaryEnvironmentId = EnvironmentId.make("env-primary");

function makeProjectSnapshot(
  overrides: Partial<SidebarProjectSnapshot> & Pick<SidebarProjectSnapshot, "id" | "name" | "cwd">,
): SidebarProjectSnapshot {
  return {
    id: overrides.id,
    environmentId: primaryEnvironmentId,
    name: overrides.name,
    cwd: overrides.cwd,
    projectKey: overrides.projectKey ?? `${primaryEnvironmentId}:${overrides.cwd}`,
    displayName: overrides.displayName ?? overrides.name,
    groupedProjectCount: overrides.groupedProjectCount ?? 1,
    environmentPresence: overrides.environmentPresence ?? "local-only",
    memberProjects: overrides.memberProjects ?? [
      {
        id: overrides.id,
        environmentId: primaryEnvironmentId,
        name: overrides.name,
        cwd: overrides.cwd,
        scripts: [],
        defaultModelSelection: null,
        physicalProjectKey: overrides.projectKey ?? `${primaryEnvironmentId}:${overrides.cwd}`,
        environmentLabel: null,
      },
    ],
    memberProjectRefs: overrides.memberProjectRefs ?? [],
    remoteEnvironmentLabels: overrides.remoteEnvironmentLabels ?? [],
    scripts: overrides.scripts ?? [],
    defaultModelSelection: overrides.defaultModelSelection ?? null,
    createdAt: overrides.createdAt,
    updatedAt: overrides.updatedAt,
    repositoryIdentity: overrides.repositoryIdentity ?? null,
  };
}

describe("sidebarProjectCategories", () => {
  it("resolves a shared category only when all grouped members agree", () => {
    const project = makeProjectSnapshot({
      id: ProjectId.make("project-1"),
      name: "project-1",
      cwd: "/repo/project-1",
      projectKey: "project-1",
      groupedProjectCount: 2,
      memberProjects: [
        {
          id: ProjectId.make("project-1a"),
          environmentId: primaryEnvironmentId,
          name: "project-1a",
          cwd: "/repo/project-1a",
          scripts: [],
          defaultModelSelection: null,
          physicalProjectKey: "physical-1a",
          environmentLabel: null,
        },
        {
          id: ProjectId.make("project-1b"),
          environmentId: primaryEnvironmentId,
          name: "project-1b",
          cwd: "/repo/project-1b",
          scripts: [],
          defaultModelSelection: null,
          physicalProjectKey: "physical-1b",
          environmentLabel: null,
        },
      ],
    });

    expect(
      resolveSidebarProjectCategoryId(project, {
        "physical-1a": "cat-apps",
        "physical-1b": "cat-apps",
      }),
    ).toBe("cat-apps");

    expect(
      resolveSidebarProjectCategoryId(project, {
        "physical-1a": "cat-apps",
        "physical-1b": "cat-tools",
      }),
    ).toBeNull();
  });

  it("builds nested category trees and leaves mixed projects uncategorized", () => {
    const categories: SidebarProjectCategory[] = [
      { id: "cat-apps", name: "Apps", parentId: null },
      { id: "cat-mobile", name: "Mobile", parentId: "cat-apps" },
      { id: "cat-tools", name: "Tools", parentId: null },
    ];
    const website = makeProjectSnapshot({
      id: ProjectId.make("website"),
      name: "website",
      cwd: "/repo/website",
      projectKey: "website",
      memberProjects: [
        {
          id: ProjectId.make("website-1"),
          environmentId: primaryEnvironmentId,
          name: "website-1",
          cwd: "/repo/website-1",
          scripts: [],
          defaultModelSelection: null,
          physicalProjectKey: "website-1",
          environmentLabel: null,
        },
      ],
    });
    const mobile = makeProjectSnapshot({
      id: ProjectId.make("mobile"),
      name: "mobile",
      cwd: "/repo/mobile",
      projectKey: "mobile",
      memberProjects: [
        {
          id: ProjectId.make("mobile-1"),
          environmentId: primaryEnvironmentId,
          name: "mobile-1",
          cwd: "/repo/mobile-1",
          scripts: [],
          defaultModelSelection: null,
          physicalProjectKey: "mobile-1",
          environmentLabel: null,
        },
      ],
    });
    const mixed = makeProjectSnapshot({
      id: ProjectId.make("mixed"),
      name: "mixed",
      cwd: "/repo/mixed",
      projectKey: "mixed",
      groupedProjectCount: 2,
      memberProjects: [
        {
          id: ProjectId.make("mixed-1"),
          environmentId: primaryEnvironmentId,
          name: "mixed-1",
          cwd: "/repo/mixed-1",
          scripts: [],
          defaultModelSelection: null,
          physicalProjectKey: "mixed-1",
          environmentLabel: null,
        },
        {
          id: ProjectId.make("mixed-2"),
          environmentId: primaryEnvironmentId,
          name: "mixed-2",
          cwd: "/repo/mixed-2",
          scripts: [],
          defaultModelSelection: null,
          physicalProjectKey: "mixed-2",
          environmentLabel: null,
        },
      ],
    });

    const result = buildSidebarProjectCategoryTree({
      categories,
      categoryOrder: ["cat-apps", "cat-mobile", "cat-tools"],
      projects: [website, mobile, mixed],
      categoryByPhysicalProjectKey: {
        "website-1": "cat-apps",
        "mobile-1": "cat-mobile",
        "mixed-1": "cat-apps",
        "mixed-2": "cat-tools",
      },
    });

    expect(result.rootCategories.map((node) => node.category.id)).toEqual([
      "cat-apps",
      "cat-tools",
    ]);
    expect(result.rootCategories[0]?.projects.map((project) => project.projectKey)).toEqual([
      "website",
    ]);
    expect(result.rootCategories[0]?.children.map((node) => node.category.id)).toEqual([
      "cat-mobile",
    ]);
    expect(
      result.rootCategories[0]?.children[0]?.projects.map((project) => project.projectKey),
    ).toEqual(["mobile"]);
    expect(result.uncategorizedProjects.map((project) => project.projectKey)).toEqual(["mixed"]);
  });

  it("rejects assigning a category to one of its descendants", () => {
    const categories: SidebarProjectCategory[] = [
      { id: "cat-parent", name: "Parent", parentId: null },
      { id: "cat-child", name: "Child", parentId: "cat-parent" },
      { id: "cat-grandchild", name: "Grandchild", parentId: "cat-child" },
    ];

    expect(
      canAssignSidebarProjectCategoryParent({
        categories,
        categoryId: "cat-parent",
        parentId: "cat-grandchild",
      }),
    ).toBe(false);
    expect(
      canAssignSidebarProjectCategoryParent({
        categories,
        categoryId: "cat-child",
        parentId: "cat-parent",
      }),
    ).toBe(true);
  });

  it("treats cyclic category parents as top-level categories", () => {
    const categories: SidebarProjectCategory[] = [
      { id: "cat-a", name: "A", parentId: "cat-b" },
      { id: "cat-b", name: "B", parentId: "cat-a" },
    ];

    const result = buildSidebarProjectCategoryTree({
      categories,
      categoryOrder: ["cat-a", "cat-b"],
      projects: [],
      categoryByPhysicalProjectKey: {},
    });

    expect(result.rootCategories.map((node) => node.category.id)).toEqual(["cat-a", "cat-b"]);
  });
});
