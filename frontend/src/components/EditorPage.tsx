import { useMemo, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { Toolbar } from './Toolbar';
import { StatusBar } from './StatusBar';
import { RightPanel } from './RightPanel';
import { DocumentDrawer } from './DocumentDrawer';
import { LogPanel } from './LogPanel';
import { CanvasContainer } from '@/canvas/CanvasContainer';
import { useEditorStore } from '@/stores/editorStore';
import { useDocumentStore } from '@/stores/documentStore';
import { useUIStateStore } from '@/stores/uiStateStore';
import { createLineTool } from '@/tools/lineTool';
import { createSelectTool } from '@/tools/selectTool';
import { createCircleTool } from '@/tools/circleTool';
import { createRectangleTool } from '@/tools/rectangleTool';
import { createPolygonTool } from '@/tools/polygonTool';
import { createPointTool } from '@/tools/pointTool';
import { createDimensionTool } from '@/tools/dimensionTool';
import { startAutoSave, setBackendId, getBackendId } from '@/api/autoSave';
import { api } from '@/api/client';
import { migrateDocument } from '@/utils/document';
import type { Document } from '@/types/document';
import type { Tool } from '@/tools/types';

export function EditorPage() {
  const { id } = useParams<{ id: string }>();
  const activeTool = useEditorStore((s) => s.activeTool);
  const setActiveTool = useEditorStore((s) => s.setActiveTool);
  const drawerOpen = useUIStateStore((s) => s.drawerOpen);

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
      case 'polygon':
        return createPolygonTool();
      case 'select':
        return createSelectTool();
      case 'dimension':
        return createDimensionTool();
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
      if (e.key === 'f' || e.key === 'F') {
        useEditorStore.getState().setViewportCommand('fit-entities');
        return;
      }

      if (e.key === '.') setActiveTool('point');
      if (e.key === 'l' || e.key === 'L') setActiveTool('line');
      if (e.key === 'c' || e.key === 'C') setActiveTool('circle');
      if (e.key === 'r' || e.key === 'R') setActiveTool('rectangle');
      if (e.key === 'p' || e.key === 'P') setActiveTool('polygon');
      if (e.key === 'v' || e.key === 'V') setActiveTool('select');
      if (e.key === 'd' || e.key === 'D') setActiveTool('dimension');
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [setActiveTool]);

  return (
    <div style={styles.container}>
      <Toolbar />
      <div style={styles.middle}>
        {drawerOpen && <DocumentDrawer />}
        <CanvasContainer activeTool={toolInstance} docId={id} />
        <RightPanel />
      </div>
      <LogPanel />
      <StatusBar />
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
