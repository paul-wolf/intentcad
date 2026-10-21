import { create } from 'zustand';
import type { Point } from '@/types/document';
import { setAxesShown } from '@/utils/sketchAxes';

const STORAGE_KEY = 'intentcad-ui-state';
const DRAWER_KEY = 'intentcad-drawer-open';
const PROPERTIES_KEY = 'intentcad-properties-open';
const AXES_KEY = 'intentcad-sketch-axes';

export interface PerDocumentUIState {
  viewport?: { offset: Point; scale: number };
}

interface UIStateStore {
  states: Record<string, PerDocumentUIState>;
  drawerOpen: boolean;
  propertiesOpen: boolean;
  /** Whether sketches show their built-in axes (utils/sketchAxes.ts): a
   *  view setting for this user, not saved with the sketch. Hidden axes keep
   *  the constraints on them working; they just can't be picked or snapped to. */
  axesShown: boolean;
  toggleAxes(): void;
  setViewport(docId: string, offset: Point, scale: number): void;
  getViewport(docId: string): { offset: Point; scale: number } | undefined;
  toggleDrawer(): void;
  toggleProperties(): void;
}

function loadStates(): Record<string, PerDocumentUIState> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') return parsed as Record<string, PerDocumentUIState>;
    }
  } catch { /* ignore */ }
  return {};
}

function saveStates(states: Record<string, PerDocumentUIState>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(states));
  } catch { /* ignore */ }
}

export const useUIStateStore = create<UIStateStore>((set, get) => ({
  states: loadStates(),
  drawerOpen: localStorage.getItem(DRAWER_KEY) === 'true',
  propertiesOpen: localStorage.getItem(PROPERTIES_KEY) === 'true',
  axesShown: (() => { try { return localStorage.getItem(AXES_KEY) !== 'hide'; } catch { return true; } })(),

  toggleAxes() {
    set((s) => {
      const next = !s.axesShown;
      try { localStorage.setItem(AXES_KEY, next ? 'show' : 'hide'); } catch { /* ignore */ }
      setAxesShown(next);
      return { axesShown: next };
    });
  },

  toggleDrawer() {
    set((s) => {
      const next = !s.drawerOpen;
      localStorage.setItem(DRAWER_KEY, String(next));
      return { drawerOpen: next };
    });
  },

  toggleProperties() {
    set((s) => {
      const next = !s.propertiesOpen;
      localStorage.setItem(PROPERTIES_KEY, String(next));
      return { propertiesOpen: next };
    });
  },

  setViewport(docId: string, offset: Point, scale: number) {
    set((s) => {
      const next = {
        ...s.states,
        [docId]: { ...s.states[docId], viewport: { offset, scale } },
      };
      saveStates(next);
      return { states: next };
    });
  },

  getViewport(docId: string) {
    return get().states[docId]?.viewport;
  },
}));

setAxesShown(useUIStateStore.getState().axesShown);
