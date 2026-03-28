import type { ToolpathMove } from '@/types/cam';
import type { Point } from '@/types/document';

/**
 * Generate a facing toolpath — zigzag raster across the full stock area.
 * Removes material from zTop down to (zTop - totalDepth).
 * The toolpath is a single-pass 2D pattern; depthPasses handles Z layering.
 */
export function toolpathFacing(
  origin: Point,
  toolDiameter: number,
  stepover: number,
  direction: 'climb' | 'conventional',
  feedRate: number,
  stockWidth: number,
  stockHeight: number,
): ToolpathMove[] {
  const moves: ToolpathMove[] = [];
  const toolRadius = toolDiameter / 2;
  const step = toolDiameter * stepover;

  // Stock area centered on origin, offset by tool radius so we cover the full surface
  const minX = origin.x - stockWidth / 2 - toolRadius;
  const maxX = origin.x + stockWidth / 2 + toolRadius;
  const minY = origin.y - stockHeight / 2 + toolRadius;
  const maxY = origin.y + stockHeight / 2 - toolRadius;

  if (minY > maxY) return moves;

  let y = minY;
  let leftToRight = direction === 'climb';

  while (y <= maxY + 1e-6) {
    const fromX = leftToRight ? minX : maxX;
    const toX = leftToRight ? maxX : minX;

    // Rapid to start of line
    moves.push({ kind: 'rapid', to: { x: fromX, y }, z: 0 });
    // Cut across
    moves.push({ kind: 'linear', to: { x: toX, y }, z: 0, feed: feedRate });

    y += step;
    leftToRight = !leftToRight;
  }

  return moves;
}
