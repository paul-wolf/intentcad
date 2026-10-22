import type { Entity, Point } from '@/types/document';
import { getSegmentCount, getSegmentPointIndices, getSegmentBulge } from '@/utils/lineSegments';
import { rectanglePath } from '@/utils/rectPath';

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
 * and RectangleEntity (4 straight segments, or 8 with arcs when filleted).
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
        // 4 straight segments when square; 8 with an arc at each corner when
        // filleted (the corner radius machines as a real arc, not a tool-radius
        // artefact — see cam/validate.ts).
        const { points, bulge } = rectanglePath(entity);
        for (let i = 0; i < points.length; i++) {
          segments.push({
            from: points[i]!,
            to: points[(i + 1) % points.length]!,
            bulge: bulge[i] ?? 0,
          });
        }
        break;
      }
      // PointEntity, DimensionEntity, BezierEntity are not CNC-relevant geometry
    }
  }

  // Zero-length segments (repeated points) carry no direction: drop them, so
  // corner checks compare each edge with its real neighbours.
  return segments.filter((s) => Math.hypot(s.to.x - s.from.x, s.to.y - s.from.y) > 1e-9);
}
