/**
 * Trim: remove the piece of a curve between its neighbouring intersections
 * with the rest of the sketch (or with itself).
 *
 * A polyline is one curve along all its segments (arcs included): a piece
 * runs across vertices up to the next crossing or to an open end. Removing a
 * piece from an open polyline leaves up to two polylines; from a closed one,
 * one open polyline. A circle becomes an arc (a one-segment polyline with a
 * bulge); a rectangle a polyline first. Constraints and dimensions follow the
 * points and segments that survive, where they still mean the same thing.
 */
import type { CircleEntity, Constraint, DimensionEntity, Entity, LineEntity, Point, RectangleEntity } from '@/types/document';
import { arcFromBulge } from '@/utils/arcGeometry';
import { getSegmentBulge, getSegmentCount } from '@/utils/lineSegments';
import { rectanglePath, effectiveCornerRadius } from '@/utils/rectPath';
import { remapRefs, type IndexMap } from '@/utils/remapRefs';

const TAU = Math.PI * 2;
/** distances (mm) closer than this are the same point */
const TOL = 1e-6;
/** parameters closer than this are the same place on a curve */
const PEPS = 1e-7;

// ---- primitives ----

export type Prim =
  | { kind: 'seg'; a: Point; b: Point }
  /** sweep is signed: positive runs the angle up; a whole circle is 2π */
  | { kind: 'arc'; c: Point; r: number; start: number; sweep: number };

function segPrim(p1: Point, p2: Point, bulge: number): Prim {
  if (!bulge) return { kind: 'seg', a: p1, b: p2 };
  const arc = arcFromBulge(p1, p2, bulge);
  return { kind: 'arc', c: arc.center, r: arc.radius, start: arc.startAngle, sweep: 4 * Math.atan(bulge) };
}

/** A polyline's segments as primitives, in order. */
export function linePrims(line: LineEntity): Prim[] {
  const n = getSegmentCount(line);
  const out: Prim[] = [];
  for (let j = 0; j < n; j++) {
    out.push(segPrim(line.points[j]!, line.points[(j + 1) % line.points.length]!, getSegmentBulge(line, j)));
  }
  return out;
}

function bezierAt(cp: Point[], t: number): Point {
  const u = 1 - t;
  const [a, b, c, d] = cp as [Point, Point, Point, Point];
  return {
    x: u * u * u * a.x + 3 * u * u * t * b.x + 3 * u * t * t * c.x + t * t * t * d.x,
    y: u * u * u * a.y + 3 * u * u * t * b.y + 3 * u * t * t * c.y + t * t * t * d.y,
  };
}

/** What an entity cuts other curves with (points don't: a marker on an
 *  outline isn't a place to cut it). */
export function cutterPrims(e: Entity): Prim[] {
  switch (e.type) {
    case 'line': return linePrims(e);
    case 'circle': return [{ kind: 'arc', c: e.center, r: e.radius, start: 0, sweep: TAU }];
    case 'rectangle': {
      const { points, bulge } = rectanglePath(e);
      return points.map((p, i) => segPrim(p, points[(i + 1) % points.length]!, bulge[i] ?? 0));
    }
    case 'bezier': {
      const out: Prim[] = [];
      const N = 48;
      let prev = e.controlPoints[0];
      for (let i = 1; i <= N; i++) {
        const p = bezierAt(e.controlPoints, i / N);
        out.push({ kind: 'seg', a: prev, b: p });
        prev = p;
      }
      return out;
    }
    default: return [];
  }
}

