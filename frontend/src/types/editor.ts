import type { Point } from './document';

export type ToolType = 'select' | 'line' | 'point' | 'circle' | 'rectangle' | 'rect2pt' | 'axisrect' | 'polygon' | 'dimension' | 'bezier' | 'fillet' | 'trim';

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

export interface AxisRectToolState {
  type: 'axisrect';
  axisStart: Point | null;
  axisEnd: Point | null;
}

export interface BezierToolState {
  type: 'bezier';
  points: Point[];
}

export interface FilletToolState {
  type: 'fillet';
  /** the corners picked: a polyline vertex, or a rectangle corner (0=TL…3=BL) */
  corners: { entityId: string; index: number }[];
  radius: number;
}

export interface TrimToolState {
  type: 'trim';
}

export type ToolState = LineToolState | SelectToolState | PointToolState | CircleToolState | RectangleToolState | Rect2ptToolState | AxisRectToolState | PolygonToolState | DimensionToolState | BezierToolState | FilletToolState | TrimToolState;

export interface EditorState {
  activeTool: ToolType;
  selectedEntityIds: Set<string>;
  toolState: ToolState;
  cursorWorld: Point | null;
}
