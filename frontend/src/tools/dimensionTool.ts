import type { Tool, ToolContext } from './types';
import type { CircleEntity, DimensionEntity, LineEntity, Point } from '@/types/document';
import type { Renderer, Viewport } from '@/types/renderer';
import { useEditorStore } from '@/stores/editorStore';
import { useDocumentStore } from '@/stores/documentStore';
import { hitTestSegment } from '@/hittest/hitTest';
import type { SegmentHit } from '@/hittest/hitTest';
import { drawDimension, computeAngleDimensionGeom, drawAngleDimension } from '@/rendering/dimensionRenderer';
import { DIMENSION_OFFSET_MM, PARALLEL_DOT_THRESHOLD, ANGLE_DIMENSION_ARC_RADIUS_MM } from '@/config';
import { getStyles } from '@/rendering/styles';
import { getThemePalette } from '@/theme';
import { getSegmentCount, getSegmentPointIndices } from '@/utils/lineSegments';

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

export function createDimensionTool(): Tool {
  let hoverSegment: SegmentHit | null = null;
  let firstSegment: SegmentHit | null = null;

  return {
    onMouseDown(worldPos: Point, screenPos: Point, ctx: ToolContext) {
      const activeSketch = useDocumentStore.getState().getActiveSketch();
      if (!activeSketch) return;

      const hit = hitTestSegment(screenPos, activeSketch.entities, ctx.viewport);
      if (!hit) return;

      const targetEntity = activeSketch.entities.find((e) => e.id === hit.entityId);
      if (!targetEntity || (targetEntity.type !== 'line' && targetEntity.type !== 'circle')) return;

      // Two-click workflow
      if (!firstSegment) {
        firstSegment = hit;
        return;
      }

      // Second click: if same entity+segment, create single-entity dimension
      if (firstSegment.entityId === hit.entityId && firstSegment.segmentIndex === hit.segmentIndex) {
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
          firstSegment = null;
          return;
        }

        // Polygon: create apothem dimension (segmentIndex -1)
        if ((targetEntity as LineEntity).polygonCenter) {
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
          firstSegment = null;
          return;
        }

        // Create single-segment dimension (same as original behavior)
        const exists = activeSketch.entities.some(
          (e) =>
            e.type === 'dimension' &&
            e.targetEntityId === hit.entityId &&
            e.segmentIndex === hit.segmentIndex &&
            !e.targetEntityId2,
        );
        if (exists) {
          firstSegment = null;
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
        firstSegment = null;
        return;
      }

      // Second click on a different entity
      const target1 = activeSketch.entities.find((e) => e.id === firstSegment!.entityId);
      if (!target1 || (target1.type !== 'line' && target1.type !== 'circle')) {
        firstSegment = null;
        return;
      }

      // Circle-to-circle: center distance dimension
      if (target1.type === 'circle' && targetEntity.type === 'circle') {
        const exists = activeSketch.entities.some((e) => {
          if (e.type !== 'dimension' || !e.targetEntityId2) return false;
          return (
            (e.targetEntityId === firstSegment!.entityId && e.targetEntityId2 === hit.entityId) ||
            (e.targetEntityId === hit.entityId && e.targetEntityId2 === firstSegment!.entityId)
          );
        });
        if (!exists) {
          const c1 = (target1 as CircleEntity).center;
          const c2 = (targetEntity as CircleEntity).center;
          const dx = c2.x - c1.x;
          const dy = c2.y - c1.y;
          const cross = dx * (worldPos.y - c1.y) - dy * (worldPos.x - c1.x);
          const sign = cross >= 0 ? 1 : -1;

          useDocumentStore.getState().beginTransaction('Add dimension');
          useDocumentStore.getState().addEntity({
            id: crypto.randomUUID(),
            type: 'dimension',
            targetEntityId: firstSegment!.entityId,
            segmentIndex: -1,
            offset: DIMENSION_OFFSET_MM * sign,
            targetEntityId2: hit.entityId,
            segmentIndex2: -1,
          } as DimensionEntity);
        }
        firstSegment = null;
        return;
      }

      // Mixed circle + non-circle: not supported yet
      if (target1.type === 'circle' || targetEntity.type === 'circle') {
        firstSegment = null;
        return;
      }

      // Duplicate check: prevent creating if one already exists for the same pair
      const exists = activeSketch.entities.some((e) => {
        if (e.type !== 'dimension' || !e.targetEntityId2) return false;
        return (
          (e.targetEntityId === firstSegment!.entityId &&
            e.segmentIndex === firstSegment!.segmentIndex &&
            e.targetEntityId2 === hit.entityId &&
            e.segmentIndex2 === hit.segmentIndex) ||
          (e.targetEntityId === hit.entityId &&
            e.segmentIndex === hit.segmentIndex &&
            e.targetEntityId2 === firstSegment!.entityId &&
            e.segmentIndex2 === firstSegment!.segmentIndex)
        );
      });
      if (exists) {
        firstSegment = null;
        return;
      }

      const [fs1, fs2] = getSegmentPointIndices(target1 as LineEntity, firstSegment.segmentIndex);
      const seg1p1 = (target1 as LineEntity).points[fs1]!;
      const seg1p2 = (target1 as LineEntity).points[fs2]!;
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
          targetEntityId: firstSegment.entityId,
          segmentIndex: firstSegment.segmentIndex,
          offset: ANGLE_DIMENSION_ARC_RADIUS_MM,
          targetEntityId2: hit.entityId,
          segmentIndex2: hit.segmentIndex,
          angleMode: true,
        } as DimensionEntity);
        firstSegment = null;
        return;
      }

      // Parallel: distance dimension
      const geom = twoSegmentGeom(
        (target1 as LineEntity).points,
        firstSegment.segmentIndex,
        (targetEntity as LineEntity).points,
        hit.segmentIndex,
      );
      if (!geom) {
        firstSegment = null;
        return;
      }

      // Determine offset sign from mouse position
      const abDx = geom.b.x - geom.a.x;
      const abDy = geom.b.y - geom.a.y;
      const cross = abDx * (worldPos.y - geom.a.y) - abDy * (worldPos.x - geom.a.x);
      const sign = cross >= 0 ? 1 : -1;

      useDocumentStore.getState().beginTransaction('Add dimension');
      useDocumentStore.getState().addEntity({
        id: crypto.randomUUID(),
        type: 'dimension',
        targetEntityId: firstSegment.entityId,
        segmentIndex: firstSegment.segmentIndex,
        offset: DIMENSION_OFFSET_MM * sign,
        targetEntityId2: hit.entityId,
        segmentIndex2: hit.segmentIndex,
      } as DimensionEntity);
      firstSegment = null;
    },

    onMouseMove(_worldPos: Point, screenPos: Point, ctx: ToolContext) {
      const activeSketch = useDocumentStore.getState().getActiveSketch();
      if (!activeSketch) {
        hoverSegment = null;
        return;
      }
      hoverSegment = hitTestSegment(screenPos, activeSketch.entities, ctx.viewport);
    },

    onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        if (firstSegment) {
          firstSegment = null;
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

      // Draw highlight on first selected entity
      if (firstSegment) {
        const entity1 = activeSketch.entities.find((e) => e.id === firstSegment!.entityId);
        if (entity1 && entity1.type === 'line') {
          const idx = firstSegment.segmentIndex;
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
        }
      }

      if (!hoverSegment) return;

      const targetEntity = activeSketch.entities.find((e) => e.id === hoverSegment!.entityId);
      if (!targetEntity || (targetEntity.type !== 'line' && targetEntity.type !== 'circle')) return;

      // Circle hover preview
      if (targetEntity.type === 'circle') {
        if (firstSegment) {
          // Preview circle-to-circle dimension
          if (firstSegment.entityId === hoverSegment.entityId) return;
          const entity1 = activeSketch.entities.find((e) => e.id === firstSegment!.entityId);
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
            e.targetEntityId === hoverSegment!.entityId &&
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

      // Two-segment preview: when firstSegment is set, show ghost dimension between the two segments
      if (firstSegment) {
        // Don't preview same segment
        if (firstSegment.entityId === hoverSegment.entityId && firstSegment.segmentIndex === hoverSegment.segmentIndex) return;

        const entity1 = activeSketch.entities.find((e) => e.id === firstSegment!.entityId);
        if (!entity1 || entity1.type !== 'line') return;

        const [rfs1, rfs2] = getSegmentPointIndices(entity1, firstSegment.segmentIndex);
        const seg1p1 = entity1.points[rfs1]!;
        const seg1p2 = entity1.points[rfs2]!;
        const [rhs1, rhs2] = getSegmentPointIndices(targetEntity as LineEntity, hoverSegment.segmentIndex);
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
          firstSegment.segmentIndex,
          (targetEntity as LineEntity).points,
          hoverSegment.segmentIndex,
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

      // Single-segment preview (no firstSegment set yet)
      const idx = hoverSegment.segmentIndex;
      if (idx < 0 || idx >= getSegmentCount(targetEntity as LineEntity)) return;

      // Check if dimension already exists for this segment
      const exists = activeSketch.entities.some(
        (e) =>
          e.type === 'dimension' &&
          e.targetEntityId === hoverSegment!.entityId &&
          e.segmentIndex === hoverSegment!.segmentIndex &&
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
