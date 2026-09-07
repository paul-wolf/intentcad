import type { Entity, LineEntity, RectangleEntity, SourceTransform, Point } from '@/types/document';
import { reflectPoint, rotatePoint } from '@/utils/geometry';
import { rectanglePath } from '@/utils/rectPath';

/**
 * A rectangle that a transform can no longer keep axis-aligned degrades to a
 * closed polyline. Fillets survive as bulge arcs; a reflection reverses the
 * outline's handedness, so its bulges flip sign while a rotation's do not.
 */
function rectangleAsPolyline(
  source: RectangleEntity,
  id: string,
  transform: SourceTransform,
  map: (p: Point) => Point,
  reflected: boolean,
): LineEntity {
  const { points, bulge } = rectanglePath(source);
  const filleted = bulge.some((b) => b !== 0);
  return {
    id,
    type: 'line',
    points: points.map(map),
    closed: true,
    bulge: filleted ? bulge.map((b) => (reflected ? -b : b)) : undefined,
    construction: source.construction,
    sourceId: source.id,
    sourceTransform: transform,
  };
}

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
      ...(source.bulge ? { bulge: source.bulge.map((b) => -b) } : {}),
      ...(source.polygonCenter ? { polygonCenter: reflectPoint(source.polygonCenter, lineA, lineB) } : {}),
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

  if (source.type === 'point') {
    return {
      ...source,
      id,
      position: reflectPoint(source.position, lineA, lineB),
      sourceId: source.id,
      sourceTransform: transform,
    };
  }

  if (source.type === 'bezier') {
    return {
      ...source,
      id,
      controlPoints: source.controlPoints.map((p) => reflectPoint(p, lineA, lineB)) as [Point, Point, Point, Point],
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

    // Non-axis-aligned: degrade to a closed polyline
    return rectangleAsPolyline(source, id, transform, (p) => reflectPoint(p, lineA, lineB), true);
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
      ...(source.polygonCenter ? { polygonCenter: rotatePoint(source.polygonCenter, center, angle) } : {}),
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

  if (source.type === 'point') {
    return {
      ...source,
      id,
      position: rotatePoint(source.position, center, angle),
      sourceId: source.id,
      sourceTransform: transform,
    };
  }

  if (source.type === 'bezier') {
    return {
      ...source,
      id,
      controlPoints: source.controlPoints.map((p) => rotatePoint(p, center, angle)) as [Point, Point, Point, Point],
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

    // Non-axis-aligned: degrade to a closed polyline
    return rectangleAsPolyline(source, id, transform, (p) => rotatePoint(p, center, angle), false);
  }

  return null;
}

export function createTranslatedEntity(
  source: Entity,
  transform: Extract<SourceTransform, { type: 'translate' }>,
  id: string,
): Entity | null {
  if (source.type === 'dimension') return null;

  const { dx, dy } = transform;

  if (source.type === 'line') {
    return {
      ...source,
      id,
      points: source.points.map((p) => ({ x: p.x + dx, y: p.y + dy })),
      ...(source.polygonCenter ? { polygonCenter: { x: source.polygonCenter.x + dx, y: source.polygonCenter.y + dy } } : {}),
      sourceId: source.id,
      sourceTransform: transform,
    };
  }

  if (source.type === 'circle') {
    return {
      ...source,
      id,
      center: { x: source.center.x + dx, y: source.center.y + dy },
      sourceId: source.id,
      sourceTransform: transform,
    };
  }

  if (source.type === 'point') {
    return {
      ...source,
      id,
      position: { x: source.position.x + dx, y: source.position.y + dy },
      sourceId: source.id,
      sourceTransform: transform,
    };
  }

  if (source.type === 'bezier') {
    return {
      ...source,
      id,
      controlPoints: source.controlPoints.map((p) => ({ x: p.x + dx, y: p.y + dy })) as [Point, Point, Point, Point],
      sourceId: source.id,
      sourceTransform: transform,
    };
  }

  if (source.type === 'rectangle') {
    return {
      ...source,
      id,
      center: { x: source.center.x + dx, y: source.center.y + dy },
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
    } else if (transform.type === 'translate') {
      updated = createTranslatedEntity(source, transform, e.id);
    }
    if (!updated) return e;

    return updated;
  });
}
