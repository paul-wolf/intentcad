import { useRef, useEffect, useCallback, useMemo, useState, type RefObject } from 'react';
import { useDocumentStore } from '@/stores/documentStore';
import { useEditorStore } from '@/stores/editorStore';
import { useUIStateStore } from '@/stores/uiStateStore';
import { useCamStore } from '@/stores/camStore';
import { useThemeStore } from '@/theme';
import { useCanvasRenderer, type InitialViewport } from './useCanvasRenderer';
import { useMouseHandlers } from './useMouseHandlers';
import { getDimensionTextScreenPos, getDiameterTextScreenPos, computeAngleDimensionGeom, getAngleDimensionTextScreenPos } from '@/rendering/dimensionRenderer';
import { MirrorDialog } from '@/components/MirrorDialog';
import { FilletPanel } from '@/components/FilletPanel';
import { OffsetPanel } from '@/components/OffsetPanel';
import { CircularCopyDialog } from '@/components/CircularCopyDialog';
import { GridCopyDialog } from '@/components/GridCopyDialog';
import { DxfImportDialog } from '@/components/DxfImportDialog';
import type { DimensionGeom } from '@/rendering/dimensionRenderer';
import { resolveRadiusDimension, resolveDimensionEndpoints } from '@/utils/dimensionGeom';
import { measureDimension } from '@/utils/resolveSketch';
import type { Tool } from '@/tools/types';
import type { ViewportImpl } from '@/rendering/viewport';
import type { Point, LineEntity } from '@/types/document';
import { getSegmentCount, getSegmentPointIndices, getEntitySegmentEndpoints } from '@/utils/lineSegments';
import { computeDerivedDimensionIds } from '@/utils/dof';
import { getEntityPoint } from '@/utils/entityPoints';
import { isExpression, evaluateExpression, expressionNames, completeName } from '@/utils/expression';

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
  // sketching on a part: the part's P can be used too (and wins a clash)
  const partParams = useEditorStore((s) => s.partParams);
  const docParams = useDocumentStore((s) => s.document.parameters);
  const [text, setText] = useState<string | null>(null);
  const [caret, setCaret] = useState(0);
  const [pick, setPick] = useState(0);

  useEffect(() => {
    const el = inputRef.current;
    if (el) {
      el.focus();
      el.select();
    }
  }, []);

  const vars = () => ({ ...(useDocumentStore.getState().document.parameters ?? {}), ...(partParams ?? {}) });

  const commit = (input: string) => {
    const store = useDocumentStore.getState();
    if (isExpression(input)) {
      // Expression input: evaluate against document parameters (and the part's P)
      const params = vars();
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

  // the P names to complete the word at the caret, what the expression comes
  // to, and names that are both a sketch parameter and in P
  const current = text ?? defaultVal;
  const done = partParams ? completeName(current, caret, Object.keys(partParams)) : null;
  const matches = done?.matches.slice(0, 8) ?? [];
  const accept = (name: string) => {
    const el = inputRef.current;
    if (!el || !done) return;
    const next = current.slice(0, done.start) + name + current.slice(caret);
    el.value = next;
    const at = done.start + name.length;
    el.setSelectionRange(at, at);
    setText(next); setCaret(at); setPick(0);
  };
  let result: string | null = null;
  let resultBad = false;
  const clashes: string[] = [];
  if (partParams && isExpression(current)) {
    const missing = expressionNames(current).filter((n) => !(n in partParams) && !(n in (docParams ?? {})));
    if (missing.length) { result = `unknown: ${missing.join(', ')}`; resultBad = true; }
    else {
      try {
        const v = evaluateExpression(current, vars());
        result = `= ${Math.round(v * 1000) / 1000}`;
        resultBad = !isFinite(v) || v <= 0;
      } catch { result = '…'; resultBad = true; }
    }
    for (const n of expressionNames(current)) if (docParams && n in docParams && n in partParams) clashes.push(n);
  }
  const track = (el: HTMLInputElement) => { setText(el.value); setCaret(el.selectionStart ?? el.value.length); };

  return (
    <>
    <input
      ref={inputRef}
      defaultValue={defaultVal}
      style={{
        position: 'absolute',
        left: pos.x - 50,
        top: pos.y - 12,
        width: partParams ? 140 : 100,
        ...(partParams ? { left: pos.x - 70 } : {}),
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
      onChange={partParams ? (e) => { track(e.currentTarget); setPick(0); } : undefined}
      onSelect={partParams ? (e) => track(e.currentTarget) : undefined}
      onKeyDown={(e) => {
        if (matches.length) {
          if (e.key === 'ArrowDown') { e.preventDefault(); setPick((pick + 1) % matches.length); return; }
          if (e.key === 'ArrowUp') { e.preventDefault(); setPick((pick + matches.length - 1) % matches.length); return; }
          if (e.key === 'Tab' || e.key === 'Enter') { e.preventDefault(); accept(matches[pick] ?? matches[0]!); return; }
        }
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
    {partParams && (matches.length > 0 || result || clashes.length > 0) && (
      <div
        style={{
          position: 'absolute', left: pos.x - 70, top: pos.y + 14, minWidth: 140, zIndex: 11,
          background: '#1e293b', border: '1px solid #334155', borderRadius: 4,
          fontFamily: 'monospace', fontSize: 12, color: '#cbd5e1', boxShadow: '0 2px 8px rgba(0, 0, 0, 0.3)',
        }}
        // keep the focus in the input
        onMouseDown={(e) => e.preventDefault()}
      >
        {result && <div style={{ padding: '3px 8px', color: resultBad ? '#f87171' : '#93c5fd' }}>{result}</div>}
        {clashes.map((n) => (
          <div key={n} style={{ padding: '3px 8px', color: '#fbbf24', whiteSpace: 'nowrap' }}>
            ⚠ {n}: the part's P ({partParams[n]}) is used, not the sketch parameter ({docParams![n]})
          </div>
        ))}
        {matches.map((n, i) => (
          <div
            key={n}
            onClick={() => accept(n)}
            style={{
              padding: '3px 8px', cursor: 'pointer', display: 'flex', justifyContent: 'space-between', gap: 12,
              background: i === pick ? '#334155' : undefined,
            }}
          >
            <span>{n}</span><span style={{ color: '#94a3b8' }}>{partParams[n]}</span>
          </div>
        ))}
      </div>
    )}
    </>
  );
}

/** Lets a host drive or follow the sketch viewport (e.g. a 3D view underneath). */
export interface SketchViewportController {
  /** Starting offset/scale (or a function of the canvas size giving them);
   *  overrides the per-document saved viewport. */
  initial?: InitialViewport;
  /** Called after every frame with the viewport it was drawn with and the canvas. */
  onFrame?: (viewport: ViewportImpl, canvas: HTMLCanvasElement) => void;
}

interface CanvasContainerProps {
  activeTool: Tool | null;
  docId?: string;
  /** See-through canvas: no background fill. */
  transparent?: boolean;
  /** Draw the grid (default true). */
  grid?: boolean;
  /** Don't ghost the document's other visible sketches. */
  soloActiveSketch?: boolean;
  /** External viewport control. With one, the viewport isn't saved per document. */
  viewport?: SketchViewportController;
}

export function CanvasContainer({ activeTool, docId, transparent, grid, soloActiveSketch, viewport }: CanvasContainerProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const activeToolRef = useRef<Tool | null>(activeTool);
  activeToolRef.current = activeTool;
  const displayRef = useRef({ transparent, showGrid: grid, soloActiveSketch });
  displayRef.current = { transparent, showGrid: grid, soloActiveSketch };
  const controllerRef = useRef(viewport);
  controllerRef.current = viewport;

  const getActiveTool = useCallback(() => activeToolRef.current, []);

  // An externally controlled viewport is the host's to keep; don't save it per document.
  const persistId = viewport ? undefined : docId;
  const initialViewport = viewport?.initial
    ?? (persistId ? useUIStateStore.getState().getViewport(persistId) : undefined);

  const { initCanvas, updateSize, startLoop, stopLoop, viewportRef } =
    useCanvasRenderer({
      getDocument: () => useDocumentStore.getState().document,
      getSelectedEntityIds: () => useEditorStore.getState().selectedEntityIds,
      getSelectedPoints: () => useEditorStore.getState().selectedPoints,
      getSelectedSegments: () => useEditorStore.getState().selectedSegments,
      getActiveTool,
      getAltKeyHeld: () => useEditorStore.getState().altKeyHeld,
      initialViewport,
      getRenderOptions: () => displayRef.current,
      onFrame: (vp) => {
        const canvas = canvasRef.current;
        if (canvas) controllerRef.current?.onFrame?.(vp, canvas);
      },
    });

  const { onMouseDown, onMouseMove, onMouseUp } = useMouseHandlers(
    canvasRef,
    viewportRef,
    getActiveTool,
  );

  usePanZoom(canvasRef, viewportRef, persistId);

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
        } else if (entity.type === 'point') {
          minX = Math.min(minX, entity.position.x);
          minY = Math.min(minY, entity.position.y);
          maxX = Math.max(maxX, entity.position.x);
          maxY = Math.max(maxY, entity.position.y);
          hasGeometry = true;
        } else if (entity.type === 'bezier') {
          for (const p of entity.controlPoints) {
            minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
            maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
          }
          hasGeometry = true;
        }
      }

      // In CAM, fit the stock: it holds the job's shapes, clamps and origin.
      const cam = useCamStore.getState();
      const stock = cam.camPanelOpen ? cam.resolved.stock : null;
      if (stock && stock.width > 0 && stock.height > 0) {
        minX = stock.x; minY = stock.y; maxX = stock.x + stock.width; maxY = stock.y + stock.height;
        hasGeometry = true;
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
    if (persistId) {
      useUIStateStore.getState().setViewport(persistId, vp.offset, vp.scale);
    }
    useEditorStore.getState().setViewportCommand(null);
  }, [viewportCommand, viewportRef, persistId]);

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

    if (dim.radius) {
      const g = resolveRadiusDimension(dim, sketch.entities);
      return g && { pos: vp.worldToScreen(g.end), value: g.radius, expression: dim.expression };
    }

    if (dim.offsetDistance) {
      const ends = resolveDimensionEndpoints(dim, sketch.entities);
      const value = measureDimension(dim, sketch.entities);
      if (!ends || value == null) return null;
      return { pos: getDimensionTextScreenPos(vp, { a: ends.a, b: ends.b, offset: dim.offset }), value, expression: dim.expression };
    }

    // Point-to-segment dimension
    if (dim.pointIndex != null && dim.pointIndex2 == null && dim.targetEntityId2 != null) {
      const a = getEntityPoint(target, dim.pointIndex);
      if (!a) return null;
      const target2 = sketch.entities.find((e) => e.id === dim.targetEntityId2);
      if (!target2) return null;
      const ep2 = getEntitySegmentEndpoints(target2, dim.segmentIndex2 ?? 0);
      if (!ep2) return null;
      const [q1, q2] = ep2;
      const sdx = q2.x - q1.x; const sdy = q2.y - q1.y;
      const sLenSq = sdx * sdx + sdy * sdy;
      if (sLenSq === 0) return null;
      const tP = ((a.x - q1.x) * sdx + (a.y - q1.y) * sdy) / sLenSq;
      const b: Point = { x: q1.x + tP * sdx, y: q1.y + tP * sdy };
      const geom: DimensionGeom = { a, b, offset: dim.offset };
      const pos = getDimensionTextScreenPos(vp, geom);
      const value = Math.sqrt((b.x - a.x) ** 2 + (b.y - a.y) ** 2);
      return { pos, value, expression: dim.expression };
    }

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

      const ep1 = getEntitySegmentEndpoints(target, dim.segmentIndex);
      const ep2 = getEntitySegmentEndpoints(target2, dim.segmentIndex2 ?? 0);
      if (!ep1 || !ep2) return null;
      const [p1, p2] = ep1;
      const [q1, q2] = ep2;

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
      <FilletPanel />
      <OffsetPanel />
      <CircularCopyDialog />
      <GridCopyDialog />
      <DxfImportDialog />
    </div>
  );
}
