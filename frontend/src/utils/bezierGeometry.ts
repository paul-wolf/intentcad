import type { Point } from '@/types/document';
import { pointToSegmentDist } from '@/utils/geometry';

/** Evaluate a cubic Bezier at parameter t ∈ [0,1]. */
export function bezierPoint(p0: Point, p1: Point, p2: Point, p3: Point, t: number): Point {
  const u = 1 - t;
  const u2 = u * u;
  const u3 = u2 * u;
  const t2 = t * t;
  const t3 = t2 * t;
  return {
    x: u3 * p0.x + 3 * u2 * t * p1.x + 3 * u * t2 * p2.x + t3 * p3.x,
    y: u3 * p0.y + 3 * u2 * t * p1.y + 3 * u * t2 * p2.y + t3 * p3.y,
  };
}

/**
 * Approximate distance from point p to a cubic Bezier curve.
 * Subdivides the curve into `n` linear segments and tests each.
 */
export function pointToBezierDist(
  p: Point,
  p0: Point,
  p1: Point,
  p2: Point,
  p3: Point,
  n: number = 32,
): number {
  let minDist = Infinity;
  let prev = p0;
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    const curr = bezierPoint(p0, p1, p2, p3, t);
    const d = pointToSegmentDist(p, prev, curr);
    if (d < minDist) minDist = d;
    prev = curr;
  }
  return minDist;
}

/**
 * Check if a cubic Bezier curve intersects an axis-aligned rectangle.
 * Tests n linear sub-segments for intersection, plus checks if any
 * sample point lies inside the rect.
 */
export function bezierIntersectsRect(
  p0: Point,
  p1: Point,
  p2: Point,
  p3: Point,
  rectMin: Point,
  rectMax: Point,
  n: number = 32,
): boolean {
  let prev = p0;
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    const curr = bezierPoint(p0, p1, p2, p3, t);
    // Check if the segment prev→curr intersects the rect
    if (segIntersectsAABB(prev, curr, rectMin, rectMax)) return true;
    prev = curr;
  }
  return false;
}

/** Check if a line segment intersects an axis-aligned bounding box. */
function segIntersectsAABB(a: Point, b: Point, min: Point, max: Point): boolean {
  // If either endpoint is inside the rect
  if (a.x >= min.x && a.x <= max.x && a.y >= min.y && a.y <= max.y) return true;
  if (b.x >= min.x && b.x <= max.x && b.y >= min.y && b.y <= max.y) return true;

  // Cohen-Sutherland style clipping
  const dx = b.x - a.x;
  const dy = b.y - a.y;

  let tMin = 0;
  let tMax = 1;

  // X slab
  if (Math.abs(dx) > 1e-12) {
    const t1 = (min.x - a.x) / dx;
    const t2 = (max.x - a.x) / dx;
    const tLo = Math.min(t1, t2);
    const tHi = Math.max(t1, t2);
    tMin = Math.max(tMin, tLo);
    tMax = Math.min(tMax, tHi);
    if (tMin > tMax) return false;
  } else {
    if (a.x < min.x || a.x > max.x) return false;
  }

  // Y slab
  if (Math.abs(dy) > 1e-12) {
    const t1 = (min.y - a.y) / dy;
    const t2 = (max.y - a.y) / dy;
    const tLo = Math.min(t1, t2);
    const tHi = Math.max(t1, t2);
    tMin = Math.max(tMin, tLo);
    tMax = Math.min(tMax, tHi);
    if (tMin > tMax) return false;
  } else {
    if (a.y < min.y || a.y > max.y) return false;
  }

  return tMin <= tMax;
}
