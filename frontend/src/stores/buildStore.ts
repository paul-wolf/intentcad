import { create } from 'zustand';
import type { BuildFeature } from '@/api/client';

/**
 * Holds the 3D build feature tree for the session so it survives closing and
 * reopening the Build panel (the tree used to be local component state, which
 * meant reopening started a new part). `panelOpen` lets the editor's global
 * keyboard shortcuts stand down while the panel owns the keyboard.
 */
interface BuildState {
  features: BuildFeature[];
  panelOpen: boolean;
  setFeatures: (features: BuildFeature[]) => void;
  setPanelOpen: (panelOpen: boolean) => void;
}

export const useBuildStore = create<BuildState>((set) => ({
  features: [],
  panelOpen: false,
  setFeatures: (features) => set({ features }),
  setPanelOpen: (panelOpen) => set({ panelOpen }),
}));
