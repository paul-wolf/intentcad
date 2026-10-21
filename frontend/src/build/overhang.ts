/**
 * The overhang highlight: shades the faces that would print as overhangs, so
 * print problems show before slicing. View-only: the script never changes.
 * The pure maths is here; the viewer's shader does the same per fragment.
 *
 * "down" is the way into the bed: -Z by default, or the outward normal of the
 * face chosen as the print bed. A face's overhang angle is asin(n · down): a
 * vertical wall is 0°, a flat ceiling 90°, an up-facing face has none. Past
 * the threshold it is an overhang: steep below CEILING_DEG, a ceiling (bridge)
 * from there. Faces lying on the bed are never overhangs.
 */
import { cross, dot, len, sub, type Vec3 } from './dragHandle';
import { faceLabel } from './faceSketch';
import type { FaceRefSpec, RunFace } from '@/api/client';

export const CEILING_DEG = 80;
export const THRESHOLD_MIN = 30;
export const THRESHOLD_MAX = 70;
export const THRESHOLD_STEP = 5;
export const THRESHOLD_DEFAULT = 45;
export const DEFAULT_DOWN: Vec3 = [0, 0, -1];
/** A face this square-on to down (cos ≈ 1.8°) and at the bed level rests on the bed. */
export const BED_COS = 0.9995;
/** How far (mm) above the lowest point still counts as on the bed. */
export const BED_TOL = 0.01;

export type OverhangKind = 'steep' | 'ceiling';

const DEG = 180 / Math.PI;
const unit = (v: readonly number[]): Vec3 => {
  const l = Math.hypot(v[0]!, v[1]!, v[2]!) || 1;
  return [v[0]! / l, v[1]! / l, v[2]! / l];
};

/** The overhang angle (degrees) of a face with outward normal n, or null when it faces up. */
export function overhangAngle(n: readonly number[], down: readonly number[] = DEFAULT_DOWN): number | null {
  const s = dot(unit(n), unit(down));
  if (s < -1e-9) return null;
  return Math.asin(Math.min(1, Math.max(0, s))) * DEG;
}

/** steep, ceiling, or null (not an overhang at this threshold). */
export function overhangKind(alpha: number | null, threshold = THRESHOLD_DEFAULT): OverhangKind | null {
  if (alpha == null || alpha <= threshold + 1e-9) return null;
  return alpha >= CEILING_DEG - 1e-9 ? 'ceiling' : 'steep';
}

/** How strongly to shade: 0 just past the threshold, 1 at a flat ceiling. */
export function overhangIntensity(alpha: number, threshold = THRESHOLD_DEFAULT): number {
  return Math.min(1, Math.max(0, (alpha - threshold) / (90 - threshold)));
}

export function clampThreshold(t: number): number {
  if (!Number.isFinite(t)) return THRESHOLD_DEFAULT;
  const s = Math.round(t / THRESHOLD_STEP) * THRESHOLD_STEP;
  return Math.min(THRESHOLD_MAX, Math.max(THRESHOLD_MIN, s));
}

/** The bed's level along down: the part's lowest point, as max dot(p, down). */
export function bedLevel(positions: ArrayLike<number>, down: readonly number[] = DEFAULT_DOWN): number {
  const d = unit(down);
  let m = -Infinity;
  for (let i = 0; i + 2 < positions.length; i += 3) {
    m = Math.max(m, positions[i]! * d[0] + positions[i + 1]! * d[1] + positions[i + 2]! * d[2]);
  }
  return m;
}

/** A face lying on the bed: facing straight down and at the bed level. */
export function onBed(n: readonly number[], points: readonly Vec3[], down: readonly number[], level: number): boolean {
  const d = unit(down);
  if (dot(unit(n), d) < BED_COS) return false;
  return points.every((p) => dot(p, d) >= level - BED_TOL);
}

/** One connected patch of overhanging triangles. */
export interface OverhangRegion {
  kind: OverhangKind;            // the worst kind in it
  /** area projected onto the bed (mm²): what the slicer has to hold up */
  area: number;
  steepArea: number; ceilingArea: number;
  minAngle: number; maxAngle: number;
  center: Vec3;                  // area-weighted
  /** the build's face indices (RunFace.index) in it */
  faces: number[];
}

export interface OverhangSummary {
  threshold: number; down: Vec3;
  steepArea: number; ceilingArea: number;
  regions: OverhangRegion[];     // largest first
  /** every face with an overhanging triangle (RunFace.index) */
  faces: number[];
}

