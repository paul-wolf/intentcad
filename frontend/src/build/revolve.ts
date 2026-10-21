/**
 * Revolve: a sketch's closed shapes turned round an axis (backend
 * modeling/revolve.py, written by /build/add_revolve):
 *
 *   part += revolve(sketch("Knob"), axis=sketch_line("Knob", "axis-v"), angle=360)
 *
 * The axis is a straight line of the sketch (its built-in H / V axes, a
 * construction or reference line), a straight part edge, a cylinder's centre
 * line, or X / Y / Z. It must lie in the sketch plane, and the shapes must stay
 * on one side of it (touching it is fine): checked here at once for a line of
 * the sketch, by the build (its `revolves` report) for the others.
 */
import type { ExtrudeOp, PatternDir, RunResponse } from '@/api/client';
import type { Point, Sketch } from '@/types/document';
import { AXIS_H, AXIS_V, FACE_AXIS_H, FACE_AXIS_V, withAxes } from '@/utils/sketchAxes';
import { axisLines, sketchLoops, type ProfileSegment, type XY } from './faceSketch';
import { add, cross, dot, len, scale, sub, type Vec3 } from './dragHandle';
import { dirWords, wayWords } from './pattern';
import type { Amount } from './constructionPlanes';

/** A revolve's axis as the API has it: a line of the sketch by id, or X / Y /
 *  Z, a straight edge, a cylindrical face. */
export type RevolveAxis = { line: string } | PatternDir;

/** The Revolve dialog's values. */
export interface RevolveValues {
  sketch: string;
  op: ExtrudeOp;
  axis: RevolveAxis | null;
  angle: Amount;
  both: boolean;
  flip: boolean;
}

/** A revolve as the build made it (backend revolve.make's report). */
export interface RevolveReport {
  line?: number | null;
  label: string;
  /** a point on the axis, and its direction (turned the way the profile goes) */
  origin: [number, number, number];
  axis: [number, number, number];
  /** the sketch plane's normal */
  normal: [number, number, number];
  angle: number; both: boolean; flip: boolean;
  /** from the axis toward the profile, in the plane; the profile's reach from the axis */
  arm?: [number, number, number]; radius?: number;
  /** the profile's middle */
  center?: [number, number, number];
  /** it failed: why, and where the profile crosses the axis */
  error?: string;
  crossings?: [number, number, number][];
}

/** A straight line of a sketch a revolve can turn about. */
export interface AxisChoice { id: string; label: string; a: XY; b: XY }

const AXIS_ORDER = [AXIS_V, AXIS_H, FACE_AXIS_V, FACE_AXIS_H];
const AXIS_NAMES: Record<string, string> = {
  [AXIS_V]: 'V axis', [AXIS_H]: 'H axis', [FACE_AXIS_V]: 'Face V axis', [FACE_AXIS_H]: 'Face H axis',
};

/** The sketch's lines to revolve about: its V and H axes (and a face's centre
 *  lines), then its straight construction and reference lines, numbered. */
export function axisChoices(sk: Sketch): AxisChoice[] {
  const full = withAxes(sk);
  const lines = axisLines(full);
  const out: AxisChoice[] = [];
  for (const id of AXIS_ORDER) if (lines[id]) out.push({ id, label: AXIS_NAMES[id]!, a: lines[id]![0], b: lines[id]![1] });
  let nc = 0, nr = 0;
  for (const e of full.entities) {
    const l = lines[e.id];
    if (!l || AXIS_NAMES[e.id] || e.type !== 'line') continue;
    const label = e.reference && !e.construction ? `Reference line ${++nr}` : `Construction line ${++nc}`;
    out.push({ id: e.id, label, a: l[0], b: l[1] });
  }
  return out;
}

/** What a dialog calls an axis. */
export function axisLabel(axis: RevolveAxis | null, choices: AxisChoice[] = []): string {
  if (!axis) return 'no axis yet';
  if ('line' in axis) return choices.find((c) => c.id === axis.line)?.label ?? `line ${axis.line}`;
  if ('base' in axis) return `${axis.base} axis`;
  if ('face' in axis) return `axis of the ${axis.face.hint ?? 'cylinder'}`;
  return dirWords(axis).replace(/^the /, '');
}

// ── the profile against the axis ──

