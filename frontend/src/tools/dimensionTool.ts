import type { Tool, ToolContext } from './types';
import type { BezierEntity, CircleEntity, DimensionEntity, LineEntity, Point } from '@/types/document';
import type { Renderer, Viewport } from '@/types/renderer';
import { useEditorStore } from '@/stores/editorStore';
import { useDocumentStore } from '@/stores/documentStore';
import { hitTestSegment, hitTestPoint } from '@/hittest/hitTest';
import type { SegmentHit, PointHit } from '@/hittest/hitTest';
import { drawDimension, computeAngleDimensionGeom, drawAngleDimension } from '@/rendering/dimensionRenderer';
import { DIMENSION_OFFSET_MM, PARALLEL_DOT_THRESHOLD, ANGLE_DIMENSION_ARC_RADIUS_MM, SELECTED_POINT_RADIUS } from '@/config';
import { getStyles } from '@/rendering/styles';
import { getThemePalette } from '@/theme';
import { getSegmentCount, getSegmentPointIndices } from '@/utils/lineSegments';
import { getEntityPoint } from '@/utils/entityPoints';

type DimTarget =
  | { kind: 'segment'; hit: SegmentHit }
  | { kind: 'point'; hit: PointHit };

/** Check if two segments are approximately parallel (within ~5 degrees). */
function areSegmentsParallel(p1: Point, p2: Point, q1: Point, q2: Point): boolean {
  const d1x = p2.x - p1.x;
  const d1y = p2.y - p1.y;
  const d2x = q2.x - q1.x;
  const d2y = q2.y - q1.y;
  const len1 = Math.sqrt(d1x * d1x + d1y * d1y);
  const len2 = Math.sqrt(d2x * d2x + d2y * d2y);
  if (len1 === 0 || len2 === 0) return true;
  const dot = (d1x * d2x + d1y * d2y) / (len1 * len2);
  return Math.abs(dot) > PARALLEL_DOT_THRESHOLD;
}

/** Compute the two-segment distance dimension geometry: a = midpoint of S1, b = perpendicular projection of a onto the line through S2. */
function twoSegmentGeom(
  target1Points: Point[],
  seg1Idx: number,
  target2Points: Point[],
  seg2Idx: number,
): { a: Point; b: Point } | null {
  const p1 = target1Points[seg1Idx];
  const p2 = target1Points[seg1Idx + 1];
  const q1 = target2Points[seg2Idx];
  const q2 = target2Points[seg2Idx + 1];
  if (!p1 || !p2 || !q1 || !q2) return null;

  const a = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };

  // Project a onto infinite line through q1-q2
  const dx = q2.x - q1.x;
  const dy = q2.y - q1.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return null;
  const t = ((a.x - q1.x) * dx + (a.y - q1.y) * dy) / lenSq;
  const b = { x: q1.x + t * dx, y: q1.y + t * dy };

  return { a, b };
}

/** Try to hit-test a point first, then fall back to segment. Returns a DimTarget or null. */
function hitTestDimTarget(screenPos: Point, entities: import('@/types/document').Entity[], viewport: Viewport): DimTarget | null {
  const ptHit = hitTestPoint(screenPos, entities, viewport);
  if (ptHit && ptHit.pointIndex >= 0) {
    // Valid vertex (pointIndex >= 0 excludes arc midpoints which are encoded as negative)
    return { kind: 'point', hit: ptHit };
  }
  const segHit = hitTestSegment(screenPos, entities, viewport);
  if (segHit) {
    return { kind: 'segment', hit: segHit };
  }
  return null;
}

