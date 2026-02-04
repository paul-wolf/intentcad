import type { Constraint, Entity, Point, EqualConstraint, CoincidentConstraint, HorizontalConstraint, VerticalConstraint, MidpointConstraint, ParallelConstraint, PerpendicularConstraint, TangentConstraint, BisectConstraint, LineEntity, CircleEntity } from '@/types/document';
import { propagateDerived } from '@/utils/propagate';
import { rotatePoint } from '@/utils/geometry';
import { getEntityPoint, setEntityPoint } from '@/utils/entityPoints';

// --- Validation API ---

export interface ValidationResult {
  valid: boolean;
  reason?: string;
  /** Constraint IDs that should be auto-removed (e.g., H supersedes V on same segment) */
  supersedes?: string[];
}

export function validateConstraint(
  proposed: Constraint,
  existing: Constraint[],
  entities: Entity[],
): ValidationResult {
  // Self-constraint check (same entity + same indices)
  if ('targetEntityId' in proposed) {
    const p = proposed as Constraint & { targetEntityId: string };
    if (p.entityId === p.targetEntityId) {
      // For segment-based constraints, check segment indices too
      if ('segmentIndex' in p && 'targetSegmentIndex' in p) {
        if ((p as any).segmentIndex === (p as any).targetSegmentIndex) {
          return { valid: false, reason: 'Cannot constrain a segment to itself' };
        }
      } else if ('pointIndex' in p && 'targetPointIndex' in p) {
        if ((p as any).pointIndex === (p as any).targetPointIndex) {
          return { valid: false, reason: 'Cannot constrain a point to itself' };
        }
      } else {
        return { valid: false, reason: 'Cannot constrain an entity to itself' };
      }
    }
  }

  // Both entities fixed check
  if ('targetEntityId' in proposed) {
    const p = proposed as Constraint & { targetEntityId: string };
    const fixedIds = getFixedIds(existing);
    if (fixedIds.has(p.entityId) && fixedIds.has(p.targetEntityId)) {
      return { valid: false, reason: 'Both entities are fixed' };
    }
  }

  // Duplicate check for two-entity constraints
  if ('targetEntityId' in proposed) {
    const p = proposed as Constraint & { targetEntityId: string };
    const isDuplicate = existing.some((c) => {
      if (c.type !== proposed.type) return false;
      if (!('targetEntityId' in c)) return false;
      const ec = c as Constraint & { targetEntityId: string };
      return (
        (ec.entityId === p.entityId && ec.targetEntityId === p.targetEntityId) ||
        (ec.entityId === p.targetEntityId && ec.targetEntityId === p.entityId)
      );
    });
    if (isDuplicate) {
      return { valid: false, reason: 'Duplicate constraint' };
    }
  }

  // Equal constraint: must be same geometric type, no point/dimension
  if (proposed.type === 'equal') {
    const p = proposed as EqualConstraint;
    const entityMap = new Map(entities.map((e) => [e.id, e]));
    const e1 = entityMap.get(p.entityId);
    const e2 = entityMap.get(p.targetEntityId);
    if (!e1 || !e2) return { valid: false, reason: 'Entity not found' };
    if (e1.type !== e2.type) return { valid: false, reason: 'Different entity types' };
    if (e1.type === 'point' || e1.type === 'dimension') {
      return { valid: false, reason: 'Cannot apply equal constraint to points or dimensions' };
    }
  }

  // Parallel/perpendicular vs H/V conflicts
  if (proposed.type === 'parallel' || proposed.type === 'perpendicular') {
    const p = proposed as ParallelConstraint | PerpendicularConstraint;
    if (segmentHasHVConstraint(existing, p.entityId, p.segmentIndex)) {
      return { valid: false, reason: 'Segment has a horizontal/vertical constraint' };
    }
    if (segmentHasHVConstraint(existing, p.targetEntityId, p.targetSegmentIndex)) {
      return { valid: false, reason: 'Target segment has a horizontal/vertical constraint' };
    }
  }

  // H/V vs parallel/perpendicular conflicts
  if (proposed.type === 'horizontal' || proposed.type === 'vertical') {
    const p = proposed as HorizontalConstraint | VerticalConstraint;
    if (segmentHasDirectionalConstraint(existing, p.entityId, p.segmentIndex)) {
      return { valid: false, reason: 'Segment has a parallel/perpendicular constraint' };
    }

    // H supersedes V, V supersedes H
    const oppositeType = proposed.type === 'horizontal' ? 'vertical' : 'horizontal';
    const superseded = existing.filter(
      (c) => c.type === oppositeType && c.entityId === p.entityId &&
             (c as HorizontalConstraint | VerticalConstraint).segmentIndex === p.segmentIndex,
    );
    if (superseded.length > 0) {
      return { valid: true, supersedes: superseded.map((c) => c.id) };
    }
  }

  return { valid: true };
}

