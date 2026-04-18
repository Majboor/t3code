import { Debouncer } from "@tanstack/react-pacer";
import { create } from "zustand";
import {
  canAssignSidebarProjectCategoryParent,
  type SidebarProjectCategory,
} from "./sidebarProjectCategories";

const PERSISTED_STATE_KEY = "t3code:ui-state:v1";
const LEGACY_PERSISTED_STATE_KEYS = [
  "t3code:renderer-state:v8",
  "t3code:renderer-state:v7",
  "t3code:renderer-state:v6",
  "t3code:renderer-state:v5",
  "t3code:renderer-state:v4",
  "t3code:renderer-state:v3",
  "codething:renderer-state:v4",
  "codething:renderer-state:v3",
  "codething:renderer-state:v2",
  "codething:renderer-state:v1",
] as const;

interface PersistedUiState {
  expandedProjectCwds?: string[];
  projectOrderCwds?: string[];
  projectCategories?: SidebarProjectCategory[];
  projectCategoryAssignmentsByPhysicalKey?: Record<string, string>;
  projectCategoryExpandedById?: Record<string, boolean>;
  projectCategoryOrder?: string[];
  threadChangedFilesExpandedById?: Record<string, Record<string, boolean>>;
}

export interface UiProjectState {
  projectExpandedById: Record<string, boolean>;
  projectOrder: string[];
  projectCategories: SidebarProjectCategory[];
  projectCategoryAssignmentsByPhysicalKey: Record<string, string>;
  projectCategoryExpandedById: Record<string, boolean>;
  projectCategoryOrder: string[];
}

export interface UiThreadState {
  threadLastVisitedAtById: Record<string, string>;
  threadChangedFilesExpandedById: Record<string, Record<string, boolean>>;
}

export interface UiState extends UiProjectState, UiThreadState {}

export interface SyncProjectInput {
  key: string;
  cwd: string;
}

export interface SyncThreadInput {
  key: string;
  seedVisitedAt?: string | undefined;
}

const initialState: UiState = {
  projectExpandedById: {},
  projectOrder: [],
  projectCategories: [],
  projectCategoryAssignmentsByPhysicalKey: {},
  projectCategoryExpandedById: {},
  projectCategoryOrder: [],
  threadLastVisitedAtById: {},
  threadChangedFilesExpandedById: {},
};

const persistedExpandedProjectCwds = new Set<string>();
const persistedProjectOrderCwds: string[] = [];
const currentProjectCwdById = new Map<string, string>();
let legacyKeysCleanedUp = false;

function readPersistedState(): UiState {
  if (typeof window === "undefined") {
    return initialState;
  }
  try {
    const raw = window.localStorage.getItem(PERSISTED_STATE_KEY);
    if (!raw) {
      for (const legacyKey of LEGACY_PERSISTED_STATE_KEYS) {
        const legacyRaw = window.localStorage.getItem(legacyKey);
        if (!legacyRaw) {
          continue;
        }
        hydratePersistedProjectState(JSON.parse(legacyRaw) as PersistedUiState);
        return initialState;
      }
      return initialState;
    }
    const parsed = JSON.parse(raw) as PersistedUiState;
    hydratePersistedProjectState(parsed);
    const projectCategories = sanitizePersistedProjectCategories(parsed.projectCategories);
    return {
      ...initialState,
      projectCategories,
      projectCategoryAssignmentsByPhysicalKey: normalizeProjectCategoryAssignments(
        projectCategories,
        sanitizePersistedProjectCategoryAssignments(parsed.projectCategoryAssignmentsByPhysicalKey),
      ),
      projectCategoryExpandedById: normalizeProjectCategoryExpanded(
        projectCategories,
        sanitizePersistedProjectCategoryExpanded(parsed.projectCategoryExpandedById),
      ),
      projectCategoryOrder: normalizeProjectCategoryOrder(
        projectCategories,
        sanitizePersistedProjectCategoryOrder(parsed.projectCategoryOrder),
      ),
      threadChangedFilesExpandedById: sanitizePersistedThreadChangedFilesExpanded(
        parsed.threadChangedFilesExpandedById,
      ),
    };
  } catch {
    return initialState;
  }
}

