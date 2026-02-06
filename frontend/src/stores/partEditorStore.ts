import { create } from 'zustand';

interface PartEditorStore {
  selectedFeatureId: string | null;
  hoveredFaceId: string | null;

  setSelectedFeatureId(id: string | null): void;
  setHoveredFaceId(id: string | null): void;
}

export const usePartEditorStore = create<PartEditorStore>((set) => ({
  selectedFeatureId: null,
  hoveredFaceId: null,

  setSelectedFeatureId(id) {
    set({ selectedFeatureId: id });
  },

  setHoveredFaceId(id) {
    set({ hoveredFaceId: id });
  },
}));