/** Where on `prim` (0..1) the point `p` is, or null when it isn't on it. */
export function paramOn(prim: Prim, p: Point, tol = TOL): number | null {
  if (prim.kind === 'seg') {
    const dx = prim.b.x - prim.a.x, dy = prim.b.y - prim.a.y;
    const len2 = dx * dx + dy * dy;
    if (len2 === 0) return null;
    const t = ((p.x - prim.a.x) * dx + (p.y - prim.a.y) * dy) / len2;
    const len = Math.sqrt(len2);
    if (t < -tol / len || t > 1 + tol / len) return null;
    const tc = Math.min(1, Math.max(0, t));
    const q = { x: prim.a.x + tc * dx, y: prim.a.y + tc * dy };
    return Math.hypot(p.x - q.x, p.y - q.y) <= tol ? tc : null;
  }
  const d = Math.hypot(p.x - prim.c.x, p.y - prim.c.y);
  if (Math.abs(d - prim.r) > tol) return null;
  return arcFraction(prim, Math.atan2(p.y - prim.c.y, p.x - prim.c.x), tol / Math.max(prim.r, TOL));
}

/** How far along an arc (0..1) the angle `phi` is; null when off it. */
function arcFraction(prim: Extract<Prim, { kind: 'arc' }>, phi: number, angTol: number): number | null {
  const s = Math.sign(prim.sweep) || 1;
  let d = (phi - prim.start) * s; // the way the arc runs
  d = ((d % TAU) + TAU) % TAU;
  const span = Math.abs(prim.sweep);
  if (span >= TAU - 1e-12) return d / TAU >= 1 - 1e-12 ? 0 : d / TAU;
  if (d <= span + angTol) return Math.min(1, d / span);
  if (d >= TAU - angTol) return 0;
  return null;
}

/** The point at fraction t along a primitive. */
export function primPoint(prim: Prim, t: number): Point {
  if (prim.kind === 'seg') return { x: prim.a.x + (prim.b.x - prim.a.x) * t, y: prim.a.y + (prim.b.y - prim.a.y) * t };
  const a = prim.start + prim.sweep * t;
  return { x: prim.c.x + prim.r * Math.cos(a), y: prim.c.y + prim.r * Math.sin(a) };
}

/** The point of a primitive nearest `p`, and its fraction. */
export function nearestOn(prim: Prim, p: Point): { t: number; point: Point; dist: number } {
  let t: number;
  if (prim.kind === 'seg') {
    const dx = prim.b.x - prim.a.x, dy = prim.b.y - prim.a.y;
    const len2 = dx * dx + dy * dy;
    t = len2 === 0 ? 0 : Math.min(1, Math.max(0, ((p.x - prim.a.x) * dx + (p.y - prim.a.y) * dy) / len2));
  } else {
    const f = arcFraction(prim, Math.atan2(p.y - prim.c.y, p.x - prim.c.x), 0);
    if (f != null) t = f;
    else {
      const a = primPoint(prim, 0), b = primPoint(prim, 1);
      t = Math.hypot(p.x - a.x, p.y - a.y) <= Math.hypot(p.x - b.x, p.y - b.y) ? 0 : 1;
    }
  }
  const point = primPoint(prim, t);
  return { t, point, dist: Math.hypot(p.x - point.x, p.y - point.y) };
}

// ---- intersections ----

/** Points where the lines / circles under two primitives meet (overlaps: the
 *  primitives' ends instead). Filtered onto both by the caller. */
