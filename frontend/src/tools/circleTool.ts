import type { Tool, ToolContext } from './types';
import type { Point } from '@/types/document';
import type { Renderer, Viewport } from '@/types/renderer';
import { useEditorStore } from '@/stores/editorStore';
import { useDocumentStore } from '@/stores/documentStore';
import { snapPosition, type SnapResult } from '@/snap/snap';
import { getStyles } from '@/rendering/styles';
import { getThemePalette } from '@/theme';
import { SNAP_INDICATOR_RADIUS, DIMENSION_OFFSET_MM, GRID_SPACING_MM } from '@/config';
import { generateId } from '@/utils/id';
import { distance, snapToGrid } from '@/utils/geometry';
import { drawDiameterDimension } from '@/rendering/dimensionRenderer';
import { requestSave } from '@/api/autoSave';

export function createCircleTool(): Tool {
  let currentSnap: SnapResult | null = null;

  const getToolState = () => {
    const ts = useEditorStore.getState().toolState;
    return ts.type === 'circle' ? ts : null;
  };

  return {
    onMouseDown(worldPos: Point, _screenPos: Point, ctx: ToolContext) {
      const doc = useDocumentStore.getState().document;
      const snap = ctx.altKey ? { point: worldPos, type: 'grid' as const } : snapPosition(worldPos, ctx.viewport, doc);
      const ts = getToolState();
      if (!ts) return;

      if (ts.center) {
        // Second click: place circle
        const rawRadius = distance(ts.center, snap.point);
        const radius = snapToGrid(rawRadius, GRID_SPACING_MM);
        if (radius <= 0) return;

        useDocumentStore.getState().beginTransaction('Add circle');
        const circleId = generateId('cir');
        const dimId = generateId('dim');
        useDocumentStore.getState().addEntity({
          id: circleId,
          type: 'circle',
          center: ts.center,
          radius,
        });
        // Auto-create diameter dimension
        useDocumentStore.getState().addEntity({
          id: dimId,
          type: 'dimension',
          targetEntityId: circleId,
          segmentIndex: 0,
          offset: DIMENSION_OFFSET_MM,
        });
        // Switch to select tool and enter dimension edit mode
        useEditorStore.getState().setActiveTool('select');
        useEditorStore.getState().setSelectedEntityIds(new Set([circleId]));
        // Delay opening editor to ensure entities are rendered
        setTimeout(() => {
          useEditorStore.getState().setEditingDimensionId(dimId);
        }, 0);
        requestSave();
      } else {
        // First click: set center
        useEditorStore.getState().setToolState({
          type: 'circle',
          center: snap.point,
        });
      }
    },

    onMouseMove(worldPos: Point, _screenPos: Point, ctx: ToolContext) {
      const doc = useDocumentStore.getState().document;
      currentSnap = snapPosition(worldPos, ctx.viewport, doc);
    },

    onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        const ts = getToolState();
        if (ts && ts.center) {
          // Clear center, stay in circle tool
          useEditorStore.getState().setToolState({ type: 'circle', center: null });
          currentSnap = null;
        } else {
          // No center set — switch to select tool
          useEditorStore.getState().setActiveTool('select');
        }
      }
    },

    renderOverlay(renderer: Renderer, viewport: Viewport) {
      if (!currentSnap) return;

      const ts = getToolState();
      const snapScreen = viewport.worldToScreen(currentSnap.point);
      const palette = getThemePalette();
      const styles = getStyles(palette);

      // Snap indicator
      renderer.drawCircle(snapScreen, SNAP_INDICATOR_RADIUS, styles.snap);

      if (ts?.center) {
        // Preview circle
        const centerScreen = viewport.worldToScreen(ts.center);
        const rawRadius = distance(ts.center, currentSnap.point);
        const radius = snapToGrid(rawRadius, GRID_SPACING_MM);
        if (radius > 0) {
          const screenRadius = radius * viewport.scale;
          renderer.drawCircle(centerScreen, screenRadius, styles.preview);

          // Preview diameter dimension
          renderer.setGlobalAlpha(0.4);
          drawDiameterDimension(
            renderer,
            viewport,
            ts.center,
            radius,
            DIMENSION_OFFSET_MM,
            styles.dimensionLine,
            styles.dimensionText,
            palette.background,
          );
          renderer.resetGlobalAlpha();

          // Diameter text near cursor
          const diamLabel = `\u2300${(radius * 2).toFixed(1)}`;
          renderer.drawText(diamLabel, { x: snapScreen.x + 15, y: snapScreen.y - 15 }, styles.dimensionText);
        }
      }
    },
  };
}
