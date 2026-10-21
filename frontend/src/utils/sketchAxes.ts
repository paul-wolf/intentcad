/**
 * Every sketch's built-in axes, as in Onshape: a horizontal and a vertical
 * line through the sketch origin (axis-h, axis-v), and on a face sketch also
 * the face's own centre lines (axis-fh, axis-fv) through the middle of its
 * outline's box. They are reference geometry — reference + construction, each
 * held by a 'fixed' constraint — so mirror, symmetric, point-on-line, H/V and
 * dimensions use them like any reference line, by id; they are never in
 * profiles, exports or bounding boxes, and can't be moved or deleted. They are
 * drawn across the whole view (rendering/pipeline.ts renderAxes).
 *
 * They are derived, not saved: the origin from the sketch's plane (a face
 * sketch: the world origin projected onto the face; any other sketch: the
 * sketch origin), the face centre lines from the face outline. withAxes puts
 * them into a sketch (on load, when a sketch is made, and after anything that
 * dropped or changed them); withoutAxes takes them out of what is saved,
 * keeping the constraints and dimensions that use them. A face's centre
 * lines follow its outline in build/sketchRefs.followRefs.
 */
import type { Constraint, Document, Entity, LineEntity, Point, Sketch } from '@/types/document';
import { planeBasis, worldToSketch } from '@/build/sketchPlane';
import { isBroken, isProjected, isRef } from './brokenRefs';

export const AXIS_H = 'axis-h';
export const AXIS_V = 'axis-v';
export const FACE_AXIS_H = 'axis-fh';
export const FACE_AXIS_V = 'axis-fv';

const AXIS_IDS = new Set([AXIS_H, AXIS_V, FACE_AXIS_H, FACE_AXIS_V]);
const FIX_PREFIX = 'fix-';

/** Half the length of an axis line (mm): far beyond any part, so a point
 *  constrained onto it, or a mirror about it, never runs off its end. */
export const AXIS_REACH = 10000;

/** Whether `e` (an entity or its id) is one of a sketch's built-in axes. */
export const isAxis = (e: Entity | string): boolean => AXIS_IDS.has(typeof e === 'string' ? e : e.id);

/** Whether `c` is the 'fixed' constraint holding an axis. */
export const isAxisConstraint = (c: Constraint): boolean => c.id.startsWith(FIX_PREFIX) && AXIS_IDS.has(c.id.slice(FIX_PREFIX.length));

/** `ids` without the axes (they can't be moved, deleted or restyled). */
export const notAxes = <T extends string>(ids: Iterable<T>): T[] => [...ids].filter((id) => !isAxis(id));

/** The label drawn at the view edge for an axis. */
export function axisLabel(id: string): string {
  return id === AXIS_H ? 'H' : id === AXIS_V ? 'V' : id === FACE_AXIS_H ? 'face H' : 'face V';
}

const r6 = (v: number) => Math.round(v * 1e6) / 1e6 || 0;

/** Where the sketch's origin axes cross: on a face sketch the world origin
 *  projected onto the face's plane (so on a part modelled around the origin
 *  they are its centre lines); on any other sketch its own origin. */
export function axisOrigin(sk: Sketch): Point {
  if (!sk.face || !sk.plane) return { x: 0, y: 0 };
  const o = worldToSketch(planeBasis(sk.plane), [0, 0, 0]);
  return { x: r6(o.x), y: r6(o.y) };
}

/** The middle of a face sketch's outline box (its reference edges, not
 *  projected part edges); null when it has no outline. */
export function faceCentre(sk: Sketch, entities: Entity[] = sk.entities): Point | null {
  if (!sk.face) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const take = (p: Point) => {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
  };
  for (const e of entities) {
    if (!isRef(e) || isAxis(e) || isProjected(e) || isBroken(e)) continue;
    if (e.type === 'circle') {
      take({ x: e.center.x - e.radius, y: e.center.y - e.radius });
      take({ x: e.center.x + e.radius, y: e.center.y + e.radius });
    } else if (e.type === 'line') {
      // an arc's bulge can reach past its ends; its ends and middle bound it closely enough
      e.points.forEach(take);
    }
  }
  if (!Number.isFinite(minX)) return null;
  return { x: r6((minX + maxX) / 2), y: r6((minY + maxY) / 2) };
}

function axisLine(id: string, at: Point, horizontal: boolean): LineEntity {
  const points = horizontal
    ? [{ x: at.x - AXIS_REACH, y: at.y }, { x: at.x + AXIS_REACH, y: at.y }]
    : [{ x: at.x, y: at.y - AXIS_REACH }, { x: at.x, y: at.y + AXIS_REACH }];
  return { id, type: 'line', points, construction: true, reference: true };
}