function candidates(p: Prim, q: Prim): Point[] {
  const ends = (x: Prim) => [primPoint(x, 0), primPoint(x, 1)];
  if (p.kind === 'seg' && q.kind === 'seg') {
    const rx = p.b.x - p.a.x, ry = p.b.y - p.a.y;
    const sx = q.b.x - q.a.x, sy = q.b.y - q.a.y;
    const den = rx * sy - ry * sx;
    const scale = Math.hypot(rx, ry) * Math.hypot(sx, sy);
    if (Math.abs(den) <= 1e-12 * scale) return [...ends(p), ...ends(q)]; // parallel: touching ends only
    const t = ((q.a.x - p.a.x) * sy - (q.a.y - p.a.y) * sx) / den;
    return [{ x: p.a.x + t * rx, y: p.a.y + t * ry }];
  }
  if (p.kind === 'arc' && q.kind === 'arc') {
    const dx = q.c.x - p.c.x, dy = q.c.y - p.c.y;
    const d = Math.hypot(dx, dy);
    if (d < TOL) return Math.abs(p.r - q.r) < TOL ? [...ends(p), ...ends(q)] : [];
    if (d > p.r + q.r + TOL || d < Math.abs(p.r - q.r) - TOL) return [];
    const a = (p.r * p.r - q.r * q.r + d * d) / (2 * d);
    const h = Math.sqrt(Math.max(0, p.r * p.r - a * a));
    const mx = p.c.x + (a * dx) / d, my = p.c.y + (a * dy) / d;
    if (h < TOL) return [{ x: mx, y: my }];
    return [
      { x: mx + (h * -dy) / d, y: my + (h * dx) / d },
      { x: mx - (h * -dy) / d, y: my - (h * dx) / d },
    ];
  }
  const seg = (p.kind === 'seg' ? p : q) as Extract<Prim, { kind: 'seg' }>;
  const arc = (p.kind === 'arc' ? p : q) as Extract<Prim, { kind: 'arc' }>;
  const dx = seg.b.x - seg.a.x, dy = seg.b.y - seg.a.y;
  const fx = seg.a.x - arc.c.x, fy = seg.a.y - arc.c.y;
  const A = dx * dx + dy * dy;
  if (A === 0) return [];
  const B = 2 * (fx * dx + fy * dy);
  const C = fx * fx + fy * fy - arc.r * arc.r;
  let disc = B * B - 4 * A * C;
  // a tangent touch: the foot of the perpendicular, if it's on the circle
  const foot = -B / (2 * A);
  const footPt = { x: seg.a.x + foot * dx, y: seg.a.y + foot * dy };
  if (disc < 0) {
    return Math.abs(Math.hypot(footPt.x - arc.c.x, footPt.y - arc.c.y) - arc.r) <= TOL ? [footPt] : [];
  }
  disc = Math.sqrt(disc);
  const t1 = (-B - disc) / (2 * A), t2 = (-B + disc) / (2 * A);
  return [{ x: seg.a.x + t1 * dx, y: seg.a.y + t1 * dy }, { x: seg.a.x + t2 * dx, y: seg.a.y + t2 * dy }];
}

/** Where `cutter` crosses or touches `target`, as fractions along target. */
export function crossings(target: Prim, cutter: Prim): number[] {
  const out: number[] = [];
  for (const pt of candidates(target, cutter)) {
    if (!isFinite(pt.x) || !isFinite(pt.y)) continue;
    const t = paramOn(target, pt);
    if (t == null || paramOn(cutter, pt) == null) continue;
    out.push(t);
  }
  return out;
}

// ---- a trimmable curve ----

/** A curve trim works on: a polyline (rectangles converted) or a circle. */
export interface TrimCurve {
  entity: LineEntity | CircleEntity;
  prims: Prim[];
  /** parameter range: 0..prims.length (a circle: 0..1) */
  closed: boolean;
}

/** A rectangle as the closed polyline it draws as (same id). */
export function rectangleAsLine(rect: RectangleEntity): LineEntity {
  const { points, bulge } = rectanglePath(rect);
  const line: LineEntity = { id: rect.id, type: 'line', points, closed: true };
  if (bulge.some((b) => b !== 0)) line.bulge = bulge;
  for (const k of ['construction', 'fill'] as const) if (rect[k]) line[k] = true;
  return line;
}

/** Can this entity be trimmed? (Not copies, which follow their source, nor
 *  reference geometry, which follows the part.) */
export function trimmable(e: Entity): boolean {
  if (e.type !== 'line' && e.type !== 'circle' && e.type !== 'rectangle') return false;
  if (e.sourceId || e.reference) return false;
  if (e.type === 'line' && e.points.length < 2) return false;
  return true;
}

export function trimCurve(e: Entity): TrimCurve | null {
  if (!trimmable(e)) return null;
  if (e.type === 'circle') return { entity: e, prims: cutterPrims(e), closed: true };
  const line = e.type === 'rectangle' ? rectangleAsLine(e) : (e as LineEntity);
  return { entity: line, prims: linePrims(line), closed: !!line.closed };
}

