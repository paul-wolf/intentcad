import {
  areaD,
  areaPathsD,
  differenceD,
  EndType,
  FillRule,
  inflatePathsD,
  JoinType,
  simplifyPathsD,
  unionD,
  type PathD,
  type PathsD,
} from 'clipper2-ts';
import type { Point } from '@/types/document';
import type { ToolpathMove } from '@/types/cam';
import type { CncSegment } from './entityToSegments';
import { arcFromBulge } from '@/utils/arcGeometry';
import { groupContours, isClosed } from './contours';

/**
 * Pocket clearing: concentric rings, offset from the walls with Clipper2 (so
 * concave pockets never give self-crossing rings), cut from the walls inwards.
 *
 * Every closed loop of the operation counts: a loop inside another is an island
 * (left standing), a loop inside an island is a pocket again, and separate loops
 * are separate pockets. The tool centre stays at least the tool radius from
 * every wall and island.
 *
 * Rings are linked inside material that's already been cleared: each ring starts
 * at its point nearest the end of the last one, and the link is a feed move when
 * it stays a tool radius clear of the walls and runs over cleared floor (apart
 * from its last stepover). Otherwise the tool lifts (depthPasses() turns a rapid
 * into lift, travel and plunge) and goes down where it has already cut, next to
 * the ring, so it only plunges into solid material at the start of a pocket.
 *
 * Direction: Clipper gives outer loops counter-clockwise and holes clockwise in
 * sketch (x, y), so the material left standing is on the right of travel; seen
 * on the machine (Y flipped) it is on the left, which is conventional milling
 * with a clockwise (M3) spindle. Climb runs every ring the other way.
 */
export interface PocketResult {
  moves: ToolpathMove[];
  startPosition: Point;
  /** Set when the pocket can't be cut; `moves` is then empty. */
  problem?: string;
  /** Set when it can be cut but leaves some floor uncut. */
  warning?: string;
}

/** Clipper's working precision: decimal places. */
const PRECISION = 6;
/** Largest gap between an arc and the chords that stand in for it (mm). */
const ARC_SAGITTA = 0.0005;
/** Tolerance of the round joins Clipper adds next to the walls (mm); their chords sit inside the true arc. */
const ARC_TOLERANCE = 0.001;
/** The same for rings further in, which only need to clear the floor. */
const INNER_ARC_TOLERANCE = 0.01;
/**
 * Extra clearance from the walls (mm), more than the chord errors above and
 * below together, so the tool centre is never closer to a wall than the tool radius.
 */
const CLEARANCE = 0.003;
/** Rings drop points that are within this of the line through their neighbours (mm). */
const SIMPLIFY = 0.0005;
const INNER_SIMPLIFY = 0.005;
/** Spacing of the points checked along a link for cleared floor (mm). */
const LINK_STEP = 0.25;

