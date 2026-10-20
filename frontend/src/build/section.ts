/**
 * The section view: a plane that cuts the part open in the 3D view, for
 * checking wall thicknesses, insert depths and board fit. View-only: the
 * script never changes. The pure maths is here; the viewer draws it.
 *
 * A section is the plane dot(p, dir) = offset. The side `dir` points to is
 * cut away, or the other side when it is flipped. `offset` is where the plane
 * sits along `dir` (for an axis, its coordinate), so Flip never moves it.
 */
import { add, cross, dot, len, scale, sub, type Vec3 } from './dragHandle';

export interface Section { dir: Vec3; offset: number; flip: boolean }

/** A selected face starts the plane this far inside it (mm). */
export const FACE_INSET = 0.1;

const unit = (v: Vec3): Vec3 => { const l = len(v) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };

/** The plane's normal pointing into the side that is cut away. */
export const cutNormal = (s: Section): Vec3 => (s.flip ? scale(s.dir, -1) : s.dir);

/** The plane for a shader: fragments with dot(p, n) > w are cut away. */
export function shaderPlane(s: Section): [number, number, number, number] {
  const n = cutNormal(s);
  return [n[0], n[1], n[2], s.flip ? -s.offset : s.offset];
}

/** How far p is into the cut-away side (negative: on the side that stays). */
export const cutDepth = (s: Section, p: Vec3): number => (dot(p, s.dir) - s.offset) * (s.flip ? -1 : 1);

export const isCut = (s: Section, p: Vec3, eps = 1e-6): boolean => cutDepth(s, p) > eps;

/** The same plane, cutting away the other side. */
export const flipSection = (s: Section): Section => ({ ...s, flip: !s.flip });

/** The plane moved by d along its `dir` (the offset's direction). */
export const moveSection = (s: Section, d: number): Section => ({ ...s, offset: s.offset + d });

/** The point of the plane nearest p. */
export const planePoint = (s: Section, p: Vec3): Vec3 => add(p, scale(s.dir, s.offset - dot(p, s.dir)));

/** The plane on a selected flat face: parallel to it, just inside the
 *  material, cutting away the face's own side (so you look into the part
 *  through where the face was). */
export function sectionOnFace(face: { center: Vec3; normal: Vec3 }, inset = FACE_INSET): Section {
  const n = unit(face.normal);
  return { dir: n, offset: dot(face.center, n) - inset, flip: false };
}

/** The standard axis (0 X, 1 Y, 2 Z) nearest the direction v. */
export function nearestAxis(v: Vec3): 0 | 1 | 2 {
  const a = v.map(Math.abs);
  return a[0]! >= a[1]! && a[0]! >= a[2]! ? 0 : a[1]! >= a[2]! ? 1 : 2;
}

/** A plane square to an axis through `center`, cutting away the side toward
 *  the viewer (`back`: from the part toward the camera), so the cut faces you. */
export function axisSection(axis: 0 | 1 | 2, center: Vec3, back: Vec3): Section {
  const dir: Vec3 = [0, 0, 0];
  dir[axis] = 1;
  return { dir, offset: center[axis], flip: back[axis] < 0 };
}

/** With no face selected: through the part's centre, square to the standard
 *  axis nearest the line of sight. */
export const sectionForView = (back: Vec3, center: Vec3): Section => axisSection(nearestAxis(back), center, back);

/** The section's axis, if it is square to one (for the panel). */
export function sectionAxis(s: Section): 'X' | 'Y' | 'Z' | null {
  const i = nearestAxis(s.dir);
  return Math.abs(s.dir[i]) > 0.99999 ? (['X', 'Y', 'Z'] as const)[i] : null;
}

/** Which side is cut away, in words: "the +Y side", "the side the face looks to". */
export function cutSideText(s: Section): string {
  const ax = sectionAxis(s);
  if (!ax) return s.flip ? 'the side behind the face' : 'the side the face looks to';
  const sign = (s.dir[nearestAxis(s.dir)] > 0) !== s.flip ? '+' : '−';
  return `the ${sign}${ax} side`;
}

