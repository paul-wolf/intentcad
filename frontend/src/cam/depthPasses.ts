import type { Point } from '@/types/document';
import type { ToolpathMove, DepthSettings } from '@/types/cam';

/**
 * Replicate a single-depth toolpath across Z depth passes.
 *
 * Input moves are a 2D pattern (their z is ignored). Each pass:
 *   rapid to the start at safe Z → plunge straight down at the plunge rate →
 *   the pattern's feed moves at the pass depth → rapid straight up to safe Z.
 *
 * A rapid inside the pattern never runs at depth: the tool goes straight up to
 * safe Z, across, and plunges again. (A rapid to where the tool already is, such
 * as a pattern's leading "go to the start", is dropped.)
 */
export function depthPasses(
  moves: ToolpathMove[],
  depth: DepthSettings,
  safeZ: number,
  plungeRate: number,
  startPosition?: Point,
): ToolpathMove[] {
  if (moves.length === 0) return [];

  const { totalDepth, depthPerPass, finalPassAllowance } = depth;
  const passes = computePassDepths(totalDepth, depthPerPass, finalPassAllowance);
  const result: ToolpathMove[] = [];
  const start = startPosition ?? moves[0]!.to;

  for (const passDepth of passes) {
    const z = -passDepth;
    result.push({ kind: 'rapid', to: start, z: safeZ });
    result.push({ kind: 'linear', to: start, z, feed: plungeRate });

    let cur = start;
    for (const move of moves) {
      if (move.kind === 'rapid') {
        if (samePoint(move.to, cur)) continue;
        result.push({ kind: 'rapid', to: cur, z: safeZ });
        result.push({ kind: 'rapid', to: move.to, z: safeZ });
        result.push({ kind: 'linear', to: move.to, z, feed: plungeRate });
      } else {
        result.push({ ...move, z });
      }
      cur = move.to;
    }

    result.push({ kind: 'rapid', to: cur, z: safeZ });
  }

  return result;
}

function samePoint(a: Point, b: Point): boolean {
  return Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.y - b.y) < 1e-9;
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

  // A zero or negative step would never reach the target (validate.ts reports it).
  const step = depthPerPass > 0 ? depthPerPass : Math.max(roughTarget, 0.001);
  let current = 0;
  while (current < roughTarget - 0.001) {
    current = Math.min(current + step, roughTarget);
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
