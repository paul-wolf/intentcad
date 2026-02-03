import { useRef, useEffect, useCallback, useMemo, type RefObject } from 'react';
import { useDocumentStore } from '@/stores/documentStore';
import { useEditorStore } from '@/stores/editorStore';
import { useUIStateStore } from '@/stores/uiStateStore';
import { useThemeStore } from '@/theme';
import { useCanvasRenderer } from './useCanvasRenderer';
import { useMouseHandlers } from './useMouseHandlers';
import { getDimensionTextScreenPos, getDiameterTextScreenPos } from '@/rendering/dimensionRenderer';
import { MirrorDialog } from '@/components/MirrorDialog';
import { CircularCopyDialog } from '@/components/CircularCopyDialog';
import { GridCopyDialog } from '@/components/GridCopyDialog';
import type { DimensionGeom } from '@/rendering/dimensionRenderer';
import type { Tool } from '@/tools/types';
import type { ViewportImpl } from '@/rendering/viewport';
import type { Point, LineEntity } from '@/types/document';

function usePanZoom(
  canvasRef: RefObject<HTMLCanvasElement | null>,
  viewportRef: RefObject<ViewportImpl | null>,
  docId?: string,
) {
  const panRef = useRef<{ lastX: number; lastY: number } | null>(null);
  const zoomTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const saveViewport = () => {
      const vp = viewportRef.current;
      if (!vp || !docId) return;
      useUIStateStore.getState().setViewport(docId, vp.offset, vp.scale);
    };

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const vp = viewportRef.current;
      if (!vp) return;
      const rect = canvas.getBoundingClientRect();
      const screenPos = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      const factor = Math.pow(1.001, -e.deltaY);
      vp.zoomAt(screenPos, factor);
      useEditorStore.getState().setViewportScale(vp.scale);

      if (zoomTimerRef.current) clearTimeout(zoomTimerRef.current);
      zoomTimerRef.current = setTimeout(saveViewport, 300);
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
      if (e.button === 1) {
        panRef.current = null;
        saveViewport();
      }
    };

    const onBeforeUnload = () => saveViewport();

    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      window.removeEventListener('beforeunload', onBeforeUnload);
      if (zoomTimerRef.current) clearTimeout(zoomTimerRef.current);
    };
  }, [canvasRef, viewportRef, docId]);
}

function DimensionEditInput({
  dimensionId,
  pos,
  value,
}: {
  dimensionId: string;
  pos: Point;
  value: number;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const el = inputRef.current;
    if (el) {
      el.focus();
      el.select();
    }
  }, []);

  const commit = (input: string) => {
    const v = parseFloat(input);
    if (isNaN(v) || v <= 0) return false;
    useDocumentStore.getState().applyDimensionValue(dimensionId, v);
    useEditorStore.getState().setEditingDimensionId(null);
    return true;
  };

  const cancel = () => {
    useEditorStore.getState().setEditingDimensionId(null);
  };

  return (
    <input
      ref={inputRef}
      defaultValue={value >= 10 ? value.toFixed(1) : value.toFixed(2)}
      style={{
        position: 'absolute',
        left: pos.x - 30,
        top: pos.y - 9,
        width: 60,
        height: 18,
        background: 'transparent',
        border: 'none',
        outline: 'none',
        color: '#4ade80',
        fontSize: 11,
        fontFamily: 'monospace',
        textAlign: 'center',
        padding: 0,
        zIndex: 10,
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          const ok = commit(e.currentTarget.value);
          if (!ok) return; // invalid: keep input open
        }
        if (e.key === 'Escape') {
          cancel();
        }
      }}
      onBlur={cancel}
    />
  );
}

interface CanvasContainerProps {
  activeTool: Tool | null;
  docId?: string;
}

