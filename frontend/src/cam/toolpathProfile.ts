import type { Point } from '@/types/document';
import type { ToolpathMove } from '@/types/cam';
import type { CncSegment } from './entityToSegments';
import { arcFromBulge } from '@/utils/arcGeometry';

/**
 * Offset a contour by tool radius for cutter compensation.
 * cutSide: 'on' = no offset, 'outside' = offset outward, 'inside' = offset inward.
 *
 * For 'on' cutting, segments are followed as-is at a given Z depth.
 * For inside/outside, each segment is offset by toolRadius perpendicular to the cut direction.
 */
export interface ProfileResult {
  moves: ToolpathMove[];
  startPosition: Point;
  /** Set when this contour can't be offset safely; `moves` is then empty. */
  problem?: string;
}

export function toolpathProfile(
  segments: CncSegment[],
  toolDiameter: number,
  cutSide: 'inside' | 'outside' | 'on',
  feedRate: number,
  _tabs: boolean = false,
  _tabWidth: number = 5,
  _tabHeight: number = 1,
): ProfileResult {
  if (segments.length === 0) return { moves: [], startPosition: { x: 0, y: 0 } };

  const moves: ToolpathMove[] = [];
  const toolRadius = toolDiameter / 2;

  // For 'on' cutting, follow segments directly
  let offsetSegments = segments;
  if (cutSide !== 'on') {
    const offset = offsetContour(segments, toolRadius, cutSide);
    if (offset.problem || offset.segments.length === 0) {
      return {
        moves: [],
        startPosition: segments[0]!.from,
        problem: offset.problem ?? 'the shape is too small for this tool',
      };
    }
    offsetSegments = offset.segments;
  }

  const startPosition = offsetSegments[0]!.from;

  // Generate moves from offset segments
  for (let i = 0; i < offsetSegments.length; i++) {
    const seg = offsetSegments[i]!;

    if (seg.bulge !== 0) {
      // Arc segment
      const arc = arcFromBulge(seg.from, seg.to, seg.bulge);
      // Compute I, J relative to arc start point
      const center: Point = {
        x: arc.center.x - seg.from.x,
        y: arc.center.y - seg.from.y,
      };
      moves.push({
        kind: 'arc',
        to: seg.to,
        z: 0,
        center,
        // Clockwise as seen on screen (see ArcMove).
        clockwise: !arc.counterClockwise,
        feed: feedRate,
      });
    } else {
      // Linear segment
      moves.push({
        kind: 'linear',
        to: seg.to,
        z: 0,
        feed: feedRate,
      });
    }
  }

  return { moves, startPosition };
}

/**
 * Offset a closed contour by a given distance.
 * For 'outside': offset each segment to the right of travel direction.
 * For 'inside': offset each segment to the left.
 *
 * After offsetting each segment independently, adjacent line segments are
 * trimmed/extended to meet at their intersection point (corner joining).
 */
