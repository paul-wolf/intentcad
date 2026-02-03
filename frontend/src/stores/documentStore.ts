import { create } from 'zustand';
import type { Document, Entity, Point, Sketch } from '@/types/document';
import { createEmptyDocument, createEmptySketch } from '@/utils/document';

const UNDO_STACK_LIMIT = 100;

interface DocumentStore {
  document: Document;
  undoStack: Document[];
  redoStack: Document[];

  // Document actions
  setDocument(doc: Document): void;
  setDocumentName(name: string): void;

  // Undo/Redo
  beginTransaction(): void;
  undo(): void;
  redo(): void;

  // Sketch actions
  addSketch(name: string): void;
  renameSketch(sketchId: string, name: string): void;
  toggleSketchVisibility(sketchId: string): void;
  setActiveSketch(sketchId: string): void;

  // Entity actions
  addEntity(entity: Entity): void;
  removeEntities(entityIds: string[]): void;
  moveEntities(entityIds: string[], delta: Point): void;
  movePoint(entityId: string, pointIndex: number, delta: Point): void;
  extendPolyline(entityId: string, point: Point, end: 'start' | 'end'): void;

  // Helpers
  getActiveSketch(): Sketch | undefined;
}

export const useDocumentStore = create<DocumentStore>((set, get) => ({
  document: createEmptyDocument('Untitled'),
  undoStack: [],
  redoStack: [],

  setDocument(doc) {
    set({ document: doc });
  },

  setDocumentName(name) {
    set((s) => ({ document: { ...s.document, name } }));
  },

  beginTransaction() {
    const { document, undoStack } = get();
    const newStack = [...undoStack, structuredClone(document)];
    if (newStack.length > UNDO_STACK_LIMIT) {
      newStack.splice(0, newStack.length - UNDO_STACK_LIMIT);
    }
    set({ undoStack: newStack, redoStack: [] });
  },

  undo() {
    const { undoStack, redoStack, document } = get();
    if (undoStack.length === 0) return;
    const prev = undoStack[undoStack.length - 1]!;
    set({
      document: prev,
      undoStack: undoStack.slice(0, -1),
      redoStack: [...redoStack, structuredClone(document)],
    });
  },

  redo() {
    const { undoStack, redoStack, document } = get();
    if (redoStack.length === 0) return;
    const next = redoStack[redoStack.length - 1]!;
    set({
      document: next,
      undoStack: [...undoStack, structuredClone(document)],
      redoStack: redoStack.slice(0, -1),
    });
  },

  addSketch(name) {
    const sketch = createEmptySketch(name);
    set((s) => ({
      document: {
        ...s.document,
        sketches: [...s.document.sketches, sketch],
        activeSketchId: sketch.id,
      },
    }));
  },

  renameSketch(sketchId, name) {
    set((s) => ({
      document: {
        ...s.document,
        sketches: s.document.sketches.map((sk) =>
          sk.id === sketchId ? { ...sk, name } : sk,
        ),
      },
    }));
  },

  toggleSketchVisibility(sketchId) {
    set((s) => ({
      document: {
        ...s.document,
        sketches: s.document.sketches.map((sk) =>
          sk.id === sketchId ? { ...sk, visible: !sk.visible } : sk,
        ),
      },
    }));
  },

  setActiveSketch(sketchId) {
    set((s) => ({ document: { ...s.document, activeSketchId: sketchId } }));
  },

  addEntity(entity) {
    const { document } = get();
    set({
      document: {
        ...document,
        sketches: document.sketches.map((sk) =>
          sk.id === document.activeSketchId
            ? { ...sk, entities: [...sk.entities, entity] }
            : sk,
        ),
      },
    });
  },

  removeEntities(entityIds) {
    const idSet = new Set(entityIds);
    const { document } = get();
    set({
      document: {
        ...document,
        sketches: document.sketches.map((sk) =>
          sk.id === document.activeSketchId
            ? {
                ...sk,
                entities: sk.entities.filter((e) => {
                  if (idSet.has(e.id)) return false;
                  if (e.type === 'dimension' && idSet.has(e.targetEntityId)) return false;
                  return true;
                }),
              }
            : sk,
        ),
      },
    });
  },

  moveEntities(entityIds, delta) {
    const idSet = new Set(entityIds);
    const { document } = get();
    set({
      document: {
        ...document,
        sketches: document.sketches.map((sk) =>
          sk.id === document.activeSketchId
            ? {
                ...sk,
                entities: sk.entities.map((e) => {
                  if (!idSet.has(e.id)) return e;
                  if (e.type === 'line') {
                    return {
                      ...e,
                      points: e.points.map((p) => ({
                        x: p.x + delta.x,
                        y: p.y + delta.y,
                      })),
                    };
                  }
                  if (e.type === 'circle') {
                    return {
                      ...e,
                      center: {
                        x: e.center.x + delta.x,
                        y: e.center.y + delta.y,
                      },
                    };
                  }
                  if (e.type === 'rectangle') {
                    return {
                      ...e,
                      center: {
                        x: e.center.x + delta.x,
                        y: e.center.y + delta.y,
                      },
                    };
                  }
                  return e;
                }),
              }
            : sk,
        ),
      },
    });
  },

  movePoint(entityId, pointIndex, delta) {
    const { document } = get();
    set({
      document: {
        ...document,
        sketches: document.sketches.map((sk) =>
          sk.id === document.activeSketchId
            ? {
                ...sk,
                entities: sk.entities.map((e) => {
                  if (e.id !== entityId || e.type !== 'line') return e;
                  return {
                    ...e,
                    points: e.points.map((p, i) =>
                      i === pointIndex
                        ? { x: p.x + delta.x, y: p.y + delta.y }
                        : p,
                    ),
                  };
                }),
              }
            : sk,
        ),
      },
    });
  },

  extendPolyline(entityId, point, end) {
    const { document } = get();
    set({
      document: {
        ...document,
        sketches: document.sketches.map((sk) =>
          sk.id === document.activeSketchId
            ? {
                ...sk,
                entities: sk.entities.map((e) => {
                  if (e.id !== entityId || e.type !== 'line') return e;
                  return {
                    ...e,
                    points:
                      end === 'start'
                        ? [point, ...e.points]
                        : [...e.points, point],
                  };
                }),
              }
            : sk,
        ),
      },
    });
  },

  getActiveSketch() {
    const { document } = get();
    return document.sketches.find((sk) => sk.id === document.activeSketchId);
  },
}));
