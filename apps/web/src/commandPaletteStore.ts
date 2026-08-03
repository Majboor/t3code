import { create } from "zustand";
import type { EnvironmentId, OrchestrationProjectOwnership } from "@t3tools/contracts";

export interface AddProjectWorkspaceContext {
  readonly environmentId: EnvironmentId;
  readonly ownership: OrchestrationProjectOwnership;
}

interface CommandPaletteOpenIntent {
  kind: "add-project";
  requestId: number;
  workspace?: AddProjectWorkspaceContext;
}

interface CommandPaletteStore {
  open: boolean;
  openIntent: CommandPaletteOpenIntent | null;
  setOpen: (open: boolean) => void;
  toggleOpen: () => void;
  openAddProject: (workspace?: AddProjectWorkspaceContext) => void;
  clearOpenIntent: () => void;
}

export const useCommandPaletteStore = create<CommandPaletteStore>((set) => ({
  open: false,
  openIntent: null,
  setOpen: (open) => set({ open, ...(open ? {} : { openIntent: null }) }),
  toggleOpen: () =>
    set((state) => ({ open: !state.open, ...(state.open ? { openIntent: null } : {}) })),
  openAddProject: (workspace) =>
    set((state) => ({
      open: true,
      openIntent: {
        kind: "add-project",
        requestId: (state.openIntent?.requestId ?? 0) + 1,
        ...(workspace ? { workspace } : {}),
      },
    })),
  clearOpenIntent: () => set({ openIntent: null }),
}));
