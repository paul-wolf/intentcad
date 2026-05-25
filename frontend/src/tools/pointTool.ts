import type { Tool, ToolContext } from './types';
import type { Point } from '@/types/document';
import type { Renderer, Viewport } from '@/types/renderer';
import { useEditorStore } from '@/stores/editorStore';
import { useDocumentStore } from '@/stores/documentStore';
import { snapPosition, type SnapResult } from '@/snap/snap';
import { getStyles } from '@/rendering/styles';
import { getThemePalette } from '@/theme';
import { SNAP_INDICATOR_RADIUS } from '@/config';
import { generateId } from '@/utils/id';
import { requestSave } from '@/api/autoSave';

export function createPointTool(): Tool {
  let currentSnap: SnapResult | null = null;

  return {
    onMouseDown(worldPos: Point, _screenPos: Point, ctx: ToolContext) {
      const doc = useDocumentStore.getState().document;
      const snap = ctx.altKey ? { point: worldPos, type: 'grid' as const } : snapPosition(worldPos, ctx.viewport, doc);

      useDocumentStore.getState().beginTransaction('Add point');
      useDocumentStore.getState().addEntity({
        id: generateId('pt'),
        type: 'point',
        position: snap.point,
      });
      requestSave();
    },

    onMouseMove(worldPos: Point, _screenPos: Point, ctx: ToolContext) {
      const doc = useDocumentStore.getState().document;
      currentSnap = snapPosition(worldPos, ctx.viewport, doc);
    },

    onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        useEditorStore.getState().setActiveTool('select');
      }
    },

    renderOverlay(renderer: Renderer, viewport: Viewport) {
      if (!currentSnap) return;

      const snapScreen = viewport.worldToScreen(currentSnap.point);
      const palette = getThemePalette();
      const styles = getStyles(palette);

      // Snap indicator
      renderer.drawCircle(snapScreen, SNAP_INDICATOR_RADIUS, styles.snap);

      // Crosshair preview
      const size = 6;
      renderer.drawLine(
        { x: snapScreen.x - size, y: snapScreen.y },
        { x: snapScreen.x + size, y: snapScreen.y },
        styles.preview,
      );
      renderer.drawLine(
        { x: snapScreen.x, y: snapScreen.y - size },
        { x: snapScreen.x, y: snapScreen.y + size },
        styles.preview,
      );
    },
  };
}
