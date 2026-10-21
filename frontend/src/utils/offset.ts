/**
 * Offset curves: a closed loop, a chain of connected segments or a circle,
 * moved a distance to one side. Straight segments shift along their normal,
 * arcs keep their centre and change radius, and the corners where the shifted
 * pieces no longer meet are joined with an arc about the corner (or a miter);
 * where they overlap, both are cut back to where they cross.
 *
 * The result is a derived entity (sourceId + an 'offset' sourceTransform):
 * propagateDerived calls offsetEntity again whenever the source changes.
 */
import type { CircleEntity, Entity, LineEntity, Point, RectangleEntity, SourceTransform } from '@/types/document';
import { getSegmentBulge, getSegmentCount } from '@/utils/lineSegments';
import { effectiveCornerRadius } from '@/utils/rectPath';
import { candidates, nearestOn, primPoint, segPrim, type Prim } from '@/utils/trim';

export type OffsetJoin = 'arc' | 'miter';
export type OffsetTransform = Extract<SourceTransform, { type: 'offset' }>;

const TOL = 1e-6;
/** A miter corner reaches at most this many offsets from the source corner;
 *  sharper corners are rounded instead. */
const MITER_LIMIT = 4;

export interface Path {
  points: Point[];
  /** per segment; bulge[i] belongs to points[i] → points[i+1] */
  bulge: number[];
  closed: boolean;
}

const sub = (a: Point, b: Point): Point => ({ x: a.x - b.x, y: a.y - b.y });
const cross = (a: Point, b: Point) => a.x * b.y - a.y * b.x;
const dot = (a: Point, b: Point) => a.x * b.x + a.y * b.y;
const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

function linePath(e: LineEntity): Path {
  const n = getSegmentCount(e);
  return { points: e.points, bulge: Array.from({ length: n }, (_, i) => getSegmentBulge(e, i)), closed: !!e.closed };
}

function reversed(p: Path): Path {
  const n = p.bulge.length;
  return { points: [...p.points].reverse(), bulge: Array.from({ length: n }, (_, i) => -(p.bulge[n - 1 - i] ?? 0)), closed: p.closed };
}

/** Polylines joined end to end into one path, running the way the first
 *  one runs; closed when the chain comes back to its start. Null when they
 *  don't make one chain. */
export function chainPath(lines: LineEntity[], tol = 1e-6): Path | null {
  if (lines.length === 0 || lines.some((l) => l.points.length < 2)) return null;
  if (lines.length === 1) return linePath(lines[0]!);
  if (lines.some((l) => l.closed)) return null;
  let path = linePath(lines[0]!);
  const rest = lines.slice(1).map(linePath);
  while (rest.length) {
    const start = path.points[0]!, end = path.points[path.points.length - 1]!;
    let joined = false;
    for (let k = 0; k < rest.length && !joined; k++) {
      const q = rest[k]!;
      const qs = q.points[0]!, qe = q.points[q.points.length - 1]!;
      const glue = (a: Path, b: Path): Path => ({ points: [...a.points, ...b.points.slice(1)], bulge: [...a.bulge, ...b.bulge], closed: false });
      if (dist(qs, end) <= tol) path = glue(path, q);
      else if (dist(qe, end) <= tol) path = glue(path, reversed(q));
      else if (dist(qe, start) <= tol) path = glue(q, path);
      else if (dist(qs, start) <= tol) path = glue(reversed(q), path);
      else continue;
      rest.splice(k, 1);
      joined = true;
    }
    if (!joined) return null;
  }
  const n = path.points.length;
  if (n > 3 && dist(path.points[0]!, path.points[n - 1]!) <= tol) {
    return { points: path.points.slice(0, n - 1), bulge: path.bulge, closed: true };
  }
  return path;
}

export function pathPrims(p: Path): Prim[] {
  const n = p.closed ? p.points.length : p.points.length - 1;
  const out: Prim[] = [];
  for (let i = 0; i < n; i++) {
    const a = p.points[i]!, b = p.points[(i + 1) % p.points.length]!;
    if (dist(a, b) <= TOL) continue;
    out.push(segPrim(a, b, p.bulge[i] ?? 0));
  }
  return out;
}

/** Signed area of a closed run of primitives (positive: the angle runs up
 *  round it). */
export function primsArea(prims: Prim[]): number {
  let area = 0;
  for (const p of prims) {
    const a = primPoint(p, 0), b = primPoint(p, 1);
    area += cross(a, b) / 2;
    if (p.kind === 'arc') {
      const th = Math.abs(p.sweep);
      area += Math.sign(p.sweep) * (th - Math.sin(th)) * p.r * p.r / 2;
    }
  }
  return area;
}

