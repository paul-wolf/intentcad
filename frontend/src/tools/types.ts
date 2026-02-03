import type { Point } from '@/types/document';
import type { Renderer, Viewport } from '@/types/renderer';

export interface ToolContext {
  viewport: Viewport;
  screenToWorld(p: Point): Point;
  worldToScreen(p: Point): Point;
}

export interface Tool {
  onMouseDown?(worldPos: Point, screenPos: Point, ctx: ToolContext): void;
  onMouseMove?(worldPos: Point, screenPos: Point, ctx: ToolContext): void;
  onMouseUp?(worldPos: Point, screenPos: Point, ctx: ToolContext): void;
  onKeyDown?(e: KeyboardEvent): void;
  renderOverlay?(renderer: Renderer, viewport: Viewport): void;
}
