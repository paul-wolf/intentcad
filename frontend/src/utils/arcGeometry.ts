import type { Point } from '@/types/document';

export interface ArcParams {
  center: Point;
  radius: number;
  startAngle: number;
  endAngle: number;
  counterClockwise: boolean;
}

/**
 * Compute arc parameters from two endpoints and a bulge factor.
 * bulge = tan(θ/4) where θ is the included angle.
 * Positive bulge = arc bulges to the left of p1→p2.
 */
export function arcFromBulge(p1: Point, p2: Point, bulge: number): ArcParams {
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  const d = Math.sqrt(dx * dx + dy * dy);

  if (d === 0 || bulge === 0) {
    // Degenerate: return a zero-radius arc at midpoint
    const mid = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
    return { center: mid, radius: 0, startAngle: 0, endAngle: 0, counterClockwise: false };
  }

  const absBulge = Math.abs(bulge);
  const radius = (d * (1 + bulge * bulge)) / (4 * absBulge);
  const sagitta = absBulge * d / 2;

  // Perpendicular to chord (left of p1→p2)
  const perpX = -dy / d;
  const perpY = dx / d;

  // Midpoint of chord
  const midX = (p1.x + p2.x) / 2;
  const midY = (p1.y + p2.y) / 2;

  // Center offset from midpoint along perpendicular
  const centerDist = radius - sagitta;
  const sign = bulge > 0 ? 1 : -1;
  const center: Point = {
    x: midX + sign * centerDist * perpX,
    y: midY + sign * centerDist * perpY,
  };

  const startAngle = Math.atan2(p1.y - center.y, p1.x - center.x);
  const endAngle = Math.atan2(p2.y - center.y, p2.x - center.x);

  // In y-down canvas coords, positive bulge → clockwise (counterClockwise=false)
  // because canvas angles increase clockwise.
  const counterClockwise = bulge < 0;

  return { center, radius, startAngle, endAngle, counterClockwise };
}

/**
 * Distance from a point to an arc curve.
 */
export function pointToArcDist(
  p: Point,
  center: Point,
  radius: number,
  startAngle: number,
  endAngle: number,
  counterClockwise: boolean,
  p1: Point,
  p2: Point,
): number {
  const angle = Math.atan2(p.y - center.y, p.x - center.x);

  if (isAngleInSweep(angle, startAngle, endAngle, counterClockwise)) {
    // Point projects onto the arc: distance is |dist_to_center - radius|
    const dx = p.x - center.x;
    const dy = p.y - center.y;
    return Math.abs(Math.sqrt(dx * dx + dy * dy) - radius);
  }

  // Outside sweep: distance to nearest endpoint
  const d1 = Math.sqrt((p.x - p1.x) ** 2 + (p.y - p1.y) ** 2);
  const d2 = Math.sqrt((p.x - p2.x) ** 2 + (p.y - p2.y) ** 2);
  return Math.min(d1, d2);
}

/**
 * Point on the arc at the midpoint of the sweep.
 */
