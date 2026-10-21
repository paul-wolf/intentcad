/**
 * Pattern (backend modeling/pattern.py): copies of a whole body
 * (`part = pattern_body(part, PATTERN, join=True)`) or of chosen steps, each
 * step copied once as `patterned(..., PATTERN)` with a link comment
 * (`# pattern of line 7`). PATTERN is linear(...) — along one direction, or
 * two for a grid — or circular(...) round an axis. Pure helpers: the
 * dialog's values and the API's form, the pattern in words, where each
 * instance is as the values change (the preview's boxes, numbers and
 * handles), and the skip list kept right when a count changes.
 */
import type { EdgeRefSpec, PatternDir, PatternReport, PatternSpec, RunEdge, RunFace, Step } from '@/api/client';
import { faceLabel } from './faceSketch';
import { amountOut, amountValue, type Amount } from './constructionPlanes';
import { MIRROR_OPS } from './mirror';
import { add, cross, len, scale, sub, type Vec3 } from './dragHandle';

const normalize = (a: Vec3): Vec3 => scale(a, 1 / (len(a) || 1));

/** A Pattern dialog's values. Linear: `dir`, `count` instances `spacing`
 *  apart (or fitted within `extent`), and with `two` a second direction
 *  making a grid. Circular: `count` round `axis`, spread over `angle` (360:
 *  the full circle). `symmetric`: as many again the other way. `target`:
 *  which direction a pick in the view sets. */
export interface PatternValues {
  type: 'linear' | 'circular';
  dir: PatternDir | null;
  count: Amount;
  mode: 'spacing' | 'extent';
  spacing: Amount;
  extent: Amount;
  symmetric: boolean;
  flip: boolean;
  two: boolean;
  dir2: PatternDir | null;
  count2: Amount;
  mode2: 'spacing' | 'extent';
  spacing2: Amount;
  extent2: Amount;
  flip2: boolean;
  axis: PatternDir | null;
  angle: Amount;
  skip: number[];
  target: 'dir' | 'dir2';
}

export const defaultPattern = (type: 'linear' | 'circular' = 'linear', dir: PatternDir | null = null): PatternValues => ({
  type, dir: type === 'linear' ? dir ?? { base: 'X' } : null, count: type === 'linear' ? 3 : 6, mode: 'spacing',
  spacing: 10, extent: 20, symmetric: false, flip: false, two: false, dir2: { base: 'Y' }, count2: 2, mode2: 'spacing',
  spacing2: 10, extent2: 10, flip2: false, axis: type === 'circular' ? dir : null, angle: 360, skip: [], target: 'dir',
});

/** The values as the API takes them (numbers, or expressions of P names). */
export function patternSpec(v: PatternValues): PatternSpec {
  const skip = [...new Set(v.skip)].filter((i) => i > 0).sort((a, b) => a - b);
  if (v.type === 'circular') {
    return { type: 'circular', axis: v.axis, count: amountOut(v.count), angle: amountOut(v.angle),
             symmetric: v.symmetric, flip: v.flip, skip };
  }
  const out: PatternSpec = { type: 'linear', dir: v.dir, count: amountOut(v.count), mode: v.mode,
                             symmetric: v.symmetric, flip: v.flip, skip };
  if (v.mode === 'spacing') out.spacing = amountOut(v.spacing);
  else out.extent = amountOut(v.extent);
  if (v.two) {
    Object.assign(out, { dir2: v.dir2, count2: amountOut(v.count2), mode2: v.mode2, flip2: v.flip2 });
    if (v.mode2 === 'spacing') out.spacing2 = amountOut(v.spacing2);
    else out.extent2 = amountOut(v.extent2);
  }
  return out;
}

/** A pattern read back (op_at): its values, each number written as an
 *  expression shown as one. */
export function patternValues(a: PatternSpec, exprs: Record<string, string> = {}): PatternValues {
  const pick = (k: string, fallback: Amount): Amount => {
    const e = exprs[k];
    if (e != null) return e;
    const x = (a as Record<string, unknown>)[k];
    return typeof x === 'number' || typeof x === 'string' ? x : fallback;
  };
  const v = defaultPattern(a.type);
  if (a.type === 'circular') {
    return { ...v, axis: a.axis, count: pick('count', 6), angle: pick('angle', 360), symmetric: !!a.symmetric,
             flip: !!a.flip, skip: [...(a.skip ?? [])] };
  }
  const mode = a.mode ?? (a.extent != null ? 'extent' : 'spacing');
  const mode2 = a.mode2 ?? (a.extent2 != null ? 'extent' : 'spacing');
  return {
    ...v, dir: a.dir, count: pick('count', 3), mode, spacing: pick('spacing', 10), extent: pick('extent', 20),
    symmetric: !!a.symmetric, flip: !!a.flip, two: !!a.dir2, dir2: a.dir2 ?? v.dir2, count2: pick('count2', 2), mode2,
    spacing2: pick('spacing2', 10), extent2: pick('extent2', 10), flip2: !!a.flip2, skip: [...(a.skip ?? [])],
  };
}

