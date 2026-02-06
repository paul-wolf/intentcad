import type { Entity, Sketch, Point, LineEntity, CircleEntity, RectangleEntity } from '@/types/document';
import { isClosedProfile } from '@/types/document';

/** Get all extrudable (non-construction, closed) entities from a sketch. */
export function getExtrudableEntities(sketch: Sketch): Entity[] {
  return sketch.entities.filter((e) => {
    if (e.type === 'rectangle') return !e.construction;
    if (e.type === 'circle') return !e.construction;
    if (e.type === 'line') return isClosedProfile(e as LineEntity);
    return false;
  });
}

/** Find the outermost closed profile in a sketch (largest by area). */
export function findOuterProfile(sketch: Sketch): Entity | null {
  const extrudable = getExtrudableEntities(sketch);
  if (extrudable.length === 0) return null;

  let best: Entity | null = null;
  let bestArea = -1;

  for (const e of extrudable) {
    const area = getEntityArea(e);
    if (area > bestArea) {
      bestArea = area;
      best = e;
    }
  }

  return best;
}

/** Find all top-level (not contained within any other) closed profiles in a sketch. */
export function findTopLevelProfiles(sketch: Sketch): Entity[] {
  const extrudable = getExtrudableEntities(sketch);
  return extrudable.filter((e) => {
    const center = getEntityCenter(e);
    if (!center) return true;
    return !extrudable.some((other) => {
      if (other.id === e.id) return false;
      return isPointInsideEntity(center.x, center.y, other);
    });
  });
}

/** Find all closed profiles contained within the outer entity. */
export function findHoles(outerEntity: Entity, sketch: Sketch): Entity[] {
  const extrudable = getExtrudableEntities(sketch);
  return extrudable.filter((e) => {
    if (e.id === outerEntity.id) return false;
    const center = getEntityCenter(e);
    if (!center) return false;
    return isPointInsideEntity(center.x, center.y, outerEntity);
  });
}

/** Approximate area of an entity (for comparison/sorting). */
export function getEntityArea(e: Entity): number {
  if (e.type === 'circle') {
    const c = e as CircleEntity;
    return Math.PI * c.radius * c.radius;
  }
  if (e.type === 'rectangle') {
    const r = e as RectangleEntity;
    return r.width * r.height;
  }
  if (e.type === 'line') {
    // Use shoelace formula for polygon area
    const pts = (e as LineEntity).points;
    let area = 0;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      area += (pts[j]!.x + pts[i]!.x) * (pts[j]!.y - pts[i]!.y);
    }
    return Math.abs(area / 2);
  }
  return 0;
}

function getEntityCenter(e: Entity): Point | null {
  if (e.type === 'circle') return (e as CircleEntity).center;
  if (e.type === 'rectangle') return (e as RectangleEntity).center;
  if (e.type === 'line') {
    const pts = (e as LineEntity).points;
    let cx = 0, cy = 0;
    for (const p of pts) { cx += p.x; cy += p.y; }
    return { x: cx / pts.length, y: cy / pts.length };
  }
  return null;
}

function isPointInsideEntity(px: number, py: number, entity: Entity): boolean {
  if (entity.type === 'circle') {
    const c = entity as CircleEntity;
    const dx = px - c.center.x, dy = py - c.center.y;
    return dx * dx + dy * dy < c.radius * c.radius;
  }
  if (entity.type === 'rectangle') {
    const r = entity as RectangleEntity;
    return Math.abs(px - r.center.x) < r.width / 2 && Math.abs(py - r.center.y) < r.height / 2;
  }
  if (entity.type === 'line') {
    return pointInPolygon(px, py, (entity as LineEntity).points);
  }
  return false;
}

function pointInPolygon(px: number, py: number, polygon: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i]!.x, yi = polygon[i]!.y;
    const xj = polygon[j]!.x, yj = polygon[j]!.y;
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}
