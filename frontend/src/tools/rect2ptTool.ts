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

export function createRect2ptTool(): Tool {
  let currentSnap: SnapResult | null = null;

  const getToolState = () => {
    const ts = useEditorStore.getState().toolState;
    return ts.type === 'rect2pt' ? ts : null;
  };

  return {
    onMouseDown(worldPos: Point, _screenPos: Point, ctx: ToolContext) {
      const doc = useDocumentStore.getState().document;
      const snap = snapPosition(worldPos, ctx.viewport, doc);
      const ts = getToolState();
      if (!ts) return;

      if (ts.corner) {
        // Second click: compute center and dimensions from two corners
        const c1 = ts.corner;
        const c2 = snap.point;
        const rawW = Math.abs(c2.x - c1.x);
        const rawH = Math.abs(c2.y - c1.y);
        const width = snapToGrid(rawW, GRID_SPACING_MM);
        const height = snapToGrid(rawH, GRID_SPACING_MM);
        if (width <= 0 || height <= 0) return;

        const center: Point = {
          x: (c1.x + c2.x) / 2,
          y: (c1.y + c2.y) / 2,
        };

        useDocumentStore.getState().beginTransaction();
        const rectId = generateId('rec');
        useDocumentStore.getState().addEntity({
          id: rectId,
          type: 'rectangle',
          center,
          width,
          height,
          anchor: 'corner',
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
        // First click: set first corner
        useEditorStore.getState().setToolState({
          type: 'rect2pt',
          corner: snap.point,
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
        if (ts && ts.corner) {
          useEditorStore.getState().setToolState({ type: 'rect2pt', corner: null });
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

      if (ts?.corner) {
        const c1 = ts.corner;
        const c2 = currentSnap.point;
        const rawW = Math.abs(c2.x - c1.x);
        const rawH = Math.abs(c2.y - c1.y);
        const width = snapToGrid(rawW, GRID_SPACING_MM);
        const height = snapToGrid(rawH, GRID_SPACING_MM);
        if (width > 0 && height > 0) {
          const center: Point = {
            x: (c1.x + c2.x) / 2,
            y: (c1.y + c2.y) / 2,
          };
          const halfW = width / 2;
          const halfH = height / 2;
          const corners = [
            viewport.worldToScreen({ x: center.x - halfW, y: center.y + halfH }),
            viewport.worldToScreen({ x: center.x + halfW, y: center.y + halfH }),
            viewport.worldToScreen({ x: center.x + halfW, y: center.y - halfH }),
            viewport.worldToScreen({ x: center.x - halfW, y: center.y - halfH }),
          ];
          for (let i = 0; i < 4; i++) {
            renderer.drawLine(corners[i]!, corners[(i + 1) % 4]!, styles.preview);
          }

          // Corner dots at the two defining corners
          const c1Screen = viewport.worldToScreen(c1);
          renderer.fillCircle(c1Screen, ENDPOINT_RADIUS, styles.preview.color);
          renderer.fillCircle(snapScreen, ENDPOINT_RADIUS, styles.preview.color);

          // Preview dimensions
          renderer.setGlobalAlpha(0.4);
          // Width dimension along top edge
          drawDimension(
            renderer,
            viewport,
            {
              a: { x: center.x - halfW, y: center.y + halfH },
              b: { x: center.x + halfW, y: center.y + halfH },
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
              a: { x: center.x + halfW, y: center.y + halfH },
              b: { x: center.x + halfW, y: center.y - halfH },
              offset: DIMENSION_OFFSET_MM,
            },
            styles.dimensionLine,
            styles.dimensionText,
            palette.background,
          );
          renderer.resetGlobalAlpha();

          // Size text near cursor
          const sizeLabel = `${width.toFixed(1)} \u00d7 ${height.toFixed(1)}`;
          renderer.drawText(sizeLabel, { x: snapScreen.x + 15, y: snapScreen.y - 15 }, styles.dimensionText);
        }
      }
    },
  };
}
