import { create } from 'zustand';
import type { Point } from '@/types/document';
import type { ToolType, ToolState } from '@/types/editor';

interface EditorStore {
  activeTool: ToolType;
  selectedEntityIds: Set<string>;
  toolState: ToolState;
  cursorWorld: Point | null;
  altKeyHeld: boolean;

  setActiveTool(tool: ToolType): void;
  setSelectedEntityIds(ids: Set<string>): void;
  addToSelection(ids: string[]): void;
  clearSelection(): void;
  setToolState(state: ToolState): void;
  setCursorWorld(p: Point | null): void;
  setAltKeyHeld(held: boolean): void;
}

function defaultToolState(tool: ToolType): ToolState {
  switch (tool) {
    case 'line':
      return { type: 'line', firstPoint: null, activePolylineId: null, activeEnd: null };
    case 'select':
      return { type: 'select', dragStart: null, dragEnd: null };
    case 'dimension':
      return { type: 'dimension' };
  }
}

export const useEditorStore = create<EditorStore>((set) => ({
  activeTool: 'line',
  selectedEntityIds: new Set(),
  toolState: { type: 'line', firstPoint: null, activePolylineId: null, activeEnd: null },
  cursorWorld: null,
  altKeyHeld: false,

  setActiveTool(tool) {
    set({ activeTool: tool, toolState: defaultToolState(tool), selectedEntityIds: new Set() });
  },

  setSelectedEntityIds(ids) {
    set({ selectedEntityIds: ids });
  },

  addToSelection(ids) {
    set((s) => {
      const next = new Set(s.selectedEntityIds);
      for (const id of ids) next.add(id);
      return { selectedEntityIds: next };
    });
  },

  clearSelection() {
    set({ selectedEntityIds: new Set() });
  },

  setToolState(state) {
    set({ toolState: state });
  },

  setCursorWorld(p) {
    set({ cursorWorld: p });
  },

  setAltKeyHeld(held) {
    set({ altKeyHeld: held });
  },
}));