/** Where the plane is, for the panel's offset box: on an axis, its
 *  coordinate along that axis (Y = 30 whichever way the plane faces); off
 *  one, its distance from the origin along its own normal. */
export function sectionPosition(s: Section): number {
  const ax = sectionAxis(s);
  return ax && s.dir[nearestAxis(s.dir)] < 0 ? -s.offset : s.offset;
}

/** The plane moved to a typed position (as sectionPosition reads it). */
export function atPosition(s: Section, v: number): Section {
  const ax = sectionAxis(s);
  return { ...s, offset: ax && s.dir[nearestAxis(s.dir)] < 0 ? -v : v };
}

/** Two unit vectors spanning the plane square to n (u × v = n). */
export function planeBasis(n: Vec3): [Vec3, Vec3] {
  const a: Vec3 = Math.abs(n[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const u = unit(cross(a, n));
  return [u, cross(n, u)];
}

/** dot(vertex, dir) for every vertex: kept while the plane only moves along
 *  dir, so a drag recomputes the outline from these alone. */
export function vertexDots(positions: ArrayLike<number>, dir: Vec3): Float32Array {
  const n = Math.floor(positions.length / 3);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = positions[i * 3]! * dir[0] + positions[i * 3 + 1]! * dir[1] + positions[i * 3 + 2]! * dir[2];
  }
  return out;
}

/** The plane's cut through a triangle soup: one segment per triangle that
 *  crosses it, as world endpoints (6 floats each) and the triangle it came
 *  from. A vertex exactly on the plane counts as on the side `dir` points to,
 *  so an edge lying in the plane comes out once (from the triangle on the
 *  other side), a triangle in the plane gives nothing, and a triangle that
 *  only touches it at a corner gives nothing. */
export function sectionSegments(positions: ArrayLike<number>, dots: ArrayLike<number>, offset: number,
                                first = 0, count = dots.length - first): { pts: number[]; tri: number[] } {
  const pts: number[] = [];
  const tri: number[] = [];
  const at = (i: number, j: number, si: number, sj: number) => {
    const t = si / (si - sj);
    pts.push(positions[i * 3]! + (positions[j * 3]! - positions[i * 3]!) * t,
             positions[i * 3 + 1]! + (positions[j * 3 + 1]! - positions[i * 3 + 1]!) * t,
             positions[i * 3 + 2]! + (positions[j * 3 + 2]! - positions[i * 3 + 2]!) * t);
  };
  for (let v = first; v + 2 < first + count; v += 3) {
    const s0 = dots[v]! - offset, s1 = dots[v + 1]! - offset, s2 = dots[v + 2]! - offset;
    const n0 = s0 < 0, n1 = s1 < 0, n2 = s2 < 0;
    const neg = +n0 + +n1 + +n2;
    if (neg === 0 || neg === 3) continue;
    // the lone vertex on one side, and the two on the other
    const lone = neg === 1 ? (n0 ? 0 : n1 ? 1 : 2) : (!n0 ? 0 : !n1 ? 1 : 2);
    const a = v + lone, b = v + (lone + 1) % 3, c = v + (lone + 2) % 3;
    const sa = dots[a]! - offset, sb = dots[b]! - offset, sc = dots[c]! - offset;
    const k = pts.length;
    at(a, b, sa, sb);
    at(a, c, sa, sc);
    if (pts[k] === pts[k + 3] && pts[k + 1] === pts[k + 4] && pts[k + 2] === pts[k + 5]) {
      pts.length = k;   // only a corner on the plane
      continue;
    }
    tri.push(v / 3);
  }
  return { pts, tri };
}

/** The section outline, ready to draw and measure on. */
export interface Outline {
  /** world endpoints, 6 floats a segment */
  pts: Float32Array;
  /** the triangle each segment came from */
  tri: Int32Array;
  /** the endpoints in the plane's (u, v) coordinates, 4 floats a segment */
  uv: Float32Array;
  /** the in-plane normal pointing out of the material, 2 floats a segment
   *  (0, 0 when the face lies nearly in the plane) */
  out: Float32Array;
  count: number;
  basis: [Vec3, Vec3];
}

/** The outline of the cut at `offset` along `dir`, from the vertex dots. */
export function buildOutline(positions: ArrayLike<number>, normals: ArrayLike<number>, dots: ArrayLike<number>,
                             dir: Vec3, offset: number): Outline {
  const { pts, tri } = sectionSegments(positions, dots, offset);
  const count = tri.length;
  const basis = planeBasis(dir);
  const [u, v] = basis;
  const uv = new Float32Array(count * 4);
  const out = new Float32Array(count * 2);
  for (let i = 0; i < count; i++) {
    for (let e = 0; e < 2; e++) {
      const p: Vec3 = [pts[i * 6 + e * 3]!, pts[i * 6 + e * 3 + 1]!, pts[i * 6 + e * 3 + 2]!];
      uv[i * 4 + e * 2] = dot(p, u);
      uv[i * 4 + e * 2 + 1] = dot(p, v);
    }
    const t = tri[i]! * 9;
    const nf: Vec3 = [normals[t] ?? 0, normals[t + 1] ?? 0, normals[t + 2] ?? 0];
    const mu = dot(nf, u), mv = dot(nf, v), ml = Math.hypot(mu, mv);
    if (ml > 1e-3) { out[i * 2] = mu / ml; out[i * 2 + 1] = mv / ml; }
  }
  return { pts: new Float32Array(pts), tri: new Int32Array(tri), uv, out, count, basis };
}

/** The point of segment i nearest q (plane coordinates), and how far it is. */
export function nearestOnSegment(o: Outline, i: number, q: [number, number]): { p: [number, number]; d: number } {
  const ax = o.uv[i * 4]!, ay = o.uv[i * 4 + 1]!, bx = o.uv[i * 4 + 2]!, by = o.uv[i * 4 + 3]!;
  const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((q[0] - ax) * dx + (q[1] - ay) * dy) / l2)) : 0;
  const p: [number, number] = [ax + dx * t, ay + dy * t];
  return { p, d: Math.hypot(q[0] - p[0], q[1] - p[1]) };
}