// ---- a primitive's carrier (its whole line or circle), by arc length ----

const primLen = (p: Prim) => (p.kind === 'seg' ? dist(p.a, p.b) : Math.abs(p.sweep) * p.r);

function at(p: Prim, t: number): Point {
  if (p.kind === 'seg') {
    const l = dist(p.a, p.b);
    return { x: p.a.x + ((p.b.x - p.a.x) * t) / l, y: p.a.y + ((p.b.y - p.a.y) * t) / l };
  }
  const phi = p.start + (Math.sign(p.sweep) * t) / p.r;
  return { x: p.c.x + p.r * Math.cos(phi), y: p.c.y + p.r * Math.sin(phi) };
}

function tangent(p: Prim, t: number): Point {
  if (p.kind === 'seg') {
    const l = dist(p.a, p.b);
    return { x: (p.b.x - p.a.x) / l, y: (p.b.y - p.a.y) / l };
  }
  const s = Math.sign(p.sweep);
  const phi = p.start + (s * t) / p.r;
  return { x: -s * Math.sin(phi), y: s * Math.cos(phi) };
}

/** Where `x` (on the carrier) is, nearest to `ref`. */
function paramOf(p: Prim, x: Point, ref: number): number {
  if (p.kind === 'seg') return dot(sub(x, p.a), tangent(p, 0));
  let d = Math.sign(p.sweep) * (Math.atan2(x.y - p.c.y, x.x - p.c.x) - p.start);
  const r0 = ref / p.r;
  while (d - r0 > Math.PI) d -= 2 * Math.PI;
  while (d - r0 < -Math.PI) d += 2 * Math.PI;
  return d * p.r;
}

function piece(p: Prim, t0: number, t1: number): Prim {
  if (p.kind === 'seg') return { kind: 'seg', a: at(p, t0), b: at(p, t1) };
  const s = Math.sign(p.sweep);
  return { kind: 'arc', c: p.c, r: p.r, start: p.start + (s * t0) / p.r, sweep: (s * (t1 - t0)) / p.r };
}

/** A primitive moved `d` to its left (negative: right); null when an arc
 *  shrinks away. */
function shifted(p: Prim, d: number): Prim | null {
  if (p.kind === 'seg') {
    const t = tangent(p, 0);
    const n = { x: -t.y * d, y: t.x * d };
    return { kind: 'seg', a: { x: p.a.x + n.x, y: p.a.y + n.y }, b: { x: p.b.x + n.x, y: p.b.y + n.y } };
  }
  // the centre is on the left of an arc whose angle runs up
  const r = p.r - Math.sign(p.sweep) * d;
  return r > TOL ? { ...p, r } : null;
}

interface Item { orig: Prim; off: Prim; len: number; t0: number; t1: number; join: Prim[] }

function arcJoin(v: Point, from: Point, to: Point, d: number): Prim[] {
  const u = sub(from, v), w = sub(to, v);
  const r = Math.abs(d);
  if (Math.abs(Math.hypot(u.x, u.y) - r) > 1e-6 * (1 + r) || Math.abs(Math.hypot(w.x, w.y) - r) > 1e-6 * (1 + r)) {
    return [{ kind: 'seg', a: from, b: to }];
  }
  // round the outside of the turn: against the side offset to
  const sweep = -Math.sign(d) * Math.abs(Math.atan2(cross(u, w), dot(u, w)));
  return [{ kind: 'arc', c: v, r, start: Math.atan2(u.y, u.x), sweep }];
}