/** Why a step can't be patterned (null: it can), as the backend says it. */
export function patternSkip(s: Step): string | null {
  if (s.off) return 'it is switched off';
  if (s.kind !== 'op' || !s.op || s.op === 'script') return "it isn't a step the editor can pattern";
  if (!(MIRROR_OPS as readonly string[]).includes(s.op)) return `${STEP_NAMES[s.op] ?? s.op} can't be patterned`;
  if (s.mirror_of != null) return 'it is a mirrored copy already: pattern its original';
  if (s.pattern_of != null) return 'it is a pattern copy already: pattern its original';
  return null;
}
const STEP_NAMES: Record<string, string> = {
  shell: 'Shell', auto_round: 'Round', truss_windows: 'Lighten', offset_plane: 'Offset plane',
  edge_plane: 'Plane on edge', mirror_body: 'Mirror body', pattern_body: 'Pattern body',
};

/** The direction a picked face gives: a flat face's normal, a cylinder's
 *  (or cone's) axis. null: neither. */
export function dirOfFace(f: RunFace): PatternDir | null {
  if (!f.ref) return null;
  if (f.kind === 'plane') return { face: { ...f.ref, hint: f.ref.hint ?? faceLabel(f.normal) } };
  if (f.kind === 'cylinder' || f.kind === 'cone') {
    const hint = f.ref.hint ?? (f.radius ? `Ø${+(2 * f.radius).toFixed(2)} ${f.kind} face` : `${f.kind} face`);
    return { face: { ...f.ref, hint } };
  }
  return null;
}

/** The direction a picked edge gives: along a straight one, a circle's
 *  centre axis. null: neither (a spline). */
export function dirOfEdge(e: RunEdge): PatternDir | null {
  const r = e.ref;
  if (!r || (r.kind !== 'line' && r.kind !== 'circle')) return null;
  return { edge: r };
}

/** What a picked direction is, in a few words: "X", "the bottom-front edge",
 *  "the Ø10 cylinder face". */
export function dirWords(d: PatternDir | null): string {
  if (!d) return 'nothing yet';
  if ('base' in d) return d.base;
  if ('edge' in d) return `the ${edgeHint(d.edge)}`;
  return `the ${d.face.hint ?? 'face'}`;
}
const edgeHint = (e: EdgeRefSpec) => e.hint ?? (e.kind === 'circle' ? 'circular edge' : 'edge');

/** Which way a unit vector points, in words: "+X", "−Z", or "[0.71, 0.71, 0]". */
export function wayWords(v: readonly number[] | null | undefined): string {
  if (!v) return '';
  const names = ['X', 'Y', 'Z'];
  for (let i = 0; i < 3; i++) if (Math.abs(v[i]!) > 0.999) return `${v[i]! > 0 ? '+' : '−'}${names[i]}`;
  return `[${v.map((x) => +x.toFixed(2)).join(', ')}]`;
}

/** The axis a circular pattern turns round, in words, as the build placed it. */
export function axisWords(r: PatternReport | null): string {
  if (!r?.axis || !r.origin) return '';
  return `${wayWords(r.axis)} through (${r.origin.map((x) => +x.toFixed(1)).join(', ')})`;
}

const whole = (a: Amount, p: Record<string, number>): number | null => {
  const n = amountValue(a, p);
  return n === null || n < 1 || !Number.isInteger(+n.toFixed(9)) ? null : Math.round(n);
};
const isFull = (v: PatternValues, p: Record<string, number>) => {
  const a = amountValue(v.angle, p);
  return a !== null && Math.abs(Math.abs(a) - 360) < 1e-9;
};

/** The instances one direction has: count, or 2·count − 1 when symmetric. */
const along = (n: number, sym: boolean) => (sym ? 2 * n - 1 : n);

/** How many instances the pattern makes, the original among them (null:
 *  a count isn't a whole number). */
export function instanceCount(v: PatternValues, p: Record<string, number>): number | null {
  const n = whole(v.count, p);
  if (n === null) return null;
  if (v.type === 'circular') return along(n, v.symmetric && !isFull(v, p));
  if (!v.two) return along(n, v.symmetric);
  const n2 = whole(v.count2, p);
  return n2 === null ? null : along(n, v.symmetric) * along(n2, v.symmetric);
}

