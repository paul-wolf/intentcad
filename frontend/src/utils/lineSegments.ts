import type { LineEntity } from '@/types/document';

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
