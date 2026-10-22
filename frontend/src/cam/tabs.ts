import type { Point } from '@/types/document';
import type { ToolpathMove } from '@/types/cam';

/**
 * Holding tabs on a closed profile path: `count` stretches, spaced about evenly
 * along the path, where the deepest passes lift over the material instead of
 * cutting it. Each stretch is the tab width plus the tool diameter long, so the
 * bridge left standing is the tab width. A tab is moved along to sit on one
 * straight move (or failing that one arc) of the path, so it doesn't wrap a
 * corner, where the bridge would come out thinner.
 */
export interface TabbedPath {
  /** The path, split at the start and end of every tab. */
  moves: ToolpathMove[];
  /** overTab[i]: moves[i] runs over a tab. */
  overTab: boolean[];
}

/** Length of a feed path (lines and arcs) that starts at `start`. */
export function pathLength(moves: ToolpathMove[], start: Point): number {
  let len = 0;
  let cur = start;
  for (const m of moves) {
    len += moveLength(m, cur);
    cur = m.to;
  }
  return len;
}

export function splitAtTabs(moves: ToolpathMove[], start: Point, count: number, tabLength: number): TabbedPath {
  const total = pathLength(moves, start);
  const tabs = placeTabs(moves, start, total, count, tabLength).map((centre) => [centre - tabLength / 2, centre + tabLength / 2] as const);
  const cuts = tabs.flat();
  const isTab = (s: number) => tabs.some(([a, b]) => s > a && s < b);

  const out: ToolpathMove[] = [];
  const overTab: boolean[] = [];
  let along = 0;
  let cur = start;
  for (const m of moves) {
    const len = moveLength(m, cur);
    const ends = cuts
      .filter((c) => c > along + 1e-9 && c < along + len - 1e-9)
      .map((c) => c - along)
      .sort((a, b) => a - b);
    ends.push(len);
    let from = cur;
    let done = 0;
    for (const s of ends) {
      const piece = pieceOf(m, cur, from, s === len ? null : s);
      out.push(piece);
      overTab.push(isTab(along + (done + s) / 2));
      done = s;
      from = piece.to;
    }
    along += len;
    cur = m.to;
  }
  return { moves: out, overTab };
}

/** Tab centres (distances along the path), sorted. */
function placeTabs(moves: ToolpathMove[], start: Point, total: number, count: number, tabLength: number): number[] {
  // Stretches of single moves a whole tab fits on: [first, last] possible centre.
  const spots: { lo: number; hi: number; arc: boolean }[] = [];
  let along = 0;
  let cur = start;
  for (const m of moves) {
    const len = moveLength(m, cur);
    if (len >= tabLength && m.kind !== 'rapid') {
      spots.push({ lo: along + tabLength / 2, hi: along + len - tabLength / 2, arc: m.kind === 'arc' });
    }
    along += len;
    cur = m.to;
  }
  const spacing = total / count;
  const placed: number[] = [];
  const clear = (c: number) => placed.every((p) => Math.abs(p - c) >= tabLength);
  for (let i = 0; i < count; i++) {
    const target = (i + 0.5) * spacing;
    let best: number | null = null;
    let bestCost = Infinity;
    for (const spot of spots) {
      const c = Math.max(spot.lo, Math.min(spot.hi, target));
      // A straight move within half a spacing beats any arc.
      const cost = Math.abs(c - target) + (spot.arc ? spacing / 2 : 0);
      if (cost < bestCost && clear(c)) { bestCost = cost; best = c; }
    }
    placed.push(best ?? target);
  }
  return placed.sort((a, b) => a - b);
}

// ── Geometry of single moves ──

interface ArcShape { c: Point; r: number; a0: number; sweep: number; dir: 1 | -1 }

/**
 * An arc move as a circle: `dir` +1 turns with increasing angle in sketch
 * (x, y), which is clockwise on screen (Y down), i.e. ArcMove.clockwise.
 */
function arcShape(m: Extract<ToolpathMove, { kind: 'arc' }>, from: Point): ArcShape {
  const c = { x: from.x + m.center.x, y: from.y + m.center.y };
  const r = Math.hypot(from.x - c.x, from.y - c.y);
  const a0 = Math.atan2(from.y - c.y, from.x - c.x);
  const a1 = Math.atan2(m.to.y - c.y, m.to.x - c.x);
  const dir = m.clockwise ? 1 : -1;
  let sweep = (dir * (a1 - a0)) % (2 * Math.PI);
  if (sweep <= 1e-12) sweep += 2 * Math.PI;
  return { c, r, a0, sweep, dir };
}

export function moveLength(m: ToolpathMove, from: Point): number {
  if (m.kind === 'arc') {
    const a = arcShape(m, from);
    return a.r * a.sweep;
  }
  if (m.kind === 'linear') return Math.hypot(m.to.x - from.x, m.to.y - from.y);
  return 0;
}

/**
 * The part of move m (which starts at `start`) from `from` to distance `s`
 * along it, or to its end when s is null.
 */
export function pieceOf(m: ToolpathMove, start: Point, from: Point, s: number | null): ToolpathMove {
  if (m.kind === 'arc') {
    const a = arcShape(m, start);
    let to = m.to;
    if (s !== null) {
      const angle = a.a0 + (a.dir * s) / a.r;
      to = { x: a.c.x + a.r * Math.cos(angle), y: a.c.y + a.r * Math.sin(angle) };
    }
    return { ...m, to, center: { x: a.c.x - from.x, y: a.c.y - from.y } };
  }
  if (s === null) return { ...m };
  const len = Math.hypot(m.to.x - start.x, m.to.y - start.y);
  const t = len > 0 ? s / len : 0;
  return { ...m, to: { x: start.x + (m.to.x - start.x) * t, y: start.y + (m.to.y - start.y) * t } };
}