function offsetContour(
  segments: CncSegment[],
  offset: number,
  side: 'inside' | 'outside',
): { segments: CncSegment[]; problem?: string } {
  const sign = side === 'outside' ? 1 : -1;
  const raw: CncSegment[] = [];

  // Corners joined at an angle where an arc is involved can't be offset by the
  // simple joins below without gouging (they need a proper corner join; phase 2).
  // Refuse them rather than cut into the part.
  const closedInput = segments.length >= 2 &&
    distSq(segments[0]!.from, segments[segments.length - 1]!.to) < CLOSED_TOL_SQ;
  for (let i = 0; i < segments.length; i++) {
    if (i === segments.length - 1 && !closedInput) break;
    const a = segments[i]!;
    const b = segments[(i + 1) % segments.length]!;
    if (a.bulge === 0 && b.bulge === 0) continue;
    if (!isTangent(endDirection(a), startDirection(b))) {
      return {
        segments: [],
        problem: 'an arc meets another edge at a sharp corner; inside/outside cuts need arcs to join smoothly (tangent) for now',
      };
    }
  }

  for (let si = 0; si < segments.length; si++) {
    const seg = segments[si]!;
    if (seg.bulge !== 0) {
      // For arc segments, adjust the radius
      const arc = arcFromBulge(seg.from, seg.to, seg.bulge);
      // The contour runs counter-clockwise (generate.ts), so an arc with a
      // positive bulge is convex and grows outward; a negative one is concave.
      const adjustedRadius = arc.radius + sign * offset * (seg.bulge > 0 ? 1 : -1);

      if (adjustedRadius <= 1e-6) {
        // A fillet no bigger than the tool between two straight edges (a
        // rounded corner cut from the inside, say): the tool can't follow it,
        // so drop the arc and let the two offset lines meet in a corner. That
        // leaves the tool's radius in the corner, never a gouge.
        const prev = si > 0 ? segments[si - 1] : closedInput ? segments[segments.length - 1] : undefined;
        const next = si < segments.length - 1 ? segments[si + 1] : closedInput ? segments[0] : undefined;
        if (prev && next && prev.bulge === 0 && next.bulge === 0) continue;
        return {
          segments: [],
          problem: `an arc of radius ${arc.radius.toFixed(2)}mm is too tight for a ${(offset * 2).toFixed(2)}mm tool`,
        };
      }

      // Compute new endpoints on the offset arc
      const newFrom: Point = {
        x: arc.center.x + adjustedRadius * Math.cos(arc.startAngle),
        y: arc.center.y + adjustedRadius * Math.sin(arc.startAngle),
      };
      const newTo: Point = {
        x: arc.center.x + adjustedRadius * Math.cos(arc.endAngle),
        y: arc.center.y + adjustedRadius * Math.sin(arc.endAngle),
      };

      // Recompute bulge for the new radius (same sweep angle, different radius)
      // The bulge magnitude stays the same since it encodes the angle, not the radius
      raw.push({ from: newFrom, to: newTo, bulge: seg.bulge });
    } else {
      // Straight segment: offset perpendicular
      const dx = seg.to.x - seg.from.x;
      const dy = seg.to.y - seg.from.y;
      const len = Math.sqrt(dx * dx + dy * dy);
      if (len === 0) continue;

      // Normal pointing right of travel direction (for y-down coordinate system)
      const nx = (dy / len) * sign * offset;
      const ny = (-dx / len) * sign * offset;

      raw.push({
        from: { x: seg.from.x + nx, y: seg.from.y + ny },
        to: { x: seg.to.x + nx, y: seg.to.y + ny },
        bulge: 0,
      });
    }
  }

  if (raw.length < 2) return { segments: raw };

  // Join adjacent segments at corners: for two consecutive line segments
  // whose endpoints don't meet, find the intersection of the two lines
  // and adjust both endpoints to the intersection point.
  // For a closed contour, also join last→first.
  const isClosed = closedInput;

  const n = raw.length;
  for (let i = 0; i < n; i++) {
    const next = (i + 1) % n;
    if (!isClosed && next === 0) break; // don't wrap open contours

    const a = raw[i]!;
    const b = raw[next]!;

    // Skip if already connected
    if (distSq(a.to, b.from) < 1e-6) continue;

    // Only handle line-line corners for now (most common case: rectangles, polygons)
    if (a.bulge === 0 && b.bulge === 0) {
      const ix = lineLineIntersection(a.from, a.to, b.from, b.to);
      if (ix) {
        a.to = ix;
        b.from = ix;
      }
    } else {
      // Tangent line/arc joins (checked above) offset to the same point, up to
      // rounding; close the tiny gap.
      const mid = {
        x: (a.to.x + b.from.x) / 2,
        y: (a.to.y + b.from.y) / 2,
      };
      a.to = mid;
      b.from = mid;
    }
  }

  return { segments: raw };
}

/** Same tolerance generate.ts uses to decide a chained contour is closed. */
const CLOSED_TOL_SQ = 0.5 * 0.5;

/** Direction of travel at a segment's start, in sketch (x, y). */
function startDirection(seg: CncSegment): Point {
  return seg.bulge === 0 ? { x: seg.to.x - seg.from.x, y: seg.to.y - seg.from.y } : arcTangent(seg, seg.from);
}

/** Direction of travel at a segment's end, in sketch (x, y). */
function endDirection(seg: CncSegment): Point {
  return seg.bulge === 0 ? { x: seg.to.x - seg.from.x, y: seg.to.y - seg.from.y } : arcTangent(seg, seg.to);
}

/** Tangent of an arc segment at one of its ends: a positive bulge turns counter-clockwise in (x, y). */
function arcTangent(seg: CncSegment, p: Point): Point {
  const { center } = arcFromBulge(seg.from, seg.to, seg.bulge);
  const rx = p.x - center.x, ry = p.y - center.y;
  return seg.bulge > 0 ? { x: -ry, y: rx } : { x: ry, y: -rx };
}

function isTangent(u: Point, v: Point): boolean {
  const lu = Math.hypot(u.x, u.y), lv = Math.hypot(v.x, v.y);
  if (lu < 1e-12 || lv < 1e-12) return true;
  return (u.x * v.x + u.y * v.y) / (lu * lv) > Math.cos(Math.PI / 180); // within 1°
}

function distSq(a: Point, b: Point): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

/**
 * Find intersection point of two lines (a1→a2) and (b1→b2).
 * Returns null if lines are parallel.
 */
function lineLineIntersection(a1: Point, a2: Point, b1: Point, b2: Point): Point | null {
  const dax = a2.x - a1.x;
  const day = a2.y - a1.y;
  const dbx = b2.x - b1.x;
  const dby = b2.y - b1.y;

  const denom = dax * dby - day * dbx;
  if (Math.abs(denom) < 1e-10) return null; // parallel

  const t = ((b1.x - a1.x) * dby - (b1.y - a1.y) * dbx) / denom;
  return {
    x: a1.x + t * dax,
    y: a1.y + t * day,
  };
}
