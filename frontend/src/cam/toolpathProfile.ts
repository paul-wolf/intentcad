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

  // For 'on' cutting or when tool radius is negligible, follow segments directly
  const offsetSegments = cutSide === 'on' ? segments : offsetContour(segments, toolRadius, cutSide);

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
): CncSegment[] {
  const sign = side === 'outside' ? 1 : -1;
  const raw: CncSegment[] = [];

  for (const seg of segments) {
    if (seg.bulge !== 0) {
      // For arc segments, adjust the radius
      const arc = arcFromBulge(seg.from, seg.to, seg.bulge);
      const adjustedRadius = arc.radius + sign * offset;

      if (adjustedRadius <= 0) {
        // Arc collapses — skip or replace with point
        continue;
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

  if (raw.length < 2) return raw;

  // Join adjacent segments at corners: for two consecutive line segments
  // whose endpoints don't meet, find the intersection of the two lines
  // and adjust both endpoints to the intersection point.
  // For a closed contour, also join last→first.
  const isClosed = segments.length >= 2 &&
    distSq(segments[0]!.from, segments[segments.length - 1]!.to) < 1e-4;

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
      // For mixed line/arc corners, use the midpoint as a simple approximation
      const mid = {
        x: (a.to.x + b.from.x) / 2,
        y: (a.to.y + b.from.y) / 2,
      };
      a.to = mid;
      b.from = mid;
    }
  }

  return raw;
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