function sanitizePersistedThreadChangedFilesExpanded(
  value: PersistedUiState["threadChangedFilesExpandedById"],
): Record<string, Record<string, boolean>> {
  if (!value || typeof value !== "object") {
    return {};
  }

  const nextState: Record<string, Record<string, boolean>> = {};
  for (const [threadId, turns] of Object.entries(value)) {
    if (!threadId || !turns || typeof turns !== "object") {
      continue;
    }

    const nextTurns: Record<string, boolean> = {};
    for (const [turnId, expanded] of Object.entries(turns)) {
      if (turnId && typeof expanded === "boolean" && expanded === false) {
        nextTurns[turnId] = false;
      }
    }

    if (Object.keys(nextTurns).length > 0) {
      nextState[threadId] = nextTurns;
    }
  }

  return nextState;
}

function sanitizePersistedProjectCategories(
  value: PersistedUiState["projectCategories"],
): SidebarProjectCategory[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const categories: SidebarProjectCategory[] = [];
  const seenIds = new Set<string>();

  for (const entry of value) {
    if (!entry || typeof entry !== "object") {
      continue;
    }

    const id = typeof entry.id === "string" ? entry.id.trim() : "";
    const name = typeof entry.name === "string" ? entry.name.trim() : "";
    const parentId =
      typeof entry.parentId === "string" && entry.parentId.trim().length > 0
        ? entry.parentId.trim()
        : null;

    if (!id || !name || seenIds.has(id)) {
      continue;
    }

    seenIds.add(id);
    categories.push({
      id,
      name,
      parentId: parentId === id ? null : parentId,
    });
  }

  return categories;
}

function sanitizePersistedProjectCategoryAssignments(
  value: PersistedUiState["projectCategoryAssignmentsByPhysicalKey"],
): Record<string, string> {
  if (!value || typeof value !== "object") {
    return {};
  }

  const assignments: Record<string, string> = {};
  for (const [physicalProjectKey, categoryId] of Object.entries(value)) {
    const nextPhysicalProjectKey = physicalProjectKey.trim();
    const nextCategoryId = typeof categoryId === "string" ? categoryId.trim() : "";
    if (!nextPhysicalProjectKey || !nextCategoryId) {
      continue;
    }
    assignments[nextPhysicalProjectKey] = nextCategoryId;
  }

  return assignments;
}

function sanitizePersistedProjectCategoryExpanded(
  value: PersistedUiState["projectCategoryExpandedById"],
): Record<string, boolean> {
  if (!value || typeof value !== "object") {
    return {};
  }

  const expandedById: Record<string, boolean> = {};
  for (const [categoryId, expanded] of Object.entries(value)) {
    if (categoryId && expanded === false) {
      expandedById[categoryId] = false;
    }
  }

  return expandedById;
}

function sanitizePersistedProjectCategoryOrder(
  value: PersistedUiState["projectCategoryOrder"],
): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const categoryOrder: string[] = [];
  for (const entry of value) {
    const categoryId = typeof entry === "string" ? entry.trim() : "";
    if (!categoryId || categoryOrder.includes(categoryId)) {
      continue;
    }
    categoryOrder.push(categoryId);
  }

  return categoryOrder;
}

function hydratePersistedProjectState(parsed: PersistedUiState): void {
  persistedExpandedProjectCwds.clear();
  persistedProjectOrderCwds.length = 0;
  for (const cwd of parsed.expandedProjectCwds ?? []) {
    if (typeof cwd === "string" && cwd.length > 0) {
      persistedExpandedProjectCwds.add(cwd);
    }
  }
  for (const cwd of parsed.projectOrderCwds ?? []) {
    if (typeof cwd === "string" && cwd.length > 0 && !persistedProjectOrderCwds.includes(cwd)) {
      persistedProjectOrderCwds.push(cwd);
    }
  }
}