/** The sorted places (parameters) where the rest of the sketch, or the curve
 *  itself, crosses `curve`. */
export function boundaries(curve: TrimCurve, entities: Entity[]): number[] {
  const out: number[] = [];
  const self = curve.entity.id;
  const n = curve.prims.length;
  for (const e of entities) {
    if (e.id === self || e.type === 'dimension' || e.type === 'text') continue;
    const cut = cutterPrims(e);
    curve.prims.forEach((p, j) => {
      for (const c of cut) for (const t of crossings(p, c)) out.push(j + t);
    });
  }
  // the curve against itself: not at the vertex two neighbouring segments share
  if (curve.entity.type === 'line') {
    const pts = curve.entity.points;
    for (let i = 0; i < n; i++) {
      for (let k = 0; k < n; k++) {
        if (k === i) continue;
        const shared: Point[] = [];
        if ((i + 1) % pts.length === k) shared.push(pts[k]!);
        if ((k + 1) % pts.length === i) shared.push(pts[i]!);
        for (const t of crossings(curve.prims[i]!, curve.prims[k]!)) {
          const at = primPoint(curve.prims[i]!, t);
          if (shared.some((s) => Math.hypot(s.x - at.x, s.y - at.y) <= TOL * 10)) continue;
          out.push(i + t);
        }
      }
    }
  }
  // closed: n ≡ 0
  const norm = out.map((s) => (curve.closed && s >= n - PEPS ? 0 : s)).sort((a, b) => a - b);
  const uniq: number[] = [];
  for (const s of norm) if (!uniq.length || s - uniq[uniq.length - 1]! > PEPS) uniq.push(s);
  if (curve.closed && uniq.length > 1 && n - uniq[uniq.length - 1]! + uniq[0]! <= PEPS) uniq.pop();
  return uniq;
}

/** The piece of a curve around parameter `s`: from `start` to `end` (end may
 *  pass `n` on a closed curve, wrapping round), or the whole curve. */
export interface Piece {
  start: number;
  end: number;
  whole: boolean;
}

export function pieceAt(curve: TrimCurve, bounds: number[], s: number): Piece {
  const n = curve.prims.length;
  if (!curve.closed) {
    const inner = bounds.filter((b) => b > PEPS && b < n - PEPS);
    let start = 0, end = n;
    for (const b of inner) {
      if (b <= s) start = b;
      else { end = b; break; }
    }
    return { start, end, whole: start === 0 && end === n };
  }
  if (bounds.length < 2) return { start: 0, end: n, whole: true };
  let i = bounds.findIndex((b) => b > s);
  if (i === -1) i = 0;
  const end = bounds[i]!;
  const start = bounds[(i - 1 + bounds.length) % bounds.length]!;
  return { start, end: end > start ? end : end + n, whole: false };
}

// ---- building pieces ----

/** The polyline along `curve` from parameter s0 to s1 (s1 > s0; may wrap a
 *  closed curve), with where each original vertex and segment went. */
