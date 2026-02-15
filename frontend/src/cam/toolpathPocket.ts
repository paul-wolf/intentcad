import type { ToolpathMove } from '@/types/cam';
import type { CncSegment } from './entityToSegments';

/**
 * Generate pocket clearing toolpath using parallel line strategy.
 * Creates a zigzag pattern within the bounding box of the contour,
 * with stepover as a fraction of tool diameter.
 */
export function toolpathPocket(
  segments: CncSegment[],
  toolDiameter: number,
  stepover: number,
  direction: 'climb' | 'conventional',
  feedRate: number,
): ToolpathMove[] {
  if (segments.length === 0) return [];

  const moves: ToolpathMove[] = [];
  const toolRadius = toolDiameter / 2;
  const step = toolDiameter * stepover;

  // Compute bounding box of the contour
  const allPoints = segments.flatMap((s) => [s.from, s.to]);
  const minX = Math.min(...allPoints.map((p) => p.x)) + toolRadius;
  const maxX = Math.max(...allPoints.map((p) => p.x)) - toolRadius;
  const minY = Math.min(...allPoints.map((p) => p.y)) + toolRadius;
  const maxY = Math.max(...allPoints.map((p) => p.y)) - toolRadius;

  if (minX >= maxX || minY >= maxY) return [];

  // Generate zigzag lines along X direction with Y stepping
  let y = minY;
  let leftToRight = direction === 'climb';

  while (y <= maxY) {
    // Intersect scan line with contour to find valid X ranges
    const intersections = findScanLineIntersections(segments, y);

    if (intersections.length >= 2) {
      // Sort intersections and pair them
      intersections.sort((a, b) => a - b);

      for (let i = 0; i < intersections.length - 1; i += 2) {
        const x1 = Math.max(intersections[i]! + toolRadius, minX);
        const x2 = Math.min(intersections[i + 1]! - toolRadius, maxX);

        if (x1 < x2) {
          const fromX = leftToRight ? x1 : x2;
          const toX = leftToRight ? x2 : x1;

          moves.push({
            kind: 'linear',
            to: { x: fromX, y },
            z: 0,
            feed: feedRate,
          });
          moves.push({
            kind: 'linear',
            to: { x: toX, y },
            z: 0,
            feed: feedRate,
          });
        }
      }
    }

    y += step;
    leftToRight = !leftToRight;
  }

  return moves;
}

/**
 * Find X positions where a horizontal scan line at given Y intersects the contour segments.
 */
function findScanLineIntersections(segments: CncSegment[], y: number): number[] {
  const intersections: number[] = [];

  for (const seg of segments) {
    if (seg.bulge === 0) {
      // Line segment intersection with horizontal line
      const { from, to } = seg;
      const minY = Math.min(from.y, to.y);
      const maxY = Math.max(from.y, to.y);

      if (y >= minY && y <= maxY && from.y !== to.y) {
        const t = (y - from.y) / (to.y - from.y);
        const x = from.x + t * (to.x - from.x);
        intersections.push(x);
      }
    } else {
      // Arc segment: approximate with chord for pocket intersection
      // (A full arc-scanline intersection would be more complex)
      const { from, to } = seg;
      const minY = Math.min(from.y, to.y);
      const maxY = Math.max(from.y, to.y);

      if (y >= minY && y <= maxY && from.y !== to.y) {
        const t = (y - from.y) / (to.y - from.y);
        const x = from.x + t * (to.x - from.x);
        intersections.push(x);
      }
    }
  }

  return intersections;
}
