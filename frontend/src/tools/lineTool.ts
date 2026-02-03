import type { Tool, ToolContext } from './types';
import type { Point, LineEntity } from '@/types/document';
import type { Renderer, Viewport } from '@/types/renderer';
import { useEditorStore } from '@/stores/editorStore';
import { useDocumentStore } from '@/stores/documentStore';
import { snapPosition, type SnapResult } from '@/snap/snap';
import { getStyles } from '@/rendering/styles';
import { getThemePalette } from '@/theme';
import { SNAP_INDICATOR_RADIUS } from '@/config';
import { generateId } from '@/utils/id';
import { requestSave } from '@/api/autoSave';

/**
 * Check if a snap result targets the first or last point of a polyline.
 * Returns the end ('start' | 'end') if so, or null for middle points / non-endpoints.
 */
function getTerminalSnap(snap: SnapResult): { entityId: string; end: 'start' | 'end' } | null {
  if (snap.type !== 'endpoint' || snap.entityId == null || snap.pointIndex == null) return null;

  const sketch = useDocumentStore.getState().getActiveSketch();
  if (!sketch) return null;

  const entity = sketch.entities.find((e) => e.id === snap.entityId);
  if (!entity || entity.type !== 'line') return null;

  if (snap.pointIndex === 0) return { entityId: entity.id, end: 'start' };
  if (snap.pointIndex === entity.points.length - 1) return { entityId: entity.id, end: 'end' };

  return null; // middle point — no extension
}

export function createLineTool(): Tool {
  let currentSnap: SnapResult | null = null;

  const getToolState = () => {
    const ts = useEditorStore.getState().toolState;
    return ts.type === 'line' ? ts : null;
  };

  const setToolState = (patch: {
    firstPoint?: Point | null;
    activePolylineId?: string | null;
    activeEnd?: 'start' | 'end' | null;
  }) => {
    const current = getToolState();
    useEditorStore.getState().setToolState({
      type: 'line',
      firstPoint: patch.firstPoint !== undefined ? patch.firstPoint : current?.firstPoint ?? null,
      activePolylineId: patch.activePolylineId !== undefined ? patch.activePolylineId : current?.activePolylineId ?? null,
      activeEnd: patch.activeEnd !== undefined ? patch.activeEnd : current?.activeEnd ?? null,
    });
  };

  const resetState = () => {
    setToolState({ firstPoint: null, activePolylineId: null, activeEnd: null });
    currentSnap = null;
  };

  /**
   * Get the world-space point to draw the preview line from.
   * If we have an active polyline, read its terminal point from the store.
   * Otherwise use firstPoint.
   */
  const getDrawFromPoint = (): Point | null => {
    const ts = getToolState();
    if (!ts) return null;

    if (ts.activePolylineId) {
      const sketch = useDocumentStore.getState().getActiveSketch();
      if (!sketch) return null;
      const entity = sketch.entities.find((e) => e.id === ts.activePolylineId) as LineEntity | undefined;
      if (!entity) return null;
      return ts.activeEnd === 'start' ? entity.points[0]! : entity.points[entity.points.length - 1]!;
    }

    return ts.firstPoint;
  };

  return {
    onMouseDown(worldPos: Point, _screenPos: Point, ctx: ToolContext) {
      const doc = useDocumentStore.getState().document;
      const snap = snapPosition(worldPos, ctx.viewport, doc);
      const ts = getToolState();
      if (!ts) return;

      const { firstPoint, activePolylineId } = ts;

      if (activePolylineId) {
        // Already extending a polyline — append/prepend the new point
        useDocumentStore.getState().beginTransaction();
        useDocumentStore.getState().extendPolyline(activePolylineId, snap.point, ts.activeEnd!);
        requestSave();
        // activeEnd stays the same, polyline keeps growing from that end
        return;
      }

      if (firstPoint) {
        // Have a firstPoint but no active polyline — create new entity
        useDocumentStore.getState().beginTransaction();
        const id = generateId('ln');
        useDocumentStore.getState().addEntity({
          id,
          type: 'line',
          points: [firstPoint, snap.point],
        });
        setToolState({ firstPoint: null, activePolylineId: id, activeEnd: 'end' });
        requestSave();
        return;
      }

      // No active drawing — first click
      const terminal = getTerminalSnap(snap);
      if (terminal) {
        // Clicked a terminal point of an existing polyline → start extending it
        setToolState({ firstPoint: null, activePolylineId: terminal.entityId, activeEnd: terminal.end });
      } else {
        // Start a fresh polyline from this point
        setToolState({ firstPoint: snap.point, activePolylineId: null, activeEnd: null });
      }
    },

    onMouseMove(worldPos: Point, _screenPos: Point, ctx: ToolContext) {
      const doc = useDocumentStore.getState().document;
      currentSnap = snapPosition(worldPos, ctx.viewport, doc);
    },

    onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        const ts = getToolState();
        if (ts && !ts.firstPoint && !ts.activePolylineId) {
          // Already clean — switch to select tool
          useEditorStore.getState().setActiveTool('select');
        } else {
          resetState();
        }
      }
    },

    renderOverlay(renderer: Renderer, viewport: Viewport) {
      if (!currentSnap) return;

      const drawFrom = getDrawFromPoint();
      const snapScreen = viewport.worldToScreen(currentSnap.point);

      const styles = getStyles(getThemePalette());

      // Snap indicator
      renderer.drawCircle(snapScreen, SNAP_INDICATOR_RADIUS, styles.snap);

      // Preview line from current anchor to snap position
      if (drawFrom) {
        const startScreen = viewport.worldToScreen(drawFrom);
        renderer.drawLine(startScreen, snapScreen, styles.preview);
      }
    },
  };
}
