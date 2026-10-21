import type { Entity, Constraint, LineEntity } from '@/types/document';

/** Base degrees of freedom for each entity type. */
function baseDoF(entity: Entity): number {
  switch (entity.type) {
    case 'point': return 2;
    case 'circle': return 3;
    case 'rectangle': return 4;
    case 'line':
      // Polygon is a rigid body: center (x,y) + rotation + scale = 4 DoF
      if ((entity as LineEntity).polygonCenter) return 4;
      return 2 * entity.points.length;
    case 'bezier': return 8; // 4 points x 2 coordinates
    case 'dimension': return 0;
    case 'text': return 2; // position only
  }
}

/** The entity a point relation (two points level, ...) takes freedom from,
 *  and how much. */
function pointRelationReduction(c: Constraint): [string, number] | null {
  if (c.type === 'horizontalPoints' || c.type === 'verticalPoints') return [c.targetEntityId, 1];
  if (c.type === 'pointOnCurve') return [c.entityId, 1];
  if (c.type === 'symmetric') return [c.entityId2, 2];
  return null;
}

/**
 * Compute per-entity DoF for all entities in a sketch.
 * - Derived entities (sourceId set) → 0 DoF
 * - Each dimension targeting an entity removes 1 DoF
 * - Clamped at 0 (never negative)
 */
export function computeSketchDoF(entities: Entity[], constraints: Constraint[] = []): Map<string, number> {
  const dofMap = new Map<string, number>();

  // Collect entity IDs that have a fixed constraint
  const fixedIds = new Set<string>();
  for (const c of constraints) {
    if (c.type === 'fixed') fixedIds.add(c.entityId);
  }

  // Count how many dimensions target each entity
  const dimCount = new Map<string, number>();
  for (const e of entities) {
    if (e.type === 'dimension') {
      dimCount.set(e.targetEntityId, (dimCount.get(e.targetEntityId) ?? 0) + 1);
      if (e.targetEntityId2) {
        dimCount.set(e.targetEntityId2, (dimCount.get(e.targetEntityId2) ?? 0) + 1);
      }
    }
  }

  for (const e of entities) {
    if (e.type === 'dimension') {
      dofMap.set(e.id, 0);
      continue;
    }

    // Derived entities are fully constrained
    if ('sourceId' in e && e.sourceId) {
      dofMap.set(e.id, 0);
      continue;
    }

    // Fixed entities have 0 DoF
    if (fixedIds.has(e.id)) {
      dofMap.set(e.id, 0);
      continue;
    }

    const base = baseDoF(e);
    const dims = dimCount.get(e.id) ?? 0;
    dofMap.set(e.id, Math.max(0, base - dims));
  }

  // Second pass: apply constraint-based DoF reductions
  for (const c of constraints) {
    if (c.type === 'equal') {
      const current = dofMap.get(c.targetEntityId);
      if (current !== undefined && current > 0) {
        const target = entities.find((e) => e.id === c.targetEntityId);
        // Rectangle equality constrains both width and height (-2), others -1
        const reduction = target?.type === 'rectangle' ? 2 : 1;
        dofMap.set(c.targetEntityId, Math.max(0, current - reduction));
      }
    }
    if (c.type === 'coincident') {
      const current = dofMap.get(c.targetEntityId);
      if (current !== undefined && current > 0) {
        dofMap.set(c.targetEntityId, Math.max(0, current - 2));
      }
    }
    if (c.type === 'midpoint') {
      const current = dofMap.get(c.entityId);
      if (current !== undefined && current > 0) {
        dofMap.set(c.entityId, Math.max(0, current - 2));
      }
    }
    if (c.type === 'tangent') {
      const current = dofMap.get(c.targetEntityId);
      if (current !== undefined && current > 0) {
        dofMap.set(c.targetEntityId, Math.max(0, current - 1));
      }
    }
    if (c.type === 'parallel' || c.type === 'perpendicular') {
      const current = dofMap.get(c.targetEntityId);
      if (current !== undefined && current > 0) {
        dofMap.set(c.targetEntityId, Math.max(0, current - 1));
      }
    }
    if (c.type === 'horizontal' || c.type === 'vertical') {
      const current = dofMap.get(c.entityId);
      if (current !== undefined && current > 0) {
        dofMap.set(c.entityId, Math.max(0, current - 1));
      }
    }
    const rel = pointRelationReduction(c);
    if (rel) {
      const current = dofMap.get(rel[0]);
      if (current !== undefined && current > 0) dofMap.set(rel[0], Math.max(0, current - rel[1]));
    }
  }

  return dofMap;
}

