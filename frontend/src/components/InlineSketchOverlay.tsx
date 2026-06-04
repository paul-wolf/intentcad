import { useState, useEffect, useRef, useMemo } from 'react';
import { useThemeStore } from '@/theme';
import { useDocumentStore } from '@/stores/documentStore';
import { useEditorStore } from '@/stores/editorStore';
import type { Plane } from '@/types/part';
import type { Point, Document } from '@/types/document';
import type { Tool } from '@/tools/types';
import type { ToolType } from '@/types/editor';
import type { PartViewport } from '@/part/PartViewport';
import { renderFrame, type RenderContext } from '@/rendering/pipeline';
import { setBackendId } from '@/api/autoSave';

import { createLineTool } from '@/tools/lineTool';
import { createSelectTool } from '@/tools/selectTool';
import { createCircleTool } from '@/tools/circleTool';
import { createRectangleTool } from '@/tools/rectangleTool';
import { createPolygonTool } from '@/tools/polygonTool';
import { createPointTool } from '@/tools/pointTool';
import { createDimensionTool } from '@/tools/dimensionTool';
import { createRect2ptTool } from '@/tools/rect2ptTool';
import { createAxisRectTool } from '@/tools/axisRectTool';
import { createBezierTool } from '@/tools/bezierTool';

interface InlineSketchOverlayProps {
  plane: Plane;
  sketchId: string;
  documentId: string;
  viewport: PartViewport;
  onDone: () => void;
}

function createTool(type: ToolType): Tool {
  switch (type) {
    case 'line': return createLineTool();
    case 'point': return createPointTool();
    case 'circle': return createCircleTool();
    case 'rectangle': return createRectangleTool();
    case 'rect2pt': return createRect2ptTool();
    case 'axisrect': return createAxisRectTool();
    case 'polygon': return createPolygonTool();
    case 'select': return createSelectTool();
    case 'dimension': return createDimensionTool();
    case 'bezier': return createBezierTool();
  }
}

/**
 * Build a document containing only the active sketch, so the pipeline
 * doesn't render ghosted sketches from the parent document.
 */
function activeSketchOnly(doc: Document, sketchId: string): Document {
  const sketch = doc.sketches.find((s) => s.id === sketchId);
  if (!sketch) return doc;
  return {
    ...doc,
    sketches: [sketch],
    activeSketchId: sketchId,
  };
}

