import * as Schema from "effect/Schema";
import { useCallback } from "react";
import type { DesktopLayoutMode } from "@t3tools/contracts/settings";
import { setLocalStorageItem, useLocalStorage } from "~/hooks/useLocalStorage";
import { findLargestAcceptedInlineWorkspaceWidth } from "~/lib/inlineWorkspaceSidebarLayout";

export const PROJECT_SIDEBAR_MIN_WIDTH_PX = 13 * 16;
export const PROJECT_SIDEBAR_DEFAULT_WIDTH_PX = 16 * 16;
export const PROJECT_SIDEBAR_MAIN_CONTENT_MIN_WIDTH_PX = 40 * 16;
export const PROJECT_SIDEBAR_WIDTH_STORAGE_KEY = "chat_thread_sidebar_width";
export const WORKSPACE_INLINE_SIDEBAR_WIDTH_STORAGE_KEY = "chat_right_panel_sidebar_width";
export const DEV_WORKSPACE_MIN_WIDTH_PX = 28 * 16;
export const DEV_CHAT_MIN_WIDTH_WITH_PROJECTS_PX = 18 * 16;
export const DEV_CHAT_MIN_WIDTH_WITH_PROJECTS_AND_TERMINAL_PX = 22 * 16;

const PROJECT_SIDEBAR_OPEN_STATE_STORAGE_KEY = "t3code:project-sidebar-open:v1";
const DESKTOP_LAYOUT_PANEL_PREFERENCE_STORAGE_KEY = "t3code:desktop-layout-panels:v1";

const ProjectSidebarOpenStateSchema = Schema.Struct({
  vibe: Schema.Boolean,
  dev: Schema.Boolean,
});
type ProjectSidebarOpenState = typeof ProjectSidebarOpenStateSchema.Type;

const DesktopLayoutPanelPreferenceSchema = Schema.Literals(["none", "workspace", "diff"]);
export type DesktopLayoutPanelPreference = typeof DesktopLayoutPanelPreferenceSchema.Type;

const DesktopLayoutPanelPreferencesSchema = Schema.Struct({
  vibe: DesktopLayoutPanelPreferenceSchema,
  dev: DesktopLayoutPanelPreferenceSchema,
});
type DesktopLayoutPanelPreferences = typeof DesktopLayoutPanelPreferencesSchema.Type;

const DEFAULT_OPEN_STATE: ProjectSidebarOpenState = {
  vibe: true,
  dev: false,
};

const DEFAULT_PANEL_PREFERENCES: DesktopLayoutPanelPreferences = {
  vibe: "none",
  dev: "workspace",
};

export function getMinimumDevChatWidthPx(terminalOpen: boolean): number {
  return terminalOpen
    ? DEV_CHAT_MIN_WIDTH_WITH_PROJECTS_AND_TERMINAL_PX
    : DEV_CHAT_MIN_WIDTH_WITH_PROJECTS_PX;
}

export function getMinimumDevMainContentWidthPx(terminalOpen: boolean): number {
  return DEV_WORKSPACE_MIN_WIDTH_PX + getMinimumDevChatWidthPx(terminalOpen);
}

export function rebalanceDevWorkspaceWidthBeforeProjectsOpen(input: {
  layoutWidth: number;
  projectSidebarWidth: number;
  root: ParentNode;
  terminalOpen: boolean;
}): {
  canOpen: boolean;
  nextProjectSidebarWidth: number | null;
  nextWorkspaceWidth: number | null;
} {
  const maximumProjectSidebarWidth =
    input.layoutWidth - getMinimumDevMainContentWidthPx(input.terminalOpen);
  if (maximumProjectSidebarWidth < PROJECT_SIDEBAR_MIN_WIDTH_PX) {
    return { canOpen: false, nextProjectSidebarWidth: null, nextWorkspaceWidth: null };
  }

  const workspaceSidebarWrapper = input.root.querySelector<HTMLElement>(
    "[data-layout-column='workspace'][data-slot='sidebar-wrapper']",
  );
  if (!workspaceSidebarWrapper) {
    return {
      canOpen: true,
      nextProjectSidebarWidth: Math.min(input.projectSidebarWidth, maximumProjectSidebarWidth),
      nextWorkspaceWidth: null,
    };
  }

  const currentWorkspaceWidth =
    Number.parseFloat(
      getComputedStyle(workspaceSidebarWrapper).getPropertyValue("--sidebar-width"),
    ) ||
    workspaceSidebarWrapper
      .querySelector<HTMLElement>("[data-slot='sidebar-container']")
      ?.getBoundingClientRect().width ||
    null;
  if (currentWorkspaceWidth === null) {
    return {
      canOpen: true,
      nextProjectSidebarWidth: Math.min(input.projectSidebarWidth, maximumProjectSidebarWidth),
      nextWorkspaceWidth: null,
    };
  }

  const tryLayout = (projectSidebarWidth: number) => {
    const mainContentWidth = input.layoutWidth - projectSidebarWidth;
    if (mainContentWidth < PROJECT_SIDEBAR_MAIN_CONTENT_MIN_WIDTH_PX) {
      return null;
    }

    const maximumWorkspaceWidth = mainContentWidth - getMinimumDevChatWidthPx(input.terminalOpen);
    if (maximumWorkspaceWidth < DEV_WORKSPACE_MIN_WIDTH_PX) {
      return null;
    }

    const requestedWorkspaceWidth = Math.max(
      DEV_WORKSPACE_MIN_WIDTH_PX,
      Math.min(currentWorkspaceWidth, maximumWorkspaceWidth),
    );
    const nextWorkspaceWidth = findLargestAcceptedInlineWorkspaceWidth({
      currentWidth: currentWorkspaceWidth,
      minWidth: DEV_WORKSPACE_MIN_WIDTH_PX,
      projectsSidebarOpen: true,
      requestedWidth: requestedWorkspaceWidth,
      terminalOpen: input.terminalOpen,
      wrapper: workspaceSidebarWrapper,
    });
    if (nextWorkspaceWidth === null) {
      return null;
    }
    return { projectSidebarWidth, workspaceWidth: nextWorkspaceWidth };
  };

  const preferredProjectSidebarWidth = Math.max(
    PROJECT_SIDEBAR_MIN_WIDTH_PX,
    Math.min(input.projectSidebarWidth, maximumProjectSidebarWidth),
  );

  const preferredLayout = tryLayout(preferredProjectSidebarWidth);
  const fallbackLayout =
    preferredLayout ??
    (preferredProjectSidebarWidth === PROJECT_SIDEBAR_MIN_WIDTH_PX
      ? null
      : tryLayout(PROJECT_SIDEBAR_MIN_WIDTH_PX));

  if (fallbackLayout === null) {
    return { canOpen: false, nextProjectSidebarWidth: null, nextWorkspaceWidth: null };
  }

  if (fallbackLayout.workspaceWidth < currentWorkspaceWidth - 0.5) {
    workspaceSidebarWrapper.style.setProperty(
      "--sidebar-width",
      `${fallbackLayout.workspaceWidth}px`,
    );
    setLocalStorageItem(
      WORKSPACE_INLINE_SIDEBAR_WIDTH_STORAGE_KEY,
      fallbackLayout.workspaceWidth,
      Schema.Finite,
    );
  }

  return {
    canOpen: true,
    nextProjectSidebarWidth: fallbackLayout.projectSidebarWidth,
    nextWorkspaceWidth: fallbackLayout.workspaceWidth,
  };
}

