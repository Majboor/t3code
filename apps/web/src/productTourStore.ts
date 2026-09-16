import { create } from "zustand";

interface ProductTourStore {
  active: boolean;
  stepIndex: number;
  start: () => void;
  stop: () => void;
  next: (totalSteps: number) => void;
  back: () => void;
  goTo: (index: number) => void;
}

/**
 * Cross-cutting tour state, mirroring `commandPaletteStore`: a global
 * singleton a menu item anywhere in the tree can flip on, and the overlay
 * mounted once in `_chat.tsx` reads.
 */
export const useProductTourStore = create<ProductTourStore>((set) => ({
  active: false,
  stepIndex: 0,
  start: () => set({ active: true, stepIndex: 0 }),
  stop: () => set({ active: false }),
  next: (totalSteps) =>
    set((state) => {
      const nextIndex = state.stepIndex + 1;
      if (nextIndex >= totalSteps) {
        return { active: false, stepIndex: 0 };
      }
      return { stepIndex: nextIndex };
    }),
  back: () => set((state) => ({ stepIndex: Math.max(0, state.stepIndex - 1) })),
  goTo: (index) => set({ stepIndex: index }),
}));
