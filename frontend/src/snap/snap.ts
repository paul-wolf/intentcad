import type { Point, Document } from '@/types/document';
import { GRID_SPACING_MM, SNAP_RADIUS } from '@/config';
import { distance, snapToGrid, segmentSegmentIntersection } from '@/utils/geometry';
import { getSegmentCount, getSegmentPointIndices } from '@/utils/lineSegments';
import type { Viewport } from '@/types/renderer';

export interface SnapResult {
  point: Point;
  type: 'endpoint' | 'intersection' | 'circumference' | 'grid';
  entityId?: string;
  pointIndex?: number;
}

/**
 * Snap position with priority: endpoint > grid.
 * Distances are compared in screen space.
 * @param excludeEntityIds - Optional set of entity IDs to exclude from snap targets (e.g., when moving entities)
 */
export function snapPosition(
  worldPos: Point,
  viewport: Viewport,
  document: Document,
  excludeEntityIds?: Set<string>,
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
      // Skip excluded entities (e.g., entities being moved)
      if (excludeEntityIds?.has(entity.id)) continue;
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
      if (entity.type === 'bezier') {
        // Snap to on-curve endpoints only (P0 and P3), not handles
        const endpoints = [entity.controlPoints[0], entity.controlPoints[3]];
        for (let i = 0; i < endpoints.length; i++) {
          const pt = endpoints[i]!;
          const sp = viewport.worldToScreen(pt);
          const d = distance(sp, screenPos);
          if (d < bestDist) {
            bestDist = d;
            bestEndpoint = pt;
            bestEntityId = entity.id;
            bestPointIndex = i === 0 ? 0 : 3;
          }
        }
      }
    }
  }

  let bestType: 'endpoint' | 'intersection' = 'endpoint';

  // Check all segment-segment intersections
  const segments: { p1: Point; p2: Point }[] = [];
  for (const sketch of document.sketches) {
    if (!sketch.visible || sketch.suppressed) continue;
    for (const entity of sketch.entities) {
      // Skip excluded entities (e.g., entities being moved)
      if (excludeEntityIds?.has(entity.id)) continue;
      if (entity.type === 'line') {
        const count = getSegmentCount(entity);
        for (let s = 0; s < count; s++) {
          const [i0, i1] = getSegmentPointIndices(entity, s);
          segments.push({ p1: entity.points[i0]!, p2: entity.points[i1]! });
        }
      }
    }
  }
  for (let i = 0; i < segments.length; i++) {
    for (let j = i + 1; j < segments.length; j++) {
      const ix = segmentSegmentIntersection(
        segments[i]!.p1, segments[i]!.p2,
        segments[j]!.p1, segments[j]!.p2,
      );
      if (!ix) continue;
      const sp = viewport.worldToScreen(ix);
      const d = distance(sp, screenPos);
      if (d < bestDist) {
        bestDist = d;
        bestEndpoint = ix;
        bestEntityId = undefined;
        bestPointIndex = undefined;
        bestType = 'intersection';
      }
    }
  }

  if (bestEndpoint) {
    return { point: bestEndpoint, type: bestType, entityId: bestEntityId, pointIndex: bestPointIndex };
  }

  // Check circle circumferences (lower priority than endpoints/intersections, higher than grid)
  let bestCircSnap: Point | null = null;
  let bestCircDist = SNAP_RADIUS;
  let bestCircEntityId: string | undefined;

  for (const sketch of document.sketches) {
    if (!sketch.visible || sketch.suppressed) continue;
    for (const entity of sketch.entities) {
      if (excludeEntityIds?.has(entity.id)) continue;
      if (entity.type === 'circle') {
        const screenCenter = viewport.worldToScreen(entity.center);
        const screenRadius = entity.radius * viewport.scale;
        const dToCenter = distance(screenPos, screenCenter);
        const dToEdge = Math.abs(dToCenter - screenRadius);
        if (dToEdge < bestCircDist && dToCenter > 0.001) {
          bestCircDist = dToEdge;
          // Nearest point on circumference in world space
          const dx = worldPos.x - entity.center.x;
          const dy = worldPos.y - entity.center.y;
          const len = Math.sqrt(dx * dx + dy * dy);
          bestCircSnap = {
            x: entity.center.x + (dx / len) * entity.radius,
            y: entity.center.y + (dy / len) * entity.radius,
          };
          bestCircEntityId = entity.id;
        }
      }
    }
  }

  if (bestCircSnap) {
    return { point: bestCircSnap, type: 'circumference', entityId: bestCircEntityId };
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
