/**
 * Edges in the 3D part editor: which edge (or face) a click picks, the loop
 * and the tangent chain a double-click selects, and the readout for selected
 * edges. Pure — the viewer projects the edges and says what is hidden; the
 * build result's edges (polyline + the faces each borders) are all it needs.
 */

export type Vec3 = [number, number, number];

/** The selection: faces and edges by build-result index, in the order picked. */
export interface Selection { faces: number[]; edges: number[] }
export const NOTHING: Selection = { faces: [], edges: [] };
export const isEmpty = (s: Selection) => s.faces.length === 0 && s.edges.length === 0;

/** What a click can pick: both (an edge near the cursor wins), faces only, edges only. */
export type PickFilter = 'both' | 'faces' | 'edges';
export const PICK_FILTERS: [PickFilter, string, string][] = [
  ['both', 'Faces + edges', 'An edge within a few pixels of the cursor, else the face under it'],
  ['faces', 'Faces', 'Faces only: edges are not picked'],
  ['edges', 'Edges', 'Edges only: faces are not picked'],
];
/** The key that steps through the filters. */
export const FILTER_KEY = 'E';
export const nextFilter = (f: PickFilter): PickFilter =>
  PICK_FILTERS[(PICK_FILTERS.findIndex(([k]) => k === f) + 1) % PICK_FILTERS.length]![0];

/** How near the cursor (CSS px) an edge must be to win over the face. */
export const EDGE_PX = 6;

/** An edge as the build gives it. */
export interface EdgeLike { index: number; kind: string; faceIndices: number[]; polyline: Vec3[] }

/** An edge projected to the screen: points [x, y] in CSS px (null: behind the camera). */
export interface ScreenEdge { index: number; pts: ([number, number] | null)[] }

/** An edge near the cursor: how near, and where on it (segment, 0–1 along). */
export interface EdgeCandidate { index: number; dist: number; seg: number; t: number }

/** Distance from (px, py) to the segment a–b, and how far along it the nearest point is. */
export function segmentDistance(px: number, py: number, a: [number, number], b: [number, number]): { d: number; t: number } {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((px - a[0]) * dx + (py - a[1]) * dy) / l2)) : 0;
  return { d: Math.hypot(px - (a[0] + t * dx), py - (a[1] + t * dy)), t };
}

/** The edges within `px` of the cursor, nearest first (each once, at its nearest point). */
export function edgesNear(edges: ScreenEdge[], x: number, y: number, px = EDGE_PX): EdgeCandidate[] {
  const out: EdgeCandidate[] = [];
  for (const e of edges) {
    let best: EdgeCandidate | null = null;
    for (let i = 0; i + 1 < e.pts.length; i++) {
      const a = e.pts[i], b = e.pts[i + 1];
      if (!a || !b) continue;
      const { d, t } = segmentDistance(x, y, a, b);
      if (d <= px && (!best || d < best.dist)) best = { index: e.index, dist: d, seg: i, t };
    }
    if (best) out.push(best);
  }
  return out.sort((a, b) => a.dist - b.dist);
}

/** What a click picks. */
export type Pick = { edge: number } | { face: number } | null;

/**
 * The pick at the cursor: the nearest visible edge within the threshold
 * (`near`, nearest first), else the face under the cursor. An edge hidden
 * behind the part isn't pickable, except a selected one (it shows through
 * the part, so it can be clicked off again).
 */
export function choosePick(near: EdgeCandidate[], face: number | null, filter: PickFilter,
                           visible: (c: EdgeCandidate) => boolean, selected: ReadonlySet<number> = new Set()): Pick {
  if (filter !== 'faces') {
    for (const c of near) if (selected.has(c.index) || visible(c)) return { edge: c.index };
  }
  if (filter !== 'edges' && face != null) return { face };
  return null;
}

/** A click on `p` (Shift: add or remove it), the new selection. Empty space
 *  clears (Shift: keeps it). */
export function clickSelect(s: Selection, p: Pick, shift: boolean): Selection {
  if (!p) return shift ? s : NOTHING;
  const key = 'edge' in p ? 'edges' : 'faces';
  const i = 'edge' in p ? p.edge : p.face;
  if (!shift) return key === 'edges' ? { faces: [], edges: [i] } : { faces: [i], edges: [] };
  const list = s[key].includes(i) ? s[key].filter((x) => x !== i) : [...s[key], i];
  return { ...s, [key]: list };
}

/** Add `edges` to the selection (Shift), or select just them. */
export function selectEdges(s: Selection, edges: number[], shift: boolean): Selection {
  if (!shift) return { faces: [], edges: [...edges] };
  return { ...s, edges: [...s.edges, ...edges.filter((e) => !s.edges.includes(e))] };
}

