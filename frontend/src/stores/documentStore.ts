import { create } from 'zustand';
import type { Document, Entity, Point, Sketch, Constraint, EqualConstraint, CoincidentConstraint, HorizontalConstraint, VerticalConstraint, LineEntity } from '@/types/document';
import { createEmptyDocument, createEmptySketch } from '@/utils/document';
import { createMirroredEntity, createRotatedEntity, createTranslatedEntity, propagateDerived } from '@/utils/propagate';
import { rotatePoint } from '@/utils/geometry';
import { getEntityPoint, setEntityPoint, getEntityPoints } from '@/utils/entityPoints';
import type { SelectedPoint } from '@/stores/editorStore';

const UNDO_STACK_LIMIT = 100;

/** Make target entity's size match source entity's size. Returns null if incompatible. */
function matchEntitySize(target: Entity, source: Entity): Entity | null {
  if (target.type !== source.type) return null;

  if (source.type === 'circle' && target.type === 'circle') {
    return { ...target, radius: source.radius };
  }

  if (source.type === 'rectangle' && target.type === 'rectangle') {
    return { ...target, width: source.width, height: source.height };
  }

  if (source.type === 'line' && target.type === 'line') {
    // Polygons: scale apothem to match
    if (source.polygonCenter && target.polygonCenter) {
      const srcMid = { x: (source.points[0]!.x + source.points[1]!.x) / 2, y: (source.points[0]!.y + source.points[1]!.y) / 2 };
      const srcApothem = Math.sqrt((srcMid.x - source.polygonCenter.x) ** 2 + (srcMid.y - source.polygonCenter.y) ** 2);
      const tgtMid = { x: (target.points[0]!.x + target.points[1]!.x) / 2, y: (target.points[0]!.y + target.points[1]!.y) / 2 };
      const tgtApothem = Math.sqrt((tgtMid.x - target.polygonCenter.x) ** 2 + (tgtMid.y - target.polygonCenter.y) ** 2);
      if (tgtApothem === 0) return null;
      const scale = srcApothem / tgtApothem;
      const center = target.polygonCenter;
      return { ...target, points: target.points.map((p) => ({ x: center.x + (p.x - center.x) * scale, y: center.y + (p.y - center.y) * scale })) };
    }

    // Regular lines: scale total length around centroid
    let srcLen = 0;
    for (let i = 0; i < source.points.length - 1; i++) {
      srcLen += Math.sqrt((source.points[i + 1]!.x - source.points[i]!.x) ** 2 + (source.points[i + 1]!.y - source.points[i]!.y) ** 2);
    }
    let tgtLen = 0;
    for (let i = 0; i < target.points.length - 1; i++) {
      tgtLen += Math.sqrt((target.points[i + 1]!.x - target.points[i]!.x) ** 2 + (target.points[i + 1]!.y - target.points[i]!.y) ** 2);
    }
    if (tgtLen === 0) return null;
    const scale = srcLen / tgtLen;
    const cx = target.points.reduce((s, p) => s + p.x, 0) / target.points.length;
    const cy = target.points.reduce((s, p) => s + p.y, 0) / target.points.length;
    return { ...target, points: target.points.map((p) => ({ x: cx + (p.x - cx) * scale, y: cy + (p.y - cy) * scale })) };
  }

  return null;
}

/** Propagate equal constraints outward from a modified entity using BFS. */
function enforceEqual(entities: Entity[], constraints: Constraint[], modifiedId: string): Entity[] {
  const equalConstraints = constraints.filter((c): c is EqualConstraint => c.type === 'equal');
  if (equalConstraints.length === 0) return entities;

  const entityMap = new Map(entities.map((e) => [e.id, e]));
  const visited = new Set([modifiedId]);
  const queue = [modifiedId];

  while (queue.length > 0) {
    const currentId = queue.shift()!;
    const current = entityMap.get(currentId);
    if (!current) continue;

    for (const c of equalConstraints) {
      let otherId: string | null = null;
      if (c.entityId === currentId) otherId = c.targetEntityId;
      else if (c.targetEntityId === currentId) otherId = c.entityId;
      if (!otherId || visited.has(otherId)) continue;

      visited.add(otherId);
      queue.push(otherId);

      const other = entityMap.get(otherId);
      if (!other) continue;

      const adjusted = matchEntitySize(other, current);
      if (adjusted) entityMap.set(otherId, adjusted);
    }
  }

  return entities.map((e) => entityMap.get(e.id) ?? e);
}

