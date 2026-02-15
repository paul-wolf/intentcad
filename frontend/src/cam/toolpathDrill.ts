import type { Point } from '@/types/document';
import type { ToolpathMove } from '@/types/cam';

/** Reorder circles using nearest-neighbor heuristic to minimize rapid travel. */
function nearestNeighborOrder<T extends { center: Point }>(
  items: T[],
  origin: Point = { x: 0, y: 0 },
): T[] {
  if (items.length <= 1) return [...items];
  const remaining = [...items];
  const result: T[] = [];
  let current = origin;

  while (remaining.length > 0) {
    let bestIdx = 0;
    let bestDist = Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const dx = remaining[i]!.center.x - current.x;
      const dy = remaining[i]!.center.y - current.y;
      const dist = dx * dx + dy * dy;
      if (dist < bestDist) {
        bestDist = dist;
        bestIdx = i;
      }
    }
    const next = remaining.splice(bestIdx, 1)[0]!;
    result.push(next);
    current = next.center;
  }
  return result;
}

/**
 * Generate peck drill cycle toolpath moves for circle entities.
 * Each circle is drilled at its center point.
 * Circles are reordered by nearest-neighbor to minimize rapid travel.
 */
export function toolpathDrill(
  circles: { center: Point; radius: number }[],
  peckDepth: number,
  totalDepth: number,
  dwell: number,
  _feedRate: number,
  plungeRate: number,
  safeZ: number,
  origin: Point = { x: 0, y: 0 },
): ToolpathMove[] {
  const moves: ToolpathMove[] = [];
  const sorted = nearestNeighborOrder(circles, origin);

  for (const circle of sorted) {
    const { center } = circle;

    // Rapid to position above hole
    moves.push({ kind: 'rapid', to: center, z: safeZ });

    if (peckDepth > 0 && peckDepth < totalDepth) {
      // Peck drilling: drill in increments, retract between pecks
      let currentDepth = 0;
      while (currentDepth < totalDepth) {
        const nextDepth = Math.min(currentDepth + peckDepth, totalDepth);

        // Plunge to next depth
        moves.push({
          kind: 'linear',
          to: center,
          z: -nextDepth,
          feed: plungeRate,
        });

        // Retract to safe height (except on last peck, we'll dwell first)
        if (nextDepth >= totalDepth && dwell > 0) {
          // Dwell at bottom is represented as a zero-length move at feed rate
          // The G-code emitter will add G4 for dwell
          moves.push({
            kind: 'linear',
            to: center,
            z: -nextDepth,
            feed: 0, // Signal for dwell
          });
        }

        // Retract
        moves.push({ kind: 'rapid', to: center, z: safeZ });

        currentDepth = nextDepth;
      }
    } else {
      // Single plunge (no peck)
      moves.push({
        kind: 'linear',
        to: center,
        z: -totalDepth,
        feed: plungeRate,
      });

      if (dwell > 0) {
        moves.push({
          kind: 'linear',
          to: center,
          z: -totalDepth,
          feed: 0,
        });
      }

      // Retract
      moves.push({ kind: 'rapid', to: center, z: safeZ });
    }
  }

  return moves;
}
