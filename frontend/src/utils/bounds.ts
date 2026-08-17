import type { Entity, Point } from '@/types/document';

export interface Bounds {
  min: Point;
  max: Point;
}

/** Mutable accumulator so callers can fold many entity sets into one box. */
export class BoundsBuilder {
  minX = Infinity;
  minY = Infinity;
  maxX = -Infinity;
  maxY = -Infinity;

  expandPoint(p: Point) {
    if (p.x < this.minX) this.minX = p.x;
    if (p.y < this.minY) this.minY = p.y;
    if (p.x > this.maxX) this.maxX = p.x;
    if (p.y > this.maxY) this.maxY = p.y;
  }

  /** Geometry only — dimension annotations are ignored, as they extend well
   *  beyond the geometry and are positioned relative to it. */
  expandEntity(entity: Entity) {
    switch (entity.type) {
      case 'line':
        for (const pt of entity.points) this.expandPoint(pt);
        break;
      case 'circle':
        this.expandPoint({ x: entity.center.x - entity.radius, y: entity.center.y - entity.radius });
        this.expandPoint({ x: entity.center.x + entity.radius, y: entity.center.y + entity.radius });
        break;
      case 'rectangle': {
        const hw = entity.width / 2;
        const hh = entity.height / 2;
        this.expandPoint({ x: entity.center.x - hw, y: entity.center.y - hh });
        this.expandPoint({ x: entity.center.x + hw, y: entity.center.y + hh });
        break;
      }
      case 'point':
        this.expandPoint(entity.position);
        break;
      case 'text':
        this.expandPoint(entity.position);
        this.expandPoint({ x: entity.position.x, y: entity.position.y - entity.height });
        break;
      case 'bezier':
        // Convex hull of control points contains the curve
        for (const cp of entity.controlPoints) this.expandPoint(cp);
        break;
      case 'dimension':
        break;
    }
  }

  get isEmpty(): boolean {
    return this.minX > this.maxX;
  }

  toBounds(): Bounds {
    return { min: { x: this.minX, y: this.minY }, max: { x: this.maxX, y: this.maxY } };
  }
}

/** Bounding box of a set of entities, or null when none carry geometry. */
export function entityBounds(entities: Iterable<Entity>): Bounds | null {
  const b = new BoundsBuilder();
  for (const e of entities) b.expandEntity(e);
  return b.isEmpty ? null : b.toBounds();
}

export function boundsCenter(b: Bounds): Point {
  return { x: (b.min.x + b.max.x) / 2, y: (b.min.y + b.max.y) / 2 };
}

export function boundsSize(b: Bounds): { width: number; height: number } {
  return { width: b.max.x - b.min.x, height: b.max.y - b.min.y };
}
