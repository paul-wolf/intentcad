import type { ToolpathMove } from '@/types/cam';
import type { Point } from '@/types/document';

/**
 * Compute the total angular sweep for an arc move (always positive).
 * Detects full circles (from ≈ to) where atan2 would give sweep ≈ 0.
 */
function arcSweep(from: Point, move: ToolpathMove & { kind: 'arc' }): { radius: number; startAngle: number; sweep: number } {
  const absCenter = { x: from.x + move.center.x, y: from.y + move.center.y };
  const dx = from.x - absCenter.x;
  const dy = from.y - absCenter.y;
  const radius = Math.sqrt(dx * dx + dy * dy);
  const startAngle = Math.atan2(dy, dx);

  // Full-circle: from ≈ to → atan2 gives sweep ≈ 0, must use 2π
  const fdx = move.to.x - from.x;
  const fdy = move.to.y - from.y;
  if (fdx * fdx + fdy * fdy < 1e-6) {
    return { radius, startAngle, sweep: 2 * Math.PI };
  }

  const endAngle = Math.atan2(move.to.y - absCenter.y, move.to.x - absCenter.x);
  let sweep = move.clockwise ? startAngle - endAngle : endAngle - startAngle;
  if (sweep <= 0) sweep += 2 * Math.PI;
  return { radius, startAngle, sweep };
}

/**
 * Compute the length of a toolpath move (linear distance or arc length).
 */
export function moveLength(from: Point, move: ToolpathMove): number {
  switch (move.kind) {
    case 'rapid':
    case 'linear': {
      const dx = move.to.x - from.x;
      const dy = move.to.y - from.y;
      return Math.sqrt(dx * dx + dy * dy);
    }
    case 'arc': {
      const { radius, sweep } = arcSweep(from, move);
      return radius * sweep;
    }
  }
}

/**
 * Interpolate position along a move at parameter t ∈ [0,1].
 */
export function interpolateMove(from: Point, move: ToolpathMove, t: number): Point {
  switch (move.kind) {
    case 'rapid':
    case 'linear':
      return {
        x: from.x + t * (move.to.x - from.x),
        y: from.y + t * (move.to.y - from.y),
      };
    case 'arc': {
      const absCenter = { x: from.x + move.center.x, y: from.y + move.center.y };
      const { radius, startAngle, sweep } = arcSweep(from, move);
      const angle = move.clockwise
        ? startAngle - t * sweep
        : startAngle + t * sweep;
      return {
        x: absCenter.x + radius * Math.cos(angle),
        y: absCenter.y + radius * Math.sin(angle),
      };
    }
  }
}