export function toolpathPocket(
  segments: CncSegment[],
  toolDiameter: number,
  stepover: number,
  direction: 'climb' | 'conventional',
  feedRate: number,
): PocketResult {
  const none = (problem?: string): PocketResult =>
    ({ moves: [], startPosition: segments[0]?.from ?? { x: 0, y: 0 }, problem });
  if (segments.length === 0) return none();

  const r = toolDiameter / 2;
  const step = toolDiameter * stepover;
  if (!(r > 0) || !(step > 0)) return none();

  const loops = groupContours(segments);
  const open = loops.find((l) => !isClosed(l));
  if (open) return { ...none('a pocket outline must be closed'), startPosition: open[0]!.from };

  // The area to clear: inside an odd number of loops.
  const region = unionD(loops.map(polygonize), [], FillRule.EvenOdd, PRECISION);
  const pieces = components(region);
  if (pieces.length === 0) return none();

  // Level 0, the tool centre one tool radius from every wall.
  const wall = simplifyPathsD(offset(region, -(r + CLEARANCE)), SIMPLIFY, true);
  const level0 = components(wall);
  for (const piece of pieces) {
    if (!level0.some((c) => contains(piece.outer, c.outer[0]!))) {
      return {
        ...none(`the pocket is too narrow for a ${toolDiameter.toFixed(2)}mm tool`),
        startPosition: piece.outer[0]!,
      };
    }
  }

  // The rings, as a tree: each piece of a level is cleared before the pieces
  // inside it. Coming in by a full stepover could leave uncut floor where a
  // piece narrows and vanishes from the next level, so a level that wouldn't
  // reach everything within a tool radius comes in by just under a tool radius.
  interface Node { rings: PathD[]; children: Node[] }
  const inner = Math.min(step, 0.98 * r);
  const build = (piece: Piece, guard: number): Node => {
    const paths = [piece.outer, ...piece.holes];
    let next = simplifyPathsD(offset(paths, -step, INNER_ARC_TOLERANCE), INNER_SIMPLIFY, true);
    if (step > inner) {
      const reach = offset(next, r, INNER_ARC_TOLERANCE);
      const deep = offset(paths, -r, INNER_ARC_TOLERANCE);
      const missed = differenceD(deep, reach, FillRule.NonZero, PRECISION);
      if (Math.abs(areaPathsD(missed)) > 1e-3) {
        next = simplifyPathsD(offset(paths, -inner, INNER_ARC_TOLERANCE), INNER_SIMPLIFY, true);
      }
    }
    const children = guard > 0 ? components(next).map((c) => build(c, guard - 1)) : [];
    return { rings: paths, children };
  };
  const roots = level0.map((c) => build(c, 10000));

  // Cut them one pocket at a time, nearest first. In each, a level's rings
  // that border what's already cut (the outer wall ring, coming in) go first,
  // then the levels inside it, then the rest of its rings (those round
  // islands), which by then have cleared floor next to them. A last pass round
  // the walls gives a clean finish.
  const tool: ToolState = {
    r,
    step,
    wall: region,
    cut: [],
    moves: [],
    at: null,
    feedRate,
    reverse: direction === 'climb',
  };
  const pick = (nodes: Node[]): Node => {
    let best = 0;
    let bestScore = Infinity;
    for (const [i, node] of nodes.entries()) {
      const q = tool.at ? nearestOn(node.rings[0]!, tool.at).point : node.rings[0]![0]!;
      const d = tool.at ? dist(tool.at, q) : 0;
      const score = d + (tool.at && !canFeed(tool, tool.at, q) ? 1e6 : 0);
      if (score < bestScore) { bestScore = score; best = i; }
    }
    return nodes.splice(best, 1)[0]!;
  };
  const cutNode = (node: Node) => {
    const left = [...node.rings];
    let started = false;
    while (left.length > 0) {
      const i = nearestFeedable(tool, left);
      if (i < 0 && started) break;
      cutRing(tool, left.splice(Math.max(i, 0), 1)[0]!);
      started = true;
    }
    const children = [...node.children];
    while (children.length > 0) cutNode(pick(children));
    cutRings(tool, left);
  };
  const pending = [...roots];
  while (pending.length > 0) {
    const root = pick(pending);
    cutNode(root);
    if (root.children.length > 0) cutRings(tool, root.rings);
  }

  // Floor the tool can't reach (narrow arms, sharp corners).
  const reached = offset(wall, r, INNER_ARC_TOLERANCE);
  const missed = differenceD(region, reached, FillRule.NonZero, PRECISION);
  // Corners always leave a little; only count what's more than a sliver.
  const sizeable = offset(missed, -0.5 * r, INNER_ARC_TOLERANCE);
  let warning: string | undefined;
  if (sizeable.length > 0) {
    const share = Math.abs(areaPathsD(missed)) / Math.abs(areaPathsD(region));
    const percent = Math.round(share * 100);
    const what = `${percent > 0 ? `${percent}%` : 'some'} of the pocket is too narrow for a ${toolDiameter.toFixed(2)}mm tool and would be left uncut`;
    if (share > 0.25) return { moves: [], startPosition: sizeable[0]![0]!, problem: what };
    warning = what;
  }

  const first = tool.moves[0];
  return { moves: tool.moves, startPosition: first ? first.to : segments[0]!.from, warning };
}

// ── Cutting ──

interface ToolState {
  r: number;
  /** The stepover (mm). */
  step: number;
  /** The area to clear (the walls). */
  wall: PathsD;
  /** Every stretch cut so far. */
  cut: [Point, Point][];
  moves: ToolpathMove[];
  /** Where the tool is (null before the first ring). */
  at: Point | null;
  feedRate: number;
  reverse: boolean;
}

/** Index of the ring the tool can feed onto with the shortest link, or -1. */
function nearestFeedable(tool: ToolState, rings: PathD[]): number {
  if (!tool.at) return -1;
  let best = -1;
  let bestD = Infinity;
  for (const [i, ring] of rings.entries()) {
    const q = nearestOn(ring, tool.at).point;
    const d = dist(tool.at, q);
    if (d < bestD && canFeed(tool, tool.at, q)) { bestD = d; best = i; }
  }
  return best;
}