// --- Solve API ---

export interface SolveResult {
  entities: Entity[];
  converged: boolean;
  iterations: number;
}

export interface SolveOptions {
  movedIds?: Set<string>;
  maxIterations?: number;  // default 10
  tolerance?: number;      // default 1e-6
}

export function solveConstraints(
  entities: Entity[],
  constraints: Constraint[],
  options?: SolveOptions,
): SolveResult {
  const maxIterations = options?.maxIterations ?? 10;
  const tolerance = options?.tolerance ?? 1e-6;
  let movedIds = options?.movedIds ?? new Set(entities.map((e) => e.id));

  const entityMap = new Map(entities.map((e) => [e.id, e]));
  const fixedIds = getFixedIds(constraints);

  let converged = false;
  let iteration = 0;

  for (; iteration < maxIterations; iteration++) {
    const before = snapshotPositions(entityMap);

    enforceCoincident(entityMap, constraints, fixedIds, movedIds);
    enforceMidpoint(entityMap, constraints, fixedIds);
    enforceEqual(entityMap, constraints);
    enforceParallel(entityMap, constraints, fixedIds);
    enforcePerpendicular(entityMap, constraints, fixedIds);
    enforceTangent(entityMap, constraints, fixedIds);
    enforceBisect(entityMap, constraints, fixedIds);
    enforceHorizontalVertical(entityMap, constraints, fixedIds);

    const after = snapshotPositions(entityMap);
    const maxDelta = computeMaxDelta(before, after);

    if (maxDelta < tolerance) {
      converged = true;
      break;
    }

    // Keep original movedIds throughout — the outer convergence loop
    // handles propagation; expanding to all IDs would break coincident BFS.
  }

  const result = entities.map((e) => entityMap.get(e.id) ?? e);
  return { entities: propagateDerived(result), converged, iterations: iteration + 1 };
}

// --- Internal helpers ---

function getFixedIds(constraints: Constraint[]): Set<string> {
  const ids = new Set<string>();
  for (const c of constraints) {
    if (c.type === 'fixed') ids.add(c.entityId);
  }
  return ids;
}

function segmentHasDirectionalConstraint(
  constraints: Constraint[],
  entityId: string,
  segmentIndex: number,
): boolean {
  return constraints.some((c) => {
    if (c.type === 'parallel' || c.type === 'perpendicular') {
      if (c.entityId === entityId && c.segmentIndex === segmentIndex) return true;
      if (c.targetEntityId === entityId && c.targetSegmentIndex === segmentIndex) return true;
    }
    return false;
  });
}

function segmentHasHVConstraint(
  constraints: Constraint[],
  entityId: string,
  segmentIndex: number,
): boolean {
  return constraints.some((c) => {
    if ((c.type === 'horizontal' || c.type === 'vertical') &&
        c.entityId === entityId && c.segmentIndex === segmentIndex) {
      return true;
    }
    return false;
  });
}

/** Snapshot all entity positions into a flat Float64Array for convergence comparison. */
function snapshotPositions(entityMap: Map<string, Entity>): Float64Array {
  const values: number[] = [];
  for (const e of entityMap.values()) {
    switch (e.type) {
      case 'line':
        for (const p of e.points) { values.push(p.x, p.y); }
        if (e.polygonCenter) { values.push(e.polygonCenter.x, e.polygonCenter.y); }
        break;
      case 'circle':
        values.push(e.center.x, e.center.y, e.radius);
        break;
      case 'rectangle':
        values.push(e.center.x, e.center.y, e.width, e.height);
        break;
      case 'point':
        values.push(e.position.x, e.position.y);
        break;
    }
  }
  return new Float64Array(values);
}

