import type { Entity, SourceTransform, Point } from '@/types/document';
import { reflectPoint, rotatePoint } from '@/utils/geometry';

export function createMirroredEntity(
  source: Entity,
  transform: Extract<SourceTransform, { type: 'mirror' }>,
  id: string,
): Entity | null {
  if (source.type === 'dimension') return null;

  const { lineA, lineB } = transform;

  if (source.type === 'line') {
    return {
      ...source,
      id,
      points: source.points.map((p) => reflectPoint(p, lineA, lineB)),
      sourceId: source.id,
      sourceTransform: transform,
    };
  }

  if (source.type === 'circle') {
    return {
      ...source,
      id,
      center: reflectPoint(source.center, lineA, lineB),
      sourceId: source.id,
      sourceTransform: transform,
    };
  }

  if (source.type === 'rectangle') {
    // Check if mirror axis is axis-aligned (horizontal or vertical)
    const isHorizontal = lineA.y === lineB.y;
    const isVertical = lineA.x === lineB.x;

    if (isHorizontal || isVertical) {
      return {
        ...source,
        id,
        center: reflectPoint(source.center, lineA, lineB),
        sourceId: source.id,
        sourceTransform: transform,
      };
    }

    // Non-axis-aligned: convert to a 5-point closed polyline
    const hw = source.width / 2;
    const hh = source.height / 2;
    const c = source.center;
    const corners: Point[] = [
      { x: c.x - hw, y: c.y - hh },
      { x: c.x + hw, y: c.y - hh },
      { x: c.x + hw, y: c.y + hh },
      { x: c.x - hw, y: c.y + hh },
      { x: c.x - hw, y: c.y - hh }, // close
    ];
    return {
      id,
      type: 'line',
      points: corners.map((p) => reflectPoint(p, lineA, lineB)),
      construction: source.construction,
      sourceId: source.id,
      sourceTransform: transform,
    };
  }

  return null;
}

export function createRotatedEntity(
  source: Entity,
  transform: Extract<SourceTransform, { type: 'rotate' }>,
  id: string,
): Entity | null {
  if (source.type === 'dimension') return null;

  const { center, angle } = transform;

  if (source.type === 'line') {
    return {
      ...source,
      id,
      points: source.points.map((p) => rotatePoint(p, center, angle)),
      sourceId: source.id,
      sourceTransform: transform,
    };
  }

  if (source.type === 'circle') {
    return {
      ...source,
      id,
      center: rotatePoint(source.center, center, angle),
      sourceId: source.id,
      sourceTransform: transform,
    };
  }

  if (source.type === 'rectangle') {
    // Check if angle is axis-aligned (multiples of π/2)
    const normalised = ((angle % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    const isAxisAligned =
      Math.abs(normalised) < 1e-9 ||
      Math.abs(normalised - Math.PI / 2) < 1e-9 ||
      Math.abs(normalised - Math.PI) < 1e-9 ||
      Math.abs(normalised - (3 * Math.PI) / 2) < 1e-9 ||
      Math.abs(normalised - 2 * Math.PI) < 1e-9;

    if (isAxisAligned) {
      const is90or270 =
        Math.abs(normalised - Math.PI / 2) < 1e-9 ||
        Math.abs(normalised - (3 * Math.PI) / 2) < 1e-9;
      return {
        ...source,
        id,
        center: rotatePoint(source.center, center, angle),
        width: is90or270 ? source.height : source.width,
        height: is90or270 ? source.width : source.height,
        sourceId: source.id,
        sourceTransform: transform,
      };
    }

    // Non-axis-aligned: convert to 5-point closed polyline
    const hw = source.width / 2;
    const hh = source.height / 2;
    const c = source.center;
    const corners: Point[] = [
      { x: c.x - hw, y: c.y - hh },
      { x: c.x + hw, y: c.y - hh },
      { x: c.x + hw, y: c.y + hh },
      { x: c.x - hw, y: c.y + hh },
      { x: c.x - hw, y: c.y - hh }, // close
    ];
    return {
      id,
      type: 'line',
      points: corners.map((p) => rotatePoint(p, center, angle)),
      construction: source.construction,
      sourceId: source.id,
      sourceTransform: transform,
    };
  }

  return null;
}

export function propagateDerived(entities: Entity[]): Entity[] {
  const byId = new Map<string, Entity>();
  for (const e of entities) byId.set(e.id, e);

  return entities.map((e) => {
    if (!('sourceId' in e) || !e.sourceId || !('sourceTransform' in e) || !e.sourceTransform) {
      return e;
    }
    const source = byId.get(e.sourceId);
    if (!source) return e;

    const transform = e.sourceTransform;
    let updated: Entity | null = null;
    if (transform.type === 'mirror') {
      updated = createMirroredEntity(source, transform, e.id);
    } else if (transform.type === 'rotate') {
      updated = createRotatedEntity(source, transform, e.id);
    }
    if (!updated) return e;

    return updated;
  });
}