function circleThrough(a: XY, b: XY, c: XY): { c: XY; r: number } | null {
  const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
  if (Math.abs(d) < 1e-12) return null;
  const sa = a[0] ** 2 + a[1] ** 2, sb = b[0] ** 2 + b[1] ** 2, sc = c[0] ** 2 + c[1] ** 2;
  const x = (sa * (b[1] - c[1]) + sb * (c[1] - a[1]) + sc * (a[1] - b[1])) / d;
  const y = (sa * (c[0] - b[0]) + sb * (a[0] - c[0]) + sc * (b[0] - a[0])) / d;
  return { c: [x, y], r: Math.hypot(a[0] - x, a[1] - y) };
}

/** Points along a profile segment, end to end. */
export function segmentPoints(s: ProfileSegment, n = 32): XY[] {
  if (s.t === 'line') return [s.p[0], s.p[1]];
  if (s.t === 'circle') {
    return Array.from({ length: 2 * n + 1 }, (_, i) => {
      const t = (i / (2 * n)) * 2 * Math.PI;
      return [s.c[0] + s.r * Math.cos(t), s.c[1] + s.r * Math.sin(t)] as XY;
    });
  }
  if (s.t === 'bezier') {
    const [p0, p1, p2, p3] = s.p;
    return Array.from({ length: n + 1 }, (_, i) => {
      const t = i / n, u = 1 - t;
      const w = [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t];
      return [w[0]! * p0[0] + w[1]! * p1[0] + w[2]! * p2[0] + w[3]! * p3[0],
              w[0]! * p0[1] + w[1]! * p1[1] + w[2]! * p2[1] + w[3]! * p3[1]] as XY;
    });
  }
  const [a, m, b] = s.p;
  const c = circleThrough(a, m, b);
  if (!c) return [a, b];
  const ang = (p: XY) => Math.atan2(p[1] - c.c[1], p[0] - c.c[0]);
  const t0 = ang(a);
  // the way round from a that passes m before b
  const ccw = (x: number) => ((x - t0) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
  const tm = ccw(ang(m)), tb = ccw(ang(b));
  const sweep = tm <= tb ? tb : tb - 2 * Math.PI;
  return Array.from({ length: n + 1 }, (_, i) => {
    const t = t0 + (sweep * i) / n;
    return [c.c[0] + c.r * Math.cos(t), c.c[1] + c.r * Math.sin(t)] as XY;
  });
}

const TOUCH = 1e-5;
const normalize = (v: Vec3): Vec3 => { const l = len(v); return l > 1e-12 ? scale(v, 1 / l) : v; };

/** Where the shapes lie against the line a–b (sketch coordinates): the side
 *  they are on (1: left of a→b as drawn, -1: right, 0: across it or on it)
 *  and the points where they cross it. Touching it is fine. */
export function profileSide(loops: ProfileSegment[][], a: XY, b: XY): { side: 1 | -1 | 0; crossings: XY[]; reach: number } {
  const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy);
  if (l < 1e-12) return { side: 0, crossings: [], reach: 0 };
  const dist = (p: XY) => (dx * (p[1] - a[1]) - dy * (p[0] - a[0])) / l;
  let lo = Infinity, hi = -Infinity;
  const cross: XY[] = [], ends: XY[] = [];
  for (const loop of loops) {
    for (const seg of loop) {
      const pts = segmentPoints(seg);
      let last: [XY, number] | null = null, on: XY | null = null;
      pts.forEach((p, k) => {
        const s = dist(p);
        lo = Math.min(lo, s); hi = Math.max(hi, s);
        if (Math.abs(s) <= TOUCH) {
          on ??= p;
          if (k === 0 || k === pts.length - 1) ends.push(p);
          return;
        }
        if (last && (last[1] < 0) !== (s < 0)) {
          const f = last[1] / (last[1] - s);
          cross.push(on ?? [last[0][0] + (p[0] - last[0][0]) * f, last[0][1] + (p[1] - last[0][1]) * f]);
        }
        last = [p, s]; on = null;
      });
    }
  }
  if (!Number.isFinite(lo)) return { side: 0, crossings: [], reach: 0 };
  const across = lo < -TOUCH && hi > TOUCH;
  const pts = across && !cross.length ? ends : cross;
  const crossings: XY[] = [];
  for (const p of pts) if (crossings.every((q) => Math.hypot(p[0] - q[0], p[1] - q[1]) > 1e-3)) crossings.push(p);
  const side = across || (hi <= TOUCH && lo >= -TOUCH) ? 0 : hi > TOUCH ? 1 : -1;
  return { side, crossings, reach: Math.max(Math.abs(lo), Math.abs(hi)) };
}