/** The outline segment nearest q, within maxD. */
export function nearestSegment(o: Outline, q: [number, number], maxD = Infinity):
  { seg: number; p: [number, number]; d: number } | null {
  let best: { seg: number; p: [number, number]; d: number } | null = null;
  for (let i = 0; i < o.count; i++) {
    const r = nearestOnSegment(o, i, q);
    if (r.d <= maxD && (!best || r.d < best.d)) best = { seg: i, ...r };
  }
  return best;
}

/** Whether q (plane coordinates) is in the material: inside the outline,
 *  by the even-odd rule. */
export function insideOutline(o: Outline, q: [number, number]): boolean {
  let inside = false;
  for (let i = 0; i < o.count; i++) {
    const ax = o.uv[i * 4]!, ay = o.uv[i * 4 + 1]!, bx = o.uv[i * 4 + 2]!, by = o.uv[i * 4 + 3]!;
    if ((ay > q[1]) === (by > q[1])) continue;
    const x = ax + ((q[1] - ay) / (by - ay)) * (bx - ax);
    if (x > q[0]) inside = !inside;
  }
  return inside;
}

/** The wall's thickness at p on segment `seg`: across the material along the
 *  segment's inward normal, to the first outline segment it meets. */
export function wallThickness(o: Outline, seg: number, p: [number, number]):
  { mm: number; to: [number, number]; seg: number } | null {
  const dx = -o.out[seg * 2]!, dy = -o.out[seg * 2 + 1]!;
  if (!dx && !dy) return null;
  let best: { mm: number; to: [number, number]; seg: number } | null = null;
  for (let j = 0; j < o.count; j++) {
    if (j === seg) continue;
    const ax = o.uv[j * 4]!, ay = o.uv[j * 4 + 1]!;
    const ex = o.uv[j * 4 + 2]! - ax, ey = o.uv[j * 4 + 3]! - ay;
    const den = dx * ey - dy * ex;
    if (Math.abs(den) < 1e-12) continue;   // parallel to the ray
    const wx = ax - p[0], wy = ay - p[1];
    const t = (wx * ey - wy * ex) / den;      // along the ray
    const s = (wx * dy - wy * dx) / den;      // along the segment
    if (t <= 1e-4 || s < -1e-9 || s > 1 + 1e-9) continue;
    if (!best || t < best.mm) best = { mm: t, to: [p[0] + dx * t, p[1] + dy * t], seg: j };
  }
  return best;
}

