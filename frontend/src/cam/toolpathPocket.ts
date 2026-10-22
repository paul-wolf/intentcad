import type { ToolpathMove } from '@/types/cam';
import type { CncSegment } from './entityToSegments';

type Pt = { x: number; y: number };

// ── Arc geometry helpers ──

/** Compute arc center and radius from a CncSegment with nonzero bulge. */
function arcParams(seg: CncSegment): { cx: number; cy: number; r: number } {
  const { from, to, bulge } = seg;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const chordLen = Math.sqrt(dx * dx + dy * dy);
  if (chordLen < 1e-12) return { cx: from.x, cy: from.y, r: 0 };

  const s = ((1 / bulge) - bulge) / 2;
  const mx = (from.x + to.x) / 2;
  const my = (from.y + to.y) / 2;
  const nx = -dy / chordLen;
  const ny = dx / chordLen;
  const cx = mx + s * nx * (chordLen / 2);
  const cy = my + s * ny * (chordLen / 2);
  const r = Math.sqrt((from.x - cx) ** 2 + (from.y - cy) ** 2);
  return { cx, cy, r };
}

// ── Contour to polygon ──

/** Sample all segments into a closed polygon of points. */
function contourToPolygon(segments: CncSegment[], samplesPerArc = 24): Pt[] {
  const pts: Pt[] = [];

  for (const seg of segments) {
    if (seg.bulge === 0) {
      pts.push({ ...seg.from });
    } else {
      const { cx, cy, r } = arcParams(seg);
      if (r < 1e-12) { pts.push({ ...seg.from }); continue; }

      const startAngle = Math.atan2(seg.from.y - cy, seg.from.x - cx);
      const endAngle = Math.atan2(seg.to.y - cy, seg.to.x - cx);
      const ccw = seg.bulge > 0;

      let sweep: number;
      if (ccw) {
        sweep = endAngle - startAngle;
        if (sweep <= 0) sweep += 2 * Math.PI;
      } else {
        sweep = startAngle - endAngle;
        if (sweep <= 0) sweep += 2 * Math.PI;
        sweep = -sweep;
      }

      const steps = Math.max(4, Math.ceil(Math.abs(sweep) / (2 * Math.PI) * samplesPerArc));
      for (let i = 0; i < steps; i++) {
        const a = startAngle + sweep * (i / steps);
        pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
      }
    }
  }

  return pts;
}

// ── Polygon offset (inward) ──

/** Compute the signed area of a polygon. Positive = CCW. */
function polygonArea(poly: Pt[]): number {
  let area = 0;
  for (let i = 0; i < poly.length; i++) {
    const j = (i + 1) % poly.length;
    area += poly[i]!.x * poly[j]!.y - poly[j]!.x * poly[i]!.y;
  }
  return area / 2;
}

/**
 * Offset a closed polygon inward by `dist`.
 * Uses edge-normal offsetting with line-line intersection at corners.
 * Returns null if the offset collapses (area becomes zero/negative).
 */
function offsetPolygon(poly: Pt[], dist: number): Pt[] | null {
  const n = poly.length;
  if (n < 3) return null;

  // Ensure CCW winding so inward = right-hand side of edges
  const area = polygonArea(poly);
  const pts = area < 0 ? [...poly].reverse() : poly;
  const len = pts.length;

  // Compute offset edges
  const edges: { p1: Pt; p2: Pt }[] = [];
  for (let i = 0; i < len; i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % len]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const l = Math.sqrt(dx * dx + dy * dy);
    if (l < 1e-12) {
      // Degenerate edge, use previous edge direction or skip
      edges.push({ p1: a, p2: b });
      continue;
    }
    // Inward normal for CCW polygon: (-dy, dx) / len
    const nx = -dy / l * dist;
    const ny = dx / l * dist;
    edges.push({
      p1: { x: a.x + nx, y: a.y + ny },
      p2: { x: b.x + nx, y: b.y + ny },
    });
  }

  // Intersect consecutive offset edges to get new vertices
  const result: Pt[] = [];
  for (let i = 0; i < len; i++) {
    const e1 = edges[i]!;
    const e2 = edges[(i + 1) % len]!;
    const pt = lineLineIntersect(e1.p1, e1.p2, e2.p1, e2.p2);
    if (!pt) {
      // Parallel edges, use midpoint of connection
      result.push({ x: (e1.p2.x + e2.p1.x) / 2, y: (e1.p2.y + e2.p1.y) / 2 });
    } else {
      result.push(pt);
    }
  }

  // Check if the result is still a valid polygon (positive area, not self-intersecting)
  const newArea = polygonArea(result);
  if (newArea <= 0 || Math.abs(newArea) < 0.01) return null;

  return result;
}

