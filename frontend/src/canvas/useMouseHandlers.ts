import { useCallback, useRef, type RefObject } from 'react';
import type { ViewportImpl } from '@/rendering/viewport';
import type { Tool } from '@/tools/types';
import type { ToolContext } from '@/tools/types';
import { useEditorStore } from '@/stores/editorStore';

export function useMouseHandlers(
  canvasRef: RefObject<HTMLCanvasElement | null>,
  viewportRef: RefObject<ViewportImpl | null>,
  getActiveTool: () => Tool | null,
) {
  const setCursorWorld = useEditorStore((s) => s.setCursorWorld);
  const lastScreenPos = useRef({ x: 0, y: 0 });

  const getToolContext = useCallback((e?: React.MouseEvent): ToolContext | null => {
    const viewport = viewportRef.current;
    if (!viewport) return null;
    return {
      viewport,
      screenToWorld: (p) => viewport.screenToWorld(p),
      worldToScreen: (p) => viewport.worldToScreen(p),
      shiftKey: e?.shiftKey || e?.metaKey,
    };
  }, [viewportRef]);

  const getCanvasPos = useCallback(
    (e: React.MouseEvent): { x: number; y: number } => {
      const canvas = canvasRef.current;
      if (!canvas) return { x: 0, y: 0 };
      const rect = canvas.getBoundingClientRect();
      return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    },
    [canvasRef],
  );

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (useEditorStore.getState().editingDimensionId) return;
      const screenPos = getCanvasPos(e);
      const ctx = getToolContext(e);
      if (!ctx) return;
      const worldPos = ctx.screenToWorld(screenPos);
      lastScreenPos.current = screenPos;
      getActiveTool()?.onMouseDown?.(worldPos, screenPos, ctx);
    },
    [getCanvasPos, getToolContext, getActiveTool],
  );

  const onMouseMove = useCallback(
    (e: React.MouseEvent) => {
      const screenPos = getCanvasPos(e);
      const ctx = getToolContext(e);
      if (!ctx) return;
      const worldPos = ctx.screenToWorld(screenPos);
      lastScreenPos.current = screenPos;
      setCursorWorld(worldPos);
      getActiveTool()?.onMouseMove?.(worldPos, screenPos, ctx);
    },
    [getCanvasPos, getToolContext, getActiveTool, setCursorWorld],
  );

  const onMouseUp = useCallback(
    (e: React.MouseEvent) => {
      const screenPos = getCanvasPos(e);
      const ctx = getToolContext(e);
      if (!ctx) return;
      const worldPos = ctx.screenToWorld(screenPos);
      getActiveTool()?.onMouseUp?.(worldPos, screenPos, ctx);
    },
    [getCanvasPos, getToolContext, getActiveTool],
  );

  return { onMouseDown, onMouseMove, onMouseUp };
}
