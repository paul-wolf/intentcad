import type { Point } from './document';

export type ToolType = 'select' | 'line' | 'point' | 'circle' | 'rectangle' | 'rect2pt' | 'polygon' | 'dimension';

export interface LineToolState {
  type: 'line';
  firstPoint: Point | null;
  activePolylineId: string | null;
  activeEnd: 'start' | 'end' | null;
}

export interface SelectToolState {
  type: 'select';
  dragStart: Point | null;
  dragEnd: Point | null;
}

export interface CircleToolState {
  type: 'circle';
  center: Point | null;
}

export interface RectangleToolState {
  type: 'rectangle';
  center: Point | null;
}

export interface Rect2ptToolState {
  type: 'rect2pt';
  corner: Point | null;
}

export interface PolygonToolState {
  type: 'polygon';
  center: Point | null;
  sides: number;
}

export interface PointToolState {
  type: 'point';
}

export interface DimensionToolState {
  type: 'dimension';
}

export type ToolState = LineToolState | SelectToolState | PointToolState | CircleToolState | RectangleToolState | Rect2ptToolState | PolygonToolState | DimensionToolState;

export interface EditorState {
  activeTool: ToolType;
  selectedEntityIds: Set<string>;
  toolState: ToolState;
  cursorWorld: Point | null;
}