/** Join neighbours, cutting back overlaps and bridging gaps. */
function joinItems(items: Item[], closed: boolean, d: number, join: OffsetJoin) {
  for (const it of items) { it.t0 = 0; it.t1 = it.len; it.join = []; }
  const m = items.length;
  for (let i = 0; i < (closed ? m : m - 1); i++) {
    const A = items[i]!, B = items[(i + 1) % m]!;
    if (A === B) continue;
    const eA = at(A.off, A.len), sB = at(B.off, 0);
    if (dist(eA, sB) <= TOL) continue;
    const v = primPoint(A.orig, 1);
    const tA = tangent(A.off, A.len), tB = tangent(B.off, 0);
    const cr = cross(tA, tB);
    const gap = Math.abs(cr) < 1e-9 ? dot(tA, tB) < 0 : cr * d < 0;
    if (gap) {
      if (join === 'miter' && Math.abs(cr) > 1e-9) {
        const s = cross(sub(sB, eA), tB) / cr;
        const x = { x: eA.x + tA.x * s, y: eA.y + tA.y * s };
        if (dist(x, v) <= MITER_LIMIT * Math.abs(d)) {
          A.join = [{ kind: 'seg', a: eA, b: x }, { kind: 'seg', a: x, b: sB }];
          continue;
        }
      }
      A.join = arcJoin(v, eA, sB, d);
      continue;
    }
    // overlapping: cut both back to where they cross, nearest the corner
    let best: Point | null = null;
    for (const x of candidates(A.off, B.off)) {
      if (!isFinite(x.x) || !isFinite(x.y)) continue;
      if (!best || dist(x, v) < dist(best, v)) best = x;
    }
    if (!best) { A.join = [{ kind: 'seg', a: eA, b: sB }]; continue; }
    A.t1 = paramOf(A.off, best, A.len);
    B.t0 = paramOf(B.off, best, 0);
  }
}

/** The path moved `d` to its left (negative: right), or null when it
 *  doesn't fit (an inside offset larger than the shape). */
export function offsetPath(path: Path, d: number, join: OffsetJoin = 'arc'): Path | null {
  const prims = pathPrims(path);
  if (!prims.length) return null;
  if (Math.abs(d) <= TOL) return path;
  let items: Item[] = [];
  for (const p of prims) {
    const off = shifted(p, d);
    if (off) items.push({ orig: p, off, len: primLen(off), t0: 0, t1: 0, join: [] });
  }
  // a piece the neighbours cut back past its own length is gone: take it out
  // and join the neighbours across it, until none is
  for (let guard = prims.length + 1; guard > 0 && items.length; guard--) {
    joinItems(items, path.closed, d, join);
    let worst = -1, worstBy = -1e-9;
    items.forEach((it, i) => { if (it.t1 - it.t0 < worstBy) { worst = i; worstBy = it.t1 - it.t0; } });
    if (worst < 0) break;
    items = items.filter((_, i) => i !== worst);
  }
  if (!items.length) return null;

  // the pieces in order, straight runs merged
  const out: Prim[] = [];
  const push = (p: Prim) => {
    if (primLen(p) <= TOL) return;
    const last = out[out.length - 1];
    if (last && last.kind === 'seg' && p.kind === 'seg') {
      const u = tangent(last, 0), w = tangent(p, 0);
      if (Math.abs(cross(u, w)) < 1e-9 && dot(u, w) > 0) { out[out.length - 1] = { kind: 'seg', a: last.a, b: p.b }; return; }
    }
    out.push(p);
  };
  for (const it of items) {
    push(piece(it.off, it.t0, it.t1));
    for (const j of it.join) push(j);
  }
  if (path.closed && out.length > 1) {
    const first = out[0]!, last = out[out.length - 1]!;
    if (first.kind === 'seg' && last.kind === 'seg') {
      const u = tangent(last, 0), w = tangent(first, 0);
      if (Math.abs(cross(u, w)) < 1e-9 && dot(u, w) > 0) { out[0] = { kind: 'seg', a: last.a, b: first.b }; out.pop(); }
    }
  }
  if (!out.length) return null;

  // everything must stay the full distance from the source; a closed loop
  // must keep running the same way round
  const near = Math.abs(d) - 1e-5 * (1 + Math.abs(d));
  for (const p of out) {
    for (const t of [0, 0.5]) {
      const q = primPoint(p, t);
      if (prims.some((s) => nearestOn(s, q).dist < near)) return null;
    }
  }
  if (path.closed && Math.sign(primsArea(out)) !== Math.sign(primsArea(prims))) return null;

  const points = out.map((p) => primPoint(p, 0));
  if (!path.closed) points.push(primPoint(out[out.length - 1]!, 1));
  const bulge = out.map((p) => (p.kind === 'arc' ? Math.tan(p.sweep / 4) : 0));
  return { points, bulge, closed: path.closed };
}

// ---- the derived entity ----

/** The source ids of an offset (or a copy): what it follows. */
export function offsetSources(e: Entity): string[] {
  if (!('sourceId' in e) || !e.sourceId) return [];
  const t = e.sourceTransform;
  return t?.type === 'offset' && t.chain?.length ? t.chain : [e.sourceId];
}

