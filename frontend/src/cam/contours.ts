import type { CncSegment } from './entityToSegments';
import { arcFromBulge } from '@/utils/arcGeometry';

const CHAIN_TOL = 0.5; // endpoint matching tolerance when chaining segments

/**
 * Signed area of a contour in sketch coordinates, arcs included (shoelace over
 * the chords plus each arc's circular segment). Positive = counter-clockwise in
 * the sketch's own (x, y) coordinates.
 */
export function signedArea(contour: CncSegment[]): number {
  let area = 0;
  for (const s of contour) {
    area += (s.from.x * s.to.y - s.to.x * s.from.y) / 2;
    if (s.bulge !== 0) {
      const theta = 4 * Math.atan(Math.abs(s.bulge)); // the arc's sweep
      const chord = Math.hypot(s.to.x - s.from.x, s.to.y - s.from.y);
      const r = chord / (2 * Math.sin(theta / 2));
      // A positive bulge turns counter-clockwise, so its arc lies to the right
      // of the chord and adds area on a counter-clockwise loop.
      area += Math.sign(s.bulge) * (r * r / 2) * (theta - Math.sin(theta));
    }
  }
  return area;
}

/** True when the contour ends where it starts (within the chaining tolerance). */
export function isClosed(contour: CncSegment[]): boolean {
  if (contour.length === 0) return false;
  const head = contour[0]!.from;
  const tail = contour[contour.length - 1]!.to;
  return Math.hypot(head.x - tail.x, head.y - tail.y) < CHAIN_TOL;
}

/** The same path run the other way. */
export function reverseContour(contour: CncSegment[]): CncSegment[] {
  return [...contour].reverse().map((s) => ({ from: s.to, to: s.from, bulge: -s.bulge }));
}

/** Reverse a closed contour that runs clockwise; open contours are left as drawn. */
export function orientCounterClockwise(contour: CncSegment[]): CncSegment[] {
  if (!isClosed(contour) || signedArea(contour) >= 0) return contour;
  return reverseContour(contour);
}

/**
 * Group segments into connected contours by tracing endpoint connectivity.
 * Segments are chained so that seg[i].to ≈ seg[i+1].from within each group.
 * Segments may be reversed if needed to maintain chain continuity.
 */
export function groupContours(segments: CncSegment[]): CncSegment[][] {
  if (segments.length === 0) return [];

  const TOL = CHAIN_TOL;
  const used = new Array(segments.length).fill(false);
  const groups: CncSegment[][] = [];

  for (let start = 0; start < segments.length; start++) {
    if (used[start]) continue;
    used[start] = true;
    const chain: CncSegment[] = [segments[start]!];

    // Extend forward: find a segment whose start matches chain tail
    let changed = true;
    while (changed) {
      changed = false;
      const tail = chain[chain.length - 1]!.to;
      for (let i = 0; i < segments.length; i++) {
        if (used[i]) continue;
        const s = segments[i]!;
        const dxF = s.from.x - tail.x;
        const dyF = s.from.y - tail.y;
        if (dxF * dxF + dyF * dyF < TOL * TOL) {
          chain.push(s);
          used[i] = true;
          changed = true;
          break;
        }
        // Try reversed
        const dxR = s.to.x - tail.x;
        const dyR = s.to.y - tail.y;
        if (dxR * dxR + dyR * dyR < TOL * TOL) {
          chain.push({ from: s.to, to: s.from, bulge: -s.bulge });
          used[i] = true;
          changed = true;
          break;
        }
      }
    }

    // Extend backward: find a segment whose end matches chain head
    changed = true;
    while (changed) {
      changed = false;
      const head = chain[0]!.from;
      for (let i = 0; i < segments.length; i++) {
        if (used[i]) continue;
        const s = segments[i]!;
        const dxT = s.to.x - head.x;
        const dyT = s.to.y - head.y;
        if (dxT * dxT + dyT * dyT < TOL * TOL) {
          chain.unshift(s);
          used[i] = true;
          changed = true;
          break;
        }
        // Try reversed
        const dxR = s.from.x - head.x;
        const dyR = s.from.y - head.y;
        if (dxR * dxR + dyR * dyR < TOL * TOL) {
          chain.unshift({ from: s.to, to: s.from, bulge: -s.bulge });
          used[i] = true;
          changed = true;
          break;
        }
      }
    }

    groups.push(chain);
  }

  return groups;
}

/**
 * For each contour, how many of the other closed contours it lies inside (0 for
 * an outer loop, 1 for a hole in it, 2 for a loop inside that hole, ...). Open
 * contours count as 0.
 */
export function nestingDepths(contours: CncSegment[][]): number[] {
  const closed = contours.map(isClosed);
  const rings = contours.map((c, i) => (closed[i] ? polygon(c) : []));
  return contours.map((c, i) => {
    if (!closed[i]) return 0;
    const p = c[0]!.from;
    return rings.filter((ring, j) => j !== i && closed[j] && insidePolygon(ring, p)).length;
  });
}

/** A closed contour's corners, arcs as 32 chords each. */
function polygon(contour: CncSegment[]): { x: number; y: number }[] {
  const pts: { x: number; y: number }[] = [];
  for (const s of contour) {
    pts.push(s.from);
    if (s.bulge === 0) continue;
    const theta = 4 * Math.atan(s.bulge); // counter-clockwise in (x, y) when positive
    const { center: c, radius: r } = arcFromBulge(s.from, s.to, s.bulge);
    const a0 = Math.atan2(s.from.y - c.y, s.from.x - c.x);
    for (let k = 1; k < 32; k++) {
      const a = a0 + (theta * k) / 32;
      pts.push({ x: c.x + r * Math.cos(a), y: c.y + r * Math.sin(a) });
    }
  }
  return pts;
}

function insidePolygon(ring: { x: number; y: number }[], p: { x: number; y: number }): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]!, b = ring[j]!;
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}
