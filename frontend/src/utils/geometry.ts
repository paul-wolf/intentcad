import type { Point } from '@/types/document';

export function distance(a: Point, b: Point): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

export function pointToSegmentDist(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return distance(p, a);

  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));

  return distance(p, { x: a.x + t * dx, y: a.y + t * dy });
}

/** Check if a line segment (a→b) intersects an axis-aligned rectangle. */
export function segmentIntersectsRect(
  a: Point,
  b: Point,
  rectMin: Point,
  rectMax: Point,
): boolean {
  // If either endpoint is inside the rect, it intersects.
  if (
    a.x >= rectMin.x && a.x <= rectMax.x && a.y >= rectMin.y && a.y <= rectMax.y
  ) return true;
  if (
    b.x >= rectMin.x && b.x <= rectMax.x && b.y >= rectMin.y && b.y <= rectMax.y
  ) return true;

  // Cohen-Sutherland style clipping test
  return lineClipsRect(a, b, rectMin, rectMax);
}

function outcode(p: Point, min: Point, max: Point): number {
  let code = 0;
  if (p.x < min.x) code |= 1;
  else if (p.x > max.x) code |= 2;
  if (p.y < min.y) code |= 4;
  else if (p.y > max.y) code |= 8;
  return code;
}

function lineClipsRect(a: Point, b: Point, min: Point, max: Point): boolean {
  let x0 = a.x, y0 = a.y, x1 = b.x, y1 = b.y;
  let code0 = outcode({ x: x0, y: y0 }, min, max);
  let code1 = outcode({ x: x1, y: y1 }, min, max);

  for (let i = 0; i < 20; i++) {
    if ((code0 | code1) === 0) return true;
    if ((code0 & code1) !== 0) return false;

    const codeOut = code0 !== 0 ? code0 : code1;
    let x: number, y: number;

    if (codeOut & 8) {
      x = x0 + (x1 - x0) * (max.y - y0) / (y1 - y0);
      y = max.y;
    } else if (codeOut & 4) {
      x = x0 + (x1 - x0) * (min.y - y0) / (y1 - y0);
      y = min.y;
    } else if (codeOut & 2) {
      y = y0 + (y1 - y0) * (max.x - x0) / (x1 - x0);
      x = max.x;
    } else {
      y = y0 + (y1 - y0) * (min.x - x0) / (x1 - x0);
      x = min.x;
    }

    if (codeOut === code0) {
      x0 = x; y0 = y;
      code0 = outcode({ x: x0, y: y0 }, min, max);
    } else {
      x1 = x; y1 = y;
      code1 = outcode({ x: x1, y: y1 }, min, max);
    }
  }
  return false;
}

export function snapToGrid(value: number, spacing: number): number {
  return Math.round(value / spacing) * spacing;
}
