/**
 * Mirror (backend modeling/mirror.py): a whole body across a plane
 * (`part = mirror_body(part, PLANE, join=True)`), or chosen steps, each copied
 * once as `mirrored(...)` with a link comment (`# mirror of line 7 across Mid`)
 * that keeps the copy following its original. Pure helpers: the plane in
 * words and as drawn, which steps can be mirrored, the steps list's grouping
 * (copies under their original) and its multi-select.
 */
import type { FaceRefSpec, MirrorPlane, PlaneReport, Step } from '@/api/client';
import { faceLabel } from './faceSketch';
import { offsetPlaneShape, type BaseName, type PlaneShape } from './constructionPlanes';
import type { Vec3 } from './dragHandle';

/** The steps a copy can be made of (backend paramedit.MIRROR_OPS). */
export const MIRROR_OPS = ['extrude', 'revolve', 'holes', 'fillet', 'chamfer'] as const;

const TITLES: Record<string, string> = {
  shell: 'Shell', auto_round: 'Round', truss_windows: 'Lighten', offset_plane: 'Offset plane',
  edge_plane: 'Plane on edge', tangent_plane: 'Tangent plane', mirror_body: 'Mirror body', pattern_body: 'Pattern body',
};

/** Why a step can't be mirrored (null: it can), as the backend says it. */
export function mirrorSkip(s: Step): string | null {
  if (s.off) return 'it is switched off';
  if (s.kind !== 'op' || !s.op || s.op === 'script') return "it isn't a step the editor can mirror";
  if (!(MIRROR_OPS as readonly string[]).includes(s.op)) return `${TITLES[s.op] ?? s.op} can't be mirrored`;
  if (s.mirror_of != null) return 'it is a mirrored copy already: mirror its original';
  if (s.pattern_of != null) return 'it is a pattern copy already: mirror its original';
  return null;
}

/** The plane a flat face gives (the face's hint, for the words). */
export function facePlane(ref: FaceRefSpec, normal: readonly number[]): MirrorPlane {
  return { face: { ...ref, hint: ref.hint ?? faceLabel(normal as Vec3) } };
}

/** The plane in a few words: "the XY plane", "plane Mid", "the right face". */
export function mirrorPlaneWords(p: MirrorPlane | null): string {
  if (!p) return 'a plane';
  if ('base' in p) return `the ${p.base} plane`;
  if ('plane' in p) return `plane ${p.plane}`;
  return `the ${p.face.hint ?? 'face'}`;
}

export function sameMirrorPlane(a: MirrorPlane | null, b: MirrorPlane | null): boolean {
  if (!a || !b) return a === b;
  if ('base' in a || 'base' in b) return 'base' in a && 'base' in b && a.base === b.base;
  if ('plane' in a || 'plane' in b) return 'plane' in a && 'plane' in b && a.plane === b.plane;
  const f = a.face, g = b.face;
  return f.center.every((x, i) => Math.abs(x - g.center[i]!) < 1e-3) && f.normal.every((x, i) => Math.abs(x - g.normal[i]!) < 1e-3);
}

/** The plane drawn while a Mirror dialog is open: a base plane through the
 *  origin, the construction plane as built, or the face's own plane (where
 *  it is now: `faceNow`, else as stored). */
export function mirrorPlaneShape(p: MirrorPlane | null, planes: Record<string, PlaneReport> | undefined,
                                 faceNow?: { center: Vec3; normal: Vec3 } | null): PlaneShape | null {
  if (!p) return null;
  if ('base' in p) return { name: p.base, ...offsetPlaneShape(p.base as BaseName, 0) };
  if ('plane' in p) {
    const r = planes?.[p.plane];
    return r ? { name: p.plane, origin: r.origin as Vec3, normal: r.normal as Vec3, xAxis: r.xAxis as Vec3 } : null;
  }
  const f = faceNow ?? { center: p.face.center as Vec3, normal: p.face.normal as Vec3 };
  return { name: 'Mirror', ...offsetPlaneShape(f, 0) };
}

/** What Mirror body does, in words; `gap` (Separate): mm between the part
 *  and its copy (null: not a valid amount). */
export function mirrorBodySummary(p: MirrorPlane | null, join: boolean, gap: number | null = 0): string {
  const across = mirrorPlaneWords(p);
  if (join) {
    return `Mirrors the whole part across ${across} and fuses the mirror image with it into one solid. Model one half up to the plane, and this makes the other.`;
  }
  const apart = gap ? `, ${+gap.toFixed(3)} mm further out (the plane moved ${+(gap / 2).toFixed(3)} mm away from the part)` : '';
  return `Mirrors the whole part across ${across} and keeps the mirror image as a separate body beside it${apart}.`;
}

