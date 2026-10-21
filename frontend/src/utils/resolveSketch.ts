/**
 * Dimensions set from values and expressions, as pure functions of a sketch:
 * the document store uses them for the sketch being edited, the build for
 * face sketches whose dimensions use the part's parameters (P).
 */
import type { Entity, Point, Sketch } from '@/types/document';
import { rotatePoint, lineLineIntersection } from '@/utils/geometry';
import { getEntityPoint, setEntityPoint } from '@/utils/entityPoints';
import { solveConstraints } from '@/utils/constraintSolver';
import { computeDerivedDimensionIds } from '@/utils/dof';
import { getSegmentCount, getSegmentPointIndices, getEntitySegmentEndpoints } from '@/utils/lineSegments';
import { evaluateExpression, expressionNames } from '@/utils/expression';
import { resolveDimensionEndpoints } from '@/utils/dimensionGeom';
import { brokenIds, onBroken } from '@/utils/brokenRefs';
import { setArcRadius, filletRectangle } from '@/utils/fillet';

/** What dimension `dim` measures now (mm, or degrees for an angle); null
 *  when its targets are gone. */
export function measureDimension(dim: Entity, entities: Entity[]): number | null {
  if (dim.type !== 'dimension') return null;
  if (dim.angleMode && dim.targetEntityId2 != null) {
    const t1 = entities.find((e) => e.id === dim.targetEntityId);
    const t2 = entities.find((e) => e.id === dim.targetEntityId2);
    if (!t1 || !t2) return null;
    const ep1 = getEntitySegmentEndpoints(t1, dim.segmentIndex);
    const ep2 = getEntitySegmentEndpoints(t2, dim.segmentIndex2 ?? 0);
    if (!ep1 || !ep2) return null;
    const [p1, p2] = ep1, [q1, q2] = ep2;
    const ix = lineLineIntersection(p1, p2, q1, q2);
    if (!ix) return null;
    // as dimensionEntities measures it: between the segments' midpoints, about the intersection
    let sweep = Math.atan2((q1.y + q2.y) / 2 - ix.y, (q1.x + q2.x) / 2 - ix.x)
      - Math.atan2((p1.y + p2.y) / 2 - ix.y, (p1.x + p2.x) / 2 - ix.x);
    while (sweep > Math.PI) sweep -= 2 * Math.PI;
    while (sweep < -Math.PI) sweep += 2 * Math.PI;
    return Math.abs(sweep) * 180 / Math.PI;
  }
  if (dim.targetEntityId2 != null && dim.pointIndex == null) {
    // between two segments (a line's or a rectangle's), as dimensionEntities
    // measures it: from the first one's midpoint across to the second
    const t1 = entities.find((e) => e.id === dim.targetEntityId);
    const t2 = entities.find((e) => e.id === dim.targetEntityId2);
    const ep1 = t1 && getEntitySegmentEndpoints(t1, dim.segmentIndex);
    const ep2 = t2 && getEntitySegmentEndpoints(t2, dim.segmentIndex2 ?? 0);
    if (ep1 && ep2) {
      const a = { x: (ep1[0].x + ep1[1].x) / 2, y: (ep1[0].y + ep1[1].y) / 2 };
      const [q1, q2] = ep2;
      const dx = q2.x - q1.x, dy = q2.y - q1.y, l2 = dx * dx + dy * dy;
      if (l2 === 0) return null;
      const t = ((a.x - q1.x) * dx + (a.y - q1.y) * dy) / l2;
      return Math.hypot(q1.x + t * dx - a.x, q1.y + t * dy - a.y);
    }
  }
  const ends = resolveDimensionEndpoints(dim, entities);
  return ends ? Math.hypot(ends.b.x - ends.a.x, ends.b.y - ends.a.y) : null;
}

/** The sketch's entities with dimension `dimId` set to `newValue` and the
 *  constraints re-solved; 'derived' for a driven dimension (it can't be set),
 *  null when nothing can change. Pure: `sketch` is not touched. */
