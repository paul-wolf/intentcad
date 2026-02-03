import { useRef, useEffect, useCallback, type RefObject } from 'react';
import { useDocumentStore } from '@/stores/documentStore';
import { useEditorStore } from '@/stores/editorStore';
import { useThemeStore } from '@/theme';
import { useCanvasRenderer } from './useCanvasRenderer';
import { useMouseHandlers } from './useMouseHandlers';
import type { Tool } from '@/tools/types';
import type { ViewportImpl } from '@/rendering/viewport';

function usePanZoom(
  canvasRef: RefObject<HTMLCanvasElement | null>,
  viewportRef: RefObject<ViewportImpl | null>,
) {
  const panRef = useRef<{ lastX: number; lastY: number } | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const vp = viewportRef.current;
      if (!vp) return;
      const rect = canvas.getBoundingClientRect();
      const screenPos = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      const factor = Math.pow(1.001, -e.deltaY);
      vp.zoomAt(screenPos, factor);
    };

    const onMouseDown = (e: MouseEvent) => {
      if (e.button === 1) {
        e.preventDefault();
        panRef.current = { lastX: e.clientX, lastY: e.clientY };
      }
    };

    const onMouseMove = (e: MouseEvent) => {
      const pan = panRef.current;
      if (!pan) return;
      const vp = viewportRef.current;
      if (!vp) return;
      vp.pan(e.clientX - pan.lastX, e.clientY - pan.lastY);
      pan.lastX = e.clientX;
      pan.lastY = e.clientY;
    };

    const onMouseUp = (e: MouseEvent) => {
      if (e.button === 1) panRef.current = null;
    };

    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, [canvasRef, viewportRef]);
}

interface CanvasContainerProps {
  activeTool: Tool | null;
}

export function CanvasContainer({ activeTool }: CanvasContainerProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const activeToolRef = useRef<Tool | null>(activeTool);
  activeToolRef.current = activeTool;

  const getActiveTool = useCallback(() => activeToolRef.current, []);

  const { initCanvas, updateSize, startLoop, stopLoop, viewportRef } =
    useCanvasRenderer({
      getDocument: () => useDocumentStore.getState().document,
      getSelectedEntityIds: () => useEditorStore.getState().selectedEntityIds,
      getActiveTool,
      getAltKeyHeld: () => useEditorStore.getState().altKeyHeld,
    });

  const { onMouseDown, onMouseMove, onMouseUp } = useMouseHandlers(
    canvasRef,
    viewportRef,
    getActiveTool,
  );

  usePanZoom(canvasRef, viewportRef);

  // Handle resize
  const handleResize = useCallback(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const dpr = window.devicePixelRatio || 1;
    const width = container.clientWidth;
    const height = container.clientHeight;

    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;

    const ctx = canvas.getContext('2d');
    if (ctx) ctx.scale(dpr, dpr);

    updateSize(width, height);
  }, [updateSize]);

  // Init
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    initCanvas(canvas);
    handleResize();
    startLoop();

    const ro = new ResizeObserver(handleResize);
    if (containerRef.current) ro.observe(containerRef.current);

    return () => {
      stopLoop();
      ro.disconnect();
    };
  }, [initCanvas, handleResize, startLoop, stopLoop]);

  // Keyboard events
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return;
      activeTool?.onKeyDown?.(e);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [activeTool]);

  // Sync CSS variables with theme
  useEffect(() => {
    const sync = (palette: { background: string; text: string }) => {
      document.documentElement.style.setProperty('--bg', palette.background);
      document.documentElement.style.setProperty('--text', palette.text);
    };
    sync(useThemeStore.getState().palette);
    const unsub = useThemeStore.subscribe((s) => sync(s.palette));
    return unsub;
  }, []);

  // Alt key tracking for dimension overlay
  useEffect(() => {
    const setAltKeyHeld = useEditorStore.getState().setAltKeyHeld;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Alt') setAltKeyHeld(true);
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Alt') setAltKeyHeld(false);
    };
    const onBlur = () => setAltKeyHeld(false);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }, []);

  return (
    <div
      ref={containerRef}
      style={{ flex: 1, position: 'relative', overflow: 'hidden' }}
    >
      <canvas
        ref={canvasRef}
        style={{ display: 'block', cursor: 'crosshair' }}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
      />
    </div>
  );
}
