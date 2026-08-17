import { create } from 'zustand';
import type { BuildFeature } from '@/api/client';

/**
 * Holds the 3D build feature tree for the session (so closing/reopening the
 * panel keeps the part) with undo/redo history. `panelOpen` lets the editor's
 * global keyboard shortcuts stand down while the panel owns the keyboard.
 */
interface BuildState {
  features: BuildFeature[];
  past: BuildFeature[][];
  future: BuildFeature[][];
  panelOpen: boolean;
  setFeatures: (features: BuildFeature[]) => void;  // records an undo step
  initTree: (features: BuildFeature[]) => void;     // seed; no history
  undo: () => void;
  redo: () => void;
  setPanelOpen: (panelOpen: boolean) => void;
}

export const useBuildStore = create<BuildState>((set) => ({
  features: [],
  past: [],
  future: [],
  panelOpen: false,

  setFeatures: (features) =>
    set((s) => ({ features, past: [...s.past, s.features], future: [] })),

  initTree: (features) => set({ features, past: [], future: [] }),

  undo: () =>
    set((s) => {
      if (s.past.length === 0) return s;
      const prev = s.past[s.past.length - 1]!;
      return { features: prev, past: s.past.slice(0, -1), future: [s.features, ...s.future] };
    }),

  redo: () =>
    set((s) => {
      if (s.future.length === 0) return s;
      const next = s.future[0]!;
      return { features: next, past: [...s.past, s.features], future: s.future.slice(1) };
    }),

  setPanelOpen: (panelOpen) => set({ panelOpen }),
}));
