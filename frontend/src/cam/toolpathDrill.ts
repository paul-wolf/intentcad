import type { Point } from '@/types/document';
import type { ToolpathMove } from '@/types/cam';

/**
 * Generate peck drill cycle toolpath moves for circle entities.
 * Each circle is drilled at its center point.
 */
export function toolpathDrill(
  circles: { center: Point; radius: number }[],
  peckDepth: number,
  totalDepth: number,
  dwell: number,
  _feedRate: number,
  plungeRate: number,
  safeZ: number,
): ToolpathMove[] {
  const moves: ToolpathMove[] = [];

  for (const circle of circles) {
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
