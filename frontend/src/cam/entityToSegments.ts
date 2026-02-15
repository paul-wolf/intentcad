import type { Entity, Point } from '@/types/document';
import { getSegmentCount, getSegmentPointIndices, getSegmentBulge } from '@/utils/lineSegments';

/**
 * An ordered CNC path segment with optional bulge for arcs.
 * bulge = 0 means straight line.
 * bulge = tan(theta/4) for arc segments (same convention as LineEntity).
 */
export interface CncSegment {
  from: Point;
  to: Point;
  bulge: number;
}

/**
 * Convert sketch entities (filtered to a set of IDs) into ordered CNC path segments.
 * Handles LineEntity (with arc segments via bulge), CircleEntity (2 semicircles),
 * and RectangleEntity (4 straight segments).
 */
export function entityToSegments(entities: Entity[], entityIds: string[]): CncSegment[] {
  const idSet = new Set(entityIds);
  const segments: CncSegment[] = [];

  for (const entity of entities) {
    if (!idSet.has(entity.id)) continue;

    switch (entity.type) {
      case 'line': {
        const count = getSegmentCount(entity);
        for (let i = 0; i < count; i++) {
          const [i1, i2] = getSegmentPointIndices(entity, i);
          segments.push({
            from: entity.points[i1]!,
            to: entity.points[i2]!,
            bulge: getSegmentBulge(entity, i),
          });
        }
        break;
      }
      case 'circle': {
        // Split circle into two semicircular arcs (bulge = 1 means 180-degree arc)
        const { center, radius } = entity;
        const top: Point = { x: center.x, y: center.y - radius };
        const bottom: Point = { x: center.x, y: center.y + radius };
        // Two semicircles using bulge = 1 (positive = arcs left of travel direction)
        segments.push({ from: top, to: bottom, bulge: 1 });
        segments.push({ from: bottom, to: top, bulge: 1 });
        break;
      }
      case 'rectangle': {
        const hw = entity.width / 2;
        const hh = entity.height / 2;
        const c = entity.center;
        const corners: Point[] = [
          { x: c.x - hw, y: c.y + hh }, // TL (y-down)
          { x: c.x + hw, y: c.y + hh }, // TR
          { x: c.x + hw, y: c.y - hh }, // BR
          { x: c.x - hw, y: c.y - hh }, // BL
        ];
        for (let i = 0; i < 4; i++) {
          segments.push({
            from: corners[i]!,
            to: corners[(i + 1) % 4]!,
            bulge: 0,
          });
        }
        break;
      }
      // PointEntity, DimensionEntity, BezierEntity are not CNC-relevant geometry
    }
  }

  return segments;
}
