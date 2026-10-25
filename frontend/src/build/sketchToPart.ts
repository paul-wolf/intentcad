/**
 * A project sketch made into parts: Extrude… / Cut… / Revolve… in the sketch
 * editor runs the same operation on each part picked (or a new part), one
 * part after another. The sketch editor hands the waiting operation to the
 * part editor through sessionStorage (ids only); the part editor adds the
 * SK alias if the part doesn't have it, opens its Extrude or Revolve dialog on
 * the shared sketch, and moves on to the next part when it is applied.
 *
 * In the dialogs a shared sketch is its source text, where a face sketch has
 * its name (backend paramedit.is_shared_src):
 *     SK["frame"]   SK["frame"].group("arm holes")   SK["frame"].named("outline")
 * each maybe placed elsewhere: ….on(PLANES["Mid"]) / .on(face_ref({...})).
 */
import type { FaceRefSpec } from '@/api/client';
import type { Sketch, SketchRef } from '@/types/document';
import type { Plane } from '@/types/geometry';
import { XY_PLANE } from './sharedSketch';

export type SkPick = { kind: 'group' | 'named'; name: string } | null;
export type BasePlane = 'XY' | 'XZ' | 'YZ';
/** Where the shapes go: the sketch's own plane (null), a base plane, a
 *  construction plane, or a flat face of the part. */
export type SkPlacement = null | { base: BasePlane } | { plane: string } | { face: FaceRefSpec };

/** build123d's Plane.XY / XZ / YZ */
export const BASE_PLANES: Record<BasePlane, Plane> = {
  XY: { origin: [0, 0, 0], normal: [0, 0, 1], xAxis: [1, 0, 0] },
  XZ: { origin: [0, 0, 0], normal: [0, -1, 0], xAxis: [1, 0, 0] },
  YZ: { origin: [0, 0, 0], normal: [1, 0, 0], xAxis: [0, 1, 0] },
};

export interface SkSource { alias: string; pick: SkPick; on: SkPlacement }

const q = (s: string) => JSON.stringify(s);

/** A face ref as the backend writes it (paramedit._lit): "keys", 25 not 25.0. */
function lit(v: unknown): string {
  if (v === null || v === undefined) return 'None';
  if (typeof v === 'boolean') return v ? 'True' : 'False';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(Math.round(v * 1e6) / 1e6);
  if (typeof v === 'string') return q(v);
  if (Array.isArray(v)) return `[${v.map(lit).join(', ')}]`;
  return `{${Object.entries(v as Record<string, unknown>).map(([k, x]) => `${q(k)}: ${lit(x)}`).join(', ')}}`;
}

export const isSkSource = (s: string | null | undefined): boolean => !!s && s.startsWith('SK[');

export function skSource(s: SkSource): string {
  let out = `SK[${q(s.alias)}]`;
  if (s.pick) out += `.${s.pick.kind}(${q(s.pick.name)})`;
  if (s.on && 'base' in s.on) out += `.on(Plane.${s.on.base})`;
  else if (s.on && 'plane' in s.on) out += `.on(PLANES[${q(s.on.plane)}])`;
  else if (s.on) out += `.on(face_ref(${lit(s.on.face)}))`;
  return out;
}

const STR = String.raw`"((?:[^"\\]|\\.)*)"`;
const SOURCE = new RegExp(String.raw`^SK\[${STR}\](?:\.(group|named)\(${STR}\))?(?:\.on\((.+)\))?$`);

/** A source written by skSource back into its parts (null: not one). A face
 *  placement is read back from the ref's JSON-like literal. */
export function parseSkSource(src: string): SkSource | null {
  const m = SOURCE.exec(src.trim());
  if (!m) return null;
  const alias = JSON.parse(`"${m[1]}"`) as string;
  const pick: SkPick = m[2] ? { kind: m[2] as 'group' | 'named', name: JSON.parse(`"${m[3]}"`) as string } : null;
  let on: SkPlacement = null;
  if (m[4]) {
    const plane = new RegExp(String.raw`^PLANES\[${STR}\]$`).exec(m[4]);
    const face = /^face_ref\((\{.*\})\)$/.exec(m[4]);
    const base = /^Plane\.(XY|XZ|YZ)$/.exec(m[4]);
    if (base) on = { base: base[1] as BasePlane };
    else if (plane) on = { plane: JSON.parse(`"${plane[1]}"`) as string };
    else if (face) {
      try {
        on = { face: JSON.parse(face[1]!.replace(/\bTrue\b/g, 'true').replace(/\bFalse\b/g, 'false').replace(/\bNone\b/g, 'null')) };
      } catch { return null; }
    } else return null;
  }
  return { alias, pick, on };
}

/** The source with another placement. */
export const placed = (src: string, on: SkPlacement): string => {
  const s = parseSkSource(src);
  return s ? skSource({ ...s, on }) : src;
};

/** A source in a few words: "frame_holes · arm holes", "frame_holes" (whole sketch). */
export function skWords(src: string): string {
  const s = parseSkSource(src);
  if (!s) return src;
  return s.pick ? `${s.alias} · ${s.pick.name}` : s.alias;
}

/** A sketch as the dialogs say it: a face sketch's name, a shared one's words. */
export const sketchWords = (s: string): string => (isSkSource(s) ? skWords(s) : s);

/** An alias from a sketch's name: "Frame holes" → "frame_holes". */
/** A new part's name to start with: the sketch's name and "part", so the two
 *  don't share one name ("Frame" makes "Frame part"). */
