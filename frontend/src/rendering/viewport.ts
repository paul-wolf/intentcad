import type { Point } from '@/types/document';
import type { Viewport as IViewport } from '@/types/renderer';
import { SCALE } from '@/config';

const MIN_SCALE = 0.5;
const MAX_SCALE = 80;

export class ViewportImpl implements IViewport {
  scale: number;
  offset: Point;
  readonly width: number;
  readonly height: number;

  constructor(width: number, height: number, offset?: Point, scale?: number) {
    this.scale = scale ?? SCALE;
    this.offset = offset ?? { x: Math.round(width / 2), y: Math.round(height / 2) };
    this.width = width;
    this.height = height;
  }

  worldToScreen(p: Point): Point {
    return {
      x: p.x * this.scale + this.offset.x,
      y: p.y * this.scale + this.offset.y,
    };
  }

  screenToWorld(p: Point): Point {
    return {
      x: (p.x - this.offset.x) / this.scale,
      y: (p.y - this.offset.y) / this.scale,
    };
  }

  /** Translate viewport offset by screen-pixel deltas. */
  pan(dx: number, dy: number): void {
    this.offset = { x: this.offset.x + dx, y: this.offset.y + dy };
  }

  /** Zoom by `factor` keeping the world point under `screenPos` fixed. */
  zoomAt(screenPos: Point, factor: number): void {
    const newScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, this.scale * factor));
    const realFactor = newScale / this.scale;
    this.offset = {
      x: screenPos.x - (screenPos.x - this.offset.x) * realFactor,
      y: screenPos.y - (screenPos.y - this.offset.y) * realFactor,
    };
    this.scale = newScale;
  }
}
