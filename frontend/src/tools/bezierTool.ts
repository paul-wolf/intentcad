import type { Tool, ToolContext } from './types';
import type { Point } from '@/types/document';
import type { Renderer, Viewport } from '@/types/renderer';
import { useEditorStore } from '@/stores/editorStore';
import { useDocumentStore } from '@/stores/documentStore';
import { snapPosition, type SnapResult } from '@/snap/snap';
import { getStyles } from '@/rendering/styles';
import { getThemePalette } from '@/theme';
import { SNAP_INDICATOR_RADIUS, ENDPOINT_RADIUS } from '@/config';
import { generateId } from '@/utils/id';

import { requestSave } from '@/api/autoSave';

export function createBezierTool(): Tool {
  let currentSnap: SnapResult | null = null;

  const getToolState = () => {
    const ts = useEditorStore.getState().toolState;
    return ts.type === 'bezier' ? ts : null;
  };

  return {
    onMouseDown(worldPos: Point, _screenPos: Point, ctx: ToolContext) {
      const doc = useDocumentStore.getState().document;
      const snap = ctx.altKey ? { point: worldPos, type: 'grid' as const } : snapPosition(worldPos, ctx.viewport, doc);
      const ts = getToolState();
      if (!ts) return;

      const pts = [...ts.points, snap.point];

      if (pts.length >= 4) {
        // All 4 points placed — create the bezier entity
        useDocumentStore.getState().beginTransaction('Add bezier');
        const bezId = generateId('bez');
        useDocumentStore.getState().addEntity({
          id: bezId,
          type: 'bezier',
          controlPoints: [pts[0]!, pts[1]!, pts[2]!, pts[3]!],
        });
        // Switch to select tool and auto-select the new entity
        useEditorStore.getState().setActiveTool('select');
        useEditorStore.getState().setSelectedEntityIds(new Set([bezId]));
        requestSave();
      } else {
        // Accumulate points
        useEditorStore.getState().setToolState({
          type: 'bezier',
          points: pts,
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
        if (ts && ts.points.length > 0) {
          // Clear accumulated points, stay in bezier tool
          useEditorStore.getState().setToolState({ type: 'bezier', points: [] });
          currentSnap = null;
        } else {
          // No points placed — switch to select tool
          useEditorStore.getState().setActiveTool('select');
        }
      }
    },

    renderOverlay(renderer: Renderer, viewport: Viewport) {
      if (!currentSnap) return;

      const ts = getToolState();
      const palette = getThemePalette();
      const styles = getStyles(palette);
      const snapScreen = viewport.worldToScreen(currentSnap.point);

      // Snap indicator
      renderer.drawCircle(snapScreen, SNAP_INDICATOR_RADIUS, styles.snap);

      if (!ts) return;
      const pts = ts.points;
      const hoverPt = currentSnap.point;

      // Build the current set of placed + hovering points
      const allPts = [...pts, hoverPt];

      // Draw placed point dots
      for (const p of pts) {
        const sp = viewport.worldToScreen(p);
        renderer.fillCircle(sp, ENDPOINT_RADIUS + 1, styles.preview.color);
      }

      // Draw handle lines for placed points
      if (allPts.length >= 2) {
        // P0→P1 handle line
        const sp0 = viewport.worldToScreen(allPts[0]!);
        const sp1 = viewport.worldToScreen(allPts[1]!);
        renderer.drawLine(sp0, sp1, { ...styles.preview, dash: [4, 3] });
      }
      if (allPts.length >= 4) {
        // P3→P2 handle line
        const sp3 = viewport.worldToScreen(allPts[3]!);
        const sp2 = viewport.worldToScreen(allPts[2]!);
        renderer.drawLine(sp3, sp2, { ...styles.preview, dash: [4, 3] });
      }

      // Draw the bezier curve preview when we have all 4 points
      if (allPts.length >= 4) {
        const s0 = viewport.worldToScreen(allPts[0]!);
        const s1 = viewport.worldToScreen(allPts[1]!);
        const s2 = viewport.worldToScreen(allPts[2]!);
        const s3 = viewport.worldToScreen(allPts[3]!);
        renderer.drawBezier(s0, s1, s2, s3, styles.preview);
      }

      // Labels showing current step
      const labels = ['P0 (start)', 'P1 (handle)', 'P2 (handle)', 'P3 (end)'];
      const stepIndex = pts.length; // index of the next point to be placed
      if (stepIndex < 4) {
        renderer.drawText(labels[stepIndex]!, { x: snapScreen.x + 15, y: snapScreen.y - 15 }, styles.dimensionText);
      }
    },
  };
}
