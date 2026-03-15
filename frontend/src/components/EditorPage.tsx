import { useMemo, useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Toolbar } from './Toolbar';
import { StatusBar } from './StatusBar';
import { RightPanel } from './RightPanel';
import { DocumentDrawer } from './DocumentDrawer';
import { LogPanel } from './LogPanel';
import { HistoryPanel } from './HistoryPanel';
import { DocumentPropertiesPanel } from './DocumentPropertiesPanel';
import { GcodePanel } from './GcodePanel';
import { CamOperationsPanel } from './CamOperationsPanel';
import { CanvasContainer } from '@/canvas/CanvasContainer';
import { useEditorStore } from '@/stores/editorStore';
import { useDocumentStore } from '@/stores/documentStore';
import { useCamStore, setCamDocumentId } from '@/stores/camStore';
import { useThemeStore } from '@/theme';
import { createLineTool } from '@/tools/lineTool';
import { createSelectTool } from '@/tools/selectTool';
import { createCircleTool } from '@/tools/circleTool';
import { createRectangleTool } from '@/tools/rectangleTool';
import { createPolygonTool } from '@/tools/polygonTool';
import { createPointTool } from '@/tools/pointTool';
import { createDimensionTool } from '@/tools/dimensionTool';
import { createRect2ptTool } from '@/tools/rect2ptTool';
import { createBezierTool } from '@/tools/bezierTool';
import { startAutoSave, setBackendId, getBackendId, setProjectContext } from '@/api/autoSave';
import { api } from '@/api/client';
import { projectApi } from '@/api/projectClient';
import { migrateDocument } from '@/utils/document';
import type { Document } from '@/types/document';
import type { Tool } from '@/tools/types';

function SimDepthIndicator() {
  const simState = useCamStore((s) => s.simState);
  const simZ = useCamStore((s) => s.simZ);
  const palette = useThemeStore((s) => s.palette);

  if (simState === 'idle' || simZ === null) return null;

  return (
    <div style={{
      position: 'absolute',
      top: '12px',
      left: '50%',
      transform: 'translateX(-50%)',
      background: palette.panelBg,
      border: `1px solid ${palette.border}`,
      borderRadius: '6px',
      padding: '6px 16px',
      zIndex: 10,
      pointerEvents: 'none',
      boxShadow: '0 2px 8px rgba(0,0,0,0.25)',
    }}>
      <span style={{
        fontFamily: 'monospace',
        fontSize: '20px',
        fontWeight: 'bold',
        color: simZ < 0 ? '#ff8c00' : palette.text,
      }}>
        Z {simZ.toFixed(2)}
      </span>
    </div>
  );
}

function CamRightPanel() {
  const palette = useThemeStore((s) => s.palette);
  return (
    <div style={{
      width: '240px',
      background: palette.panelBg,
      borderLeft: `1px solid ${palette.border}`,
      display: 'flex',
      flexDirection: 'column',
      overflowY: 'auto',
    }}>
      <GcodePanel />
    </div>
  );
}

interface SketchOnFaceIntent {
  returnToPartId: string;
  sketchId: string;
  plane: unknown;
  sketchDocumentId: string;
}

