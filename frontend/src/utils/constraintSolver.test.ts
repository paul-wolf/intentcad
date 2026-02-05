import { describe, it, expect } from 'vitest';
import { solveConstraints } from './constraintSolver';
import { getSegmentCount, getSegmentPointIndices } from './lineSegments';
import type { Entity, Constraint, LineEntity } from '@/types/document';

function segmentLength(entity: LineEntity, segIdx: number): number {
  const [i1, i2] = getSegmentPointIndices(entity, segIdx);
  const a = entity.points[i1]!;
  const b = entity.points[i2]!;
  return Math.sqrt((b.x - a.x) ** 2 + (b.y - a.y) ** 2);
}

function distanceBetweenParallelSegments(entity: LineEntity, seg1: number, seg2: number): number {
  const [i1, i2] = getSegmentPointIndices(entity, seg1);
  const [j1, j2] = getSegmentPointIndices(entity, seg2);
  const a = { x: (entity.points[i1]!.x + entity.points[i2]!.x) / 2, y: (entity.points[i1]!.y + entity.points[i2]!.y) / 2 };
  const q1 = entity.points[j1]!;
  const q2 = entity.points[j2]!;
  const dx = q2.x - q1.x;
  const dy = q2.y - q1.y;
  const lenSq = dx * dx + dy * dy;
  const t = ((a.x - q1.x) * dx + (a.y - q1.y) * dy) / lenSq;
  const b = { x: q1.x + t * dx, y: q1.y + t * dy };
  return Math.sqrt((b.x - a.x) ** 2 + (b.y - a.y) ** 2);
}

/**
 * Simulate what applyDimensionValue does for a single-segment dimension:
 * adjust the segment endpoints then run the solver.
 */
function adjustSegLen(
  entities: Entity[],
  entityId: string,
  segIdx: number,
  targetValue: number,
): Entity[] {
  return entities.map((e) => {
    if (e.id !== entityId || e.type !== 'line') return e;
    const le = e as LineEntity;
    if (segIdx < 0 || segIdx >= getSegmentCount(le)) return e;
    const [dsi1, dsi2] = getSegmentPointIndices(le, segIdx);
    const pa = le.points[dsi1]!;
    const pb = le.points[dsi2]!;
    const dx = pb.x - pa.x;
    const dy = pb.y - pa.y;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len === 0) return e;
    const dirX = dx / len;
    const dirY = dy / len;
    const newPoints = [...le.points];
    if (getSegmentCount(le) === 1) {
      newPoints[dsi2] = { x: pa.x + dirX * targetValue, y: pa.y + dirY * targetValue };
    } else {
      const midX = (pa.x + pb.x) / 2;
      const midY = (pa.y + pb.y) / 2;
      const half = targetValue / 2;
      newPoints[dsi1] = { x: midX - dirX * half, y: midY - dirY * half };
      newPoints[dsi2] = { x: midX + dirX * half, y: midY + dirY * half };
    }
    return { ...le, points: newPoints };
  });
}

function measureSegLen(entities: Entity[], entityId: string, segIdx: number): number {
  const e = entities.find((ent) => ent.id === entityId) as LineEntity;
  const [i1, i2] = getSegmentPointIndices(e, segIdx);
  const a = e.points[i1]!;
  const b = e.points[i2]!;
  return Math.sqrt((b.x - a.x) ** 2 + (b.y - a.y) ** 2);
}

function applySegmentDimension(
  entities: Entity[],
  constraints: Constraint[],
  entityId: string,
  segIdx: number,
  newValue: number,
): Entity[] {
  let aim = newValue;
  let currentEntities = entities;
  for (let iter = 0; iter < 5; iter++) {
    const adjusted = adjustSegLen(currentEntities, entityId, segIdx, aim);
    const solved = solveConstraints(adjusted, constraints, { movedIds: new Set([entityId]) });
    currentEntities = solved.entities;
    const achieved = measureSegLen(currentEntities, entityId, segIdx);
    const error = newValue - achieved;
    if (Math.abs(error) < 0.01) break;
    aim += error;
  }
  return currentEntities;
}

/**
 * Simulate what applyDimensionValue does for a two-segment distance dimension:
 * move both segments' endpoints apart, then run the solver.
 */
