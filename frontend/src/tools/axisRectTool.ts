import type { Tool, ToolContext } from './types';
import type { Point } from '@/types/document';
import type { Renderer, Viewport } from '@/types/renderer';
import { useEditorStore } from '@/stores/editorStore';
import { useDocumentStore } from '@/stores/documentStore';
import { snapPosition, type SnapResult } from '@/snap/snap';
import { getStyles } from '@/rendering/styles';
import { getThemePalette } from '@/theme';
import { SNAP_INDICATOR_RADIUS, DIMENSION_OFFSET_MM, ENDPOINT_RADIUS } from '@/config';
import { generateId } from '@/utils/id';
import { distance } from '@/utils/geometry';
import { drawDimension } from '@/rendering/dimensionRenderer';
import { requestSave } from '@/api/autoSave';
import type { EqualConstraint, PerpendicularConstraint } from '@/types/document';

function computeCorners(
  axisStart: Point,
  axisEnd: Point,
  widthPoint: Point,
): { corners: Point[]; halfWidth: number; axisLen: number } | null {
  const dx = axisEnd.x - axisStart.x;
  const dy = axisEnd.y - axisStart.y;
  const axisLen = Math.sqrt(dx * dx + dy * dy);
  if (axisLen < 1e-6) return null;

  const ux = dx / axisLen;
  const uy = dy / axisLen;
  // Unit perpendicular (90° CCW from axis)
  const px = -uy;
  const py = ux;

  // Signed perpendicular distance from axis to widthPoint
  const toPoint = { x: widthPoint.x - axisStart.x, y: widthPoint.y - axisStart.y };
  const halfWidth = Math.abs(toPoint.x * px + toPoint.y * py);
  if (halfWidth < 1e-6) return null;

  return {
    corners: [
      { x: axisStart.x + halfWidth * px, y: axisStart.y + halfWidth * py },
      { x: axisEnd.x + halfWidth * px, y: axisEnd.y + halfWidth * py },
      { x: axisEnd.x - halfWidth * px, y: axisEnd.y - halfWidth * py },
      { x: axisStart.x - halfWidth * px, y: axisStart.y - halfWidth * py },
    ],
    halfWidth,
    axisLen,
  };
}