function persistState(state: UiState): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    const expandedProjectCwds = Object.entries(state.projectExpandedById)
      .filter(([, expanded]) => expanded)
      .flatMap(([projectId]) => {
        const cwd = currentProjectCwdById.get(projectId);
        return cwd ? [cwd] : [];
      });
    const projectOrderCwds = state.projectOrder.flatMap((projectId) => {
      const cwd = currentProjectCwdById.get(projectId);
      return cwd ? [cwd] : [];
    });
    const threadChangedFilesExpandedById = Object.fromEntries(
      Object.entries(state.threadChangedFilesExpandedById).flatMap(([threadId, turns]) => {
        const nextTurns = Object.fromEntries(
          Object.entries(turns).filter(([, expanded]) => expanded === false),
        );
        return Object.keys(nextTurns).length > 0 ? [[threadId, nextTurns]] : [];
      }),
    );
    window.localStorage.setItem(
      PERSISTED_STATE_KEY,
      JSON.stringify({
        expandedProjectCwds,
        projectOrderCwds,
        projectCategories: state.projectCategories,
        projectCategoryAssignmentsByPhysicalKey: state.projectCategoryAssignmentsByPhysicalKey,
        projectCategoryExpandedById: Object.fromEntries(
          Object.entries(state.projectCategoryExpandedById).filter(
            ([, expanded]) => expanded === false,
          ),
        ),
        projectCategoryOrder: state.projectCategoryOrder,
        threadChangedFilesExpandedById,
      } satisfies PersistedUiState),
    );
    if (!legacyKeysCleanedUp) {
      legacyKeysCleanedUp = true;
      for (const legacyKey of LEGACY_PERSISTED_STATE_KEYS) {
        window.localStorage.removeItem(legacyKey);
      }
    }
  } catch {
    // Ignore quota/storage errors to avoid breaking chat UX.
  }
}

const debouncedPersistState = new Debouncer(persistState, { wait: 500 });

function recordsEqual<T>(left: Record<string, T>, right: Record<string, T>): boolean {
  const leftEntries = Object.entries(left);
  const rightEntries = Object.entries(right);
  if (leftEntries.length !== rightEntries.length) {
    return false;
  }
  for (const [key, value] of leftEntries) {
    if (right[key] !== value) {
      return false;
    }
  }
  return true;
}

function projectOrdersEqual(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length && left.every((projectId, index) => projectId === right[index])
  );
}

function nestedBooleanRecordsEqual(
  left: Record<string, Record<string, boolean>>,
  right: Record<string, Record<string, boolean>>,
): boolean {
  const leftEntries = Object.entries(left);
  const rightEntries = Object.entries(right);
  if (leftEntries.length !== rightEntries.length) {
    return false;
  }
  for (const [key, value] of leftEntries) {
    if (!(key in right) || !recordsEqual(value, right[key]!)) {
      return false;
    }
  }
  return true;
}

function normalizeProjectCategoryOrder(
  categories: ReadonlyArray<SidebarProjectCategory>,
  categoryOrder: ReadonlyArray<string>,
): string[] {
  const categoryIds = new Set(categories.map((category) => category.id));
  const nextOrder = categoryOrder.filter((categoryId) => categoryIds.has(categoryId));

  for (const category of categories) {
    if (!nextOrder.includes(category.id)) {
      nextOrder.push(category.id);
    }
  }

  return nextOrder;
}

function normalizeProjectCategoryAssignments(
  categories: ReadonlyArray<SidebarProjectCategory>,
  assignments: Readonly<Record<string, string>>,
): Record<string, string> {
  const categoryIds = new Set(categories.map((category) => category.id));
  return Object.fromEntries(
    Object.entries(assignments).filter(([, categoryId]) => categoryIds.has(categoryId)),
  );
}