export function CanvasContainer({ activeTool, docId }: CanvasContainerProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const activeToolRef = useRef<Tool | null>(activeTool);
  activeToolRef.current = activeTool;

  const getActiveTool = useCallback(() => activeToolRef.current, []);

  const initialViewport = docId
    ? useUIStateStore.getState().getViewport(docId)
    : undefined;

  const { initCanvas, updateSize, startLoop, stopLoop, viewportRef } =
    useCanvasRenderer({
      getDocument: () => useDocumentStore.getState().document,
      getSelectedEntityIds: () => useEditorStore.getState().selectedEntityIds,
      getActiveTool,
      getAltKeyHeld: () => useEditorStore.getState().altKeyHeld,
      initialViewport,
    });

  const { onMouseDown, onMouseMove, onMouseUp } = useMouseHandlers(
    canvasRef,
    viewportRef,
    getActiveTool,
  );

  usePanZoom(canvasRef, viewportRef, docId);

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
    if (viewportRef.current) {
      useEditorStore.getState().setViewportScale(viewportRef.current.scale);
    }
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

  const editingDimensionId = useEditorStore((s) => s.editingDimensionId);

  const dimensionEditPos = useMemo((): { pos: Point; value: number } | null => {
    if (!editingDimensionId) return null;
    const vp = viewportRef.current;
    if (!vp) return null;
    const sketch = useDocumentStore.getState().getActiveSketch();
    if (!sketch) return null;
    const dim = sketch.entities.find((e) => e.id === editingDimensionId);
    if (!dim || dim.type !== 'dimension') return null;
    const target = sketch.entities.find((e) => e.id === dim.targetEntityId);
    if (!target) return null;

    if (target.type === 'circle') {
      const diameter = target.radius * 2;
      const pos = getDiameterTextScreenPos(vp, target.center, target.radius, dim.offset);
      return { pos, value: diameter };
    }
    if (target.type === 'rectangle') {
      const hw = target.width / 2;
      const hh = target.height / 2;
      const c = target.center;
      let a: Point, b: Point;
      if (dim.segmentIndex === 0) {
        a = { x: c.x - hw, y: c.y + hh };
        b = { x: c.x + hw, y: c.y + hh };
      } else {
        a = { x: c.x + hw, y: c.y + hh };
        b = { x: c.x + hw, y: c.y - hh };
      }
      const geom: DimensionGeom = { a, b, offset: dim.offset };
      const pos = getDimensionTextScreenPos(vp, geom);
      const value = dim.segmentIndex === 0 ? target.width : target.height;
      return { pos, value };
    }
    if (target.type === 'line') {
      // Polygon radius (apothem) dimension
      if (dim.segmentIndex === -1 && (target as LineEntity).polygonCenter) {
        const center = (target as LineEntity).polygonCenter!;
        const midA: Point = {
          x: (target.points[0]!.x + target.points[1]!.x) / 2,
          y: (target.points[0]!.y + target.points[1]!.y) / 2,
        };
        const geom: DimensionGeom = { a: center, b: midA, offset: dim.offset };
        const pos = getDimensionTextScreenPos(vp, geom);
        const value = Math.sqrt((midA.x - center.x) ** 2 + (midA.y - center.y) ** 2);
        return { pos, value };
      }
      const idx = dim.segmentIndex;
      if (idx < 0 || idx >= target.points.length - 1) return null;
      const a = target.points[idx]!;
      const b = target.points[idx + 1]!;
      const geom: DimensionGeom = { a, b, offset: dim.offset };
      const pos = getDimensionTextScreenPos(vp, geom);
      const value = Math.sqrt((b.x - a.x) ** 2 + (b.y - a.y) ** 2);
      return { pos, value };
    }
    return null;
  }, [editingDimensionId, viewportRef]);

  return (
    <div
      ref={containerRef}
      style={{ flex: 1, position: 'relative', overflow: 'hidden' }}
    >
      <canvas
        ref={canvasRef}
        style={{ display: 'block', cursor: activeTool?.cursor ?? 'crosshair' }}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
      />
      {editingDimensionId && dimensionEditPos && (
        <DimensionEditInput
          key={editingDimensionId}
          dimensionId={editingDimensionId}
          pos={dimensionEditPos.pos}
          value={dimensionEditPos.value}
        />
      )}
      <MirrorDialog />
      <CircularCopyDialog />
      <GridCopyDialog />
    </div>
  );
}