function computeMaxDelta(a: Float64Array, b: Float64Array): number {
  let max = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const d = Math.abs(a[i]! - b[i]!);
    if (d > max) max = d;
  }
  return max;
}

/** Make target entity's size match source entity's size. Returns null if incompatible. */
function matchEntitySize(target: Entity, source: Entity): Entity | null {
  if (target.type !== source.type) return null;

  if (source.type === 'circle' && target.type === 'circle') {
    return { ...target, radius: source.radius };
  }

  if (source.type === 'rectangle' && target.type === 'rectangle') {
    return { ...target, width: source.width, height: source.height };
  }

  if (source.type === 'line' && target.type === 'line') {
    // Polygons: scale apothem to match
    if (source.polygonCenter && target.polygonCenter) {
      const srcMid = { x: (source.points[0]!.x + source.points[1]!.x) / 2, y: (source.points[0]!.y + source.points[1]!.y) / 2 };
      const srcApothem = Math.sqrt((srcMid.x - source.polygonCenter.x) ** 2 + (srcMid.y - source.polygonCenter.y) ** 2);
      const tgtMid = { x: (target.points[0]!.x + target.points[1]!.x) / 2, y: (target.points[0]!.y + target.points[1]!.y) / 2 };
      const tgtApothem = Math.sqrt((tgtMid.x - target.polygonCenter.x) ** 2 + (tgtMid.y - target.polygonCenter.y) ** 2);
      if (tgtApothem === 0) return null;
      const scale = srcApothem / tgtApothem;
      const center = target.polygonCenter;
      return { ...target, points: target.points.map((p) => ({ x: center.x + (p.x - center.x) * scale, y: center.y + (p.y - center.y) * scale })) };
    }

    // Regular lines: scale total length around centroid
    let srcLen = 0;
    for (let i = 0; i < source.points.length - 1; i++) {
      srcLen += Math.sqrt((source.points[i + 1]!.x - source.points[i]!.x) ** 2 + (source.points[i + 1]!.y - source.points[i]!.y) ** 2);
    }
    let tgtLen = 0;
    for (let i = 0; i < target.points.length - 1; i++) {
      tgtLen += Math.sqrt((target.points[i + 1]!.x - target.points[i]!.x) ** 2 + (target.points[i + 1]!.y - target.points[i]!.y) ** 2);
    }
    if (tgtLen === 0) return null;
    const scale = srcLen / tgtLen;
    const cx = target.points.reduce((s, p) => s + p.x, 0) / target.points.length;
    const cy = target.points.reduce((s, p) => s + p.y, 0) / target.points.length;
    return { ...target, points: target.points.map((p) => ({ x: cx + (p.x - cx) * scale, y: cy + (p.y - cy) * scale })) };
  }

  return null;
}

/** Get the two endpoints of a segment on an entity. */
function getSegmentEndpoints(entity: Entity, segmentIndex: number): [Point, Point] | null {
  if (entity.type === 'line') {
    const a = entity.points[segmentIndex];
    const b = entity.points[segmentIndex + 1];
    if (!a || !b) return null;
    return [a, b];
  }
  if (entity.type === 'rectangle') {
    const hw = entity.width / 2;
    const hh = entity.height / 2;
    const c = entity.center;
    const corners: Point[] = [
      { x: c.x - hw, y: c.y + hh }, // TL
      { x: c.x + hw, y: c.y + hh }, // TR
      { x: c.x + hw, y: c.y - hh }, // BR
      { x: c.x - hw, y: c.y - hh }, // BL
    ];
    const a = corners[segmentIndex];
    const b = corners[(segmentIndex + 1) % 4];
    if (!a || !b) return null;
    return [a, b];
  }
  return null;
}

