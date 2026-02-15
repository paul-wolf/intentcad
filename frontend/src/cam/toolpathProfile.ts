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
export function toolpathProfile(
  segments: CncSegment[],
  toolDiameter: number,
  cutSide: 'inside' | 'outside' | 'on',
  feedRate: number,
  _tabs: boolean = false,
  _tabWidth: number = 5,
  _tabHeight: number = 1,
): ToolpathMove[] {
  if (segments.length === 0) return [];

  const moves: ToolpathMove[] = [];
  const toolRadius = toolDiameter / 2;

  // For 'on' cutting or when tool radius is negligible, follow segments directly
  const offsetSegments = cutSide === 'on' ? segments : offsetContour(segments, toolRadius, cutSide);

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

  return moves;
}

/**
 * Offset a closed contour by a given distance.
 * For 'outside': offset each segment to the right of travel direction.
 * For 'inside': offset each segment to the left.
 */
function offsetContour(
  segments: CncSegment[],
  offset: number,
  side: 'inside' | 'outside',
): CncSegment[] {
  const sign = side === 'outside' ? 1 : -1;
  const result: CncSegment[] = [];

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
      result.push({ from: newFrom, to: newTo, bulge: seg.bulge });
    } else {
      // Straight segment: offset perpendicular
      const dx = seg.to.x - seg.from.x;
      const dy = seg.to.y - seg.from.y;
      const len = Math.sqrt(dx * dx + dy * dy);
      if (len === 0) continue;

      // Normal pointing right of travel direction (for y-down coordinate system)
      const nx = (dy / len) * sign * offset;
      const ny = (-dx / len) * sign * offset;

      result.push({
        from: { x: seg.from.x + nx, y: seg.from.y + ny },
        to: { x: seg.to.x + nx, y: seg.to.y + ny },
        bulge: 0,
      });
    }
  }

  return result;
}
