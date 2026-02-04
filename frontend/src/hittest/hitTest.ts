import type { Point, Entity, LineEntity } from '@/types/document';
import type { Viewport } from '@/types/renderer';
import { distance, pointToSegmentDist } from '@/utils/geometry';
import { HIT_TOL } from '@/config';

export interface PointHit {
  entityId: string;
  pointIndex: number;
  isCenter?: boolean;
}

export interface SegmentHit {
  entityId: string;
  segmentIndex: number;
}

/**
 * Hit test entity endpoints at a screen position. Returns the closest
 * endpoint within HIT_TOL screen pixels, or null. Takes priority over
 * edge hits when the cursor is near a vertex.
 */
export function hitTestPoint(
  screenPos: Point,
  entities: Entity[],
  viewport: Viewport,
): PointHit | null {
  let best: PointHit | null = null;
  let bestDist = HIT_TOL;

  for (const entity of entities) {
    if (entity.type === 'line') {
      for (let i = 0; i < entity.points.length; i++) {
        const sp = viewport.worldToScreen(entity.points[i]!);
        const d = distance(screenPos, sp);
        if (d < bestDist) {
          bestDist = d;
          best = { entityId: entity.id, pointIndex: i };
        }
      }
      // Polygon center point
      if ((entity as LineEntity).polygonCenter) {
        const sp = viewport.worldToScreen((entity as LineEntity).polygonCenter!);
        const d = distance(screenPos, sp);
        if (d < bestDist) {
          bestDist = d;
          best = { entityId: entity.id, pointIndex: 0, isCenter: true };
        }
      }
    } else if (entity.type === 'circle') {
      const sp = viewport.worldToScreen(entity.center);
      const d = distance(screenPos, sp);
      if (d < bestDist) {
        bestDist = d;
        best = { entityId: entity.id, pointIndex: 0, isCenter: true };
      }
    } else if (entity.type === 'rectangle') {
      // Center point
      const sp = viewport.worldToScreen(entity.center);
      const d = distance(screenPos, sp);
      if (d < bestDist) {
        bestDist = d;
        best = { entityId: entity.id, pointIndex: 0, isCenter: true };
      }
      // Corner points: 1=TL, 2=TR, 3=BR, 4=BL
      const hw = entity.width / 2;
      const hh = entity.height / 2;
      const c = entity.center;
      const corners: [number, Point][] = [
        [1, { x: c.x - hw, y: c.y + hh }],
        [2, { x: c.x + hw, y: c.y + hh }],
        [3, { x: c.x + hw, y: c.y - hh }],
        [4, { x: c.x - hw, y: c.y - hh }],
      ];
      for (const [idx, corner] of corners) {
        const spc = viewport.worldToScreen(corner);
        const dc = distance(screenPos, spc);
        if (dc < bestDist) {
          bestDist = dc;
          best = { entityId: entity.id, pointIndex: idx };
        }
      }
    }
  }

  return best;
}

/**
 * Hit test entities at a screen position. Returns the closest entity within
 * HIT_TOL screen pixels, or null.
 *
 * Pass allEntities to enable dimension entity hit testing (resolves target lines).
 */