/** A plane-coordinate point back in the world. */
export function fromPlane(o: Outline, s: Section, q: [number, number]): Vec3 {
  const [u, v] = o.basis;
  return add(add(scale(u, q[0]), scale(v, q[1])), scale(s.dir, s.offset));
}

/** The plane coordinates of a world point. */
export const toPlane = (o: Outline, p: Vec3): [number, number] => [dot(p, o.basis[0]), dot(p, o.basis[1])];

/** The separate bodies of a part: faces joined by an edge are one body.
 *  Returns each face's body number (0, 1, …, in face order). */
export function faceBodies(faceCount: number, edges: { faceIndices: number[] }[]): Int32Array {
  const parent = Array.from({ length: faceCount }, (_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) { parent[i] = parent[parent[i]!]!; i = parent[i]!; }
    return i;
  };
  for (const e of edges) {
    const fs = e.faceIndices.filter((f) => f >= 0 && f < faceCount);
    for (let k = 1; k < fs.length; k++) {
      const a = find(fs[0]!), b = find(fs[k]!);
      if (a !== b) parent[b] = a;
    }
  }
  const id = new Map<number, number>();
  const out = new Int32Array(faceCount);
  for (let i = 0; i < faceCount; i++) {
    const r = find(i);
    if (!id.has(r)) id.set(r, id.size);
    out[i] = id.get(r)!;
  }
  return out;
}

/** Six times the signed volume of the triangles from vertex `first` (`count`
 *  vertices): positive when they wind counter-clockwise seen from outside. */
export function signedVolume6(positions: ArrayLike<number>, first: number, count: number): number {
  let v = 0;
  for (let i = first; i + 2 < first + count; i += 3) {
    const a: Vec3 = [positions[i * 3]!, positions[i * 3 + 1]!, positions[i * 3 + 2]!];
    const b: Vec3 = [positions[i * 3 + 3]!, positions[i * 3 + 4]!, positions[i * 3 + 5]!];
    const c: Vec3 = [positions[i * 3 + 6]!, positions[i * 3 + 7]!, positions[i * 3 + 8]!];
    v += dot(a, cross(b, c));
  }
  return v;
}

/** Distance between two points, for the two-point measure. */
export const distance = (a: Vec3, b: Vec3): number => len(sub(a, b));

// ---- remembered per part ----

const STORE = 'intentcad-section:';

export interface SavedSection { on: boolean; plane: Section }

const isVec = (v: unknown): v is Vec3 =>
  Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === 'number' && Number.isFinite(x));

export function loadSection(part: string): SavedSection | null {
  try {
    const v = JSON.parse(localStorage.getItem(STORE + part) ?? 'null') as
      { on?: unknown; plane?: { dir?: unknown; offset?: unknown; flip?: unknown } } | null;
    const p = v?.plane;
    if (!p || !isVec(p.dir) || len(p.dir) < 1e-6 || typeof p.offset !== 'number' || !Number.isFinite(p.offset)) return null;
    return { on: v!.on === true, plane: { dir: unit(p.dir), offset: p.offset, flip: p.flip === true } };
  } catch {
    return null;
  }
}

export function saveSection(part: string, s: SavedSection): void {
  try { localStorage.setItem(STORE + part, JSON.stringify(s)); } catch { /* private window: not remembered */ }
}
