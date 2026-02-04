import { create } from 'zustand';
import type { Document, Entity, Point, Sketch, Constraint, HorizontalConstraint, VerticalConstraint } from '@/types/document';
import { createEmptyDocument, createEmptySketch } from '@/utils/document';
import { createMirroredEntity, createRotatedEntity, createTranslatedEntity, propagateDerived } from '@/utils/propagate';
import { rotatePoint, lineLineIntersection } from '@/utils/geometry';
import { getEntityPoint, setEntityPoint, getEntityPoints } from '@/utils/entityPoints';
import { solveConstraints, validateConstraint } from '@/utils/constraintSolver';
import { computeDerivedDimensionIds } from '@/utils/dof';
import type { SelectedPoint } from '@/stores/editorStore';

const UNDO_STACK_LIMIT = 100;

/** Check if a constraint references any of the given entity IDs. */
function constraintReferencesAny(c: Constraint, idSet: Set<string>): boolean {
  if (idSet.has(c.entityId)) return true;
  if ('targetEntityId' in c && idSet.has(c.targetEntityId)) return true;
  return false;
}

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
  toggleSketchSuppressed(sketchId: string): void;
  moveSketch(sketchId: string, direction: 'up' | 'down'): void;
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

  // Constraints
  addConstraint(constraint: Constraint): void;
  removeConstraints(entityIds: string[]): void;
  toggleFixed(entityIds: string[]): void;
  toggleEqual(entityIds: string[]): void;
  toggleCoincident(entityIds: string[]): void;
  toggleCoincidentWithPoints(pt1: SelectedPoint, pt2: SelectedPoint): void;
  toggleMidpoint(point: SelectedPoint, segment: {entityId: string, segmentIndex: number}): void;
  toggleParallel(seg1: {entityId: string, segmentIndex: number}, seg2: {entityId: string, segmentIndex: number}): void;
  togglePerpendicular(seg1: {entityId: string, segmentIndex: number}, seg2: {entityId: string, segmentIndex: number}): void;
  toggleTangent(e1Id: string, seg1Idx: number, e2Id: string, seg2Idx: number): void;
  toggleBisect(seg1: {entityId: string, segmentIndex: number}, seg2: {entityId: string, segmentIndex: number}): void;
  toggleHorizontal(entityIds: string[], segments?: {entityId: string, segmentIndex: number}[]): void;
  toggleVertical(entityIds: string[], segments?: {entityId: string, segmentIndex: number}[]): void;

  // Entity replacement
  updateEntity(entityId: string, updatedEntity: Entity): void;

  // Dimension editing
  applyDimensionValue(dimensionId: string, newValue: number): void;

  // Helpers
  getActiveSketch(): Sketch | undefined;
}