export function hitTestEntities(
  screenPos: Point,
  entities: Entity[],
  viewport: Viewport,
  allEntities?: Entity[],
): Entity | null {
  let best: Entity | null = null;
  let bestDist = HIT_TOL;

  for (const entity of entities) {
    if (entity.type === 'line') {
      for (let i = 0; i < entity.points.length - 1; i++) {
        const a = viewport.worldToScreen(entity.points[i]!);
        const b = viewport.worldToScreen(entity.points[i + 1]!);
        const d = pointToSegmentDist(screenPos, a, b);
        if (d < bestDist) {
          bestDist = d;
          best = entity;
        }
      }
    } else if (entity.type === 'circle') {
      const screenCenter = viewport.worldToScreen(entity.center);
      const screenRadius = entity.radius * viewport.scale;
      const d = Math.abs(distance(screenPos, screenCenter) - screenRadius);
      if (d < bestDist) {
        bestDist = d;
        best = entity;
      }
    } else if (entity.type === 'rectangle') {
      const hw = entity.width / 2;
      const hh = entity.height / 2;
      const c = entity.center;
      const corners: Point[] = [
        { x: c.x - hw, y: c.y + hh },
        { x: c.x + hw, y: c.y + hh },
        { x: c.x + hw, y: c.y - hh },
        { x: c.x - hw, y: c.y - hh },
      ];
      for (let i = 0; i < 4; i++) {
        const sa = viewport.worldToScreen(corners[i]!);
        const sb = viewport.worldToScreen(corners[(i + 1) % 4]!);
        const d = pointToSegmentDist(screenPos, sa, sb);
        if (d < bestDist) {
          bestDist = d;
          best = entity;
        }
      }
    } else if (entity.type === 'point') {
      const sp = viewport.worldToScreen(entity.position);
      const d = distance(screenPos, sp);
      if (d < bestDist) {
        bestDist = d;
        best = entity;
      }
    } else if (entity.type === 'dimension' && allEntities) {
      const target = allEntities.find(
        (e) => e.id === entity.targetEntityId,
      );
      if (!target) continue;
      if (target.type === 'circle') {
        // Hit test the diameter dimension line (horizontal, offset above circle)
        const c = target.center;
        const r = target.radius;
        const oa: Point = { x: c.x - r, y: c.y + entity.offset };
        const ob: Point = { x: c.x + r, y: c.y + entity.offset };
        const sa = viewport.worldToScreen(oa);
        const sb = viewport.worldToScreen(ob);
        const d = pointToSegmentDist(screenPos, sa, sb);
        if (d < bestDist) {
          bestDist = d;
          best = entity;
        }
        continue;
      }
      if (target.type === 'rectangle') {
        const hw = target.width / 2;
        const hh = target.height / 2;
        const c = target.center;
        let ea: Point, eb: Point;
        if (entity.segmentIndex === 0) {
          // Width dimension along top edge
          ea = { x: c.x - hw, y: c.y + hh };
          eb = { x: c.x + hw, y: c.y + hh };
        } else {
          // Height dimension along right edge
          ea = { x: c.x + hw, y: c.y + hh };
          eb = { x: c.x + hw, y: c.y - hh };
        }
        const p = perpDir(ea, eb);
        const oa: Point = { x: ea.x + p.x * entity.offset, y: ea.y + p.y * entity.offset };
        const ob: Point = { x: eb.x + p.x * entity.offset, y: eb.y + p.y * entity.offset };
        const sa = viewport.worldToScreen(oa);
        const sb = viewport.worldToScreen(ob);
        const d = pointToSegmentDist(screenPos, sa, sb);
        if (d < bestDist) {
          bestDist = d;
          best = entity;
        }
        continue;
      }
      if (target.type !== 'line') continue;
      // Polygon apothem dimension
      if (entity.segmentIndex === -1 && (target as LineEntity).polygonCenter) {
        const center = (target as LineEntity).polygonCenter!;
        const midA: Point = {
          x: (target.points[0]!.x + target.points[1]!.x) / 2,
          y: (target.points[0]!.y + target.points[1]!.y) / 2,
        };
        const perp2 = perpDir(center, midA);
        const oa: Point = { x: center.x + perp2.x * entity.offset, y: center.y + perp2.y * entity.offset };
        const ob: Point = { x: midA.x + perp2.x * entity.offset, y: midA.y + perp2.y * entity.offset };
        const sa = viewport.worldToScreen(oa);
        const sb = viewport.worldToScreen(ob);
        const d = pointToSegmentDist(screenPos, sa, sb);
        if (d < bestDist) {
          bestDist = d;
          best = entity;
        }
        continue;
      }
      const idx = entity.segmentIndex;
      if (idx < 0 || idx >= target.points.length - 1) continue;
      const pa = target.points[idx]!;
      const pb = target.points[idx + 1]!;
      const perp = perpDir(pa, pb);
      const oa: Point = { x: pa.x + perp.x * entity.offset, y: pa.y + perp.y * entity.offset };
      const ob: Point = { x: pb.x + perp.x * entity.offset, y: pb.y + perp.y * entity.offset };
      const sa = viewport.worldToScreen(oa);
      const sb = viewport.worldToScreen(ob);
      const d = pointToSegmentDist(screenPos, sa, sb);
      if (d < bestDist) {
        bestDist = d;
        best = entity;
      }
    }
  }

  return best;
}

/**
 * Hit test line segments at a screen position. Returns the specific segment
 * index within the closest line entity, or null.
 */
export function hitTestSegment(
  screenPos: Point,
  entities: Entity[],
  viewport: Viewport,
): SegmentHit | null {
  let best: SegmentHit | null = null;
  let bestDist = HIT_TOL;

  for (const entity of entities) {
    if (entity.type === 'line') {
      for (let i = 0; i < entity.points.length - 1; i++) {
        const a = viewport.worldToScreen(entity.points[i]!);
        const b = viewport.worldToScreen(entity.points[i + 1]!);
        const d = pointToSegmentDist(screenPos, a, b);
        if (d < bestDist) {
          bestDist = d;
          best = { entityId: entity.id, segmentIndex: i };
        }
      }
    } else if (entity.type === 'rectangle') {
      const hw = entity.width / 2;
      const hh = entity.height / 2;
      const c = entity.center;
      // 0=TL→TR, 1=TR→BR, 2=BR→BL, 3=BL→TL
      const corners: Point[] = [
        { x: c.x - hw, y: c.y + hh }, // TL
        { x: c.x + hw, y: c.y + hh }, // TR
        { x: c.x + hw, y: c.y - hh }, // BR
        { x: c.x - hw, y: c.y - hh }, // BL
      ];
      for (let i = 0; i < 4; i++) {
        const a = viewport.worldToScreen(corners[i]!);
        const b = viewport.worldToScreen(corners[(i + 1) % 4]!);
        const d = pointToSegmentDist(screenPos, a, b);
        if (d < bestDist) {
          bestDist = d;
          best = { entityId: entity.id, segmentIndex: i };
        }
      }
    }
  }

  return best;
}

function perpDir(a: Point, b: Point): Point {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len === 0) return { x: 0, y: -1 };
  return { x: -dy / len, y: dx / len };
}
