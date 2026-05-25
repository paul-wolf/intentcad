import type { Tool, ToolContext } from './types';
import type { Point } from '@/types/document';
import type { Renderer, Viewport } from '@/types/renderer';
import { useEditorStore } from '@/stores/editorStore';
import { useDocumentStore } from '@/stores/documentStore';
import { snapPosition, type SnapResult } from '@/snap/snap';
import { getStyles } from '@/rendering/styles';
import { getThemePalette } from '@/theme';
import { SNAP_INDICATOR_RADIUS, DIMENSION_OFFSET_MM, GRID_SPACING_MM, ENDPOINT_RADIUS } from '@/config';
import { generateId } from '@/utils/id';
import { snapToGrid } from '@/utils/geometry';
import { drawDimension } from '@/rendering/dimensionRenderer';
import { requestSave } from '@/api/autoSave';

export function createRectangleTool(): Tool {
  let currentSnap: SnapResult | null = null;

  const getToolState = () => {
    const ts = useEditorStore.getState().toolState;
    return ts.type === 'rectangle' ? ts : null;
  };

  return {
    onMouseDown(worldPos: Point, _screenPos: Point, ctx: ToolContext) {
      const doc = useDocumentStore.getState().document;
      const snap = ctx.altKey ? { point: worldPos, type: 'grid' as const } : snapPosition(worldPos, ctx.viewport, doc);
      const ts = getToolState();
      if (!ts) return;

      if (ts.center) {
        // Second click: place rectangle
        const rawHW = Math.abs(snap.point.x - ts.center.x);
        const rawHH = Math.abs(snap.point.y - ts.center.y);
        const halfW = snapToGrid(rawHW, GRID_SPACING_MM);
        const halfH = snapToGrid(rawHH, GRID_SPACING_MM);
        if (halfW <= 0 || halfH <= 0) return;

        const width = halfW * 2;
        const height = halfH * 2;

        useDocumentStore.getState().beginTransaction('Add rectangle');
        const rectId = generateId('rec');
        useDocumentStore.getState().addEntity({
          id: rectId,
          type: 'rectangle',
          center: ts.center,
          width,
          height,
          anchor: 'center',
        });
        // Auto-create width dimension (top edge)
        useDocumentStore.getState().addEntity({
          id: generateId('dim'),
          type: 'dimension',
          targetEntityId: rectId,
          segmentIndex: 0,
          offset: DIMENSION_OFFSET_MM,
        });
        // Auto-create height dimension (right edge)
        useDocumentStore.getState().addEntity({
          id: generateId('dim'),
          type: 'dimension',
          targetEntityId: rectId,
          segmentIndex: 1,
          offset: DIMENSION_OFFSET_MM,
        });
        // Switch to select tool
        useEditorStore.getState().setActiveTool('select');
        requestSave();
      } else {
        // First click: set center
        useEditorStore.getState().setToolState({
          type: 'rectangle',
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
          useEditorStore.getState().setToolState({ type: 'rectangle', center: null });
          currentSnap = null;
        } else {
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
        const rawHW = Math.abs(currentSnap.point.x - ts.center.x);
        const rawHH = Math.abs(currentSnap.point.y - ts.center.y);
        const halfW = snapToGrid(rawHW, GRID_SPACING_MM);
        const halfH = snapToGrid(rawHH, GRID_SPACING_MM);
        if (halfW > 0 && halfH > 0) {
          const c = ts.center;
          const corners = [
            viewport.worldToScreen({ x: c.x - halfW, y: c.y + halfH }),
            viewport.worldToScreen({ x: c.x + halfW, y: c.y + halfH }),
            viewport.worldToScreen({ x: c.x + halfW, y: c.y - halfH }),
            viewport.worldToScreen({ x: c.x - halfW, y: c.y - halfH }),
          ];
          for (let i = 0; i < 4; i++) {
            renderer.drawLine(corners[i]!, corners[(i + 1) % 4]!, styles.preview);
          }

          // Center dot
          const centerScreen = viewport.worldToScreen(c);
          renderer.fillCircle(centerScreen, ENDPOINT_RADIUS, styles.preview.color);

          // Preview dimensions
          const width = halfW * 2;
          const height = halfH * 2;
          renderer.setGlobalAlpha(0.4);
          // Width dimension along top edge
          drawDimension(
            renderer,
            viewport,
            {
              a: { x: c.x - halfW, y: c.y + halfH },
              b: { x: c.x + halfW, y: c.y + halfH },
              offset: DIMENSION_OFFSET_MM,
            },
            styles.dimensionLine,
            styles.dimensionText,
            palette.background,
          );
          // Height dimension along right edge
          drawDimension(
            renderer,
            viewport,
            {
              a: { x: c.x + halfW, y: c.y + halfH },
              b: { x: c.x + halfW, y: c.y - halfH },
              offset: DIMENSION_OFFSET_MM,
            },
            styles.dimensionLine,
            styles.dimensionText,
            palette.background,
          );
          renderer.resetGlobalAlpha();

          // Size text near cursor
          const sizeLabel = `${width.toFixed(1)} × ${height.toFixed(1)}`;
          renderer.drawText(sizeLabel, { x: snapScreen.x + 15, y: snapScreen.y - 15 }, styles.dimensionText);
        }
      }
    },
  };
}