/** Cut these rings, each one nearest the tool next, preferring those it can feed onto. */
function cutRings(tool: ToolState, rings: PathD[]) {
  const left = [...rings];
  while (left.length > 0) {
    let best = nearestFeedable(tool, left);
    if (best < 0 && tool.at) {
      let bestD = Infinity;
      for (const [i, ring] of left.entries()) {
        const d = dist(tool.at, nearestOn(ring, tool.at).point);
        if (d < bestD) { bestD = d; best = i; }
      }
    }
    cutRing(tool, left.splice(Math.max(best, 0), 1)[0]!);
  }
}

function cutRing(tool: ToolState, ring: PathD) {
  const path = tool.reverse ? [...ring].reverse() : ring;
  // Start at the ring's point nearest the tool. When the tool can't feed
  // there, go down somewhere already cut that it can feed onto the ring from,
  // so it never plunges into solid material (except at the first ring).
  let entry: { down: Point; onto: Point } | null = null;
  if (tool.at) {
    const q = nearestOn(path, tool.at).point;
    entry = canFeed(tool, tool.at, q) ? { down: tool.at, onto: q } : findEntry(tool, path) ?? { down: q, onto: q };
  }
  let pts: Point[];
  if (entry) {
    const { index, point } = nearestOn(path, entry.onto);
    // `point` lies on the edge from path[index] to the next point.
    const n = path.length;
    pts = [point];
    for (let k = 1; k <= n; k++) pts.push(path[(index + k) % n]!);
    pts.push(point);
  } else {
    pts = [...path, path[0]!];
  }
  pts = pts.filter((p, i) => i === 0 || dist(p, pts[i - 1]!) > 1e-9);

  const start = pts[0]!;
  if (!tool.at || !entry) {
    tool.moves.push({ kind: 'rapid', to: start, z: 0 });
  } else {
    if (dist(tool.at, entry.down) > 1e-9) tool.moves.push({ kind: 'rapid', to: entry.down, z: 0 });
    if (dist(entry.down, start) > 1e-9) {
      tool.moves.push({ kind: 'linear', to: start, z: 0, feed: tool.feedRate });
      tool.cut.push([entry.down, start]);
    }
  }
  for (let i = 1; i < pts.length; i++) {
    tool.moves.push({ kind: 'linear', to: pts[i]!, z: 0, feed: tool.feedRate });
    tool.cut.push([pts[i - 1]!, pts[i]!]);
  }
  tool.at = pts[pts.length - 1]!;
}

/**
 * A point already cut and a point on the ring with a safe feed between them,
 * as close together as possible; null when there's none.
 */
function findEntry(tool: ToolState, ring: PathD): { down: Point; onto: Point } | null {
  if (tool.cut.length === 0) return null;
  // Points along the ring, no more than about a millimetre apart.
  const samples: Point[] = [];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!, b = ring[(i + 1) % ring.length]!;
    const n = Math.max(1, Math.ceil(dist(a, b)));
    for (let k = 0; k < n; k++) samples.push({ x: a.x + ((b.x - a.x) * k) / n, y: a.y + ((b.y - a.y) * k) / n });
  }
  const every = Math.max(1, Math.floor(samples.length / 400));
  const pairs: { down: Point; onto: Point; d: number }[] = [];
  for (let i = 0; i < samples.length; i += every) {
    const q = samples[i]!;
    let best: Point | null = null;
    let bestD = Infinity;
    for (const [a, b] of tool.cut) {
      const c = closestOnSegment(q, a, b);
      const d = dist(q, c);
      if (d < bestD) { bestD = d; best = c; }
    }
    if (best) pairs.push({ down: best, onto: q, d: bestD });
  }
  pairs.sort((a, b) => a.d - b.d);
  for (const pair of pairs.slice(0, 12)) {
    if (canFeed(tool, pair.down, pair.onto)) return { down: pair.down, onto: pair.onto };
  }
  return null;
}

/**
 * A straight feed from a to b is safe: it stays inside the walls and at least
 * a tool radius from them, and runs over floor that's already been cut,
 * except for its last stepover onto the next ring.
 */
function canFeed(tool: ToolState, a: Point, b: Point): boolean {
  if (!insideEvenOdd(tool.wall, a)) return false;
  if (segmentToPaths(tool.wall, a, b) < tool.r + CLEARANCE / 4) return false;
  const reach = Math.max(tool.step, tool.r) + 1e-9;
  const n = Math.max(1, Math.ceil(dist(a, b) / LINK_STEP));
  for (let k = 0; k <= n; k++) {
    const p = { x: a.x + ((b.x - a.x) * k) / n, y: a.y + ((b.y - a.y) * k) / n };
    if (dist(p, b) <= reach) continue;
    if (!nearCut(tool.cut, p, tool.r)) return false;
  }
  return true;
}