export function createDimensionTool(): Tool {
  let hoverTarget: DimTarget | null = null;
  let firstTarget: DimTarget | null = null;

  return {
    onMouseDown(worldPos: Point, screenPos: Point, ctx: ToolContext) {
      const activeSketch = useDocumentStore.getState().getActiveSketch();
      if (!activeSketch) return;

      const target = hitTestDimTarget(screenPos, activeSketch.entities, ctx.viewport);
      if (!target) return;

      // Validate the hit entity exists and is a geometry type
      const targetEntity = activeSketch.entities.find((e) => e.id === (target.kind === 'point' ? target.hit.entityId : target.hit.entityId));
      if (!targetEntity || targetEntity.type === 'dimension') return;

      // First click: store the target
      if (!firstTarget) {
        firstTarget = target;
        return;
      }

      // Second click: create dimension based on target combination
      const firstEntity = activeSketch.entities.find((e) => e.id === (firstTarget!.kind === 'point' ? firstTarget!.hit.entityId : firstTarget!.hit.entityId));
      if (!firstEntity) {
        firstTarget = null;
        return;
      }

      // === POINT + POINT ===
      if (firstTarget.kind === 'point' && target.kind === 'point') {
        const pt1 = firstTarget.hit;
        const pt2 = target.hit;

        // Same entity, same point: no-op (a point has no length)
        if (pt1.entityId === pt2.entityId && pt1.pointIndex === pt2.pointIndex) {
          firstTarget = null;
          return;
        }

        const a = getEntityPoint(firstEntity, pt1.pointIndex);
        const b = getEntityPoint(targetEntity, pt2.pointIndex);
        if (!a || !b) {
          firstTarget = null;
          return;
        }

        // Offset sign from mouse position
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const cross = dx * (worldPos.y - a.y) - dy * (worldPos.x - a.x);
        const sign = cross >= 0 ? 1 : -1;

        const sameEntity = pt1.entityId === pt2.entityId;

        useDocumentStore.getState().beginTransaction('Add dimension');
        useDocumentStore.getState().addEntity({
          id: crypto.randomUUID(),
          type: 'dimension',
          targetEntityId: pt1.entityId,
          segmentIndex: 0,
          pointIndex: pt1.pointIndex,
          offset: DIMENSION_OFFSET_MM * sign,
          ...(sameEntity
            ? { pointIndex2: pt2.pointIndex }
            : { targetEntityId2: pt2.entityId, segmentIndex2: 0, pointIndex2: pt2.pointIndex }),
        } as DimensionEntity);
        firstTarget = null;
        return;
      }

      // === SEGMENT + SEGMENT (existing behavior) ===
      if (firstTarget.kind === 'segment' && target.kind === 'segment') {
        const hit = target.hit;
        const firstHit = firstTarget.hit;

        // Same entity+segment: single-entity dimension
        if (firstHit.entityId === hit.entityId && firstHit.segmentIndex === hit.segmentIndex) {
          // Circle: create diameter dimension
          if (targetEntity.type === 'circle') {
            const exists = activeSketch.entities.some(
              (e) =>
                e.type === 'dimension' &&
                e.targetEntityId === hit.entityId &&
                !e.targetEntityId2,
            );
            if (!exists) {
              useDocumentStore.getState().beginTransaction('Add dimension');
              useDocumentStore.getState().addEntity({
                id: crypto.randomUUID(),
                type: 'dimension',
                targetEntityId: hit.entityId,
                segmentIndex: -1,
                offset: DIMENSION_OFFSET_MM,
              });
            }
            firstTarget = null;
            return;
          }

          // Polygon: create apothem dimension (segmentIndex -1)
          if (targetEntity.type === 'line' && (targetEntity as LineEntity).polygonCenter) {
            const exists = activeSketch.entities.some(
              (e) =>
                e.type === 'dimension' &&
                e.targetEntityId === hit.entityId &&
                e.segmentIndex === -1,
            );
            if (!exists) {
              useDocumentStore.getState().beginTransaction('Add dimension');
              useDocumentStore.getState().addEntity({
                id: crypto.randomUUID(),
                type: 'dimension',
                targetEntityId: hit.entityId,
                segmentIndex: -1,
                offset: DIMENSION_OFFSET_MM,
              });
            }
            firstTarget = null;
            return;
          }

          // Bezier: create start-to-end dimension (control points 0 → 3)
          if (targetEntity.type === 'bezier') {
            const bz = targetEntity as BezierEntity;
            const exists = activeSketch.entities.some(
              (e) =>
                e.type === 'dimension' &&
                e.targetEntityId === hit.entityId &&
                !e.targetEntityId2,
            );
            if (!exists) {
              const a = bz.controlPoints[0]!;
              const b = bz.controlPoints[3]!;
              const dx = b.x - a.x;
              const dy = b.y - a.y;
              const cross = dx * (worldPos.y - a.y) - dy * (worldPos.x - a.x);
              const sign = cross >= 0 ? 1 : -1;

              useDocumentStore.getState().beginTransaction('Add dimension');
              useDocumentStore.getState().addEntity({
                id: crypto.randomUUID(),
                type: 'dimension',
                targetEntityId: hit.entityId,
                segmentIndex: 0,
                pointIndex: 0,
                pointIndex2: 3,
                offset: DIMENSION_OFFSET_MM * sign,
              });
            }
            firstTarget = null;
            return;
          }

          if (targetEntity.type !== 'line') {
            firstTarget = null;
            return;
          }

          // Create single-segment dimension
          const exists = activeSketch.entities.some(
            (e) =>
              e.type === 'dimension' &&
              e.targetEntityId === hit.entityId &&
              e.segmentIndex === hit.segmentIndex &&
              !e.targetEntityId2,
          );
          if (exists) {
            firstTarget = null;
            return;
          }

          const [hsi1, hsi2] = getSegmentPointIndices(targetEntity as LineEntity, hit.segmentIndex);
          const a = (targetEntity as LineEntity).points[hsi1]!;
          const b = (targetEntity as LineEntity).points[hsi2]!;
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const cross = dx * (worldPos.y - a.y) - dy * (worldPos.x - a.x);
          const sign = cross >= 0 ? 1 : -1;

          useDocumentStore.getState().beginTransaction('Add dimension');
          useDocumentStore.getState().addEntity({
            id: crypto.randomUUID(),
            type: 'dimension',
            targetEntityId: hit.entityId,
            segmentIndex: hit.segmentIndex,
            offset: DIMENSION_OFFSET_MM * sign,
          });
          firstTarget = null;
          return;
        }

        // Different entity: two-segment dimension
        if (firstEntity.type !== 'line' && firstEntity.type !== 'circle') {
          firstTarget = null;
          return;
        }

        // Circle-to-circle: center distance dimension
        if (firstEntity.type === 'circle' && targetEntity.type === 'circle') {
          const exists = activeSketch.entities.some((e) => {
            if (e.type !== 'dimension' || !e.targetEntityId2) return false;
            return (
              (e.targetEntityId === firstHit.entityId && e.targetEntityId2 === hit.entityId) ||
              (e.targetEntityId === hit.entityId && e.targetEntityId2 === firstHit.entityId)
            );
          });
          if (!exists) {
            const c1 = (firstEntity as CircleEntity).center;
            const c2 = (targetEntity as CircleEntity).center;
            const dx = c2.x - c1.x;
            const dy = c2.y - c1.y;
            const cross = dx * (worldPos.y - c1.y) - dy * (worldPos.x - c1.x);
            const sign = cross >= 0 ? 1 : -1;

            useDocumentStore.getState().beginTransaction('Add dimension');
            useDocumentStore.getState().addEntity({
              id: crypto.randomUUID(),
              type: 'dimension',
              targetEntityId: firstHit.entityId,
              segmentIndex: -1,
              offset: DIMENSION_OFFSET_MM * sign,
              targetEntityId2: hit.entityId,
              segmentIndex2: -1,
            } as DimensionEntity);
          }
          firstTarget = null;
          return;
        }

        // Mixed circle + non-circle: not supported yet
        if (firstEntity.type === 'circle' || targetEntity.type === 'circle') {
          firstTarget = null;
          return;
        }

        if (firstEntity.type !== 'line' || targetEntity.type !== 'line') {
          firstTarget = null;
          return;
        }

        // Duplicate check
        const exists = activeSketch.entities.some((e) => {
          if (e.type !== 'dimension' || !e.targetEntityId2) return false;
          return (
            (e.targetEntityId === firstHit.entityId &&
              e.segmentIndex === firstHit.segmentIndex &&
              e.targetEntityId2 === hit.entityId &&
              e.segmentIndex2 === hit.segmentIndex) ||
            (e.targetEntityId === hit.entityId &&
              e.segmentIndex === hit.segmentIndex &&
              e.targetEntityId2 === firstHit.entityId &&
              e.segmentIndex2 === firstHit.segmentIndex)
          );
        });
        if (exists) {
          firstTarget = null;
          return;
        }

        const [fs1, fs2] = getSegmentPointIndices(firstEntity, firstHit.segmentIndex);
        const seg1p1 = firstEntity.points[fs1]!;
        const seg1p2 = firstEntity.points[fs2]!;
        const [hs1, hs2] = getSegmentPointIndices(targetEntity as LineEntity, hit.segmentIndex);
        const seg2p1 = (targetEntity as LineEntity).points[hs1]!;
        const seg2p2 = (targetEntity as LineEntity).points[hs2]!;
        const parallel = areSegmentsParallel(seg1p1, seg1p2, seg2p1, seg2p2);

        if (!parallel) {
          // Angle dimension
          useDocumentStore.getState().beginTransaction('Add dimension');
          useDocumentStore.getState().addEntity({
            id: crypto.randomUUID(),
            type: 'dimension',
            targetEntityId: firstHit.entityId,
            segmentIndex: firstHit.segmentIndex,
            offset: ANGLE_DIMENSION_ARC_RADIUS_MM,
            targetEntityId2: hit.entityId,
            segmentIndex2: hit.segmentIndex,
            angleMode: true,
          } as DimensionEntity);
          firstTarget = null;
          return;
        }

        // Parallel: distance dimension
        const geom = twoSegmentGeom(
          firstEntity.points,
          firstHit.segmentIndex,
          (targetEntity as LineEntity).points,
          hit.segmentIndex,
        );
        if (!geom) {
          firstTarget = null;
          return;
        }

        const abDx = geom.b.x - geom.a.x;
        const abDy = geom.b.y - geom.a.y;
        const cross = abDx * (worldPos.y - geom.a.y) - abDy * (worldPos.x - geom.a.x);
        const sign = cross >= 0 ? 1 : -1;

        useDocumentStore.getState().beginTransaction('Add dimension');
        useDocumentStore.getState().addEntity({
          id: crypto.randomUUID(),
          type: 'dimension',
          targetEntityId: firstHit.entityId,
          segmentIndex: firstHit.segmentIndex,
          offset: DIMENSION_OFFSET_MM * sign,
          targetEntityId2: hit.entityId,
          segmentIndex2: hit.segmentIndex,
        } as DimensionEntity);
        firstTarget = null;
        return;
      }

      // === MIXED: POINT + SEGMENT or SEGMENT + POINT ===
      // Not supported for now — reset
      firstTarget = null;
    },

    onMouseMove(_worldPos: Point, screenPos: Point, ctx: ToolContext) {
      const activeSketch = useDocumentStore.getState().getActiveSketch();
      if (!activeSketch) {
        hoverTarget = null;
        return;
      }
      hoverTarget = hitTestDimTarget(screenPos, activeSketch.entities, ctx.viewport);
    },

    onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        if (firstTarget) {
          firstTarget = null;
        } else {
          useEditorStore.getState().setActiveTool('select');
        }
      }
    },

    renderOverlay(renderer: Renderer, viewport: Viewport) {
      const activeSketch = useDocumentStore.getState().getActiveSketch();
      if (!activeSketch) return;

      const palette = getThemePalette();
      const styles = getStyles(palette);

      // Draw highlight on first selected target
      if (firstTarget) {
        if (firstTarget.kind === 'point') {
          const entity1 = activeSketch.entities.find((e) => e.id === firstTarget!.hit.entityId);
          if (entity1) {
            const pt = getEntityPoint(entity1, (firstTarget.hit as PointHit).pointIndex);
            if (pt) {
              const sp = viewport.worldToScreen(pt);
              renderer.drawCircle(sp, SELECTED_POINT_RADIUS + 2, { color: palette.accent, width: 2 });
            }
          }
        } else {
          const entity1 = activeSketch.entities.find((e) => e.id === firstTarget!.hit.entityId);
          const segHit = firstTarget.hit as SegmentHit;
          if (entity1 && entity1.type === 'line') {
            const idx = segHit.segmentIndex;
            if (idx >= 0 && idx < getSegmentCount(entity1)) {
              const [dti1, dti2] = getSegmentPointIndices(entity1, idx);
              const sa = viewport.worldToScreen(entity1.points[dti1]!);
              const sb = viewport.worldToScreen(entity1.points[dti2]!);
              renderer.drawLine(sa, sb, { color: palette.accent, width: 2.5 });
            }
          } else if (entity1 && entity1.type === 'circle') {
            const sc = viewport.worldToScreen(entity1.center);
            const sr = entity1.radius * viewport.scale;
            renderer.drawArc(sc, sr, 0, Math.PI * 2, false, { color: palette.accent, width: 2.5 });
          } else if (entity1 && entity1.type === 'bezier') {
            const bz = entity1 as BezierEntity;
            const [p0, p1, p2, p3] = bz.controlPoints.map((p) => viewport.worldToScreen(p));
            renderer.drawBezier(p0!, p1!, p2!, p3!, { color: palette.accent, width: 2.5 });
          }
        }
      }

      if (!hoverTarget) return;

      // --- Point hover ---
      if (hoverTarget.kind === 'point') {
        const hoverPtHit = hoverTarget.hit as PointHit;
        const hoverEntity = activeSketch.entities.find((e) => e.id === hoverPtHit.entityId);
        if (!hoverEntity) return;
        const hoverPt = getEntityPoint(hoverEntity, hoverPtHit.pointIndex);
        if (!hoverPt) return;

        // Draw hover circle on the vertex
        const sp = viewport.worldToScreen(hoverPt);
        renderer.drawCircle(sp, SELECTED_POINT_RADIUS + 2, { color: palette.accent, width: 1.5 });

        // If we have a first target that's a point, preview the point-to-point dimension
        if (firstTarget && firstTarget.kind === 'point') {
          const firstPtHit = firstTarget.hit as PointHit;
          // Same point: no preview
          if (firstPtHit.entityId === hoverPtHit.entityId && firstPtHit.pointIndex === hoverPtHit.pointIndex) return;

          const firstEntity = activeSketch.entities.find((e) => e.id === firstPtHit.entityId);
          if (!firstEntity) return;
          const a = getEntityPoint(firstEntity, firstPtHit.pointIndex);
          if (!a) return;

          renderer.setGlobalAlpha(0.4);
          drawDimension(
            renderer,
            viewport,
            { a, b: hoverPt, offset: DIMENSION_OFFSET_MM },
            styles.dimensionLine,
            styles.dimensionText,
            palette.background,
          );
          renderer.resetGlobalAlpha();
        }
        return;
      }

      // --- Segment hover (existing behavior) ---
      const hoverSegHit = hoverTarget.hit as SegmentHit;
      const targetEntity = activeSketch.entities.find((e) => e.id === hoverSegHit.entityId);
      if (!targetEntity || (targetEntity.type !== 'line' && targetEntity.type !== 'circle' && targetEntity.type !== 'bezier')) return;

      // Bezier hover: preview start-to-end dimension
      if (targetEntity.type === 'bezier') {
        const bz = targetEntity as BezierEntity;
        const [p0, p1, p2, p3] = bz.controlPoints.map((p) => viewport.worldToScreen(p));
        renderer.drawBezier(p0!, p1!, p2!, p3!, { color: palette.accent, width: 1.5, opacity: 0.6 });

        if (!firstTarget) {
          // Preview the start-to-end dimension
          const exists = activeSketch.entities.some(
            (e) =>
              e.type === 'dimension' &&
              e.targetEntityId === hoverSegHit.entityId &&
              !e.targetEntityId2,
          );
          if (!exists) {
            const a = bz.controlPoints[0]!;
            const b = bz.controlPoints[3]!;
            renderer.setGlobalAlpha(0.4);
            drawDimension(
              renderer,
              viewport,
              { a, b, offset: DIMENSION_OFFSET_MM },
              styles.dimensionLine,
              styles.dimensionText,
              palette.background,
            );
            renderer.resetGlobalAlpha();
          }
        }
        return;
      }

      // Circle hover preview
      if (targetEntity.type === 'circle') {
        if (firstTarget && firstTarget.kind === 'segment') {
          // Preview circle-to-circle dimension
          if (firstTarget.hit.entityId === hoverSegHit.entityId) return;
          const entity1 = activeSketch.entities.find((e) => e.id === firstTarget!.hit.entityId);
          if (!entity1 || entity1.type !== 'circle') return;
          const c1 = (entity1 as CircleEntity).center;
          const c2 = (targetEntity as CircleEntity).center;
          renderer.setGlobalAlpha(0.4);
          drawDimension(
            renderer,
            viewport,
            { a: c1, b: c2, offset: DIMENSION_OFFSET_MM },
            styles.dimensionLine,
            styles.dimensionText,
            palette.background,
          );
          renderer.resetGlobalAlpha();
        }
        return;
      }

      // Polygon: preview radius dimension (single-click behavior)
      if ((targetEntity as LineEntity).polygonCenter) {
        const exists = activeSketch.entities.some(
          (e) =>
            e.type === 'dimension' &&
            e.targetEntityId === hoverSegHit.entityId &&
            e.segmentIndex === -1,
        );
        if (exists) return;

        const center = (targetEntity as LineEntity).polygonCenter!;
        const midA = {
          x: (targetEntity.points[0]!.x + targetEntity.points[1]!.x) / 2,
          y: (targetEntity.points[0]!.y + targetEntity.points[1]!.y) / 2,
        };
        renderer.setGlobalAlpha(0.4);
        drawDimension(
          renderer,
          viewport,
          { a: center, b: midA, offset: DIMENSION_OFFSET_MM },
          styles.dimensionLine,
          styles.dimensionText,
          palette.background,
        );
        renderer.resetGlobalAlpha();
        return;
      }

      // Two-segment preview: when firstTarget is a segment, show ghost dimension
      if (firstTarget && firstTarget.kind === 'segment') {
        const firstSegHit = firstTarget.hit as SegmentHit;
        // Don't preview same segment
        if (firstSegHit.entityId === hoverSegHit.entityId && firstSegHit.segmentIndex === hoverSegHit.segmentIndex) return;

        const entity1 = activeSketch.entities.find((e) => e.id === firstSegHit.entityId);
        if (!entity1 || entity1.type !== 'line') return;

        const [rfs1, rfs2] = getSegmentPointIndices(entity1, firstSegHit.segmentIndex);
        const seg1p1 = entity1.points[rfs1]!;
        const seg1p2 = entity1.points[rfs2]!;
        const [rhs1, rhs2] = getSegmentPointIndices(targetEntity as LineEntity, hoverSegHit.segmentIndex);
        const seg2p1 = (targetEntity as LineEntity).points[rhs1]!;
        const seg2p2 = (targetEntity as LineEntity).points[rhs2]!;
        const parallel = areSegmentsParallel(seg1p1, seg1p2, seg2p1, seg2p2);

        if (!parallel) {
          // Angle preview
          const angleGeom = computeAngleDimensionGeom(seg1p1, seg1p2, seg2p1, seg2p2, ANGLE_DIMENSION_ARC_RADIUS_MM);
          if (angleGeom) {
            renderer.setGlobalAlpha(0.4);
            drawAngleDimension(
              renderer,
              viewport,
              angleGeom,
              styles.dimensionLine,
              styles.dimensionText,
              palette.background,
            );
            renderer.resetGlobalAlpha();
          }
          return;
        }

        const geom = twoSegmentGeom(
          entity1.points,
          firstSegHit.segmentIndex,
          (targetEntity as LineEntity).points,
          hoverSegHit.segmentIndex,
        );
        if (!geom) return;

        renderer.setGlobalAlpha(0.4);
        drawDimension(
          renderer,
          viewport,
          { a: geom.a, b: geom.b, offset: DIMENSION_OFFSET_MM },
          styles.dimensionLine,
          styles.dimensionText,
          palette.background,
        );
        renderer.resetGlobalAlpha();
        return;
      }

      // Single-segment preview (no firstTarget set yet)
      if (targetEntity.type !== 'line') return;
      const idx = hoverSegHit.segmentIndex;
      if (idx < 0 || idx >= getSegmentCount(targetEntity as LineEntity)) return;

      // Check if dimension already exists for this segment
      const exists = activeSketch.entities.some(
        (e) =>
          e.type === 'dimension' &&
          e.targetEntityId === hoverSegHit.entityId &&
          e.segmentIndex === hoverSegHit.segmentIndex &&
          !e.targetEntityId2,
      );
      if (exists) return;

      const [dai, dbi] = getSegmentPointIndices(targetEntity as LineEntity, idx);
      const a = (targetEntity as LineEntity).points[dai]!;
      const b = (targetEntity as LineEntity).points[dbi]!;

      renderer.setGlobalAlpha(0.4);
      drawDimension(
        renderer,
        viewport,
        { a, b, offset: DIMENSION_OFFSET_MM },
        styles.dimensionLine,
        styles.dimensionText,
        palette.background,
      );
      renderer.resetGlobalAlpha();
    },
  };
}
