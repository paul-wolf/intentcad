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
 * at its point nearest the end of the last one, and the link is a feed move only
 * when the whole link is over cleared floor and a tool radius clear of the walls.
 * Otherwise the link is a rapid, which depthPasses() turns into lift, travel and
 * plunge.
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
/** Spacing of the points checked along a link (mm). */
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

  // Cut them one pocket at a time, nearest first; in each, nearest available
  // ring first, preferring rings that can be reached by a feed move. A last
  // pass round the walls gives a clean finish.
  const tool: ToolState = {
    r,
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
  const pending = [...roots];
  while (pending.length > 0) {
    const root = pick(pending);
    const available: Node[] = [root];
    while (available.length > 0) {
      const node = pick(available);
      cutRings(tool, node.rings);
      available.push(...node.children);
    }
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

/** Cut these rings, each one nearest the tool next. */
function cutRings(tool: ToolState, rings: PathD[]) {
  const left = [...rings];
  while (left.length > 0) {
    let best = 0;
    if (tool.at) {
      let bestD = Infinity;
      for (const [i, ring] of left.entries()) {
        const q = nearestOn(ring, tool.at).point;
        const d = dist(tool.at, q) + (canFeed(tool, tool.at, q) ? 0 : 1e6);
        if (d < bestD) { bestD = d; best = i; }
      }
    }
    cutRing(tool, left.splice(best, 1)[0]!);
  }
}

function cutRing(tool: ToolState, ring: PathD) {
  const path = tool.reverse ? [...ring].reverse() : ring;
  // Start at the ring's point nearest the tool.
  let pts: Point[];
  if (tool.at) {
    const { index, point } = nearestOn(path, tool.at);
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
  if (tool.at && dist(tool.at, start) > 1e-9) {
    if (canFeed(tool, tool.at, start)) {
      tool.moves.push({ kind: 'linear', to: start, z: 0, feed: tool.feedRate });
      tool.cut.push([tool.at, start]);
    } else {
      tool.moves.push({ kind: 'rapid', to: start, z: 0 });
    }
  } else if (!tool.at) {
    tool.moves.push({ kind: 'rapid', to: start, z: 0 });
  }
  for (let i = 1; i < pts.length; i++) {
    tool.moves.push({ kind: 'linear', to: pts[i]!, z: 0, feed: tool.feedRate });
    tool.cut.push([pts[i - 1]!, pts[i]!]);
  }
  tool.at = pts[pts.length - 1]!;
}

/**
 * A straight feed from a to b is safe: every point of it is over floor that's
 * already been cut and at least a tool radius inside the walls.
 */
function canFeed(tool: ToolState, a: Point, b: Point): boolean {
  const n = Math.max(1, Math.ceil(dist(a, b) / LINK_STEP));
  for (let k = 0; k <= n; k++) {
    const p = { x: a.x + ((b.x - a.x) * k) / n, y: a.y + ((b.y - a.y) * k) / n };
    if (!insideEvenOdd(tool.wall, p)) return false;
    if (distToPaths(tool.wall, p) < tool.r + CLEARANCE / 4) return false;
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

function distToPaths(paths: PathsD, p: Point): number {
  let min = Infinity;
  for (const path of paths) {
    for (let i = 0, j = path.length - 1; i < path.length; j = i++) {
      min = Math.min(min, distToSegment(p, path[j]!, path[i]!));
    }
  }
  return min;
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