export function arcMidpoint(p1: Point, p2: Point, bulge: number): Point {
  if (bulge === 0) {
    return { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
  }

  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  const d = Math.sqrt(dx * dx + dy * dy);
  if (d === 0) return { x: p1.x, y: p1.y };

  const sagitta = bulge * d / 2;

  // Perpendicular to chord (left of p1→p2)
  const perpX = -dy / d;
  const perpY = dx / d;

  // Midpoint of chord
  const midX = (p1.x + p2.x) / 2;
  const midY = (p1.y + p2.y) / 2;

  // Arc midpoint is sagitta distance from chord midpoint, toward arc
  return {
    x: midX - sagitta * perpX,
    y: midY - sagitta * perpY,
  };
}

/**
 * Compute bulge from a dragged midpoint position.
 * Given the chord endpoints and a point on the desired arc, returns the bulge.
 */
export function bulgeFromMidpoint(p1: Point, p2: Point, midpoint: Point): number {
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  const d = Math.sqrt(dx * dx + dy * dy);
  if (d === 0) return 0;

  // Vector from chord midpoint to the dragged midpoint
  const chordMidX = (p1.x + p2.x) / 2;
  const chordMidY = (p1.y + p2.y) / 2;
  const toMidX = midpoint.x - chordMidX;
  const toMidY = midpoint.y - chordMidY;

  // Perpendicular to chord (left of p1→p2)
  const perpX = -dy / d;
  const perpY = dx / d;

  // Signed sagitta: projection of toMid onto the negative perpendicular
  // (negative because sagitta = bulge * d/2, and midpoint is on the arc side)
  const sagitta = -(toMidX * perpX + toMidY * perpY);

  // bulge = sagitta / (d/2) = 2*sagitta/d
  const bulge = (2 * sagitta) / d;

  // Clamp to reasonable range
  if (Math.abs(bulge) < 0.001) return 0;
  return Math.max(-10, Math.min(10, bulge));
}

/**
 * Check if an arc segment intersects an axis-aligned rectangle.
 * Tests: endpoint inside rect, arc curve crosses rect edges, or rect corners near arc.
 */
export function arcIntersectsRect(
  p1: Point,
  p2: Point,
  bulge: number,
  rectMin: Point,
  rectMax: Point,
): boolean {
  // If either endpoint is inside the rect
  if (p1.x >= rectMin.x && p1.x <= rectMax.x && p1.y >= rectMin.y && p1.y <= rectMax.y) return true;
  if (p2.x >= rectMin.x && p2.x <= rectMax.x && p2.y >= rectMin.y && p2.y <= rectMax.y) return true;

  const arc = arcFromBulge(p1, p2, bulge);
  if (arc.radius === 0) return false;

  // Check if the arc midpoint is inside the rect
  const mid = arcMidpoint(p1, p2, bulge);
  if (mid.x >= rectMin.x && mid.x <= rectMax.x && mid.y >= rectMin.y && mid.y <= rectMax.y) return true;

  // Check the four cardinal directions on the arc circle against rect edges
  const { center, radius, startAngle, endAngle, counterClockwise } = arc;
  const cardinals = [0, Math.PI / 2, Math.PI, -Math.PI / 2]; // right, up, left, down
  for (const angle of cardinals) {
    if (isAngleInSweep(angle, startAngle, endAngle, counterClockwise)) {
      const px = center.x + radius * Math.cos(angle);
      const py = center.y + radius * Math.sin(angle);
      if (px >= rectMin.x && px <= rectMax.x && py >= rectMin.y && py <= rectMax.y) return true;
    }
  }

  // Check if the arc circle intersects any rect edge
  // Closest point on rect to circle center
  const cx = Math.max(rectMin.x, Math.min(center.x, rectMax.x));
  const cy = Math.max(rectMin.y, Math.min(center.y, rectMax.y));
  const distSq = (center.x - cx) ** 2 + (center.y - cy) ** 2;
  if (distSq > radius * radius) return false;

  // Circle intersects the rect; check if the intersection angle is within sweep
  // Sample the four rect edges
  const edges: [Point, Point][] = [
    [rectMin, { x: rectMax.x, y: rectMin.y }],
    [{ x: rectMax.x, y: rectMin.y }, rectMax],
    [rectMax, { x: rectMin.x, y: rectMax.y }],
    [{ x: rectMin.x, y: rectMax.y }, rectMin],
  ];
  for (const [ea, eb] of edges) {
    if (arcIntersectsSegment(center, radius, startAngle, endAngle, counterClockwise, ea, eb)) {
      return true;
    }
  }

  return false;
}

/** Check if an arc intersects a line segment */
function arcIntersectsSegment(
  center: Point,
  radius: number,
  startAngle: number,
  endAngle: number,
  counterClockwise: boolean,
  a: Point,
  b: Point,
): boolean {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const fx = a.x - center.x;
  const fy = a.y - center.y;

  const A = dx * dx + dy * dy;
  const B = 2 * (fx * dx + fy * dy);
  const C = fx * fx + fy * fy - radius * radius;
  const disc = B * B - 4 * A * C;

  if (disc < 0) return false;

  const sqrtDisc = Math.sqrt(disc);
  for (const sign of [-1, 1]) {
    const t = (-B + sign * sqrtDisc) / (2 * A);
    if (t >= 0 && t <= 1) {
      const px = a.x + t * dx;
      const py = a.y + t * dy;
      const angle = Math.atan2(py - center.y, px - center.x);
      if (isAngleInSweep(angle, startAngle, endAngle, counterClockwise)) {
        return true;
      }
    }
  }
  return false;
}

/** Check if an angle falls within an arc sweep (Canvas2D convention) */
function isAngleInSweep(
  angle: number,
  startAngle: number,
  endAngle: number,
  counterClockwise: boolean,
): boolean {
  // Normalize all angles to [0, 2π)
  const TWO_PI = 2 * Math.PI;
  const normalize = (a: number) => ((a % TWO_PI) + TWO_PI) % TWO_PI;

  const a = normalize(angle);
  const s = normalize(startAngle);
  const e = normalize(endAngle);

  if (!counterClockwise) {
    // Canvas2D default (CW on screen): sweep from start in increasing-angle direction to end
    if (s <= e) {
      return a >= s && a <= e;
    } else {
      return a >= s || a <= e;
    }
  } else {
    // Canvas2D CCW: sweep from start in decreasing-angle direction to end
    if (s >= e) {
      return a <= s && a >= e;
    } else {
      return a <= s || a >= e;
    }
  }
}
