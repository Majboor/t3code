import * as Schema from "effect/Schema";
import { useCallback } from "react";
import type { DesktopLayoutMode } from "@t3tools/contracts/settings";
import { useLocalStorage } from "~/hooks/useLocalStorage";

export const PROJECT_SIDEBAR_MIN_WIDTH_PX = 13 * 16;
export const PROJECT_SIDEBAR_MAIN_CONTENT_MIN_WIDTH_PX = 40 * 16;
export const PROJECT_SIDEBAR_WIDTH_STORAGE_KEY = "chat_thread_sidebar_width";

const PROJECT_SIDEBAR_OPEN_STATE_STORAGE_KEY = "t3code:project-sidebar-open:v1";

const ProjectSidebarOpenStateSchema = Schema.Struct({
  vibe: Schema.Boolean,
  dev: Schema.Boolean,
});
type ProjectSidebarOpenState = typeof ProjectSidebarOpenStateSchema.Type;

const DEFAULT_OPEN_STATE: ProjectSidebarOpenState = {
  vibe: true,
  dev: false,
};

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