/** What can be offset: polylines, rectangles and circles that aren't copies. */
export function offsettable(e: Entity | undefined): e is LineEntity | RectangleEntity | CircleEntity {
  if (!e || (e.type !== 'line' && e.type !== 'rectangle' && e.type !== 'circle')) return false;
  return !e.sourceId && !(e.type === 'line' && e.points.length < 2);
}

type Source =
  | { kind: 'circle'; e: CircleEntity }
  | { kind: 'rectangle'; e: RectangleEntity }
  | { kind: 'path'; path: Path; prims: Prim[]; area: number };

function sourceOf(ids: string[], lookup: (id: string) => Entity | undefined): Source | null {
  const es = ids.map(lookup);
  if (!es.length || es.some((e) => !e)) return null;
  if (es.length === 1) {
    const e = es[0]!;
    if (e.type === 'circle') return { kind: 'circle', e };
    if (e.type === 'rectangle') return { kind: 'rectangle', e };
  }
  if (es.some((e) => e!.type !== 'line')) return null;
  const path = chainPath(es as LineEntity[]);
  if (!path) return null;
  const prims = pathPrims(path);
  if (!prims.length) return null;
  return { kind: 'path', path, prims, area: path.closed ? primsArea(prims) : 0 };
}

/** The distance to the left of the path's travel: side 1 is outside for a
 *  closed loop, the left for an open chain. */
function leftDistance(src: Extract<Source, { kind: 'path' }>, t: OffsetTransform): number {
  const d = t.distance * t.side;
  if (!src.path.closed) return d;
  // round a loop whose angle runs up, the inside is on the left
  return src.area > 0 ? -d : d;
}

/** Whether the offset is of a closed shape (sides read outside / inside)
 *  rather than an open chain (sides read left / right). */
export function offsetIsClosed(ids: string[], lookup: (id: string) => Entity | undefined): boolean {
  const src = sourceOf(ids, lookup);
  return !!src && (src.kind !== 'path' || src.path.closed);
}

/**
 * The offset entity `id` of `sourceIds` (one entity, or polylines that chain
 * end to end), or null when it can't be made (not a chain, or an inside
 * offset bigger than the shape). `base` carries the entity's own settings
 * (construction, fill) through an update.
 */
export function offsetEntity(
  sourceIds: string[],
  transform: Omit<OffsetTransform, 'chain'>,
  id: string,
  lookup: (id: string) => Entity | undefined,
  base?: Entity,
): Entity | null {
  const src = sourceOf(sourceIds, lookup);
  if (!src || !(transform.distance > 0)) return null;
  const sourceTransform: OffsetTransform = { ...transform, ...(sourceIds.length > 1 ? { chain: sourceIds } : {}) };
  const own = {
    sourceId: sourceIds[0]!,
    sourceTransform,
    ...(base && 'construction' in base && base.construction ? { construction: true } : {}),
    ...(base && 'fill' in base && base.fill ? { fill: true } : {}),
  };
  const d = transform.distance * transform.side;
  if (src.kind === 'circle') {
    const r = src.e.radius + d;
    return r > TOL ? { id, type: 'circle', center: src.e.center, radius: r, ...own } : null;
  }
  if (src.kind === 'rectangle') {
    const w = src.e.width + 2 * d, h = src.e.height + 2 * d;
    if (w <= TOL || h <= TOL) return null;
    // outside, the sharp corners round to the distance (or stay sharp as
    // miters); rounded ones grow by it. Inside, they shrink to nothing.
    const cr = effectiveCornerRadius(src.e);
    const r = d >= 0 ? (cr > 0 || transform.join === 'arc' ? cr + d : 0) : Math.max(0, cr + d);
    return {
      id, type: 'rectangle', center: src.e.center, width: w, height: h,
      ...(r > TOL ? { cornerRadius: r } : {}), ...own,
    };
  }
  const p = offsetPath(src.path, leftDistance(src, transform), transform.join);
  if (!p) return null;
  return {
    id, type: 'line', points: p.points,
    ...(p.bulge.some((b) => b !== 0) ? { bulge: p.bulge } : {}),
    ...(p.closed ? { closed: true } : {}),
    ...own,
  };
}

/** Where the offset's distance dimension measures: a point on the source
 *  and the same point moved across to the offset. */
