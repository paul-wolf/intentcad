import type { Tool, ToolContext } from './types';
import type { BezierEntity, CircleEntity, DimensionEntity, LineEntity, Point, Entity } from '@/types/document';
import type { Renderer, Viewport } from '@/types/renderer';
import { useEditorStore } from '@/stores/editorStore';
import { useDocumentStore } from '@/stores/documentStore';
import { hitTestSegment, hitTestPoint } from '@/hittest/hitTest';
import type { SegmentHit, PointHit } from '@/hittest/hitTest';
import { drawDimension, computeAngleDimensionGeom, drawAngleDimension } from '@/rendering/dimensionRenderer';
import { DIMENSION_OFFSET_MM, PARALLEL_DOT_THRESHOLD, ANGLE_DIMENSION_ARC_RADIUS_MM, SELECTED_POINT_RADIUS, SNAP_INDICATOR_RADIUS } from '@/config';
import { getStyles } from '@/rendering/styles';
import { getThemePalette } from '@/theme';
import { getSegmentCount, getSegmentPointIndices, getEntitySegmentEndpoints } from '@/utils/lineSegments';
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

/** Compute the two-segment distance dimension geometry using any entity types (line or rectangle). */
function twoSegmentGeomForEntities(
  entity1: import('@/types/document').Entity,
  seg1Idx: number,
  entity2: import('@/types/document').Entity,
  seg2Idx: number,
): { a: Point; b: Point } | null {
  const ep1 = getEntitySegmentEndpoints(entity1, seg1Idx);
  const ep2 = getEntitySegmentEndpoints(entity2, seg2Idx);
  if (!ep1 || !ep2) return null;
  const [p1, p2] = ep1;
  const [q1, q2] = ep2;

  const a = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
  const dx = q2.x - q1.x;
  const dy = q2.y - q1.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return null;
  const t = ((a.x - q1.x) * dx + (a.y - q1.y) * dy) / lenSq;
  return { a, b: { x: q1.x + t * dx, y: q1.y + t * dy } };
}