function normalizeProjectCategoryExpanded(
  categories: ReadonlyArray<SidebarProjectCategory>,
  expandedById: Readonly<Record<string, boolean>>,
): Record<string, boolean> {
  const categoryIds = new Set(categories.map((category) => category.id));
  return Object.fromEntries(
    Object.entries(expandedById).filter(
      ([categoryId, expanded]) => categoryIds.has(categoryId) && expanded === false,
    ),
  );
}

export function syncProjects(state: UiState, projects: readonly SyncProjectInput[]): UiState {
  const previousProjectCwdById = new Map(currentProjectCwdById);
  const previousProjectIdByCwd = new Map(
    [...previousProjectCwdById.entries()].map(([projectId, cwd]) => [cwd, projectId] as const),
  );
  currentProjectCwdById.clear();
  for (const project of projects) {
    currentProjectCwdById.set(project.key, project.cwd);
  }
  const cwdMappingChanged =
    previousProjectCwdById.size !== currentProjectCwdById.size ||
    projects.some((project) => previousProjectCwdById.get(project.key) !== project.cwd);

  const nextExpandedById: Record<string, boolean> = {};
  const previousExpandedById = state.projectExpandedById;
  const persistedOrderByCwd = new Map(
    persistedProjectOrderCwds.map((cwd, index) => [cwd, index] as const),
  );
  const mappedProjects = projects.map((project, index) => {
    const previousProjectIdForCwd = previousProjectIdByCwd.get(project.cwd);
    const expanded =
      previousExpandedById[project.key] ??
      (previousProjectIdForCwd ? previousExpandedById[previousProjectIdForCwd] : undefined) ??
      (persistedExpandedProjectCwds.size > 0
        ? persistedExpandedProjectCwds.has(project.cwd)
        : true);
    nextExpandedById[project.key] = expanded;
    return {
      id: project.key,
      cwd: project.cwd,
      incomingIndex: index,
    };
  });

  const nextProjectOrder =
    state.projectOrder.length > 0
      ? (() => {
          const nextProjectIdByCwd = new Map(
            mappedProjects.map((project) => [project.cwd, project.id] as const),
          );
          const usedProjectIds = new Set<string>();
          const orderedProjectIds: string[] = [];

          for (const projectId of state.projectOrder) {
            const matchedProjectId =
              (projectId in nextExpandedById ? projectId : undefined) ??
              (() => {
                const previousCwd = previousProjectCwdById.get(projectId);
                return previousCwd ? nextProjectIdByCwd.get(previousCwd) : undefined;
              })();
            if (!matchedProjectId || usedProjectIds.has(matchedProjectId)) {
              continue;
            }
            usedProjectIds.add(matchedProjectId);
            orderedProjectIds.push(matchedProjectId);
          }

          for (const project of mappedProjects) {
            if (usedProjectIds.has(project.id)) {
              continue;
            }
            orderedProjectIds.push(project.id);
          }

          return orderedProjectIds;
        })()
      : mappedProjects
          .map((project) => ({
            id: project.id,
            incomingIndex: project.incomingIndex,
            orderIndex:
              persistedOrderByCwd.get(project.cwd) ??
              persistedProjectOrderCwds.length + project.incomingIndex,
          }))
          .toSorted((left, right) => {
            const byOrder = left.orderIndex - right.orderIndex;
            if (byOrder !== 0) {
              return byOrder;
            }
            return left.incomingIndex - right.incomingIndex;
          })
          .map((project) => project.id);

  if (
    recordsEqual(state.projectExpandedById, nextExpandedById) &&
    projectOrdersEqual(state.projectOrder, nextProjectOrder) &&
    !cwdMappingChanged
  ) {
    return state;
  }

  return {
    ...state,
    projectExpandedById: nextExpandedById,
    projectOrder: nextProjectOrder,
  };
}

