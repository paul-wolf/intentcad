import type { Tool, ToolContext } from './types';
import type { LineEntity, Point } from '@/types/document';
import type { Renderer, Viewport } from '@/types/renderer';
import { useEditorStore } from '@/stores/editorStore';
import { useDocumentStore } from '@/stores/documentStore';
import { hitTestSegment } from '@/hittest/hitTest';
import type { SegmentHit } from '@/hittest/hitTest';
import { drawDimension } from '@/rendering/dimensionRenderer';
import { DIMENSION_OFFSET_MM } from '@/config';
import { getStyles } from '@/rendering/styles';
import { getThemePalette } from '@/theme';

export function createDimensionTool(): Tool {
  let hoverSegment: SegmentHit | null = null;

  return {
    onMouseDown(worldPos: Point, screenPos: Point, ctx: ToolContext) {
      const activeSketch = useDocumentStore.getState().getActiveSketch();
      if (!activeSketch) return;

      const hit = hitTestSegment(screenPos, activeSketch.entities, ctx.viewport);
      if (!hit) return;

      const targetEntity = activeSketch.entities.find((e) => e.id === hit.entityId);
      if (!targetEntity || targetEntity.type !== 'line') return;

      // Polygon: create a radius dimension (segmentIndex -1)
      if ((targetEntity as LineEntity).polygonCenter) {
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

      // Check no existing dimension for this segment already
      const exists = activeSketch.entities.some(
        (e) =>
          e.type === 'dimension' &&
          e.targetEntityId === hit.entityId &&
          e.segmentIndex === hit.segmentIndex,
      );
      if (exists) return;

      const a = targetEntity.points[hit.segmentIndex]!;
      const b = targetEntity.points[hit.segmentIndex + 1]!;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      // Cross product of (B-A) x (mouse-A)
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
        useEditorStore.getState().setActiveTool('select');
      }
    },

    renderOverlay(renderer: Renderer, viewport: Viewport) {
      if (!hoverSegment) return;

      const activeSketch = useDocumentStore.getState().getActiveSketch();
      if (!activeSketch) return;

      const targetEntity = activeSketch.entities.find((e) => e.id === hoverSegment!.entityId);
      if (!targetEntity || targetEntity.type !== 'line') return;

      // Polygon: preview radius dimension
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
        const palette = getThemePalette();
        const styles = getStyles(palette);
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

      const idx = hoverSegment.segmentIndex;
      if (idx < 0 || idx >= targetEntity.points.length - 1) return;

      // Check if dimension already exists for this segment
      const exists = activeSketch.entities.some(
        (e) =>
          e.type === 'dimension' &&
          e.targetEntityId === hoverSegment!.entityId &&
          e.segmentIndex === hoverSegment!.segmentIndex,
      );
      if (exists) return;

      const a = targetEntity.points[idx]!;
      const b = targetEntity.points[idx + 1]!;

      const palette = getThemePalette();
      const styles = getStyles(palette);
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