/** A line of the sketch checked against its shapes: null when they stay on
 *  one side of it; else what's wrong, and where they cross it. */
export function lineProblem(sk: Sketch, line: string): { message: string; crossings: XY[] } | null {
  const c = axisChoices(sk).find((x) => x.id === line);
  if (!c) return { message: 'That line is gone from the sketch: pick another axis', crossings: [] };
  const loops = sketchLoops(sk).loops;
  if (!loops.length) return { message: 'The sketch has no closed shape to revolve', crossings: [] };
  const r = profileSide(loops, c.a, c.b);
  if (r.side !== 0) return null;
  if (!r.crossings.length) return { message: `The shapes lie along the ${c.label}: they have no width to turn`, crossings: [] };
  return {
    message: `The shapes cross the ${c.label} (marked red): a revolve would run through itself. Move them to one side `
      + '(they may touch it) or pick another axis',
    crossings: r.crossings,
  };
}

/** The axis a new revolve starts with: the sketch's V axis if the shapes lie
 *  all on one side of it, else its H axis, else none (the dialog asks). */
export function defaultAxis(sk: Sketch): RevolveAxis | null {
  for (const id of [AXIS_V, AXIS_H]) if (!lineProblem(sk, id)) return { line: id };
  return null;
}

/** The sketches a revolve can use: on a plane, with a closed shape. */
export function revolvable(sketches: Sketch[]): Sketch[] {
  return sketches.filter((s) => s.plane && sketchLoops(s).loops.length > 0);
}

// ── the report, the words, the handle ──

/** The build's report on the revolve `values` writes into `code`: the one on
 *  `line` (shifted by the lines added above it), or for a new one the last. */
export function revolveReport(r: Pick<RunResponse, 'revolves'> | null | undefined, line: number | null,
                              grown = 0): RevolveReport | null {
  const all = r?.revolves ?? [];
  if (line != null) return all.find((x) => x.line === line + grown) ?? null;
  return all[all.length - 1] ?? null;
}

/** What the dialog's summary says it makes. */
export function revolveSummary(v: RevolveValues, angle: number | null, axis: string, normal?: readonly number[] | null): string {
  const what = v.op === 'cut' ? 'Cuts' : v.op === 'join' ? 'Adds' : 'Makes the part from';
  const head = `${what} “${v.sketch}” turned`;
  if (angle === null) return `${head} about the ${axis}.`;
  if (angle >= 360 - 1e-9) return `${head} a full 360° about the ${axis}: a round shape.`;
  if (v.both) return `${head} ${+(angle / 2).toFixed(3)}° each way about the ${axis} (${+angle.toFixed(3)}° in all), `
    + 'symmetric about the sketch plane.';
  const way = normal ? wayWords(v.flip ? normal.map((x) => -x) : normal) : '';
  return `${head} ${+angle.toFixed(3)}° about the ${axis}, starting ${v.flip ? 'behind the sketch' : 'out of the side the sketch faces'}`
    + `${way ? ` (toward ${way})` : ''}.`;
}

/** The rotation handle on the preview: on the axis level with the shapes'
 *  middle, its knob out past their reach, turned to where the revolve ends
 *  (with both ways, one end: half the angle). */
export function revolveHandle(r: RevolveReport | null, angle: number | null):
  { at: Vec3; w: Vec3; n: Vec3; arm: number; value: number } | null {
  if (!r || r.error || !r.arm || !r.center || r.radius == null || angle === null) return null;
  const d = normalize(r.axis as Vec3), o = r.origin as Vec3;
  const at = add(o, scale(d, dot(sub(r.center as Vec3, o), d)));
  const w = normalize(r.arm as Vec3);
  if (len(w) < 0.5) return null;
  const n = cross(d, w);
  return { at, w, n, arm: Math.max(r.radius * 1.15, r.radius + 4), value: r.both ? angle / 2 : angle };
}

/** A dragged handle value back to the dialog's angle (at most 360). The
 *  handle keeps to (-180, 180]: past half way round it reads negative. */
export function angleFromHandle(value: number, both: boolean): number {
  const a = both ? value * 2 : value <= 0 ? value + 360 : value;
  return Math.min(360, Math.max(1, Math.round(a * 1000) / 1000));
}

/** A point in the sketch's coordinates (y down the screen) as an SVG point. */
export const svgXY = (p: Point | XY): [number, number] => ('x' in p ? [p.x, p.y] : [p[0], p[1]]);
