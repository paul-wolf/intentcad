import { create } from 'zustand';
import type { Entity, Point } from '@/types/document';
import type { ToolType, ToolState } from '@/types/editor';
import type { SegmentHit } from '@/hittest/hitTest';
import { addLog } from '@/stores/logStore';
import type { RunEdge } from '@/api/client';
import type { PlaneBasis } from '@/build/sketchPlane';

/** What the project tool picks from: the part's edges, the plane the sketch
 *  is on, and whether the part in front of that plane is cut away in the
 *  view (a face sketch). */
export interface ProjectSource { edges: RunEdge[]; plane: PlaneBasis; clipped: boolean }

export interface SelectedPoint {
  entityId: string;
  pointIndex: number;
}

/** A parsed DXF waiting on the user's placement choice before it is committed. */
export interface PendingDxfImport {
  fileName: string;
  entities: Entity[];
  skipped: number;
  skippedTypes: string[];
  /** Bounding box of the incoming geometry, in source-file coordinates. */
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
}

interface EditorStore {
  activeTool: ToolType;
  selectedEntityIds: Set<string>;
  selectedPoints: SelectedPoint[];
  selectedSegments: SegmentHit[];
  toolState: ToolState;
  cursorWorld: Point | null;
  altKeyHeld: boolean;
  editingDimensionId: string | null;
  mirrorEntityIds: string[] | null;
  mirrorPickingLine: boolean;
  circularCopyEntityIds: string[] | null;
  circularCopyPickingCenter: boolean;
  circularCopyCenter: Point | null;
  /** Where the pointer would put the centre, while picking it */
  circularCopyHover: Point | null;
  gridCopyEntityIds: string[] | null;
  /** The pattern a copy dialog is changing (null: making a new one). */
  copyPatternId: string | null;
  /** Shapes a copy dialog would add, drawn as a preview while it is open. */
  copyPreview: Entity[] | null;
  /** The centre a circular copy preview turns about, marked in the sketch. */
  copyPreviewCenter: Point | null;
  /** Copies left out of the drawing while a dialog previews their replacements. */
  copyPreviewHides: Set<string> | null;
  /** The part's parameters (its script's P) while sketching on a part: a
   *  dimension expression can use them too, and shows its value. null in the
   *  2D sketch editor. */
  partParams: Record<string, number> | null;
  setPartParams(params: Record<string, number> | null): void;
  /** The part's edges and the sketch plane while sketching on a part, for
   *  the project tool (build/projectEdges.ts). null in the 2D sketch editor. */
  projectSource: ProjectSource | null;
  setProjectSource(source: ProjectSource | null): void;
  pendingDxfImport: PendingDxfImport | null;
  viewportScale: number;
  viewportCommand: 'center-origin' | 'fit-entities' | null;

  setActiveTool(tool: ToolType): void;
  setSelectedEntityIds(ids: Set<string>): void;
  addToSelection(ids: string[]): void;
  setSelectedPoints(pts: SelectedPoint[]): void;
  toggleSelectedPoint(pt: SelectedPoint): void;
  setSelectedSegments(segs: SegmentHit[]): void;
  toggleSelectedSegment(seg: SegmentHit): void;
  clearSelection(): void;
  setToolState(state: ToolState): void;
  setCursorWorld(p: Point | null): void;
  setAltKeyHeld(held: boolean): void;
  setEditingDimensionId(id: string | null): void;
  setMirrorEntityIds(ids: string[] | null): void;
  setMirrorPickingLine(picking: boolean): void;
  setCircularCopyEntityIds(ids: string[] | null, patternId?: string | null): void;
  setCircularCopyPickingCenter(picking: boolean): void;
  setCircularCopyCenter(center: Point | null): void;
  setCircularCopyHover(p: Point | null): void;
  setGridCopyEntityIds(ids: string[] | null, patternId?: string | null): void;
  setCopyPreview(entities: Entity[] | null, center?: Point | null, hides?: Set<string> | null): void;
  setPendingDxfImport(pending: PendingDxfImport | null): void;
  setViewportScale(scale: number): void;
  setViewportCommand(cmd: 'center-origin' | 'fit-entities' | null): void;
}

/** The fillet tool starts with the radius used last. */
let lastFilletRadius = 2;
export function rememberFilletRadius(r: number) { lastFilletRadius = r; }

/** The offset tool starts with the distance and corner joins used last. */
let lastOffset: { distance: number; join: 'arc' | 'miter' } = { distance: 1, join: 'arc' };
export function rememberOffset(distance: number, join: 'arc' | 'miter') { lastOffset = { distance, join }; }

