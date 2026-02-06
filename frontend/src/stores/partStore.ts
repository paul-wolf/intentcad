import { create } from 'zustand';
import type { Part, Feature } from '@/types/part';

const UNDO_STACK_LIMIT = 100;

export interface PartHistoryEntry {
  label: string;
  part: Part;
  timestamp: number;
}

function createEmptyPart(name: string): Part {
  return {
    id: crypto.randomUUID(),
    name,
    documentId: '',
    features: [],
  };
}

interface PartStore {
  part: Part;
  undoStack: PartHistoryEntry[];
  redoStack: PartHistoryEntry[];

  setPart(part: Part): void;
  setPartName(name: string): void;
  beginTransaction(label: string): void;
  undo(): void;
  redo(): void;
  restoreHistory(persisted: { undo: PartHistoryEntry[]; redo: PartHistoryEntry[] }): void;

  addFeature(feature: Feature): void;
  updateFeature(featureId: string, updated: Feature): void;
  removeFeature(featureId: string): void;
}

let txSnapshot: Part | null = null;

export const usePartStore = create<PartStore>((set, get) => ({
  part: createEmptyPart('Untitled Part'),
  undoStack: [],
  redoStack: [],

  setPart(part) {
    set({ part, undoStack: [], redoStack: [] });
    txSnapshot = null;
  },

  setPartName(name) {
    set((s) => ({ part: { ...s.part, name } }));
  },

  beginTransaction(label) {
    const state = get();
    if (txSnapshot === state.part) return;
    const entry: PartHistoryEntry = {
      label,
      part: state.part,
      timestamp: Date.now(),
    };
    set((s) => ({
      undoStack: [...s.undoStack, entry].slice(-UNDO_STACK_LIMIT),
      redoStack: [],
    }));
    txSnapshot = state.part;
  },

  undo() {
    const { undoStack, part } = get();
    if (undoStack.length === 0) return;
    const prev = undoStack[undoStack.length - 1]!;
    set((s) => ({
      part: prev.part,
      undoStack: s.undoStack.slice(0, -1),
      redoStack: [...s.redoStack, { label: prev.label, part, timestamp: Date.now() }],
    }));
    txSnapshot = null;
  },

  redo() {
    const { redoStack, part } = get();
    if (redoStack.length === 0) return;
    const next = redoStack[redoStack.length - 1]!;
    set((s) => ({
      part: next.part,
      undoStack: [...s.undoStack, { label: next.label, part, timestamp: Date.now() }],
      redoStack: s.redoStack.slice(0, -1),
    }));
    txSnapshot = null;
  },

  restoreHistory(persisted) {
    set({ undoStack: persisted.undo, redoStack: persisted.redo });
  },

  addFeature(feature) {
    set((s) => ({
      part: { ...s.part, features: [...s.part.features, feature] },
    }));
  },

  updateFeature(featureId, updated) {
    set((s) => ({
      part: {
        ...s.part,
        features: s.part.features.map((f) => (f.id === featureId ? updated : f)),
      },
    }));
  },

  removeFeature(featureId) {
    set((s) => ({
      part: {
        ...s.part,
        features: s.part.features.filter((f) => f.id !== featureId),
      },
    }));
  },
}));
