import type { Point, Document } from '@/types/document';
import { GRID_SPACING_MM, SNAP_RADIUS } from '@/config';
import { distance, snapToGrid, segmentSegmentIntersection } from '@/utils/geometry';
import { getSegmentCount, getSegmentPointIndices } from '@/utils/lineSegments';
import type { Viewport } from '@/types/renderer';
import { axisPoint, hiddenAxis, isAxis } from '@/utils/sketchAxes';

export interface SnapResult {
  point: Point;
  type: 'endpoint' | 'intersection' | 'circumference' | 'axis' | 'grid';
  entityId?: string;
  pointIndex?: number;
}

/**
 * Snap position with priority: endpoint (a sketch's origin among them) >
 * intersection (an axis crossing a line too) > circumference > on an axis >
 * grid. Hidden axes (utils/sketchAxes.ts) aren't snapped to.
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
      if (isAxis(entity)) {
        if (hiddenAxis(entity) || entity.type !== 'line' || sketch.id !== document.activeSketchId) continue;
        const pt = axisPoint(entity);
        const d = distance(viewport.worldToScreen(pt), screenPos);
        if (d < bestDist) {
          bestDist = d;
          bestEndpoint = pt;
          bestEntityId = undefined;
          bestPointIndex = undefined;
        }
        continue;
      }
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
      // only the active sketch's axes are drawn, so only they are snapped to
      if (isAxis(entity) && (hiddenAxis(entity) || sketch.id !== document.activeSketchId)) continue;
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

  // Onto an axis: the nearest point on it
  let bestAxis: { point: Point; entityId: string } | null = null;
  let bestAxisDist = SNAP_RADIUS;
  for (const sketch of document.sketches) {
    if (!sketch.visible || sketch.suppressed) continue;
    for (const entity of sketch.entities) {
      if (!isAxis(entity) || hiddenAxis(entity) || entity.type !== 'line' || excludeEntityIds?.has(entity.id)) continue;
      if (sketch.id !== document.activeSketchId) continue;
      const at = axisPoint(entity);
      const horizontal = Math.abs(entity.points[0]!.y - entity.points[1]!.y) < 1e-9;
      const point = horizontal ? { x: snapToGrid(worldPos.x, GRID_SPACING_MM), y: at.y } : { x: at.x, y: snapToGrid(worldPos.y, GRID_SPACING_MM) };
      const d = horizontal ? Math.abs(viewport.worldToScreen(at).y - screenPos.y) : Math.abs(viewport.worldToScreen(at).x - screenPos.x);
      if (d < bestAxisDist) {
        bestAxisDist = d;
        bestAxis = { point, entityId: entity.id };
      }
    }
  }
  if (bestAxis) return { point: bestAxis.point, type: 'axis', entityId: bestAxis.entityId };

  // Fall back to grid snap
  return {
    point: {
      x: snapToGrid(worldPos.x, GRID_SPACING_MM),
      y: snapToGrid(worldPos.y, GRID_SPACING_MM),
    },
    type: 'grid',
  };
}