/** Check if a constraint references any of the given entity IDs. */
function constraintReferencesAny(c: Constraint, idSet: Set<string>): boolean {
  if (idSet.has(c.entityId)) return true;
  if ('targetEntityId' in c && idSet.has(c.targetEntityId)) return true;
  return false;
}


/** Enforce coincident constraints via BFS from modified entities. */
function enforceCoincident(entities: Entity[], constraints: Constraint[], movedIds: Set<string>): Entity[] {
  const coincidentConstraints = constraints.filter((c): c is CoincidentConstraint => c.type === 'coincident');
  if (coincidentConstraints.length === 0) return entities;

  const entityMap = new Map(entities.map((e) => [e.id, e]));
  const processed = new Set<string>();
  const queue = [...movedIds];
  const visited = new Set(movedIds);

  while (queue.length > 0) {
    const currentId = queue.shift()!;

    for (const c of coincidentConstraints) {
      if (processed.has(c.id)) continue;

      let sourceId: string;
      let sourcePointIdx: number;
      let targetId: string;
      let targetPointIdx: number;

      if (c.entityId === currentId) {
        sourceId = c.entityId;
        sourcePointIdx = c.pointIndex;
        targetId = c.targetEntityId;
        targetPointIdx = c.targetPointIndex;
      } else if (c.targetEntityId === currentId) {
        sourceId = c.targetEntityId;
        sourcePointIdx = c.targetPointIndex;
        targetId = c.entityId;
        targetPointIdx = c.pointIndex;
      } else {
        continue;
      }

      if (visited.has(targetId)) continue;
      processed.add(c.id);

      const source = entityMap.get(sourceId);
      const target = entityMap.get(targetId);
      if (!source || !target) continue;

      const pt = getEntityPoint(source, sourcePointIdx);
      if (!pt) continue;

      const updated = setEntityPoint(target, targetPointIdx, pt);
      if (updated) {
        entityMap.set(targetId, updated);
        visited.add(targetId);
        queue.push(targetId);
      }
    }
  }

  return entities.map((e) => entityMap.get(e.id) ?? e);
}

/** Rotate a polygon so that the segment at segmentIndex becomes horizontal or vertical. */
function snapPolygonForHV(entity: LineEntity, segmentIndex: number, type: 'horizontal' | 'vertical'): LineEntity {
  if (!entity.polygonCenter) return entity;
  const pa = entity.points[segmentIndex]!;
  const pb = entity.points[segmentIndex + 1]!;
  const dx = pb.x - pa.x;
  const dy = pb.y - pa.y;
  const currentAngle = Math.atan2(dy, dx);

  let targetAngle: number;
  if (type === 'horizontal') {
    // Snap to nearest multiple of π (0 or ±π)
    targetAngle = Math.round(currentAngle / Math.PI) * Math.PI;
  } else {
    // Snap to nearest π/2 + nπ (±π/2)
    targetAngle = Math.round((currentAngle - Math.PI / 2) / Math.PI) * Math.PI + Math.PI / 2;
  }

  const rotation = targetAngle - currentAngle;
  if (Math.abs(rotation) < 1e-9) return entity;

  const center = entity.polygonCenter;
  return {
    ...entity,
    points: entity.points.map((p) => rotatePoint(p, center, rotation)),
  };
}