/** Helper to update sketch entities and constraints in one set() call. */
function updateActiveSketch(
  document: Document,
  update: (sk: Sketch) => Partial<Pick<Sketch, 'entities' | 'constraints'>>,
): Document {
  return {
    ...document,
    sketches: document.sketches.map((sk) =>
      sk.id === document.activeSketchId ? { ...sk, ...update(sk) } : sk,
    ),
  };
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

  toggleSketchSuppressed(sketchId) {
    set((s) => ({
      document: {
        ...s.document,
        sketches: s.document.sketches.map((sk) =>
          sk.id === sketchId ? { ...sk, suppressed: !sk.suppressed } : sk,
        ),
      },
    }));
  },

  moveSketch(sketchId, direction) {
    set((s) => {
      const sketches = [...s.document.sketches];
      const idx = sketches.findIndex((sk) => sk.id === sketchId);
      if (idx < 0) return s;
      const targetIdx = direction === 'up' ? idx - 1 : idx + 1;
      if (targetIdx < 0 || targetIdx >= sketches.length) return s;
      [sketches[idx], sketches[targetIdx]] = [sketches[targetIdx]!, sketches[idx]!];
      return { document: { ...s.document, sketches } };
    });
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
                  if (e.type === 'dimension' && e.targetEntityId2 && idSet.has(e.targetEntityId2)) return false;
                  return true;
                }),
                constraints: sk.constraints.filter((c) => !constraintReferencesAny(c, idSet)),
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
                entities: solveConstraints(sk.entities.map((e) => {
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
                  if (e.type === 'point') {
                    return {
                      ...e,
                      position: {
                        x: e.position.x + delta.x,
                        y: e.position.y + delta.y,
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
                }), sk.constraints, { movedIds: idSet }).entities,
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
                entities: solveConstraints(sk.entities.map((e) => {
                  if (e.id !== entityId || e.type !== 'line') return e;
                  if (e.sourceId) return e; // locked
                  // Polygon: translate rigidly to preserve regular shape
                  if (e.polygonCenter) {
                    return {
                      ...e,
                      points: e.points.map((p) => ({
                        x: p.x + delta.x,
                        y: p.y + delta.y,
                      })),
                      polygonCenter: {
                        x: e.polygonCenter.x + delta.x,
                        y: e.polygonCenter.y + delta.y,
                      },
                    };
                  }
                  return {
                    ...e,
                    points: e.points.map((p, i) =>
                      i === pointIndex
                        ? { x: p.x + delta.x, y: p.y + delta.y }
                        : p,
                    ),
                  };
                }), sk.constraints, { movedIds: new Set([entityId]) }).entities,
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
                entities: solveConstraints(sk.entities.map((e) => {
                  if (e.id !== entityId || e.type !== 'line') return e;
                  if (e.sourceId) return e; // locked
                  if (!e.polygonCenter) return e;
                  const center = e.polygonCenter;
                  return {
                    ...e,
                    points: e.points.map((p) => rotatePoint(p, center, angleDelta)),
                  };
                }), sk.constraints, { movedIds: new Set([entityId]) }).entities,
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
                  if (e.polygonCenter) return e; // polygon: cannot extend
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
                  if (e.type === 'line' || e.type === 'circle' || e.type === 'rectangle' || e.type === 'point') {
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

  addConstraint(constraint) {
    const { document } = get();
    set({
      document: {
        ...document,
        sketches: document.sketches.map((sk) =>
          sk.id === document.activeSketchId
            ? { ...sk, constraints: [...sk.constraints, constraint] }
            : sk,
        ),
      },
    });
  },

  removeConstraints(entityIds) {
    const idSet = new Set(entityIds);
    const { document } = get();
    set({
      document: {
        ...document,
        sketches: document.sketches.map((sk) =>
          sk.id === document.activeSketchId
            ? { ...sk, constraints: sk.constraints.filter((c) => !constraintReferencesAny(c, idSet)) }
            : sk,
        ),
      },
    });
  },

  toggleFixed(entityIds) {
    const { document } = get();
    const sketch = document.sketches.find((sk) => sk.id === document.activeSketchId);
    if (!sketch) return;
    const fixedSet = new Set(sketch.constraints.filter((c) => c.type === 'fixed').map((c) => c.entityId));
    const allFixed = entityIds.every((id) => fixedSet.has(id));
    if (allFixed) {
      // Remove fixed constraints for these entities
      const removeSet = new Set(entityIds);
      set({
        document: {
          ...document,
          sketches: document.sketches.map((sk) =>
            sk.id === document.activeSketchId
              ? { ...sk, constraints: sk.constraints.filter((c) => !(c.type === 'fixed' && removeSet.has(c.entityId))) }
              : sk,
          ),
        },
      });
    } else {
      // Add fixed constraints for entities that aren't already fixed
      const newConstraints = entityIds
        .filter((id) => !fixedSet.has(id))
        .map((id) => ({ id: crypto.randomUUID(), type: 'fixed' as const, entityId: id }));
      set({
        document: {
          ...document,
          sketches: document.sketches.map((sk) =>
            sk.id === document.activeSketchId
              ? { ...sk, constraints: [...sk.constraints, ...newConstraints] }
              : sk,
          ),
        },
      });
    }
  },

  toggleEqual(entityIds) {
    if (entityIds.length !== 2) return;
    const { document } = get();
    const sketch = document.sketches.find((sk) => sk.id === document.activeSketchId);
    if (!sketch) return;

    const [id1, id2] = entityIds as [string, string];

    // Check if constraint already exists between these two
    const existing = sketch.constraints.find((c) =>
      c.type === 'equal' &&
      ((c.entityId === id1 && c.targetEntityId === id2) || (c.entityId === id2 && c.targetEntityId === id1)),
    );

    if (existing) {
      set({
        document: updateActiveSketch(document, () => ({
          constraints: sketch.constraints.filter((c) => c.id !== existing.id),
        })),
      });
    } else {
      const proposed: Constraint = { id: crypto.randomUUID(), type: 'equal', entityId: id1, targetEntityId: id2 };
      const validation = validateConstraint(proposed, sketch.constraints, sketch.entities);
      if (!validation.valid) return;

      const newConstraints = [...sketch.constraints, proposed];
      const solved = solveConstraints(sketch.entities, newConstraints, { movedIds: new Set([id1]) });
      set({
        document: updateActiveSketch(document, () => ({
          constraints: newConstraints,
          entities: solved.entities,
        })),
      });
    }
  },

  toggleCoincident(entityIds) {
    if (entityIds.length !== 2) return;
    const { document } = get();
    const sketch = document.sketches.find((sk) => sk.id === document.activeSketchId);
    if (!sketch) return;

    const [id1, id2] = entityIds as [string, string];
    const e1 = sketch.entities.find((e) => e.id === id1);
    const e2 = sketch.entities.find((e) => e.id === id2);
    if (!e1 || !e2) return;
    if (e1.type === 'dimension' || e2.type === 'dimension') return;

    // Check if a coincident constraint already exists between these two
    const existing = sketch.constraints.find((c) =>
      c.type === 'coincident' &&
      ((c.entityId === id1 && c.targetEntityId === id2) || (c.entityId === id2 && c.targetEntityId === id1)),
    );

    if (existing) {
      set({
        document: updateActiveSketch(document, () => ({
          constraints: sketch.constraints.filter((c) => c.id !== existing.id),
        })),
      });
    } else {
      // Find closest pair of characteristic points
      const pts1 = getEntityPoints(e1);
      const pts2 = getEntityPoints(e2);
      if (pts1.length === 0 || pts2.length === 0) return;

      let bestDist = Infinity;
      let bestI = 0;
      let bestJ = 0;
      for (const [i, p1] of pts1) {
        for (const [j, p2] of pts2) {
          const d = (p1.x - p2.x) ** 2 + (p1.y - p2.y) ** 2;
          if (d < bestDist) {
            bestDist = d;
            bestI = i;
            bestJ = j;
          }
        }
      }

      // Snap e2's point to e1's point
      const sourcePoint = getEntityPoint(e1, bestI)!;
      const snapped = setEntityPoint(e2, bestJ, sourcePoint);
      const proposed: Constraint = {
        id: crypto.randomUUID(),
        type: 'coincident',
        entityId: id1,
        pointIndex: bestI,
        targetEntityId: id2,
        targetPointIndex: bestJ,
      };

      const newConstraints = [...sketch.constraints, proposed];
      const snappedEntities = snapped
        ? sketch.entities.map((e) => (e.id === id2 ? snapped : e))
        : sketch.entities;
      const solved = solveConstraints(snappedEntities, newConstraints, { movedIds: new Set([id1]) });
      set({
        document: updateActiveSketch(document, () => ({
          constraints: newConstraints,
          entities: solved.entities,
        })),
      });
    }
  },

  toggleCoincidentWithPoints(pt1, pt2) {
    const { document } = get();
    const sketch = document.sketches.find((sk) => sk.id === document.activeSketchId);
    if (!sketch) return;

    const e1 = sketch.entities.find((e) => e.id === pt1.entityId);
    const e2 = sketch.entities.find((e) => e.id === pt2.entityId);
    if (!e1 || !e2) return;
    if (e1.type === 'dimension' || e2.type === 'dimension') return;

    // Check if a coincident constraint already exists between these two entities
    const existing = sketch.constraints.find((c) =>
      c.type === 'coincident' &&
      ((c.entityId === pt1.entityId && c.targetEntityId === pt2.entityId) ||
       (c.entityId === pt2.entityId && c.targetEntityId === pt1.entityId)),
    );

    if (existing) {
      set({
        document: updateActiveSketch(document, () => ({
          constraints: sketch.constraints.filter((c) => c.id !== existing.id),
        })),
      });
    } else {
      const sourcePoint = getEntityPoint(e1, pt1.pointIndex);
      if (!sourcePoint) return;
      const snapped = setEntityPoint(e2, pt2.pointIndex, sourcePoint);
      const proposed: Constraint = {
        id: crypto.randomUUID(),
        type: 'coincident',
        entityId: pt1.entityId,
        pointIndex: pt1.pointIndex,
        targetEntityId: pt2.entityId,
        targetPointIndex: pt2.pointIndex,
      };

      const newConstraints = [...sketch.constraints, proposed];
      const snappedEntities = snapped
        ? sketch.entities.map((e) => (e.id === pt2.entityId ? snapped : e))
        : sketch.entities;
      const solved = solveConstraints(snappedEntities, newConstraints, { movedIds: new Set([pt1.entityId]) });
      set({
        document: updateActiveSketch(document, () => ({
          constraints: newConstraints,
          entities: solved.entities,
        })),
      });
    }
  },

  toggleMidpoint(point, segment) {
    const { document } = get();
    const sketch = document.sketches.find((sk) => sk.id === document.activeSketchId);
    if (!sketch) return;

    const existing = sketch.constraints.find((c) =>
      c.type === 'midpoint' &&
      c.entityId === point.entityId &&
      c.pointIndex === point.pointIndex &&
      c.targetEntityId === segment.entityId &&
      c.segmentIndex === segment.segmentIndex,
    );

    if (existing) {
      set({
        document: updateActiveSketch(document, () => ({
          constraints: sketch.constraints.filter((c) => c.id !== existing.id),
        })),
      });
    } else {
      const proposed: Constraint = {
        id: crypto.randomUUID(),
        type: 'midpoint',
        entityId: point.entityId,
        pointIndex: point.pointIndex,
        targetEntityId: segment.entityId,
        segmentIndex: segment.segmentIndex,
      };

      const newConstraints = [...sketch.constraints, proposed];
      const solved = solveConstraints(sketch.entities, newConstraints);
      set({
        document: updateActiveSketch(document, () => ({
          constraints: newConstraints,
          entities: solved.entities,
        })),
      });
    }
  },

  toggleParallel(seg1, seg2) {
    const { document } = get();
    const sketch = document.sketches.find((sk) => sk.id === document.activeSketchId);
    if (!sketch) return;

    const existing = sketch.constraints.find((c) =>
      c.type === 'parallel' &&
      ((c.entityId === seg1.entityId && c.segmentIndex === seg1.segmentIndex &&
        c.targetEntityId === seg2.entityId && c.targetSegmentIndex === seg2.segmentIndex) ||
       (c.entityId === seg2.entityId && c.segmentIndex === seg2.segmentIndex &&
        c.targetEntityId === seg1.entityId && c.targetSegmentIndex === seg1.segmentIndex)),
    );

    if (existing) {
      set({
        document: updateActiveSketch(document, () => ({
          constraints: sketch.constraints.filter((c) => c.id !== existing.id),
        })),
      });
    } else {
      const proposed: Constraint = {
        id: crypto.randomUUID(),
        type: 'parallel',
        entityId: seg1.entityId,
        segmentIndex: seg1.segmentIndex,
        targetEntityId: seg2.entityId,
        targetSegmentIndex: seg2.segmentIndex,
      };

      const validation = validateConstraint(proposed, sketch.constraints, sketch.entities);
      if (!validation.valid) return;

      const newConstraints = [
        ...sketch.constraints.filter((c) => !validation.supersedes?.includes(c.id)),
        proposed,
      ];
      const solved = solveConstraints(sketch.entities, newConstraints);
      set({
        document: updateActiveSketch(document, () => ({
          constraints: newConstraints,
          entities: solved.entities,
        })),
      });
    }
  },

  togglePerpendicular(seg1, seg2) {
    const { document } = get();
    const sketch = document.sketches.find((sk) => sk.id === document.activeSketchId);
    if (!sketch) return;

    const existing = sketch.constraints.find((c) =>
      c.type === 'perpendicular' &&
      ((c.entityId === seg1.entityId && c.segmentIndex === seg1.segmentIndex &&
        c.targetEntityId === seg2.entityId && c.targetSegmentIndex === seg2.segmentIndex) ||
       (c.entityId === seg2.entityId && c.segmentIndex === seg2.segmentIndex &&
        c.targetEntityId === seg1.entityId && c.targetSegmentIndex === seg1.segmentIndex)),
    );

    if (existing) {
      set({
        document: updateActiveSketch(document, () => ({
          constraints: sketch.constraints.filter((c) => c.id !== existing.id),
        })),
      });
    } else {
      const proposed: Constraint = {
        id: crypto.randomUUID(),
        type: 'perpendicular',
        entityId: seg1.entityId,
        segmentIndex: seg1.segmentIndex,
        targetEntityId: seg2.entityId,
        targetSegmentIndex: seg2.segmentIndex,
      };

      const validation = validateConstraint(proposed, sketch.constraints, sketch.entities);
      if (!validation.valid) return;

      const newConstraints = [
        ...sketch.constraints.filter((c) => !validation.supersedes?.includes(c.id)),
        proposed,
      ];
      const solved = solveConstraints(sketch.entities, newConstraints);
      set({
        document: updateActiveSketch(document, () => ({
          constraints: newConstraints,
          entities: solved.entities,
        })),
      });
    }
  },

  toggleTangent(e1Id, seg1Idx, e2Id, seg2Idx) {
    const { document } = get();
    const sketch = document.sketches.find((sk) => sk.id === document.activeSketchId);
    if (!sketch) return;

    const existing = sketch.constraints.find((c) =>
      c.type === 'tangent' &&
      ((c.entityId === e1Id && c.segmentIndex === seg1Idx &&
        c.targetEntityId === e2Id && c.targetSegmentIndex === seg2Idx) ||
       (c.entityId === e2Id && c.segmentIndex === seg2Idx &&
        c.targetEntityId === e1Id && c.targetSegmentIndex === seg1Idx)),
    );

    if (existing) {
      set({
        document: updateActiveSketch(document, () => ({
          constraints: sketch.constraints.filter((c) => c.id !== existing.id),
        })),
      });
    } else {
      const proposed: Constraint = {
        id: crypto.randomUUID(),
        type: 'tangent',
        entityId: e1Id,
        segmentIndex: seg1Idx,
        targetEntityId: e2Id,
        targetSegmentIndex: seg2Idx,
      };

      const newConstraints = [...sketch.constraints, proposed];
      const solved = solveConstraints(sketch.entities, newConstraints);
      set({
        document: updateActiveSketch(document, () => ({
          constraints: newConstraints,
          entities: solved.entities,
        })),
      });
    }
  },

  toggleBisect(seg1, seg2) {
    const { document } = get();
    const sketch = document.sketches.find((sk) => sk.id === document.activeSketchId);
    if (!sketch) return;

    const existing = sketch.constraints.find((c) =>
      c.type === 'bisect' &&
      ((c.entityId === seg1.entityId && c.segmentIndex === seg1.segmentIndex &&
        c.targetEntityId === seg2.entityId && c.targetSegmentIndex === seg2.segmentIndex) ||
       (c.entityId === seg2.entityId && c.segmentIndex === seg2.segmentIndex &&
        c.targetEntityId === seg1.entityId && c.targetSegmentIndex === seg1.segmentIndex)),
    );

    if (existing) {
      set({
        document: updateActiveSketch(document, () => ({
          constraints: sketch.constraints.filter((c) => c.id !== existing.id),
        })),
      });
    } else {
      // seg1 = bisecting line, seg2 = line being bisected
      const proposed: Constraint = {
        id: crypto.randomUUID(),
        type: 'bisect',
        entityId: seg1.entityId,
        segmentIndex: seg1.segmentIndex,
        targetEntityId: seg2.entityId,
        targetSegmentIndex: seg2.segmentIndex,
      };

      const validation = validateConstraint(proposed, sketch.constraints, sketch.entities);
      if (!validation.valid) return;

      const newConstraints = [
        ...sketch.constraints.filter((c) => !validation.supersedes?.includes(c.id)),
        proposed,
      ];
      const solved = solveConstraints(sketch.entities, newConstraints);
      set({
        document: updateActiveSketch(document, () => ({
          constraints: newConstraints,
          entities: solved.entities,
        })),
      });
    }
  },

  toggleHorizontal(entityIds, segments) {
    const { document } = get();
    const sketch = document.sketches.find((sk) => sk.id === document.activeSketchId);
    if (!sketch) return;

    for (const entityId of entityIds) {
      const entity = sketch.entities.find((e) => e.id === entityId);
      if (!entity || entity.type !== 'line') continue;

      const targetSegIndices = segments
        ? segments.filter((s) => s.entityId === entityId).map((s) => s.segmentIndex)
        : undefined;

      const segCount = entity.points.length - 1;
      const existing = sketch.constraints.filter(
        (c) => c.type === 'horizontal' && c.entityId === entityId,
      );

      if (targetSegIndices && targetSegIndices.length > 0) {
        const existingForTarget = existing.filter((c) =>
          targetSegIndices.includes((c as HorizontalConstraint).segmentIndex),
        );
        if (existingForTarget.length >= targetSegIndices.length) {
          // Remove horizontal constraints for these specific segments
          const removeIds = new Set(existingForTarget.map((c) => c.id));
          set((s) => ({
            document: updateActiveSketch(s.document, (sk2) => ({
              constraints: sk2.constraints.filter((c) => !removeIds.has(c.id)),
            })),
          }));
        } else {
          const constrainedSegs = new Set(existing.map((c) => (c as HorizontalConstraint).segmentIndex));
          const newConstraints: Constraint[] = [];
          const supersededIds: string[] = [];

          for (const i of targetSegIndices) {
            if (constrainedSegs.has(i)) continue;
            const proposed: Constraint = {
              id: crypto.randomUUID(),
              type: 'horizontal' as const,
              entityId,
              segmentIndex: i,
            };
            const validation = validateConstraint(proposed, sketch.constraints, sketch.entities);
            if (!validation.valid) continue;
            newConstraints.push(proposed);
            if (validation.supersedes) supersededIds.push(...validation.supersedes);
          }
          if (newConstraints.length === 0) continue;

          const supersededSet = new Set(supersededIds);
          const allConstraints = [
            ...sketch.constraints.filter((c) => !supersededSet.has(c.id)),
            ...newConstraints,
          ];
          const solved = solveConstraints(sketch.entities, allConstraints);
          set((s) => ({
            document: updateActiveSketch(s.document, () => ({
              constraints: allConstraints,
              entities: solved.entities,
            })),
          }));
        }
      } else if (existing.length > 0) {
        // Toggle off: remove all horizontal constraints for this entity
        set((s) => ({
          document: updateActiveSketch(s.document, (sk2) => ({
            constraints: sk2.constraints.filter((c) => !(c.type === 'horizontal' && c.entityId === entityId)),
          })),
        }));
      } else {
        // Add horizontal constraints for all eligible segments
        const newConstraints: Constraint[] = [];
        const supersededIds: string[] = [];
        for (let i = 0; i < segCount; i++) {
          const proposed: Constraint = {
            id: crypto.randomUUID(),
            type: 'horizontal' as const,
            entityId,
            segmentIndex: i,
          };
          const validation = validateConstraint(proposed, sketch.constraints, sketch.entities);
          if (!validation.valid) continue;
          newConstraints.push(proposed);
          if (validation.supersedes) supersededIds.push(...validation.supersedes);
        }
        if (newConstraints.length === 0) continue;

        const supersededSet = new Set(supersededIds);
        const allConstraints = [
          ...sketch.constraints.filter((c) => !supersededSet.has(c.id)),
          ...newConstraints,
        ];
        const solved = solveConstraints(sketch.entities, allConstraints);
        set((s) => ({
          document: updateActiveSketch(s.document, () => ({
            constraints: allConstraints,
            entities: solved.entities,
          })),
        }));
      }
    }
  },

  toggleVertical(entityIds, segments) {
    const { document } = get();
    const sketch = document.sketches.find((sk) => sk.id === document.activeSketchId);
    if (!sketch) return;

    for (const entityId of entityIds) {
      const entity = sketch.entities.find((e) => e.id === entityId);
      if (!entity || entity.type !== 'line') continue;

      const targetSegIndices = segments
        ? segments.filter((s) => s.entityId === entityId).map((s) => s.segmentIndex)
        : undefined;

      const segCount = entity.points.length - 1;
      const existing = sketch.constraints.filter(
        (c) => c.type === 'vertical' && c.entityId === entityId,
      );

      if (targetSegIndices && targetSegIndices.length > 0) {
        const existingForTarget = existing.filter((c) =>
          targetSegIndices.includes((c as VerticalConstraint).segmentIndex),
        );
        if (existingForTarget.length >= targetSegIndices.length) {
          // Remove vertical constraints for these specific segments
          const removeIds = new Set(existingForTarget.map((c) => c.id));
          set((s) => ({
            document: updateActiveSketch(s.document, (sk2) => ({
              constraints: sk2.constraints.filter((c) => !removeIds.has(c.id)),
            })),
          }));
        } else {
          const constrainedSegs = new Set(existing.map((c) => (c as VerticalConstraint).segmentIndex));
          const newConstraints: Constraint[] = [];
          const supersededIds: string[] = [];

          for (const i of targetSegIndices) {
            if (constrainedSegs.has(i)) continue;
            const proposed: Constraint = {
              id: crypto.randomUUID(),
              type: 'vertical' as const,
              entityId,
              segmentIndex: i,
            };
            const validation = validateConstraint(proposed, sketch.constraints, sketch.entities);
            if (!validation.valid) continue;
            newConstraints.push(proposed);
            if (validation.supersedes) supersededIds.push(...validation.supersedes);
          }
          if (newConstraints.length === 0) continue;

          const supersededSet = new Set(supersededIds);
          const allConstraints = [
            ...sketch.constraints.filter((c) => !supersededSet.has(c.id)),
            ...newConstraints,
          ];
          const solved = solveConstraints(sketch.entities, allConstraints);
          set((s) => ({
            document: updateActiveSketch(s.document, () => ({
              constraints: allConstraints,
              entities: solved.entities,
            })),
          }));
        }
      } else if (existing.length > 0) {
        // Toggle off: remove all vertical constraints for this entity
        set((s) => ({
          document: updateActiveSketch(s.document, (sk2) => ({
            constraints: sk2.constraints.filter((c) => !(c.type === 'vertical' && c.entityId === entityId)),
          })),
        }));
      } else {
        // Add vertical constraints for all eligible segments
        const newConstraints: Constraint[] = [];
        const supersededIds: string[] = [];
        for (let i = 0; i < segCount; i++) {
          const proposed: Constraint = {
            id: crypto.randomUUID(),
            type: 'vertical' as const,
            entityId,
            segmentIndex: i,
          };
          const validation = validateConstraint(proposed, sketch.constraints, sketch.entities);
          if (!validation.valid) continue;
          newConstraints.push(proposed);
          if (validation.supersedes) supersededIds.push(...validation.supersedes);
        }
        if (newConstraints.length === 0) continue;

        const supersededSet = new Set(supersededIds);
        const allConstraints = [
          ...sketch.constraints.filter((c) => !supersededSet.has(c.id)),
          ...newConstraints,
        ];
        const solved = solveConstraints(sketch.entities, allConstraints);
        set((s) => ({
          document: updateActiveSketch(s.document, () => ({
            constraints: allConstraints,
            entities: solved.entities,
          })),
        }));
      }
    }
  },

  updateEntity(entityId, updatedEntity) {
    const { document } = get();
    const sketch = document.sketches.find((sk) => sk.id === document.activeSketchId);
    if (!sketch) return;

    const updatedEntities = sketch.entities.map((e) =>
      e.id === entityId ? updatedEntity : e,
    );
    const solved = solveConstraints(updatedEntities, sketch.constraints, { movedIds: new Set([entityId]) });
    set({
      document: updateActiveSketch(document, () => ({
        entities: solved.entities,
      })),
    });
  },

  applyDimensionValue(dimensionId, newValue) {
    const { document } = get();
    const sketch = document.sketches.find((sk) => sk.id === document.activeSketchId);
    if (!sketch) return;
    const dim = sketch.entities.find((e) => e.id === dimensionId);
    if (!dim || dim.type !== 'dimension') return;

    // Reject edits on derived (driven) dimensions
    const derivedIds = computeDerivedDimensionIds(sketch.entities, sketch.constraints);
    if (derivedIds.has(dim.id)) return;

    const target = sketch.entities.find((e) => e.id === dim.targetEntityId);
    if (!target) return;

    // Two-segment dimension (distance or angle)
    if (dim.targetEntityId2 != null) {
      const target2 = sketch.entities.find((e) => e.id === dim.targetEntityId2);
      if (!target2 || target.type !== 'line' || target2.type !== 'line') return;
      const idx1 = dim.segmentIndex;
      const idx2 = dim.segmentIndex2!;
      if (idx1 < 0 || idx1 >= target.points.length - 1) return;
      if (idx2 < 0 || idx2 >= target2.points.length - 1) return;
      const p1 = target.points[idx1]!;
      const p2 = target.points[idx1 + 1]!;
      const q1 = target2.points[idx2]!;
      const q2 = target2.points[idx2 + 1]!;

      // Angle dimension: rotate segments to match new angle
      if (dim.angleMode) {
        const ix = lineLineIntersection(p1, p2, q1, q2);
        if (!ix) return;

        // Direction vectors oriented toward each segment's midpoint (away from intersection)
        const mid1x = (p1.x + p2.x) / 2 - ix.x;
        const mid1y = (p1.y + p2.y) / 2 - ix.y;
        const mid2x = (q1.x + q2.x) / 2 - ix.x;
        const mid2y = (q1.y + q2.y) / 2 - ix.y;
        const startAngle = Math.atan2(mid1y, mid1x);
        const endAngle = Math.atan2(mid2y, mid2x);
        let sweep = endAngle - startAngle;
        while (sweep > Math.PI) sweep -= 2 * Math.PI;
        while (sweep < -Math.PI) sweep += 2 * Math.PI;
        const currentAngleDeg = Math.abs(sweep) * 180 / Math.PI;
        const deltaRad = (newValue - currentAngleDeg) * Math.PI / 180;
        // Preserve the sign of sweep for rotation direction
        const signedDelta = sweep >= 0 ? deltaRad : -deltaRad;

        const target1Fixed = sketch.constraints.some((c) => c.type === 'fixed' && c.entityId === target.id);
        const target2Fixed = sketch.constraints.some((c) => c.type === 'fixed' && c.entityId === target2.id);
        if (target1Fixed && target2Fixed) return;

        // Symmetric rotation: each segment rotates half the delta around intersection
        let rot1 = -signedDelta / 2;
        let rot2 = signedDelta / 2;
        if (target1Fixed) { rot1 = 0; rot2 = signedDelta; }
        if (target2Fixed) { rot2 = 0; rot1 = -signedDelta; }

        get().beginTransaction();

        const movedIds = new Set<string>();
        const updatedEntities = sketch.entities.map((e) => {
          if (e.type !== 'line') return e;
          if ('sourceId' in e && e.sourceId) return e;

          if (e.id === target.id && rot1 !== 0) {
            movedIds.add(e.id);
            return {
              ...e,
              points: e.points.map((pt, i) =>
                (i === idx1 || i === idx1 + 1) ? rotatePoint(pt, ix, rot1) : pt,
              ),
            };
          }
          if (e.id === target2.id && rot2 !== 0) {
            movedIds.add(e.id);
            return {
              ...e,
              points: e.points.map((pt, i) =>
                (i === idx2 || i === idx2 + 1) ? rotatePoint(pt, ix, rot2) : pt,
              ),
            };
          }
          return e;
        });
        const solved = solveConstraints(updatedEntities, sketch.constraints, { movedIds });
        set({
          document: updateActiveSketch(document, () => ({
            entities: solved.entities,
          })),
        });
        return;
      }

      const a = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
      const dx = q2.x - q1.x;
      const dy = q2.y - q1.y;
      const lenSq = dx * dx + dy * dy;
      if (lenSq === 0) return;
      const t = ((a.x - q1.x) * dx + (a.y - q1.y) * dy) / lenSq;
      const b = { x: q1.x + t * dx, y: q1.y + t * dy };
      const dist = Math.sqrt((b.x - a.x) ** 2 + (b.y - a.y) ** 2);
      if (dist === 0) return;
      // Direction from target1's segment toward target2's segment
      const nx = (b.x - a.x) / dist;
      const ny = (b.y - a.y) / dist;
      const delta = newValue - dist;

      const target1Fixed = sketch.constraints.some((c) => c.type === 'fixed' && c.entityId === target.id);
      const target2Fixed = sketch.constraints.some((c) => c.type === 'fixed' && c.entityId === target2.id);
      if (target1Fixed && target2Fixed) return;

      // Split movement symmetrically; if one is fixed the other takes the full delta
      // target1 moves in -n direction (away from target2), target2 moves in +n direction
      let move1 = -delta / 2;
      let move2 = delta / 2;
      if (target1Fixed) { move1 = 0; move2 = delta; }
      if (target2Fixed) { move2 = 0; move1 = -delta; }

      get().beginTransaction();

      const movedIds = new Set<string>();
      const updatedEntities = sketch.entities.map((e) => {
        if (e.type !== 'line') return e;
        if ('sourceId' in e && e.sourceId) return e;

        // Only move the referenced segment's endpoints, not the whole entity
        if (e.id === target.id && move1 !== 0) {
          movedIds.add(e.id);
          return {
            ...e,
            points: e.points.map((pt, i) =>
              (i === idx1 || i === idx1 + 1)
                ? { x: pt.x + nx * move1, y: pt.y + ny * move1 }
                : pt,
            ),
          };
        }
        if (e.id === target2.id && move2 !== 0) {
          movedIds.add(e.id);
          return {
            ...e,
            points: e.points.map((pt, i) =>
              (i === idx2 || i === idx2 + 1)
                ? { x: pt.x + nx * move2, y: pt.y + ny * move2 }
                : pt,
            ),
          };
        }
        return e;
      });
      const solved = solveConstraints(updatedEntities, sketch.constraints, { movedIds });
      set({
        document: updateActiveSketch(document, () => ({
          entities: solved.entities,
        })),
      });
      return;
    }

    if ('sourceId' in target && target.sourceId) return; // locked

    get().beginTransaction();

    const updatedEntities = sketch.entities.map((e) => {
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
        // Polygon segment dimension: scale uniformly to preserve regularity
        if (e.polygonCenter) {
          const idx = dim.segmentIndex;
          if (idx < 0 || idx >= e.points.length - 1) return e;
          const pa = e.points[idx]!;
          const pb = e.points[idx + 1]!;
          const curLen = Math.sqrt((pb.x - pa.x) ** 2 + (pb.y - pa.y) ** 2);
          if (curLen === 0) return e;
          const scale = newValue / curLen;
          const center = e.polygonCenter;
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
    });

    const solved = solveConstraints(updatedEntities, sketch.constraints, { movedIds: new Set([target.id]) });
    set({
      document: updateActiveSketch(document, () => ({
        entities: solved.entities,
      })),
    });
  },

  getActiveSketch() {
    const { document } = get();
    return document.sketches.find((sk) => sk.id === document.activeSketchId);
  },
}));
