import type { Point } from '@/types/document';
import type { ToolpathMove } from '@/types/cam';
import type { CncSegment } from './entityToSegments';
import { arcFromBulge } from '@/utils/arcGeometry';
import { isClosed, reverseContour } from './contours';

/**
 * The tool path round one contour, at a single depth (z 0; depthPasses() adds
 * the passes). cutSide: 'on' follows the outline; 'outside' and 'inside' keep the
 * tool centre exactly one tool radius away from it, arcs included: convex
 * corners get a rounding arc of the tool radius round the corner, concave
 * corners are cut where the two offset edges meet, and arcs too tight for the
 * tool are left out (the tool can't follow them; its neighbours meet instead).
 *
 * Closed contours arrive counter-clockwise in sketch (x, y) (generate.ts), so
 * the part is on the left of travel. With a clockwise (M3) spindle, climb
 * milling keeps the wall on the right of travel as seen on the machine, which is
 * the left in sketch (x, y) (the G-code flips Y): an outside cut is already
 * climb, an inside cut runs the other way.
 */
export interface ProfileResult {
  moves: ToolpathMove[];
  startPosition: Point;
  /** Set when this contour can't be offset safely; `moves` is then empty. */
  problem?: string;
}

export function toolpathProfile(
  segments: CncSegment[],
  toolDiameter: number,
  cutSide: 'inside' | 'outside' | 'on',
  cutDirection: 'climb' | 'conventional',
  feedRate: number,
): ProfileResult {
  if (segments.length === 0) return { moves: [], startPosition: { x: 0, y: 0 } };

  let path = segments;
  if (cutSide !== 'on') {
    // Open outlines have no inside or outside; validate.ts reports them.
    if (!isClosed(segments)) return { moves: [], startPosition: segments[0]!.from };
    const offset = offsetContour(segments, toolDiameter / 2, cutSide === 'outside' ? 1 : -1);
    if (offset.problem || offset.segments.length === 0) {
      return {
        moves: [],
        startPosition: segments[0]!.from,
        problem: offset.problem ?? 'the shape is too small for this tool',
      };
    }
    path = offset.segments;
  }

  // Conventional milling runs the other way from climb.
  const reverse = isClosed(segments) && ((cutSide === 'inside') === (cutDirection === 'climb'));
  if (reverse) path = reverseContour(path);

  return { moves: segmentsToMoves(path, feedRate), startPosition: path[0]!.from };
}

/** Feed moves along a chain of segments (z 0). */
export function segmentsToMoves(path: CncSegment[], feedRate: number): ToolpathMove[] {
  return path.map((seg): ToolpathMove => {
    if (seg.bulge === 0) return { kind: 'linear', to: seg.to, z: 0, feed: feedRate };
    const arc = arcFromBulge(seg.from, seg.to, seg.bulge);
    return {
      kind: 'arc',
      to: seg.to,
      z: 0,
      // I, J: the centre relative to the arc's start.
      center: { x: arc.center.x - seg.from.x, y: arc.center.y - seg.from.y },
      // Clockwise as seen on screen (see ArcMove): a positive bulge.
      clockwise: !arc.counterClockwise,
      feed: feedRate,
    };
  });
}

// ── Offsetting ──

/**
 * A line or a circle (the curve an edge lies on) and the stretch of it in use,
 * from parameter s0 to s1. Line: point(s) = p + s·t, t a unit vector. Circle:
 * point(s) = c + r·(cos, sin)(a0 + dir·s), s an angle; dir +1 turns
 * counter-clockwise in sketch (x, y).
 */
type Curve =
  | { kind: 'line'; p: Point; t: Point }
  | { kind: 'circle'; c: Point; r: number; a0: number; dir: 1 | -1 };

interface Elem {
  curve: Curve;
  /** The stretch as offset, before any trimming. */
  base: [number, number];
  s0: number;
  s1: number;
}

/** How two neighbouring offset edges join: they already meet, or they're cut where they cross. */
type Joint = 'meet' | 'cut';

const TOUCH = 1e-7;
/**
 * Offset edges at a convex corner closer than this (mm) are extended to meet
 * instead of joined by a rounding arc: the arc would be shorter than the
 * G-code's resolution (and an arc whose start and end print the same is a
 * full circle to GRBL). The extension is about half the gap.
 */
