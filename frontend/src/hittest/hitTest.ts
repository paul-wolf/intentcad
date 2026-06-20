import type { Point, Entity, LineEntity } from '@/types/document';
import type { Viewport } from '@/types/renderer';
import { distance, pointToSegmentDist } from '@/utils/geometry';
import { computeAngleDimensionGeom } from '@/rendering/dimensionRenderer';
import { HIT_TOL } from '@/config';
import { getSegmentCount, getSegmentPointIndices, getSegmentBulge, getEntitySegmentEndpoints } from '@/utils/lineSegments';
import { arcFromBulge, pointToArcDist, arcMidpoint } from '@/utils/arcGeometry';
import { pointToBezierDist } from '@/utils/bezierGeometry';
import { resolveDimensionEndpoints } from '@/utils/dimensionGeom';

export interface PointHit {
  entityId: string;
  pointIndex: number;
  isCenter?: boolean;
}

export interface SegmentHit {
  entityId: string;
  segmentIndex: number;
}

export type SelectionCandidate =
  | { kind: 'point';   hit: PointHit;   entity: Entity; dist: number }
  | { kind: 'segment'; hit: SegmentHit; entity: Entity; dist: number }
  | { kind: 'entity';  entity: Entity;  dist: number };

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
      // Arc midpoint handles (virtual points)
      const segCountPt = getSegmentCount(entity);
      for (let i = 0; i < segCountPt; i++) {
        const bulge = getSegmentBulge(entity, i);
        if (bulge === 0) continue;
        const [ai, bi] = getSegmentPointIndices(entity, i);
        const mid = arcMidpoint(entity.points[ai]!, entity.points[bi]!, bulge);
        const sp = viewport.worldToScreen(mid);
        const d = distance(screenPos, sp);
        if (d < bestDist) {
          bestDist = d;
          // Encode arc midpoint as pointIndex = -(segmentIndex + 1) to distinguish from real points
          best = { entityId: entity.id, pointIndex: -(i + 1) };
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
    } else if (entity.type === 'point') {
      const sp = viewport.worldToScreen(entity.position);
      const d = distance(screenPos, sp);
      if (d < bestDist) {
        bestDist = d;
        best = { entityId: entity.id, pointIndex: 0 };
      }
    } else if (entity.type === 'bezier') {
      // All 4 control points are hittable
      for (let i = 0; i < 4; i++) {
        const sp = viewport.worldToScreen(entity.controlPoints[i]!);
        const d = distance(screenPos, sp);
        if (d < bestDist) {
          bestDist = d;
          best = { entityId: entity.id, pointIndex: i };
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
      const segCount = getSegmentCount(entity);
      for (let i = 0; i < segCount; i++) {
        const [i1, i2] = getSegmentPointIndices(entity, i);
        const bulge = getSegmentBulge(entity, i);
        let d: number;
        if (bulge !== 0) {
          const arc = arcFromBulge(entity.points[i1]!, entity.points[i2]!, bulge);
          const screenCenter = viewport.worldToScreen(arc.center);
          const screenRadius = arc.radius * viewport.scale;
          const sa = viewport.worldToScreen(entity.points[i1]!);
          const sb = viewport.worldToScreen(entity.points[i2]!);
          d = pointToArcDist(screenPos, screenCenter, screenRadius, arc.startAngle, arc.endAngle, arc.counterClockwise, sa, sb);
        } else {
          const a = viewport.worldToScreen(entity.points[i1]!);
          const b = viewport.worldToScreen(entity.points[i2]!);
          d = pointToSegmentDist(screenPos, a, b);
        }
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
    } else if (entity.type === 'bezier') {
      const sp0 = viewport.worldToScreen(entity.controlPoints[0]);
      const sp1 = viewport.worldToScreen(entity.controlPoints[1]);
      const sp2 = viewport.worldToScreen(entity.controlPoints[2]);
      const sp3 = viewport.worldToScreen(entity.controlPoints[3]);
      const d = pointToBezierDist(screenPos, sp0, sp1, sp2, sp3);
      if (d < bestDist) {
        bestDist = d;
        best = entity;
      }
    } else if (entity.type === 'dimension' && allEntities) {
      const target = allEntities.find(
        (e) => e.id === entity.targetEntityId,
      );
      if (!target) continue;

      // Point-to-point dimension (vertex-based)
      if (entity.pointIndex != null) {
        const endpoints = resolveDimensionEndpoints(entity, allEntities);
        if (!endpoints) continue;
        const perp2 = perpDir(endpoints.a, endpoints.b);
        const oa: Point = { x: endpoints.a.x + perp2.x * entity.offset, y: endpoints.a.y + perp2.y * entity.offset };
        const ob: Point = { x: endpoints.b.x + perp2.x * entity.offset, y: endpoints.b.y + perp2.y * entity.offset };
        const sa = viewport.worldToScreen(oa);
        const sb = viewport.worldToScreen(ob);
        const d = pointToSegmentDist(screenPos, sa, sb);
        if (d < bestDist) {
          bestDist = d;
          best = entity;
        }
        continue;
      }

      // Two-entity dimension (distance or angle)
      if (entity.targetEntityId2 != null) {
        const target2 = allEntities.find((e) => e.id === entity.targetEntityId2);
        if (!target2) continue;

        // Circle-to-circle center distance dimension
        if (target.type === 'circle' && target2.type === 'circle') {
          const a = target.center;
          const b = target2.center;
          const perp2 = perpDir(a, b);
          const oa: Point = { x: a.x + perp2.x * entity.offset, y: a.y + perp2.y * entity.offset };
          const ob: Point = { x: b.x + perp2.x * entity.offset, y: b.y + perp2.y * entity.offset };
          const sa = viewport.worldToScreen(oa);
          const sb = viewport.worldToScreen(ob);
          const d = pointToSegmentDist(screenPos, sa, sb);
          if (d < bestDist) {
            bestDist = d;
            best = entity;
          }
          continue;
        }

        const ep1 = getEntitySegmentEndpoints(target, entity.segmentIndex);
        const ep2 = getEntitySegmentEndpoints(target2, entity.segmentIndex2 ?? 0);
        if (!ep1 || !ep2) continue;
        const [p1, p2] = ep1;
        const [q1, q2] = ep2;

        if (entity.angleMode && target.type === 'line' && target2.type === 'line') {
          const angleGeom = computeAngleDimensionGeom(p1, p2, q1, q2, entity.offset);
          if (!angleGeom) continue;
          const screenCenter = viewport.worldToScreen(angleGeom.intersection);
          const screenArcRadius = angleGeom.arcRadius * viewport.scale;
          const distToArc = Math.abs(distance(screenPos, screenCenter) - screenArcRadius);
          if (distToArc < bestDist) {
            const cursorAngle = Math.atan2(screenPos.y - screenCenter.y, screenPos.x - screenCenter.x);
            let sweep = angleGeom.endAngle - angleGeom.startAngle;
            while (sweep > Math.PI) sweep -= 2 * Math.PI;
            while (sweep < -Math.PI) sweep += 2 * Math.PI;
            let cursorRel = cursorAngle - angleGeom.startAngle;
            while (cursorRel > Math.PI) cursorRel -= 2 * Math.PI;
            while (cursorRel < -Math.PI) cursorRel += 2 * Math.PI;
            const inSweep = sweep >= 0
              ? (cursorRel >= 0 && cursorRel <= sweep)
              : (cursorRel <= 0 && cursorRel >= sweep);
            if (inSweep) {
              bestDist = distToArc;
              best = entity;
            }
          }
          continue;
        }

        const a = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
        const dx2 = q2.x - q1.x;
        const dy2 = q2.y - q1.y;
        const lenSq = dx2 * dx2 + dy2 * dy2;
        if (lenSq === 0) continue;
        const t = ((a.x - q1.x) * dx2 + (a.y - q1.y) * dy2) / lenSq;
        const b = { x: q1.x + t * dx2, y: q1.y + t * dy2 };
        const perp2 = perpDir(a, b);
        const oa: Point = { x: a.x + perp2.x * entity.offset, y: a.y + perp2.y * entity.offset };
        const ob: Point = { x: b.x + perp2.x * entity.offset, y: b.y + perp2.y * entity.offset };
        const sa = viewport.worldToScreen(oa);
        const sb = viewport.worldToScreen(ob);
        const d = pointToSegmentDist(screenPos, sa, sb);
        if (d < bestDist) {
          bestDist = d;
          best = entity;
        }
        continue;
      }

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
      if (idx < 0 || idx >= getSegmentCount(target)) continue;
      const [pai, pbi] = getSegmentPointIndices(target, idx);
      const pa = target.points[pai]!;
      const pb = target.points[pbi]!;
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
      const segCount = getSegmentCount(entity);
      for (let i = 0; i < segCount; i++) {
        const [i1, i2] = getSegmentPointIndices(entity, i);
        const bulge = getSegmentBulge(entity, i);
        let d: number;
        if (bulge !== 0) {
          const arc = arcFromBulge(entity.points[i1]!, entity.points[i2]!, bulge);
          const screenCenter = viewport.worldToScreen(arc.center);
          const screenRadius = arc.radius * viewport.scale;
          const sa = viewport.worldToScreen(entity.points[i1]!);
          const sb = viewport.worldToScreen(entity.points[i2]!);
          d = pointToArcDist(screenPos, screenCenter, screenRadius, arc.startAngle, arc.endAngle, arc.counterClockwise, sa, sb);
        } else {
          const a = viewport.worldToScreen(entity.points[i1]!);
          const b = viewport.worldToScreen(entity.points[i2]!);
          d = pointToSegmentDist(screenPos, a, b);
        }
        if (d < bestDist) {
          bestDist = d;
          best = { entityId: entity.id, segmentIndex: i };
        }
      }
    } else if (entity.type === 'circle') {
      const screenCenter = viewport.worldToScreen(entity.center);
      const screenRadius = entity.radius * viewport.scale;
      // Hit the circle edge or center
      const dEdge = Math.abs(distance(screenPos, screenCenter) - screenRadius);
      const dCenter = distance(screenPos, screenCenter);
      const d = Math.min(dEdge, dCenter);
      if (d < bestDist) {
        bestDist = d;
        best = { entityId: entity.id, segmentIndex: -1 };
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

/**
 * Return all entities within HIT_TOL, one candidate per entity, using the
 * most specific hit type (point > segment > body). Sorted by distance ascending.
 */
export function hitTestAllCandidates(
  screenPos: Point,
  entities: Entity[],
  viewport: Viewport,
  allEntities?: Entity[],
): SelectionCandidate[] {
  const candidates: SelectionCandidate[] = [];

  for (const entity of entities) {
    // --- 1. Check points ---
    let bestPointDist = Infinity;
    let bestPointHit: PointHit | null = null;

    if (entity.type === 'line') {
      for (let i = 0; i < entity.points.length; i++) {
        const sp = viewport.worldToScreen(entity.points[i]!);
        const d = distance(screenPos, sp);
        if (d < bestPointDist) {
          bestPointDist = d;
          bestPointHit = { entityId: entity.id, pointIndex: i };
        }
      }
      if ((entity as LineEntity).polygonCenter) {
        const sp = viewport.worldToScreen((entity as LineEntity).polygonCenter!);
        const d = distance(screenPos, sp);
        if (d < bestPointDist) {
          bestPointDist = d;
          bestPointHit = { entityId: entity.id, pointIndex: 0, isCenter: true };
        }
      }
      // Arc midpoint handles
      const segCountPtAll = getSegmentCount(entity);
      for (let i = 0; i < segCountPtAll; i++) {
        const bulge = getSegmentBulge(entity, i);
        if (bulge === 0) continue;
        const [ai, bi] = getSegmentPointIndices(entity, i);
        const mid = arcMidpoint(entity.points[ai]!, entity.points[bi]!, bulge);
        const sp = viewport.worldToScreen(mid);
        const d = distance(screenPos, sp);
        if (d < bestPointDist) {
          bestPointDist = d;
          bestPointHit = { entityId: entity.id, pointIndex: -(i + 1) };
        }
      }
    } else if (entity.type === 'circle') {
      const sp = viewport.worldToScreen(entity.center);
      const d = distance(screenPos, sp);
      if (d < bestPointDist) {
        bestPointDist = d;
        bestPointHit = { entityId: entity.id, pointIndex: 0, isCenter: true };
      }
    } else if (entity.type === 'rectangle') {
      const sp = viewport.worldToScreen(entity.center);
      const d = distance(screenPos, sp);
      if (d < bestPointDist) {
        bestPointDist = d;
        bestPointHit = { entityId: entity.id, pointIndex: 0, isCenter: true };
      }
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
        if (dc < bestPointDist) {
          bestPointDist = dc;
          bestPointHit = { entityId: entity.id, pointIndex: idx };
        }
      }
    } else if (entity.type === 'point') {
      const sp = viewport.worldToScreen(entity.position);
      const d = distance(screenPos, sp);
      if (d < bestPointDist) {
        bestPointDist = d;
        bestPointHit = { entityId: entity.id, pointIndex: 0 };
      }
    } else if (entity.type === 'bezier') {
      for (let i = 0; i < 4; i++) {
        const sp = viewport.worldToScreen(entity.controlPoints[i]!);
        const d = distance(screenPos, sp);
        if (d < bestPointDist) {
          bestPointDist = d;
          bestPointHit = { entityId: entity.id, pointIndex: i };
        }
      }
    }

    // --- 2. Check segments ---
    let bestSegDist = Infinity;
    let bestSegHit: SegmentHit | null = null;

    if (entity.type === 'line') {
      const segCount2 = getSegmentCount(entity);
      for (let i = 0; i < segCount2; i++) {
        const [i1, i2] = getSegmentPointIndices(entity, i);
        const bulge = getSegmentBulge(entity, i);
        let d: number;
        if (bulge !== 0) {
          const arc = arcFromBulge(entity.points[i1]!, entity.points[i2]!, bulge);
          const screenCenter = viewport.worldToScreen(arc.center);
          const screenRadius = arc.radius * viewport.scale;
          const sa = viewport.worldToScreen(entity.points[i1]!);
          const sb = viewport.worldToScreen(entity.points[i2]!);
          d = pointToArcDist(screenPos, screenCenter, screenRadius, arc.startAngle, arc.endAngle, arc.counterClockwise, sa, sb);
        } else {
          const a = viewport.worldToScreen(entity.points[i1]!);
          const b = viewport.worldToScreen(entity.points[i2]!);
          d = pointToSegmentDist(screenPos, a, b);
        }
        if (d < bestSegDist) {
          bestSegDist = d;
          bestSegHit = { entityId: entity.id, segmentIndex: i };
        }
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
        const a = viewport.worldToScreen(corners[i]!);
        const b = viewport.worldToScreen(corners[(i + 1) % 4]!);
        const d = pointToSegmentDist(screenPos, a, b);
        if (d < bestSegDist) {
          bestSegDist = d;
          bestSegHit = { entityId: entity.id, segmentIndex: i };
        }
      }
    }

    // --- 3. Check body (entity-level) distance ---
    let bodyDist = Infinity;

    if (entity.type === 'line') {
      const segCount3 = getSegmentCount(entity);
      for (let i = 0; i < segCount3; i++) {
        const [i1, i2] = getSegmentPointIndices(entity, i);
        const bulge = getSegmentBulge(entity, i);
        let d: number;
        if (bulge !== 0) {
          const arc = arcFromBulge(entity.points[i1]!, entity.points[i2]!, bulge);
          const screenCenter = viewport.worldToScreen(arc.center);
          const screenRadius = arc.radius * viewport.scale;
          const sa = viewport.worldToScreen(entity.points[i1]!);
          const sb = viewport.worldToScreen(entity.points[i2]!);
          d = pointToArcDist(screenPos, screenCenter, screenRadius, arc.startAngle, arc.endAngle, arc.counterClockwise, sa, sb);
        } else {
          const a = viewport.worldToScreen(entity.points[i1]!);
          const b = viewport.worldToScreen(entity.points[i2]!);
          d = pointToSegmentDist(screenPos, a, b);
        }
        if (d < bodyDist) bodyDist = d;
      }
    } else if (entity.type === 'circle') {
      const screenCenter = viewport.worldToScreen(entity.center);
      const screenRadius = entity.radius * viewport.scale;
      bodyDist = Math.abs(distance(screenPos, screenCenter) - screenRadius);
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
        const a = viewport.worldToScreen(corners[i]!);
        const b = viewport.worldToScreen(corners[(i + 1) % 4]!);
        const d = pointToSegmentDist(screenPos, a, b);
        if (d < bodyDist) bodyDist = d;
      }
    } else if (entity.type === 'point') {
      const sp = viewport.worldToScreen(entity.position);
      bodyDist = distance(screenPos, sp);
    } else if (entity.type === 'bezier') {
      const sp0 = viewport.worldToScreen(entity.controlPoints[0]);
      const sp1 = viewport.worldToScreen(entity.controlPoints[1]);
      const sp2 = viewport.worldToScreen(entity.controlPoints[2]);
      const sp3 = viewport.worldToScreen(entity.controlPoints[3]);
      bodyDist = pointToBezierDist(screenPos, sp0, sp1, sp2, sp3);
    } else if (entity.type === 'dimension' && allEntities) {
      // Use hitTestEntities logic for dimensions — just check if it would be hit
      const dimHit = hitTestEntities(screenPos, [entity], viewport, allEntities);
      if (dimHit) bodyDist = 0; // approximate: it's within tolerance
    }

    // --- 4. Pick best candidate ---
    const minDist = Math.min(bestPointDist, bestSegDist, bodyDist);
    if (minDist < HIT_TOL) {
      if (bestPointDist <= bestSegDist && bestPointDist <= bodyDist && bestPointHit) {
        candidates.push({ kind: 'point', hit: bestPointHit, entity, dist: bestPointDist });
      } else if (bestSegDist <= bodyDist && bestSegHit) {
        candidates.push({ kind: 'segment', hit: bestSegHit, entity, dist: bestSegDist });
      } else {
        candidates.push({ kind: 'entity', entity, dist: bodyDist });
      }
    }
  }

  candidates.sort((a, b) => a.dist - b.dist);
  return candidates;
}

function perpDir(a: Point, b: Point): Point {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len === 0) return { x: 0, y: -1 };
  return { x: -dy / len, y: dx / len };
}
