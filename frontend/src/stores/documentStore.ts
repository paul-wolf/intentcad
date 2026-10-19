import { create } from 'zustand';
import { patternCopies, prunePatterns } from '@/utils/copyPattern';
import type { CopyPatternParams, Document, DocumentMetadata, Entity, OriginAlignMode, Point, Sketch, Constraint, HorizontalConstraint, VerticalConstraint } from '@/types/document';
import { createEmptyDocument, createEmptySketch } from '@/utils/document';
import { createMirroredEntity, propagateDerived } from '@/utils/propagate';
import { rotatePoint } from '@/utils/geometry';
import { getEntityPoints } from '@/utils/entityPoints';
import { solveConstraints, validateConstraint } from '@/utils/constraintSolver';
import { generateId } from '@/utils/id';
import { addLog } from '@/stores/logStore';
import type { SelectedPoint } from '@/stores/editorStore';
import { getSegmentCount } from '@/utils/lineSegments';
import { BoundsBuilder } from '@/utils/bounds';
import { evaluateExpression } from '@/utils/expression';
import { dimensionEntities, resolveSketch } from '@/utils/resolveSketch';

const UNDO_STACK_LIMIT = 100;

/** One step of the history. On the undo stack `doc` is the document from
 *  before the step; on the redo stack, from after it. `label` names the step
 *  either way. */
export interface HistoryEntry {
  label: string;
  doc: Document;
  timestamp: number;
}

/** Check if a constraint references any of the given entity IDs. */
function constraintReferencesAny(c: Constraint, idSet: Set<string>): boolean {
  if (idSet.has(c.entityId)) return true;
  if ('targetEntityId' in c && idSet.has(c.targetEntityId)) return true;
  return false;
}

interface DocumentStore {
  document: Document;
  undoStack: HistoryEntry[];
  redoStack: HistoryEntry[];

  // Document actions
  setDocument(doc: Document): void;
  setDocumentName(name: string): void;
  setMetadata(metadata: Partial<DocumentMetadata>): void;
  setBuildFeatures(features: import('@/api/client').BuildFeature[]): void;
  setModelCode(code: string, label?: string): void;
  setChat(chat: import('@/types/document').ChatMessage[]): void;
  setThumbnail(thumbnail: string): void;
  setProductionNotes(notes: string): void;

  // Undo/Redo
  beginTransaction(label: string): void;
  undo(): void;
  redo(): void;
  /** Go to the state after the first `position` steps (0: before any). */
  goToHistory(position: number): void;
  restoreHistory(persisted: { undo: HistoryEntry[]; redo: HistoryEntry[] }): void;

  // Sketch actions
  addSketch(name: string, plane?: import('@/types/geometry').Plane): string;
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
  deleteSegmentFromPolyline(entityId: string, segmentIndex: number): void;
  deleteVertexFromPolyline(entityId: string, pointIndex: number): void;

  // Construction toggle
  toggleConstruction(entityIds: string[]): void;

  /** Mark entities as reference/datum features: kept, drawn, exported and
   *  built as normal, but ignored when measuring a sketch for alignment. */
  toggleReference(entityIds: string[]): void;

  // Mirror
  mirrorEntities(entityIds: string[], lineA: Point, lineB: Point): string[];

  // Grid or circular copy: makes the copies and keeps the pattern; given a
  // patternId, replaces that pattern's copies instead. Returns the new ids.
  copyPattern(sourceIds: string[], params: CopyPatternParams, patternId?: string | null): string[];

  // Center sketch at origin
  centerToOrigin(): void;
  /** Align geometry to the origin. `entityIds` limits the move to a subset
   *  (e.g. just-imported entities); omit it to align the whole active sketch. */
  alignToOrigin(
    mode: OriginAlignMode,
    entityIds?: string[] | null,
    skipTransaction?: boolean,
  ): void;

  // Constraints
  addConstraint(constraint: Constraint): void;
  removeConstraints(entityIds: string[]): void;
  toggleFixed(entityIds: string[]): void;
  toggleEqual(entityIds: string[], segments?: {entityId: string, segmentIndex: number}[]): void;
  toggleCoincident(entityIds: string[]): void;
  toggleCoincidentWithPoints(pt1: SelectedPoint, pt2: SelectedPoint): void;
  toggleMidpoint(point: SelectedPoint, segment: {entityId: string, segmentIndex: number}): void;
  toggleParallel(seg1: {entityId: string, segmentIndex: number}, seg2: {entityId: string, segmentIndex: number}): void;
  togglePerpendicular(seg1: {entityId: string, segmentIndex: number}, seg2: {entityId: string, segmentIndex: number}): void;
  toggleTangent(e1Id: string, seg1Idx: number, e2Id: string, seg2Idx: number): void;
  toggleBisect(seg1: {entityId: string, segmentIndex: number}, seg2: {entityId: string, segmentIndex: number}): void;
  toggleHorizontal(entityIds: string[], segments?: {entityId: string, segmentIndex: number}[]): void;
  toggleVertical(entityIds: string[], segments?: {entityId: string, segmentIndex: number}[]): void;

  // Arc segments
  toggleArc(entityId: string, segmentIndex: number): void;
  setArcBulge(entityId: string, segmentIndex: number, bulge: number): void;

  // Closed path
  toggleClosed(entityIds: string[]): void;
  setClosed(entityId: string, closed: boolean): void;

  // Join lines
  joinEntities(entityIds: string[]): string | null;

  // Entity replacement
  updateEntity(entityId: string, updatedEntity: Entity): void;

  // Dimension editing
  applyDimensionValue(dimensionId: string, newValue: number, skipTransaction?: boolean): void;