const MITER_GAP = 0.01;

function pointAt(c: Curve, s: number): Point {
  if (c.kind === 'line') return { x: c.p.x + c.t.x * s, y: c.p.y + c.t.y * s };
  const a = c.a0 + c.dir * s;
  return { x: c.c.x + c.r * Math.cos(a), y: c.c.y + c.r * Math.sin(a) };
}

/** Unit direction of travel at parameter s. */
function tangentAt(c: Curve, s: number): Point {
  if (c.kind === 'line') return c.t;
  const a = c.a0 + c.dir * s;
  return { x: -Math.sin(a) * c.dir, y: Math.cos(a) * c.dir };
}

/**
 * Parameter of a point on the curve. For a circle the angle is taken within
 * half a turn either side of the middle of `base`, so a stretch can be trimmed
 * or extended a little but not wrapped round.
 */
function paramOf(e: Elem, p: Point): number {
  const c = e.curve;
  if (c.kind === 'line') return (p.x - c.p.x) * c.t.x + (p.y - c.p.y) * c.t.y;
  const mid = (e.base[0] + e.base[1]) / 2;
  let s = c.dir * (Math.atan2(p.y - c.c.y, p.x - c.c.x) - c.a0);
  s -= 2 * Math.PI * Math.round((s - mid) / (2 * Math.PI));
  return s;
}

function elemFromSegment(seg: CncSegment): Elem {
  if (seg.bulge === 0) {
    const dx = seg.to.x - seg.from.x, dy = seg.to.y - seg.from.y;
    const len = Math.hypot(dx, dy);
    return { curve: { kind: 'line', p: seg.from, t: { x: dx / len, y: dy / len } }, base: [0, len], s0: 0, s1: len };
  }
  const arc = arcFromBulge(seg.from, seg.to, seg.bulge);
  const sweep = Math.abs(4 * Math.atan(seg.bulge));
  const a0 = Math.atan2(seg.from.y - arc.center.y, seg.from.x - arc.center.x);
  return { curve: { kind: 'circle', c: arc.center, r: arc.radius, a0, dir: seg.bulge > 0 ? 1 : -1 }, base: [0, sweep], s0: 0, s1: sweep };
}

/** The edge moved sideways by d (positive = to the right of travel); null when an arc collapses. */
function offsetElem(e: Elem, d: number): Elem | null {
  const c = e.curve;
  if (c.kind === 'line') {
    const p = { x: c.p.x + c.t.y * d, y: c.p.y - c.t.x * d };
    return { ...e, curve: { ...c, p } };
  }
  // Right of travel is away from the centre on a counter-clockwise arc.
  const r = c.r + d * c.dir;
  if (r <= 1e-9) return null;
  return { ...e, curve: { ...c, r } };
}

/** Where two curves cross, nearest `near`; null when they don't. */
function intersect(a: Curve, b: Curve, near: Point): Point | null {
  let pts: Point[] = [];
  if (a.kind === 'line' && b.kind === 'line') {
    const den = a.t.x * b.t.y - a.t.y * b.t.x;
    if (Math.abs(den) < 1e-12) return null;
    const s = ((b.p.x - a.p.x) * b.t.y - (b.p.y - a.p.y) * b.t.x) / den;
    pts = [{ x: a.p.x + a.t.x * s, y: a.p.y + a.t.y * s }];
  } else if (a.kind === 'circle' && b.kind === 'circle') {
    const dx = b.c.x - a.c.x, dy = b.c.y - a.c.y;
    const d = Math.hypot(dx, dy);
    if (d < 1e-12) return null;
    const along = (d * d + a.r * a.r - b.r * b.r) / (2 * d);
    let h2 = a.r * a.r - along * along;
    if (h2 < 0) {
      if (h2 < -1e-9 * a.r * a.r) return null;
      h2 = 0;
    }
    const h = Math.sqrt(h2);
    const mx = a.c.x + (dx / d) * along, my = a.c.y + (dy / d) * along;
    pts = [{ x: mx - (dy / d) * h, y: my + (dx / d) * h }, { x: mx + (dy / d) * h, y: my - (dx / d) * h }];
  } else {
    const line = (a.kind === 'line' ? a : b) as Extract<Curve, { kind: 'line' }>;
    const circ = (a.kind === 'circle' ? a : b) as Extract<Curve, { kind: 'circle' }>;
    const s = (circ.c.x - line.p.x) * line.t.x + (circ.c.y - line.p.y) * line.t.y;
    const foot = { x: line.p.x + line.t.x * s, y: line.p.y + line.t.y * s };
    let h2 = circ.r * circ.r - ((circ.c.x - foot.x) ** 2 + (circ.c.y - foot.y) ** 2);
    if (h2 < 0) {
      if (h2 < -1e-9 * circ.r * circ.r) return null;
      h2 = 0;
    }
    const h = Math.sqrt(h2);
    pts = [{ x: foot.x - line.t.x * h, y: foot.y - line.t.y * h }, { x: foot.x + line.t.x * h, y: foot.y + line.t.y * h }];
  }
  let best: Point | null = null;
  for (const p of pts) {
    if (!best || Math.hypot(p.x - near.x, p.y - near.y) < Math.hypot(best.x - near.x, best.y - near.y)) best = p;
  }
  return best;
}