export function createAxisRectTool(): Tool {
  let currentSnap: SnapResult | null = null;

  const getToolState = () => {
    const ts = useEditorStore.getState().toolState;
    return ts.type === 'axisrect' ? ts : null;
  };

  return {
    onMouseDown(worldPos: Point, _screenPos: Point, ctx: ToolContext) {
      const doc = useDocumentStore.getState().document;
      const snap = ctx.altKey ? { point: worldPos, type: 'grid' as const } : snapPosition(worldPos, ctx.viewport, doc);
      const ts = getToolState();
      if (!ts) return;

      if (!ts.axisStart) {
        useEditorStore.getState().setToolState({ type: 'axisrect', axisStart: snap.point, axisEnd: null });
      } else if (!ts.axisEnd) {
        if (distance(snap.point, ts.axisStart) < 1e-6) return;
        useEditorStore.getState().setToolState({ type: 'axisrect', axisStart: ts.axisStart, axisEnd: snap.point });
      } else {
        const result = computeCorners(ts.axisStart, ts.axisEnd, snap.point);
        if (!result) return;

        useDocumentStore.getState().beginTransaction('Add axis rectangle');
        const lineId = generateId('lin');
        useDocumentStore.getState().addEntity({
          id: lineId,
          type: 'line',
          points: result.corners,
          closed: true,
        });
        useDocumentStore.getState().addEntity({
          id: generateId('dim'),
          type: 'dimension',
          targetEntityId: lineId,
          segmentIndex: 0,
          offset: DIMENSION_OFFSET_MM,
        });
        useDocumentStore.getState().addEntity({
          id: generateId('dim'),
          type: 'dimension',
          targetEntityId: lineId,
          segmentIndex: 1,
          offset: DIMENSION_OFFSET_MM,
        });
        // Equal opposite sides: seg0==seg2 (length), seg1==seg3 (width)
        const equalLen: EqualConstraint = {
          id: crypto.randomUUID(),
          type: 'equal',
          entityId: lineId,
          segmentIndex: 0,
          targetEntityId: lineId,
          targetSegmentIndex: 2,
        };
        const equalWid: EqualConstraint = {
          id: crypto.randomUUID(),
          type: 'equal',
          entityId: lineId,
          segmentIndex: 1,
          targetEntityId: lineId,
          targetSegmentIndex: 3,
        };
        // Perpendicular adjacent sides: seg0 ⊥ seg1 (one right angle → full rectangle)
        const perp: PerpendicularConstraint = {
          id: crypto.randomUUID(),
          type: 'perpendicular',
          entityId: lineId,
          segmentIndex: 0,
          targetEntityId: lineId,
          targetSegmentIndex: 1,
        };
        useDocumentStore.getState().addConstraint(equalLen);
        useDocumentStore.getState().addConstraint(equalWid);
        useDocumentStore.getState().addConstraint(perp);
        useEditorStore.getState().setActiveTool('select');
        requestSave();
      }
    },

    onMouseMove(worldPos: Point, _screenPos: Point, ctx: ToolContext) {
      const doc = useDocumentStore.getState().document;
      currentSnap = snapPosition(worldPos, ctx.viewport, doc);
    },

    onMouseUp(_worldPos: Point, _screenPos: Point, _ctx: ToolContext) {},

    onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        const ts = getToolState();
        if (ts?.axisEnd) {
          useEditorStore.getState().setToolState({ type: 'axisrect', axisStart: ts.axisStart, axisEnd: null });
        } else if (ts?.axisStart) {
          useEditorStore.getState().setToolState({ type: 'axisrect', axisStart: null, axisEnd: null });
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

      renderer.drawCircle(snapScreen, SNAP_INDICATOR_RADIUS, styles.snap);

      if (!ts?.axisStart) return;

      const axisStartScreen = viewport.worldToScreen(ts.axisStart);
      renderer.fillCircle(axisStartScreen, ENDPOINT_RADIUS, styles.preview.color);

      if (!ts.axisEnd) {
        // Phase 1: show axis preview
        renderer.drawLine(axisStartScreen, snapScreen, styles.preview);
        return;
      }

      // Phase 2: axis is set, show rectangle preview
      const axisEndScreen = viewport.worldToScreen(ts.axisEnd);
      renderer.fillCircle(axisEndScreen, ENDPOINT_RADIUS, styles.preview.color);
      renderer.drawLine(axisStartScreen, axisEndScreen, styles.construction);

      const result = computeCorners(ts.axisStart, ts.axisEnd, currentSnap.point);
      if (!result) return;

      const { corners, halfWidth, axisLen } = result;
      const cs = corners.map((c) => viewport.worldToScreen(c));
      for (let i = 0; i < 4; i++) {
        renderer.drawLine(cs[i]!, cs[(i + 1) % 4]!, styles.preview);
      }

      renderer.setGlobalAlpha(0.4);
      drawDimension(renderer, viewport,
        { a: corners[0]!, b: corners[1]!, offset: DIMENSION_OFFSET_MM },
        styles.dimensionLine, styles.dimensionText, palette.background);
      drawDimension(renderer, viewport,
        { a: corners[1]!, b: corners[2]!, offset: DIMENSION_OFFSET_MM },
        styles.dimensionLine, styles.dimensionText, palette.background);
      renderer.resetGlobalAlpha();

      const sizeLabel = `${axisLen.toFixed(1)} × ${(halfWidth * 2).toFixed(1)}`;
      renderer.drawText(sizeLabel, { x: snapScreen.x + 15, y: snapScreen.y - 15 }, styles.dimensionText);
    },
  };
}
