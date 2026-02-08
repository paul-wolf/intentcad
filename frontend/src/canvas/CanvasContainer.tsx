import { useRef, useEffect, useCallback, useMemo, type RefObject } from 'react';
import { useDocumentStore } from '@/stores/documentStore';
import { useEditorStore } from '@/stores/editorStore';
import { useUIStateStore } from '@/stores/uiStateStore';
import { useThemeStore } from '@/theme';
import { useCanvasRenderer } from './useCanvasRenderer';
import { useMouseHandlers } from './useMouseHandlers';
import { getDimensionTextScreenPos, getDiameterTextScreenPos, computeAngleDimensionGeom, getAngleDimensionTextScreenPos } from '@/rendering/dimensionRenderer';
import { MirrorDialog } from '@/components/MirrorDialog';
import { CircularCopyDialog } from '@/components/CircularCopyDialog';
import { GridCopyDialog } from '@/components/GridCopyDialog';
import type { DimensionGeom } from '@/rendering/dimensionRenderer';
import type { Tool } from '@/tools/types';
import type { ViewportImpl } from '@/rendering/viewport';
import type { Point, LineEntity } from '@/types/document';
import { getSegmentCount, getSegmentPointIndices } from '@/utils/lineSegments';
import { computeDerivedDimensionIds } from '@/utils/dof';
import { isExpression, evaluateExpression } from '@/utils/expression';

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
  isAngle,
  expression,
}: {
  dimensionId: string;
  pos: Point;
  value: number;
  isAngle?: boolean;
  expression?: string;
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
    const store = useDocumentStore.getState();
    if (isExpression(input)) {
      // Expression input: evaluate against document parameters
      const params = store.document.parameters ?? {};
      try {
        const v = evaluateExpression(input, params);
        if (!isFinite(v) || v <= 0) return false;
        if (isAngle && v >= 180) return false;
        store.setDimensionExpression(dimensionId, input);
        store.applyDimensionValue(dimensionId, v);
      } catch {
        return false;
      }
    } else {
      // Plain number input
      const v = parseFloat(input);
      if (isAngle) {
        if (isNaN(v) || v <= 0 || v >= 180) return false;
      } else {
        if (isNaN(v) || v <= 0) return false;
      }
      store.setDimensionExpression(dimensionId, undefined);
      store.applyDimensionValue(dimensionId, v);
    }
    useEditorStore.getState().setEditingDimensionId(null);
    return true;
  };

  const cancel = () => {
    useEditorStore.getState().setEditingDimensionId(null);
  };

  const defaultVal = expression ?? (isAngle ? value.toFixed(1) : (value >= 10 ? value.toFixed(1) : value.toFixed(2)));

  return (
    <input
      ref={inputRef}
      defaultValue={defaultVal}
      style={{
        position: 'absolute',
        left: pos.x - 50,
        top: pos.y - 12,
        width: 100,
        height: 24,
        background: '#1e293b',
        border: '1px solid #3b82f6',
        borderRadius: 4,
        outline: 'none',
        color: '#f1f5f9',
        fontSize: 14,
        fontFamily: 'monospace',
        textAlign: 'center',
        padding: '0 4px',
        zIndex: 10,
        boxShadow: '0 2px 8px rgba(0, 0, 0, 0.3)',
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
      getSelectedPoints: () => useEditorStore.getState().selectedPoints,
      getSelectedSegments: () => useEditorStore.getState().selectedSegments,
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

  // React to viewport commands (center-origin, fit-entities)
  const viewportCommand = useEditorStore((s) => s.viewportCommand);
  useEffect(() => {
    if (!viewportCommand) return;
    const vp = viewportRef.current;
    if (!vp) return;

    const MIN_SCALE = 0.5;
    const MAX_SCALE = 80;

    if (viewportCommand === 'center-origin') {
      vp.offset = { x: vp.width / 2, y: vp.height / 2 };
    } else if (viewportCommand === 'fit-entities') {
      const sketch = useDocumentStore.getState().getActiveSketch();
      const entities = sketch?.entities ?? [];

      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      let hasGeometry = false;

      for (const entity of entities) {
        if (entity.type === 'dimension') continue;
        if (entity.type === 'line') {
          for (const p of entity.points) {
            minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
            maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
          }
          hasGeometry = true;
        } else if (entity.type === 'circle') {
          minX = Math.min(minX, entity.center.x - entity.radius);
          minY = Math.min(minY, entity.center.y - entity.radius);
          maxX = Math.max(maxX, entity.center.x + entity.radius);
          maxY = Math.max(maxY, entity.center.y + entity.radius);
          hasGeometry = true;
        } else if (entity.type === 'rectangle') {
          const hw = entity.width / 2, hh = entity.height / 2;
          minX = Math.min(minX, entity.center.x - hw);
          minY = Math.min(minY, entity.center.y - hh);
          maxX = Math.max(maxX, entity.center.x + hw);
          maxY = Math.max(maxY, entity.center.y + hh);
          hasGeometry = true;
        }
      }

      if (!hasGeometry) {
        // Fallback: center origin
        vp.offset = { x: vp.width / 2, y: vp.height / 2 };
      } else {
        const bbW = (maxX - minX) * 1.1 || 1;
        const bbH = (maxY - minY) * 1.1 || 1;
        const centerX = (minX + maxX) / 2;
        const centerY = (minY + maxY) / 2;
        const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, Math.min(vp.width / bbW, vp.height / bbH)));
        vp.scale = scale;
        vp.offset = {
          x: vp.width / 2 - centerX * scale,
          y: vp.height / 2 - centerY * scale,
        };
      }
    }

    useEditorStore.getState().setViewportScale(vp.scale);
    if (docId) {
      useUIStateStore.getState().setViewport(docId, vp.offset, vp.scale);
    }
    useEditorStore.getState().setViewportCommand(null);
  }, [viewportCommand, viewportRef, docId]);

  const editingDimensionId = useEditorStore((s) => s.editingDimensionId);

  const dimensionEditPos = useMemo((): { pos: Point; value: number; isAngle?: boolean; expression?: string } | null => {
    if (!editingDimensionId) return null;
    const vp = viewportRef.current;
    if (!vp) return null;
    const sketch = useDocumentStore.getState().getActiveSketch();
    if (!sketch) return null;
    const dim = sketch.entities.find((e) => e.id === editingDimensionId);
    if (!dim || dim.type !== 'dimension') return null;

    // Don't allow editing derived (driven) dimensions
    const derivedIds = computeDerivedDimensionIds(sketch.entities, sketch.constraints);
    if (derivedIds.has(dim.id)) {
      useEditorStore.getState().setEditingDimensionId(null);
      return null;
    }

    const target = sketch.entities.find((e) => e.id === dim.targetEntityId);
    if (!target) return null;

    // Two-entity dimension (distance or angle)
    if (dim.targetEntityId2 != null) {
      const target2 = sketch.entities.find((e) => e.id === dim.targetEntityId2);
      if (!target2) return null;

      // Circle-to-circle center distance
      if (target.type === 'circle' && target2.type === 'circle') {
        const a = target.center;
        const b = target2.center;
        const geom: DimensionGeom = { a, b, offset: dim.offset };
        const pos = getDimensionTextScreenPos(vp, geom);
        const value = Math.sqrt((b.x - a.x) ** 2 + (b.y - a.y) ** 2);
        return { pos, value, expression: dim.expression };
      }

      if (target.type !== 'line' || target2.type !== 'line') return null;
      const idx1 = dim.segmentIndex;
      const idx2 = dim.segmentIndex2!;
      if (idx1 < 0 || idx1 >= getSegmentCount(target)) return null;
      if (idx2 < 0 || idx2 >= getSegmentCount(target2)) return null;
      const [cpi1, cpi2] = getSegmentPointIndices(target, idx1);
      const [cqi1, cqi2] = getSegmentPointIndices(target2, idx2);
      const p1 = target.points[cpi1]!;
      const p2 = target.points[cpi2]!;
      const q1 = target2.points[cqi1]!;
      const q2 = target2.points[cqi2]!;

      if (dim.angleMode) {
        const angleGeom = computeAngleDimensionGeom(p1, p2, q1, q2, dim.offset);
        if (!angleGeom) return null;
        const pos = getAngleDimensionTextScreenPos(vp, angleGeom);
        let sweep = angleGeom.endAngle - angleGeom.startAngle;
        while (sweep > Math.PI) sweep -= 2 * Math.PI;
        while (sweep < -Math.PI) sweep += 2 * Math.PI;
        const value = Math.abs(sweep) * 180 / Math.PI;
        return { pos, value, isAngle: true, expression: dim.expression };
      }

      const a: Point = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
      const dx = q2.x - q1.x;
      const dy = q2.y - q1.y;
      const lenSq = dx * dx + dy * dy;
      if (lenSq === 0) return null;
      const t = ((a.x - q1.x) * dx + (a.y - q1.y) * dy) / lenSq;
      const b: Point = { x: q1.x + t * dx, y: q1.y + t * dy };
      const geom: DimensionGeom = { a, b, offset: dim.offset };
      const pos = getDimensionTextScreenPos(vp, geom);
      const value = Math.sqrt((b.x - a.x) ** 2 + (b.y - a.y) ** 2);
      return { pos, value, expression: dim.expression };
    }

    if (target.type === 'circle') {
      const diameter = target.radius * 2;
      const pos = getDiameterTextScreenPos(vp, target.center, target.radius, dim.offset);
      return { pos, value: diameter, expression: dim.expression };
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
      return { pos, value, expression: dim.expression };
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
        return { pos, value, expression: dim.expression };
      }
      const idx = dim.segmentIndex;
      if (idx < 0 || idx >= getSegmentCount(target)) return null;
      const [cai, cbi] = getSegmentPointIndices(target, idx);
      const a = target.points[cai]!;
      const b = target.points[cbi]!;
      const geom: DimensionGeom = { a, b, offset: dim.offset };
      const pos = getDimensionTextScreenPos(vp, geom);
      const value = Math.sqrt((b.x - a.x) ** 2 + (b.y - a.y) ** 2);
      return { pos, value, expression: dim.expression };
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
          isAngle={dimensionEditPos.isAngle}
          expression={dimensionEditPos.expression}
        />
      )}
      <MirrorDialog />
      <CircularCopyDialog />
      <GridCopyDialog />
    </div>
  );
}