const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

/**
 * Offset a closed contour by `r`: side +1 = to the right of travel (outside of
 * a counter-clockwise contour), -1 = to the left.
 */
function offsetContour(
  segments: CncSegment[],
  r: number,
  side: 1 | -1,
): { segments: CncSegment[]; problem?: string } {
  const source = segments.map(elemFromSegment);
  const d = side * r;

  // Offset every edge; arcs too tight for the tool drop out.
  let elems: Elem[] = [];
  /** joints[i] joins elems[i] to elems[i + 1]. */
  let joints: Joint[] = [];
  let collapsed: number | null = null;
  let lastKept = -1;
  const pending: { from: number; to: number }[] = []; // source indices of kept neighbours
  for (let i = 0; i < source.length; i++) {
    const off = offsetElem(source[i]!, d);
    if (!off) {
      const c = source[i]!.curve;
      if (collapsed === null && c.kind === 'circle') collapsed = c.r;
      continue;
    }
    if (lastKept >= 0) pending.push({ from: lastKept, to: i });
    elems.push(off);
    lastKept = i;
  }
  if (elems.length === 0) {
    return {
      segments: [],
      problem: collapsed !== null
        ? `an arc of radius ${collapsed.toFixed(2)}mm is too tight for a ${(2 * r).toFixed(2)}mm tool`
        : undefined,
    };
  }
  const firstKept = source.indexOf(source.find((_, i) => offsetElem(source[i]!, d) !== null)!);
  pending.push({ from: lastKept, to: firstKept });

  // Corners. Where two edges met at the outline, a corner the tool goes round
  // (a gap opens between the offset edges) gets an arc of the tool radius about
  // the corner; anything else is cut where the offset edges cross.
  const withArcs: Elem[] = [];
  const withJoints: Joint[] = [];
  for (let k = 0; k < elems.length; k++) {
    const a = elems[k]!, b = elems[(k + 1) % elems.length]!;
    withArcs.push(a);
    const { from, to } = pending[k]!;
    const adjacent = to === (from + 1) % source.length;
    const gap = dist(pointAt(a.curve, a.s1), pointAt(b.curve, b.s0));
    if (!adjacent) { withJoints.push('cut'); continue; }
    if (gap < TOUCH) { withJoints.push('meet'); continue; }
    const sa = source[from]!, sb = source[to]!;
    const ta = tangentAt(sa.curve, sa.s1), tb = tangentAt(sb.curve, sb.s0);
    const turn = Math.atan2(ta.x * tb.y - ta.y * tb.x, ta.x * tb.x + ta.y * tb.y);
    if (turn * side > 0 && gap >= MITER_GAP) {
      const v = pointAt(sa.curve, sa.s1);
      const p = pointAt(a.curve, a.s1);
      const sweep = Math.abs(turn);
      withArcs.push({
        curve: { kind: 'circle', c: v, r, a0: Math.atan2(p.y - v.y, p.x - v.x), dir: turn > 0 ? 1 : -1 },
        base: [0, sweep], s0: 0, s1: sweep,
      });
      withJoints.push('meet', 'meet');
    } else {
      withJoints.push('cut');
    }
  }
  elems = withArcs;
  joints = withJoints;

  // Trim at every cut; an edge trimmed away completely (it ran backwards), or
  // an arc that can't meet its neighbour, is dropped and its neighbours cut
  // against each other instead. Repeat until nothing more drops out.
  for (let guard = 0; guard <= source.length * 4 + 8; guard++) {
    for (const e of elems) { e.s0 = e.base[0]; e.s1 = e.base[1]; }
    let unreachable: number | null = null;
    if (elems.length === 1) break;
    for (let k = 0; k < elems.length; k++) {
      if (joints[k] !== 'cut') continue;
      const a = elems[k]!, b = elems[(k + 1) % elems.length]!;
      const pa = pointAt(a.curve, a.s1), pb = pointAt(b.curve, b.s0);
      if (dist(pa, pb) < TOUCH) continue;
      const x = intersect(a.curve, b.curve, { x: (pa.x + pb.x) / 2, y: (pa.y + pb.y) / 2 });
      if (x) {
        a.s1 = paramOf(a, x);
        b.s0 = paramOf(b, x);
        continue;
      }
      // They never cross. Two parallel lines (either side of an arc too tight
      // for the tool) are joined straight across; an arc that can't reach its
      // neighbour (it would only fit part of the tool) is left out. The check
      // at the end makes sure the joined path stays clear of the outline.
      if (a.curve.kind === 'line' && b.curve.kind === 'line') continue;
      unreachable = a.curve.kind === 'circle' && (b.curve.kind !== 'circle' || a.base[1] * a.curve.r <= b.base[1] * b.curve.r)
        ? k
        : (k + 1) % elems.length;
      break;
    }
    const gone = unreachable ?? elems.findIndex((e) => e.s1 - e.s0 <= 1e-9);
    if (gone < 0) break;
    const prevJoint = (gone - 1 + elems.length) % elems.length;
    elems.splice(gone, 1);
    joints[prevJoint] = 'cut';
    joints.splice(gone, 1);
    if (elems.length === 0) return { segments: [], problem: 'the shape is too small for this tool' };
  }

  // Back to segments, each starting exactly where the last one ended.
  const out: CncSegment[] = [];
  for (const e of elems) {
    const from = out.length > 0 ? out[out.length - 1]!.to : pointAt(e.curve, e.s0);
    const to = pointAt(e.curve, e.s1);
    out.push({ from, to, bulge: e.curve.kind === 'line' ? 0 : e.curve.dir * Math.tan((e.s1 - e.s0) / 4) });
  }
  if (out.length > 0) out[out.length - 1]!.to = out[0]!.from;

  // Last line of defence: the finished path must nowhere come closer to the
  // outline than the tool radius (narrow necks make the two sides cross).
  if (minDistanceTo(segments, out) < r - 1e-4) {
    return { segments: [], problem: 'the shape is too narrow in places for this tool: the tool would cut into it' };
  }
  return { segments: out };
}

