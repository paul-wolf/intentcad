import type { Point } from '@/types/document';
import type { CamIssue, ClampZone, ToolpathMove } from '@/types/cam';
import { interpolateMove } from './simulatorInterp';

/** Room kept between the tool's side and a clamp, mm. */
export const CLAMP_MARGIN = 1;
/** Room kept between the tool's tip and the top of a clamp when passing over it, mm. */
export const CLAMP_HEIGHT_MARGIN = 2;

interface Rect { x0: number; y0: number; x1: number; y1: number }

const grow = (c: ClampZone, by: number): Rect => ({ x0: c.x - by, y0: c.y - by, x1: c.x + c.width + by, y1: c.y + c.height + by });
const inside = (p: Point, r: Rect) => p.x > r.x0 && p.x < r.x1 && p.y > r.y0 && p.y < r.y1;

/** Whether the straight line a→b passes through the rectangle (Liang–Barsky). */
export function segmentHitsRect(a: Point, b: Point, r: Rect): boolean {
  if (inside(a, r) || inside(b, r)) return true;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  let t0 = 0;
  let t1 = 1;
  const edges: [number, number][] = [[-dx, a.x - r.x0], [dx, r.x1 - a.x], [-dy, a.y - r.y0], [dy, r.y1 - a.y]];
  for (const [p, q] of edges) {
    if (Math.abs(p) < 1e-12) {
      if (q <= 0) return false;
    } else {
      const t = q / p;
      if (p < 0) t0 = Math.max(t0, t);
      else t1 = Math.min(t1, t);
      if (t0 >= t1) return false;
    }
  }
  return true;
}

/** Points along a move, close enough together to test an arc against a rectangle. */
function samples(from: Point, m: ToolpathMove): Point[] {
  if (m.kind !== 'arc') return [from, m.to];
  const pts: Point[] = [];
  for (let i = 0; i <= 24; i++) pts.push(interpolateMove(from, m, i / 24));
  return pts;
}

export interface ToolAt {
  /** Index of the first move cut with this tool. */
  moveStart: number;
  radius: number;
  operationIndex?: number;
}

/**
 * Keep the toolpath out of the clamps. Heights are relative to the stock top
 * (as the toolpaths are built). A rapid that would pass a clamp lower than its
 * top (plus a margin) goes up to `travelZ` to cross it instead. A cutting move
 * or a descent that reaches a clamp is an error: the plan has to change.
 *
 * Returns the new moves, and for each old move index the new one (so operation
 * boundaries can be moved along).
 */
export function avoidClamps(
  moves: ToolpathMove[],
  clamps: ClampZone[],
  tools: ToolAt[],
  travelZ: number,
): { moves: ToolpathMove[]; indexMap: number[]; issues: CamIssue[] } {
  const issues: CamIssue[] = [];
  if (clamps.length === 0) return { moves, indexMap: moves.map((_, i) => i), issues };

  const out: ToolpathMove[] = [];
  const indexMap: number[] = [];
  const reported = new Set<string>();
  let toolIdx = -1;
  let prev: { p: Point; z: number } | null = null;

  for (const [i, m] of moves.entries()) {
    while (toolIdx + 1 < tools.length && tools[toolIdx + 1]!.moveStart <= i) toolIdx++;
    const tool = tools[Math.max(toolIdx, 0)];
    const radius = tool?.radius ?? 0;
    indexMap.push(out.length);

    if (prev && (m.kind === 'rapid' || m.kind === 'linear' || m.kind === 'arc')) {
      let goOver = false;
      for (const c of clamps) {
        const top = c.zHeight + CLAMP_HEIGHT_MARGIN;
        const zone = grow(c, radius + CLAMP_MARGIN);
        if (Math.min(prev.z, m.z) >= top) continue;
        const pts = samples(prev.p, m);
        if (!pts.some((p, k) => k > 0 && segmentHitsRect(pts[k - 1]!, p, zone))) continue;
        if (m.kind === 'rapid' && !inside(m.to, zone) && !inside(prev.p, zone)) {
          // Travelling at rapid: the emitter moves sideways at the higher of
          // the two heights. Below the clamp, go over it instead.
          if (Math.max(prev.z, m.z) < top) goOver = true;
          continue;
        }
        const key = `${c.id}:${tool?.operationIndex ?? ''}`;
        if (!reported.has(key)) {
          reported.add(key);
          const name = tool?.operationIndex !== undefined ? `Operation ${tool.operationIndex + 1}` : 'The toolpath';
          issues.push({
            severity: 'error',
            message: `${name} runs into a clamp (${c.width.toFixed(0)}×${c.height.toFixed(0)}mm at ${c.x.toFixed(0)}, ${c.y.toFixed(0)}): move the clamp or leave those shapes out`,
            operationIndex: tool?.operationIndex,
            position: m.to,
          });
        }
      }
      if (goOver) {
        out.push({ kind: 'rapid', to: prev.p, z: travelZ });
        out.push({ kind: 'rapid', to: m.to, z: travelZ });
      }
    }
    out.push(m);
    prev = { p: m.to, z: m.z };
  }
  return { moves: out, indexMap, issues };
}

/** Problems with the clamps themselves. */
export function checkClamps(clamps: ClampZone[], clearanceZ: number): CamIssue[] {
  const issues: CamIssue[] = [];
  for (const c of clamps) {
    if (!(c.width > 0) || !(c.height > 0)) {
      issues.push({ severity: 'error', message: 'A clamp has no area: draw it again', position: { x: c.x, y: c.y } });
    } else if (c.zHeight + CLAMP_HEIGHT_MARGIN > clearanceZ) {
      issues.push({
        severity: 'error',
        message: `A clamp ${c.zHeight}mm tall is too close to the machine's clearance height (${clearanceZ}mm above the stock): raise the clearance height in Edit machine to at least ${c.zHeight + CLAMP_HEIGHT_MARGIN}mm`,
        position: { x: c.x, y: c.y },
      });
    }
  }
  return issues;
}