export function offsetMeasure(offset: Entity, lookup: (id: string) => Entity | undefined): { a: Point; b: Point } | null {
  if (!('sourceTransform' in offset) || offset.sourceTransform?.type !== 'offset') return null;
  const t = offset.sourceTransform;
  const src = sourceOf(offsetSources(offset), lookup);
  if (!src) return null;
  const d = t.distance * t.side;
  if (src.kind === 'circle') {
    const u = { x: Math.SQRT1_2, y: -Math.SQRT1_2 };
    const { center: c, radius: r } = src.e;
    return { a: { x: c.x + u.x * r, y: c.y + u.y * r }, b: { x: c.x + u.x * (r + d), y: c.y + u.y * (r + d) } };
  }
  if (src.kind === 'rectangle') {
    const { center: c, width: w } = src.e;
    return { a: { x: c.x + w / 2, y: c.y }, b: { x: c.x + w / 2 + d, y: c.y } };
  }
  const left = leftDistance(src, t);
  let best: Prim | null = null;
  for (const p of src.prims) if (p.kind === 'seg' && (!best || primLen(p) > primLen(best))) best = p;
  if (best && best.kind === 'seg') {
    const a = primPoint(best, 0.5), u = tangent(best, 0);
    return { a, b: { x: a.x - u.y * left, y: a.y + u.x * left } };
  }
  const arc = src.prims[0]!;
  if (arc.kind !== 'arc') return null;
  const a = primPoint(arc, 0.5);
  const k = (arc.r - Math.sign(arc.sweep) * left) / arc.r;
  return { a, b: { x: arc.c.x + (a.x - arc.c.x) * k, y: arc.c.y + (a.y - arc.c.y) * k } };
}

/**
 * The sketch with an offset of `sourceIds` added, and its distance
 * dimension (driving it; `expression`, a P / parameter expression, goes on
 * it). Null when the sources can't be offset that far.
 */
export function addOffset(
  entities: Entity[],
  sourceIds: string[],
  t: Pick<OffsetTransform, 'distance' | 'side' | 'join'>,
  newId: () => string,
  expression?: string,
): { entities: Entity[]; offsetId: string; dimensionId: string } | null {
  const byId = new Map(entities.map((e) => [e.id, e]));
  if (!sourceIds.length || !sourceIds.every((id) => offsettable(byId.get(id)))) return null;
  const offsetId = newId();
  const e = offsetEntity(sourceIds, { type: 'offset', ...t }, offsetId, (id) => byId.get(id));
  if (!e) return null;
  const dimensionId = newId();
  const dim: Entity = {
    id: dimensionId, type: 'dimension', targetEntityId: offsetId, segmentIndex: 0, offset: 0, offsetDistance: true,
    ...(expression ? { expression } : {}),
  };
  return { entities: [...entities, e, dim], offsetId, dimensionId };
}

/** The offset `id` made independent: it keeps its shape, stops following its
 *  source, and its distance dimension goes. Null when it isn't an offset. */
export function unlinkOffset(entities: Entity[], id: string): Entity[] | null {
  const e = entities.find((x) => x.id === id);
  if (!e || !('sourceTransform' in e) || e.sourceTransform?.type !== 'offset') return null;
  return entities
    .filter((x) => !(x.type === 'dimension' && x.offsetDistance && x.targetEntityId === id))
    .map((x) => (x.id === id ? ({ ...x, sourceId: undefined, sourceTransform: undefined } as Entity) : x));
}

/** The open polyline `id` and the open polylines joined on to it end to end,
 *  in chain order: what one click offsets. It stops where the chain branches
 *  (more than one line at an end). */
export function connectedChain(entities: Entity[], id: string, tol = TOL): string[] {
  const open = entities.filter((e): e is LineEntity => e.type === 'line' && offsettable(e) && !e.closed);
  const start = open.find((e) => e.id === id);
  if (!start) return [id];
  const ends = (l: LineEntity) => [l.points[0]!, l.points[l.points.length - 1]!] as const;
  const used = new Set([id]);
  const grow = (tip: Point): string[] => {
    const out: string[] = [];
    for (;;) {
      const touching = open.filter((l) => !used.has(l.id) && ends(l).some((p) => dist(p, tip) <= tol));
      if (touching.length !== 1) return out;
      const l = touching[0]!;
      used.add(l.id);
      out.push(l.id);
      const [a, b] = ends(l);
      tip = dist(a, tip) <= tol ? b : a;
    }
  };
  const [a, b] = ends(start);
  const forward = grow(b);
  const back = grow(a);
  return [...back.reverse(), id, ...forward];
}

/** Whether `ids` can be offset at all (one closed shape or circle, or lines
 *  that chain end to end, none of them copies). */
export function canOffset(ids: string[], lookup: (id: string) => Entity | undefined): boolean {
  return ids.length > 0 && ids.every((id) => offsettable(lookup(id))) && !!sourceOf(ids, lookup);
}
