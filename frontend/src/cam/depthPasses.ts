import type { ToolpathMove } from '@/types/cam';
import type { DepthSettings } from '@/types/cam';

/**
 * Replicate a single-depth toolpath across multiple Z depth passes.
 * Input moves should have z=0 as reference depth.
 * Output moves have Z adjusted for each pass, with rapid retracts between passes.
 */
export function depthPasses(
  moves: ToolpathMove[],
  depth: DepthSettings,
  safeZ: number,
  startPosition?: { x: number; y: number },
): ToolpathMove[] {
  if (moves.length === 0) return [];

  const { totalDepth, depthPerPass, finalPassAllowance } = depth;
  const passes = computePassDepths(totalDepth, depthPerPass, finalPassAllowance);
  const result: ToolpathMove[] = [];

  // Use explicit start position (contour entry point) if provided,
  // otherwise fall back to first move's destination (legacy behavior)
  const startPoint = startPosition ?? getMoveTo(moves[0]!);

  for (const passDepth of passes) {
    // Rapid to safe height at the contour entry point
    result.push({ kind: 'rapid', to: startPoint, z: safeZ });

    // Plunge to pass depth at the start position
    result.push({
      kind: 'linear',
      to: startPoint,
      z: -passDepth,
      feed: 0, // Will use plunge rate (handled by caller)
    });

    // Replay all moves with Z adjusted to this pass depth
    for (const move of moves) {
      result.push(adjustMoveZ(move, -passDepth));
    }

    // Retract after pass
    const lastMove = moves[moves.length - 1]!;
    result.push({ kind: 'rapid', to: getMoveTo(lastMove), z: safeZ });
  }

  return result;
}

/**
 * Compute the list of pass depths from surface to total depth.
 */
function computePassDepths(
  totalDepth: number,
  depthPerPass: number,
  finalPassAllowance: number,
): number[] {
  const depths: number[] = [];
  const roughTarget = totalDepth - finalPassAllowance;

  let current = 0;
  while (current < roughTarget - 0.001) {
    current = Math.min(current + depthPerPass, roughTarget);
    depths.push(current);
  }

  // Add final finish pass if there's an allowance
  if (finalPassAllowance > 0) {
    depths.push(totalDepth);
  }

  // Ensure at least one pass
  if (depths.length === 0) {
    depths.push(totalDepth);
  }

  return depths;
}

function getMoveTo(move: ToolpathMove): { x: number; y: number } {
  return move.to;
}

function adjustMoveZ(move: ToolpathMove, z: number): ToolpathMove {
  switch (move.kind) {
    case 'rapid':
      return { ...move, z };
    case 'linear':
      return { ...move, z };
    case 'arc':
      return { ...move, z };
  }
}