/** Translate an entity by (dx, dy). */
function translateEntity(entity: Entity, dx: number, dy: number): Entity | null {
  switch (entity.type) {
    case 'line':
      return {
        ...entity,
        points: entity.points.map((p) => ({ x: p.x + dx, y: p.y + dy })),
        ...(entity.polygonCenter ? {
          polygonCenter: { x: entity.polygonCenter.x + dx, y: entity.polygonCenter.y + dy },
        } : {}),
      };
    case 'circle':
      return { ...entity, center: { x: entity.center.x + dx, y: entity.center.y + dy } };
    case 'rectangle':
      return { ...entity, center: { x: entity.center.x + dx, y: entity.center.y + dy } };
    case 'point':
      return { ...entity, position: { x: entity.position.x + dx, y: entity.position.y + dy } };
    default:
      return null;
  }
}

/** Rotate a polygon so that the segment at segmentIndex becomes horizontal or vertical. */
function snapPolygonForHV(entity: LineEntity, segmentIndex: number, type: 'horizontal' | 'vertical'): LineEntity {
  if (!entity.polygonCenter) return entity;
  const pa = entity.points[segmentIndex]!;
  const pb = entity.points[segmentIndex + 1]!;
  const dx = pb.x - pa.x;
  const dy = pb.y - pa.y;
  const currentAngle = Math.atan2(dy, dx);

  let targetAngle: number;
  if (type === 'horizontal') {
    targetAngle = Math.round(currentAngle / Math.PI) * Math.PI;
  } else {
    targetAngle = Math.round((currentAngle - Math.PI / 2) / Math.PI) * Math.PI + Math.PI / 2;
  }

  const rotation = targetAngle - currentAngle;
  if (Math.abs(rotation) < 1e-9) return entity;

  const center = entity.polygonCenter;
  return {
    ...entity,
    points: entity.points.map((p) => rotatePoint(p, center, rotation)),
  };
}

// --- Enforce functions (mutating shared entityMap) ---

function enforceCoincident(
  entityMap: Map<string, Entity>,
  constraints: Constraint[],
  fixedIds: Set<string>,
  movedIds: Set<string>,
): void {
  const coincidentConstraints = constraints.filter((c): c is CoincidentConstraint => c.type === 'coincident');
  if (coincidentConstraints.length === 0) return;

  // Simple per-constraint iteration: for each constraint, snap the appropriate
  // entity so both points coincide. The outer convergence loop handles chains
  // (A→B→C) across multiple iterations.
  for (const c of coincidentConstraints) {
    const e1 = entityMap.get(c.entityId);
    const e2 = entityMap.get(c.targetEntityId);
    if (!e1 || !e2) continue;

    const e1Fixed = fixedIds.has(c.entityId);
    const e2Fixed = fixedIds.has(c.targetEntityId);
    if (e1Fixed && e2Fixed) continue;

    const pt1 = getEntityPoint(e1, c.pointIndex);
    const pt2 = getEntityPoint(e2, c.targetPointIndex);
    if (!pt1 || !pt2) continue;

    if (Math.abs(pt1.x - pt2.x) < 1e-9 && Math.abs(pt1.y - pt2.y) < 1e-9) continue;

    // Determine which entity to move:
    // - Fixed entities never move
    // - Among non-fixed, prefer keeping the moved (user-dragged) entity in place
    let moveEntityId: string;
    let movePointIdx: number;
    let anchorPt: Point;

    if (e1Fixed || (!e2Fixed && movedIds.has(c.entityId) && !movedIds.has(c.targetEntityId))) {
      moveEntityId = c.targetEntityId;
      movePointIdx = c.targetPointIndex;
      anchorPt = pt1;
    } else if (e2Fixed || (!e1Fixed && movedIds.has(c.targetEntityId) && !movedIds.has(c.entityId))) {
      moveEntityId = c.entityId;
      movePointIdx = c.pointIndex;
      anchorPt = pt2;
    } else {
      // Both moved or neither — move target toward entity
      moveEntityId = c.targetEntityId;
      movePointIdx = c.targetPointIndex;
      anchorPt = pt1;
    }

    const moveEntity = entityMap.get(moveEntityId)!;
    const updated = setEntityPoint(moveEntity, movePointIdx, anchorPt);
    if (updated) {
      entityMap.set(moveEntityId, updated);
    }
  }
}

