import type { Tool, ToolContext } from './types';
import type { DimensionEntity, LineEntity, Point } from '@/types/document';
import type { Renderer, Viewport } from '@/types/renderer';
import { useEditorStore } from '@/stores/editorStore';
import { useDocumentStore } from '@/stores/documentStore';
import { hitTestSegment } from '@/hittest/hitTest';
import type { SegmentHit } from '@/hittest/hitTest';
import { drawDimension } from '@/rendering/dimensionRenderer';
import { DIMENSION_OFFSET_MM } from '@/config';
import { getStyles } from '@/rendering/styles';
import { getThemePalette } from '@/theme';

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
      if (!targetEntity || targetEntity.type !== 'line') return;

      // Polygon: create a radius dimension (segmentIndex -1) — single-click, no two-click state
      if ((targetEntity as LineEntity).polygonCenter) {
        firstSegment = null; // reset any pending first segment
        const exists = activeSketch.entities.some(
          (e) =>
            e.type === 'dimension' &&
            e.targetEntityId === hit.entityId &&
            e.segmentIndex === -1,
        );
        if (exists) return;

        useDocumentStore.getState().beginTransaction();
        useDocumentStore.getState().addEntity({
          id: crypto.randomUUID(),
          type: 'dimension',
          targetEntityId: hit.entityId,
          segmentIndex: -1,
          offset: DIMENSION_OFFSET_MM,
        });
        return;
      }

      // Two-click workflow for line segments
      if (!firstSegment) {
        // First click: store the segment
        firstSegment = hit;
        return;
      }

      // Second click: if same entity+segment, fall through to single-segment dimension
      if (firstSegment.entityId === hit.entityId && firstSegment.segmentIndex === hit.segmentIndex) {
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

        const a = targetEntity.points[hit.segmentIndex]!;
        const b = targetEntity.points[hit.segmentIndex + 1]!;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const cross = dx * (worldPos.y - a.y) - dy * (worldPos.x - a.x);
        const sign = cross >= 0 ? 1 : -1;

        useDocumentStore.getState().beginTransaction();
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

      // Second click on a different segment: create two-segment distance dimension
      const target1 = activeSketch.entities.find((e) => e.id === firstSegment!.entityId);
      if (!target1 || target1.type !== 'line') {
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

      const geom = twoSegmentGeom(
        target1.points,
        firstSegment.segmentIndex,
        targetEntity.points,
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

      useDocumentStore.getState().beginTransaction();
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

      // Draw highlight on first selected segment
      if (firstSegment) {
        const entity1 = activeSketch.entities.find((e) => e.id === firstSegment!.entityId);
        if (entity1 && entity1.type === 'line') {
          const idx = firstSegment.segmentIndex;
          if (idx >= 0 && idx < entity1.points.length - 1) {
            const sa = viewport.worldToScreen(entity1.points[idx]!);
            const sb = viewport.worldToScreen(entity1.points[idx + 1]!);
            renderer.drawLine(sa, sb, { color: palette.accent, width: 2.5 });
          }
        }
      }

      if (!hoverSegment) return;

      const targetEntity = activeSketch.entities.find((e) => e.id === hoverSegment!.entityId);
      if (!targetEntity || targetEntity.type !== 'line') return;

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

        const geom = twoSegmentGeom(
          entity1.points,
          firstSegment.segmentIndex,
          targetEntity.points,
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
      if (idx < 0 || idx >= targetEntity.points.length - 1) return;

      // Check if dimension already exists for this segment
      const exists = activeSketch.entities.some(
        (e) =>
          e.type === 'dimension' &&
          e.targetEntityId === hoverSegment!.entityId &&
          e.segmentIndex === hoverSegment!.segmentIndex &&
          !e.targetEntityId2,
      );
      if (exists) return;

      const a = targetEntity.points[idx]!;
      const b = targetEntity.points[idx + 1]!;

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