function areEntitiesParallelSegs(entity1: import('@/types/document').Entity, seg1Idx: number, entity2: import('@/types/document').Entity, seg2Idx: number): boolean {
  const ep1 = getEntitySegmentEndpoints(entity1, seg1Idx);
  const ep2 = getEntitySegmentEndpoints(entity2, seg2Idx);
  if (!ep1 || !ep2) return false;
  return areSegmentsParallel(ep1[0], ep1[1], ep2[0], ep2[1]);
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
        if (firstEntity.type !== 'line' && firstEntity.type !== 'circle' && firstEntity.type !== 'rectangle') {
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

        // Support line + line, line + rectangle, rectangle + line, rectangle + rectangle
        if ((firstEntity.type !== 'line' && firstEntity.type !== 'rectangle') ||
            (targetEntity.type !== 'line' && targetEntity.type !== 'rectangle')) {
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

        const parallel = areEntitiesParallelSegs(firstEntity, firstHit.segmentIndex, targetEntity, hit.segmentIndex);

        if (!parallel && firstEntity.type === 'line' && targetEntity.type === 'line') {
          // Angle dimension (only meaningful for two lines)
          const ep1 = getEntitySegmentEndpoints(firstEntity, firstHit.segmentIndex);
          const ep2 = getEntitySegmentEndpoints(targetEntity, hit.segmentIndex);
          if (ep1 && ep2) {
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
          }
          firstTarget = null;
          return;
        }

        if (!parallel) {
          // Non-parallel rectangle combos — skip for now
          firstTarget = null;
          return;
        }

        // Parallel: distance dimension
        const geom = twoSegmentGeomForEntities(firstEntity, firstHit.segmentIndex, targetEntity, hit.segmentIndex);
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
      // Normalise so ptTarget is the point side and segTarget is the segment side
      const ptTarget = firstTarget.kind === 'point' ? firstTarget : target.kind === 'point' ? target : null;
      const segTarget = firstTarget.kind === 'segment' ? firstTarget : target.kind === 'segment' ? target : null;
      if (!ptTarget || !segTarget) { firstTarget = null; return; }

      const ptHit = ptTarget.hit as PointHit;
      const segHit = segTarget.hit as SegmentHit;

      const ptEntity = activeSketch.entities.find((e) => e.id === ptHit.entityId);
      const segEntity = activeSketch.entities.find((e) => e.id === segHit.entityId);
      if (!ptEntity || !segEntity) { firstTarget = null; return; }

      const ptPos = getEntityPoint(ptEntity, ptHit.pointIndex);
      const ep = getEntitySegmentEndpoints(segEntity, segHit.segmentIndex);
      if (!ptPos || !ep) { firstTarget = null; return; }

      const [q1, q2] = ep;
      const sdx = q2.x - q1.x;
      const sdy = q2.y - q1.y;
      const lenSq = sdx * sdx + sdy * sdy;
      if (lenSq === 0) { firstTarget = null; return; }
      const tProj = ((ptPos.x - q1.x) * sdx + (ptPos.y - q1.y) * sdy) / lenSq;
      const foot = { x: q1.x + tProj * sdx, y: q1.y + tProj * sdy };

      const abDx = foot.x - ptPos.x;
      const abDy = foot.y - ptPos.y;
      const cross = abDx * (worldPos.y - ptPos.y) - abDy * (worldPos.x - ptPos.x);
      const sign = cross >= 0 ? 1 : -1;

      useDocumentStore.getState().beginTransaction('Add dimension');
      useDocumentStore.getState().addEntity({
        id: crypto.randomUUID(),
        type: 'dimension',
        targetEntityId: ptHit.entityId,
        segmentIndex: 0,
        pointIndex: ptHit.pointIndex,
        offset: DIMENSION_OFFSET_MM * sign,
        targetEntityId2: segHit.entityId,
        segmentIndex2: segHit.segmentIndex,
      } as DimensionEntity);
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

      // Status hint
      const statusText = firstTarget
        ? 'Click second segment or endpoint — Esc to cancel'
        : 'Click segment or endpoint to start dimension';
      renderer.drawText(statusText, { x: 12, y: 18 }, { color: palette.textMuted, fontSize: 11, textAlign: 'left', textBaseline: 'top' });

      // Highlight first selected target
      if (firstTarget) {
        if (firstTarget.kind === 'point') {
          const entity1 = activeSketch.entities.find((e) => e.id === firstTarget!.hit.entityId);
          if (entity1) {
            const pt = getEntityPoint(entity1, (firstTarget.hit as PointHit).pointIndex);
            if (pt) {
              const sp = viewport.worldToScreen(pt);
              renderer.fillCircle(sp, SNAP_INDICATOR_RADIUS, palette.accent);
              renderer.drawCircle(sp, SELECTED_POINT_RADIUS + 4, { color: palette.accent, width: 2 });
            }
          }
        } else {
          const entity1 = activeSketch.entities.find((e) => e.id === firstTarget!.hit.entityId);
          const segHit = firstTarget.hit as SegmentHit;
          if (entity1) {
            const ep = getEntitySegmentEndpoints(entity1, segHit.segmentIndex);
            if (ep) {
              renderer.drawLine(viewport.worldToScreen(ep[0]), viewport.worldToScreen(ep[1]), { color: palette.accent, width: 3 });
            } else if (entity1.type === 'circle') {
              const sc = viewport.worldToScreen(entity1.center);
              const sr = entity1.radius * viewport.scale;
              renderer.drawArc(sc, sr, 0, Math.PI * 2, false, { color: palette.accent, width: 2.5 });
            } else if (entity1.type === 'bezier') {
              const bz = entity1 as BezierEntity;
              const [p0, p1, p2, p3] = bz.controlPoints.map((p) => viewport.worldToScreen(p));
              renderer.drawBezier(p0!, p1!, p2!, p3!, { color: palette.accent, width: 2.5 });
            }
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

        // If we have a first target that's a segment, preview the point-to-segment dimension
        if (firstTarget && firstTarget.kind === 'segment') {
          const firstSegHit = firstTarget.hit as SegmentHit;
          const firstSegEntity = activeSketch.entities.find((e) => e.id === firstSegHit.entityId);
          if (!firstSegEntity) return;
          const segEp = getEntitySegmentEndpoints(firstSegEntity, firstSegHit.segmentIndex);
          if (!segEp) return;
          const [q1, q2] = segEp;
          const sdx = q2.x - q1.x; const sdy = q2.y - q1.y;
          const sLenSq = sdx * sdx + sdy * sdy;
          if (sLenSq === 0) return;
          const tP = ((hoverPt.x - q1.x) * sdx + (hoverPt.y - q1.y) * sdy) / sLenSq;
          const foot = { x: q1.x + tP * sdx, y: q1.y + tP * sdy };
          renderer.setGlobalAlpha(0.4);
          drawDimension(renderer, viewport, { a: hoverPt, b: foot, offset: DIMENSION_OFFSET_MM }, styles.dimensionLine, styles.dimensionText, palette.background);
          renderer.resetGlobalAlpha();
        }
        return;
      }

      // --- Segment hover ---
      const hoverSegHit = hoverTarget.hit as SegmentHit;
      const targetEntity = activeSketch.entities.find((e) => e.id === hoverSegHit.entityId);
      if (!targetEntity || targetEntity.type === 'dimension' || targetEntity.type === 'point' || targetEntity.type === 'text') return;

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
      if (targetEntity.type === 'line' && (targetEntity as LineEntity).polygonCenter) {
        const exists = activeSketch.entities.some(
          (e) =>
            e.type === 'dimension' &&
            e.targetEntityId === hoverSegHit.entityId &&
            e.segmentIndex === -1,
        );
        if (exists) return;

        const lineEnt = targetEntity as LineEntity;
        const center = lineEnt.polygonCenter!;
        const midA = {
          x: (lineEnt.points[0]!.x + lineEnt.points[1]!.x) / 2,
          y: (lineEnt.points[0]!.y + lineEnt.points[1]!.y) / 2,
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

      // Point-to-segment preview: when firstTarget is a point, show ghost dimension to this segment
      if (firstTarget && firstTarget.kind === 'point') {
        const firstPtHit = firstTarget.hit as PointHit;
        const firstPtEntity = activeSketch.entities.find((e) => e.id === firstPtHit.entityId);
        if (firstPtEntity) {
          const ptPos = getEntityPoint(firstPtEntity, firstPtHit.pointIndex);
          const segEp = getEntitySegmentEndpoints(targetEntity, hoverSegHit.segmentIndex);
          if (ptPos && segEp) {
            const [q1, q2] = segEp;
            const sdx = q2.x - q1.x; const sdy = q2.y - q1.y;
            const sLenSq = sdx * sdx + sdy * sdy;
            if (sLenSq > 0) {
              const tP = ((ptPos.x - q1.x) * sdx + (ptPos.y - q1.y) * sdy) / sLenSq;
              const foot = { x: q1.x + tP * sdx, y: q1.y + tP * sdy };
              const hoverEp2 = getEntitySegmentEndpoints(targetEntity, hoverSegHit.segmentIndex);
              if (hoverEp2) renderer.drawLine(viewport.worldToScreen(hoverEp2[0]), viewport.worldToScreen(hoverEp2[1]), { color: palette.accent, width: 2, dash: [4, 3] });
              renderer.setGlobalAlpha(0.4);
              drawDimension(renderer, viewport, { a: ptPos, b: foot, offset: DIMENSION_OFFSET_MM }, styles.dimensionLine, styles.dimensionText, palette.background);
              renderer.resetGlobalAlpha();
            }
          }
        }
        return;
      }

      // Two-segment preview: when firstTarget is a segment, show ghost dimension
      if (firstTarget && firstTarget.kind === 'segment') {
        const firstSegHit = firstTarget.hit as SegmentHit;
        if (firstSegHit.entityId === hoverSegHit.entityId && firstSegHit.segmentIndex === hoverSegHit.segmentIndex) return;

        const entity1 = activeSketch.entities.find((e) => e.id === firstSegHit.entityId);
        if (!entity1) return;

        // Highlight the hovered segment so the user can see what they're about to select
        const hoverEp = getEntitySegmentEndpoints(targetEntity, hoverSegHit.segmentIndex);
        if (hoverEp) {
          renderer.drawLine(viewport.worldToScreen(hoverEp[0]), viewport.worldToScreen(hoverEp[1]), { color: palette.accent, width: 2, dash: [4, 3] });
        }

        const parallel = areEntitiesParallelSegs(entity1, firstSegHit.segmentIndex, targetEntity, hoverSegHit.segmentIndex);

        if (!parallel && entity1.type === 'line' && targetEntity.type === 'line') {
          const ep1 = getEntitySegmentEndpoints(entity1, firstSegHit.segmentIndex);
          const ep2 = getEntitySegmentEndpoints(targetEntity, hoverSegHit.segmentIndex);
          if (ep1 && ep2) {
            const angleGeom = computeAngleDimensionGeom(ep1[0], ep1[1], ep2[0], ep2[1], ANGLE_DIMENSION_ARC_RADIUS_MM);
            if (angleGeom) {
              renderer.setGlobalAlpha(0.4);
              drawAngleDimension(renderer, viewport, angleGeom, styles.dimensionLine, styles.dimensionText, palette.background);
              renderer.resetGlobalAlpha();
            }
          }
          return;
        }

        if (!parallel) return;

        const geom = twoSegmentGeomForEntities(entity1, firstSegHit.segmentIndex, targetEntity, hoverSegHit.segmentIndex);
        if (!geom) return;

        renderer.setGlobalAlpha(0.4);
        drawDimension(renderer, viewport, { a: geom.a, b: geom.b, offset: DIMENSION_OFFSET_MM }, styles.dimensionLine, styles.dimensionText, palette.background);
        renderer.resetGlobalAlpha();
        return;
      }

      // Highlight hovered segment when no first target yet
      const hoverEpSingle = getEntitySegmentEndpoints(targetEntity as Entity, hoverSegHit.segmentIndex);
      if (hoverEpSingle) {
        renderer.drawLine(viewport.worldToScreen(hoverEpSingle[0]), viewport.worldToScreen(hoverEpSingle[1]), { color: palette.accent, width: 2, dash: [4, 3] });
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
