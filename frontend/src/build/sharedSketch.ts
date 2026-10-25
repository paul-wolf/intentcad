/**
 * A sketch document's sketches, as parts read them through SK["alias"]
 * (backend modeling/shared_sketch.py): each sketch's closed shapes, its
 * elements one by one (points, circles, lines, with their ids), the names
 * given to elements and the groups made with Group…, and the closed shapes
 * of each group and named element.
 *
 * Saved on each sketch as `profile` whenever a sketch document saves; the
 * server hashes it as the sketch's version, so any change parts could see
 * (shapes, plane, a renamed group) marks the parts that use it out of date.
 */
import type { BuildInputs, Entity, Sketch } from '@/types/document';
import type { Plane } from '@/types/geometry';
import { axisLines, sketchLoops, type ProfileSegment, type SketchProfile, type XY } from './faceSketch';

/** A sketch with no plane of its own lies on XY of the project frame. */
export const XY_PLANE: Plane = { origin: [0, 0, 0], normal: [0, 0, 1], xAxis: [1, 0, 0] };

export interface SharedItems {
  points: { id: string; p: XY }[];
  circles: { id: string; c: XY; r: number }[];
  lines: { id: string; p: [XY, XY] }[];
}

export interface SharedProfile extends SketchProfile {
  items: SharedItems;
  names: Record<string, string>;
  groups: Record<string, string[]>;
  sub: Record<string, ProfileSegment[][]>;
}

const xy = (p: { x: number; y: number }): XY => [Math.round(p.x * 1e6) / 1e6, Math.round(p.y * 1e6) / 1e6];

const isConstruction = (e: Entity) => 'construction' in e && !!e.construction;

/** Its real elements, one by one: points, circles, and the straight pieces
 *  of its lines and rectangles (a polyline's segments share its id). */
function sketchItems(sketch: Sketch): SharedItems {
  const items: SharedItems = { points: [], circles: [], lines: [] };
  for (const e of sketch.entities) {
    if (isConstruction(e)) continue;
    if (e.type === 'point') items.points.push({ id: e.id, p: xy(e.position) });
    else if (e.type === 'circle' && e.radius > 0) items.circles.push({ id: e.id, c: xy(e.center), r: e.radius });
    else if (e.type === 'line') {
      const n = e.closed ? e.points.length : e.points.length - 1;
      for (let i = 0; i < n; i++) {
        if (e.bulge?.[i]) continue;   // an arc, not a straight line
        const a = e.points[i]!, b = e.points[(i + 1) % e.points.length]!;
        if (Math.hypot(a.x - b.x, a.y - b.y) > 1e-9) items.lines.push({ id: e.id, p: [xy(a), xy(b)] });
      }
    }
  }
  return items;
}

/** The names given to elements: {name: id} (the first element keeps a name
 *  used twice). */
export function sketchNames(sketch: Sketch): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of sketch.entities) {
    const name = e.name?.trim();
    if (name && !(name in out)) out[name] = e.id;
  }
  return out;
}

/** The sketch's groups: {name: [ids]}, leaving out ids no longer in it. */
export function sketchGroups(sketch: Sketch): Record<string, string[]> {
  const ids = new Set(sketch.entities.map((e) => e.id));
  const out: Record<string, string[]> = {};
  for (const g of sketch.groups ?? []) {
    const name = g.name.trim();
    if (name && !(name in out)) out[name] = g.ids.filter((id) => ids.has(id));
  }
  return out;
}

const subLoops = (sketch: Sketch, ids: string[]) => {
  const keep = new Set(ids);
  return sketchLoops({ ...sketch, entities: sketch.entities.filter((e) => keep.has(e.id)) }).loops;
};

/** The profile a sketch document saves for one sketch. */
export function sharedProfile(sketch: Sketch): SharedProfile {
  const points = sketch.entities.flatMap((e) => (e.type === 'point' ? [xy(e.position)] : []));
  const lines = axisLines(sketch);
  const names = sketchNames(sketch);
  const groups = sketchGroups(sketch);
  const sub: Record<string, ProfileSegment[][]> = {};
  for (const [g, ids] of Object.entries(groups)) sub[`g:${g}`] = subLoops(sketch, ids);
  for (const [n, id] of Object.entries(names)) sub[`n:${n}`] = subLoops(sketch, [id]);
  return {
    plane: sketch.plane ?? XY_PLANE,
    loops: sketchLoops(sketch).loops,
    ...(points.length ? { points } : {}),
    ...(Object.keys(lines).length ? { lines } : {}),
    items: sketchItems(sketch),
    names, groups, sub,
  };
}

/** The document's sketches, each with its shared profile, for saving. */
export function withSharedProfiles(sketches: Sketch[]): Sketch[] {
  return sketches.map((s) => ({ ...s, profile: sharedProfile(s) }));
}

/** The groups and names a part asks for that this sketch no longer has. */
export function missingUses(sketch: Sketch, uses: { groups: string[]; names: string[] }): string[] {
  const names = sketchNames(sketch), groups = sketchGroups(sketch);
  return [
    ...uses.groups.filter((g) => !(g in groups)).map((g) => `group "${g}"`),
    ...uses.names.filter((n) => !(n in names)).map((n) => `element "${n}"`),
  ];
}

const SK_RE = /SK\[\s*(["'])(.+?)\1\s*\]/g;
const PP_RE = /PP(?:\[\s*|\.get\(\s*)(["'])(.+?)\1/;

/** The SK aliases a script reads (backend engine.sk_aliases). */
export const skAliases = (code: string): string[] => [...new Set([...code.matchAll(SK_RE)].map((m) => m[2]!))];

/** Whether a script reads shared sketches or project parameters (its build
 *  then depends on more than the part: backend engine.uses_shared). */
export const usesShared = (code: string): boolean => skAliases(code).length > 0 || PP_RE.test(code);

/** What a pinned part builds with that's older than the latest, in words:
 *  ['"frame"', 'PP "arm_pitch"'] (the sketches by their SK alias). */
export function pinnedChanges(pinned: BuildInputs, latest: BuildInputs): string[] {
  const out: string[] = [];
  for (const [a, v] of Object.entries(pinned.sk ?? {})) {
    if (latest.sk?.[a] && latest.sk[a]!.version !== v.version) out.push(`"${a}"`);
  }
  for (const [n, v] of Object.entries(pinned.pp ?? {})) {
    if (latest.pp && n in latest.pp && latest.pp[n] !== v) out.push(`PP "${n}"`);
  }
  return out;
}
