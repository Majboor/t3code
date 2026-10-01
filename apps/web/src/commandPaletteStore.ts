import { create } from "zustand";
import type { EnvironmentId, OrchestrationProjectOwnership } from "@t3tools/contracts";

import type { CreatableProjectKind } from "./components/projectKind.logic";

export interface AddProjectWorkspaceContext {
  readonly environmentId: EnvironmentId;
  readonly ownership: OrchestrationProjectOwnership;
}

interface CommandPaletteOpenIntent {
  kind: "add-project";
  requestId: number;
  workspace?: AddProjectWorkspaceContext;
  /**
   * A project kind the opener already asked for, so the palette opens with it
   * chosen instead of asking a second time.
   *
   * The dashboard's "Add project" is a menu of kinds and the palette is where
   * the project is actually made, so the answer has to travel the short distance
   * between them. It stays a *request*: the palette re-checks it against the
   * environment it ends up creating on (`resolveSelectedProjectKind`), because
   * the opener knew which workspace it meant but not which environment the
   * person would settle on.
   *
   * Named `projectKind` rather than `kind` because `kind` on this object already
   * means which intent this is.
   */
  projectKind?: CreatableProjectKind;
}

interface CommandPaletteStore {
  open: boolean;
  openIntent: CommandPaletteOpenIntent | null;
  setOpen: (open: boolean) => void;
  toggleOpen: () => void;
  openAddProject: (
    workspace?: AddProjectWorkspaceContext,
    projectKind?: CreatableProjectKind,
  ) => void;
  clearOpenIntent: () => void;
}

export const useCommandPaletteStore = create<CommandPaletteStore>((set) => ({
  open: false,
  openIntent: null,
  setOpen: (open) => set({ open, ...(open ? {} : { openIntent: null }) }),
  toggleOpen: () =>
    set((state) => ({ open: !state.open, ...(state.open ? { openIntent: null } : {}) })),
  openAddProject: (workspace, projectKind) =>
    set((state) => ({
      open: true,
      openIntent: {
        kind: "add-project",
        requestId: (state.openIntent?.requestId ?? 0) + 1,
        ...(workspace ? { workspace } : {}),
        ...(projectKind ? { projectKind } : {}),
      },
    })),
  clearOpenIntent: () => set({ openIntent: null }),
}));