function applyTwoSegmentDimension(
  entities: Entity[],
  constraints: Constraint[],
  entityId1: string,
  seg1: number,
  entityId2: string,
  seg2: number,
  newValue: number,
): Entity[] {
  // Compute current geometry
  const target = entities.find((e) => e.id === entityId1) as LineEntity;
  const target2 = entities.find((e) => e.id === entityId2) as LineEntity;
  const [pi1, pi2] = getSegmentPointIndices(target, seg1);
  const [qi1, qi2] = getSegmentPointIndices(target2, seg2);
  const p1 = target.points[pi1]!;
  const p2 = target.points[pi2]!;
  const q1 = target2.points[qi1]!;
  const q2 = target2.points[qi2]!;
  const a = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
  const dx = q2.x - q1.x;
  const dy = q2.y - q1.y;
  const lenSq = dx * dx + dy * dy;
  const t = ((a.x - q1.x) * dx + (a.y - q1.y) * dy) / lenSq;
  const b = { x: q1.x + t * dx, y: q1.y + t * dy };
  const dist = Math.sqrt((b.x - a.x) ** 2 + (b.y - a.y) ** 2);
  const nx = (b.x - a.x) / dist;
  const ny = (b.y - a.y) / dist;
  const delta = newValue - dist;
  const move1 = -delta / 2;
  const move2 = delta / 2;
  const sameEntity = entityId1 === entityId2;

  const updated = entities.map((e) => {
    if (e.type !== 'line') return e;
    if (sameEntity && e.id === entityId1) {
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
    if (!sameEntity && e.id === entityId1 && move1 !== 0) {
      return {
        ...e,
        points: e.points.map((pt, i) =>
          (i === pi1 || i === pi2) ? { x: pt.x + nx * move1, y: pt.y + ny * move1 } : pt,
        ),
      };
    }
    if (!sameEntity && e.id === entityId2 && move2 !== 0) {
      return {
        ...e,
        points: e.points.map((pt, i) =>
          (i === qi1 || i === qi2) ? { x: pt.x + nx * move2, y: pt.y + ny * move2 } : pt,
        ),
      };
    }
    return e;
  });
  const movedIds = new Set<string>();
  if (move1 !== 0) movedIds.add(entityId1);
  if (move2 !== 0) movedIds.add(entityId2);
  const solved = solveConstraints(updated, constraints, { movedIds });
  return solved.entities;
}

// --- Test data: the user's closed trapezoid ---

const ENTITY_ID = 'ln_VmB9TRtWjP';

function makeTrapezoid(): LineEntity {
  return {
    id: ENTITY_ID,
    type: 'line',
    points: [
      { x: -110, y: -100 },
      { x: -80, y: -100 },
      { x: -115, y: -60 },
      { x: -75, y: -60 },
    ],
    closed: true,
  };
}

// Segments:
// 0: (-110,-100)→(-80,-100)  top horizontal, length 30
// 1: (-80,-100)→(-115,-60)   left diagonal,  length ~51.48
// 2: (-115,-60)→(-75,-60)    bottom horizontal, length 40
// 3: (-75,-60)→(-110,-100)   right diagonal (closing), length ~51.48

const CONSTRAINTS: Constraint[] = [
  { id: 'h0', type: 'horizontal', entityId: ENTITY_ID, segmentIndex: 0 },
  { id: 'h2', type: 'horizontal', entityId: ENTITY_ID, segmentIndex: 2 },
  { id: 'eq', type: 'equal', entityId: ENTITY_ID, targetEntityId: ENTITY_ID, segmentIndex: 1, targetSegmentIndex: 3 },
];

describe('applyDimensionValue on closed polyline', () => {
  it('two-segment dimension between horizontal lines should achieve exact distance', () => {
    const entities: Entity[] = [makeTrapezoid()];
    const result = applyTwoSegmentDimension(entities, CONSTRAINTS, ENTITY_ID, 0, ENTITY_ID, 2, 55);
    const line = result.find((e) => e.id === ENTITY_ID) as LineEntity;

    const dist = distanceBetweenParallelSegments(line, 0, 2);
    expect(dist).toBeCloseTo(55, 1);

    // Horizontal constraints still satisfied
    expect(line.points[0]!.y).toBeCloseTo(line.points[1]!.y, 6);
    expect(line.points[2]!.y).toBeCloseTo(line.points[3]!.y, 6);

    // Equal diagonals still satisfied
    const len1 = segmentLength(line, 1);
    const len3 = segmentLength(line, 3);
    expect(len1).toBeCloseTo(len3, 1);
  });

  it('single-segment dimension on closing diagonal should achieve exact length', () => {
    const entities: Entity[] = [makeTrapezoid()];
    const targetLen = 55;
    const result = applySegmentDimension(entities, CONSTRAINTS, ENTITY_ID, 3, targetLen);
    const line = result.find((e) => e.id === ENTITY_ID) as LineEntity;

    const actualLen = segmentLength(line, 3);
    expect(actualLen).toBeCloseTo(targetLen, 1);

    // Horizontal constraints still satisfied
    expect(line.points[0]!.y).toBeCloseTo(line.points[1]!.y, 6);
    expect(line.points[2]!.y).toBeCloseTo(line.points[3]!.y, 6);

    // Equal diagonals still satisfied
    const len1 = segmentLength(line, 1);
    const len3 = segmentLength(line, 3);
    expect(len1).toBeCloseTo(len3, 1);
  });

  it('single-segment dimension on segment 1 (non-closing diagonal) should achieve exact length', () => {
    const entities: Entity[] = [makeTrapezoid()];
    const targetLen = 60;
    const result = applySegmentDimension(entities, CONSTRAINTS, ENTITY_ID, 1, targetLen);
    const line = result.find((e) => e.id === ENTITY_ID) as LineEntity;

    const actualLen = segmentLength(line, 1);
    expect(actualLen).toBeCloseTo(targetLen, 1);

    // Horizontal constraints still satisfied
    expect(line.points[0]!.y).toBeCloseTo(line.points[1]!.y, 6);
    expect(line.points[2]!.y).toBeCloseTo(line.points[3]!.y, 6);
  });

  it('single-segment dimension on top horizontal should achieve exact length', () => {
    const entities: Entity[] = [makeTrapezoid()];
    const targetLen = 20;
    const result = applySegmentDimension(entities, CONSTRAINTS, ENTITY_ID, 0, targetLen);
    const line = result.find((e) => e.id === ENTITY_ID) as LineEntity;

    const actualLen = segmentLength(line, 0);
    expect(actualLen).toBeCloseTo(targetLen, 1);

    // Horizontal constraints still satisfied
    expect(line.points[0]!.y).toBeCloseTo(line.points[1]!.y, 6);
    expect(line.points[2]!.y).toBeCloseTo(line.points[3]!.y, 6);
  });
});