/** Where an axis crosses its partner: the origin, or the face centre. */
export function axisPoint(e: LineEntity): Point {
  const [a, b] = e.points as [Point, Point];
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/** The face centre lines through `c`. */
export function faceAxes(c: Point): LineEntity[] {
  return [axisLine(FACE_AXIS_H, c, true), axisLine(FACE_AXIS_V, c, false)];
}

/** The axes `sk` should have as it is now. A face sketch whose outline is
 *  gone keeps the centre lines it had. */
export function sketchAxes(sk: Sketch): LineEntity[] {
  const o = axisOrigin(sk);
  const out = [axisLine(AXIS_H, o, true), axisLine(AXIS_V, o, false)];
  if (sk.face) {
    const c = faceCentre(sk);
    if (c) out.push(...faceAxes(c));
    else out.push(...(sk.entities.filter((e) => e.id === FACE_AXIS_H || e.id === FACE_AXIS_V) as LineEntity[]));
  }
  return out;
}

const fixOf = (id: string): Constraint => ({ id: FIX_PREFIX + id, type: 'fixed', entityId: id });

/** The sketch with its axes (and their 'fixed' constraints) in place, first
 *  among its entities; `sk` itself when they already are. */
export function withAxes(sk: Sketch): Sketch {
  const want = sketchAxes(sk);
  const have = new Map(sk.entities.filter(isAxis).map((e) => [e.id, e]));
  const entsOk = want.length === have.size && want.every((w) => JSON.stringify(have.get(w.id)) === JSON.stringify(w));
  const fixes = new Set(sk.constraints.filter(isAxisConstraint).map((c) => c.id));
  const consOk = want.length === fixes.size && want.every((w) => fixes.has(FIX_PREFIX + w.id))
    && sk.constraints.every((c) => !isAxisConstraint(c) || (c.type === 'fixed' && c.entityId === c.id.slice(FIX_PREFIX.length)));
  if (entsOk && consOk) return sk;
  return {
    ...sk,
    entities: entsOk ? sk.entities : [...want, ...sk.entities.filter((e) => !isAxis(e))],
    constraints: consOk ? sk.constraints : [...want.map((w) => fixOf(w.id)), ...sk.constraints.filter((c) => !isAxisConstraint(c))],
  };
}

/** The sketch as saved: without its axes, which are derived on load. The
 *  constraints and dimensions on them stay. */
export function withoutAxes(sk: Sketch): Sketch {
  if (!sk.entities.some(isAxis) && !sk.constraints.some(isAxisConstraint)) return sk;
  return { ...sk, entities: sk.entities.filter((e) => !isAxis(e)), constraints: sk.constraints.filter((c) => !isAxisConstraint(c)) };
}

/** The document with every sketch's axes in place (`doc` itself when they are). */
export function docWithAxes(doc: Document): Document {
  let changed = false;
  const sketches = doc.sketches.map((s) => {
    const n = withAxes(s);
    if (n !== s) changed = true;
    return n;
  });
  return changed ? { ...doc, sketches } : doc;
}

/** The document as saved, without the axes. */
export function docWithoutAxes<T extends { sketches?: Sketch[] }>(doc: T): T {
  if (!doc.sketches?.some((s) => s.entities.some(isAxis) || s.constraints.some(isAxisConstraint))) return doc;
  return { ...doc, sketches: doc.sketches.map(withoutAxes) };
}

/** Whether the axes are shown (a per-user view setting); hidden axes can't be
 *  picked or snapped to, but the constraints on them still hold. */
export const axesShown = (): boolean => shown;
let shown = true;

/** Set by the UI state store (stores/uiStateStore.ts), which keeps the setting. */
export function setAxesShown(v: boolean) { shown = v; }

/** Whether `e` is an axis the user can't see now (so can't pick or snap to). */
export const hiddenAxis = (e: Entity): boolean => isAxis(e) && !axesShown();

/** A document's data as saved (cache and server): without the axes, in the
 *  document and in its history alike. */
export function savedData<T>(data: T): T {
  return data && typeof data === 'object' ? docWithoutAxes(data as { sketches?: Sketch[] }) as T : data;
}

export function savedHistory<T>(history: T): T {
  const h = history as { undo?: { doc: { sketches?: Sketch[] } }[]; redo?: { doc: { sketches?: Sketch[] } }[] } | null;
  if (!h || typeof h !== 'object' || (!Array.isArray(h.undo) && !Array.isArray(h.redo))) return history;
  const strip = (es?: { doc: { sketches?: Sketch[] } }[]) => es?.map((e) => (e?.doc ? { ...e, doc: docWithoutAxes(e.doc) } : e));
  return { ...h, undo: strip(h.undo), redo: strip(h.redo) } as T;
}