export function EditorPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const activeTool = useEditorStore((s) => s.activeTool);
  const setActiveTool = useEditorStore((s) => s.setActiveTool);
  const camPanelOpen = useCamStore((s) => s.camPanelOpen);
  const [sketchOnFaceIntent, setSketchOnFaceIntent] = useState<SketchOnFaceIntent | null>(null);

  // Load document from backend if navigated directly and backendId not set
  useEffect(() => {
    if (!id) return;
    // Reset CAM state when switching documents
    useCamStore.getState().clearJob();
    useCamStore.setState({ camPanelOpen: false });
    setCamDocumentId(id);
    if (getBackendId() === id) {
      // Already loaded via list page — just restore CAM session
      useCamStore.getState().restoreSession(id);
      return;
    }
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
        // Load project context
        if (full.project_id) {
          projectApi.getProject(full.project_id)
            .then((p) => { if (!cancelled) setProjectContext(full.project_id, p.name); })
            .catch(() => {});
        } else {
          setProjectContext(null, null);
        }
        // Restore CAM session after doc is loaded
        if (!cancelled) await useCamStore.getState().restoreSession(id);
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

  // Check for sketch-on-face intent on mount
  useEffect(() => {
    const raw = sessionStorage.getItem('sketchOnFace_intent');
    if (!raw) return;
    try {
      const intent = JSON.parse(raw) as SketchOnFaceIntent;
      setSketchOnFaceIntent(intent);
      // Auto-select the sketch that was just created
      const doc = useDocumentStore.getState().document;
      const sketch = doc.sketches.find((s) => s.id === intent.sketchId);
      if (sketch) {
        useDocumentStore.getState().setActiveSketch(intent.sketchId);
      }
    } catch {
      // ignore
    }
  }, [id]);

  // In CAM mode, force select tool
  const effectiveTool = camPanelOpen ? 'select' : activeTool;

  const toolInstance: Tool = useMemo(() => {
    switch (effectiveTool) {
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
  }, [effectiveTool]);

  // Keyboard shortcuts for tool switching
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return;

      const ctrl = e.ctrlKey || e.metaKey;

      // Viewport shortcuts work in both modes
      if (e.key === 'Home') {
        e.preventDefault();
        useEditorStore.getState().setViewportCommand('center-origin');
        return;
      }
      if (e.key === 'F' && e.shiftKey) {
        useEditorStore.getState().setViewportCommand('fit-entities');
        return;
      }

      // Escape in CAM mode: stop simulator first, then exit CAM
      if (e.key === 'Escape' && useCamStore.getState().camPanelOpen) {
        const camState = useCamStore.getState();
        if (camState.simState !== 'idle') {
          camState.simStop();
          return;
        }
        camState.toggleCamPanel();
        return;
      }

      // In CAM mode: simulator shortcuts
      if (useCamStore.getState().camPanelOpen) {
        if (e.key === ' ') {
          e.preventDefault();
          const camState = useCamStore.getState();
          if (camState.simState === 'playing') {
            camState.simPause();
          } else {
            camState.simPlay();
          }
          return;
        }
        if (e.key === 'ArrowRight') {
          e.preventDefault();
          useCamStore.getState().simStep();
          return;
        }
        return;
      }

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

  const handleSketchOnFaceDone = () => {
    if (!sketchOnFaceIntent) return;
    // Keep the intent in sessionStorage so the part editor picks it up
    // (it's still there — we didn't remove it)
    navigate(`/part/${sketchOnFaceIntent.returnToPartId}`);
  };

  return (
    <div style={styles.container}>
      <Toolbar />
      {sketchOnFaceIntent && (
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '12px',
          padding: '6px 12px',
          background: '#1a5fb4',
          color: '#fff',
          fontSize: '13px',
          fontWeight: 500,
        }}>
          <span>Sketching on face</span>
          <button
            onClick={handleSketchOnFaceDone}
            style={{
              padding: '3px 14px',
              background: '#fff',
              color: '#1a5fb4',
              border: 'none',
              borderRadius: '4px',
              fontSize: '12px',
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            Done
          </button>
        </div>
      )}
      <div style={styles.middle}>
        {!camPanelOpen && <HistoryPanel />}
        {camPanelOpen && <CamOperationsPanel />}
        <CanvasContainer activeTool={toolInstance} docId={id} />
        {camPanelOpen && <SimDepthIndicator />}
        {!camPanelOpen && <DocumentPropertiesPanel />}
        {camPanelOpen ? <CamRightPanel /> : <RightPanel />}
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
    position: 'relative',
  } as React.CSSProperties,
};