export function syncThreads(state: UiState, threads: readonly SyncThreadInput[]): UiState {
  const retainedThreadIds = new Set(threads.map((thread) => thread.key));
  const nextThreadLastVisitedAtById = Object.fromEntries(
    Object.entries(state.threadLastVisitedAtById).filter(([threadId]) =>
      retainedThreadIds.has(threadId),
    ),
  );
  for (const thread of threads) {
    if (
      nextThreadLastVisitedAtById[thread.key] === undefined &&
      thread.seedVisitedAt !== undefined &&
      thread.seedVisitedAt.length > 0
    ) {
      nextThreadLastVisitedAtById[thread.key] = thread.seedVisitedAt;
    }
  }
  const nextThreadChangedFilesExpandedById = Object.fromEntries(
    Object.entries(state.threadChangedFilesExpandedById).filter(([threadId]) =>
      retainedThreadIds.has(threadId),
    ),
  );
  if (
    recordsEqual(state.threadLastVisitedAtById, nextThreadLastVisitedAtById) &&
    nestedBooleanRecordsEqual(
      state.threadChangedFilesExpandedById,
      nextThreadChangedFilesExpandedById,
    )
  ) {
    return state;
  }
  return {
    ...state,
    threadLastVisitedAtById: nextThreadLastVisitedAtById,
    threadChangedFilesExpandedById: nextThreadChangedFilesExpandedById,
  };
}

export function markThreadVisited(state: UiState, threadId: string, visitedAt?: string): UiState {
  const at = visitedAt ?? new Date().toISOString();
  const visitedAtMs = Date.parse(at);
  const previousVisitedAt = state.threadLastVisitedAtById[threadId];
  const previousVisitedAtMs = previousVisitedAt ? Date.parse(previousVisitedAt) : NaN;
  if (
    Number.isFinite(previousVisitedAtMs) &&
    Number.isFinite(visitedAtMs) &&
    previousVisitedAtMs >= visitedAtMs
  ) {
    return state;
  }
  return {
    ...state,
    threadLastVisitedAtById: {
      ...state.threadLastVisitedAtById,
      [threadId]: at,
    },
  };
}

export function markThreadUnread(
  state: UiState,
  threadId: string,
  latestTurnCompletedAt: string | null | undefined,
): UiState {
  if (!latestTurnCompletedAt) {
    return state;
  }
  const latestTurnCompletedAtMs = Date.parse(latestTurnCompletedAt);
  if (Number.isNaN(latestTurnCompletedAtMs)) {
    return state;
  }
  const unreadVisitedAt = new Date(latestTurnCompletedAtMs - 1).toISOString();
  if (state.threadLastVisitedAtById[threadId] === unreadVisitedAt) {
    return state;
  }
  return {
    ...state,
    threadLastVisitedAtById: {
      ...state.threadLastVisitedAtById,
      [threadId]: unreadVisitedAt,
    },
  };
}

export function clearThreadUi(state: UiState, threadId: string): UiState {
  const hasVisitedState = threadId in state.threadLastVisitedAtById;
  const hasChangedFilesState = threadId in state.threadChangedFilesExpandedById;
  if (!hasVisitedState && !hasChangedFilesState) {
    return state;
  }
  const nextThreadLastVisitedAtById = { ...state.threadLastVisitedAtById };
  const nextThreadChangedFilesExpandedById = { ...state.threadChangedFilesExpandedById };
  delete nextThreadLastVisitedAtById[threadId];
  delete nextThreadChangedFilesExpandedById[threadId];
  return {
    ...state,
    threadLastVisitedAtById: nextThreadLastVisitedAtById,
    threadChangedFilesExpandedById: nextThreadChangedFilesExpandedById,
  };
}

