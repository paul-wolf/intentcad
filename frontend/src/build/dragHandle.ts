/**
 * Direct-manipulation drag handles: the pure math behind dragging a face to
 * change the parameter that moves it. A param's `shifts` (backend sensitivity)
 * say how far each face it controls travels per unit of the param; a drag
 * along that shift on screen inverts it back into a param value.
 */

import type { DimInfo } from '@/api/client';

export type Vec3 = [number, number, number];

export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
export const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: Vec3, b: Vec3): Vec3 =>
  [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const len = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);

/** The face fields the handle math needs (a subset of the viewer's FaceRange). */
export interface HandleFace {
  index: number; start: number; count: number;
  kind: string; center: Vec3; normal: Vec3;
  radius?: number | null;
}

/** One param that can be dragged from a face. */
export interface HandleOption {
  name: string;
  value: number;
  shift: Vec3;       // the face's world motion per unit of the param
  dr: number;        // a cylinder face's radius change per unit (else 0)
  moves: number[];   // every face the param changes (not snap targets)
}

/** The params that move `face`, best first: the one whose shift is most
 * parallel to the face normal (a drag "pushes/pulls" the face), then by name. */
export function handleOptions(face: HandleFace, sens: Record<string, DimInfo>): HandleOption[] {
  const out: (HandleOption & { par: number })[] = [];
  for (const [name, d] of Object.entries(sens)) {
    const s = d.shifts?.[face.index];
    if (!s) continue;
    const l = len(s);
    if (l < 1e-6) continue;
    out.push({ name, value: d.value, shift: s, dr: d.radial?.[face.index] ?? 0, moves: d.faces,
               par: Math.abs(dot(s, face.normal)) / l });
  }
  out.sort((a, b) => b.par - a.par || a.name.localeCompare(b.name));
  return out.map(({ par: _par, ...o }) => o);
}

/** The world motion a drag follows per unit of the param. A face the param
 * resizes (a fillet or hole: `dr` per unit) may barely move — a fillet's face
 * sits only ~0.4 mm further in per mm of radius — so the drag goes at the
 * radius's rate instead, along the same direction: a mm of drag a mm of radius. */
export function dragShift(shift: Vec3, dr: number): Vec3 {
  const l = len(shift);
  return dr && l > 1e-9 && Math.abs(dr) > l ? scale(shift, Math.abs(dr) / l) : shift;
}

/** Param change for a mouse drag: the mouse delta projected onto the screen
 * image of the shift. `s` is the screen motion (px) per unit of the param.
 * Null when the shift points (nearly) at the camera — no usable direction. */
export function dragAmount(mouse: [number, number], s: [number, number]): number | null {
  const ss = s[0] * s[0] + s[1] * s[1];
  if (ss < 1e-4) return null;
  return (mouse[0] * s[0] + mouse[1] * s[1]) / ss;
}

/** Round to a grid step, without float noise (7.5, not 7.500000000001). */
export function snapToStep(v: number, step: number): number {
  return Math.round(Math.round(v / step) * step * 1e6) / 1e6;
}

/** Snap a drag so the dragged planar face lands on the plane of another face
 * with a parallel (or opposed) normal, when that's within `tolPx` on screen.
 * `t` is the raw param change, `pxPerUnit` the screen length of one unit of
 * shift. Faces the param itself moves are skipped — their planes aren't fixed.
 * Returns the snapped change and the face it snapped to, or null. */
export function snapToPlane(
  face: HandleFace, shift: Vec3, t: number, pxPerUnit: number,
  faces: HandleFace[], skip: Iterable<number>, tolPx = 6,
): { t: number; face: number } | null {
  if (face.kind !== 'plane') return null;
  const n = face.normal;
  const ns = dot(n, shift);        // plane offset per unit of the param
  if (Math.abs(ns) < 1e-6) return null;
  const skipSet = new Set(skip);
  let best: { t: number; face: number } | null = null;
  let bestPx = tolPx;
  for (const g of faces) {
    if (g.index === face.index || g.kind !== 'plane' || skipSet.has(g.index)) continue;
    if (Math.abs(dot(n, g.normal)) < 0.999) continue;
    const tg = dot(n, sub(g.center, face.center)) / ns;
    const px = Math.abs(t - tg) * pxPerUnit;
    if (px < bestPx) { bestPx = px; best = { t: tg, face: g.index }; }
  }
  return best;
}

/** Per-vertex world motion per unit of the param, for previewing a drag by
 * offsetting the face's own triangles. A face translates by `shift` (its
 * anchor's motion). A cylinder whose radius changes (`dr` per unit — a hole
 * or boss diameter) also dilates about its axis, recovered from the mesh: each
 * vertex moves `dr` away from the axis, plus whatever translation is left of
 * the anchor's shift once its own radial part is taken out.
 * `positions` is the whole mesh (flat xyz); the face is [start, start+count). */
export function faceMotion(face: HandleFace, positions: ArrayLike<number>, shift: Vec3, dr = 0): Float32Array {
  const out = new Float32Array(face.count * 3);
  for (let i = 0; i < face.count; i++) out.set(shift, i * 3);
  const r = face.radius;
  if (face.kind !== 'cylinder' || !r || !dr) return out;

  const vtx = (i: number): Vec3 => [positions[i * 3]!, positions[i * 3 + 1]!, positions[i * 3 + 2]!];
  const n = face.normal, P = face.center;
  // axis direction: both n and any other triangle's normal are radial, so
  // their cross product runs along the axis (take the best-conditioned one)
  let axis: Vec3 | null = null, best = 0.2;
  for (let v = face.start; v + 2 < face.start + face.count; v += 3) {
    const a = vtx(v);
    const tn = cross(sub(vtx(v + 1), a), sub(vtx(v + 2), a));
    const tl = len(tn);
    if (tl < 1e-12) continue;
    const c = cross(n, scale(tn, 1 / tl));
    const cl = len(c);
    if (cl > best) { best = cl; axis = scale(c, 1 / cl); }
  }
  if (!axis) return out;
  const ax = axis;
  const radial = (p: Vec3, a: Vec3): Vec3 => { const w = sub(p, a); return sub(w, scale(ax, dot(w, ax))); };
  // the axis is `r` from the anchor along ±n — whichever side every vertex
  // is `r` away from (a hole's normal points at its axis, a boss's away)
  const err = (k: number) => {
    const a = add(P, scale(n, k * r));
    let e = 0;
    const stride = Math.max(1, Math.floor(face.count / 32));
    for (let i = 0; i < face.count; i += stride) e += Math.abs(len(radial(vtx(face.start + i), a)) - r);
    return e;
  };
  const k = err(1) <= err(-1) ? 1 : -1;
  const A = add(P, scale(n, k * r));
  const trans = sub(shift, scale(n, -k * dr));   // anchor's shift minus its radial part (-k·n is away from the axis there)
  for (let i = 0; i < face.count; i++) {
    const w = radial(vtx(face.start + i), A);
    const wl = len(w);
    if (wl < 1e-9) continue;
    out.set(add(trans, scale(w, dr / wl)), i * 3);
  }
  return out;
}
