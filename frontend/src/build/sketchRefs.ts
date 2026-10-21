/**
 * A face sketch's reference outline following its face. Each build reports
 * the edges of the face each face sketch landed on, in the sketch's own
 * coordinates (modeling/sketch_profile.face_outline). The sketch's reference
 * edges are matched to them by shape — a line to the line running the same
 * way nearest it, a circle or arc to the nearest one of about the same
 * radius — keeping their ids, so the dimensions and constraints on them
 * follow: a standoff 14 mm from the inner wall stays 14 mm from it when the
 * wall gets thicker. A new face edge becomes a new reference edge; a
 * reference edge whose face edge is gone is kept, marked broken
 * (utils/brokenRefs.ts), when something uses it, and dropped otherwise.
 */
import type { Constraint, Entity, Point, Sketch } from '@/types/document';
import { generateId } from '@/utils/id';
import { arcFromBulge, bulgeFromMidpoint } from '@/utils/arcGeometry';
import { solveConstraints } from '@/utils/constraintSolver';
import { dimensionEntities, measureDimension, resolveSketch } from '@/utils/resolveSketch';
import { brokenIds, isBroken, isProjected, isRef, onBroken, targetsOf } from '@/utils/brokenRefs';

type XY = [number, number];

/** One edge of the face a sketch is on, in sketch coordinates (y down); a
 *  curve that is neither line nor circle comes as points along it. Mirrors
 *  modeling/sketch_profile.face_outline. */
export type OutlineEdge =
  | { t: 'line'; p: [XY, XY] }
  | { t: 'arc'; c: XY; r: number; p: [XY, XY, XY] }      // start, middle, end
  | { t: 'circle'; c: XY; r: number }
  | { t: 'poly'; p: XY[] };

const REF = { construction: true, reference: true } as const;
const P = (p: XY): Point => ({ x: p[0], y: p[1] });

/** The face's edges as reference (construction) entities with new ids:
 *  lines, arcs as one bulged segment, circles, and other curves as polylines. */
export function outlineEntities(outline: OutlineEdge[]): Entity[] {
  const out: Entity[] = [];
  for (const e of outline) {
    if (e.t === 'line') {
      out.push({ id: generateId('e'), type: 'line', points: [P(e.p[0]), P(e.p[1])], ...REF });
    } else if (e.t === 'arc') {
      const [a, m, b] = e.p.map(P) as [Point, Point, Point];
      out.push({ id: generateId('e'), type: 'line', points: [a, b], bulge: [bulgeFromMidpoint(a, b, m)], ...REF });
    } else if (e.t === 'circle') {
      out.push({ id: generateId('e'), type: 'circle', center: P(e.c), radius: e.r, ...REF });
    } else if (e.p.length >= 2) {
      const pts = e.p.map(P);
      const first = pts[0]!, last = pts[pts.length - 1]!;
      const closed = pts.length > 2 && Math.hypot(first.x - last.x, first.y - last.y) < 1e-6;
      out.push({ id: generateId('e'), type: 'line', points: closed ? pts.slice(0, -1) : pts,
                 ...(closed ? { closed: true } : {}), ...REF });
    }
  }
  return out;
}

// ── matching ──

type Shape =
  | { kind: 'seg'; a: Point; b: Point; mid: Point; dir: Point }
  | { kind: 'arc' | 'circle'; c: Point; r: number; a?: Point; b?: Point }
  | { kind: 'path'; closed: boolean; c: Point; w: number; h: number };

function shapeOf(e: Entity): Shape | null {
  if (e.type === 'circle') return { kind: 'circle', c: e.center, r: e.radius };
  if (e.type !== 'line' || e.points.length < 2) return null;
  if (e.points.length === 2 && !e.closed) {
    const [a, b] = e.points as [Point, Point];
    const bulge = e.bulge?.[0] ?? 0;
    if (bulge) {
      const arc = arcFromBulge(a, b, bulge);
      return { kind: 'arc', c: arc.center, r: arc.radius, a, b };
    }
    const l = Math.hypot(b.x - a.x, b.y - a.y);
    if (l < 1e-9) return null;
    return { kind: 'seg', a, b, mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, dir: { x: (b.x - a.x) / l, y: (b.y - a.y) / l } };
  }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of e.points) {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
  }
  return { kind: 'path', closed: !!e.closed, c: { x: (minX + maxX) / 2, y: (minY + maxY) / 2 }, w: maxX - minX, h: maxY - minY };
}

const SAME_DIR = Math.cos((0.5 * Math.PI) / 180);   // lines within 0.5° run the same way

/** How far apart two edges are as the same edge (Infinity: they can't be).
 *  Lines: running the same way (either direction, within 0.5°), the gap
 *  across between them, the distance along only breaking ties (an edge
 *  split in two). Circles and arcs: the gap between centres plus the change
 *  in radius, the radius within 1 mm or a factor of 2. */