function subLine(curve: TrimCurve, s0: number, s1: number, id: string): {
  line: LineEntity;
  vertex: Map<number, number>;
  segment: Map<number, { index: number; whole: boolean }>;
} {
  const n = curve.prims.length;
  const src = curve.entity as LineEntity;
  // an original vertex's index at parameter m (closed curves wrap round)
  const vertexAt = (m: number) => (curve.closed ? ((Math.round(m) % n) + n) % n : Math.round(m));
  const at = (s: number): Point => {
    const w = curve.closed ? ((s % n) + n) % n : s;
    const j = Math.min(n - 1, Math.floor(w + PEPS));
    return primPoint(curve.prims[j]!, Math.min(1, Math.max(0, w - j)));
  };
  // the marks along the way: s0, the vertices strictly inside, s1
  const marks: number[] = [s0];
  for (let k = Math.floor(s0 + PEPS) + 1; k < s1 - PEPS; k++) marks.push(k);
  marks.push(s1);
  const isVertex = (m: number) => Math.abs(m - Math.round(m)) < PEPS;
  const points = marks.map((m) => (isVertex(m) ? src.points[vertexAt(m)]! : at(m)));
  const bulge: number[] = [];
  const segment = new Map<number, { index: number; whole: boolean }>();
  for (let i = 0; i + 1 < marks.length; i++) {
    const a = marks[i]!, b = marks[i + 1]!;
    const j = Math.floor(a + PEPS);
    const orig = ((j % n) + n) % n;
    const bj = getSegmentBulge(src, orig);
    const frac = b - a;
    bulge.push(bj ? Math.tan(Math.atan(bj) * Math.min(1, frac)) : 0);
    const whole = frac > 1 - PEPS;
    const prev = segment.get(orig);
    if (!prev || (whole && !prev.whole)) segment.set(orig, { index: i, whole });
  }
  const vertex = new Map<number, number>();
  marks.forEach((m, i) => { if (isVertex(m) && !vertex.has(vertexAt(m))) vertex.set(vertexAt(m), i); });
  const line: LineEntity = { id, type: 'line', points };
  if (bulge.some((b) => b !== 0)) line.bulge = bulge;
  for (const k of ['construction', 'fill'] as const) if (src[k]) line[k] = true;
  return { line, vertex, segment };
}

/** Constraint types that still mean the same on a shorter piece of their
 *  segment: about its direction or the infinite line / circle through it. */
const DIRECTIONAL = new Set<Constraint['type']>(['horizontal', 'vertical', 'parallel', 'perpendicular', 'tangent', 'pointOnCurve', 'symmetric']);

/** Is `x` still right when the segments in `cut` (of entity `id`) got shorter? */
function stillApplies(x: Constraint | Entity, id: string, cut: (seg: number) => boolean): boolean {
  if (x.type === 'dimension') {
    if (x.radius || x.angleMode) return true;
    const segs: number[] = [];
    if (x.targetEntityId === id && x.pointIndex == null) segs.push(x.segmentIndex);
    if (x.targetEntityId2 === id && x.pointIndex2 == null && x.segmentIndex2 != null) segs.push(x.segmentIndex2);
    return !segs.some(cut);
  }
  const c = x as unknown as Record<string, unknown>;
  // an equal on the whole shape (no segment) compares what's now shorter
  if (x.type === 'equal' && ((x.entityId === id && x.segmentIndex == null) || (x.targetEntityId === id && x.targetSegmentIndex == null))) return false;
  if (DIRECTIONAL.has(x.type as Constraint['type'])) return true;
  const pairs: [string, string][] = [['entityId', 'segmentIndex'], ['targetEntityId', 'targetSegmentIndex'], ['targetEntityId', 'segmentIndex']];
  for (const [ek, ik] of pairs) if (c[ek] === id && typeof c[ik] === 'number' && cut(c[ik] as number)) return false;
  return true;
}

export interface TrimOutcome {
  entities: Entity[];
  constraints: Constraint[];
  /** constraints and dimensions that no longer applied */
  dropped: number;
  /** the whole shape went (nothing crossed it there) */
  removedWhole: boolean;
  /** ids of the pieces left (the first keeps the shape's id) */
  pieces: string[];
}

/** Refer constraints to a rectangle as to the polyline it becomes: corners →
 *  vertices (square corners only), sides → segments, corner radius → the arcs. */
function rectangleToLine(entities: Entity[], constraints: Constraint[], rect: RectangleEntity) {
  const filleted = effectiveCornerRadius(rect) > 0;
  const point: IndexMap = (i) => (i >= 1 && i <= 4 && !filleted ? i - 1 : null);
  const segment: IndexMap = (i, ref) => {
    if (ref.type === 'dimension' && ref.radius) return filleted ? (2 * (((i % 4) + 4) % 4) + 7) % 8 : null;
    if (i < 0 || i > 3) return null;
    return filleted ? 2 * i : i;
  };
  const line = rectangleAsLine(rect);
  const wholeEqual = (x: Constraint | Entity) => x.type === 'equal'
    && ((x.entityId === rect.id && x.segmentIndex == null) || (x.targetEntityId === rect.id && x.targetSegmentIndex == null));
  const re = remapRefs(entities, constraints, { entityId: rect.id, point, segment }, (x) => !wholeEqual(x));
  return { entities: re.entities.map((e) => (e.id === rect.id ? line : e)), constraints: re.constraints, dropped: re.dropped };
}

