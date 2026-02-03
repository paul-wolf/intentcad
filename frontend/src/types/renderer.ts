import type { Point } from './document';

export interface Viewport {
  worldToScreen(p: Point): Point;
  screenToWorld(p: Point): Point;
  readonly scale: number;
  readonly offset: Point;
  readonly width: number;
  readonly height: number;
}

export interface LineStyle {
  color: string;
  width: number;
  opacity?: number;
}

export interface TextStyle {
  color: string;
  fontSize: number;
  fontFamily?: string;
  textAlign?: CanvasTextAlign;
  textBaseline?: CanvasTextBaseline;
}

export interface Renderer {
  clear(color: string): void;
  drawLine(a: Point, b: Point, style: LineStyle): void;
  drawCircle(center: Point, radius: number, style: LineStyle): void;
  fillCircle(center: Point, radius: number, color: string): void;
  drawRect(topLeft: Point, size: Point, fillColor: string, strokeStyle?: LineStyle): void;
  drawText(text: string, position: Point, style: TextStyle): void;
  measureText(text: string, style: TextStyle): { width: number; height: number };
  setGlobalAlpha(alpha: number): void;
  resetGlobalAlpha(): void;
}