/** The multiples of the spacing of one direction's instances in index
 *  order (backend pattern._steps): 0 … n−1, then −1 … −(n−1). */
export function stepsOf(n: number, sym: boolean): number[] {
  const out = Array.from({ length: n }, (_, i) => i);
  if (sym) for (let k = 1; k < n; k++) out.push(-k);
  return out;
}

/** Each instance's place in the pattern: [k1, k2] — multiples of the first
 *  and second spacing (linear), or of the step angle (circular, k2 = 0). */
export function instanceSteps(v: PatternValues, p: Record<string, number>): [number, number][] | null {
  const n = whole(v.count, p);
  if (n === null) return null;
  if (v.type === 'circular') return stepsOf(n, v.symmetric && !isFull(v, p)).map((k) => [k, 0]);
  const a = stepsOf(n, v.symmetric);
  if (!v.two) return a.map((k) => [k, 0]);
  const n2 = whole(v.count2, p);
  if (n2 === null) return null;
  return stepsOf(n2, v.symmetric).flatMap((j) => a.map((i): [number, number] => [i, j]));
}

/** The skip list after the values change from `from` to `to`: each skipped
 *  instance kept where it still is (the same multiples of the spacings),
 *  dropped where it no longer is. */
export function remapSkip(skip: number[], from: PatternValues, to: PatternValues, p: Record<string, number>): number[] {
  if (!skip.length) return [];
  const a = instanceSteps(from, p), b = instanceSteps(to, p);
  if (!a || !b) return skip;
  // circular round the full circle: the angles change with the count, the indices stay
  if (to.type === 'circular' && isFull(to, p)) return skip.filter((i) => i > 0 && i < b.length);
  const at = new Map(b.map(([i, j], idx) => [`${i},${j}`, idx]));
  const out = new Set<number>();
  for (const s of skip) {
    const k = a[s];
    const idx = k ? at.get(`${k[0]},${k[1]}`) : undefined;
    if (idx) out.add(idx);
  }
  return [...out].sort((x, y) => x - y);
}

/** Skip on or off for instance `i` (the original, 0, can't be). */
export function toggleSkip(skip: number[], i: number): number[] {
  if (i <= 0) return skip;
  return skip.includes(i) ? skip.filter((x) => x !== i) : [...skip, i].sort((a, b) => a - b);
}

/** The pattern in a few words, as the backend's pattern_label: "8 × 3",
 *  "4 along X", "6 round the Ø10 cylinder face". */
export function patternWords(v: PatternValues, p: Record<string, number>): string {
  const skipped = v.skip.length ? `, ${v.skip.length} skipped` : '';
  const n = whole(v.count, p) ?? '?';
  if (v.type === 'circular') {
    const full = isFull(v, p);
    const c = typeof n === 'number' && v.symmetric && !full ? 2 * n - 1 : n;
    const a = amountValue(v.angle, p);
    const over = full ? '' : ` over ${a === null ? '?' : +a.toFixed(2)}°${v.symmetric ? ' each way' : ''}`;
    return `${c} round ${dirWords(v.axis)}${over}${skipped}`;
  }
  const c1 = typeof n === 'number' ? along(n, v.symmetric) : n;
  if (v.two) {
    const n2 = whole(v.count2, p);
    return `${c1} × ${n2 === null ? '?' : along(n2, v.symmetric)}${skipped}`;
  }
  return `${c1} along ${dirWords(v.dir)}${skipped}`;
}

/** What the pattern does, in words. `kind`: a whole body (joined or not)
 *  or `n` chosen steps, their copies going after line `after`. */