export interface SummaryMesh { positions: ArrayLike<number> }

/**
 * The overhangs of a triangle soup (each triangle's normal from its winding,
 * outward unless its vertex range is in `inverted`), joined into regions
 * through shared edges.
 */
export function overhangSummary(
  mesh: SummaryMesh, faces: readonly Pick<RunFace, 'index' | 'start' | 'count'>[],
  opts: { down?: readonly number[]; threshold?: number; inverted?: readonly [number, number][] } = {},
): OverhangSummary {
  const down = unit(opts.down ?? DEFAULT_DOWN);
  const threshold = opts.threshold ?? THRESHOLD_DEFAULT;
  const pos = mesh.positions;
  const tris = Math.floor(pos.length / 9);
  const level = bedLevel(pos, down);
  const at = (v: number): Vec3 => [pos[v * 3]!, pos[v * 3 + 1]!, pos[v * 3 + 2]!];
  const flipped = (v: number) => (opts.inverted ?? []).some(([s, c]) => v >= s && v < s + c);
  const faceOf = new Int32Array(tris).fill(-1);
  for (const f of faces) for (let v = f.start; v < f.start + f.count; v += 3) faceOf[Math.floor(v / 3)] = f.index;

  type Tri = { t: number; kind: OverhangKind; alpha: number; proj: number; c: Vec3 };
  const hit: Tri[] = [];
  for (let t = 0; t < tris; t++) {
    const a = at(t * 3), b = at(t * 3 + 1), c = at(t * 3 + 2);
    let n = cross(sub(b, a), sub(c, a));
    const area2 = len(n);
    if (area2 < 1e-12) continue;
    if (flipped(t * 3)) n = [-n[0], -n[1], -n[2]];
    const alpha = overhangAngle(n, down);
    const kind = overhangKind(alpha, threshold);
    if (!kind || onBed(n, [a, b, c], down, level)) continue;
    const proj = (area2 / 2) * (dot(n, down) / area2);
    hit.push({ t, kind, alpha: alpha!, proj, c: [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3] });
  }

  // regions: triangles that share an edge (vertices matched to 1e-4 mm)
  const parent = hit.map((_, i) => i);
  const root = (i: number): number => { while (parent[i] !== i) i = parent[i] = parent[parent[i]!]!; return i; };
  const key = (p: Vec3) => p.map((x) => Math.round(x * 1e4)).join(',');
  const byEdge = new Map<string, number>();
  hit.forEach((h, i) => {
    const k = [0, 1, 2].map((j) => key(at(h.t * 3 + j)));
    for (const [x, y] of [[k[0]!, k[1]!], [k[1]!, k[2]!], [k[2]!, k[0]!]] as const) {
      const e = x < y ? `${x}|${y}` : `${y}|${x}`;
      const o = byEdge.get(e);
      if (o == null) byEdge.set(e, i); else parent[root(i)] = root(o);
    }
  });

  const groups = new Map<number, Tri[]>();
  hit.forEach((h, i) => { const r = root(i); (groups.get(r) ?? groups.set(r, []).get(r)!).push(h); });
  const regions = [...groups.values()].map((g): OverhangRegion => {
    let steepArea = 0, ceilingArea = 0, minAngle = 90, maxAngle = 0;
    const c: Vec3 = [0, 0, 0];
    const fs = new Set<number>();
    for (const h of g) {
      if (h.kind === 'ceiling') ceilingArea += h.proj; else steepArea += h.proj;
      minAngle = Math.min(minAngle, h.alpha); maxAngle = Math.max(maxAngle, h.alpha);
      for (let j = 0; j < 3; j++) c[j]! += h.c[j]! * h.proj;
      if (faceOf[h.t]! >= 0) fs.add(faceOf[h.t]!);
    }
    const area = steepArea + ceilingArea;
    return {
      kind: ceilingArea > 0 ? 'ceiling' : 'steep', area, steepArea, ceilingArea, minAngle, maxAngle,
      center: area > 0 ? [c[0] / area, c[1] / area, c[2] / area] : g[0]!.c,
      faces: [...fs].sort((x, y) => x - y),
    };
  }).sort((x, y) => y.area - x.area);

  return {
    threshold, down,
    steepArea: regions.reduce((s, r) => s + r.steepArea, 0),
    ceilingArea: regions.reduce((s, r) => s + r.ceilingArea, 0),
    regions,
    faces: [...new Set(regions.flatMap((r) => r.faces))].sort((x, y) => x - y),
  };
}

