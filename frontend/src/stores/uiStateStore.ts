import { create } from 'zustand';
import type { Point } from '@/types/document';

const STORAGE_KEY = 'intentcad-ui-state';
const DRAWER_KEY = 'intentcad-drawer-open';

export interface PerDocumentUIState {
  viewport?: { offset: Point; scale: number };
}

interface UIStateStore {
  states: Record<string, PerDocumentUIState>;
  drawerOpen: boolean;
  setViewport(docId: string, offset: Point, scale: number): void;
  getViewport(docId: string): { offset: Point; scale: number } | undefined;
  toggleDrawer(): void;
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

  toggleDrawer() {
    set((s) => {
      const next = !s.drawerOpen;
      localStorage.setItem(DRAWER_KEY, String(next));
      return { drawerOpen: next };
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
