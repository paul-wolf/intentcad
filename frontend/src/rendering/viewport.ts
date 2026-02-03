import type { Point } from '@/types/document';
import type { Viewport as IViewport } from '@/types/renderer';
import { SCALE } from '@/config';

export class ViewportImpl implements IViewport {
  readonly scale: number;
  readonly offset: Point;
  readonly width: number;
  readonly height: number;

  constructor(width: number, height: number, offset?: Point) {
    this.scale = SCALE;
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
}