export const partNameFor = (sketchName: string): string => {
  const n = sketchName.trim();
  return !n ? 'New part' : /\bpart$/i.test(n) ? n : `${n} part`;
};

export const aliasFor = (name: string): string => {
  const a = name.trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
  return /^[a-z_]/.test(a) ? a : `s_${a}`.slice(0, 40);
};

/** The alias a part reads this sketch by: the one it already has for it, else
 *  `wanted` (numbered when the part uses that name for another sketch). */
export function aliasIn(refs: Record<string, SketchRef>, ref: SketchRef, wanted: string): { alias: string; added: boolean } {
  const have = Object.entries(refs).find(([, r]) => r.document === ref.document && r.sketch === ref.sketch);
  if (have) return { alias: have[0], added: false };
  let alias = wanted, n = 2;
  while (alias in refs) alias = `${wanted}_${n++}`;
  return { alias, added: true };
}

/** On its own plane or a plane, a shared sketch is datum (a through cut goes
 *  both ways); on a face it isn't (a cut goes into the part): paramedit._shared_datum. */
export const skDatum = (src: string): boolean => {
  const on = parseSkSource(src)?.on;
  return !(on && 'face' in on);
};

/** The shared sketch as the dialogs see a sketch: named by its source, only
 *  the picked elements, on the plane it is placed on (`plane`: a face's,
 *  worked out by the caller; a construction plane goes by planeRef). */
export function sharedAsSketch(sketch: Sketch, src: string, plane?: Plane | null): Sketch {
  const s = parseSkSource(src);
  const group = s?.pick?.kind === 'group' ? sketch.groups?.find((g) => g.name === s.pick!.name)?.ids : undefined;
  const named = s?.pick?.kind === 'named' ? sketch.entities.find((e) => e.name?.trim() === s.pick!.name)?.id : undefined;
  const keep = group ? new Set(group) : named ? new Set([named]) : null;
  const on = s?.on;
  const { face: _face, planeRef: _ref, ...rest } = sketch;
  return {
    ...rest,
    name: src,
    entities: keep ? sketch.entities.filter((e) => keep.has(e.id)) : sketch.entities,
    plane: (on && 'face' in on && plane) || (on && 'base' in on && BASE_PLANES[on.base]) || sketch.plane || XY_PLANE,
    ...(on && 'plane' in on ? { planeRef: on.plane } : {}),
  };
}

/** The shapes to use from a sketch, from what is selected in it: the group
 *  that is exactly the selection, else the named element selected alone,
 *  else the whole sketch. */
export function pickFor(sketch: Sketch, selected: string[]): SkPick {
  if (!selected.length) return null;
  const sel = new Set(selected);
  const g = (sketch.groups ?? []).find((x) => x.ids.length === sel.size && x.ids.every((id) => sel.has(id)));
  if (g) return { kind: 'group', name: g.name };
  if (selected.length === 1) {
    const name = sketch.entities.find((e) => e.id === selected[0])?.name?.trim();
    if (name) return { kind: 'named', name };
  }
  return null;
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A face sketch saved to the project: the script reads it as SK["alias"]
 *  where it read sketch("name") (and its lines and points likewise). */
export function toShared(code: string, name: string, alias: string): string {
  const n = String.raw`(["'])${esc(name)}\1`;
  const sk = `SK[${q(alias)}]`;
  return code
    .replace(new RegExp(String.raw`\bsketch_line\(\s*${n}\s*,\s*`, 'g'), `${sk}.line(`)
    .replace(new RegExp(String.raw`\bsketch_points\(\s*${n}\s*\)`, 'g'), `${sk}.points`)
    .replace(new RegExp(String.raw`\bsketch\(\s*${n}\s*\)`, 'g'), sk);
}

// ---------------------------------------------------------------- the handoff

export type HandoffOp = 'extrude' | 'cut' | 'revolve';

export interface Handoff {
  op: HandoffOp;
  /** the sketch document, the sketch in it, their names */
  sketchDoc: string; sketchId: string; sketchName: string;
  alias: string;
  pick: SkPick;
  /** the parts, in order (a new part already made) */
  parts: { id: string; name: string; isNew?: boolean }[];
  /** the part being worked on */
  at: number;
  done: string[];
  skipped: string[];
}

const KEY = 'intent.sketchToPart';

export function readHandoff(): Handoff | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    const h = raw ? (JSON.parse(raw) as Handoff) : null;
    return h && Array.isArray(h.parts) && typeof h.at === 'number' ? h : null;
  } catch { return null; }
}

export function saveHandoff(h: Handoff | null) {
  try {
    if (h) sessionStorage.setItem(KEY, JSON.stringify(h));
    else sessionStorage.removeItem(KEY);
  } catch { /* storage blocked: the operation stops here */ }
}

/** The handoff after this part: applied (done) or skipped. */
export function advance(h: Handoff, how: 'done' | 'skipped'): Handoff {
  const id = h.parts[h.at]?.id;
  return {
    ...h, at: h.at + 1,
    done: how === 'done' && id ? [...h.done, id] : h.done,
    skipped: how === 'skipped' && id ? [...h.skipped, id] : h.skipped,
  };
}

export const OP_WORDS: Record<HandoffOp, { verb: string; button: string }> = {
  extrude: { verb: 'Extrude', button: 'Extrude…' },
  cut: { verb: 'Cut', button: 'Cut…' },
  revolve: { verb: 'Revolve', button: 'Revolve…' },
};