export function edgeDistance(o: Entity, n: Entity): number {
  const a = shapeOf(o), b = shapeOf(n);
  if (!a || !b || a.kind !== b.kind) return Infinity;
  if (a.kind === 'seg' && b.kind === 'seg') {
    if (Math.abs(a.dir.x * b.dir.x + a.dir.y * b.dir.y) < SAME_DIR) return Infinity;
    const dx = b.mid.x - a.mid.x, dy = b.mid.y - a.mid.y;
    const across = Math.abs(dx * a.dir.y - dy * a.dir.x);
    const along = Math.abs(dx * a.dir.x + dy * a.dir.y);
    return across + 1e-3 * along;
  }
  if ((a.kind === 'arc' || a.kind === 'circle') && (b.kind === 'arc' || b.kind === 'circle')) {
    const dr = Math.abs(a.r - b.r);
    if (dr > 1 && (b.r > 2 * a.r || a.r > 2 * b.r)) return Infinity;
    return Math.hypot(a.c.x - b.c.x, a.c.y - b.c.y) + dr;
  }
  if (a.kind === 'path' && b.kind === 'path') {
    if (a.closed !== b.closed) return Infinity;
    return Math.hypot(a.c.x - b.c.x, a.c.y - b.c.y) + Math.abs(a.w - b.w) + Math.abs(a.h - b.h);
  }
  return Infinity;
}

/** Pairs of [old index, new index], nearest first, each edge in one pair at most. */
export function matchEdges(old: Entity[], fresh: Entity[]): [number, number][] {
  const cand: [number, number, number][] = [];
  old.forEach((o, i) => fresh.forEach((n, j) => {
    const d = edgeDistance(o, n);
    if (d < Infinity) cand.push([d, i, j]);
  }));
  cand.sort((x, y) => x[0] - y[0]);
  const takenOld = new Set<number>(), takenNew = new Set<number>();
  const out: [number, number][] = [];
  for (const [, i, j] of cand) {
    if (takenOld.has(i) || takenNew.has(j)) continue;
    takenOld.add(i); takenNew.add(j);
    out.push([i, j]);
  }
  return out;
}

// the new edge drawn the way the old one ran, so a dimension to "point 0"
// of it still means the same end
function orientLike(o: Entity, n: Entity): Entity {
  if (o.type !== 'line' || n.type !== 'line' || o.points.length !== 2 || n.points.length !== 2) return n;
  const [a, b] = o.points as [Point, Point], [c, d] = n.points as [Point, Point];
  if ((b.x - a.x) * (d.x - c.x) + (b.y - a.y) * (d.y - c.y) >= 0) return n;
  return { ...n, points: [d, c], ...(n.bulge ? { bulge: n.bulge.map((k) => -k) } : {}) };
}

const MOVE_TOL = 1e-4;   // mm: less is the tessellation's round-off, not the part changing

// whether `n` is `o` moved (beyond round-off)
function moved(o: Entity, n: Entity): boolean {
  if (o.type === 'circle' && n.type === 'circle') {
    return Math.hypot(o.center.x - n.center.x, o.center.y - n.center.y) > MOVE_TOL || Math.abs(o.radius - n.radius) > MOVE_TOL;
  }
  if (o.type === 'line' && n.type === 'line') {
    if (o.points.length === 2 && n.points.length === 2) {
      const far = o.points.some((p, i) => Math.hypot(p.x - n.points[i]!.x, p.y - n.points[i]!.y) > MOVE_TOL);
      return far || Math.abs((o.bulge?.[0] ?? 0) - (n.bulge?.[0] ?? 0)) > 1e-6;
    }
    // a curve sampled two ways (the viewer's mesh, the engine's 16 steps): by its box
    return edgeDistance(o, n) > 0.02;
  }
  return true;
}

export interface Followed {
  /** the sketch as it is now: `sk` itself when nothing changed */
  sketch: Sketch;
  changed: boolean;
  /** a reference edge moved (so what is dimensioned to it may have) */
  moved: boolean;
  added: number;
  /** ids of the reference edges whose face edge is gone (kept: something uses them) */
  broken: string[];
}

/** The sketch with its reference edges moved onto `fresh` (the face's edges
 *  as they are now, as outlineEntities makes them), keeping their ids. The
 *  dimensions on reference edges keep the values they had and the
 *  constraints are solved again; then expression dimensions are set from
 *  `vars` (when given). Constraints on broken edges are left out of the
 *  solve, and the dimensions on them simply keep their geometry.
 *  `projected`: where the part edges projected onto the sketch are now
 *  (build/projectEdges.matchProjected; null: the edge is gone, and the
 *  projection is kept, broken); those not in it are left as they are. Pure. */