export function setThreadChangedFilesExpanded(
  state: UiState,
  threadId: string,
  turnId: string,
  expanded: boolean,
): UiState {
  const currentThreadState = state.threadChangedFilesExpandedById[threadId] ?? {};
  const currentExpanded = currentThreadState[turnId] ?? true;
  if (currentExpanded === expanded) {
    return state;
  }

  if (expanded) {
    if (!(turnId in currentThreadState)) {
      return state;
    }

    const nextThreadState = { ...currentThreadState };
    delete nextThreadState[turnId];
    if (Object.keys(nextThreadState).length === 0) {
      const nextState = { ...state.threadChangedFilesExpandedById };
      delete nextState[threadId];
      return {
        ...state,
        threadChangedFilesExpandedById: nextState,
      };
    }

    return {
      ...state,
      threadChangedFilesExpandedById: {
        ...state.threadChangedFilesExpandedById,
        [threadId]: nextThreadState,
      },
    };
  }

  return {
    ...state,
    threadChangedFilesExpandedById: {
      ...state.threadChangedFilesExpandedById,
      [threadId]: {
        ...currentThreadState,
        [turnId]: false,
      },
    },
  };
}

export function toggleProject(state: UiState, projectId: string): UiState {
  const expanded = state.projectExpandedById[projectId] ?? true;
  return {
    ...state,
    projectExpandedById: {
      ...state.projectExpandedById,
      [projectId]: !expanded,
    },
  };
}

export function setProjectExpanded(state: UiState, projectId: string, expanded: boolean): UiState {
  if ((state.projectExpandedById[projectId] ?? true) === expanded) {
    return state;
  }
  return {
    ...state,
    projectExpandedById: {
      ...state.projectExpandedById,
      [projectId]: expanded,
    },
  };
}

export function reorderProjects(
  state: UiState,
  draggedProjectIds: readonly string[],
  targetProjectIds: readonly string[],
): UiState {
  if (draggedProjectIds.length === 0) {
    return state;
  }
  const draggedSet = new Set(draggedProjectIds);
  const targetSet = new Set(targetProjectIds);
  if (draggedProjectIds.every((id) => targetSet.has(id))) {
    return state;
  }

  const originalTargetIndex = state.projectOrder.findIndex((id) => targetSet.has(id));
  if (originalTargetIndex < 0) {
    return state;
  }

  const projectOrder = [...state.projectOrder];

  const removed: string[] = [];
  let draggedBeforeTarget = 0;
  for (let i = projectOrder.length - 1; i >= 0; i--) {
    if (draggedSet.has(projectOrder[i]!)) {
      removed.unshift(projectOrder.splice(i, 1)[0]!);
      if (i < originalTargetIndex) {
        draggedBeforeTarget++;
      }
    }
  }
  if (removed.length === 0) {
    return state;
  }

  const insertIndex = originalTargetIndex - Math.max(0, draggedBeforeTarget - 1);
  projectOrder.splice(insertIndex, 0, ...removed);
  return {
    ...state,
    projectOrder,
  };
}

export function addProjectCategory(
  state: UiState,
  input: { id: string; name: string; parentId: string | null },
): UiState {
  const id = input.id.trim();
  const name = input.name.trim();
  if (!id || !name || state.projectCategories.some((category) => category.id === id)) {
    return state;
  }

  const projectCategories = [
    ...state.projectCategories,
    {
      id,
      name,
      parentId:
        input.parentId &&
        canAssignSidebarProjectCategoryParent({
          categories: state.projectCategories,
          categoryId: id,
          parentId: input.parentId,
        })
          ? input.parentId
          : null,
    },
  ];

  return {
    ...state,
    projectCategories,
    projectCategoryOrder: normalizeProjectCategoryOrder(projectCategories, [
      ...state.projectCategoryOrder,
      id,
    ]),
  };
}

