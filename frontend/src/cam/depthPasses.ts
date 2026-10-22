import type { Point } from '@/types/document';
import type { ToolpathMove, DepthSettings } from '@/types/cam';
import { moveLength, pathLength, pieceOf } from './tabs';

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
  tabs?: { overTab: boolean[]; height: number },
  ramp?: { angle: number },
): ToolpathMove[] {
  if (moves.length === 0) return [];

  const { totalDepth, depthPerPass, finalPassAllowance } = depth;
  const passes = computePassDepths(totalDepth, depthPerPass, finalPassAllowance);
  const result: ToolpathMove[] = [];
  const start = startPosition ?? moves[0]!.to;
  const rampLoop = ramp && ramp.angle > 0 ? closedFeedLoop(moves, start) : null;

  for (const [pi, passDepth] of passes.entries()) {
    const z = -passDepth;
    const tabTop = tabs && passDepth > totalDepth - tabs.height + 1e-9 ? -(totalDepth - tabs.height) : null;
    if (rampLoop) {
      const zFrom = pi === 0 ? 0 : -passes[pi - 1]!;
      rampPass(result, rampLoop.loop, tabs?.overTab.slice(rampLoop.first), start, zFrom, z, ramp!.angle, tabTop, safeZ, plungeRate);
      continue;
    }
    result.push({ kind: 'rapid', to: start, z: safeZ });
    result.push({ kind: 'linear', to: start, z, feed: plungeRate });

    let cur = start;
    let lifted = false;
    for (const [i, move] of moves.entries()) {
      const over = tabTop !== null && tabs!.overTab[i] === true && move.kind !== 'rapid';
      if (over !== lifted) {
        result.push({ kind: 'linear', to: cur, z: over ? tabTop! : z, feed: plungeRate });
        lifted = over;
      }
      if (over) {
        result.push({ ...move, z: tabTop! });
      } else if (move.kind === 'rapid') {
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

/**
 * The pattern as a closed loop of feed moves from `start`, or null when it
 * isn't one (it has rapids, doesn't end where it starts, or has no length):
 * only a closed loop can be ramped into.
 */
function closedFeedLoop(moves: ToolpathMove[], start: Point): { loop: ToolpathMove[]; first: number } | null {
  const first = moves[0]!.kind === 'rapid' && samePoint(moves[0]!.to, start) ? 1 : 0;
  const loop = moves.slice(first);
  if (loop.some((m) => m.kind !== 'linear' && m.kind !== 'arc')) return null;
  const end = loop[loop.length - 1]?.to;
  if (!end || Math.hypot(end.x - start.x, end.y - start.y) > 1e-6) return null;
  return pathLength(loop, start) > 1e-6 ? { loop, first } : null;
}

/**
 * One pass that ramps in: down from the last pass's floor (zFrom) along the
 * loop at `angle` until it reaches z (going round more than once if it has
 * to), then one whole lap at z, which also cuts away the sloped floor the
 * ramp left. Over tabs it stays at the tab top.
 */
function rampPass(
  out: ToolpathMove[],
  loop: ToolpathMove[],
  overTab: boolean[] | undefined,
  start: Point,
  zFrom: number,
  z: number,
  angle: number,
  tabTop: number | null,
  safeZ: number,
  plungeRate: number,
) {
  const rampLength = (zFrom - z) / Math.tan((angle * Math.PI) / 180);
  const lap = pathLength(loop, start);
  const total = rampLength + lap;
  const zAt = (d: number) => (d >= rampLength ? z : zFrom - ((zFrom - z) * d) / rampLength);

  out.push({ kind: 'rapid', to: start, z: safeZ });
  out.push({ kind: 'linear', to: start, z: zFrom, feed: plungeRate });
  let cur = start;
  let curZ = zFrom;
  let d = 0;
  for (let i = 0; d < total - 1e-9; i++) {
    const m = loop[i % loop.length]!;
    const over = tabTop !== null && overTab?.[i % loop.length] === true;
    const height = (along: number) => (over ? Math.max(zAt(along), tabTop!) : zAt(along));
    const len = moveLength(m, cur);
    const mStart = cur;
    // Split where the ramp reaches the floor, and where the job is done.
    const cuts = [rampLength - d, total - d].filter((s) => s > 1e-9 && s < len - 1e-9).sort((a, b) => a - b);
    let done = 0;
    for (const s of [...cuts, len]) {
      if (s > total - d + 1e-9) break;
      const piece = pieceOf(m, mStart, cur, s >= len - 1e-9 ? null : s);
      const zStart = height(d + done);
      if (Math.abs(curZ - zStart) > 1e-9) out.push({ kind: 'linear', to: cur, z: zStart, feed: plungeRate });
      const zEnd = height(d + s);
      out.push({ ...piece, z: zEnd });
      cur = piece.to;
      curZ = zEnd;
      done = s;
    }
    d += done;
  }
  out.push({ kind: 'rapid', to: cur, z: safeZ });
}

function samePoint(a: Point, b: Point): boolean {
  return Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.y - b.y) < 1e-9;
}

/**
 * Compute the list of pass depths from surface to total depth.
 */
export function computePassDepths(
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