export function patternSummary(v: PatternValues, p: Record<string, number>,
                               what: { kind: 'body'; join: boolean } | { kind: 'steps'; n: number; after: number | null }
                                 | { kind: 'copy'; of: string }): string {
  const total = instanceCount(v, p);
  if (total === null) return 'Each count must be a whole number, at least 1.';
  const copies = total - 1 - v.skip.filter((i) => i < total).length;
  const made = copies === 1 ? 'one copy' : `${copies} copies`;
  let lay: string;
  if (v.type === 'circular') {
    const a = amountValue(v.angle, p);
    lay = isFull(v, p) ? `spread evenly round ${dirWords(v.axis)}`
      : `round ${dirWords(v.axis)}, ${a === null ? '?' : +a.toFixed(2)}° from first to last${v.symmetric ? ', both ways' : ''}`;
  } else {
    const s = amountValue(v.mode === 'spacing' ? v.spacing : v.extent, p);
    const gap = s === null ? '?' : `${+s.toFixed(3)} mm`;
    lay = `along ${dirWords(v.dir)}${v.flip ? ' (reversed)' : ''}, ${v.mode === 'spacing' ? `${gap} apart` : `within ${gap}`}`
      + (v.symmetric ? ', both ways' : '');
    if (v.two) {
      const s2 = amountValue(v.mode2 === 'spacing' ? v.spacing2 : v.extent2, p);
      lay += ` and ${dirWords(v.dir2)}${v.flip2 ? ' (reversed)' : ''}, ${s2 === null ? '?' : `${+s2.toFixed(3)} mm`}`
        + `${v.mode2 === 'spacing' ? ' apart' : ' in all'}`;
    }
  }
  if (what.kind === 'body') {
    return `Makes ${made} of the whole part ${lay}${what.join ? ', fused with it into one solid' : ', each a body of its own'}.`;
  }
  if (what.kind === 'copy') return `${cap(made)} of ${what.of} ${lay}.`;
  if (!what.n) return 'None of the chosen steps can be patterned.';
  const lines = what.n === 1 ? 'one line' : `${what.n} lines`;
  return `Adds ${lines}${what.after ? ` after line ${what.after}` : ''}: ${made} of ${what.n === 1 ? 'the step' : 'each step'} ${lay}. `
    + `Change ${what.n === 1 ? 'the original' : 'an original'} later and its copies follow.`;
}
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// ── where the instances are, for the preview

export interface PlacedInstance { index: number; skip: boolean; center: Vec3; corners: Vec3[] }

/** The instances of a built pattern placed as the values say now: the
 *  report's original (instance 0) moved by each instance's steps along the
 *  report's directions — so a count or spacing typed or dragged shows at
 *  once, before the build catches up. `same`: the report was built with
 *  these directions (else its instances are shown as built). */
export function placeInstances(r: PatternReport, v: PatternValues, p: Record<string, number>,
                               same: boolean): PlacedInstance[] {
  const asBuilt = () => r.instances.filter((i) => i.center && i.corners).map((i) => ({
    index: i.index, skip: v.skip.includes(i.index), center: i.center as Vec3, corners: i.corners as Vec3[],
  }));
  const o = r.instances[0];
  const ks = instanceSteps(v, p);
  if (!same || !o?.center || !o.corners || !ks || r.kind !== v.type) return asBuilt();
  const c0 = o.center as Vec3, k0 = o.corners as Vec3[];
  if (r.kind === 'linear') {
    if (!r.dir) return asBuilt();
    const n = whole(v.count, p)!, s = pitch(v.mode, v.spacing, v.extent, n, p);
    const n2 = v.two ? whole(v.count2, p) : 1;
    const s2 = v.two && n2 ? pitch(v.mode2, v.spacing2, v.extent2, n2, p) : 0;
    if (s === null || s2 === null || (v.two && !r.dir2)) return asBuilt();
    return ks.map(([i, j], index) => {
      const m = add(scale(r.dir as Vec3, i * s), v.two ? scale(r.dir2 as Vec3, j * s2) : [0, 0, 0]);
      return { index, skip: v.skip.includes(index), center: add(c0, m), corners: k0.map((c) => add(c, m)) };
    });
  }
  if (!r.axis || !r.origin) return asBuilt();
  const n = whole(v.count, p)!, a = amountValue(v.angle, p);
  if (a === null) return asBuilt();
  const step = isFull(v, p) ? 360 / n : n > 1 ? a / (n - 1) : 0;
  return ks.map(([k], index) => {
    const turn = (q: Vec3) => rotate(q, r.origin as Vec3, r.axis as Vec3, (k * step * Math.PI) / 180);
    return { index, skip: v.skip.includes(index), center: turn(c0), corners: k0.map(turn) };
  });
}

/** One direction's spacing: given, or the extent shared out (null: not a number). */
function pitch(mode: 'spacing' | 'extent', spacing: Amount, extent: Amount, n: number, p: Record<string, number>): number | null {
  const x = amountValue(mode === 'spacing' ? spacing : extent, p);
  if (x === null) return null;
  return mode === 'spacing' ? x : n > 1 ? x / (n - 1) : 0;
}

/** `q` turned by `rad` about the axis through `o` along unit `d` (Rodrigues). */
export function rotate(q: Vec3, o: Vec3, d: Vec3, rad: number): Vec3 {
  const v = sub(q, o), c = Math.cos(rad), s = Math.sin(rad);
  const dv = d[0] * v[0] + d[1] * v[1] + d[2] * v[2];
  return add(o, add(add(scale(v, c), scale(cross(d, v), s)), scale(d, dv * (1 - c))));
}

