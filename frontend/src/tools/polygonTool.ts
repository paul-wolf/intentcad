import type { Tool, ToolContext } from './types';
import type { Point } from '@/types/document';
import type { Renderer, Viewport } from '@/types/renderer';
import { useEditorStore } from '@/stores/editorStore';
import { useDocumentStore } from '@/stores/documentStore';
import { snapPosition, type SnapResult } from '@/snap/snap';
import { getStyles } from '@/rendering/styles';
import { getThemePalette } from '@/theme';
import { SNAP_INDICATOR_RADIUS, GRID_SPACING_MM, ENDPOINT_RADIUS } from '@/config';
import { generateId } from '@/utils/id';
import { distance, snapToGrid } from '@/utils/geometry';
import { requestSave } from '@/api/autoSave';

function computePolygonPoints(center: Point, radius: number, sides: number): Point[] {
  const points: Point[] = [];
  for (let i = 0; i <= sides; i++) {
    const angle = (2 * Math.PI * (i % sides)) / sides - Math.PI / 2;
    points.push({
      x: center.x + radius * Math.cos(angle),
      y: center.y + radius * Math.sin(angle),
    });
  }
  return points;
}

export function createPolygonTool(): Tool {
  let currentSnap: SnapResult | null = null;

  const getToolState = () => {
    const ts = useEditorStore.getState().toolState;
    return ts.type === 'polygon' ? ts : null;
  };

  return {
    onMouseDown(worldPos: Point, _screenPos: Point, ctx: ToolContext) {
      const doc = useDocumentStore.getState().document;
      const snap = snapPosition(worldPos, ctx.viewport, doc);
      const ts = getToolState();
      if (!ts) return;

      if (ts.center) {
        // Second click: place polygon
        const rawRadius = distance(ts.center, snap.point);
        const radius = snapToGrid(rawRadius, GRID_SPACING_MM);
        if (radius <= 0) return;

        const points = computePolygonPoints(ts.center, radius, ts.sides);

        useDocumentStore.getState().beginTransaction();
        useDocumentStore.getState().addEntity({
          id: generateId('lin'),
          type: 'line',
          points,
        });
        useEditorStore.getState().setActiveTool('select');
        requestSave();
      } else {
        // First click: set center
        useEditorStore.getState().setToolState({
          type: 'polygon',
          center: snap.point,
          sides: ts.sides,
        });
      }
    },

    onMouseMove(worldPos: Point, _screenPos: Point, ctx: ToolContext) {
      const doc = useDocumentStore.getState().document;
      currentSnap = snapPosition(worldPos, ctx.viewport, doc);
    },

    onKeyDown(e: KeyboardEvent) {
      const ts = getToolState();
      if (!ts) return;

      if (e.key === 'Escape') {
        if (ts.center) {
          useEditorStore.getState().setToolState({ type: 'polygon', center: null, sides: ts.sides });
          currentSnap = null;
        } else {
          useEditorStore.getState().setActiveTool('select');
        }
        return;
      }

      if (e.key === 'ArrowUp') {
        e.preventDefault();
        const newSides = Math.min(ts.sides + 1, 64);
        useEditorStore.getState().setToolState({ ...ts, sides: newSides });
        return;
      }

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        const newSides = Math.max(ts.sides - 1, 3);
        useEditorStore.getState().setToolState({ ...ts, sides: newSides });
        return;
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

      // Side count label near cursor
      const sidesLabel = `${ts?.sides ?? 6} sides`;
      renderer.drawText(sidesLabel, { x: snapScreen.x + 15, y: snapScreen.y - 15 }, styles.dimensionText);

      if (ts?.center) {
        const rawRadius = distance(ts.center, currentSnap.point);
        const radius = snapToGrid(rawRadius, GRID_SPACING_MM);
        if (radius > 0) {
          const points = computePolygonPoints(ts.center, radius, ts.sides);

          // Draw preview polygon edges
          for (let i = 0; i < points.length - 1; i++) {
            const a = viewport.worldToScreen(points[i]!);
            const b = viewport.worldToScreen(points[i + 1]!);
            renderer.drawLine(a, b, styles.preview);
          }

          // Center dot
          const centerScreen = viewport.worldToScreen(ts.center);
          renderer.fillCircle(centerScreen, ENDPOINT_RADIUS, styles.preview.color);
        }
      }
    },
  };
}