export function dimensionEntities(sketch: Sketch, dimId: string, newValue: number): Entity[] | 'derived' | null {
  const dim = sketch.entities.find((e) => e.id === dimId);
  if (!dim || dim.type !== 'dimension') return null;

  // Reject edits on derived (driven) dimensions
  const derivedIds = computeDerivedDimensionIds(sketch.entities, sketch.constraints);
  if (derivedIds.has(dim.id)) {
    return 'derived';
  }

  const target = sketch.entities.find((e) => e.id === dim.targetEntityId);
  if (!target) return null;

  // Radius of a fillet or other arc segment, or of a rectangle's corners
  if (dim.radius) {
    if ('sourceId' in target && target.sourceId) return null;
    let next: Entity | null = null;
    if (target.type === 'line') next = setArcRadius(target, dim.segmentIndex, newValue);
    if (target.type === 'rectangle') next = filletRectangle(target, newValue).entity;
    if (!next) return null;
    const updated = sketch.entities.map((e) => (e.id === target.id ? next! : e));
    return solveConstraints(updated, sketch.constraints, { movedIds: new Set([target.id]) }).entities;
  }

  // Point-to-point dimension editing
  if (dim.pointIndex != null && dim.pointIndex2 != null) {
    const sameEntity = dim.targetEntityId2 == null || dim.targetEntityId2 === dim.targetEntityId;
    const target2 = sameEntity ? target : sketch.entities.find((e) => e.id === dim.targetEntityId2);
    if (!target2) return null;

    const a = getEntityPoint(target, dim.pointIndex);
    const b = getEntityPoint(target2, dim.pointIndex2);
    if (!a || !b) return null;

    const dist = Math.sqrt((b.x - a.x) ** 2 + (b.y - a.y) ** 2);
    if (dist === 0) return null;

    const nx = (b.x - a.x) / dist;
    const ny = (b.y - a.y) / dist;
    const delta = newValue - dist;

    const target1Fixed = sketch.constraints.some((c) => c.type === 'fixed' && c.entityId === target.id);
    const target2Fixed = !sameEntity && sketch.constraints.some((c) => c.type === 'fixed' && c.entityId === target2.id);
    if (target1Fixed && target2Fixed) return null;

    // Split movement: point a moves in -n direction, point b in +n direction
    let moveA = -delta / 2;
    let moveB = delta / 2;
    if (target1Fixed) { moveA = 0; moveB = delta; }
    if (target2Fixed) { moveB = 0; moveA = -delta; }

    const newA: Point = { x: a.x + nx * moveA, y: a.y + ny * moveA };
    const newB: Point = { x: b.x + nx * moveB, y: b.y + ny * moveB };

    const movedIds = new Set<string>();
    const updatedEntities = sketch.entities.map((e) => {
      if (sameEntity && e.id === target.id) {
        let result = setEntityPoint(e, dim.pointIndex!, newA);
        if (result) result = setEntityPoint(result, dim.pointIndex2!, newB);
        if (result) {
          movedIds.add(e.id);
          return result;
        }
      }
      if (!sameEntity && e.id === target.id && moveA !== 0) {
        const result = setEntityPoint(e, dim.pointIndex!, newA);
        if (result) {
          movedIds.add(e.id);
          return result;
        }
      }
      if (!sameEntity && e.id === target2.id && moveB !== 0) {
        const result = setEntityPoint(e, dim.pointIndex2!, newB);
        if (result) {
          movedIds.add(e.id);
          return result;
        }
      }
      return e;
    });
    const solved = solveConstraints(updatedEntities, sketch.constraints, { movedIds });
    return solved.entities;
  }

  // Point-to-segment dimension
  if (dim.pointIndex != null && dim.pointIndex2 == null && dim.targetEntityId2 != null) {
    const target2 = sketch.entities.find((e) => e.id === dim.targetEntityId2);
    if (!target2) return null;

    const a = getEntityPoint(target, dim.pointIndex);
    if (!a) return null;
    const ep2 = getEntitySegmentEndpoints(target2, dim.segmentIndex2 ?? 0);
    if (!ep2) return null;
    const [q1, q2] = ep2;
    const sdx = q2.x - q1.x; const sdy = q2.y - q1.y;
    const sLenSq = sdx * sdx + sdy * sdy;
    if (sLenSq === 0) return null;
    const tProj = ((a.x - q1.x) * sdx + (a.y - q1.y) * sdy) / sLenSq;
    const foot: Point = { x: q1.x + tProj * sdx, y: q1.y + tProj * sdy };
    const dist = Math.sqrt((foot.x - a.x) ** 2 + (foot.y - a.y) ** 2);
    if (dist === 0) return null;
    const nx = (foot.x - a.x) / dist;
    const ny = (foot.y - a.y) / dist;
    const delta = newValue - dist;

    const target1Fixed = sketch.constraints.some((c) => c.type === 'fixed' && c.entityId === target.id);
    const target2Fixed = sketch.constraints.some((c) => c.type === 'fixed' && c.entityId === target2.id);
    if (target1Fixed && target2Fixed) return null;

    let move1 = -delta / 2;
    let move2 = delta / 2;
    if (target1Fixed) { move1 = 0; move2 = delta; }
    if (target2Fixed) { move2 = 0; move1 = -delta; }

    const movedIds = new Set<string>();
    const updatedEntities = sketch.entities.map((e) => {
      if (e.id === target.id && move1 !== 0) {
        movedIds.add(e.id);
        if (e.type === 'circle') return { ...e, center: { x: e.center.x + nx * move1, y: e.center.y + ny * move1 } };
        if (e.type === 'point') return { ...e, position: { x: e.position.x + nx * move1, y: e.position.y + ny * move1 } };
        if (e.type === 'rectangle') return { ...e, center: { x: e.center.x + nx * move1, y: e.center.y + ny * move1 } };
      }
      if (e.id === target2.id && move2 !== 0) {
        movedIds.add(e.id);
        if (e.type === 'rectangle') return { ...e, center: { x: e.center.x + nx * move2, y: e.center.y + ny * move2 } };
        if (e.type === 'line') {
          const [qi1, qi2] = getSegmentPointIndices(target2 as import('@/types/document').LineEntity, dim.segmentIndex2 ?? 0);
          return { ...e, points: (e as import('@/types/document').LineEntity).points.map((pt, i) =>
            (i === qi1 || i === qi2) ? { x: pt.x + nx * move2, y: pt.y + ny * move2 } : pt,
          ) };
        }
      }
      return e;
    });
    const solved = solveConstraints(updatedEntities, sketch.constraints, { movedIds });
    return solved.entities;
  }

  // Two-segment dimension (distance or angle)
  if (dim.targetEntityId2 != null) {
    const target2 = sketch.entities.find((e) => e.id === dim.targetEntityId2);
    if (!target2) return null;

    const ep1 = getEntitySegmentEndpoints(target, dim.segmentIndex);
    const ep2 = getEntitySegmentEndpoints(target2, dim.segmentIndex2 ?? 0);
    if (!ep1 || !ep2) return null;
    const [p1, p2] = ep1;
    const [q1, q2] = ep2;

    // Angle dimension: rotate segments to match new angle (line+line only)
    if (dim.angleMode && target.type === 'line' && target2.type === 'line') {
      const idx1 = dim.segmentIndex;
      const idx2 = dim.segmentIndex2!;
      const [pi1, pi2] = getSegmentPointIndices(target, idx1);
      const [qi1, qi2] = getSegmentPointIndices(target2, idx2);
      const ix = lineLineIntersection(p1, p2, q1, q2);
      if (!ix) return null;

      const mid1x = (p1.x + p2.x) / 2 - ix.x;
      const mid1y = (p1.y + p2.y) / 2 - ix.y;
      const mid2x = (q1.x + q2.x) / 2 - ix.x;
      const mid2y = (q1.y + q2.y) / 2 - ix.y;
      const startAngle = Math.atan2(mid1y, mid1x);
      const endAngle = Math.atan2(mid2y, mid2x);
      let sweep = endAngle - startAngle;
      while (sweep > Math.PI) sweep -= 2 * Math.PI;
      while (sweep < -Math.PI) sweep += 2 * Math.PI;
      const currentAngleDeg = Math.abs(sweep) * 180 / Math.PI;
      const deltaRad = (newValue - currentAngleDeg) * Math.PI / 180;
      const signedDelta = sweep >= 0 ? deltaRad : -deltaRad;

      const target1Fixed = sketch.constraints.some((c) => c.type === 'fixed' && c.entityId === target.id);
      const target2Fixed = sketch.constraints.some((c) => c.type === 'fixed' && c.entityId === target2.id);
      if (target1Fixed && target2Fixed) return null;

      let rot1 = -signedDelta / 2;
      let rot2 = signedDelta / 2;
      if (target1Fixed) { rot1 = 0; rot2 = signedDelta; }
      if (target2Fixed) { rot2 = 0; rot1 = -signedDelta; }

      const sameEntityAngle = target.id === target2.id;
      const movedIds = new Set<string>();
      const updatedEntities = sketch.entities.map((e) => {
        if (e.type !== 'line') return e;
        if ('sourceId' in e && e.sourceId) return e;

        if (sameEntityAngle && e.id === target.id && (rot1 !== 0 || rot2 !== 0)) {
          movedIds.add(e.id);
          return {
            ...e,
            points: e.points.map((pt, i) => {
              if ((i === pi1 || i === pi2) && rot1 !== 0) return rotatePoint(pt, ix, rot1);
              if ((i === qi1 || i === qi2) && rot2 !== 0) return rotatePoint(pt, ix, rot2);
              return pt;
            }),
          };
        }
        if (!sameEntityAngle && e.id === target.id && rot1 !== 0) {
          movedIds.add(e.id);
          return {
            ...e,
            points: e.points.map((pt, i) =>
              (i === pi1 || i === pi2) ? rotatePoint(pt, ix, rot1) : pt,
            ),
          };
        }
        if (!sameEntityAngle && e.id === target2.id && rot2 !== 0) {
          movedIds.add(e.id);
          return {
            ...e,
            points: e.points.map((pt, i) =>
              (i === qi1 || i === qi2) ? rotatePoint(pt, ix, rot2) : pt,
            ),
          };
        }
        return e;
      });
      const solved = solveConstraints(updatedEntities, sketch.constraints, { movedIds });
      return solved.entities;
    }

    const a = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
    const dx = q2.x - q1.x;
    const dy = q2.y - q1.y;
    const lenSq = dx * dx + dy * dy;
    if (lenSq === 0) return null;
    const t = ((a.x - q1.x) * dx + (a.y - q1.y) * dy) / lenSq;
    const b = { x: q1.x + t * dx, y: q1.y + t * dy };
    const dist = Math.sqrt((b.x - a.x) ** 2 + (b.y - a.y) ** 2);
    if (dist === 0) return null;
    const nx = (b.x - a.x) / dist;
    const ny = (b.y - a.y) / dist;
    const delta = newValue - dist;

    const target1Fixed = sketch.constraints.some((c) => c.type === 'fixed' && c.entityId === target.id);
    const target2Fixed = sketch.constraints.some((c) => c.type === 'fixed' && c.entityId === target2.id);
    if (target1Fixed && target2Fixed) return null;

    let move1 = -delta / 2;
    let move2 = delta / 2;
    if (target1Fixed) { move1 = 0; move2 = delta; }
    if (target2Fixed) { move2 = 0; move1 = -delta; }

    /** Translate a single entity by (nx*move, ny*move). For lines, only the
     *  two segment-endpoint indices are shifted; for rectangles the whole center moves. */
    const translateEntity = (e: Entity, move: number, segPointIndices: [number, number]): Entity => {
      if ('sourceId' in e && (e as { sourceId?: unknown }).sourceId) return e;
      if (e.type === 'line') {
        const [i1, i2] = segPointIndices;
        return {
          ...e,
          points: e.points.map((pt, i) =>
            (i === i1 || i === i2) ? { x: pt.x + nx * move, y: pt.y + ny * move } : pt,
          ),
        };
      }
      if (e.type === 'rectangle') {
        return { ...e, center: { x: e.center.x + nx * move, y: e.center.y + ny * move } };
      }
      return e;
    };

    const sameEntity = target.id === target2.id;
    const movedIds = new Set<string>();

    let pi1 = 0, pi2 = 1, qi1 = 0, qi2 = 1;
    if (target.type === 'line') {
      [pi1, pi2] = getSegmentPointIndices(target, dim.segmentIndex);
    }
    if (target2.type === 'line') {
      [qi1, qi2] = getSegmentPointIndices(target2, dim.segmentIndex2 ?? 0);
    }

    const updatedEntities = sketch.entities.map((e) => {
      if (sameEntity && e.id === target.id && (move1 !== 0 || move2 !== 0)) {
        movedIds.add(e.id);
        if (e.type === 'line') {
          return {
            ...e,
            points: e.points.map((pt, i) => {
              if ((i === pi1 || i === pi2) && move1 !== 0)
                return { x: pt.x + nx * move1, y: pt.y + ny * move1 };
              if ((i === qi1 || i === qi2) && move2 !== 0)
                return { x: pt.x + nx * move2, y: pt.y + ny * move2 };
              return pt;
            }),
          };
        }
        // Same-entity rectangle (unusual but handle gracefully)
        if (e.type === 'rectangle') {
          return { ...e, center: { x: e.center.x + nx * ((move1 + move2) / 2), y: e.center.y + ny * ((move1 + move2) / 2) } };
        }
      }
      if (!sameEntity && e.id === target.id && move1 !== 0) {
        movedIds.add(e.id);
        return translateEntity(e, move1, [pi1, pi2]);
      }
      if (!sameEntity && e.id === target2.id && move2 !== 0) {
        movedIds.add(e.id);
        return translateEntity(e, move2, [qi1, qi2]);
      }
      return e;
    });
    const solved = solveConstraints(updatedEntities, sketch.constraints, { movedIds });
    return solved.entities;
  }

  if ('sourceId' in target && target.sourceId) return null; // locked

  // Helper: adjust a single segment's length on a line entity
  const adjustSegLen = (entities: Entity[], targetValue: number): Entity[] =>
    entities.map((e) => {
      if (e.id !== target.id) return e;
      if (e.type === 'line') {
        // Polygon apothem dimension
        if (dim.segmentIndex === -1 && e.polygonCenter) {
          const center = e.polygonCenter;
          const midA = {
            x: (e.points[0]!.x + e.points[1]!.x) / 2,
            y: (e.points[0]!.y + e.points[1]!.y) / 2,
          };
          const curApothem = Math.sqrt((midA.x - center.x) ** 2 + (midA.y - center.y) ** 2);
          if (curApothem === 0) return e;
          const scale = targetValue / curApothem;
          return {
            ...e,
            points: e.points.map((p) => ({
              x: center.x + (p.x - center.x) * scale,
              y: center.y + (p.y - center.y) * scale,
            })),
          };
        }
        // Polygon segment dimension: scale uniformly to preserve regularity
        if (e.polygonCenter) {
          const idx = dim.segmentIndex;
          if (idx < 0 || idx >= getSegmentCount(e)) return e;
          const [pdi1, pdi2] = getSegmentPointIndices(e, idx);
          const pa = e.points[pdi1]!;
          const pb = e.points[pdi2]!;
          const curLen = Math.sqrt((pb.x - pa.x) ** 2 + (pb.y - pa.y) ** 2);
          if (curLen === 0) return e;
          const scale = targetValue / curLen;
          const center = e.polygonCenter;
          return {
            ...e,
            points: e.points.map((p) => ({
              x: center.x + (p.x - center.x) * scale,
              y: center.y + (p.y - center.y) * scale,
            })),
          };
        }
        const idx = dim.segmentIndex;
        if (idx < 0 || idx >= getSegmentCount(e)) return e;
        const [dsi1, dsi2] = getSegmentPointIndices(e, idx);
        const pa = e.points[dsi1]!;
        const pb = e.points[dsi2]!;
        const dx = pb.x - pa.x;
        const dy = pb.y - pa.y;
        const len = Math.sqrt(dx * dx + dy * dy);
        if (len === 0) return e;
        const dirX = dx / len;
        const dirY = dy / len;
        const newPoints = [...e.points];
        if (getSegmentCount(e) === 1) {
          newPoints[dsi2] = {
            x: pa.x + dirX * targetValue,
            y: pa.y + dirY * targetValue,
          };
        } else {
          const midX = (pa.x + pb.x) / 2;
          const midY = (pa.y + pb.y) / 2;
          const half = targetValue / 2;
          newPoints[dsi1] = { x: midX - dirX * half, y: midY - dirY * half };
          newPoints[dsi2] = { x: midX + dirX * half, y: midY + dirY * half };
        }
        return { ...e, points: newPoints };
      }
      if (e.type === 'circle') {
        return { ...e, radius: targetValue / 2 };
      }
      if (e.type === 'rectangle') {
        if (dim.segmentIndex === 0) {
          return { ...e, width: targetValue };
        } else {
          return { ...e, height: targetValue };
        }
      }
      return e;
    });

  // Helper: measure the current segment length after solver
  const measureSegLen = (entities: Entity[]): number | null => {
    const e = entities.find((ent) => ent.id === target.id);
    if (!e || e.type === 'circle') return e ? (e as import('@/types/document').CircleEntity).radius * 2 : null;
    if (e.type === 'rectangle') return dim.segmentIndex === 0 ? e.width : e.height;
    if (e.type !== 'line') return null;
    if (dim.segmentIndex === -1 && e.polygonCenter) {
      const midA = { x: (e.points[0]!.x + e.points[1]!.x) / 2, y: (e.points[0]!.y + e.points[1]!.y) / 2 };
      return Math.sqrt((midA.x - e.polygonCenter.x) ** 2 + (midA.y - e.polygonCenter.y) ** 2);
    }
    const idx = dim.segmentIndex;
    if (idx < 0 || idx >= getSegmentCount(e)) return null;
    const [i1, i2] = getSegmentPointIndices(e, idx);
    const a = e.points[i1]!;
    const b = e.points[i2]!;
    return Math.sqrt((b.x - a.x) ** 2 + (b.y - a.y) ** 2);
  };

  // Iterative correction: adjust, solve, measure, overshoot to compensate
  let aim = newValue;
  let currentEntities = sketch.entities;
  for (let iter = 0; iter < 5; iter++) {
    const adjusted = adjustSegLen(currentEntities, aim);
    const solved = solveConstraints(adjusted, sketch.constraints, { movedIds: new Set([target.id]) });
    currentEntities = solved.entities;
    const achieved = measureSegLen(currentEntities);
    if (achieved == null) break;
    const error = newValue - achieved;
    if (Math.abs(error) < 0.01) break;
    aim += error; // overshoot next iteration to compensate
  }

  return currentEntities;
}