/** The one-line hint under Join / Separate body. */
export const mirrorBodyHint = (join: boolean): string => (join
  ? 'Model half the part, then mirror it to complete it.'
  : 'A mirrored copy as its own body, e.g. left and right versions.');

/** The mirror plane as Separate's gap moves it: gap/2 along its normal,
 *  toward the side the copy is on (`copyCenter`, the centre of the copy's
 *  box; unknown: not moved), as the backend's mirror.outward does. */
export function shiftedMirrorShape(shape: PlaneShape, gap: number, copyCenter: Vec3 | null): PlaneShape {
  if (!gap || !copyCenter) return shape;
  const n = shape.normal, o = shape.origin;
  const len = Math.hypot(n[0], n[1], n[2]) || 1;
  const side = ((copyCenter[0] - o[0]) * n[0] + (copyCenter[1] - o[1]) * n[1] + (copyCenter[2] - o[2]) * n[2]) / len;
  const k = (side >= 0 ? 1 : -1) * gap / 2 / len;
  return { ...shape, origin: [o[0] + n[0] * k, o[1] + n[1] * k, o[2] + n[2] * k] };
}

/** The script that makes Mirror body's mirror image alone, for the preview
 *  to draw in its own colour: the lines before the mirror_body() line (the
 *  one on `line`, or the last line when it was just appended) and that line
 *  as `_mirror_copy(...)`. null: no such line. */
export function mirrorCopyScript(code: string, line: number | null): string | null {
  const rows = code.split('\n');
  let i = line != null ? line - 1 : rows.length - 1;
  if (line == null) while (i >= 0 && !rows[i]!.trim()) i--;
  const row = rows[i];
  if (row == null || !/\bmirror_body\(/.test(row)) return null;
  return [...rows.slice(0, i), row.replace(/\bmirror_body\(/, '_mirror_copy('), ''].join('\n');
}

/** What Mirror steps does, in words. */
export function mirrorStepsSummary(p: MirrorPlane | null, n: number, after: number | null): string {
  if (!n) return 'None of the chosen steps can be mirrored.';
  const what = n === 1 ? 'one line' : `${n} lines`;
  return `Adds ${what}${after ? ` after line ${after}` : ''}: ${n === 1 ? 'the step' : 'each step'} again on the other side of `
    + `${mirrorPlaneWords(p)}. Change ${n === 1 ? 'the original' : 'an original'} later and its copy follows.`;
}

/** A steps-list row: the step, and how far it is indented (a linked copy
 *  sits under its original). */
export interface StepRow { step: Step; depth: 0 | 1 }

/** The line of the step a linked copy (mirrored or pattern) follows; null: none. */
export const copyOf = (s: Step): number | null => s.mirror_of ?? s.pattern_of ?? null;

/** The steps in list order, each linked copy moved up under its original. */
export function groupSteps(steps: Step[]): StepRow[] {
  const lines = new Set(steps.map((s) => s.line));
  const copies = new Map<number, Step[]>();
  const isCopy = (s: Step) => { const o = copyOf(s); return o != null && o !== s.line && lines.has(o); };
  for (const s of steps) {
    if (isCopy(s)) copies.set(copyOf(s)!, [...(copies.get(copyOf(s)!) ?? []), s]);
  }
  const out: StepRow[] = [];
  for (const s of steps) {
    if (isCopy(s)) continue;
    out.push({ step: s, depth: 0 });
    for (const c of copies.get(s.line) ?? []) out.push({ step: c, depth: 1 });
  }
  return out;
}

/** The linked copies (mirrored or pattern) of the step on `line`. */
export function copiesOf(steps: Step[], line: number): Step[] {
  return steps.filter((s) => copyOf(s) === line && s.line !== line);
}

/** The steps selection after a click on `line`: alone, Ctrl/Cmd toggles it
 *  in or out, Shift takes the run from the last one clicked (`anchor`) in
 *  list order. */
export function nextStepSelection(current: number[], order: number[], line: number, anchor: number | null,
                                  mode: 'only' | 'toggle' | 'range'): number[] {
  if (mode === 'toggle') return current.includes(line) ? current.filter((l) => l !== line) : [...current, line];
  if (mode === 'range' && anchor != null && order.includes(anchor)) {
    const a = order.indexOf(anchor), b = order.indexOf(line);
    const run = order.slice(Math.min(a, b), Math.max(a, b) + 1);
    return [...new Set([...current, ...run])];
  }
  return [line];
}