function nearCut(cut: [Point, Point][], p: Point, r: number): boolean {
  for (const [a, b] of cut) {
    if (distToSegment(p, a, b) <= r) return true;
  }
  return false;
}

// ── Geometry ──

interface Piece { outer: PathD; holes: PathD[] }

/** Round-joined offset (negative = inwards). */
function offset(paths: PathsD, delta: number, arcTolerance = ARC_TOLERANCE): PathsD {
  if (paths.length === 0) return [];
  return inflatePathsD(paths, delta, JoinType.Round, EndType.Polygon, 2, PRECISION, arcTolerance)
    .filter((p) => p.length >= 3 && Math.abs(areaD(p)) > 1e-9);
}

/**
 * Split Clipper output into separate pieces: each outer loop (counter-clockwise
 * in x, y) with the holes (clockwise) directly inside it.
 */
function components(paths: PathsD): Piece[] {
  const outers = paths.filter((p) => areaD(p) > 0).sort((a, b) => areaD(a) - areaD(b));
  const pieces = outers.map((outer): Piece => ({ outer, holes: [] }));
  for (const hole of paths.filter((p) => areaD(p) < 0)) {
    // The smallest outer loop round the hole.
    const owner = pieces.find((pc) => contains(pc.outer, hole[0]!));
    owner?.holes.push(hole);
  }
  return pieces;
}

function contains(path: PathD, p: Point): boolean {
  return insideEvenOdd([path], p);
}

function insideEvenOdd(paths: PathsD, p: Point): boolean {
  let inside = false;
  for (const path of paths) {
    for (let i = 0, j = path.length - 1; i < path.length; j = i++) {
      const a = path[i]!, b = path[j]!;
      if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
    }
  }
  return inside;
}

/** The smallest distance between segment ab and the edges of the paths. */
function segmentToPaths(paths: PathsD, a: Point, b: Point): number {
  let min = Infinity;
  for (const path of paths) {
    for (let i = 0, j = path.length - 1; i < path.length; j = i++) {
      min = Math.min(min, segmentToSegment(a, b, path[j]!, path[i]!));
    }
  }
  return min;
}

function segmentToSegment(a: Point, b: Point, c: Point, d: Point): number {
  const cross = (p: Point, q: Point, r: Point) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const d1 = cross(c, d, a), d2 = cross(c, d, b), d3 = cross(a, b, c), d4 = cross(a, b, d);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return 0;
  return Math.min(distToSegment(a, c, d), distToSegment(b, c, d), distToSegment(c, a, b), distToSegment(d, a, b));
}

/** The point of a closed path nearest p, and the index of the edge it's on. */
function nearestOn(path: PathD, p: Point): { index: number; point: Point } {
  let best = { index: 0, point: path[0]! as Point };
  let bestD = Infinity;
  for (let i = 0; i < path.length; i++) {
    const a = path[i]!, b = path[(i + 1) % path.length]!;
    const q = closestOnSegment(p, a, b);
    const d = dist(p, q);
    if (d < bestD) { bestD = d; best = { index: i, point: q }; }
  }
  return best;
}

function closestOnSegment(p: Point, a: Point, b: Point): Point {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-18) return { x: a.x, y: a.y };
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return { x: a.x + dx * t, y: a.y + dy * t };
}

function distToSegment(p: Point, a: Point, b: Point): number {
  return dist(p, closestOnSegment(p, a, b));
}

const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

/** A closed loop as a polygon, arcs as chords no more than ARC_SAGITTA from them. */
function polygonize(loop: CncSegment[]): PathD {
  const pts: PathD = [];
  for (const seg of loop) {
    pts.push({ x: seg.from.x, y: seg.from.y });
    if (seg.bulge === 0) continue;
    const arc = arcFromBulge(seg.from, seg.to, seg.bulge);
    const sweep = 4 * Math.atan(seg.bulge); // counter-clockwise in (x, y) when positive
    const maxStep = 2 * Math.acos(Math.max(-1, 1 - ARC_SAGITTA / arc.radius));
    const n = Math.max(1, Math.ceil(Math.abs(sweep) / maxStep));
    const a0 = Math.atan2(seg.from.y - arc.center.y, seg.from.x - arc.center.x);
    for (let k = 1; k < n; k++) {
      const a = a0 + (sweep * k) / n;
      pts.push({ x: arc.center.x + arc.radius * Math.cos(a), y: arc.center.y + arc.radius * Math.sin(a) });
    }
  }
  return pts;
}