/** A dimension expression that couldn't be evaluated: it uses names that
 *  aren't parameters, so the dimension keeps its last solved value. */
export interface ResolveWarning {
  sketch: string;
  dimensionId: string;
  expression: string;
  missing: string[];
}

export interface Resolved {
  /** the input sketch itself when nothing moved, else a new one */
  sketch: Sketch;
  changed: boolean;
  warnings: ResolveWarning[];
}

/** Whether a sketch's dimension expressions use any of `names`. */
export function usesNames(sketch: Sketch, names: Iterable<string>): boolean {
  const set = new Set(names);
  return sketch.entities.some((e) => e.type === 'dimension' && !!e.expression
    && expressionNames(e.expression).some((n) => set.has(n)));
}

/** The sketch with every expression dimension set from `vars` and the
 *  constraints re-solved, one dimension after another (as the editor does).
 *  A dimension whose expression names something not in `vars` is left as it
 *  is and reported; one on a broken reference edge (its face edge is gone) is
 *  left as it is; one that is driven by others, or evaluates to zero or
 *  less, is left alone. Pure: neither the sketch nor the undo history is
 *  touched. */
export function resolveSketch(sketch: Sketch, vars: Record<string, number>): Resolved {
  let entities = sketch.entities;
  const warnings: ResolveWarning[] = [];
  const broken = brokenIds(sketch.entities);
  for (const dim of sketch.entities) {
    if (dim.type !== 'dimension' || !dim.expression || onBroken(dim, broken)) continue;
    const missing = expressionNames(dim.expression).filter((n) => !Object.prototype.hasOwnProperty.call(vars, n));
    if (missing.length) {
      warnings.push({ sketch: sketch.name, dimensionId: dim.id, expression: dim.expression, missing });
      continue;
    }
    let v: number;
    try {
      v = evaluateExpression(dim.expression, vars);
    } catch {
      continue;
    }
    if (!isFinite(v) || v <= 0) continue;
    const next = dimensionEntities({ ...sketch, entities }, dim.id, v);
    if (Array.isArray(next)) entities = next;
  }
  const changed = !sameGeometry(sketch.entities, entities);
  return { sketch: changed ? { ...sketch, entities } : sketch, changed, warnings };
}

/** Two entity lists alike to within `tol` in every number (the solver's
 *  round-off isn't a change). */
export function sameGeometry(a: unknown, b: unknown, tol = 1e-6): boolean {
  if (a === b) return true;
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) <= tol;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => sameGeometry(x, b[i], tol));
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a).filter((k) => (a as Record<string, unknown>)[k] !== undefined);
    const kb = Object.keys(b).filter((k) => (b as Record<string, unknown>)[k] !== undefined);
    return ka.length === kb.length
      && ka.every((k) => sameGeometry((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], tol));
  }
  return false;
}
