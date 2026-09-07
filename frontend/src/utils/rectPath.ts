import type { Point, RectangleEntity } from '@/types/document';
import { arcFromBulge } from '@/utils/arcGeometry';

/**
 * A rectangle's outline as a closed path, optionally with filleted corners.
 *
 * A fillet is a pure *path* modifier: it changes the curve the rectangle draws,
 * exports and machines, but not its parametric skeleton. `center`, `width`,
 * `height` and the four theoretical (sharp) corners are untouched, so drag
 * handles, dimensions, constraints and the bounding box all keep working off
 * the sharp rectangle — which is what CAD packages do too.
 */

/** bulge = tan(θ/4), so a 90° corner arc is tan(22.5°).
 *
 *  Negative: `arcFromBulge` places the centre at `mid + sign * dist * (-dy, dx)`,
 *  and for the corner order below the arc centre must land on the *inward* side
 *  of each chord, which is the `sign = -1` side. (Worked example: a 20×20 rect
 *  at the origin with r=2 has its top-right arc running (8,10)→(10,8) about
 *  centre (8,8); the perpendicular there is +(0.707,0.707), so the centre sits
 *  at mid−1.414·perp.) */
const QUARTER_ARC_BULGE = -Math.tan(Math.PI / 8);

export interface RectPath {
  /** Closed outline: 4 points when square-cornered, 8 when filleted. */
  points: Point[];
  /** Per-segment bulge; `bulge[i]` belongs to the segment points[i] → points[i+1]. */
  bulge: number[];
}

/**
 * The four theoretical corners in the canonical traversal order used throughout
 * the codebase (hit test, entityPoints indices 1-4, lineSegments segments 0-3):
 * 0=TL, 1=TR, 2=BR, 3=BL in the editor's Y-down space.
 */
export function rectangleCorners(rect: RectangleEntity): [Point, Point, Point, Point] {
  const hw = rect.width / 2;
  const hh = rect.height / 2;
  const { x: cx, y: cy } = rect.center;
  return [
    { x: cx - hw, y: cy + hh },
    { x: cx + hw, y: cy + hh },
    { x: cx + hw, y: cy - hh },
    { x: cx - hw, y: cy - hh },
  ];
}

/** The largest fillet that still fits: any bigger and opposite arcs would meet. */
export function maxCornerRadius(width: number, height: number): number {
  return Math.min(Math.abs(width), Math.abs(height)) / 2;
}

/** The radius actually used for drawing — the requested one, clamped to fit. */
export function effectiveCornerRadius(rect: RectangleEntity): number {
  const r = rect.cornerRadius ?? 0;
  if (!(r > 0)) return 0;
  return Math.min(r, maxCornerRadius(rect.width, rect.height));
}

/**
 * The rectangle's outline. With no fillet this is the four sharp corners and
 * four zero bulges; with a fillet it is eight points where every odd segment
 * (1, 3, 5, 7) is a quarter-circle arc.
 */
export function rectanglePath(rect: RectangleEntity): RectPath {
  const corners = rectangleCorners(rect);
  const r = effectiveCornerRadius(rect);
  if (r === 0) {
    return { points: corners, bulge: [0, 0, 0, 0] };
  }

  const hw = rect.width / 2;
  const hh = rect.height / 2;
  const { x: cx, y: cy } = rect.center;
  const k = QUARTER_ARC_BULGE;

  return {
    points: [
      { x: cx - hw + r, y: cy + hh }, // 0: leaving the TL arc
      { x: cx + hw - r, y: cy + hh }, // 1: entering the TR arc
      { x: cx + hw, y: cy + hh - r }, // 2: leaving the TR arc
      { x: cx + hw, y: cy - hh + r }, // 3: entering the BR arc
      { x: cx + hw - r, y: cy - hh }, // 4: leaving the BR arc
      { x: cx - hw + r, y: cy - hh }, // 5: entering the BL arc
      { x: cx - hw, y: cy - hh + r }, // 6: leaving the BL arc
      { x: cx - hw, y: cy + hh - r }, // 7: entering the TL arc
    ],
    bulge: [0, k, 0, k, 0, k, 0, k],
  };
}

/** Sample count for one quarter-circle when flattening to straight segments. */
const ARC_STEPS = 12;

/**
 * The outline flattened to a plain polygon — for fills and for canvas backends
 * that only take straight segments. Square-cornered rectangles come back as
 * their four corners unchanged.
 */
export function rectangleOutline(rect: RectangleEntity): Point[] {
  const { points, bulge } = rectanglePath(rect);
  if (effectiveCornerRadius(rect) === 0) return points;

  const out: Point[] = [];
  for (let i = 0; i < points.length; i++) {
    const p1 = points[i]!;
    const p2 = points[(i + 1) % points.length]!;
    out.push(p1);
    const b = bulge[i] ?? 0;
    if (b === 0) continue;
    const arc = arcFromBulge(p1, p2, b);
    if (arc.radius === 0) continue;
    let sweep = arc.endAngle - arc.startAngle;
    // Normalise the sweep into the direction the arc actually travels.
    if (arc.counterClockwise) {
      while (sweep > 0) sweep -= Math.PI * 2;
    } else {
      while (sweep < 0) sweep += Math.PI * 2;
    }
    for (let s = 1; s < ARC_STEPS; s++) {
      const a = arc.startAngle + (sweep * s) / ARC_STEPS;
      out.push({ x: arc.center.x + arc.radius * Math.cos(a), y: arc.center.y + arc.radius * Math.sin(a) });
    }
  }
  return out;
}

/**
 * Clamp a typed-in fillet radius to what the rectangle can hold.
 *
 * Only the entry points where a user types a radius need this. Resizing a
 * rectangle deliberately does *not* rewrite the stored radius: `rectanglePath`
 * clamps at draw time, so shrinking a box and growing it again brings the
 * original fillet back rather than silently destroying it.
 */
export function clampCornerRadius(radius: number, width: number, height: number): number {
  if (!isFinite(radius) || radius <= 0) return 0;
  return Math.min(radius, maxCornerRadius(width, height));
}
