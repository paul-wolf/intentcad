import type { Point } from './document';

export type ToolType = 'select' | 'line' | 'dimension';

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

export interface DimensionToolState {
  type: 'dimension';
}

export type ToolState = LineToolState | SelectToolState | DimensionToolState;

export interface EditorState {
  activeTool: ToolType;
  selectedEntityIds: Set<string>;
  toolState: ToolState;
  cursorWorld: Point | null;
}
