import type { Tool, ToolContext } from './types';
import type { Entity, Point } from '@/types/document';
import type { Renderer, Viewport } from '@/types/renderer';
import { useEditorStore } from '@/stores/editorStore';
import { useDocumentStore } from '@/stores/documentStore';
import { hitTestEntities, hitTestPoint } from '@/hittest/hitTest';
import type { PointHit } from '@/hittest/hitTest';
import { segmentIntersectsRect, circleIntersectsRect } from '@/utils/geometry';
import { getThemePalette } from '@/theme';
import { distance } from '@/utils/geometry';

const DRAG_THRESHOLD = 4; // screen pixels before starting drag

export function createSelectTool(): Tool {
  let mouseDownScreen: Point | null = null;
  let dragStartWorld: Point | null = null;
  let dragEndWorld: Point | null = null;

  let hitEntityOnDown: Entity | null = null;
  let hitPointOnDown: PointHit | null = null;
  let dragMode: 'box-select' | 'move' | 'move-point' | null = null;
  let lastMoveWorld: Point | null = null;

  const resetDrag = () => {
    mouseDownScreen = null;
    dragStartWorld = null;
    dragEndWorld = null;
    hitEntityOnDown = null;
    hitPointOnDown = null;
    dragMode = null;
    lastMoveWorld = null;
    useEditorStore.getState().setToolState({
      type: 'select',
      dragStart: null,
      dragEnd: null,
    });
  };

  return {
    onMouseDown(worldPos: Point, screenPos: Point, ctx: ToolContext) {
      mouseDownScreen = screenPos;
      dragStartWorld = worldPos;
      lastMoveWorld = worldPos;
      dragMode = null;

      const activeSketch = useDocumentStore.getState().getActiveSketch();
      if (activeSketch) {
        hitPointOnDown = hitTestPoint(screenPos, activeSketch.entities, ctx.viewport);
        hitEntityOnDown = hitPointOnDown
          ? null
          : hitTestEntities(screenPos, activeSketch.entities, ctx.viewport, activeSketch.entities);
      } else {
        hitPointOnDown = null;
        hitEntityOnDown = null;
      }
    },

    onMouseMove(worldPos: Point, screenPos: Point, _ctx: ToolContext) {
      if (!mouseDownScreen) return;

      // Decide drag mode at threshold
      if (dragMode === null && distance(screenPos, mouseDownScreen) > DRAG_THRESHOLD) {
        if (hitPointOnDown) {
          dragMode = 'move-point';
          useDocumentStore.getState().beginTransaction();
        } else if (hitEntityOnDown) {
          dragMode = 'move';
          useDocumentStore.getState().beginTransaction();
          const selectedIds = useEditorStore.getState().selectedEntityIds;
          if (!selectedIds.has(hitEntityOnDown.id)) {
            useEditorStore.getState().setSelectedEntityIds(new Set([hitEntityOnDown.id]));
          }
        } else {
          dragMode = 'box-select';
        }
      }

      if (dragMode === 'move-point' && lastMoveWorld && hitPointOnDown) {
        const delta = { x: worldPos.x - lastMoveWorld.x, y: worldPos.y - lastMoveWorld.y };
        useDocumentStore.getState().movePoint(hitPointOnDown.entityId, hitPointOnDown.pointIndex, delta);
        lastMoveWorld = worldPos;
      }

      if (dragMode === 'move' && lastMoveWorld) {
        const delta = { x: worldPos.x - lastMoveWorld.x, y: worldPos.y - lastMoveWorld.y };
        const selectedIds = useEditorStore.getState().selectedEntityIds;
        if (selectedIds.size > 0) {
          useDocumentStore.getState().moveEntities([...selectedIds], delta);
        }
        lastMoveWorld = worldPos;
      }

      if (dragMode === 'box-select') {
        dragEndWorld = worldPos;
        useEditorStore.getState().setToolState({
          type: 'select',
          dragStart: dragStartWorld,
          dragEnd: dragEndWorld,
        });
      }
    },

    onMouseUp(worldPos: Point, screenPos: Point, ctx: ToolContext) {
      if (dragMode === 'box-select' && dragStartWorld) {
        // Box select
        const minX = Math.min(dragStartWorld.x, worldPos.x);
        const minY = Math.min(dragStartWorld.y, worldPos.y);
        const maxX = Math.max(dragStartWorld.x, worldPos.x);
        const maxY = Math.max(dragStartWorld.y, worldPos.y);

        const activeSketch = useDocumentStore.getState().getActiveSketch();
        if (activeSketch) {
          const ids = new Set<string>();
          for (const entity of activeSketch.entities) {
            if (entity.type === 'line') {
              for (let i = 0; i < entity.points.length - 1; i++) {
                if (
                  segmentIntersectsRect(
                    entity.points[i]!,
                    entity.points[i + 1]!,
                    { x: minX, y: minY },
                    { x: maxX, y: maxY },
                  )
                ) {
                  ids.add(entity.id);
                  break;
                }
              }
            }
            if (entity.type === 'circle') {
              if (circleIntersectsRect(entity.center, entity.radius, { x: minX, y: minY }, { x: maxX, y: maxY })) {
                ids.add(entity.id);
              }
            }
          }
          useEditorStore.getState().setSelectedEntityIds(ids);
        }
      } else if (dragMode === null) {
        // Click select (no drag occurred)
        const activeSketch = useDocumentStore.getState().getActiveSketch();
        if (activeSketch) {
          const hit = hitTestEntities(screenPos, activeSketch.entities, ctx.viewport, activeSketch.entities);
          if (hit) {
            useEditorStore.getState().setSelectedEntityIds(new Set([hit.id]));
          } else {
            useEditorStore.getState().clearSelection();
          }
        }
      }
      // dragMode === 'move' → nothing to do, positions already applied incrementally
      resetDrag();
    },

    onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        useEditorStore.getState().clearSelection();
        resetDrag();
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        const ids = useEditorStore.getState().selectedEntityIds;
        if (ids.size > 0) {
          useDocumentStore.getState().beginTransaction();
          useDocumentStore.getState().removeEntities([...ids]);
          useEditorStore.getState().clearSelection();
        }
      }
    },

    renderOverlay(renderer: Renderer, viewport: Viewport) {
      const ts = useEditorStore.getState().toolState;
      if (ts.type !== 'select' || !ts.dragStart || !ts.dragEnd) return;

      const a = viewport.worldToScreen(ts.dragStart);
      const b = viewport.worldToScreen(ts.dragEnd);

      const topLeft = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y) };
      const size = {
        x: Math.abs(b.x - a.x),
        y: Math.abs(b.y - a.y),
      };

      const palette = getThemePalette();
      renderer.drawRect(topLeft, size, palette.selectionRect, {
        color: palette.selectionRectBorder,
        width: 1,
      });
    },
  };
}