export function followRefs(sk: Sketch, fresh: Entity[], vars?: Record<string, number> | null,
                           projected?: Map<string, Entity | null>): Followed {
  const same: Followed = { sketch: sk, changed: false, moved: false, added: 0, broken: [...brokenIds(sk.entities)] };
  const outlineOn = !!sk.face && fresh.length > 0;
  if (!outlineOn && !projected?.size) return same;
  const old = sk.entities.filter((e) => isRef(e) && !isProjected(e));
  const pairs = outlineOn ? matchEdges(old, fresh) : [];
  const matchOf = new Map(pairs.map(([i, j]) => [old[i]!.id, fresh[j]!]));
  const takenNew = new Set(pairs.map(([, j]) => j));
  const user = sk.entities.filter((e) => !isRef(e));
  const used = new Set([...sk.constraints.filter((c) => c.type !== 'fixed'), ...user].flatMap(targetsOf));

  let anyMoved = false, anyChange = false;
  const dropped = new Set<string>();
  const entities: Entity[] = [];
  for (const e of sk.entities) {
    if (!isRef(e)) { entities.push(e); continue; }
    if (isProjected(e)) {
      if (!projected?.has(e.id)) { entities.push(e); continue; }
      const n = projected.get(e.id);
      if (n) {
        const m = orientLike(e, n);
        const refMoved = JSON.stringify((e as { edgeRef?: unknown }).edgeRef) !== JSON.stringify((n as { edgeRef?: unknown }).edgeRef);
        if (moved(e, m)) {
          anyMoved = true; anyChange = true;
          entities.push({ ...m, id: e.id });
        } else if (isBroken(e) || refMoved) {
          anyChange = true;   // back again, or moved only along the sketch's normal
          entities.push({ ...stripBroken(e), edgeRef: (n as { edgeRef?: unknown }).edgeRef } as Entity);
        } else entities.push(e);
      } else {
        if (!isBroken(e)) anyChange = true;
        entities.push(isBroken(e) ? e : ({ ...e, broken: true } as Entity));
      }
      continue;
    }
    if (!outlineOn) { entities.push(e); continue; }
    const n = matchOf.get(e.id);
    if (n) {
      const m = orientLike(e, n);
      if (moved(e, m)) {
        anyMoved = true; anyChange = true;
        entities.push({ ...m, id: e.id });
      } else if (isBroken(e)) {
        anyChange = true;   // its face edge came back
        entities.push(stripBroken(e));
      } else entities.push(e);
    } else if (used.has(e.id)) {
      if (!isBroken(e)) anyChange = true;
      entities.push(isBroken(e) ? e : ({ ...e, broken: true } as Entity));
    } else {
      dropped.add(e.id); anyChange = true;
    }
  }
  const added = outlineOn ? fresh.filter((_, j) => !takenNew.has(j)) : [];
  if (added.length) anyChange = true;
  if (!anyChange) return same;

  const constraints: Constraint[] = sk.constraints.filter((c) => !(c.type === 'fixed' && dropped.has(c.entityId)));
  for (const e of added) constraints.push({ id: generateId('c'), type: 'fixed', entityId: e.id });
  let next: Sketch = { ...sk, entities: [...entities, ...added], constraints };
  const broken = brokenIds(next.entities);

  if (anyMoved || broken.size !== same.broken.length) {
    // what the dimensions on the outline measured before it moved, to keep them
    const refIds = new Set(sk.entities.filter(isRef).map((o) => o.id));
    const held: [string, number][] = [];
    for (const d of user) {
      if (d.type !== 'dimension' || onBroken(d, broken) || !targetsOf(d).some((id) => refIds.has(id))) continue;
      const v = measureDimension(d, sk.entities);
      if (v != null) held.push([d.id, v]);
    }
    next = { ...next, entities: solveConstraints(next.entities, constraints).entities };
    for (const [id, v] of held) {
      const ents = dimensionEntities(next, id, v);
      if (Array.isArray(ents)) next = { ...next, entities: ents };
    }
  }
  if (vars) next = resolveSketch(next, vars).sketch;
  return { sketch: next, changed: true, moved: anyMoved, added: added.length, broken: [...broken] };
}

function stripBroken(e: Entity): Entity {
  const { broken: _gone, ...rest } = e as Entity & { broken?: boolean };
  return rest as Entity;
}

/** How many dimensions (or, with none, constraints) use the sketch's broken
 *  reference edges. */
export function brokenUses(sk: Sketch): { dimensions: number; constraints: number } {
  const broken = brokenIds(sk.entities);
  if (!broken.size) return { dimensions: 0, constraints: 0 };
  return {
    dimensions: sk.entities.filter((e) => e.type === 'dimension' && onBroken(e, broken)).length,
    constraints: sk.constraints.filter((c) => onBroken(c, broken)).length,
  };
}

/** "Sketch 'Standoffs': 2 dimensions refer to an edge that no longer exists" (null: none do). */
export function brokenRefWarning(sk: Sketch): string | null {
  const { dimensions, constraints } = brokenUses(sk);
  const [n, what] = dimensions ? [dimensions, 'dimension'] : [constraints, 'constraint'];
  if (!n) return null;
  return `Sketch '${sk.name}': ${n} ${what}${n === 1 ? ' refers' : 's refer'} to an edge that no longer exists`;
}

/** Whether a face sketch has dimensions to its reference (face) edges. */
export function dimensionedToEdges(sk: Sketch): boolean {
  const refs = new Set(sk.entities.filter(isRef).map((e) => e.id));
  return !!sk.face && sk.entities.some((e) => e.type === 'dimension' && targetsOf(e).some((id) => refs.has(id)));
}