const r1 = (x: number) => Math.round(x * 10) / 10;
const pt = (p: readonly number[]) => `(${p.map((x) => r1(x) + 0).join(', ')})`;
const deg = (a: number) => `${Math.round(a)}°`;

/** What the hover says over a highlighted area: "62° overhang", "88° ceiling". */
export function overhangHoverText(alpha: number, kind: OverhangKind): string {
  return kind === 'ceiling' ? `${deg(alpha)} ceiling` : `${deg(alpha)} overhang`;
}

/** The print bed in words: "Z (the part's lowest face)" or "the front face (toward −Y)". */
export function bedWords(bed: FaceRefSpec | null | undefined): string {
  if (!bed) return 'Z (the part’s lowest side)';
  const name = bed.hint && bed.hint !== 'face' ? bed.hint : faceLabel(bed.normal);
  return `the ${name} at ${pt(bed.center)}`;
}

/** A region named for a message: its faces, angles and area. */
export function regionWords(r: OverhangRegion, faces: readonly RunFace[]): string {
  const byIndex = new Map(faces.map((f) => [f.index, f]));
  const names = r.faces.map((i) => byIndex.get(i)).filter(Boolean).slice(0, 3).map((f) => {
    const what = f!.kind === 'plane' ? 'flat' : f!.kind === 'cylinder' && f!.radius ? `cylinder r${r1(f!.radius)}` : f!.kind;
    return `${what} face at ${pt(f!.center)}`;
  });
  const more = r.faces.length > 3 ? ` and ${r.faces.length - 3} more` : '';
  const angles = Math.round(r.minAngle) === Math.round(r.maxAngle) ? deg(r.maxAngle) : `${deg(r.minAngle)}–${deg(r.maxAngle)}`;
  const kind = r.kind === 'ceiling' ? (r.steepArea > 0 ? 'overhang into a ceiling' : 'ceiling / bridge') : 'steep overhang';
  return `${kind} around ${pt(r.center)}, ${angles}, ${r1(r.area)} mm²` + (names.length ? ` (${names.join('; ')}${more})` : '');
}

/** The instruction "Ask AI to fix" puts in the chat box. */
export function overhangInstruction(s: OverhangSummary, faces: readonly RunFace[], bed: FaceRefSpec | null | undefined): string {
  // one line: the chat box is a single-line input
  const shown = s.regions.slice(0, 8);
  const list = shown.map((r, i) => `${i + 1}. ${regionWords(r, faces)}${i < shown.length - 1 ? ';' : '.'}`);
  const more = s.regions.length > 8 ? [`…and ${s.regions.length - 8} smaller regions.`] : [];
  return [
    `This part prints with ${bedWords(bed)} on the bed. Past ${s.threshold}° these regions would print as overhangs `
      + `(${s.regions.length} region${s.regions.length === 1 ? '' : 's'}, ${r1(s.steepArea)} mm² steep, ${r1(s.ceilingArea)} mm² ceiling):`,
    ...list, ...more,
    'Please change the script so it prints without supports, keeping its function and sizes: for example chamfers instead '
      + 'of fillets on bottom edges, teardrop shapes for horizontal holes, and a 45° taper under overhanging ledges.',
  ].join(' ');
}

/** The highlight's state, per user: on/off and the threshold. */
export interface OverhangState { on: boolean; threshold: number }

const STORE = 'intentcad-overhangs';

export function loadOverhangs(user = ''): OverhangState {
  try {
    const v = JSON.parse(localStorage.getItem(STORE + (user ? `-${user}` : '')) ?? 'null') as
      { on?: unknown; threshold?: unknown } | null;
    return { on: v?.on === true, threshold: clampThreshold(typeof v?.threshold === 'number' ? v.threshold : THRESHOLD_DEFAULT) };
  } catch {
    return { on: false, threshold: THRESHOLD_DEFAULT };
  }
}

export function saveOverhangs(s: OverhangState, user = ''): void {
  try { localStorage.setItem(STORE + (user ? `-${user}` : ''), JSON.stringify(s)); } catch { /* private window: not remembered */ }
}

/** A direction in words: "+Z", "−X", or its components when it isn't on an axis. */
export function dirWords(n: readonly number[]): string {
  const u = unit(n);
  for (let i = 0; i < 3; i++) if (Math.abs(u[i]!) > 0.999) return `${u[i]! > 0 ? '+' : '−'}${'XYZ'[i]}`;
  return `(${u.map((x) => (Math.round(x * 100) / 100 + 0).toString().replace('-', '−')).join(', ')})`;
}
