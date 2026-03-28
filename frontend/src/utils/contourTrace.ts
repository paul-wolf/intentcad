import type { Entity, Point } from '@/types/document';

const TOLERANCE = 0.5; // world units — generous enough for snapped geometry

function ptEq(a: Point, b: Point): boolean {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy < TOLERANCE * TOLERANCE;
}

/** Get the start and end endpoints of an entity (null if self-closed). */
function getEndpoints(e: Entity): [Point, Point] | null {
  if (e.type === 'circle' || e.type === 'rectangle') return null; // self-closed
  if (e.type === 'line') {
    if (e.closed || e.points.length < 2) return null;
    // Check implicit closure
    const first = e.points[0]!;
    const last = e.points[e.points.length - 1]!;
    if (ptEq(first, last)) return null;
    return [first, last];
  }
  if (e.type === 'bezier') {
    return [e.controlPoints[0], e.controlPoints[3]];
  }
  return null;
}

/**
 * Trace a connected contour starting from a given entity.
 * Returns the set of entity IDs that form the chain.
 */
export function traceContour(startEntity: Entity, allEntities: Entity[]): Set<string> {
  const result = new Set<string>([startEntity.id]);

  // Self-closed entities are their own complete contour
  const eps = getEndpoints(startEntity);
  if (!eps) return result;

  // Build lookup: for each entity, its endpoints
  const entityEndpoints = new Map<string, [Point, Point]>();
  for (const e of allEntities) {
    const ep = getEndpoints(e);
    if (ep) entityEndpoints.set(e.id, ep);
  }

  // Follow chain in both directions from the start entity
  for (const dirIdx of [0, 1] as const) {
    let currentPt = eps[dirIdx]!;

    for (let steps = 0; steps < allEntities.length; steps++) {
      // Find an unvisited entity with an endpoint matching currentPt
      let found = false;
      for (const e of allEntities) {
        if (result.has(e.id)) continue;
        const eEps = entityEndpoints.get(e.id);
        if (!eEps) continue;

        if (ptEq(eEps[0], currentPt)) {
          result.add(e.id);
          currentPt = eEps[1];
          found = true;
          break;
        }
        if (ptEq(eEps[1], currentPt)) {
          result.add(e.id);
          currentPt = eEps[0];
          found = true;
          break;
        }
      }
      if (!found) break;

      // Check if we've looped back to the start
      if (ptEq(currentPt, eps[0]) || ptEq(currentPt, eps[1])) break;
    }
  }

  return result;
}
