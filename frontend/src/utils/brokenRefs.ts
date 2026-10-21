/**
 * Broken reference edges: a face sketch's reference outline follows its face
 * when the part changes (build/sketchRefs.ts); an edge whose face edge is gone
 * stays where it was, marked `broken`, so the dimensions and constraints on it
 * aren't lost. The solve leaves out the constraints on a broken edge (its own
 * 'fixed' stays), and expression dimensions on it aren't set.
 */
import type { Constraint, Entity } from '@/types/document';

/** A face outline edge: reference + construction. */
export const isRef = (e: Entity) => 'reference' in e && !!e.reference && 'construction' in e && !!e.construction;

/** A part edge projected onto the sketch (build/projectEdges.ts): a
 *  reference edge that follows its part edge rather than the sketch's face. */
export const isProjected = (e: Entity) => isRef(e) && 'edgeRef' in e && !!e.edgeRef;

export const isBroken = (e: Entity) => 'broken' in e && !!e.broken;

/** The entity ids a constraint or entity (a dimension) points at. */
export function targetsOf(x: Constraint | Entity): string[] {
  const out: string[] = [];
  const walk = (v: unknown, key: string) => {
    if (typeof v === 'string' && /entityid/i.test(key)) out.push(v);
    else if (Array.isArray(v)) v.forEach((y) => walk(y, key));
    else if (v && typeof v === 'object') for (const [k, y] of Object.entries(v)) walk(y, k);
  };
  for (const [k, v] of Object.entries(x)) if (k !== 'id') walk(v, k);
  return out;
}

export function brokenIds(entities: Entity[]): Set<string> {
  return new Set(entities.filter(isBroken).map((e) => e.id));
}

/** Whether a constraint or dimension uses a broken edge (a broken edge's own
 *  'fixed' doesn't count: it keeps the edge where it was). */
export function onBroken(x: Constraint | Entity, broken: Set<string>): boolean {
  if (!broken.size || ('type' in x && x.type === 'fixed')) return false;
  return targetsOf(x).some((id) => broken.has(id));
}

/** The constraints the solve uses: all but those on broken edges. */
export function liveConstraints(entities: Entity[], constraints: Constraint[]): Constraint[] {
  const broken = brokenIds(entities);
  return broken.size ? constraints.filter((c) => !onBroken(c, broken)) : constraints;
}
