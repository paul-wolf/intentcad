/**
 * Regions of a sketch for the Extrude dialogs: the closed shapes split the
 * sketch into regions (/build/sketch_regions), and a step picks some of
 * them by a point inside each one (null: the default ones — shapes that
 * cross add up, a shape fully inside another is a hole in it).
 */
import type { XY } from './faceSketch';

/** A region as /build/sketch_regions gives it, in sketch (x, y). */
export interface SketchRegion {
  point: XY;
  default: boolean;
  area: number;
  tris: [XY, XY, XY][];
  edges: XY[][];
}

const cross = (a: XY, b: XY, p: XY) => (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);

/** Is `p` in triangle `t` (its edges count, to 1e-6 mm)? */
function inTri(t: [XY, XY, XY], p: XY): boolean {
  const s = Math.sign(cross(t[0], t[1], t[2])) || 1;
  const eps = 1e-6 * Math.max(1, Math.hypot(t[1][0] - t[0][0], t[1][1] - t[0][1]));
  return [cross(t[0], t[1], p), cross(t[1], t[2], p), cross(t[2], t[0], p)].every((c) => c * s >= -eps);
}

/** The region `p` is in, or -1. */
export function regionAt(regions: SketchRegion[], p: XY): number {
  return regions.findIndex((r) => r.tris.some((t) => inTri(t, p)));
}

/** Which regions a step takes: the default ones when nothing is picked. */
export function chosenRegions(regions: SketchRegion[], picked: XY[] | null | undefined): boolean[] {
  if (!picked) return regions.map((r) => r.default);
  const on = regions.map(() => false);
  for (const p of picked) {
    const i = regionAt(regions, p);
    if (i >= 0) on[i] = true;
  }
  return on;
}

/** The picked points that are in no region any more (the sketch changed). */
export function lostPicks(regions: SketchRegion[], picked: XY[] | null | undefined): XY[] {
  return (picked ?? []).filter((p) => regionAt(regions, p) < 0);
}

/** The pick after clicking region `i`: null when it comes back to the
 *  default; the last region can't be left out (nothing to extrude). Points
 *  in no region are dropped. */
export function togglePick(regions: SketchRegion[], picked: XY[] | null | undefined, i: number): XY[] | null {
  const on = chosenRegions(regions, picked);
  on[i] = !on[i];
  if (!on.some(Boolean)) return picked ?? null;
  if (on.every((x, j) => x === regions[j]!.default)) return null;
  return regions.flatMap((r, j) => (on[j] ? [r.point] : []));
}

/** The outline of the regions a step takes, as polylines: an edge two taken
 *  regions share is inside the shape and left out. */
export function pickedOutline(regions: SketchRegion[], picked: XY[] | null | undefined): XY[][] {
  const on = chosenRegions(regions, picked);
  const key = (e: XY[]) => {
    const r = (p: XY) => `${p[0].toFixed(3)},${p[1].toFixed(3)}`;
    // the middle of it, the same either way round
    const a = e[Math.floor((e.length - 1) / 2)]!, b = e[Math.ceil((e.length - 1) / 2)]!;
    return [r(e[0]!), r(e[e.length - 1]!)].sort().join('|') + `|${r([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2])}`;
  };
  const edges = regions.flatMap((r, i) => (on[i] ? r.edges : []));
  const count = new Map<string, number>();
  for (const e of edges) count.set(key(e), (count.get(key(e)) ?? 0) + 1);
  return edges.filter((e) => count.get(key(e)) === 1);
}

/** What the step takes, in words: "2 of 3 regions", "all 3 regions". */
export function regionsWords(regions: SketchRegion[], picked: XY[] | null | undefined): string {
  const n = chosenRegions(regions, picked).filter(Boolean).length;
  return n === regions.length ? `all ${n} regions` : `${n} of ${regions.length} region${regions.length > 1 ? 's' : ''}`;
}