/** The smallest distance from points along `path` to the outline. */
function minDistanceTo(outline: CncSegment[], path: CncSegment[]): number {
  const walls = outline.map(elemFromSegment);
  let min = Infinity;
  for (const seg of path) {
    const e = elemFromSegment(seg);
    const len = e.curve.kind === 'line' ? e.s1 : e.curve.r * e.s1;
    const n = Math.max(4, Math.ceil(len / 0.1));
    for (let k = 0; k <= n; k++) {
      const p = pointAt(e.curve, (e.s1 * k) / n);
      for (const w of walls) min = Math.min(min, distToElem(w, p));
    }
  }
  return min;
}

function distToElem(e: Elem, p: Point): number {
  const c = e.curve;
  if (c.kind === 'line') {
    const s = Math.max(e.s0, Math.min(e.s1, (p.x - c.p.x) * c.t.x + (p.y - c.p.y) * c.t.y));
    return dist(p, pointAt(c, s));
  }
  let s = c.dir * (Math.atan2(p.y - c.c.y, p.x - c.c.x) - c.a0);
  s = ((s % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  if (s <= e.s1) return Math.abs(dist(p, c.c) - c.r);
  return Math.min(dist(p, pointAt(c, e.s0)), dist(p, pointAt(c, e.s1)));
}