/**
 * Compute which dimension entities are "derived" (driven, not driving).
 * A dimension is derived when all entities it could move are already fully
 * constrained by non-dimension constraints (fixed, coincident, etc.), so the
 * dimension is purely observational and cannot drive changes.
 */
export function computeDerivedDimensionIds(entities: Entity[], constraints: Constraint[]): Set<string> {
  // Compute constraint-only DOF (same as computeSketchDoF but without dimension reductions)
  const constraintDof = new Map<string, number>();

  const fixedIds = new Set<string>();
  for (const c of constraints) {
    if (c.type === 'fixed') fixedIds.add(c.entityId);
  }

  for (const e of entities) {
    if (e.type === 'dimension') continue;
    if ('sourceId' in e && e.sourceId) {
      constraintDof.set(e.id, 0);
      continue;
    }
    if (fixedIds.has(e.id)) {
      constraintDof.set(e.id, 0);
      continue;
    }
    constraintDof.set(e.id, baseDoF(e));
  }

  // Apply constraint-based reductions (excluding dimensions)
  for (const c of constraints) {
    if (c.type === 'equal') {
      const current = constraintDof.get(c.targetEntityId);
      if (current !== undefined && current > 0) {
        const target = entities.find((e) => e.id === c.targetEntityId);
        const reduction = target?.type === 'rectangle' ? 2 : 1;
        constraintDof.set(c.targetEntityId, Math.max(0, current - reduction));
      }
    }
    if (c.type === 'coincident') {
      const current = constraintDof.get(c.targetEntityId);
      if (current !== undefined && current > 0) {
        constraintDof.set(c.targetEntityId, Math.max(0, current - 2));
      }
    }
    if (c.type === 'midpoint') {
      const current = constraintDof.get(c.entityId);
      if (current !== undefined && current > 0) {
        constraintDof.set(c.entityId, Math.max(0, current - 2));
      }
    }
    if (c.type === 'tangent') {
      const current = constraintDof.get(c.targetEntityId);
      if (current !== undefined && current > 0) {
        constraintDof.set(c.targetEntityId, Math.max(0, current - 1));
      }
    }
    if (c.type === 'parallel' || c.type === 'perpendicular') {
      const current = constraintDof.get(c.targetEntityId);
      if (current !== undefined && current > 0) {
        constraintDof.set(c.targetEntityId, Math.max(0, current - 1));
      }
    }
    if (c.type === 'horizontal' || c.type === 'vertical') {
      const current = constraintDof.get(c.entityId);
      if (current !== undefined && current > 0) {
        constraintDof.set(c.entityId, Math.max(0, current - 1));
      }
    }
    const rel = pointRelationReduction(c);
    if (rel) {
      const current = constraintDof.get(rel[0]);
      if (current !== undefined && current > 0) constraintDof.set(rel[0], Math.max(0, current - rel[1]));
    }
  }

  // Identify derived dimensions
  const derived = new Set<string>();
  for (const e of entities) {
    if (e.type !== 'dimension') continue;
    if (e.offsetDistance) continue; // drives its offset, never driven
    if (e.targetEntityId2 != null) {
      // Two-segment: derived if BOTH targets have 0 constraint-only DOF
      const dof1 = constraintDof.get(e.targetEntityId) ?? 0;
      const dof2 = constraintDof.get(e.targetEntityId2) ?? 0;
      if (dof1 === 0 && dof2 === 0) derived.add(e.id);
    } else {
      // Single-target: derived if target has 0 constraint-only DOF
      const dof = constraintDof.get(e.targetEntityId) ?? 0;
      if (dof === 0) derived.add(e.id);
    }
  }
  return derived;
}

/** Sum of DoF across all entities in the map. */
export function sketchTotalDoF(dofMap: Map<string, number>): number {
  let total = 0;
  for (const v of dofMap.values()) total += v;
  return total;
}
