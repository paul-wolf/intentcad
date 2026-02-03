import type { Point, Document } from '@/types/document';
import { GRID_SPACING_MM, SNAP_RADIUS } from '@/config';
import { distance, snapToGrid } from '@/utils/geometry';
import type { Viewport } from '@/types/renderer';

export interface SnapResult {
  point: Point;
  type: 'endpoint' | 'grid';
  entityId?: string;
  pointIndex?: number;
}

/**
 * Snap position with priority: endpoint > grid.
 * Distances are compared in screen space.
 */
export function snapPosition(
  worldPos: Point,
  viewport: Viewport,
  document: Document,
): SnapResult {
  const screenPos = viewport.worldToScreen(worldPos);

  // Check all visible sketch endpoints
  let bestEndpoint: Point | null = null;
  let bestDist = SNAP_RADIUS;
  let bestEntityId: string | undefined;
  let bestPointIndex: number | undefined;

  for (const sketch of document.sketches) {
    if (!sketch.visible || sketch.suppressed) continue;
    for (const entity of sketch.entities) {
      if (entity.type === 'line') {
        for (let i = 0; i < entity.points.length; i++) {
          const pt = entity.points[i]!;
          const sp = viewport.worldToScreen(pt);
          const d = distance(sp, screenPos);
          if (d < bestDist) {
            bestDist = d;
            bestEndpoint = pt;
            bestEntityId = entity.id;
            bestPointIndex = i;
          }
        }
      }
      if (entity.type === 'circle') {
        const sp = viewport.worldToScreen(entity.center);
        const d = distance(sp, screenPos);
        if (d < bestDist) {
          bestDist = d;
          bestEndpoint = entity.center;
          bestEntityId = entity.id;
          bestPointIndex = undefined;
        }
      }
      if (entity.type === 'point') {
        const sp = viewport.worldToScreen(entity.position);
        const d = distance(sp, screenPos);
        if (d < bestDist) {
          bestDist = d;
          bestEndpoint = entity.position;
          bestEntityId = entity.id;
          bestPointIndex = undefined;
        }
      }
      if (entity.type === 'rectangle') {
        const hw = entity.width / 2;
        const hh = entity.height / 2;
        const corners: Point[] = [
          entity.center,
          { x: entity.center.x - hw, y: entity.center.y + hh },
          { x: entity.center.x + hw, y: entity.center.y + hh },
          { x: entity.center.x + hw, y: entity.center.y - hh },
          { x: entity.center.x - hw, y: entity.center.y - hh },
        ];
        for (const pt of corners) {
          const sp = viewport.worldToScreen(pt);
          const d = distance(sp, screenPos);
          if (d < bestDist) {
            bestDist = d;
            bestEndpoint = pt;
            bestEntityId = entity.id;
            bestPointIndex = undefined;
          }
        }
      }
    }
  }

  if (bestEndpoint) {
    return { point: bestEndpoint, type: 'endpoint', entityId: bestEntityId, pointIndex: bestPointIndex };
  }

  // Fall back to grid snap
  return {
    point: {
      x: snapToGrid(worldPos.x, GRID_SPACING_MM),
      y: snapToGrid(worldPos.y, GRID_SPACING_MM),
    },
    type: 'grid',
  };
}
