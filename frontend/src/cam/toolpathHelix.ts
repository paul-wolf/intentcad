import type { Point } from '@/types/document';
import type { ToolpathMove } from '@/types/cam';

export interface HelixResult {
  moves: ToolpathMove[];
  /** Set when a hole can't be bored with this tool; `moves` then has the holes that can. */
  problem?: string;
}

/**
 * Bore round holes with an end mill smaller than them: for each hole, spiral
 * down round a circle a tool radius in from the wall (half a turn per arc, so
 * no arc is a full circle), descending at most `depthPerPass` a turn and no
 * steeper than `rampAngle`, then go once more round at the full depth to
 * leave a flat floor and a round wall, step to the centre and lift.
 *
 * A hole more than twice the tool's diameter would leave a loose core in the
 * middle, which a router can fling; those are refused.
 *
 * Climb milling on the wall of a hole (clockwise spindle) runs counter-clockwise.
 */
export function toolpathHelix(
  circles: { center: Point; radius: number }[],
  toolDiameter: number,
  totalDepth: number,
  depthPerPass: number,
  rampAngle: number,
  feedRate: number,
  plungeRate: number,
  safeZ: number,
  climb: boolean,
): HelixResult {
  const moves: ToolpathMove[] = [];
  const r = toolDiameter / 2;
  let problem: string | undefined;

  for (const { center, radius } of circles) {
    const path = radius - r;
    if (path < 0.01) {
      problem ??= `a ${(radius * 2).toFixed(2)}mm hole is too small to bore with a ${toolDiameter}mm tool`;
      continue;
    }
    if (path > r + 1e-9) {
      problem ??= `a ${(radius * 2).toFixed(2)}mm hole is more than twice the ${toolDiameter}mm tool: boring it would leave a loose core; cut it as an inside profile`;
      continue;
    }
    const turn = 2 * Math.PI * path;
    const pitch = Math.min(depthPerPass > 0 ? depthPerPass : totalDepth, turn * Math.tan((Math.max(rampAngle, 0.5) * Math.PI) / 180));
    const a = { x: center.x + path, y: center.y };
    const b = { x: center.x - path, y: center.y };
    // Screen-clockwise is ArcMove.clockwise; climb in a hole is counter-clockwise.
    const clockwise = !climb;

    moves.push({ kind: 'rapid', to: a, z: safeZ });
    moves.push({ kind: 'linear', to: a, z: 0, feed: plungeRate });
    let z = 0;
    let at = a;
    const half = (zEnd: number) => {
      const to = at === a ? b : a;
      moves.push({ kind: 'arc', to, z: zEnd, center: { x: center.x - at.x, y: center.y - at.y }, clockwise, feed: feedRate });
      at = to;
    };
    while (z > -totalDepth + 1e-9) {
      z = Math.max(z - pitch / 2, -totalDepth);
      half(z);
    }
    // A full turn at the bottom, back to where the descent ended.
    half(-totalDepth);
    half(-totalDepth);
    moves.push({ kind: 'linear', to: center, z: -totalDepth, feed: feedRate });
    moves.push({ kind: 'rapid', to: center, z: safeZ });
  }

  return { moves, problem };
}