export function useProjectSidebarOpen(
  mode: DesktopLayoutMode,
): [boolean, (value: boolean | ((prev: boolean) => boolean)) => void] {
  const [state, setState] = useLocalStorage(
    PROJECT_SIDEBAR_OPEN_STATE_STORAGE_KEY,
    DEFAULT_OPEN_STATE,
    ProjectSidebarOpenStateSchema,
  );

  const open = state[mode];
  const setOpen = useCallback(
    (value: boolean | ((prev: boolean) => boolean)) => {
      setState((previous) => {
        const previousOpen = previous[mode];
        const nextOpen =
          typeof value === "function" ? (value as (prev: boolean) => boolean)(previousOpen) : value;
        if (nextOpen === previousOpen) {
          return previous;
        }
        return { ...previous, [mode]: nextOpen };
      });
    },
    [mode, setState],
  );

  return [open, setOpen];
}

export function useDesktopLayoutPanelPreferences(): {
  panelPreferenceByMode: DesktopLayoutPanelPreferences;
  setPanelPreferenceForMode: (
    mode: DesktopLayoutMode,
    value:
      | DesktopLayoutPanelPreference
      | ((prev: DesktopLayoutPanelPreference) => DesktopLayoutPanelPreference),
  ) => void;
} {
  const [panelPreferenceByMode, setPanelPreferenceByMode] = useLocalStorage(
    DESKTOP_LAYOUT_PANEL_PREFERENCE_STORAGE_KEY,
    DEFAULT_PANEL_PREFERENCES,
    DesktopLayoutPanelPreferencesSchema,
  );

  const setPanelPreferenceForMode = useCallback(
    (
      mode: DesktopLayoutMode,
      value:
        | DesktopLayoutPanelPreference
        | ((prev: DesktopLayoutPanelPreference) => DesktopLayoutPanelPreference),
    ) => {
      setPanelPreferenceByMode((previous) => {
        const previousPreference = previous[mode];
        const nextPreference =
          typeof value === "function"
            ? (value as (prev: DesktopLayoutPanelPreference) => DesktopLayoutPanelPreference)(
                previousPreference,
              )
            : value;
        if (nextPreference === previousPreference) {
          return previous;
        }
        return {
          ...previous,
          [mode]: nextPreference,
        };
      });
    },
    [setPanelPreferenceByMode],
  );

  return {
    panelPreferenceByMode,
    setPanelPreferenceForMode,
  };
}

export function panelPreferenceFromRouteSearch(input: {
  diffOpen: boolean;
  workspaceOpen: boolean;
}): DesktopLayoutPanelPreference {
  if (input.workspaceOpen) {
    return "workspace";
  }
  if (input.diffOpen) {
    return "diff";
  }
  return "none";
}

export function normalizeDesktopLayoutPanelPreference(
  preference: DesktopLayoutPanelPreference,
  input: {
    diffAvailable: boolean;
    workspaceAvailable: boolean;
  },
): DesktopLayoutPanelPreference {
  switch (preference) {
    case "workspace":
      return input.workspaceAvailable ? "workspace" : "none";
    case "diff":
      return input.diffAvailable ? "diff" : "none";
    default:
      return "none";
  }
}