function enforceMidpoint(
  entityMap: Map<string, Entity>,
  constraints: Constraint[],
  fixedIds: Set<string>,
): void {
  const midpointConstraints = constraints.filter((c): c is MidpointConstraint => c.type === 'midpoint');
  if (midpointConstraints.length === 0) return;

  for (const c of midpointConstraints) {
    const source = entityMap.get(c.entityId);
    const target = entityMap.get(c.targetEntityId);
    if (!source || !target) continue;

    const sourceFixed = fixedIds.has(c.entityId);
    const targetFixed = fixedIds.has(c.targetEntityId);
    if (sourceFixed && targetFixed) continue;

    const endpoints = getSegmentEndpoints(target, c.segmentIndex);
    if (!endpoints) continue;

    const midpoint: Point = {
      x: (endpoints[0].x + endpoints[1].x) / 2,
      y: (endpoints[0].y + endpoints[1].y) / 2,
    };

    if (sourceFixed) {
      // Point entity is fixed — translate the segment entity so its midpoint
      // lands on the fixed point.
      const pt = getEntityPoint(source, c.pointIndex);
      if (!pt) continue;
      const dx = pt.x - midpoint.x;
      const dy = pt.y - midpoint.y;
      if (Math.abs(dx) < 1e-9 && Math.abs(dy) < 1e-9) continue;

      const translated = translateEntity(target, dx, dy);
      if (translated) entityMap.set(c.targetEntityId, translated);
    } else {
      // Normal case: move the point to the segment's midpoint
      const updated = setEntityPoint(source, c.pointIndex, midpoint);
      if (updated) {
        entityMap.set(c.entityId, updated);
      }
    }
  }
}

function enforceEqual(
  entityMap: Map<string, Entity>,
  constraints: Constraint[],
): void {
  const equalConstraints = constraints.filter((c): c is EqualConstraint => c.type === 'equal');
  if (equalConstraints.length === 0) return;

  // BFS from all entities (since we don't track a single modified source in the iterative loop)
  const visited = new Set<string>();

  for (const c of equalConstraints) {
    if (visited.has(c.entityId) && visited.has(c.targetEntityId)) continue;

    // Start BFS from the first entity we haven't visited
    const startId = !visited.has(c.entityId) ? c.entityId : c.targetEntityId;
    if (visited.has(startId)) continue;

    const queue = [startId];
    visited.add(startId);

    while (queue.length > 0) {
      const currentId = queue.shift()!;
      const current = entityMap.get(currentId);
      if (!current) continue;

      for (const ec of equalConstraints) {
        let otherId: string | null = null;
        if (ec.entityId === currentId) otherId = ec.targetEntityId;
        else if (ec.targetEntityId === currentId) otherId = ec.entityId;
        if (!otherId || visited.has(otherId)) continue;

        visited.add(otherId);
        queue.push(otherId);

        const other = entityMap.get(otherId);
        if (!other) continue;

        const adjusted = matchEntitySize(other, current);
        if (adjusted) entityMap.set(otherId, adjusted);
      }
    }
  }
}

