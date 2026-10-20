/**
 * Construction planes (backend modeling/planes.py): named planes defined by
 * the part's geometry, PLANES["Lid"] = offset_plane(...) / edge_plane(...).
 * Pure helpers: the rectangle a plane is drawn as, the preview geometry a
 * dialog shows while it is being typed (the same math as the backend's), the
 * per-part show/hide list, names, and the dialogs' amounts (a number or an
 * expression of parameter names).
 */
import type { EdgeRefSpec, FaceRefSpec, PlanePayload, PlaneReport } from '@/api/client';
import { evaluateExpression, isExpression } from '@/utils/expression';
import { add, cross, dot, len, scale, sub, type Vec3 } from './dragHandle';
import { planeForFace } from './sketchPlane';

/** A plane to draw: where it is, and whether it is a dialog's preview. */
export interface PlaneShape {
  name: string;
  origin: Vec3; normal: Vec3; xAxis: Vec3;
  preview?: boolean;
}

export type BaseName = 'XY' | 'XZ' | 'YZ';
export const BASE_NORMALS: Record<BaseName, Vec3> = { XY: [0, 0, 1], XZ: [0, -1, 0], YZ: [1, 0, 0] };

const unit = (v: Vec3): Vec3 => scale(v, 1 / (len(v) || 1));

/** The plane's in-plane axes: u along xAxis, v = normal × xAxis. */
export function planeAxes(p: Pick<PlaneShape, 'normal' | 'xAxis'>): { u: Vec3; v: Vec3; n: Vec3 } {
  const n = unit(p.normal);
  const u = unit(sub(p.xAxis, scale(n, dot(p.xAxis, n))));
  return { u, v: cross(n, u), n };
}

/** The rectangle a plane is drawn as: the part's box seen square-on in the
 *  plane, a little larger (margin mm each side). Corners in order round the
 *  loop: (u0,v0) (u1,v0) (u1,v1) (u0,v1). */
export function planeCorners(p: PlaneShape, min: Vec3, max: Vec3, margin: number): [Vec3, Vec3, Vec3, Vec3] {
  const { u, v } = planeAxes(p);
  let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
  for (let i = 0; i < 8; i++) {
    const c: Vec3 = [i & 1 ? max[0] : min[0], i & 2 ? max[1] : min[1], i & 4 ? max[2] : min[2]];
    const d = sub(c, p.origin);
    const a = dot(d, u), b = dot(d, v);
    u0 = Math.min(u0, a); u1 = Math.max(u1, a); v0 = Math.min(v0, b); v1 = Math.max(v1, b);
  }
  u0 -= margin; u1 += margin; v0 -= margin; v1 += margin;
  const at = (a: number, b: number) => add(p.origin, add(scale(u, a), scale(v, b)));
  return [at(u0, v0), at(u1, v0), at(u1, v1), at(u0, v1)];
}

/** The rectangle's outline as segment pairs [x,y,z, x,y,z, …]. */
export function outlineSegments(c: readonly Vec3[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < c.length; i++) out.push(...c[i]!, ...c[(i + 1) % c.length]!);
  return out;
}

/** Where the name goes: the rectangle's (u0, v1) corner — top left when
 *  looking at the plane. */
export const labelCorner = (c: readonly Vec3[]): Vec3 => c[3]!;

/** An offset plane's geometry: parallel to the face (or base plane) at
 *  `distance` along its outward normal, its x axis a face sketch's on it. */
export function offsetPlaneShape(base: BaseName | { center: Vec3; normal: Vec3 }, distance: number):
  Omit<PlaneShape, 'name'> {
  const f = typeof base === 'string' ? { center: [0, 0, 0] as Vec3, normal: BASE_NORMALS[base] } : base;
  const p = planeForFace(f.center, f.normal);
  return { origin: add(p.origin, scale(p.normal, distance)), normal: p.normal, xAxis: p.xAxis };
}

/** The point an offset plane's distance is measured from, under the part's
 *  middle: where the distance handle sits at 0. */
export function offsetBasePoint(base: BaseName | { center: Vec3; normal: Vec3 }, partCenter: Vec3): Vec3 {
  const f = typeof base === 'string' ? { center: [0, 0, 0] as Vec3, normal: BASE_NORMALS[base] } : base;
  const n = unit(f.normal);
  return add(partCenter, scale(n, dot(sub(f.center, partCenter), n)));
}

/** Where a face lies beside the edge a→b, read off its own triangles the way
 *  the backend's edge_plane reads it off the face: `w` across the edge onto
 *  the face, `n` the face's outward normal there. The face's centre can't
 *  tell: round a hole or pocket it is on the far side of the edge. The face
 *  is the mesh's vertices [start, start+count), flat triangles; `normals`
 *  (per vertex) orient it, else the face's own normal does. null: no
 *  triangle of the face lies along the edge. */
