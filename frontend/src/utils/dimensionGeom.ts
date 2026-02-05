import type { Point, DimensionEntity, Entity, LineEntity } from '@/types/document';
import { getSegmentCount, getSegmentPointIndices } from '@/utils/lineSegments';
import { lineLineIntersection } from '@/utils/geometry';

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

  // Two-segment distance dimension
  if (dim.targetEntityId2 != null) {
    const target2 = allEntities.find((e) => e.id === dim.targetEntityId2);
    if (!target2 || target.type !== 'line' || target2.type !== 'line') return null;
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