function enforceParallel(
  entityMap: Map<string, Entity>,
  constraints: Constraint[],
  fixedIds: Set<string>,
): void {
  const parallelConstraints = constraints.filter((c): c is ParallelConstraint => c.type === 'parallel');
  if (parallelConstraints.length === 0) return;

  for (const c of parallelConstraints) {
    const refFixed = fixedIds.has(c.entityId);
    const tgtFixed = fixedIds.has(c.targetEntityId);
    if (refFixed && tgtFixed) continue;

    const modifyRef = tgtFixed && !refFixed;
    const modId = modifyRef ? c.entityId : c.targetEntityId;
    const fixedSideId = modifyRef ? c.targetEntityId : c.entityId;
    const modSegIdx = modifyRef ? c.segmentIndex : c.targetSegmentIndex;
    const fixedSegIdx = modifyRef ? c.targetSegmentIndex : c.segmentIndex;

    const modEntity = entityMap.get(modId);
    const fixedSideEntity = entityMap.get(fixedSideId);
    if (!modEntity || !fixedSideEntity) continue;

    const fixedEndpoints = getSegmentEndpoints(fixedSideEntity, fixedSegIdx);
    const modEndpoints = getSegmentEndpoints(modEntity, modSegIdx);
    if (!fixedEndpoints || !modEndpoints) continue;

    const fixedAngle = Math.atan2(fixedEndpoints[1].y - fixedEndpoints[0].y, fixedEndpoints[1].x - fixedEndpoints[0].x);
    const modAngle = Math.atan2(modEndpoints[1].y - modEndpoints[0].y, modEndpoints[1].x - modEndpoints[0].x);

    let delta1 = fixedAngle - modAngle;
    let delta2 = fixedAngle + Math.PI - modAngle;
    delta1 = ((delta1 + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
    delta2 = ((delta2 + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
    const delta = Math.abs(delta1) <= Math.abs(delta2) ? delta1 : delta2;

    if (Math.abs(delta) < 1e-9) continue;

    if (modEntity.type === 'line' && (modEntity as LineEntity).polygonCenter) {
      const center = (modEntity as LineEntity).polygonCenter!;
      entityMap.set(modId, {
        ...modEntity,
        points: (modEntity as LineEntity).points.map((p) => rotatePoint(p, center, delta)),
      } as LineEntity);
    } else if (modEntity.type === 'line') {
      const mA = modEndpoints[0];
      const len = Math.sqrt((modEndpoints[1].x - mA.x) ** 2 + (modEndpoints[1].y - mA.y) ** 2);
      const newAngle = modAngle + delta;
      const newB = { x: mA.x + Math.cos(newAngle) * len, y: mA.y + Math.sin(newAngle) * len };
      const newPoints = [...(modEntity as LineEntity).points];
      newPoints[modSegIdx + 1] = newB;
      entityMap.set(modId, { ...modEntity, points: newPoints } as LineEntity);
    }
  }
}

function enforcePerpendicular(
  entityMap: Map<string, Entity>,
  constraints: Constraint[],
  fixedIds: Set<string>,
): void {
  const perpConstraints = constraints.filter((c): c is PerpendicularConstraint => c.type === 'perpendicular');
  if (perpConstraints.length === 0) return;

  for (const c of perpConstraints) {
    const refFixed = fixedIds.has(c.entityId);
    const tgtFixed = fixedIds.has(c.targetEntityId);
    if (refFixed && tgtFixed) continue;

    const modifyRef = tgtFixed && !refFixed;
    const modId = modifyRef ? c.entityId : c.targetEntityId;
    const fixedSideId = modifyRef ? c.targetEntityId : c.entityId;
    const modSegIdx = modifyRef ? c.segmentIndex : c.targetSegmentIndex;
    const fixedSegIdx = modifyRef ? c.targetSegmentIndex : c.segmentIndex;

    const modEntity = entityMap.get(modId);
    const fixedSideEntity = entityMap.get(fixedSideId);
    if (!modEntity || !fixedSideEntity) continue;

    const fixedEndpoints = getSegmentEndpoints(fixedSideEntity, fixedSegIdx);
    const modEndpoints = getSegmentEndpoints(modEntity, modSegIdx);
    if (!fixedEndpoints || !modEndpoints) continue;

    const fixedAngle = Math.atan2(fixedEndpoints[1].y - fixedEndpoints[0].y, fixedEndpoints[1].x - fixedEndpoints[0].x);
    const modAngle = Math.atan2(modEndpoints[1].y - modEndpoints[0].y, modEndpoints[1].x - modEndpoints[0].x);

    let delta1 = fixedAngle + Math.PI / 2 - modAngle;
    let delta2 = fixedAngle - Math.PI / 2 - modAngle;
    delta1 = ((delta1 + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
    delta2 = ((delta2 + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
    const delta = Math.abs(delta1) <= Math.abs(delta2) ? delta1 : delta2;

    if (Math.abs(delta) < 1e-9) continue;

    if (modEntity.type === 'line' && (modEntity as LineEntity).polygonCenter) {
      const center = (modEntity as LineEntity).polygonCenter!;
      entityMap.set(modId, {
        ...modEntity,
        points: (modEntity as LineEntity).points.map((p) => rotatePoint(p, center, delta)),
      } as LineEntity);
    } else if (modEntity.type === 'line') {
      const mA = modEndpoints[0];
      const len = Math.sqrt((modEndpoints[1].x - mA.x) ** 2 + (modEndpoints[1].y - mA.y) ** 2);
      const newAngle = modAngle + delta;
      const newB = { x: mA.x + Math.cos(newAngle) * len, y: mA.y + Math.sin(newAngle) * len };
      const newPoints = [...(modEntity as LineEntity).points];
      newPoints[modSegIdx + 1] = newB;
      entityMap.set(modId, { ...modEntity, points: newPoints } as LineEntity);
    }
  }
}

function enforceTangent(
  entityMap: Map<string, Entity>,
  constraints: Constraint[],
  fixedIds: Set<string>,
): void {
  const tangentConstraints = constraints.filter((c): c is TangentConstraint => c.type === 'tangent');
  if (tangentConstraints.length === 0) return;

  for (const c of tangentConstraints) {
    const refEntity = entityMap.get(c.entityId);
    const tgtEntity = entityMap.get(c.targetEntityId);
    if (!refEntity || !tgtEntity) continue;

    const refFixed = fixedIds.has(c.entityId);
    const tgtFixed = fixedIds.has(c.targetEntityId);
    if (refFixed && tgtFixed) continue;

    // Line-circle case: reference is line segment, target is circle
    if (c.segmentIndex >= 0 && c.targetSegmentIndex === -1) {
      if (tgtEntity.type !== 'circle') continue;
      const endpoints = getSegmentEndpoints(refEntity, c.segmentIndex);
      if (!endpoints) continue;
      const [a, b] = endpoints;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len = Math.sqrt(dx * dx + dy * dy);
      if (len === 0) continue;
      const nx = -dy / len;
      const ny = dx / len;
      const circle = tgtEntity as CircleEntity;
      const sd = (circle.center.x - a.x) * nx + (circle.center.y - a.y) * ny;
      const targetSd = (Math.abs(sd) < 1e-9 ? 1 : Math.sign(sd)) * circle.radius;
      const correction = targetSd - sd;
      if (Math.abs(correction) < 1e-9) continue;

      if (tgtFixed) {
        // Circle is fixed — translate the line toward the circle
        const translated = translateEntity(refEntity, -(nx * correction), -(ny * correction));
        if (translated) entityMap.set(c.entityId, translated);
      } else {
        // Move the circle toward the line
        entityMap.set(c.targetEntityId, {
          ...circle,
          center: { x: circle.center.x + nx * correction, y: circle.center.y + ny * correction },
        });
      }
    }

    // Circle-circle case
    if (c.segmentIndex === -1 && c.targetSegmentIndex === -1 && refEntity.type === 'circle' && tgtEntity.type === 'circle') {
      const moveTarget = !tgtFixed;
      const stayCircle = (moveTarget ? refEntity : tgtEntity) as CircleEntity;
      const moveCircle = (moveTarget ? tgtEntity : refEntity) as CircleEntity;
      const moveId = moveTarget ? c.targetEntityId : c.entityId;

      const dx = moveCircle.center.x - stayCircle.center.x;
      const dy = moveCircle.center.y - stayCircle.center.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const external = stayCircle.radius + moveCircle.radius;
      const internal = Math.abs(stayCircle.radius - moveCircle.radius);
      const targetDist = Math.abs(dist - external) <= Math.abs(dist - internal) ? external : internal;
      let dirX: number, dirY: number;
      if (dist < 1e-9) {
        dirX = 1;
        dirY = 0;
      } else {
        dirX = dx / dist;
        dirY = dy / dist;
      }
      entityMap.set(moveId, {
        ...moveCircle,
        center: { x: stayCircle.center.x + dirX * targetDist, y: stayCircle.center.y + dirY * targetDist },
      });
    }
  }
}

function enforceBisect(
  entityMap: Map<string, Entity>,
  constraints: Constraint[],
  fixedIds: Set<string>,
): void {
  const bisectConstraints = constraints.filter((c): c is BisectConstraint => c.type === 'bisect');
  if (bisectConstraints.length === 0) return;

  for (const c of bisectConstraints) {
    const bisector = entityMap.get(c.entityId);
    const bisected = entityMap.get(c.targetEntityId);
    if (!bisector || !bisected) continue;

    const bisectorFixed = fixedIds.has(c.entityId);
    const bisectedFixed = fixedIds.has(c.targetEntityId);
    if (bisectorFixed && bisectedFixed) continue;

    const bisectorEndpoints = getSegmentEndpoints(bisector, c.segmentIndex);
    const bisectedEndpoints = getSegmentEndpoints(bisected, c.targetSegmentIndex);
    if (!bisectorEndpoints || !bisectedEndpoints) continue;

    // Midpoint of the bisected segment
    const midpoint: Point = {
      x: (bisectedEndpoints[0].x + bisectedEndpoints[1].x) / 2,
      y: (bisectedEndpoints[0].y + bisectedEndpoints[1].y) / 2,
    };

    // Direction and normal of the bisecting line
    const [a1, a2] = bisectorEndpoints;
    const adx = a2.x - a1.x;
    const ady = a2.y - a1.y;
    const alen = Math.sqrt(adx * adx + ady * ady);
    if (alen < 1e-9) continue;
    const dirX = adx / alen;
    const dirY = ady / alen;
    const nx = -dirY;
    const ny = dirX;

    // Signed distance from midpoint to the bisecting line
    const sd = (midpoint.x - a1.x) * nx + (midpoint.y - a1.y) * ny;
    if (Math.abs(sd) < 1e-9) continue;

    if (bisectorFixed) {
      // Bisecting line is fixed — translate the bisected line so its midpoint
      // lands on the bisecting line (project midpoint onto bisector).
      const t = (midpoint.x - a1.x) * dirX + (midpoint.y - a1.y) * dirY;
      const proj: Point = { x: a1.x + dirX * t, y: a1.y + dirY * t };
      const dx = proj.x - midpoint.x;
      const dy = proj.y - midpoint.y;
      const translated = translateEntity(bisected, dx, dy);
      if (translated) entityMap.set(c.targetEntityId, translated);
    } else {
      // Translate the bisecting line perpendicular to itself so it passes
      // through the midpoint of the bisected segment.
      const translated = translateEntity(bisector, nx * sd, ny * sd);
      if (translated) entityMap.set(c.entityId, translated);
    }
  }
}

function enforceHorizontalVertical(
  entityMap: Map<string, Entity>,
  constraints: Constraint[],
  fixedIds: Set<string>,
): void {
  const hvConstraints = constraints.filter(
    (c): c is HorizontalConstraint | VerticalConstraint => c.type === 'horizontal' || c.type === 'vertical',
  );
  if (hvConstraints.length === 0) return;

  for (const c of hvConstraints) {
    if (fixedIds.has(c.entityId)) continue;
    const entity = entityMap.get(c.entityId);
    if (!entity || entity.type !== 'line') continue;
    const idx = c.segmentIndex;
    if (idx < 0 || idx >= entity.points.length - 1) continue;

    if ((entity as LineEntity).polygonCenter) {
      entityMap.set(c.entityId, snapPolygonForHV(entity as LineEntity, idx, c.type));
    } else {
      const pa = entity.points[idx]!;
      const pb = entity.points[idx + 1]!;
      const newPoints = [...entity.points];
      if (c.type === 'horizontal') {
        newPoints[idx + 1] = { x: pb.x, y: pa.y };
      } else {
        newPoints[idx + 1] = { x: pa.x, y: pb.y };
      }
      entityMap.set(c.entityId, { ...entity, points: newPoints } as LineEntity);
    }
  }
}