/** Line-line intersection of infinite lines through (p1,p2) and (p3,p4). */
function lineLineIntersect(p1: Pt, p2: Pt, p3: Pt, p4: Pt): Pt | null {
  const d1x = p2.x - p1.x, d1y = p2.y - p1.y;
  const d2x = p4.x - p3.x, d2y = p4.y - p3.y;
  const cross = d1x * d2y - d1y * d2x;
  if (Math.abs(cross) < 1e-12) return null;
  const t = ((p3.x - p1.x) * d2y - (p3.y - p1.y) * d2x) / cross;
  return { x: p1.x + t * d1x, y: p1.y + t * d1y };
}

// ── Main pocket toolpath ──

/**
 * Generate pocket clearing toolpath using contour-spiral strategy.
 * Offsets the boundary inward repeatedly by stepover, forming concentric rings
 * from outside to center. Finishes with a wall contour pass.
 */
export function toolpathPocket(
  segments: CncSegment[],
  toolDiameter: number,
  stepover: number,
  direction: 'climb' | 'conventional',
  feedRate: number,
): ToolpathMove[] {
  if (segments.length === 0) return [];

  const toolRadius = toolDiameter / 2;
  const step = toolDiameter * stepover;

  // Convert contour to polygon
  const boundary = contourToPolygon(segments);
  if (boundary.length < 3) return [];

  // First offset: inward by tool radius (wall finishing pass)
  const wallContour = offsetPolygon(boundary, toolRadius);
  if (!wallContour || wallContour.length < 3) return [];

  // Generate concentric offset rings from wall inward
  const rings: Pt[][] = [wallContour];
  let current = wallContour;
  let prevArea = Math.abs(polygonArea(wallContour));
  const maxRings = 500; // Safety limit
  for (let iter = 0; iter < maxRings; iter++) {
    const next = offsetPolygon(current, step);
    if (!next || next.length < 3) break;
    const nextArea = Math.abs(polygonArea(next));
    // Stop if area isn't shrinking (degenerate offset)
    if (nextArea >= prevArea) break;
    rings.push(next);
    current = next;
    prevArea = nextArea;
  }

  // Build toolpath: traverse rings from outermost to innermost.
  // Rings run counter-clockwise in sketch (x, y), which is clockwise on the
  // machine seen from above (Y flipped). With a clockwise spindle (M3), climb
  // milling inside a pocket needs counter-clockwise travel on the machine, so
  // climb reverses the rings.
  const moves: ToolpathMove[] = [];
  const isClimb = direction === 'climb';

  for (let ri = 0; ri < rings.length; ri++) {
    const ring = rings[ri]!;
    const pts = isClimb ? [...ring].reverse() : ring;

    // Each ring starts with a rapid: depthPasses turns it into lift, travel at
    // safe Z, plunge. A straight feed from one ring's start to the next is not
    // safe: rings don't start at matching corners, so on a concave pocket that
    // line can run through uncut material or out through the wall. (Linking
    // inside the cleared area is phase 2, with the new offsetting.)
    moves.push({ kind: 'rapid', to: pts[0]!, z: 0 });

    // Trace the ring
    for (let i = 1; i < pts.length; i++) {
      moves.push({ kind: 'linear', to: pts[i]!, z: 0, feed: feedRate });
    }
    // Close the ring
    moves.push({ kind: 'linear', to: pts[0]!, z: 0, feed: feedRate });
  }

  // Final wall finishing pass (the outermost ring, traced again for clean walls)
  if (rings.length > 1) {
    const wall = isClimb ? [...wallContour].reverse() : wallContour;
    moves.push({ kind: 'rapid', to: wall[0]!, z: 0 });
    for (let i = 1; i < wall.length; i++) {
      moves.push({ kind: 'linear', to: wall[i]!, z: 0, feed: feedRate });
    }
    moves.push({ kind: 'linear', to: wall[0]!, z: 0, feed: feedRate });
  }

  return moves;
}