function defaultToolState(tool: ToolType): ToolState {
  switch (tool) {
    case 'line':
      return { type: 'line', firstPoint: null, activePolylineId: null, activeEnd: null };
    case 'select':
      return { type: 'select', dragStart: null, dragEnd: null };
    case 'circle':
      return { type: 'circle', center: null };
    case 'rectangle':
      return { type: 'rectangle', center: null };
    case 'rect2pt':
      return { type: 'rect2pt', corner: null };
    case 'axisrect':
      return { type: 'axisrect', axisStart: null, axisEnd: null };
    case 'polygon':
      return { type: 'polygon', center: null, sides: 6 };
    case 'point':
      return { type: 'point' };
    case 'dimension':
      return { type: 'dimension' };
    case 'bezier':
      return { type: 'bezier', points: [] };
    case 'fillet':
      return { type: 'fillet', corners: [], radius: lastFilletRadius };
    case 'trim':
      return { type: 'trim' };
    case 'offset':
      return { type: 'offset', sourceIds: [], distance: lastOffset.distance, side: 1, join: lastOffset.join };
    case 'project':
      return { type: 'project' };
  }
}

export const useEditorStore = create<EditorStore>((set) => ({
  activeTool: 'line',
  selectedEntityIds: new Set(),
  selectedPoints: [],
  selectedSegments: [],
  toolState: { type: 'line', firstPoint: null, activePolylineId: null, activeEnd: null },
  cursorWorld: null,
  altKeyHeld: false,
  editingDimensionId: null,
  mirrorEntityIds: null,
  mirrorPickingLine: false,
  circularCopyEntityIds: null,
  circularCopyPickingCenter: false,
  circularCopyCenter: null,
  circularCopyHover: null,
  gridCopyEntityIds: null,
  copyPatternId: null,
  copyPreview: null,
  copyPreviewCenter: null,
  copyPreviewHides: null,
  partParams: null,
  projectSource: null,
  pendingDxfImport: null,
  viewportScale: 1,
  viewportCommand: null,

  setPartParams(partParams) {
    set({ partParams });
  },

  setProjectSource(projectSource) {
    set({ projectSource });
  },

  setActiveTool(tool) {
    addLog('info', `Tool: ${tool}`);
    set((s) => {
      const toolState = defaultToolState(tool);
      // offset what was selected, if anything
      if (toolState.type === 'offset') toolState.sourceIds = [...s.selectedEntityIds];
      return { activeTool: tool, toolState, selectedEntityIds: new Set(), selectedPoints: [], selectedSegments: [] };
    });
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

  setSelectedPoints(pts) {
    set({ selectedPoints: pts });
  },

  toggleSelectedPoint(pt) {
    set((s) => {
      const idx = s.selectedPoints.findIndex(
        (sp) => sp.entityId === pt.entityId && sp.pointIndex === pt.pointIndex,
      );
      if (idx >= 0) {
        return { selectedPoints: s.selectedPoints.filter((_, i) => i !== idx) };
      }
      return { selectedPoints: [...s.selectedPoints, pt] };
    });
  },

  setSelectedSegments(segs) {
    set({ selectedSegments: segs });
  },

  toggleSelectedSegment(seg) {
    set((s) => {
      const idx = s.selectedSegments.findIndex(
        (ss) => ss.entityId === seg.entityId && ss.segmentIndex === seg.segmentIndex,
      );
      if (idx >= 0) {
        return { selectedSegments: s.selectedSegments.filter((_, i) => i !== idx) };
      }
      return { selectedSegments: [...s.selectedSegments, seg] };
    });
  },

  clearSelection() {
    set({ selectedEntityIds: new Set(), selectedPoints: [], selectedSegments: [] });
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

  setEditingDimensionId(id) {
    set({ editingDimensionId: id });
  },

  setMirrorEntityIds(ids) {
    set({ mirrorEntityIds: ids });
  },

  setMirrorPickingLine(picking) {
    set({ mirrorPickingLine: picking });
  },

  setCircularCopyEntityIds(ids, patternId = null) {
    set({
      circularCopyEntityIds: ids, circularCopyPickingCenter: false, circularCopyCenter: null, circularCopyHover: null,
      copyPatternId: ids ? patternId : null,
      ...(ids ? {} : { copyPreview: null, copyPreviewCenter: null, copyPreviewHides: null }),
    });
  },

  setCircularCopyPickingCenter(picking) {
    set({ circularCopyPickingCenter: picking, circularCopyHover: null });
  },

  setCircularCopyCenter(center) {
    set({ circularCopyCenter: center, circularCopyPickingCenter: false, circularCopyHover: null });
  },

  setCircularCopyHover(p) {
    set({ circularCopyHover: p });
  },

  setGridCopyEntityIds(ids, patternId = null) {
    set({
      gridCopyEntityIds: ids, copyPatternId: ids ? patternId : null,
      ...(ids ? {} : { copyPreview: null, copyPreviewCenter: null, copyPreviewHides: null }),
    });
  },

  setCopyPreview(entities, center = null, hides = null) {
    set({ copyPreview: entities, copyPreviewCenter: center, copyPreviewHides: hides });
  },

  setPendingDxfImport(pending) {
    set({ pendingDxfImport: pending });
  },

  setViewportScale(scale) {
    set({ viewportScale: scale });
  },

  setViewportCommand(cmd) {
    set({ viewportCommand: cmd });
  },
}));