export function updateProjectCategory(
  state: UiState,
  input: { id: string; name: string; parentId: string | null },
): UiState {
  const existingCategory = state.projectCategories.find((category) => category.id === input.id);
  const name = input.name.trim();
  if (!existingCategory || !name) {
    return state;
  }

  const parentId =
    input.parentId &&
    canAssignSidebarProjectCategoryParent({
      categories: state.projectCategories,
      categoryId: input.id,
      parentId: input.parentId,
    })
      ? input.parentId
      : null;

  if (existingCategory.name === name && existingCategory.parentId === parentId) {
    return state;
  }

  const projectCategories = state.projectCategories.map((category) =>
    category.id === input.id
      ? {
          ...category,
          name,
          parentId,
        }
      : category,
  );

  return {
    ...state,
    projectCategories,
    projectCategoryOrder: normalizeProjectCategoryOrder(
      projectCategories,
      state.projectCategoryOrder,
    ),
    projectCategoryAssignmentsByPhysicalKey: normalizeProjectCategoryAssignments(
      projectCategories,
      state.projectCategoryAssignmentsByPhysicalKey,
    ),
    projectCategoryExpandedById: normalizeProjectCategoryExpanded(
      projectCategories,
      state.projectCategoryExpandedById,
    ),
  };
}

export function deleteProjectCategory(state: UiState, categoryId: string): UiState {
  const deletedCategory = state.projectCategories.find((category) => category.id === categoryId);
  if (!deletedCategory) {
    return state;
  }

  const projectCategories: SidebarProjectCategory[] = [];
  for (const category of state.projectCategories) {
    if (category.id === categoryId) {
      continue;
    }

    if (category.parentId === categoryId) {
      projectCategories.push({
        id: category.id,
        name: category.name,
        parentId: deletedCategory.parentId,
      });
      continue;
    }

    projectCategories.push(category);
  }
  const projectCategoryAssignmentsByPhysicalKey = Object.fromEntries(
    Object.entries(state.projectCategoryAssignmentsByPhysicalKey).flatMap(
      ([physicalProjectKey, assignedCategoryId]) => {
        if (assignedCategoryId !== categoryId) {
          return [[physicalProjectKey, assignedCategoryId] as const];
        }
        return deletedCategory.parentId
          ? [[physicalProjectKey, deletedCategory.parentId] as const]
          : [];
      },
    ),
  );
  const { [categoryId]: _removedCategoryExpanded, ...projectCategoryExpandedById } =
    state.projectCategoryExpandedById;

  return {
    ...state,
    projectCategories,
    projectCategoryOrder: normalizeProjectCategoryOrder(
      projectCategories,
      state.projectCategoryOrder,
    ),
    projectCategoryAssignmentsByPhysicalKey: normalizeProjectCategoryAssignments(
      projectCategories,
      projectCategoryAssignmentsByPhysicalKey,
    ),
    projectCategoryExpandedById: normalizeProjectCategoryExpanded(
      projectCategories,
      projectCategoryExpandedById,
    ),
  };
}

export function assignProjectsToCategory(
  state: UiState,
  physicalProjectKeys: readonly string[],
  categoryId: string | null,
): UiState {
  if (physicalProjectKeys.length === 0) {
    return state;
  }

  if (categoryId && !state.projectCategories.some((category) => category.id === categoryId)) {
    return state;
  }

  const projectCategoryAssignmentsByPhysicalKey = {
    ...state.projectCategoryAssignmentsByPhysicalKey,
  };
  let changed = false;

  for (const physicalProjectKey of physicalProjectKeys) {
    if (!physicalProjectKey) {
      continue;
    }

    if (!categoryId) {
      if (physicalProjectKey in projectCategoryAssignmentsByPhysicalKey) {
        delete projectCategoryAssignmentsByPhysicalKey[physicalProjectKey];
        changed = true;
      }
      continue;
    }

    if (projectCategoryAssignmentsByPhysicalKey[physicalProjectKey] === categoryId) {
      continue;
    }

    projectCategoryAssignmentsByPhysicalKey[physicalProjectKey] = categoryId;
    changed = true;
  }

  if (!changed) {
    return state;
  }

  return {
    ...state,
    projectCategoryAssignmentsByPhysicalKey,
  };
}