export function faceBesideEdge(positions: ArrayLike<number>, face: { start: number; count: number; normal: Vec3 },
                               a: Vec3, b: Vec3, normals?: ArrayLike<number>): { w: Vec3; n: Vec3 } | null {
  const L = len(sub(b, a));
  if (L < 1e-9) return null;
  const d = scale(sub(b, a), 1 / L), tol = 1e-4 * L + 1e-6;
  const vtx = (i: number): Vec3 => [positions[i * 3]!, positions[i * 3 + 1]!, positions[i * 3 + 2]!];
  const along = (p: Vec3) => dot(sub(p, a), d) / L;
  const off = (p: Vec3) => len(sub(sub(p, a), scale(d, dot(sub(p, a), d))));
  let best: { w: Vec3; n: Vec3; gap: number } | null = null;
  for (let v = face.start; v + 2 < face.start + face.count; v += 3) {
    const p = [vtx(v), vtx(v + 1), vtx(v + 2)];
    const on = [0, 1, 2].filter((i) => off(p[i]!) < tol);
    if (on.length !== 2) continue;
    const t0 = along(p[on[0]!]!), t1 = along(p[on[1]!]!);
    const lo = Math.min(t0, t1), hi = Math.max(t0, t1);
    if (hi < -1e-6 || lo > 1 + 1e-6) continue;
    // the triangle spanning the edge's middle, else the one nearest it
    const gap = lo <= 0.5 && 0.5 <= hi ? 0 : Math.min(Math.abs(lo - 0.5), Math.abs(hi - 0.5));
    if (best && gap >= best.gap) continue;
    const c = p[3 - on[0]! - on[1]!]!;
    const w = sub(sub(c, a), scale(d, dot(sub(c, a), d)));
    let n = cross(sub(p[1]!, p[0]!), sub(p[2]!, p[0]!));
    if (len(w) < 1e-12 || len(n) < 1e-12) continue;
    const vn: Vec3 = normals
      ? [0, 1, 2].reduce<Vec3>((s, i) => add(s, [normals[(v + i) * 3]!, normals[(v + i) * 3 + 1]!, normals[(v + i) * 3 + 2]!]), [0, 0, 0])
      : face.normal;
    if (dot(n, vn) < 0) n = scale(n, -1);
    best = { w: unit(w), n: unit(n), gap };
  }
  return best && { w: best.w, n: best.n };
}

/** A plane-on-edge's geometry (planes.edge_plane): through the straight edge
 *  a→b; at 0° the plane of `face`, turned `angle` degrees about the edge,
 *  positive lifting the half over the face out of the material. Also gives
 *  the rotation frame: `w` points across the face from the edge, `n` is the
 *  face's normal (the handle turns in the w–n plane). `face.at` is where the
 *  face lies at the edge (faceBesideEdge); without it, toward its centre. */
export function edgePlaneShape(a: Vec3, b: Vec3, face: { center: Vec3; normal: Vec3; at?: { w: Vec3; n: Vec3 } | null },
                               angle: number):
  Omit<PlaneShape, 'name'> & { mid: Vec3; d: Vec3; w: Vec3; n: Vec3 } {
  let d = unit(sub(b, a));
  const mid = scale(add(a, b), 0.5);
  const fn = face.at?.n ?? face.normal;
  const n = unit(sub(fn, scale(d, dot(fn, d))));
  let w = cross(n, d);
  // w points onto the face
  const onto = face.at?.w ?? sub(face.center, mid);
  if (dot(onto, w) < 0) { d = scale(d, -1); w = scale(w, -1); }
  const r = (angle * Math.PI) / 180;
  const normal = sub(scale(n, Math.cos(r)), scale(w, Math.sin(r)));
  const origin = sub(a, scale(d, dot(a, d)));
  return { origin, normal, xAxis: d, mid, d, w, n };
}

/** A new plane's name: "Plane 1", "Plane 2"… not yet used. */
export function newPlaneName(used: Iterable<string>, base = 'Plane'): string {
  const taken = new Set(used);
  for (let i = 1; ; i++) if (!taken.has(`${base} ${i}`)) return `${base} ${i}`;
}

