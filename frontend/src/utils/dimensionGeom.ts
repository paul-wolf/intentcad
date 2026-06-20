import type { Point, DimensionEntity, Entity, LineEntity } from '@/types/document';
import { getSegmentCount, getSegmentPointIndices, getEntitySegmentEndpoints } from '@/utils/lineSegments';
import { lineLineIntersection } from '@/utils/geometry';
import { getEntityPoint } from '@/utils/entityPoints';

/**
 * Resolve the two measurement endpoints for a non-angle dimension.
 * Returns null for angle dimensions or if the target entity is not found.
 */
export function resolveDimensionEndpoints(
  dim: DimensionEntity,
  allEntities: Entity[],
): { a: Point; b: Point } | null {
  if (dim.angleMode) return null;

  const target = allEntities.find((e) => e.id === dim.targetEntityId);
  if (!target) return null;

  // Point-to-point dimension (vertex-based)
  if (dim.pointIndex != null) {
    const a = getEntityPoint(target, dim.pointIndex);
    if (!a) return null;

    if (dim.pointIndex2 != null && dim.targetEntityId2 != null) {
      const target2 = allEntities.find((e) => e.id === dim.targetEntityId2);
      if (!target2) return null;
      const b = getEntityPoint(target2, dim.pointIndex2);
      if (!b) return null;
      return { a, b };
    }
    // pointIndex2 on the same entity
    if (dim.pointIndex2 != null) {
      const b = getEntityPoint(target, dim.pointIndex2);
      if (!b) return null;
      return { a, b };
    }
    // Point-to-segment: a = point, b = foot of perpendicular from a onto the segment
    if (dim.targetEntityId2 != null) {
      const target2 = allEntities.find((e) => e.id === dim.targetEntityId2);
      if (!target2) return null;
      const ep2 = getEntitySegmentEndpoints(target2, dim.segmentIndex2 ?? 0);
      if (!ep2) return null;
      const [q1, q2] = ep2;
      const dx = q2.x - q1.x;
      const dy = q2.y - q1.y;
      const lenSq = dx * dx + dy * dy;
      if (lenSq === 0) return null;
      const t = ((a.x - q1.x) * dx + (a.y - q1.y) * dy) / lenSq;
      return { a, b: { x: q1.x + t * dx, y: q1.y + t * dy } };
    }
    return null;
  }

  // Two-entity distance dimension
  if (dim.targetEntityId2 != null) {
    const target2 = allEntities.find((e) => e.id === dim.targetEntityId2);
    if (!target2) return null;

    // Circle-to-circle center distance
    if (target.type === 'circle' && target2.type === 'circle') {
      return { a: target.center, b: target2.center };
    }

    if (target.type !== 'line' || target2.type !== 'line') return null;
    const idx1 = dim.segmentIndex;
    const idx2 = dim.segmentIndex2!;
    if (idx1 < 0 || idx1 >= getSegmentCount(target)) return null;
    if (idx2 < 0 || idx2 >= getSegmentCount(target2)) return null;
    const [pi1, pi2] = getSegmentPointIndices(target, idx1);
    const [qi1, qi2] = getSegmentPointIndices(target2, idx2);
    const p1 = target.points[pi1]!;
    const p2 = target.points[pi2]!;
    const q1 = target2.points[qi1]!;
    const q2 = target2.points[qi2]!;

    const a = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
    const dx2 = q2.x - q1.x;
    const dy2 = q2.y - q1.y;
    const lenSq = dx2 * dx2 + dy2 * dy2;
    if (lenSq === 0) return null;
    const t = ((a.x - q1.x) * dx2 + (a.y - q1.y) * dy2) / lenSq;
    const b = { x: q1.x + t * dx2, y: q1.y + t * dy2 };
    return { a, b };
  }

  if (target.type === 'circle') {
    const c = target.center;
    const r = target.radius;
    return { a: { x: c.x - r, y: c.y }, b: { x: c.x + r, y: c.y } };
  }

  if (target.type === 'rectangle') {
    const hw = target.width / 2;
    const hh = target.height / 2;
    const c = target.center;
    if (dim.segmentIndex === 0) {
      // Width dimension along top edge
      return { a: { x: c.x - hw, y: c.y + hh }, b: { x: c.x + hw, y: c.y + hh } };
    } else {
      // Height dimension along right edge
      return { a: { x: c.x + hw, y: c.y + hh }, b: { x: c.x + hw, y: c.y - hh } };
    }
  }

  // Bezier: start-to-end (control points 0 and 3)
  if (target.type === 'bezier') {
    const a = getEntityPoint(target, 0);
    const b = getEntityPoint(target, 3);
    if (!a || !b) return null;
    return { a, b };
  }

  if (target.type !== 'line') return null;

  // Polygon apothem dimension
  if (dim.segmentIndex === -1 && (target as LineEntity).polygonCenter) {
    const center = (target as LineEntity).polygonCenter!;
    const midA: Point = {
      x: (target.points[0]!.x + target.points[1]!.x) / 2,
      y: (target.points[0]!.y + target.points[1]!.y) / 2,
    };
    return { a: center, b: midA };
  }

  // Single-segment line dimension
  const idx = dim.segmentIndex;
  if (idx < 0 || idx >= getSegmentCount(target)) return null;
  const [i1, i2] = getSegmentPointIndices(target, idx);
  return { a: target.points[i1]!, b: target.points[i2]! };
}

/**
 * Resolve the line-line intersection point for an angle dimension.
 * Returns null if not an angle dimension or if intersection can't be computed.
 */
export function resolveDimensionAngleIntersection(
  dim: DimensionEntity,
  allEntities: Entity[],
): Point | null {
  if (!dim.angleMode || dim.targetEntityId2 == null) return null;

  const target = allEntities.find((e) => e.id === dim.targetEntityId);
  const target2 = allEntities.find((e) => e.id === dim.targetEntityId2);
  if (!target || !target2 || target.type !== 'line' || target2.type !== 'line') return null;

  const idx1 = dim.segmentIndex;
  const idx2 = dim.segmentIndex2!;
  if (idx1 < 0 || idx1 >= getSegmentCount(target)) return null;
  if (idx2 < 0 || idx2 >= getSegmentCount(target2)) return null;

  const [pi1, pi2] = getSegmentPointIndices(target, idx1);
  const [qi1, qi2] = getSegmentPointIndices(target2, idx2);
  const p1 = target.points[pi1]!;
  const p2 = target.points[pi2]!;
  const q1 = target2.points[qi1]!;
  const q2 = target2.points[qi2]!;

  return lineLineIntersection(p1, p2, q1, q2);
}