export function setProjectCategoryExpanded(
  state: UiState,
  categoryId: string,
  expanded: boolean,
): UiState {
  const currentExpanded = state.projectCategoryExpandedById[categoryId] ?? true;
  if (currentExpanded === expanded) {
    return state;
  }

  if (expanded) {
    if (!(categoryId in state.projectCategoryExpandedById)) {
      return state;
    }
    const nextExpandedById = { ...state.projectCategoryExpandedById };
    delete nextExpandedById[categoryId];
    return {
      ...state,
      projectCategoryExpandedById: nextExpandedById,
    };
  }

  return {
    ...state,
    projectCategoryExpandedById: {
      ...state.projectCategoryExpandedById,
      [categoryId]: false,
    },
  };
}

interface UiStateStore extends UiState {
  syncProjects: (projects: readonly SyncProjectInput[]) => void;
  syncThreads: (threads: readonly SyncThreadInput[]) => void;
  markThreadVisited: (threadId: string, visitedAt?: string) => void;
  markThreadUnread: (threadId: string, latestTurnCompletedAt: string | null | undefined) => void;
  clearThreadUi: (threadId: string) => void;
  setThreadChangedFilesExpanded: (threadId: string, turnId: string, expanded: boolean) => void;
  toggleProject: (projectId: string) => void;
  setProjectExpanded: (projectId: string, expanded: boolean) => void;
  addProjectCategory: (input: { name: string; parentId: string | null }) => string | null;
  updateProjectCategory: (input: { id: string; name: string; parentId: string | null }) => void;
  deleteProjectCategory: (categoryId: string) => void;
  assignProjectsToCategory: (
    physicalProjectKeys: readonly string[],
    categoryId: string | null,
  ) => void;
  setProjectCategoryExpanded: (categoryId: string, expanded: boolean) => void;
  reorderProjects: (
    draggedProjectIds: readonly string[],
    targetProjectIds: readonly string[],
  ) => void;
}

export const useUiStateStore = create<UiStateStore>((set) => ({
  ...readPersistedState(),
  syncProjects: (projects) => set((state) => syncProjects(state, projects)),
  syncThreads: (threads) => set((state) => syncThreads(state, threads)),
  markThreadVisited: (threadId, visitedAt) =>
    set((state) => markThreadVisited(state, threadId, visitedAt)),
  markThreadUnread: (threadId, latestTurnCompletedAt) =>
    set((state) => markThreadUnread(state, threadId, latestTurnCompletedAt)),
  clearThreadUi: (threadId) => set((state) => clearThreadUi(state, threadId)),
  setThreadChangedFilesExpanded: (threadId, turnId, expanded) =>
    set((state) => setThreadChangedFilesExpanded(state, threadId, turnId, expanded)),
  toggleProject: (projectId) => set((state) => toggleProject(state, projectId)),
  setProjectExpanded: (projectId, expanded) =>
    set((state) => setProjectExpanded(state, projectId, expanded)),
  addProjectCategory: ({ name, parentId }) => {
    const id =
      globalThis.crypto?.randomUUID?.() ??
      `category-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    let created = false;
    set((state) => {
      const nextState = addProjectCategory(state, { id, name, parentId });
      created = nextState !== state;
      return nextState;
    });
    return created ? id : null;
  },
  updateProjectCategory: (input) => set((state) => updateProjectCategory(state, input)),
  deleteProjectCategory: (categoryId) => set((state) => deleteProjectCategory(state, categoryId)),
  assignProjectsToCategory: (physicalProjectKeys, categoryId) =>
    set((state) => assignProjectsToCategory(state, physicalProjectKeys, categoryId)),
  setProjectCategoryExpanded: (categoryId, expanded) =>
    set((state) => setProjectCategoryExpanded(state, categoryId, expanded)),
  reorderProjects: (draggedProjectIds, targetProjectIds) =>
    set((state) => reorderProjects(state, draggedProjectIds, targetProjectIds)),
}));

useUiStateStore.subscribe((state) => debouncedPersistState.maybeExecute(state));

if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("beforeunload", () => {
    debouncedPersistState.flush();
  });
}