/** Refer constraints to a circle as to the arc it becomes: point on the
 *  circle stays (on the arc's circle), its diameter becomes the arc's radius;
 *  the rest (its centre, tangency, equal size) is dropped. */
function circleToArc(entities: Entity[], constraints: Constraint[], circleId: string) {
  let dropped = 0;
  const outC: Constraint[] = [];
  for (const c of constraints) {
    const refs = c.entityId === circleId || ('targetEntityId' in c && c.targetEntityId === circleId) || ('entityId2' in c && c.entityId2 === circleId);
    if (!refs || c.type === 'fixed') { outC.push(c); continue; }
    if (c.type === 'pointOnCurve' && c.targetEntityId === circleId && c.entityId !== circleId) { outC.push({ ...c, segmentIndex: 0 }); continue; }
    dropped++;
  }
  const outE: Entity[] = [];
  for (const e of entities) {
    if (e.type !== 'dimension' || (e.targetEntityId !== circleId && e.targetEntityId2 !== circleId)) { outE.push(e); continue; }
    if (e.targetEntityId === circleId && e.targetEntityId2 == null && e.pointIndex == null && e.pointIndex2 == null) {
      const d: DimensionEntity = { ...e, segmentIndex: 0, radius: true };
      if (e.expression) d.expression = `(${e.expression}) / 2`;
      outE.push(d);
      continue;
    }
    dropped++;
  }
  return { entities: outE, constraints: outC, dropped };
}

/** Remove the piece of `entityId` around parameter `s` (as hitTrim gives it). */
export function trimSketch(entities: Entity[], constraints: Constraint[], entityId: string, s: number, newId: () => string): TrimOutcome | null {
  const orig = entities.find((e) => e.id === entityId);
  if (!orig) return null;
  const curve = trimCurve(orig);
  if (!curve) return null;
  const bounds = boundaries(curve, entities);
  const piece = pieceAt(curve, bounds, s);
  if (piece.whole) {
    const ids = new Set([entityId]);
    const keptC = constraints.filter((c) => !refsAny(c, ids));
    const keptE = entities.filter((e) => e.id !== entityId && !(e.type === 'dimension' && (ids.has(e.targetEntityId) || (e.targetEntityId2 != null && ids.has(e.targetEntityId2)))));
    return {
      entities: keptE,
      constraints: keptC,
      dropped: constraints.length - keptC.length + (entities.length - 1 - keptE.length),
      removedWhole: true,
      pieces: [],
    };
  }

  if (curve.entity.type === 'circle') {
    const c = curve.entity;
    const prim = curve.prims[0]!;
    const b = piece.end % 1, a = piece.start;
    const sweep = ((a - b + 1) % 1 || 1) * TAU;
    const arc: LineEntity = { id: c.id, type: 'line', points: [primPoint(prim, b), primPoint(prim, b + sweep / TAU)], bulge: [Math.tan(sweep / 4)] };
    for (const k of ['construction', 'fill'] as const) if (c[k]) arc[k] = true;
    const re = circleToArc(entities, constraints, c.id);
    return {
      entities: re.entities.map((e) => (e.id === c.id ? arc : e)),
      constraints: re.constraints,
      dropped: re.dropped,
      removedWhole: false,
      pieces: [c.id],
    };
  }

  let dropped = 0;
  if (orig.type === 'rectangle') {
    const r = rectangleToLine(entities, constraints, orig);
    entities = r.entities; constraints = r.constraints; dropped += r.dropped;
  }
  const n = curve.prims.length;
  const ranges: [number, number][] = curve.closed
    ? [[piece.end, piece.start + n]]
    : ([[0, piece.start], [piece.end, n]] as [number, number][]).filter(([x, y]) => y - x > PEPS);
  const ids = ranges.map((_, i) => (i === 0 ? entityId : newId()));
  const built = ranges.map(([x, y], i) => subLine(curve, x, y, ids[i]!));
  const findIn = (pick: (b: (typeof built)[number]) => number | undefined) => {
    for (let i = 0; i < built.length; i++) {
      const idx = pick(built[i]!);
      if (idx != null) return { entityId: ids[i]!, index: idx };
    }
    return null;
  };
  const isPolygon = curve.entity.type === 'line' && !!curve.entity.polygonCenter;
  const nPts = (curve.entity as LineEntity).points.length;
  const point: IndexMap = (i) => (isPolygon && i === nPts ? null : findIn((b) => b.vertex.get(i)));
  const segment: IndexMap = (i) => findIn((b) => b.segment.get(i)?.index);
  const cut = (seg: number) => !built.some((b) => b.segment.get(seg)?.whole);
  const re = remapRefs(entities, constraints, { entityId, point, segment }, (x) => stillApplies(x, entityId, cut));
  dropped += re.dropped;
  constraints = re.constraints;
  // a horizontal / vertical segment cut in two: both halves stay so
  if (built.length === 2) {
    for (const c of [...constraints]) {
      if ((c.type === 'horizontal' || c.type === 'vertical') && c.entityId === ids[0]) {
        const origSeg = [...built[0]!.segment].find(([, v]) => v.index === c.segmentIndex)?.[0];
        const other = origSeg != null ? built[1]!.segment.get(origSeg) : undefined;
        if (other) constraints.push({ ...c, id: newId(), entityId: ids[1]!, segmentIndex: other.index });
      }
    }
  }
  const out = re.entities.filter((e) => e.id !== entityId);
  const at = re.entities.findIndex((e) => e.id === entityId);
  out.splice(at < 0 ? out.length : at, 0, ...built.map((b) => b.line));
  return { entities: out, constraints, dropped, removedWhole: false, pieces: ids };
}