export function InlineSketchOverlay({ plane, sketchId, documentId, viewport, onDone }: InlineSketchOverlayProps) {
  const palette = useThemeStore((s) => s.palette);
  const activeTool = useEditorStore((s) => s.activeTool);
  const [initialized, setInitialized] = useState(false);

  const toolRef = useRef<Tool | null>(null);
  const dirtyRef = useRef(true);
  const rafRef = useRef(0);

  // Create tool instance when activeTool changes
  const toolInstance = useMemo(() => createTool(activeTool), [activeTool]);
  toolRef.current = toolInstance;

  // Enter sketch-edit mode on mount, exit on unmount
  useEffect(() => {
    // Set active sketch in document store
    useDocumentStore.getState().setActiveSketch(sketchId);

    // Initialize editor store
    useEditorStore.getState().setActiveTool('line');
    useEditorStore.getState().clearSelection();

    // Enable document auto-save so tools' requestSave() calls persist entities
    setBackendId(documentId);

    // Enter 3D sketch edit mode (aligns camera, fades model, configures orbit for pan/zoom)
    viewport.enterSketchEdit(plane);
    viewport.setEdgeHighlightEnabled(false);

    setInitialized(true);

    // Mark dirty whenever document or editor state changes
    const unsubDoc = useDocumentStore.subscribe(() => { dirtyRef.current = true; });
    const unsubEditor = useEditorStore.subscribe(() => { dirtyRef.current = true; });

    return () => {
      unsubDoc();
      unsubEditor();
      setBackendId(null);
      viewport.exitSketchEdit();
      viewport.setEdgeHighlightEnabled(true);
      useEditorStore.getState().clearSelection();
      useEditorStore.getState().setActiveTool('select');
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Render loop — only re-renders when dirty flag is set
  useEffect(() => {
    if (!initialized) return;

    const loop = () => {
      rafRef.current = requestAnimationFrame(loop);
      if (!dirtyRef.current) return;
      dirtyRef.current = false;

      // Recreate PlaneViewport + ThreeJSRenderer each render
      // so they reflect current camera position (after zoom/pan)
      const pv = viewport.createPlaneViewport();
      if (!pv) return;
      const sr = viewport.createSketchRenderer(pv);

      sr.begin();

      const doc = useDocumentStore.getState().document;
      const ctx: RenderContext = {
        renderer: sr,
        viewport: pv,
        document: activeSketchOnly(doc, sketchId),
        selectedEntityIds: useEditorStore.getState().selectedEntityIds,
        selectedPoints: useEditorStore.getState().selectedPoints,
        selectedSegments: useEditorStore.getState().selectedSegments,
        activeTool: toolRef.current,
        altKeyHeld: useEditorStore.getState().altKeyHeld,
        palette,
        camMode: false,
      };

      try {
        renderFrame(ctx);
      } catch (err) {
        console.error('Inline sketch render error:', err);
      }

      sr.end();
    };

    rafRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafRef.current);
  }, [initialized, palette, viewport, sketchId]);

  // Mouse event handling — dispatch to tools via PlaneViewport
  useEffect(() => {
    if (!initialized) return;
    const canvas = viewport.getCanvas();

    const getScreenPos = (e: MouseEvent): Point => {
      const rect = canvas.getBoundingClientRect();
      return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    };

    const getContext = (e: MouseEvent) => {
      const pv = viewport.createPlaneViewport();
      if (!pv) return null;
      return {
        pv,
        ctx: {
          viewport: pv,
          screenToWorld: (p: Point) => pv.screenToWorld(p),
          worldToScreen: (p: Point) => pv.worldToScreen(p),
          shiftKey: e.shiftKey || e.metaKey,
        },
      };
    };

    const handleMouseDown = (e: MouseEvent) => {
      if (e.button !== 0) return; // only left-click for tools
      const screenPos = getScreenPos(e);
      const c = getContext(e);
      if (!c) return;
      const worldPos = c.pv.screenToWorld(screenPos);
      toolRef.current?.onMouseDown?.(worldPos, screenPos, c.ctx);
      dirtyRef.current = true;
    };

    const handleMouseMove = (e: MouseEvent) => {
      const screenPos = getScreenPos(e);
      const c = getContext(e);
      if (!c) return;
      const worldPos = c.pv.screenToWorld(screenPos);
      useEditorStore.getState().setCursorWorld(worldPos);
      toolRef.current?.onMouseMove?.(worldPos, screenPos, c.ctx);
      dirtyRef.current = true;
    };

    const handleMouseUp = (e: MouseEvent) => {
      if (e.button !== 0) return;
      const screenPos = getScreenPos(e);
      const c = getContext(e);
      if (!c) return;
      const worldPos = c.pv.screenToWorld(screenPos);
      toolRef.current?.onMouseUp?.(worldPos, screenPos, c.ctx);
      dirtyRef.current = true;
    };

    // Also re-render after orbit changes (zoom/pan via middle/right mouse or scroll)
    const handleWheel = () => { dirtyRef.current = true; };
    const handleOtherMouse = (e: MouseEvent) => {
      if (e.button !== 0) dirtyRef.current = true;
    };

    canvas.addEventListener('mousedown', handleMouseDown);
    canvas.addEventListener('mousemove', handleMouseMove);
    canvas.addEventListener('mouseup', handleMouseUp);
    canvas.addEventListener('wheel', handleWheel, { passive: true });
    canvas.addEventListener('mousedown', handleOtherMouse);
    canvas.addEventListener('mouseup', handleOtherMouse);

    return () => {
      canvas.removeEventListener('mousedown', handleMouseDown);
      canvas.removeEventListener('mousemove', handleMouseMove);
      canvas.removeEventListener('mouseup', handleMouseUp);
      canvas.removeEventListener('wheel', handleWheel);
      canvas.removeEventListener('mousedown', handleOtherMouse);
      canvas.removeEventListener('mouseup', handleOtherMouse);
    };
  }, [initialized, viewport]);

  // Keyboard handling
  useEffect(() => {
    if (!initialized) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        toolRef.current?.onKeyDown?.(e);
        if (!e.defaultPrevented) {
          onDone();
        }
        return;
      }

      // Tool switching shortcuts
      if (!e.ctrlKey && !e.metaKey && !e.altKey) {
        const store = useEditorStore.getState();
        switch (e.key.toLowerCase()) {
          case 'l': store.setActiveTool('line'); return;
          case 'c': store.setActiveTool('circle'); return;
          case 'r': store.setActiveTool('rectangle'); return;
          case 'p': store.setActiveTool('polygon'); return;
          case 'b': store.setActiveTool('bezier'); return;
          case 'd': store.setActiveTool('dimension'); return;
          case 'v': store.setActiveTool('select'); return;
          case '.': store.setActiveTool('point'); return;
        }
      }

      // Undo/redo
      if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
        if (e.shiftKey) {
          useDocumentStore.getState().redo();
        } else {
          useDocumentStore.getState().undo();
        }
        return;
      }

      toolRef.current?.onKeyDown?.(e);
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [initialized, onDone]);

  // Tool button definitions
  const tools: { key: ToolType; label: string; shortcut: string }[] = [
    { key: 'select', label: 'Select', shortcut: 'V' },
    { key: 'line', label: 'Line', shortcut: 'L' },
    { key: 'circle', label: 'Circle', shortcut: 'C' },
    { key: 'rectangle', label: 'Rect', shortcut: 'R' },
    { key: 'polygon', label: 'Polygon', shortcut: 'P' },
    { key: 'bezier', label: 'Bezier', shortcut: 'B' },
    { key: 'dimension', label: 'Dim', shortcut: 'D' },
    { key: 'point', label: 'Point', shortcut: '.' },
  ];

  const toolButtonStyle = (tool: ToolType): React.CSSProperties => ({
    padding: '4px 8px',
    background: activeTool === tool ? palette.primaryBtn : palette.buttonBg,
    color: activeTool === tool ? '#fff' : palette.text,
    border: activeTool === tool ? 'none' : `1px solid ${palette.border}`,
    borderRadius: '4px',
    fontSize: '11px',
    cursor: 'pointer',
    fontWeight: activeTool === tool ? 600 : 400,
  });

  return (
    <div
      style={{
        position: 'absolute',
        top: '8px',
        left: '50%',
        transform: 'translateX(-50%)',
        display: 'flex',
        alignItems: 'center',
        gap: '4px',
        padding: '6px 12px',
        background: palette.panelBg,
        border: `1px solid ${palette.border}`,
        borderRadius: '8px',
        boxShadow: '0 2px 12px rgba(0,0,0,0.3)',
        zIndex: 10,
      }}
    >
      <span style={{ fontSize: '12px', color: palette.textSecondary, marginRight: '4px' }}>
        Sketch on Face
      </span>

      {tools.map((t) => (
        <button
          key={t.key}
          style={toolButtonStyle(t.key)}
          onClick={() => useEditorStore.getState().setActiveTool(t.key)}
          title={`${t.label} (${t.shortcut})`}
        >
          {t.label}
        </button>
      ))}

      <div style={{ width: '1px', height: '20px', background: palette.border, margin: '0 4px' }} />

      <button
        style={{
          padding: '4px 16px',
          background: '#22c55e',
          color: '#fff',
          border: 'none',
          borderRadius: '4px',
          fontSize: '12px',
          fontWeight: 600,
          cursor: 'pointer',
        }}
        onClick={onDone}
      >
        Done
      </button>
    </div>
  );
}
