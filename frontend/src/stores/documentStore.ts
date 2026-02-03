import { create } from 'zustand';
import type { Document, Entity, Point, Sketch } from '@/types/document';
import { createEmptyDocument, createEmptySketch } from '@/utils/document';
import { createMirroredEntity, createRotatedEntity, createTranslatedEntity, propagateDerived } from '@/utils/propagate';
import { rotatePoint } from '@/utils/geometry';

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
  rotatePolygon(entityId: string, angleDelta: number): void;
  extendPolyline(entityId: string, point: Point, end: 'start' | 'end'): void;

  // Construction toggle
  toggleConstruction(entityIds: string[]): void;

  // Mirror
  mirrorEntities(entityIds: string[], lineA: Point, lineB: Point): string[];

  // Circular copy
  circularCopyEntities(entityIds: string[], center: Point, count: number): string[];

  // Grid copy
  gridCopyEntities(entityIds: string[], countX: number, countY: number, spacingX: number, spacingY: number): string[];

  // Dimension editing
  applyDimensionValue(dimensionId: string, newValue: number): void;

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
    const { document } = get();
    const sketch = document.sketches.find((sk) => sk.id === document.activeSketchId);
    // Build the full set of IDs to remove, cascading through derived entities
    const idSet = new Set(entityIds);
    if (sketch) {
      let changed = true;
      while (changed) {
        changed = false;
        for (const e of sketch.entities) {
          if (idSet.has(e.id)) continue;
          if ('sourceId' in e && e.sourceId && idSet.has(e.sourceId)) {
            idSet.add(e.id);
            changed = true;
          }
        }
      }
    }
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
                entities: propagateDerived(sk.entities.map((e) => {
                  if (!idSet.has(e.id)) return e;
                  if ('sourceId' in e && e.sourceId) return e; // locked
                  if (e.type === 'line') {
                    return {
                      ...e,
                      points: e.points.map((p) => ({
                        x: p.x + delta.x,
                        y: p.y + delta.y,
                      })),
                      ...(e.polygonCenter ? {
                        polygonCenter: {
                          x: e.polygonCenter.x + delta.x,
                          y: e.polygonCenter.y + delta.y,
                        },
                      } : {}),
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
                })),
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
                entities: propagateDerived(sk.entities.map((e) => {
                  if (e.id !== entityId || e.type !== 'line') return e;
                  if (e.sourceId) return e; // locked
                  return {
                    ...e,
                    points: e.points.map((p, i) =>
                      i === pointIndex
                        ? { x: p.x + delta.x, y: p.y + delta.y }
                        : p,
                    ),
                  };
                })),
              }
            : sk,
        ),
      },
    });
  },

  rotatePolygon(entityId, angleDelta) {
    const { document } = get();
    set({
      document: {
        ...document,
        sketches: document.sketches.map((sk) =>
          sk.id === document.activeSketchId
            ? {
                ...sk,
                entities: propagateDerived(sk.entities.map((e) => {
                  if (e.id !== entityId || e.type !== 'line') return e;
                  if (e.sourceId) return e; // locked
                  if (!e.polygonCenter) return e;
                  const center = e.polygonCenter;
                  return {
                    ...e,
                    points: e.points.map((p) => rotatePoint(p, center, angleDelta)),
                  };
                })),
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
                entities: propagateDerived(sk.entities.map((e) => {
                  if (e.id !== entityId || e.type !== 'line') return e;
                  if (e.sourceId) return e; // locked
                  return {
                    ...e,
                    points:
                      end === 'start'
                        ? [point, ...e.points]
                        : [...e.points, point],
                  };
                })),
              }
            : sk,
        ),
      },
    });
  },

  toggleConstruction(entityIds) {
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
                  if ('sourceId' in e && e.sourceId) return e; // locked
                  if (e.type === 'line' || e.type === 'circle' || e.type === 'rectangle') {
                    return { ...e, construction: !e.construction };
                  }
                  return e;
                }),
              }
            : sk,
        ),
      },
    });
  },

  mirrorEntities(entityIds, lineA, lineB) {
    const { document } = get();
    const sketch = document.sketches.find((sk) => sk.id === document.activeSketchId);
    if (!sketch) return [];
    const transform = { type: 'mirror' as const, lineA, lineB };
    const newEntities: Entity[] = [];
    for (const id of entityIds) {
      const source = sketch.entities.find((e) => e.id === id);
      if (!source) continue;
      const newId = crypto.randomUUID();
      const mirrored = createMirroredEntity(source, transform, newId);
      if (mirrored) newEntities.push(mirrored);
    }
    if (newEntities.length === 0) return [];
    set({
      document: {
        ...document,
        sketches: document.sketches.map((sk) =>
          sk.id === document.activeSketchId
            ? { ...sk, entities: [...sk.entities, ...newEntities] }
            : sk,
        ),
      },
    });
    return newEntities.map((e) => e.id);
  },

  circularCopyEntities(entityIds, center, count) {
    const { document } = get();
    const sketch = document.sketches.find((sk) => sk.id === document.activeSketchId);
    if (!sketch) return [];
    const newEntities: Entity[] = [];
    for (const id of entityIds) {
      const source = sketch.entities.find((e) => e.id === id);
      if (!source) continue;
      for (let i = 1; i < count; i++) {
        const angle = (2 * Math.PI / count) * i;
        const transform = { type: 'rotate' as const, center, angle };
        const newId = crypto.randomUUID();
        const rotated = createRotatedEntity(source, transform, newId);
        if (rotated) newEntities.push(rotated);
      }
    }
    if (newEntities.length === 0) return [];
    set({
      document: {
        ...document,
        sketches: document.sketches.map((sk) =>
          sk.id === document.activeSketchId
            ? { ...sk, entities: [...sk.entities, ...newEntities] }
            : sk,
        ),
      },
    });
    return newEntities.map((e) => e.id);
  },

  gridCopyEntities(entityIds, countX, countY, spacingX, spacingY) {
    const { document } = get();
    const sketch = document.sketches.find((sk) => sk.id === document.activeSketchId);
    if (!sketch) return [];
    const newEntities: Entity[] = [];
    for (const id of entityIds) {
      const source = sketch.entities.find((e) => e.id === id);
      if (!source) continue;
      for (let row = 0; row < countY; row++) {
        for (let col = 0; col < countX; col++) {
          if (row === 0 && col === 0) continue; // skip source position
          const transform = { type: 'translate' as const, dx: col * spacingX, dy: row * spacingY };
          const newId = crypto.randomUUID();
          const translated = createTranslatedEntity(source, transform, newId);
          if (translated) newEntities.push(translated);
        }
      }
    }
    if (newEntities.length === 0) return [];
    set({
      document: {
        ...document,
        sketches: document.sketches.map((sk) =>
          sk.id === document.activeSketchId
            ? { ...sk, entities: [...sk.entities, ...newEntities] }
            : sk,
        ),
      },
    });
    return newEntities.map((e) => e.id);
  },

  applyDimensionValue(dimensionId, newValue) {
    const { document } = get();
    const sketch = document.sketches.find((sk) => sk.id === document.activeSketchId);
    if (!sketch) return;
    const dim = sketch.entities.find((e) => e.id === dimensionId);
    if (!dim || dim.type !== 'dimension') return;
    const target = sketch.entities.find((e) => e.id === dim.targetEntityId);
    if (!target) return;
    if ('sourceId' in target && target.sourceId) return; // locked

    get().beginTransaction();

    set({
      document: {
        ...document,
        sketches: document.sketches.map((sk) =>
          sk.id === document.activeSketchId
            ? {
                ...sk,
                entities: propagateDerived(sk.entities.map((e) => {
                  if (e.id !== target.id) return e;
                  if (e.type === 'line') {
                    // Polygon apothem dimension
                    if (dim.segmentIndex === -1 && e.polygonCenter) {
                      const center = e.polygonCenter;
                      const midA = {
                        x: (e.points[0]!.x + e.points[1]!.x) / 2,
                        y: (e.points[0]!.y + e.points[1]!.y) / 2,
                      };
                      const curApothem = Math.sqrt((midA.x - center.x) ** 2 + (midA.y - center.y) ** 2);
                      if (curApothem === 0) return e;
                      const scale = newValue / curApothem;
                      return {
                        ...e,
                        points: e.points.map((p) => ({
                          x: center.x + (p.x - center.x) * scale,
                          y: center.y + (p.y - center.y) * scale,
                        })),
                      };
                    }
                    const idx = dim.segmentIndex;
                    if (idx < 0 || idx >= e.points.length - 1) return e;
                    const pa = e.points[idx]!;
                    const pb = e.points[idx + 1]!;
                    const dx = pb.x - pa.x;
                    const dy = pb.y - pa.y;
                    const len = Math.sqrt(dx * dx + dy * dy);
                    if (len === 0) return e;
                    const dirX = dx / len;
                    const dirY = dy / len;
                    const newPoints = [...e.points];
                    newPoints[idx + 1] = {
                      x: pa.x + dirX * newValue,
                      y: pa.y + dirY * newValue,
                    };
                    return { ...e, points: newPoints };
                  }
                  if (e.type === 'circle') {
                    return { ...e, radius: newValue / 2 };
                  }
                  if (e.type === 'rectangle') {
                    if (dim.segmentIndex === 0) {
                      return { ...e, width: newValue };
                    } else {
                      return { ...e, height: newValue };
                    }
                  }
                  return e;
                })),
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
