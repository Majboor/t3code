import type { SidebarProjectSnapshot } from "./sidebarProjectGrouping";

export interface SidebarProjectCategory {
  id: string;
  name: string;
  parentId: string | null;
}

export interface SidebarProjectCategoryNode {
  category: SidebarProjectCategory;
  children: SidebarProjectCategoryNode[];
  projects: SidebarProjectSnapshot[];
  projectCount: number;
}

const SORT_LOCALE_OPTIONS: Intl.CollatorOptions = { numeric: true, sensitivity: "base" };

function compareByName(left: { name: string }, right: { name: string }): number {
  return left.name.localeCompare(right.name, undefined, SORT_LOCALE_OPTIONS);
}

function uniqueNonEmptyValues(values: ReadonlyArray<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];

  for (const value of values) {
    const trimmed = value?.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    unique.push(trimmed);
  }

  return unique;
}

function finalizeSidebarProjectCategoryNode(
  node: SidebarProjectCategoryNode,
): SidebarProjectCategoryNode {
  const children = node.children.map(finalizeSidebarProjectCategoryNode);
  const projectCount =
    node.projects.length + children.reduce((count, child) => count + child.projectCount, 0);

  return {
    ...node,
    children,
    projectCount,
  };
}

export function orderSidebarProjectCategories(
  categories: ReadonlyArray<SidebarProjectCategory>,
  categoryOrder: ReadonlyArray<string>,
): SidebarProjectCategory[] {
  if (categories.length <= 1) {
    return [...categories];
  }

  const orderIndexById = new Map(categoryOrder.map((id, index) => [id, index] as const));

  return [...categories].toSorted((left, right) => {
    const leftOrderIndex = orderIndexById.get(left.id);
    const rightOrderIndex = orderIndexById.get(right.id);

    if (leftOrderIndex !== undefined || rightOrderIndex !== undefined) {
      return (
        (leftOrderIndex ?? Number.POSITIVE_INFINITY) - (rightOrderIndex ?? Number.POSITIVE_INFINITY)
      );
    }

    return compareByName(left, right);
  });
}

export function resolveSidebarProjectCategoryId(
  project: SidebarProjectSnapshot,
  categoryByPhysicalProjectKey: Readonly<Record<string, string>>,
): string | null {
  const categoryIds = uniqueNonEmptyValues(
    project.memberProjects.map((member) => categoryByPhysicalProjectKey[member.physicalProjectKey]),
  );

  return categoryIds.length === 1 ? categoryIds[0]! : null;
}

export function isSidebarProjectCategoryAncestor(input: {
  categories: ReadonlyArray<SidebarProjectCategory>;
  ancestorId: string;
  categoryId: string;
}): boolean {
  const parentIdByCategoryId = new Map(
    input.categories.map((category) => [category.id, category.parentId] as const),
  );

  const visitedCategoryIds = new Set<string>();
  let parentId = parentIdByCategoryId.get(input.categoryId) ?? null;
  while (parentId) {
    if (visitedCategoryIds.has(parentId)) {
      return false;
    }
    visitedCategoryIds.add(parentId);

    if (parentId === input.ancestorId) {
      return true;
    }
    parentId = parentIdByCategoryId.get(parentId) ?? null;
  }

  return false;
}

export function canAssignSidebarProjectCategoryParent(input: {
  categories: ReadonlyArray<SidebarProjectCategory>;
  categoryId: string;
  parentId: string | null;
}): boolean {
  if (!input.parentId) {
    return true;
  }

  if (input.parentId === input.categoryId) {
    return false;
  }

  return !isSidebarProjectCategoryAncestor({
    categories: input.categories,
    ancestorId: input.categoryId,
    categoryId: input.parentId,
  });
}

export function buildSidebarProjectCategoryTree(input: {
  categories: ReadonlyArray<SidebarProjectCategory>;
  categoryOrder: ReadonlyArray<string>;
  projects: ReadonlyArray<SidebarProjectSnapshot>;
  categoryByPhysicalProjectKey: Readonly<Record<string, string>>;
}): {
  rootCategories: SidebarProjectCategoryNode[];
  uncategorizedProjects: SidebarProjectSnapshot[];
  projectCategoryByProjectKey: Map<string, string | null>;
} {
  const orderedCategories = orderSidebarProjectCategories(input.categories, input.categoryOrder);
  const categoryById = new Map(
    orderedCategories.map((category) => [category.id, category] as const),
  );
  const nodeById = new Map<string, SidebarProjectCategoryNode>(
    orderedCategories.map((category) => [
      category.id,
      {
        category,
        children: [],
        projects: [],
        projectCount: 0,
      },
    ]),
  );

  const projectCategoryByProjectKey = new Map<string, string | null>();
  const uncategorizedProjects: SidebarProjectSnapshot[] = [];

  for (const project of input.projects) {
    const categoryId = resolveSidebarProjectCategoryId(project, input.categoryByPhysicalProjectKey);
    const resolvedCategoryId = categoryId && categoryById.has(categoryId) ? categoryId : null;
    projectCategoryByProjectKey.set(project.projectKey, resolvedCategoryId);

    if (!resolvedCategoryId) {
      uncategorizedProjects.push(project);
      continue;
    }

    nodeById.get(resolvedCategoryId)?.projects.push(project);
  }

  const rootCategories: SidebarProjectCategoryNode[] = [];
  for (const category of orderedCategories) {
    const node = nodeById.get(category.id);
    if (!node) {
      continue;
    }

    const validParentId =
      category.parentId &&
      categoryById.has(category.parentId) &&
      canAssignSidebarProjectCategoryParent({
        categories: orderedCategories,
        categoryId: category.id,
        parentId: category.parentId,
      })
        ? category.parentId
        : null;

    if (!validParentId) {
      rootCategories.push(node);
      continue;
    }

    const parentNode = nodeById.get(validParentId);
    if (!parentNode) {
      rootCategories.push(node);
      continue;
    }

    parentNode.children.push(node);
  }

  return {
    rootCategories: rootCategories.map(finalizeSidebarProjectCategoryNode),
    uncategorizedProjects,
    projectCategoryByProjectKey,
  };
}
