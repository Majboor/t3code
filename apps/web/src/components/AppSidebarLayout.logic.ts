import * as Schema from "effect/Schema";
import { useCallback } from "react";
import type { DesktopLayoutMode } from "@t3tools/contracts/settings";
import { setLocalStorageItem, useLocalStorage } from "~/hooks/useLocalStorage";

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
}): { canOpen: boolean; nextWorkspaceWidth: number | null } {
  const mainContentWidth = input.layoutWidth - input.projectSidebarWidth;
  if (mainContentWidth < PROJECT_SIDEBAR_MAIN_CONTENT_MIN_WIDTH_PX) {
    return { canOpen: false, nextWorkspaceWidth: null };
  }

  const maximumWorkspaceWidth = mainContentWidth - getMinimumDevChatWidthPx(input.terminalOpen);
  if (maximumWorkspaceWidth < DEV_WORKSPACE_MIN_WIDTH_PX) {
    return { canOpen: false, nextWorkspaceWidth: null };
  }

  const workspaceSidebarWrapper = input.root.querySelector<HTMLElement>(
    "[data-layout-column='workspace'][data-slot='sidebar-wrapper']",
  );
  if (!workspaceSidebarWrapper) {
    return { canOpen: true, nextWorkspaceWidth: null };
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
    return { canOpen: true, nextWorkspaceWidth: null };
  }

  const nextWorkspaceWidth = Math.max(
    DEV_WORKSPACE_MIN_WIDTH_PX,
    Math.min(currentWorkspaceWidth, maximumWorkspaceWidth),
  );
  if (nextWorkspaceWidth < currentWorkspaceWidth - 0.5) {
    workspaceSidebarWrapper.style.setProperty("--sidebar-width", `${nextWorkspaceWidth}px`);
    setLocalStorageItem(
      WORKSPACE_INLINE_SIDEBAR_WIDTH_STORAGE_KEY,
      nextWorkspaceWidth,
      Schema.Finite,
    );
  }

  return { canOpen: true, nextWorkspaceWidth };
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