  // Parameters & expressions
  setParameter(name: string, value: number): void;
  removeParameter(name: string): void;
  renameParameter(oldName: string, newName: string): void;
  setDimensionExpression(dimensionId: string, expression: string | undefined): void;
  reapplyExpressionDimensions(): void;

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

// Track document reference at last beginTransaction to detect no-op transactions
let _lastTransactionDocRef: Document | null = null;

// Undo / redo one step, keeping its label and time; the entry moved, or null.
function stepBack(): HistoryEntry | null {
  const { undoStack, redoStack, document } = useDocumentStore.getState();
  const entry = undoStack[undoStack.length - 1];
  if (!entry) return null;
  useDocumentStore.setState({
    document: entry.doc,
    undoStack: undoStack.slice(0, -1),
    redoStack: [...redoStack, { ...entry, doc: structuredClone(document) }],
  });
  _lastTransactionDocRef = null;
  return entry;
}

function stepForward(): HistoryEntry | null {
  const { undoStack, redoStack, document } = useDocumentStore.getState();
  const entry = redoStack[redoStack.length - 1];
  if (!entry) return null;
  useDocumentStore.setState({
    document: entry.doc,
    undoStack: [...undoStack, { ...entry, doc: structuredClone(document) }],
    redoStack: redoStack.slice(0, -1),
  });
  _lastTransactionDocRef = null;
  return entry;
}

export const useDocumentStore = create<DocumentStore>((set, get) => ({
  document: createEmptyDocument('Untitled'),
  undoStack: [],
  redoStack: [],

  setDocument(doc) {
    set({ document: doc, undoStack: [], redoStack: [] });
  },

  setDocumentName(name) {
    set((s) => ({ document: { ...s.document, name } }));
  },

  // The 3D feature tree has its own undo (buildStore); this just mirrors it into
  // the document so auto-save persists it. No transaction.
  setBuildFeatures(features) {
    set((s) => ({ document: { ...s.document, buildFeatures: features } }));
  },

  setModelCode(code, label) {
    set((s) => {
      const prev = s.document.modelCode;
      // Unchanged code is a no-op: never overwrite the label (the debounced
      // 'hand edit' save fires after every edit and would otherwise clobber the
      // AI note / param label) and never create a duplicate history entry.
      if (prev === code) return s;
      const prevLabel = s.document.modelCodeLabel;
      // Keep a capped, labeled version history so an overwrite is recoverable and
      // each entry says what produced it. Record the version being REPLACED with
      // its own label. Coalesce a run of hand edits so typing doesn't spam it.
      const hist = s.document.modelCodeHistory ?? [];
      const coalesce = prevLabel === 'hand edit' && label === 'hand edit';
      const nextHist = prev && prev.trim() && !coalesce
        ? [...hist, { code: prev, at: Date.now(), label: prevLabel }].slice(-40)
        : hist;
      return { document: { ...s.document, modelCode: code, modelCodeLabel: label, modelCodeHistory: nextHist } };
    });
  },

  setChat(chat) {
    set((s) => ({ document: { ...s.document, chat } }));
  },

  setThumbnail(thumbnail) {
    set((s) => ({ document: { ...s.document, thumbnail } }));
  },

  setProductionNotes(productionNotes) {
    set((s) => ({ document: { ...s.document, productionNotes } }));
  },

  setMetadata(metadata) {
    set((s) => ({
      document: {
        ...s.document,
        metadata: { ...s.document.metadata, ...metadata },
      },
    }));
  },

  beginTransaction(label: string) {
    const { document, undoStack } = get();
    const entry: HistoryEntry = { label, doc: structuredClone(document), timestamp: Date.now() };
    let newStack: HistoryEntry[];
    if (_lastTransactionDocRef !== null && document === _lastTransactionDocRef && undoStack.length > 0) {
      // Document unchanged since last beginTransaction — previous was a no-op.
      // Replace the stale entry instead of pushing a duplicate.
      newStack = [...undoStack.slice(0, -1), entry];
    } else {
      newStack = [...undoStack, entry];
    }
    if (newStack.length > UNDO_STACK_LIMIT) {
      newStack.splice(0, newStack.length - UNDO_STACK_LIMIT);
    }
    set({ undoStack: newStack, redoStack: [] });
    _lastTransactionDocRef = document;
  },

  undo() {
    const entry = stepBack();
    if (entry) addLog('info', `Undo: ${entry.label}`);
  },

  redo() {
    const entry = stepForward();
    if (entry) addLog('info', `Redo: ${entry.label}`);
  },

  goToHistory(position: number) {
    const { undoStack, redoStack } = get();
    const target = Math.max(0, Math.min(position, undoStack.length + redoStack.length));
    if (target === undoStack.length) return;
    while (get().undoStack.length > target) stepBack();
    while (get().undoStack.length < target) stepForward();
    const last = get().undoStack[target - 1];
    addLog('info', last ? `Back to: after ${last.label}` : 'Back to: start');
  },

  restoreHistory(persisted: { undo: HistoryEntry[]; redo: HistoryEntry[] }) {
    // older saves named an undone-and-redone step 'Current'
    const named = (es: HistoryEntry[] | undefined) =>
      (es ?? []).map((e) => (e.label === 'Current' ? { ...e, label: 'Earlier step' } : e));
    set({
      undoStack: named(persisted.undo),
      redoStack: named(persisted.redo),
    });
  },

  addSketch(name, plane) {
    const sketch = createEmptySketch(name, plane);
    set((s) => ({
      document: {
        ...s.document,
        sketches: [...s.document.sketches, sketch],
        activeSketchId: sketch.id,
      },
    }));
    return sketch.id;
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
    addLog('info', `Added ${entity.type}`);
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
                patterns: prunePatterns(sk.patterns, idSet),
              }
            : sk,
        ),
      },
    });
    addLog('info', `Removed ${idSet.size} entit${idSet.size === 1 ? 'y' : 'ies'}`);
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
                  if (e.type === 'bezier') {
                    return {
                      ...e,
                      controlPoints: e.controlPoints.map((p) => ({
                        x: p.x + delta.x,
                        y: p.y + delta.y,
                      })) as [import('@/types/document').Point, import('@/types/document').Point, import('@/types/document').Point, import('@/types/document').Point],
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
                  if (e.id !== entityId) return e;
                  if (e.type === 'rectangle') {
                    if (e.sourceId) return e; // locked
                    if (pointIndex === 0) {
                      return { ...e, center: { x: e.center.x + delta.x, y: e.center.y + delta.y } };
                    }
                    const hw = e.width / 2;
                    const hh = e.height / 2;
                    if (e.anchor === 'corner') {
                      // Two-point rect: resize keeping opposite corner fixed
                      const oppositeIndex = ({ 1: 3, 2: 4, 3: 1, 4: 2 } as Record<number, number>)[pointIndex];
                      if (!oppositeIndex) return e;
                      const corners: Record<number, { x: number; y: number }> = {
                        1: { x: e.center.x - hw, y: e.center.y + hh },
                        2: { x: e.center.x + hw, y: e.center.y + hh },
                        3: { x: e.center.x + hw, y: e.center.y - hh },
                        4: { x: e.center.x - hw, y: e.center.y - hh },
                      };
                      const current = corners[pointIndex];
                      const opposite = corners[oppositeIndex];
                      if (!current || !opposite) return e;
                      const newCorner = { x: current.x + delta.x, y: current.y + delta.y };
                      const newWidth = Math.abs(newCorner.x - opposite.x);
                      const newHeight = Math.abs(newCorner.y - opposite.y);
                      if (newWidth <= 0 || newHeight <= 0) return e;
                      return {
                        ...e,
                        center: { x: (newCorner.x + opposite.x) / 2, y: (newCorner.y + opposite.y) / 2 },
                        width: newWidth,
                        height: newHeight,
                      };
                    }
                    // Center-defined rect: resize symmetrically around center
                    const newWidth = Math.abs(hw + (pointIndex === 2 || pointIndex === 3 ? delta.x : -delta.x)) * 2;
                    const newHeight = Math.abs(hh + (pointIndex === 1 || pointIndex === 2 ? delta.y : -delta.y)) * 2;
                    if (newWidth <= 0 || newHeight <= 0) return e;
                    return { ...e, width: newWidth, height: newHeight };
                  }
                  if (e.type === 'bezier') {
                    if (e.sourceId) return e; // locked
                    if (pointIndex < 0 || pointIndex >= 4) return e;
                    const newCPs = [...e.controlPoints] as [import('@/types/document').Point, import('@/types/document').Point, import('@/types/document').Point, import('@/types/document').Point];
                    newCPs[pointIndex] = { x: newCPs[pointIndex]!.x + delta.x, y: newCPs[pointIndex]!.y + delta.y };
                    return { ...e, controlPoints: newCPs };
                  }
                  if (e.type !== 'line') return e;
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
                  if (e.closed) return e; // closed: cannot extend
                  const newBulge = e.bulge
                    ? (end === 'start' ? [0, ...e.bulge] : [...e.bulge, 0])
                    : undefined;
                  return {
                    ...e,
                    points:
                      end === 'start'
                        ? [point, ...e.points]
                        : [...e.points, point],
                    ...(newBulge ? { bulge: newBulge } : {}),
                  };
                })),
              }
            : sk,
        ),
      },
    });
  },

  deleteSegmentFromPolyline(entityId, segmentIndex) {
    const { document } = get();
    const sketch = document.sketches.find((sk) => sk.id === document.activeSketchId);
    if (!sketch) return;
    const entity = sketch.entities.find((e) => e.id === entityId);
    if (!entity || entity.type !== 'line' || entity.sourceId || entity.polygonCenter) return;

    const pts = entity.points;
    const segCount = entity.closed ? pts.length : pts.length - 1;
    if (segCount === 0) return;

    const newConstraints = sketch.constraints.filter(
      (c) => !constraintReferencesAny(c, new Set([entityId])),
    );

    let newEntities: typeof sketch.entities;

    if (entity.closed) {
      // Open the closed path: reorder so the gap is at start/end
      const n = pts.length;
      const startIdx = (segmentIndex + 1) % n;
      const newPts = Array.from({ length: n }, (_, i) => pts[(startIdx + i) % n]!);
      const newBulge = entity.bulge
        ? Array.from({ length: n - 1 }, (_, i) => entity.bulge![(startIdx + i) % n] ?? 0)
        : undefined;
      newEntities = newPts.length < 2
        ? sketch.entities.filter((e) => e.id !== entityId)
        : sketch.entities.map((e) =>
            e.id === entityId ? { ...entity, points: newPts, closed: false, bulge: newBulge } : e,
          );
    } else {
      const lastSeg = pts.length - 2;
      if (segmentIndex === 0) {
        const newPts = pts.slice(1);
        const newBulge = entity.bulge ? entity.bulge.slice(1) : undefined;
        newEntities = newPts.length < 2
          ? sketch.entities.filter((e) => e.id !== entityId)
          : sketch.entities.map((e) =>
              e.id === entityId ? { ...entity, points: newPts, bulge: newBulge } : e,
            );
      } else if (segmentIndex === lastSeg) {
        const newPts = pts.slice(0, -1);
        const newBulge = entity.bulge ? entity.bulge.slice(0, -1) : undefined;
        newEntities = newPts.length < 2
          ? sketch.entities.filter((e) => e.id !== entityId)
          : sketch.entities.map((e) =>
              e.id === entityId ? { ...entity, points: newPts, bulge: newBulge } : e,
            );
      } else {
        // Middle segment: split into two polylines
        const pts1 = pts.slice(0, segmentIndex + 1);
        const pts2 = pts.slice(segmentIndex + 1);
        const bulge1 = entity.bulge ? entity.bulge.slice(0, segmentIndex) : undefined;
        const bulge2 = entity.bulge ? entity.bulge.slice(segmentIndex + 1) : undefined;
        const newId = generateId('ln');
        const ent1 = { ...entity, points: pts1, bulge: bulge1 };
        const ent2: typeof entity = { ...entity, id: newId, points: pts2, bulge: bulge2, sourceId: undefined, sourceTransform: undefined };
        newEntities = sketch.entities.flatMap((e) =>
          e.id === entityId ? (pts1.length >= 2 && pts2.length >= 2 ? [ent1, ent2] : pts1.length >= 2 ? [ent1] : pts2.length >= 2 ? [ent2] : []) : [e],
        );
      }
    }

    set({
      document: {
        ...document,
        sketches: document.sketches.map((sk) =>
          sk.id === document.activeSketchId
            ? { ...sk, entities: propagateDerived(newEntities), constraints: newConstraints }
            : sk,
        ),
      },
    });
    addLog('info', 'Deleted segment');
  },

  deleteVertexFromPolyline(entityId, pointIndex) {
    const { document } = get();
    const sketch = document.sketches.find((sk) => sk.id === document.activeSketchId);
    if (!sketch) return;
    const entity = sketch.entities.find((e) => e.id === entityId);
    if (!entity || entity.type !== 'line' || entity.sourceId || entity.polygonCenter) return;

    const pts = entity.points;
    if (pts.length <= 2) {
      // Removing a vertex from a 2-point line leaves nothing useful
      get().removeEntities([entityId]);
      return;
    }

    const newPts = [...pts.slice(0, pointIndex), ...pts.slice(pointIndex + 1)];

    let newBulge: number[] | undefined;
    if (entity.bulge) {
      const b = [...entity.bulge];
      if (pointIndex === 0) {
        newBulge = b.slice(1);
      } else if (pointIndex === pts.length - 1) {
        newBulge = b.slice(0, -1);
      } else {
        // Remove the segment starting at pointIndex, set the previous one to straight
        b.splice(pointIndex, 1);
        b[pointIndex - 1] = 0;
        newBulge = b;
      }
    }

    const newConstraints = sketch.constraints.filter(
      (c) => !constraintReferencesAny(c, new Set([entityId])),
    );

    set({
      document: {
        ...document,
        sketches: document.sketches.map((sk) =>
          sk.id === document.activeSketchId
            ? {
                ...sk,
                entities: propagateDerived(
                  sk.entities.map((e) =>
                    e.id === entityId ? { ...entity, points: newPts, bulge: newBulge } : e,
                  ),
                ),
                constraints: newConstraints,
              }
            : sk,
        ),
      },
    });
    addLog('info', 'Deleted vertex');
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
                  if (e.type === 'line' || e.type === 'circle' || e.type === 'rectangle' || e.type === 'point' || e.type === 'bezier') {
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

  toggleReference(entityIds) {
    const idSet = new Set(entityIds);
    const { document } = get();
    get().beginTransaction('Toggle reference');
    set({
      document: {
        ...document,
        sketches: document.sketches.map((sk) =>
          sk.id === document.activeSketchId
            ? {
                ...sk,
                entities: sk.entities.map((e) => {
                  if (!idSet.has(e.id)) return e;
                  if (e.type === 'dimension') return e;
                  return { ...e, reference: !e.reference };
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
    addLog('info', `Mirrored ${newEntities.length} entit${newEntities.length === 1 ? 'y' : 'ies'}`);
    return newEntities.map((e) => e.id);
  },

  copyPattern(sourceIds, params, patternId = null) {
    const active = () => get().document.sketches.find((sk) => sk.id === get().document.activeSketchId);
    const before = active();
    if (!before) return [];
    const old = patternId ? before.patterns?.find((p) => p.id === patternId) : undefined;
    if (old) {
      const alive = new Set(before.entities.map((e) => e.id));
      const stale = old.copyIds.filter((id) => alive.has(id));
      if (stale.length) get().removeEntities(stale);
    }
    const { document } = get();
    const sketch = active()!;
    const newEntities = patternCopies(sketch.entities, sourceIds, params);
    const id = old?.id ?? generateId('pat');
    const others = (sketch.patterns ?? []).filter((p) => p.id !== id);
    const patterns = newEntities.length
      ? [...others, { id, sourceIds, copyIds: newEntities.map((e) => e.id), ...params }]
      : others;
    set({
      document: {
        ...document,
        sketches: document.sketches.map((sk) =>
          sk.id === document.activeSketchId
            ? { ...sk, entities: [...sk.entities, ...newEntities], patterns }
            : sk,
        ),
      },
    });
    const what = params.kind === 'grid' ? `Grid copy: ${params.countX}x${params.countY}` : `Circular copy: ${newEntities.length} copies`;
    addLog('info', old ? `${what} (changed)` : what);
    return newEntities.map((e) => e.id);
  },

  centerToOrigin() {
    get().alignToOrigin('center');
  },

  alignToOrigin(mode, entityIds, skipTransaction) {
    if (mode === 'none') return;
    const { document } = get();
    const sketch = document.sketches.find((sk) => sk.id === document.activeSketchId);
    if (!sketch) return;

    // Only the requested entities are measured and moved. Aligning against the
    // whole sketch would drag pre-existing geometry along with an import.
    const subset = entityIds ? new Set(entityIds) : null;

    // Reference/datum markers move with the part but must not measure it —
    // a touch-off marker outside the outline would otherwise offset everything.
    const builder = new BoundsBuilder();
    const geomIds: string[] = [];
    let sawReference = false;
    for (const e of sketch.entities) {
      if (e.type === 'dimension') continue;
      if (subset && !subset.has(e.id)) continue;
      geomIds.push(e.id);
      if ('reference' in e && e.reference) sawReference = true;
      builder.expandEntity(e, true);
    }
    if (geomIds.length === 0) return;
    if (builder.isEmpty) {
      // Nothing but markers — measure them rather than doing nothing.
      if (!sawReference) return;
      for (const e of sketch.entities) {
        if (e.type === 'dimension') continue;
        if (subset && !subset.has(e.id)) continue;
        builder.expandEntity(e);
      }
      if (builder.isEmpty) return;
    }
    const { min, max } = builder.toBounds();

    const dx = mode === 'min' ? -min.x : -(min.x + max.x) / 2;
    const dy = mode === 'min' ? -min.y : -(min.y + max.y) / 2;
    if (Math.abs(dx) < 0.01 && Math.abs(dy) < 0.01) return; // already aligned

    if (!skipTransaction) {
      get().beginTransaction(mode === 'min' ? 'Align to origin' : 'Center to origin');
    }
    get().moveEntities(geomIds, { x: dx, y: dy });
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
      addLog('info', 'Fixed constraint OFF');
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
      addLog('info', 'Fixed constraint ON');
    }
  },

  toggleEqual(entityIds, segments) {
    if (entityIds.length !== 2) return;
    const { document } = get();
    const sketch = document.sketches.find((sk) => sk.id === document.activeSketchId);
    if (!sketch) return;

    const [id1, id2] = entityIds as [string, string];
    const seg1 = segments?.[0];
    const seg2 = segments?.[1];

    // Check if constraint already exists between these two (with matching segments if applicable)
    const existing = sketch.constraints.find((c) => {
      if (c.type !== 'equal') return false;
      const ec = c as import('@/types/document').EqualConstraint;
      if (seg1 && seg2) {
        return (
          (ec.entityId === seg1.entityId && ec.segmentIndex === seg1.segmentIndex &&
           ec.targetEntityId === seg2.entityId && ec.targetSegmentIndex === seg2.segmentIndex) ||
          (ec.entityId === seg2.entityId && ec.segmentIndex === seg2.segmentIndex &&
           ec.targetEntityId === seg1.entityId && ec.targetSegmentIndex === seg1.segmentIndex)
        );
      }
      return (
        (ec.entityId === id1 && ec.targetEntityId === id2) ||
        (ec.entityId === id2 && ec.targetEntityId === id1)
      );
    });

    if (existing) {
      set({
        document: updateActiveSketch(document, () => ({
          constraints: sketch.constraints.filter((c) => c.id !== existing.id),
        })),
      });
      addLog('info', 'Equal constraint OFF');
    } else {
      const proposed: Constraint = {
        id: crypto.randomUUID(),
        type: 'equal',
        entityId: seg1?.entityId ?? id1,
        targetEntityId: seg2?.entityId ?? id2,
        ...(seg1 ? { segmentIndex: seg1.segmentIndex } : {}),
        ...(seg2 ? { targetSegmentIndex: seg2.segmentIndex } : {}),
      };
      const validation = validateConstraint(proposed, sketch.constraints, sketch.entities);
      if (!validation.valid) {
        addLog('warn', `Equal constraint denied: ${validation.reason}`);
        return;
      }

      const newConstraints = [...sketch.constraints, proposed];
      const solved = solveConstraints(sketch.entities, newConstraints, { movedIds: new Set([id1]) });
      set({
        document: updateActiveSketch(document, () => ({
          constraints: newConstraints,
          entities: solved.entities,
        })),
      });
      addLog('info', 'Equal constraint ON');
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
      addLog('info', 'Coincident constraint OFF');
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

      const proposed: Constraint = {
        id: crypto.randomUUID(),
        type: 'coincident',
        entityId: id1,
        pointIndex: bestI,
        targetEntityId: id2,
        targetPointIndex: bestJ,
      };

      const newConstraints = [...sketch.constraints, proposed];
      const solved = solveConstraints(sketch.entities, newConstraints, { movedIds: new Set([id1]) });
      set({
        document: updateActiveSketch(document, () => ({
          constraints: newConstraints,
          entities: solved.entities,
        })),
      });
      addLog('info', 'Coincident constraint ON');
    }
  },

  toggleCoincidentWithPoints(pt1, pt2) {
    const { document } = get();
    const sketch = document.sketches.find((sk) => sk.id === document.activeSketchId);
    if (!sketch) return;

    // Prevent self-referential constraint (same entity and same point)
    if (pt1.entityId === pt2.entityId && pt1.pointIndex === pt2.pointIndex) {
      addLog('warn', 'Cannot constrain a point to itself');
      return;
    }

    const e1 = sketch.entities.find((e) => e.id === pt1.entityId);
    const e2 = sketch.entities.find((e) => e.id === pt2.entityId);
    if (!e1 || !e2) return;
    if (e1.type === 'dimension' || e2.type === 'dimension') return;

    // Check if a coincident constraint already exists between these exact points
    const existing = sketch.constraints.find((c) =>
      c.type === 'coincident' &&
      ((c.entityId === pt1.entityId && c.pointIndex === pt1.pointIndex &&
        c.targetEntityId === pt2.entityId && c.targetPointIndex === pt2.pointIndex) ||
       (c.entityId === pt2.entityId && c.pointIndex === pt2.pointIndex &&
        c.targetEntityId === pt1.entityId && c.targetPointIndex === pt1.pointIndex)),
    );

    if (existing) {
      set({
        document: updateActiveSketch(document, () => ({
          constraints: sketch.constraints.filter((c) => c.id !== existing.id),
        })),
      });
      addLog('info', 'Coincident constraint OFF');
    } else {
      const proposed: Constraint = {
        id: crypto.randomUUID(),
        type: 'coincident',
        entityId: pt1.entityId,
        pointIndex: pt1.pointIndex,
        targetEntityId: pt2.entityId,
        targetPointIndex: pt2.pointIndex,
      };

      const newConstraints = [...sketch.constraints, proposed];
      const solved = solveConstraints(sketch.entities, newConstraints, { movedIds: new Set([pt1.entityId]) });
      set({
        document: updateActiveSketch(document, () => ({
          constraints: newConstraints,
          entities: solved.entities,
        })),
      });
      addLog('info', 'Coincident constraint ON');
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
      addLog('info', 'Midpoint constraint OFF');
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
      addLog('info', 'Midpoint constraint ON');
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
      addLog('info', 'Parallel constraint OFF');
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
      if (!validation.valid) {
        addLog('warn', `Parallel constraint denied: ${validation.reason}`);
        return;
      }

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
      addLog('info', 'Parallel constraint ON');
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
      addLog('info', 'Perpendicular constraint OFF');
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
      if (!validation.valid) {
        addLog('warn', `Perpendicular constraint denied: ${validation.reason}`);
        return;
      }

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
      addLog('info', 'Perpendicular constraint ON');
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
      addLog('info', 'Tangent constraint OFF');
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
      addLog('info', 'Tangent constraint ON');
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
      addLog('info', 'Bisect constraint OFF');
    } else {
      // Auto-detect bisector vs bisected: prefer fixed entity as bisector
      const seg1Fixed = sketch.constraints.some((c) => c.type === 'fixed' && c.entityId === seg1.entityId);
      const seg2Fixed = sketch.constraints.some((c) => c.type === 'fixed' && c.entityId === seg2.entityId);
      const bisectorSeg = (seg2Fixed && !seg1Fixed) ? seg2 : seg1;
      const bisectedSeg = bisectorSeg === seg1 ? seg2 : seg1;

      const proposed: Constraint = {
        id: crypto.randomUUID(),
        type: 'bisect',
        entityId: bisectorSeg.entityId,
        segmentIndex: bisectorSeg.segmentIndex,
        targetEntityId: bisectedSeg.entityId,
        targetSegmentIndex: bisectedSeg.segmentIndex,
      };

      const validation = validateConstraint(proposed, sketch.constraints, sketch.entities);
      if (!validation.valid) {
        addLog('warn', `Bisect constraint denied: ${validation.reason}`);
        return;
      }

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
      addLog('info', 'Bisect constraint ON');
    }
  },

  toggleHorizontal(entityIds, segments) {
    for (const entityId of entityIds) {
      const { document } = get();
      const sketch = document.sketches.find((sk) => sk.id === document.activeSketchId);
      if (!sketch) return;
      const eid = entityId.slice(0, 8);

      const entity = sketch.entities.find((e) => e.id === entityId);
      if (!entity || entity.type !== 'line') continue;

      const targetSegIndices = segments
        ? segments.filter((s) => s.entityId === entityId).map((s) => s.segmentIndex)
        : undefined;

      const segCount = getSegmentCount(entity);
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
          addLog('info', `Horizontal constraint OFF ${eid}`);
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
          if (newConstraints.length === 0) {
            addLog('warn', `Horizontal constraint denied ${eid}: no valid segments`);
            continue;
          }

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
          addLog('info', `Horizontal constraint ON ${eid}`);
        }
      } else if (existing.length > 0) {
        // Toggle off: remove all horizontal constraints for this entity
        set((s) => ({
          document: updateActiveSketch(s.document, (sk2) => ({
            constraints: sk2.constraints.filter((c) => !(c.type === 'horizontal' && c.entityId === entityId)),
          })),
        }));
        addLog('info', `Horizontal constraint OFF ${eid}`);
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
        if (newConstraints.length === 0) {
          addLog('warn', `Horizontal constraint denied ${eid}: no valid segments`);
          continue;
        }

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
        addLog('info', `Horizontal constraint ON ${eid}`);
      }
    }
  },

  toggleVertical(entityIds, segments) {
    for (const entityId of entityIds) {
      const { document } = get();
      const sketch = document.sketches.find((sk) => sk.id === document.activeSketchId);
      if (!sketch) return;
      const eid = entityId.slice(0, 8);

      const entity = sketch.entities.find((e) => e.id === entityId);
      if (!entity || entity.type !== 'line') continue;

      const targetSegIndices = segments
        ? segments.filter((s) => s.entityId === entityId).map((s) => s.segmentIndex)
        : undefined;

      const segCount = getSegmentCount(entity);
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
          addLog('info', `Vertical constraint OFF ${eid}`);
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
          if (newConstraints.length === 0) {
            addLog('warn', `Vertical constraint denied ${eid}: no valid segments`);
            continue;
          }

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
          addLog('info', `Vertical constraint ON ${eid}`);
        }
      } else if (existing.length > 0) {
        // Toggle off: remove all vertical constraints for this entity
        set((s) => ({
          document: updateActiveSketch(s.document, (sk2) => ({
            constraints: sk2.constraints.filter((c) => !(c.type === 'vertical' && c.entityId === entityId)),
          })),
        }));
        addLog('info', `Vertical constraint OFF ${eid}`);
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
        if (newConstraints.length === 0) {
          addLog('warn', `Vertical constraint denied ${eid}: no valid segments`);
          continue;
        }

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
        addLog('info', `Vertical constraint ON ${eid}`);
      }
    }
  },

  toggleArc(entityId, segmentIndex) {
    const { document } = get();
    const DEFAULT_BULGE = 0.4142; // tan(π/8) → 45° arc
    set({
      document: {
        ...document,
        sketches: document.sketches.map((sk) =>
          sk.id === document.activeSketchId
            ? {
                ...sk,
                entities: sk.entities.map((e) => {
                  if (e.id !== entityId || e.type !== 'line') return e;
                  if (e.sourceId) return e; // locked
                  const segCount = getSegmentCount(e);
                  if (segmentIndex < 0 || segmentIndex >= segCount) return e;
                  const bulge = e.bulge ? [...e.bulge] : new Array(segCount).fill(0);
                  // Pad if needed
                  while (bulge.length < segCount) bulge.push(0);
                  const wasArc = bulge[segmentIndex] !== 0;
                  bulge[segmentIndex] = wasArc ? 0 : DEFAULT_BULGE;
                  // If all zero, omit bulge array
                  const allZero = bulge.every((b: number) => b === 0);
                  const result = { ...e, bulge: allZero ? undefined : bulge };
                  if (allZero) delete result.bulge;
                  addLog('info', wasArc ? 'Arc OFF' : 'Arc ON');
                  return result;
                }),
              }
            : sk,
        ),
      },
    });
  },

  setArcBulge(entityId, segmentIndex, bulge) {
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
                  if (e.sourceId) return e; // locked
                  const segCount = getSegmentCount(e);
                  if (segmentIndex < 0 || segmentIndex >= segCount) return e;
                  const bulgeArr = e.bulge ? [...e.bulge] : new Array(segCount).fill(0);
                  while (bulgeArr.length < segCount) bulgeArr.push(0);
                  bulgeArr[segmentIndex] = bulge;
                  const allZero = bulgeArr.every((b: number) => b === 0);
                  const result = { ...e, bulge: allZero ? undefined : bulgeArr };
                  if (allZero) delete result.bulge;
                  return result;
                }),
              }
            : sk,
        ),
      },
    });
  },

  toggleClosed(entityIds) {
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
                  if (e.type !== 'line') return e;
                  if (e.polygonCenter) return e; // polygons not togglable
                  if (e.points.length < 3) return e;
                  return { ...e, closed: !e.closed };
                }),
              }
            : sk,
        ),
      },
    });
    addLog('info', 'Toggled closed path');
  },

  setClosed(entityId, closed) {
    const { document } = get();
    set({
      document: {
        ...document,
        sketches: document.sketches.map((sk) =>
          sk.id === document.activeSketchId
            ? {
                ...sk,
                entities: sk.entities.map((e) => {
                  if (e.id !== entityId) return e;
                  if (e.type !== 'line') return e;
                  return { ...e, closed };
                }),
              }
            : sk,
        ),
      },
    });
  },

  joinEntities(entityIds) {
    const { document } = get();
    const sketch = document.sketches.find((sk) => sk.id === document.activeSketchId);
    if (!sketch) return null;

    // Collect only non-construction line entities from the selection
    const lineEntities = entityIds
      .map((id) => sketch.entities.find((e) => e.id === id))
      .filter((e): e is Entity & { type: 'line' } => !!e && e.type === 'line' && !e.construction);

    if (lineEntities.length < 2) {
      addLog('warn', 'Need at least 2 line entities to join');
      return null;
    }

    // Each line entity contributes segments as [start, end] point pairs
    // For multi-point lines, treat as one chain: first point is start, last is end
    type Chain = { points: Point[]; used: boolean };
    const chains: Chain[] = lineEntities.map((e) => ({
      points: [...e.points],
      used: false,
    }));

    const TOLERANCE = 1.0;
    function ptsMatch(a: Point, b: Point): boolean {
      const dx = a.x - b.x, dy = a.y - b.y;
      return dx * dx + dy * dy < TOLERANCE * TOLERANCE;
    }

    // Start with the first chain
    chains[0]!.used = true;
    const result: Point[] = [...chains[0]!.points];

    // Repeatedly find a chain that connects to the end or start of the result
    let progress = true;
    while (progress) {
      progress = false;
      for (const chain of chains) {
        if (chain.used) continue;
        const chainStart = chain.points[0]!;
        const chainEnd = chain.points[chain.points.length - 1]!;
        const resultStart = result[0]!;
        const resultEnd = result[result.length - 1]!;

        if (ptsMatch(resultEnd, chainStart)) {
          // Append chain (skip first point, it's the shared endpoint)
          result.push(...chain.points.slice(1));
          chain.used = true;
          progress = true;
        } else if (ptsMatch(resultEnd, chainEnd)) {
          // Append reversed chain
          const reversed = [...chain.points].reverse();
          result.push(...reversed.slice(1));
          chain.used = true;
          progress = true;
        } else if (ptsMatch(resultStart, chainEnd)) {
          // Prepend chain (skip last point)
          result.unshift(...chain.points.slice(0, -1));
          chain.used = true;
          progress = true;
        } else if (ptsMatch(resultStart, chainStart)) {
          // Prepend reversed chain
          const reversed = [...chain.points].reverse();
          result.unshift(...reversed.slice(0, -1));
          chain.used = true;
          progress = true;
        }
      }
    }

    const unusedCount = chains.filter((c) => !c.used).length;
    if (unusedCount > 0) {
      addLog('warn', `${unusedCount} line(s) could not be joined (endpoints don't connect)`);
    }

    // Check if the result is closed (first ~= last)
    const isClosed = result.length >= 3 && ptsMatch(result[0]!, result[result.length - 1]!);

    // Create the joined entity
    const newId = crypto.randomUUID();
    const joinedEntity: Entity = {
      id: newId,
      type: 'line' as const,
      points: result,
      ...(isClosed ? { closed: true } : {}),
    };

    // Remove old entities and their constraints/dimensions, add joined one
    const removeSet = new Set(lineEntities.map((e) => e.id));
    // Also remove derived entities whose source is being removed
    let changed = true;
    while (changed) {
      changed = false;
      for (const e of sketch.entities) {
        if (removeSet.has(e.id)) continue;
        if ('sourceId' in e && e.sourceId && removeSet.has(e.sourceId)) {
          removeSet.add(e.id);
          changed = true;
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
                entities: [
                  ...sk.entities.filter((e) => {
                    if (removeSet.has(e.id)) return false;
                    if (e.type === 'dimension' && removeSet.has(e.targetEntityId)) return false;
                    if (e.type === 'dimension' && e.targetEntityId2 && removeSet.has(e.targetEntityId2)) return false;
                    return true;
                  }),
                  joinedEntity,
                ],
                constraints: sk.constraints.filter((c) => !constraintReferencesAny(c, removeSet)),
              }
            : sk,
        ),
      },
    });

    addLog('info', `Joined ${lineEntities.length} lines into ${isClosed ? 'closed' : 'open'} polyline (${result.length} points)`);
    return newId;
  },

  updateEntity(entityId, updatedEntity) {
    const { document } = get();
    const sketch = document.sketches.find((sk) => sk.id === document.activeSketchId);
    if (!sketch) return;

    const updatedEntities = sketch.entities.map((e) =>
      e.id === entityId ? updatedEntity : e,
    );

    // Dimensions only change visual properties (offset); skip geometry solving.
    if (updatedEntity.type === 'dimension') {
      set({
        document: updateActiveSketch(document, () => ({ entities: updatedEntities })),
      });
      return;
    }

    const solved = solveConstraints(updatedEntities, sketch.constraints, { movedIds: new Set([entityId]) });
    set({
      document: updateActiveSketch(document, () => ({
        entities: solved.entities,
      })),
    });
  },

  applyDimensionValue(dimensionId, newValue, skipTransaction) {
    const { document } = get();
    const sketch = document.sketches.find((sk) => sk.id === document.activeSketchId);
    if (!sketch) return;
    const entities = dimensionEntities(sketch, dimensionId, newValue);
    if (entities === 'derived') {
      addLog('warn', 'Cannot edit derived dimension');
      return;
    }
    if (!entities) return;
    if (!skipTransaction) get().beginTransaction('Edit dimension');
    set({ document: updateActiveSketch(get().document, () => ({ entities })) });
  },

  setParameter(name, value) {
    const { document } = get();
    const params = { ...(document.parameters ?? {}), [name]: value };
    set({ document: { ...document, parameters: params } });
    get().reapplyExpressionDimensions();
  },

  removeParameter(name) {
    const { document } = get();
    const params = { ...(document.parameters ?? {}) };
    delete params[name];
    // Clear expressions that can no longer evaluate
    const updatedDoc: Document = {
      ...document,
      parameters: params,
      sketches: document.sketches.map((sk) => ({
        ...sk,
        entities: sk.entities.map((e) => {
          if (e.type !== 'dimension' || !e.expression) return e;
          try {
            evaluateExpression(e.expression, params);
            return e;
          } catch {
            return { ...e, expression: undefined };
          }
        }),
      })),
    };
    set({ document: updatedDoc });
  },

  renameParameter(oldName, newName) {
    const { document } = get();
    const params = { ...(document.parameters ?? {}) };
    if (!(oldName in params)) return;
    params[newName] = params[oldName]!;
    delete params[oldName];
    // Regex-replace old name in all dimension expressions
    const re = new RegExp(`\\b${oldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');
    const updatedDoc: Document = {
      ...document,
      parameters: params,
      sketches: document.sketches.map((sk) => ({
        ...sk,
        entities: sk.entities.map((e) => {
          if (e.type !== 'dimension' || !e.expression) return e;
          return { ...e, expression: e.expression.replace(re, newName) };
        }),
      })),
    };
    set({ document: updatedDoc });
  },

  setDimensionExpression(dimensionId, expression) {
    const { document } = get();
    set({
      document: updateActiveSketch(document, (sk) => ({
        entities: sk.entities.map((e) => {
          if (e.id !== dimensionId || e.type !== 'dimension') return e;
          if (expression === undefined) {
            const { expression: _, ...rest } = e;
            return rest as typeof e;
          }
          return { ...e, expression };
        }),
      })),
    });
  },

  reapplyExpressionDimensions() {
    const { document } = get();
    const sketch = document.sketches.find((sk) => sk.id === document.activeSketchId);
    if (!sketch) return;
    const { sketch: resolved, changed } = resolveSketch(sketch, document.parameters ?? {});
    if (changed) set({ document: updateActiveSketch(document, () => ({ entities: resolved.entities })) });
  },

  getActiveSketch() {
    const { document } = get();
    return document.sketches.find((sk) => sk.id === document.activeSketchId);
  },
}));