/** Why a plane name can't be used (null: it can). */
export function planeNameProblem(name: string, used: Iterable<string>, own?: string): string | null {
  const t = name.trim();
  if (!t) return 'Give the plane a name';
  if (/["\\\n]/.test(t)) return 'A plane name can’t contain quotes, backslashes or new lines';
  if (t !== own && new Set(used).has(t)) return `There is already a plane named '${t}'`;
  return null;
}

/** A dialog's amount: a number, or an expression of parameter names. */
export type Amount = number | string;

/** Its value with these parameters (null: not a valid expression). */
export function amountValue(a: Amount, params: Record<string, number>): number | null {
  if (typeof a === 'number') return Number.isFinite(a) ? a : null;
  const t = a.trim();
  if (!t) return null;
  try {
    const v = isExpression(t) ? evaluateExpression(t, params) : Number(t);
    return Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}

/** What the payload carries: a number as a number, an expression as its text. */
export function amountOut(a: Amount): number | string {
  if (typeof a === 'number') return a;
  const t = a.trim();
  return isExpression(t) ? t : Number(t);
}

/** The amount as the dialog shows it. */
export const amountText = (a: Amount): string => (typeof a === 'number' ? `${+a.toFixed(4)}` : a);

/** The Offset plane dialog's values. */
export interface OffsetPlaneValues {
  name: string;
  /** the face it's offset from (its ref, and the face picked), or a base plane */
  base: BaseName | 'face';
  face: { ref: FaceRefSpec; center: Vec3; normal: Vec3; hint: string } | null;
  distance: Amount;
}

/** The Plane on edge dialog's values. */
export interface EdgePlaneValues {
  name: string;
  edge: EdgeRefSpec;
  /** the edge's two faces (their refs and where they are), and which is 0° */
  faces: { ref: FaceRefSpec; center: Vec3; normal: Vec3; hint: string; index: number;
           /** where it lies at the edge, from its triangles (faceBesideEdge) */
           at?: { w: Vec3; n: Vec3 } | null }[];
  from: number;
  angle: Amount;
  /** the edge's ends */
  a: Vec3; b: Vec3;
}

/** A reopened Plane on edge line's from_face among the edge's faces as the
 *  part is now: the one facing most nearly its way (a later step may have cut
 *  that face, so its centre and area no longer match). That face keeps the
 *  line's own reference, so updating the line doesn't swap it for one taken
 *  from after the later steps. */
export function reopenedFromFace(faces: EdgePlaneValues['faces'], fromFace: FaceRefSpec | null | undefined):
  { faces: EdgePlaneValues['faces']; from: number } {
  if (!fromFace || !faces.length) return { faces, from: 0 };
  let from = 0;
  faces.forEach((f, i) => { if (dot(f.normal, fromFace.normal as Vec3) > dot(faces[from]!.normal, fromFace.normal as Vec3)) from = i; });
  return { faces: faces.map((f, i) => (i === from ? { ...f, ref: fromFace } : f)), from };
}

export function offsetPayload(v: OffsetPlaneValues): PlanePayload {
  return { op: 'offset_plane', name: v.name.trim(),
           base: v.base === 'face' && v.face ? { face: v.face.ref } : (v.base === 'face' ? 'XY' : v.base),
           distance: amountOut(v.distance) };
}

export function edgePayload(v: EdgePlaneValues): PlanePayload {
  return { op: 'edge_plane', name: v.name.trim(), edge: v.edge, angle: amountOut(v.angle),
           from_face: v.faces[v.from]?.ref ?? null };
}

/** "30 mm above the top face", "15 mm into the right face", "on the XY plane". */
export function offsetSummary(base: string, d: number | null): string {
  if (d === null) return `from the ${base}`;
  const mm = `${+Math.abs(d).toFixed(3)} mm`;
  if (Math.abs(d) < 1e-9) return `on the ${base}`;
  const face = / face$/.test(base);
  return face ? `${mm} ${d > 0 ? 'out from' : 'into the part from'} the ${base}`
    : `${mm} ${d > 0 ? 'along' : 'against'} the ${base}'s normal`;
}

/** "tilted 30° out of the material from the top face". */
export function edgeSummary(face: string, a: number | null): string {
  if (a === null) return `turned from the ${face}`;
  if (Math.abs(a) < 1e-9) return `in the ${face}`;
  return `${+Math.abs(a).toFixed(3)}° ${a > 0 ? 'out of' : 'into'} the part from the ${face}`;
}

// ── show / hide, per part (view state: never in the script) ──

const hiddenKey = (docId: string) => `intentcad-planes-hidden-${docId}`;

/** The planes hidden in this part (a new plane is shown: only hidden ones are kept). */
export function loadHiddenPlanes(docId: string): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(hiddenKey(docId)) ?? '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export function saveHiddenPlanes(docId: string, names: string[]): void {
  try {
    if (names.length) localStorage.setItem(hiddenKey(docId), JSON.stringify(names));
    else localStorage.removeItem(hiddenKey(docId));
  } catch { /* private mode: not kept */ }
}

/** The hidden list after a rename (the plane stays hidden under its new name). */
export function renameHidden(hidden: string[], old: string, name: string): string[] {
  return hidden.map((h) => (h === old ? name : h));
}

/** The planes to draw: the build's, less the hidden ones, plus a preview. */
export function shownPlanes(planes: Record<string, PlaneReport> | undefined, hidden: readonly string[],
                            preview?: PlaneShape | null): PlaneShape[] {
  const out: PlaneShape[] = Object.entries(planes ?? {})
    .filter(([n]) => !hidden.includes(n) && n !== preview?.name)
    .map(([name, p]) => ({ name, origin: p.origin, normal: p.normal, xAxis: p.xAxis }));
  if (preview) out.push({ ...preview, preview: true });
  return out;
}