function refsAny(c: Constraint, ids: Set<string>): boolean {
  const r = c as unknown as Record<string, unknown>;
  return ['entityId', 'targetEntityId', 'entityId2'].some((k) => typeof r[k] === 'string' && ids.has(r[k] as string));
}

// ---- picking ----

export interface TrimHit {
  entityId: string;
  /** where on the curve (its parameter) */
  s: number;
  point: Point;
}

/** The trimmable curve nearest `p` within `tol` (world units). */
export function hitTrim(entities: Entity[], p: Point, tol: number): TrimHit | null {
  let best: TrimHit | null = null;
  let bestD = tol;
  for (const e of entities) {
    const curve = trimCurve(e);
    if (!curve) continue;
    curve.prims.forEach((prim, j) => {
      const near = nearestOn(prim, p);
      if (near.dist <= bestD) {
        bestD = near.dist;
        best = { entityId: e.id, s: j + near.t, point: near.point };
      }
    });
  }
  return best;
}

/** The piece a hit would remove, drawn as a polyline (or the whole shape),
 *  and a key naming it (the same piece hit twice gives the same key). */
export function trimPreview(entities: Entity[], hit: TrimHit): { key: string; entity: Entity } | null {
  const e = entities.find((x) => x.id === hit.entityId);
  const curve = e && trimCurve(e);
  if (!e || !curve) return null;
  const piece = pieceAt(curve, boundaries(curve, entities), hit.s);
  const key = `${e.id}:${piece.start.toFixed(6)}:${piece.end.toFixed(6)}`;
  if (piece.whole) return { key, entity: e };
  if (curve.entity.type === 'circle') {
    const prim = curve.prims[0]!;
    const sweep = ((piece.end - piece.start) % 1 || 1) * TAU;
    return { key, entity: { id: 'trim-preview', type: 'line', points: [primPoint(prim, piece.start), primPoint(prim, piece.start + sweep / TAU)], bulge: [Math.tan(sweep / 4)] } };
  }
  return { key, entity: subLine(curve, piece.start, piece.end, 'trim-preview').line };
}
