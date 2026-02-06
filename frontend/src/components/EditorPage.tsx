import { useMemo, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { Toolbar } from './Toolbar';
import { StatusBar } from './StatusBar';
import { RightPanel } from './RightPanel';
import { DocumentDrawer } from './DocumentDrawer';
import { LogPanel } from './LogPanel';
import { HistoryPanel } from './HistoryPanel';
import { CanvasContainer } from '@/canvas/CanvasContainer';
import { useEditorStore } from '@/stores/editorStore';
import { useDocumentStore } from '@/stores/documentStore';
import { createLineTool } from '@/tools/lineTool';
import { createSelectTool } from '@/tools/selectTool';
import { createCircleTool } from '@/tools/circleTool';
import { createRectangleTool } from '@/tools/rectangleTool';
import { createPolygonTool } from '@/tools/polygonTool';
import { createPointTool } from '@/tools/pointTool';
import { createDimensionTool } from '@/tools/dimensionTool';
import { createRect2ptTool } from '@/tools/rect2ptTool';
import { createBezierTool } from '@/tools/bezierTool';
import { startAutoSave, setBackendId, getBackendId } from '@/api/autoSave';
import { api } from '@/api/client';
import { migrateDocument } from '@/utils/document';
import type { Document } from '@/types/document';
import type { Tool } from '@/tools/types';

export function EditorPage() {
  const { id } = useParams<{ id: string }>();
  const activeTool = useEditorStore((s) => s.activeTool);
  const setActiveTool = useEditorStore((s) => s.setActiveTool);

  // Load document from backend if navigated directly and backendId not set
  useEffect(() => {
    if (!id) return;
    if (getBackendId() === id) return; // already loaded via list page
    let cancelled = false;
    (async () => {
      try {
        const full = await api.getDocument(id);
        if (cancelled) return;
        useDocumentStore.getState().setDocument(
          migrateDocument(full.data as unknown as Document),
        );
        const h = full.history as { undo?: unknown[]; redo?: unknown[] } | null;
        if (h && typeof h === 'object' && !Array.isArray(h) && h.undo) {
          useDocumentStore.getState().restoreHistory(h as never);
        }
        setBackendId(full.id);
      } catch (err) {
        console.error('Failed to load document:', err);
      }
    })();
    return () => { cancelled = true; };
  }, [id]);

  // Start auto-save subscription
  useEffect(() => {
    const unsub = startAutoSave();
    return unsub;
  }, []);

  const toolInstance: Tool = useMemo(() => {
    switch (activeTool) {
      case 'line':
        return createLineTool();
      case 'point':
        return createPointTool();
      case 'circle':
        return createCircleTool();
      case 'rectangle':
        return createRectangleTool();
      case 'rect2pt':
        return createRect2ptTool();
      case 'polygon':
        return createPolygonTool();
      case 'select':
        return createSelectTool();
      case 'dimension':
        return createDimensionTool();
      case 'bezier':
        return createBezierTool();
    }
  }, [activeTool]);

  // Keyboard shortcuts for tool switching
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return;

      const ctrl = e.ctrlKey || e.metaKey;
      if (ctrl && e.key === 'z' && !e.shiftKey) {
        e.preventDefault();
        useDocumentStore.getState().undo();
        return;
      }
      if (ctrl && (e.key === 'Z' || e.key === 'y')) {
        e.preventDefault();
        useDocumentStore.getState().redo();
        return;
      }

      if (e.key === 'Home') {
        e.preventDefault();
        useEditorStore.getState().setViewportCommand('center-origin');
        return;
      }
      if (e.key === 'F' && e.shiftKey) {
        useEditorStore.getState().setViewportCommand('fit-entities');
        return;
      }

      if (e.key === '.') setActiveTool('point');
      if (e.key === 'l' || e.key === 'L') setActiveTool('line');
      if (e.key === 'c' || e.key === 'C') setActiveTool('circle');
      if (e.key === 'r') setActiveTool('rectangle');
      if (e.key === 'R') setActiveTool('rect2pt');
      if (e.key === 'p' || e.key === 'P') setActiveTool('polygon');
      if (e.key === 'd' || e.key === 'D') setActiveTool('dimension');
      if (e.key === 's' || e.key === 'S') setActiveTool('bezier');
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [setActiveTool]);

  return (
    <div style={styles.container}>
      <Toolbar />
      <div style={styles.middle}>
        <HistoryPanel />
        <CanvasContainer activeTool={toolInstance} docId={id} />
        <RightPanel />
      </div>
      <LogPanel />
      <StatusBar />
      <DocumentDrawer />
    </div>
  );
}

const styles = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    width: '100%',
    height: '100%',
  } as React.CSSProperties,
  middle: {
    display: 'flex',
    flex: 1,
    overflow: 'hidden',
  } as React.CSSProperties,
};