/** A box's 12 edges as segment pairs [x,y,z, x,y,z, …] (corners in the
 *  backend's order: x, then y, then z the fastest), and with `crossed`
 *  its two long diagonals (a skipped instance). */
export function boxSegments(corners: Vec3[], crossed = false): number[] {
  if (corners.length !== 8) return [];
  const out: number[] = [];
  const seg = (a: number, b: number) => out.push(...corners[a]!, ...corners[b]!);
  for (const [a, b] of [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]]) seg(a!, b!);
  if (crossed) { seg(0, 7); seg(3, 4); }
  return out;
}

/** The handles a linear pattern's preview offers, on its first instances'
 *  layout: `pitch` on the last copy along the first direction (dragging it
 *  changes the spacing, or the extent), `count` one spacing past it
 *  (dragging adds or removes copies). Circular: `angle` (not round the full
 *  circle), turning about the axis. Each: where it sits from, the motion
 *  per unit of its value, its value now. */
export type PatternHandle =
  | { name: 'spacing' | 'extent' | 'count'; at: Vec3; shift: Vec3; value: number; step?: number; min?: number }
  | { name: 'angle'; at: Vec3; shift: Vec3; value: number; turn: { w: Vec3; n: Vec3 } };

export function patternHandles(r: PatternReport | null, v: PatternValues, p: Record<string, number>): PatternHandle[] {
  const o = r?.instances[0]?.center as Vec3 | undefined;
  const n = whole(v.count, p);
  if (!r || !o || n === null || r.kind !== v.type) return [];
  if (r.kind === 'linear') {
    if (!r.dir) return [];
    const d = r.dir as Vec3;
    const s = pitch(v.mode, v.spacing, v.extent, n, p);
    if (s === null) return [];
    const out: PatternHandle[] = [];
    if (n > 1) {
      out.push(v.mode === 'spacing'
        ? { name: 'spacing', at: o, shift: scale(d, n - 1), value: s, min: 0.5 }
        : { name: 'extent', at: o, shift: d, value: s * (n - 1), min: 0.5 });
    }
    const unit = s > 1e-6 ? s : 10;   // one copy, or no spacing yet: a count handle 10 mm a copy
    out.push({ name: 'count', at: o, shift: scale(d, unit), value: n, step: 1, min: 1 });
    return out;
  }
  if (!r.axis || !r.origin || v.type !== 'circular' || isFull(v, p)) return [];
  const a = amountValue(v.angle, p);
  const ax = normalize(r.axis as Vec3);
  // from the axis, square to it, out to the original
  const rel = sub(o, r.origin as Vec3);
  const foot = add(r.origin as Vec3, scale(ax, rel[0] * ax[0] + rel[1] * ax[1] + rel[2] * ax[2]));
  const out = sub(o, foot);
  if (a === null || len(out) < 1e-6) return [];
  const w = normalize(out), nn = cross(ax, w);
  return [{ name: 'angle', at: foot, shift: nn, value: a, turn: { w, n: nn } }];
}

/** The report's entries the pattern being edited made: those on `lines`. */
export function reportsOn(all: PatternReport[] | undefined, lines: number[]): PatternReport[] {
  return (all ?? []).filter((r) => r.line != null && lines.includes(r.line));
}

/** Where each instance's number sits: the middle of its centres over all
 *  the entries (one per patterned step). */
export function chipPoints(placed: PlacedInstance[][]): { index: number; skip: boolean; point: Vec3 }[] {
  const by = new Map<number, { sum: Vec3; n: number; skip: boolean }>();
  for (const list of placed) {
    for (const i of list) {
      const b = by.get(i.index) ?? { sum: [0, 0, 0] as Vec3, n: 0, skip: i.skip };
      by.set(i.index, { sum: add(b.sum, i.center), n: b.n + 1, skip: i.skip });
    }
  }
  return [...by].sort((a, b) => a[0] - b[0]).map(([index, b]) => ({ index, skip: b.skip, point: scale(b.sum, 1 / b.n) }));
}

/** The script line(s) the candidate's pattern is on, from the code before
 *  (`before`) and after: a pattern_body() line rewritten or appended (the
 *  last one), shifted by the lines P grew by. */
export function patternBodyLine(after: string, line: number | null, before: string): number | null {
  if (line != null) return line + after.split('\n').length - before.split('\n').length;
  const rows = after.split('\n');
  for (let i = rows.length - 1; i >= 0; i--) if (/\bpattern_body\(/.test(rows[i]!)) return i + 1;
  return null;
}
