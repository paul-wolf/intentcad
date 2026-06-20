import type { Entity, LineEntity, RectangleEntity, Point } from '@/types/document';

/**
 * Returns the two world-space endpoints of a segment on any geometry entity.
 * Works for LineEntity (any segment index) and RectangleEntity (segments 0-3:
 * top, right, bottom, left). Returns null for unsupported types or out-of-range index.
 */
export function getEntitySegmentEndpoints(entity: Entity, segmentIndex: number): [Point, Point] | null {
  if (entity.type === 'line') {
    const line = entity as LineEntity;
    if (segmentIndex < 0 || segmentIndex >= getSegmentCount(line)) return null;
    const [i1, i2] = getSegmentPointIndices(line, segmentIndex);
    return [line.points[i1]!, line.points[i2]!];
  }
  if (entity.type === 'rectangle') {
    const r = entity as RectangleEntity;
    const hw = r.width / 2;
    const hh = r.height / 2;
    const { x: cx, y: cy } = r.center;
    const corners: [Point, Point, Point, Point] = [
      { x: cx - hw, y: cy + hh }, // top-left
      { x: cx + hw, y: cy + hh }, // top-right
      { x: cx + hw, y: cy - hh }, // bottom-right
      { x: cx - hw, y: cy - hh }, // bottom-left
    ];
    if (segmentIndex < 0 || segmentIndex > 3) return null;
    return [corners[segmentIndex]!, corners[(segmentIndex + 1) % 4]!];
  }
  return null;
}

export function getSegmentCount(entity: LineEntity): number {
  if (entity.points.length < 2) return 0;
  return entity.closed ? entity.points.length : entity.points.length - 1;
}

export function getSegmentPointIndices(entity: LineEntity, segmentIndex: number): [number, number] {
  return [segmentIndex, (segmentIndex + 1) % entity.points.length];
}

export function getSegmentBulge(entity: LineEntity, segIdx: number): number {
  return entity.bulge?.[segIdx] ?? 0;
}

export function isArcSegment(entity: LineEntity, segIdx: number): boolean {
  return getSegmentBulge(entity, segIdx) !== 0;
}