/** Enforce horizontal/vertical constraints on line segments. */
function enforceHorizontalVertical(entities: Entity[], constraints: Constraint[]): Entity[] {
  const hvConstraints = constraints.filter(
    (c): c is HorizontalConstraint | VerticalConstraint => c.type === 'horizontal' || c.type === 'vertical',
  );
  if (hvConstraints.length === 0) return entities;

  const entityMap = new Map(entities.map((e) => [e.id, e]));

  for (const c of hvConstraints) {
    const entity = entityMap.get(c.entityId);
    if (!entity || entity.type !== 'line') continue;
    const idx = c.segmentIndex;
    if (idx < 0 || idx >= entity.points.length - 1) continue;

    if ((entity as LineEntity).polygonCenter) {
      // Rotate the entire polygon to satisfy the constraint
      entityMap.set(c.entityId, snapPolygonForHV(entity as LineEntity, idx, c.type));
    } else {
      const pa = entity.points[idx]!;
      const pb = entity.points[idx + 1]!;
      const newPoints = [...entity.points];
      if (c.type === 'horizontal') {
        newPoints[idx + 1] = { x: pb.x, y: pa.y };
      } else {
        newPoints[idx + 1] = { x: pa.x, y: pb.y };
      }
      entityMap.set(c.entityId, { ...entity, points: newPoints } as LineEntity);
    }
  }

  return entities.map((e) => entityMap.get(e.id) ?? e);
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
  toggleHorizontal(entityIds: string[], segments?: {entityId: string, segmentIndex: number}[]): void;
  toggleVertical(entityIds: string[], segments?: {entityId: string, segmentIndex: number}[]): void;

  // Entity replacement
  updateEntity(entityId: string, updatedEntity: Entity): void;

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
                entities: propagateDerived(enforceHorizontalVertical(enforceCoincident(sk.entities.map((e) => {
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
                }), sk.constraints, idSet), sk.constraints)),
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
                entities: propagateDerived(enforceHorizontalVertical(enforceCoincident(sk.entities.map((e) => {
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
                }), sk.constraints, new Set([entityId])), sk.constraints)),
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
                entities: propagateDerived(enforceHorizontalVertical(enforceCoincident(sk.entities.map((e) => {
                  if (e.id !== entityId || e.type !== 'line') return e;
                  if (e.sourceId) return e; // locked
                  if (!e.polygonCenter) return e;
                  const center = e.polygonCenter;
                  return {
                    ...e,
                    points: e.points.map((p) => rotatePoint(p, center, angleDelta)),
                  };
                }), sk.constraints, new Set([entityId])), sk.constraints)),
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
    const e1 = sketch.entities.find((e) => e.id === id1);
    const e2 = sketch.entities.find((e) => e.id === id2);
    if (!e1 || !e2) return;

    // Must be same geometric type, no points or dimensions
    if (e1.type !== e2.type) return;
    if (e1.type === 'dimension' || e1.type === 'point') return;

    // Check if constraint already exists between these two
    const existing = sketch.constraints.find((c) =>
      c.type === 'equal' &&
      ((c.entityId === id1 && c.targetEntityId === id2) || (c.entityId === id2 && c.targetEntityId === id1)),
    );

    if (existing) {
      // Remove it
      set({
        document: {
          ...document,
          sketches: document.sketches.map((sk) =>
            sk.id === document.activeSketchId
              ? { ...sk, constraints: sk.constraints.filter((c) => c.id !== existing.id) }
              : sk,
          ),
        },
      });
    } else {
      // Add constraint and snap target to match source
      const constraint: Constraint = { id: crypto.randomUUID(), type: 'equal', entityId: id1, targetEntityId: id2 };
      const snapped = matchEntitySize(e2, e1);
      set({
        document: {
          ...document,
          sketches: document.sketches.map((sk) =>
            sk.id === document.activeSketchId
              ? {
                  ...sk,
                  constraints: [...sk.constraints, constraint],
                  entities: snapped
                    ? propagateDerived(sk.entities.map((e) => (e.id === id2 ? snapped : e)))
                    : sk.entities,
                }
              : sk,
          ),
        },
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
      // Remove it
      set({
        document: {
          ...document,
          sketches: document.sketches.map((sk) =>
            sk.id === document.activeSketchId
              ? { ...sk, constraints: sk.constraints.filter((c) => c.id !== existing.id) }
              : sk,
          ),
        },
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
      const constraint: Constraint = {
        id: crypto.randomUUID(),
        type: 'coincident',
        entityId: id1,
        pointIndex: bestI,
        targetEntityId: id2,
        targetPointIndex: bestJ,
      };

      set({
        document: {
          ...document,
          sketches: document.sketches.map((sk) =>
            sk.id === document.activeSketchId
              ? {
                  ...sk,
                  constraints: [...sk.constraints, constraint],
                  entities: snapped
                    ? propagateDerived(sk.entities.map((e) => (e.id === id2 ? snapped : e)))
                    : sk.entities,
                }
              : sk,
          ),
        },
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
        document: {
          ...document,
          sketches: document.sketches.map((sk) =>
            sk.id === document.activeSketchId
              ? { ...sk, constraints: sk.constraints.filter((c) => c.id !== existing.id) }
              : sk,
          ),
        },
      });
    } else {
      const sourcePoint = getEntityPoint(e1, pt1.pointIndex);
      if (!sourcePoint) return;
      const snapped = setEntityPoint(e2, pt2.pointIndex, sourcePoint);
      const constraint: Constraint = {
        id: crypto.randomUUID(),
        type: 'coincident',
        entityId: pt1.entityId,
        pointIndex: pt1.pointIndex,
        targetEntityId: pt2.entityId,
        targetPointIndex: pt2.pointIndex,
      };

      set({
        document: {
          ...document,
          sketches: document.sketches.map((sk) =>
            sk.id === document.activeSketchId
              ? {
                  ...sk,
                  constraints: [...sk.constraints, constraint],
                  entities: snapped
                    ? propagateDerived(sk.entities.map((e) => (e.id === pt2.entityId ? snapped : e)))
                    : sk.entities,
                }
              : sk,
          ),
        },
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

      // Determine which segment indices to operate on
      const targetSegIndices = segments
        ? segments.filter((s) => s.entityId === entityId).map((s) => s.segmentIndex)
        : undefined;

      const segCount = entity.points.length - 1;
      const existing = sketch.constraints.filter(
        (c) => c.type === 'horizontal' && c.entityId === entityId,
      );

      if (targetSegIndices && targetSegIndices.length > 0) {
        // Segment-scoped: toggle only the specified segments
        const existingForTarget = existing.filter((c) =>
          targetSegIndices.includes((c as HorizontalConstraint).segmentIndex),
        );
        if (existingForTarget.length >= targetSegIndices.length) {
          // Remove horizontal constraints for these specific segments
          const removeIds = new Set(existingForTarget.map((c) => c.id));
          set((s) => ({
            document: {
              ...s.document,
              sketches: s.document.sketches.map((sk2) =>
                sk2.id === s.document.activeSketchId
                  ? { ...sk2, constraints: sk2.constraints.filter((c) => !removeIds.has(c.id)) }
                  : sk2,
              ),
            },
          }));
        } else {
          const constrainedSegs = new Set(existing.map((c) => (c as HorizontalConstraint).segmentIndex));
          const newConstraints: Constraint[] = [];
          let snappedEntity: Entity = entity;
          if ((entity as LineEntity).polygonCenter) {
            // Polygon: rotate to satisfy the first unconstrained target segment
            for (const i of targetSegIndices) {
              if (!constrainedSegs.has(i)) {
                snappedEntity = snapPolygonForHV(entity as LineEntity, i, 'horizontal');
                break;
              }
            }
          } else {
            const newPoints = [...entity.points];
            for (const i of targetSegIndices) {
              if (!constrainedSegs.has(i)) {
                newPoints[i + 1] = { x: newPoints[i + 1]!.x, y: newPoints[i]!.y };
              }
            }
            snappedEntity = { ...entity, points: newPoints };
          }
          for (const i of targetSegIndices) {
            if (!constrainedSegs.has(i)) {
              newConstraints.push({
                id: crypto.randomUUID(),
                type: 'horizontal' as const,
                entityId,
                segmentIndex: i,
              });
            }
          }
          set((s) => ({
            document: {
              ...s.document,
              sketches: s.document.sketches.map((sk2) =>
                sk2.id === s.document.activeSketchId
                  ? {
                      ...sk2,
                      constraints: [...sk2.constraints, ...newConstraints],
                      entities: propagateDerived(sk2.entities.map((e) => (e.id === entityId ? snappedEntity : e))),
                    }
                  : sk2,
              ),
            },
          }));
        }
      } else if (existing.length >= segCount) {
        // Remove all horizontal constraints for this entity
        set((s) => ({
          document: {
            ...s.document,
            sketches: s.document.sketches.map((sk2) =>
              sk2.id === s.document.activeSketchId
                ? { ...sk2, constraints: sk2.constraints.filter((c) => !(c.type === 'horizontal' && c.entityId === entityId)) }
                : sk2,
            ),
          },
        }));
      } else {
        // Add horizontal constraints for unconstrained segments and snap
        const constrainedSegs = new Set(existing.map((c) => (c as HorizontalConstraint).segmentIndex));
        const newConstraints: Constraint[] = [];
        let snappedEntity: Entity = entity;
        if ((entity as LineEntity).polygonCenter) {
          // Polygon: rotate to satisfy the first unconstrained segment
          for (let i = 0; i < segCount; i++) {
            if (!constrainedSegs.has(i)) {
              snappedEntity = snapPolygonForHV(entity as LineEntity, i, 'horizontal');
              break;
            }
          }
        } else {
          const newPoints = [...entity.points];
          for (let i = 0; i < segCount; i++) {
            if (!constrainedSegs.has(i)) {
              newPoints[i + 1] = { x: newPoints[i + 1]!.x, y: newPoints[i]!.y };
            }
          }
          snappedEntity = { ...entity, points: newPoints };
        }
        for (let i = 0; i < segCount; i++) {
          if (!constrainedSegs.has(i)) {
            newConstraints.push({
              id: crypto.randomUUID(),
              type: 'horizontal' as const,
              entityId,
              segmentIndex: i,
            });
          }
        }
        set((s) => ({
          document: {
            ...s.document,
            sketches: s.document.sketches.map((sk2) =>
              sk2.id === s.document.activeSketchId
                ? {
                    ...sk2,
                    constraints: [...sk2.constraints, ...newConstraints],
                    entities: propagateDerived(sk2.entities.map((e) => (e.id === entityId ? snappedEntity : e))),
                  }
                : sk2,
            ),
          },
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

      // Determine which segment indices to operate on
      const targetSegIndices = segments
        ? segments.filter((s) => s.entityId === entityId).map((s) => s.segmentIndex)
        : undefined;

      const segCount = entity.points.length - 1;
      const existing = sketch.constraints.filter(
        (c) => c.type === 'vertical' && c.entityId === entityId,
      );

      if (targetSegIndices && targetSegIndices.length > 0) {
        // Segment-scoped: toggle only the specified segments
        const existingForTarget = existing.filter((c) =>
          targetSegIndices.includes((c as VerticalConstraint).segmentIndex),
        );
        if (existingForTarget.length >= targetSegIndices.length) {
          // Remove vertical constraints for these specific segments
          const removeIds = new Set(existingForTarget.map((c) => c.id));
          set((s) => ({
            document: {
              ...s.document,
              sketches: s.document.sketches.map((sk2) =>
                sk2.id === s.document.activeSketchId
                  ? { ...sk2, constraints: sk2.constraints.filter((c) => !removeIds.has(c.id)) }
                  : sk2,
              ),
            },
          }));
        } else {
          const constrainedSegs = new Set(existing.map((c) => (c as VerticalConstraint).segmentIndex));
          const newConstraints: Constraint[] = [];
          let snappedEntity: Entity = entity;
          if ((entity as LineEntity).polygonCenter) {
            for (const i of targetSegIndices) {
              if (!constrainedSegs.has(i)) {
                snappedEntity = snapPolygonForHV(entity as LineEntity, i, 'vertical');
                break;
              }
            }
          } else {
            const newPoints = [...entity.points];
            for (const i of targetSegIndices) {
              if (!constrainedSegs.has(i)) {
                newPoints[i + 1] = { x: newPoints[i]!.x, y: newPoints[i + 1]!.y };
              }
            }
            snappedEntity = { ...entity, points: newPoints };
          }
          for (const i of targetSegIndices) {
            if (!constrainedSegs.has(i)) {
              newConstraints.push({
                id: crypto.randomUUID(),
                type: 'vertical' as const,
                entityId,
                segmentIndex: i,
              });
            }
          }
          set((s) => ({
            document: {
              ...s.document,
              sketches: s.document.sketches.map((sk2) =>
                sk2.id === s.document.activeSketchId
                  ? {
                      ...sk2,
                      constraints: [...sk2.constraints, ...newConstraints],
                      entities: propagateDerived(sk2.entities.map((e) => (e.id === entityId ? snappedEntity : e))),
                    }
                  : sk2,
              ),
            },
          }));
        }
      } else if (existing.length >= segCount) {
        // Remove all vertical constraints for this entity
        set((s) => ({
          document: {
            ...s.document,
            sketches: s.document.sketches.map((sk2) =>
              sk2.id === s.document.activeSketchId
                ? { ...sk2, constraints: sk2.constraints.filter((c) => !(c.type === 'vertical' && c.entityId === entityId)) }
                : sk2,
            ),
          },
        }));
      } else {
        // Add vertical constraints for unconstrained segments and snap
        const constrainedSegs = new Set(existing.map((c) => (c as VerticalConstraint).segmentIndex));
        const newConstraints: Constraint[] = [];
        let snappedEntity: Entity = entity;
        if ((entity as LineEntity).polygonCenter) {
          for (let i = 0; i < segCount; i++) {
            if (!constrainedSegs.has(i)) {
              snappedEntity = snapPolygonForHV(entity as LineEntity, i, 'vertical');
              break;
            }
          }
        } else {
          const newPoints = [...entity.points];
          for (let i = 0; i < segCount; i++) {
            if (!constrainedSegs.has(i)) {
              newPoints[i + 1] = { x: newPoints[i]!.x, y: newPoints[i + 1]!.y };
            }
          }
          snappedEntity = { ...entity, points: newPoints };
        }
        for (let i = 0; i < segCount; i++) {
          if (!constrainedSegs.has(i)) {
            newConstraints.push({
              id: crypto.randomUUID(),
              type: 'vertical' as const,
              entityId,
              segmentIndex: i,
            });
          }
        }
        set((s) => ({
          document: {
            ...s.document,
            sketches: s.document.sketches.map((sk2) =>
              sk2.id === s.document.activeSketchId
                ? {
                    ...sk2,
                    constraints: [...sk2.constraints, ...newConstraints],
                    entities: propagateDerived(sk2.entities.map((e) => (e.id === entityId ? snappedEntity : e))),
                  }
                : sk2,
            ),
          },
        }));
      }
    }
  },

  updateEntity(entityId, updatedEntity) {
    const { document } = get();
    set({
      document: {
        ...document,
        sketches: document.sketches.map((sk) =>
          sk.id === document.activeSketchId
            ? {
                ...sk,
                entities: propagateDerived(enforceEqual(
                  propagateDerived(sk.entities.map((e) =>
                    e.id === entityId ? updatedEntity : e,
                  )),
                  sk.constraints,
                  entityId,
                )),
              }
            : sk,
        ),
      },
    });
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
                entities: propagateDerived(enforceEqual(propagateDerived(sk.entities.map((e) => {
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
                })), sk.constraints, target.id)),
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
