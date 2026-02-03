import type { Entity, Constraint } from '@/types/document';

/** Base degrees of freedom for each entity type. */
function baseDoF(entity: Entity): number {
  switch (entity.type) {
    case 'point': return 2;
    case 'circle': return 3;
    case 'rectangle': return 4;
    case 'line': return 2 * entity.points.length;
    case 'dimension': return 0;
  }
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

  return dofMap;
}

/** Sum of DoF across all entities in the map. */
export function sketchTotalDoF(dofMap: Map<string, number>): number {
  let total = 0;
  for (const v of dofMap.values()) total += v;
  return total;
}
