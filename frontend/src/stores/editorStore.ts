import { create } from 'zustand';
import type { Entity, Point } from '@/types/document';
import type { ToolType, ToolState } from '@/types/editor';
import type { SegmentHit } from '@/hittest/hitTest';
import { addLog } from '@/stores/logStore';

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
  gridCopyEntityIds: string[] | null;
  /** Shapes a copy dialog would add, drawn as a preview while it is open. */
  copyPreview: Entity[] | null;
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
  setCircularCopyEntityIds(ids: string[] | null): void;
  setCircularCopyPickingCenter(picking: boolean): void;
  setCircularCopyCenter(center: Point | null): void;
  setGridCopyEntityIds(ids: string[] | null): void;
  setCopyPreview(entities: Entity[] | null): void;
  setPendingDxfImport(pending: PendingDxfImport | null): void;
  setViewportScale(scale: number): void;
  setViewportCommand(cmd: 'center-origin' | 'fit-entities' | null): void;
}

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
  gridCopyEntityIds: null,
  copyPreview: null,
  pendingDxfImport: null,
  viewportScale: 1,
  viewportCommand: null,

  setActiveTool(tool) {
    addLog('info', `Tool: ${tool}`);
    set({ activeTool: tool, toolState: defaultToolState(tool), selectedEntityIds: new Set(), selectedPoints: [], selectedSegments: [] });
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

  setCircularCopyEntityIds(ids) {
    set({ circularCopyEntityIds: ids, circularCopyPickingCenter: false, circularCopyCenter: null });
  },

  setCircularCopyPickingCenter(picking) {
    set({ circularCopyPickingCenter: picking });
  },

  setCircularCopyCenter(center) {
    set({ circularCopyCenter: center, circularCopyPickingCenter: false });
  },

  setGridCopyEntityIds(ids) {
    set({ gridCopyEntityIds: ids, ...(ids ? {} : { copyPreview: null }) });
  },

  setCopyPreview(entities) {
    set({ copyPreview: entities });
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