// ---- loops and chains ----

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const norm = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const unit = (a: Vec3): Vec3 => { const l = norm(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

/** The edge's two ends (a closed edge: the same point twice). */
const ends = (e: EdgeLike): [Vec3, Vec3] | null =>
  e.polyline.length ? [e.polyline[0]!, e.polyline[e.polyline.length - 1]!] : null;

/** A distance under which two ends are the same vertex: a little of the model's size. */
export function vertexTol(edges: EdgeLike[]): number {
  let lo = Infinity, hi = -Infinity;
  for (const e of edges) for (const p of e.polyline) for (const x of p) { lo = Math.min(lo, x); hi = Math.max(hi, x); }
  return Number.isFinite(lo) ? Math.max(1e-6, (hi - lo) * 1e-5) : 1e-6;
}

const meets = (a: EdgeLike, b: EdgeLike, tol: number): boolean => {
  const ea = ends(a), eb = ends(b);
  if (!ea || !eb) return false;
  return ea.some((p) => eb.some((q) => norm(sub(p, q)) <= tol));
};

/** Edges that can be selected: between two different faces (not a seam). */
export const selectable = (e: EdgeLike) => new Set(e.faceIndices).size === 2;

/**
 * The loop of face `face`'s boundary that edge `edge` is on: the edges of
 * that face joined end to end with it. A face with a hole has two loops; this
 * is the one the edge is in (a hole's rim is its own loop).
 */
export function edgeLoop(edges: EdgeLike[], edge: number, face: number): number[] {
  const own = edges.filter((e) => e.faceIndices.includes(face) && selectable(e));
  const start = own.find((e) => e.index === edge);
  if (!start) return [edge];
  const tol = vertexTol(edges);
  const seen = new Set([start.index]);
  const queue = [start];
  while (queue.length) {
    const e = queue.shift()!;
    for (const o of own) {
      if (!seen.has(o.index) && meets(e, o, tol)) { seen.add(o.index); queue.push(o); }
    }
  }
  return own.filter((e) => seen.has(e.index)).map((e) => e.index);
}

/** All of face `face`'s boundary edges ("Edges of this face"). */
export function faceEdges(edges: EdgeLike[], face: number): number[] {
  return edges.filter((e) => e.faceIndices.includes(face) && selectable(e)).map((e) => e.index);
}

// the edge's direction leaving end `which` (0: the start, going in; 1: the end, going out)
function tangentAt(e: EdgeLike, which: 0 | 1): Vec3 | null {
  const p = e.polyline;
  if (p.length < 2) return null;
  return which === 0 ? unit(sub(p[1]!, p[0]!)) : unit(sub(p[p.length - 1]!, p[p.length - 2]!));
}

/** Two edges meet smoothly (their directions at the shared end within ~10°;
 *  the polylines' end segments stand in for the tangents). */
export const TANGENT_COS = Math.cos((10 * Math.PI) / 180);

/**
 * The chain of edges joined to `edge` end to end, each meeting the next
 * smoothly: a line running into a fillet's arc and on into the next line.
 */
export function tangentChain(edges: EdgeLike[], edge: number): number[] {
  const tol = vertexTol(edges);
  const pool = edges.filter(selectable);
  const start = pool.find((e) => e.index === edge);
  if (!start) return [edge];
  const seen = new Set([start.index]);
  const queue = [start];
  while (queue.length) {
    const e = queue.shift()!;
    const ee = ends(e)!;
    for (const o of pool) {
      if (seen.has(o.index)) continue;
      const eo = ends(o);
      if (!eo) continue;
      let smooth = false;
      for (const i of [0, 1] as const) {
        for (const j of [0, 1] as const) {
          if (norm(sub(ee[i], eo[j])) > tol) continue;
          // leaving e at end i, entering o at end j: the directions agree up to sign
          const a = tangentAt(e, i), b = tangentAt(o, j);
          if (a && b && Math.abs(dot(a, b)) >= TANGENT_COS) smooth = true;
        }
      }
      if (smooth) { seen.add(o.index); queue.push(o); }
    }
  }
  return pool.filter((e) => seen.has(e.index)).map((e) => e.index);
}

// ---- the readout ----

/** What the readout knows of an edge (the build's edge + its ref). */
export interface EdgeInfo extends EdgeLike {
  ref?: { length?: number; radius?: number; center?: Vec3; direction?: Vec3; midpoint?: Vec3; hint?: string } | null;
}

export function edgeLength(e: EdgeInfo): number {
  if (e.ref?.length != null) return e.ref.length;
  let l = 0;
  for (let i = 0; i + 1 < e.polyline.length; i++) l += norm(sub(e.polyline[i + 1]!, e.polyline[i]!));
  return l;
}

const closed = (e: EdgeInfo) => {
  const en = ends(e);
  return !!en && e.polyline.length > 2 && norm(sub(en[0], en[1])) < 1e-6 * Math.max(1, edgeLength(e));
};

const mid = (e: EdgeInfo): Vec3 => e.ref?.midpoint ?? e.polyline[Math.floor(e.polyline.length / 2)] ?? [0, 0, 0];
const dirOf = (e: EdgeInfo): Vec3 | null =>
  e.kind !== 'line' ? null : e.ref?.direction ?? (e.polyline.length >= 2 ? unit(sub(e.polyline[1]!, e.polyline[0]!)) : null);
const centreOf = (e: EdgeInfo): Vec3 | null => (e.kind === 'circle' ? e.ref?.center ?? null : null);

const f2 = (x: number) => x.toFixed(2);

/** The readout for the selected edges, in words (null: nothing to say). */
export function measureEdges(es: EdgeInfo[]): { main: string; sub?: string } | null {
  if (es.length === 0) return null;
  if (es.length === 1) {
    const e = es[0]!;
    const r = e.kind === 'circle' ? e.ref?.radius : undefined;
    if (r && closed(e)) return { main: `⌀ ${f2(2 * r)} mm`, sub: `R ${f2(r)} · circumference ${f2(edgeLength(e))}` };
    if (r) return { main: `R ${f2(r)} mm`, sub: `⌀ ${f2(2 * r)} · arc length ${f2(edgeLength(e))}` };
    return { main: `${f2(edgeLength(e))} mm`, sub: e.kind === 'line' ? 'length' : `${e.kind} length` };
  }
  if (es.length === 2) {
    const [a, b] = es as [EdgeInfo, EdgeInfo];
    const da = dirOf(a), db = dirOf(b);
    if (da && db) {
      const c = Math.min(1, Math.abs(dot(da, db)));
      const deg = (Math.acos(c) * 180) / Math.PI;
      if (deg < 0.5) {
        // parallel: how far apart the lines are
        const w = sub(mid(b), mid(a));
        const across = sub(w, [da[0] * dot(w, da), da[1] * dot(w, da), da[2] * dot(w, da)]);
        return { main: `${f2(norm(across))} mm`, sub: 'parallel, apart' };
      }
      return { main: `${deg.toFixed(1)}°`, sub: 'angle between them' };
    }
    const pa = centreOf(a) ?? mid(a), pb = centreOf(b) ?? mid(b);
    const d = sub(pb, pa);
    const what = centreOf(a) && centreOf(b) ? 'centre to centre' : 'apart';
    return { main: `${f2(norm(d))} mm`, sub: `${what} · X ${d[0].toFixed(1)}, Y ${d[1].toFixed(1)}, Z ${d[2].toFixed(1)}` };
  }
  const total = es.reduce((s, e) => s + edgeLength(e), 0);
  return { main: `${f2(total)} mm`, sub: `${es.length} edges, total length` };
}

// ---- the edges a fillet / chamfer line names ----

/** What an edge reference holds that the editor matches on (EdgeRefSpec). */
export interface EdgeRefLike {
  kind: string; midpoint: Vec3; length: number;
  faces?: { normal: Vec3; kind?: string }[];
  hint?: string;
}

/** The same edge, as the build described it (its midpoint, length and kind). */
export function sameEdgeRef(a: EdgeRefLike, b: EdgeRefLike): boolean {
  const tol = 1e-3 * Math.max(1, a.length);
  return a.kind === b.kind && Math.abs(a.length - b.length) <= tol && norm(sub(a.midpoint, b.midpoint)) <= tol;
}

/** The edge of the shown part a reference names, if it's there as it was
 *  (after the fillet it names it isn't: the fillet replaced it). */
export function edgeOfRef(edges: { index: number; ref?: EdgeRefLike | null }[], r: EdgeRefLike): number | null {
  return edges.find((e) => e.ref && sameEdgeRef(e.ref, r))?.index ?? null;
}

/** Where a fillet / chamfer handle sits on an edge and the way it drags: from
 *  the edge's midpoint into the part, between its two faces (away from both
 *  outward normals; with a curved face, away from the flat one's). Worked out
 *  from the reference alone, so it works on a reopened line too. */
export function edgeHandle(r: EdgeRefLike): { at: Vec3; dir: Vec3 } {
  const flat = (r.faces ?? []).filter((f) => !f.kind).map((f) => f.normal);
  const ns = flat.length ? flat : (r.faces ?? []).map((f) => f.normal);
  let d: Vec3 = [0, 0, 0];
  for (const n of ns) d = [d[0] - n[0], d[1] - n[1], d[2] - n[2]];
  if (norm(d) < 1e-6) d = ns[0] ? [-ns[0][0], -ns[0][1], -ns[0][2]] : [0, 0, -1];
  return { at: r.midpoint, dir: unit(d) };
}
