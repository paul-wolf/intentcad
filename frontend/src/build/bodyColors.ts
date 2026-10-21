/**
 * The 3D view's per-body shading: when the part is more than one solid (a
 * mirror kept as a separate body, a new-body extrude) each solid is shaded a
 * little differently so you can tell them apart. The first body keeps the
 * part's own colour; the others lean a third of the way toward a hue each
 * (like the section caps' per-body tints). Selection and hover are drawn over
 * it, so they still win.
 */
import type { Vec3 } from './dragHandle';

/** The hues the other bodies lean toward: sage (the mirror preview's copy
 *  colour), sand, lavender, teal. */
export const BODY_HUES: Vec3[] = [[0.48, 0.82, 0.52], [0.88, 0.70, 0.45], [0.74, 0.60, 0.90], [0.42, 0.78, 0.82]];
const LEAN = 0.32;

/** Body `i`'s colour, from the part's colour `base`. */
export function bodyColor(base: Vec3, i: number): Vec3 {
  if (i <= 0) return base;
  const h = BODY_HUES[(i - 1) % BODY_HUES.length]!;
  return [base[0] + (h[0] - base[0]) * LEAN, base[1] + (h[1] - base[1]) * LEAN, base[2] + (h[2] - base[2]) * LEAN];
}

/** `ranges` ([first, count] of vertices) less the vertices of [skip, skip + n). */
export function rangesWithout(ranges: [number, number][], skip: number, n: number): [number, number][] {
  if (!n) return ranges;
  const out: [number, number][] = [];
  for (const [a, c] of ranges) {
    const b = a + c, s = skip, e = skip + n;
    if (e <= a || s >= b) { out.push([a, c]); continue; }
    if (s > a) out.push([a, s - a]);
    if (e < b) out.push([e, b - e]);
  }
  return out;
}
