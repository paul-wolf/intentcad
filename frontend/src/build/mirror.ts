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
export const MIRROR_OPS = ['extrude', 'holes', 'fillet', 'chamfer'] as const;

const TITLES: Record<string, string> = {
  shell: 'Shell', auto_round: 'Round', truss_windows: 'Lighten', offset_plane: 'Offset plane',
  edge_plane: 'Plane on edge', mirror_body: 'Mirror body',
};

/** Why a step can't be mirrored (null: it can), as the backend says it. */
export function mirrorSkip(s: Step): string | null {
  if (s.off) return 'it is switched off';
  if (s.kind !== 'op' || !s.op || s.op === 'script') return "it isn't a step the editor can mirror";
  if (!(MIRROR_OPS as readonly string[]).includes(s.op)) return `${TITLES[s.op] ?? s.op} can't be mirrored`;
  if (s.mirror_of != null) return 'it is a mirrored copy already: mirror its original';
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

/** What Mirror body does, in words. */
export function mirrorBodySummary(p: MirrorPlane | null, join: boolean): string {
  const across = mirrorPlaneWords(p);
  return join
    ? `Mirrors the whole part across ${across} and fuses the mirror image with it into one solid. Model one half up to the plane, and this makes the other.`
    : `Mirrors the whole part across ${across} and keeps the mirror image as a separate body beside it: left and right versions.`;
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

/** The steps in list order, each linked copy moved up under its original. */
export function groupSteps(steps: Step[]): StepRow[] {
  const lines = new Set(steps.map((s) => s.line));
  const copies = new Map<number, Step[]>();
  const isCopy = (s: Step) => s.mirror_of != null && s.mirror_of !== s.line && lines.has(s.mirror_of);
  for (const s of steps) {
    if (isCopy(s)) copies.set(s.mirror_of!, [...(copies.get(s.mirror_of!) ?? []), s]);
  }
  const out: StepRow[] = [];
  for (const s of steps) {
    if (isCopy(s)) continue;
    out.push({ step: s, depth: 0 });
    for (const c of copies.get(s.line) ?? []) out.push({ step: c, depth: 1 });
  }
  return out;
}

/** The linked copies of the step on `line`. */
export function copiesOf(steps: Step[], line: number): Step[] {
  return steps.filter((s) => s.mirror_of === line && s.line !== line);
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
