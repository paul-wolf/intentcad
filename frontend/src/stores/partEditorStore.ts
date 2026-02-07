import { create } from 'zustand';
import type { Feature } from '@/types/part';
import type { Document } from '@/types/document';

interface PartEditorStore {
  selectedFeatureId: string | null;
  hoveredFaceId: string | null;

  /** The in-progress (uncommitted) feature being created or edited */
  draftFeature: Feature | null;
  /** Non-null when editing an existing feature (vs creating a new one) */
  editingExistingId: string | null;
  /** Cached sketch document for the draft feature */
  draftSketchDoc: Document | null;

  setSelectedFeatureId(id: string | null): void;
  setHoveredFaceId(id: string | null): void;
  setDraftFeature(feature: Feature | null): void;
  setDraftSketchDoc(doc: Document | null): void;
  startCreating(feature: Feature): void;
  startEditing(feature: Feature): void;
  clearDraft(): void;
}

export const usePartEditorStore = create<PartEditorStore>((set) => ({
  selectedFeatureId: null,
  hoveredFaceId: null,
  draftFeature: null,
  editingExistingId: null,
  draftSketchDoc: null,

  setSelectedFeatureId(id) {
    set({ selectedFeatureId: id });
  },

  setHoveredFaceId(id) {
    set({ hoveredFaceId: id });
  },

  setDraftFeature(feature) {
    set({ draftFeature: feature });
  },

  setDraftSketchDoc(doc) {
    set({ draftSketchDoc: doc });
  },

  startCreating(feature) {
    set({ draftFeature: feature, editingExistingId: null, draftSketchDoc: null });
  },

  startEditing(feature) {
    set({ draftFeature: feature, editingExistingId: feature.id, draftSketchDoc: null });
  },

  clearDraft() {
    set({ draftFeature: null, editingExistingId: null, draftSketchDoc: null });
  },
}));
