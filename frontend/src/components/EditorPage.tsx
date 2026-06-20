import { useMemo, useEffect, useState, useRef, useCallback } from 'react';
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
import { OperationCuttingPanel } from './OperationCuttingPanel';
import { HelpModal } from './HelpModal';
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
import { createAxisRectTool } from '@/tools/axisRectTool';
import { createBezierTool } from '@/tools/bezierTool';
import { startAutoSave, setBackendId, getBackendId, setProjectContext, requestSave } from '@/api/autoSave';
import { api } from '@/api/cachedClient';
import { projectApi } from '@/api/projectClient';
import { migrateDocument } from '@/utils/document';
import type { Document } from '@/types/document';
import { addLog } from '@/stores/logStore';
import type { Tool } from '@/tools/types';

function SimDepthIndicator() {
  const simState = useCamStore((s) => s.simState);
  const simZ = useCamStore((s) => s.simZ);
  const simMoveIndex = useCamStore((s) => s.simMoveIndex);
  const simProgress = useCamStore((s) => s.simProgress);
  const toolpath = useCamStore((s) => s.toolpath);
  const palette = useThemeStore((s) => s.palette);

  const CHART_W = 260;
  const CHART_H = 60;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const samplesRef = useRef<number[]>([]);
  const prevStateRef = useRef<string>('idle');

  // Reset samples when simulation starts
  if (simState !== 'idle' && prevStateRef.current === 'idle') {
    samplesRef.current = [];
  }
  prevStateRef.current = simState;

  // Compute Z range from toolpath
  const { minZ, maxZ } = useMemo(() => {
    if (!toolpath || toolpath.length === 0) return { minZ: -10, maxZ: 5 };
    let lo = 0, hi = 0;
    for (const m of toolpath) {
      if (m.z < lo) lo = m.z;
      if (m.z > hi) hi = m.z;
    }
    return { minZ: lo - 1, maxZ: hi + 1 };
  }, [toolpath]);

  // Total moves for x-axis scaling
  const totalMoves = toolpath?.length ?? 1;

  const drawChart = useCallback(() => {
    const ctx = canvasRef.current?.getContext('2d');
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const w = CHART_W * dpr;
    const h = CHART_H * dpr;

    ctx.clearRect(0, 0, w, h);
    const range = maxZ - minZ || 1;
    const toY = (z: number) => ((maxZ - z) / range) * h;
    const toX = (i: number) => (i / totalMoves) * w;

    // Z=0 reference line
    const zeroY = toY(0);
    ctx.strokeStyle = palette.text + '40';
    ctx.lineWidth = dpr;
    ctx.setLineDash([4 * dpr, 4 * dpr]);
    ctx.beginPath();
    ctx.moveTo(0, zeroY);
    ctx.lineTo(w, zeroY);
    ctx.stroke();
    ctx.setLineDash([]);

    // Z=0 label
    ctx.fillStyle = palette.text + '60';
    ctx.font = `${9 * dpr}px monospace`;
    ctx.fillText('0', 2 * dpr, zeroY - 2 * dpr);

    // Z trace
    const samples = samplesRef.current;
    if (samples.length < 2) return;
    ctx.strokeStyle = '#ff8c00';
    ctx.lineWidth = 1.5 * dpr;
    ctx.beginPath();
    ctx.moveTo(toX(0), toY(samples[0]!));
    for (let i = 1; i < samples.length; i++) {
      ctx.lineTo(toX(i), toY(samples[i]!));
    }
    ctx.stroke();

    // Current position marker
    const lastSample = samples[samples.length - 1]!;
    const cx = toX(samples.length - 1);
    const cy = toY(lastSample);
    ctx.fillStyle = '#ff8c00';
    ctx.beginPath();
    ctx.arc(cx, cy, 3 * dpr, 0, Math.PI * 2);
    ctx.fill();
  }, [maxZ, minZ, totalMoves, palette.text]);

  // Record sample and redraw on each sim update
  useEffect(() => {
    if (simState === 'idle' || simZ === null) return;
    // Use fractional move index as sample position
    const sampleIdx = simMoveIndex + simProgress;
    // Extend samples array to current position
    const samples = samplesRef.current;
    const targetLen = Math.ceil(sampleIdx) + 1;
    while (samples.length < targetLen) {
      samples.push(simZ);
    }
    samples[samples.length - 1] = simZ;
    drawChart();
  }, [simState, simZ, simMoveIndex, simProgress, drawChart]);

  if (simState === 'idle' || simZ === null) return null;

  const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;

  return (
    <div style={{
      position: 'absolute',
      top: '12px',
      left: '50%',
      transform: 'translateX(-50%)',
      background: palette.panelBg,
      border: `1px solid ${palette.border}`,
      borderRadius: '6px',
      padding: '6px 16px 8px',
      zIndex: 10,
      pointerEvents: 'none',
      boxShadow: '0 2px 8px rgba(0,0,0,0.25)',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      gap: '4px',
    }}>
      <span style={{
        fontFamily: 'monospace',
        fontSize: '20px',
        fontWeight: 'bold',
        color: simZ < 0 ? '#ff8c00' : palette.text,
      }}>
        Z {simZ.toFixed(2)}
      </span>
      <canvas
        ref={canvasRef}
        width={CHART_W * dpr}
        height={CHART_H * dpr}
        style={{ width: CHART_W, height: CHART_H, borderRadius: '4px' }}
      />
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
  const focusedOperationIndex = useCamStore((s) => s.focusedOperationIndex);
  const [showCuttingPanel, setShowCuttingPanel] = useState(true);
  const [sketchOnFaceIntent, setSketchOnFaceIntent] = useState<SketchOnFaceIntent | null>(null);
  const [showHelp, setShowHelp] = useState(false);

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
        // Fit all entities into view after load
        setTimeout(() => useEditorStore.getState().setViewportCommand('fit-entities'), 0);
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
      case 'axisrect':
        return createAxisRectTool();
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
      if (e.key === 'e' || e.key === 'E') setActiveTool('axisrect');
      if (e.key === 'p' || e.key === 'P') setActiveTool('polygon');
      if (e.key === 'd' || e.key === 'D') setActiveTool('dimension');
      if (e.key === 's' || e.key === 'S') setActiveTool('bezier');
      if (e.key === '?') setShowHelp((v) => !v);
    };
    const pasteHandler = (e: ClipboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return;
      const text = e.clipboardData?.getData('text');
      if (!text) return;
      try {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === 'object' && Array.isArray(parsed.sketches) && typeof parsed.activeSketchId === 'string') {
          e.preventDefault();
          useDocumentStore.getState().beginTransaction('Paste document');
          useDocumentStore.getState().setDocument(migrateDocument({ ...(parsed as Document), name: `${(parsed as Document).name} copy` }));
          requestSave();
          addLog('info', 'Document pasted from clipboard');
          setTimeout(() => useEditorStore.getState().setViewportCommand('fit-entities'), 0);
        }
      } catch { /* not JSON — ignore */ }
    };

    window.addEventListener('keydown', handler);
    window.addEventListener('paste', pasteHandler);
    return () => {
      window.removeEventListener('keydown', handler);
      window.removeEventListener('paste', pasteHandler);
    };
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
        {camPanelOpen && <CamOperationsPanel onShowCutting={() => setShowCuttingPanel(true)} />}
        {camPanelOpen && showCuttingPanel && focusedOperationIndex !== null && (
          <OperationCuttingPanel onClose={() => setShowCuttingPanel(false)} />
        )}
        <CanvasContainer activeTool={toolInstance} docId={id} />
        {camPanelOpen && <SimDepthIndicator />}
        {!camPanelOpen && <DocumentPropertiesPanel />}
        {camPanelOpen ? <CamRightPanel /> : <RightPanel />}
      </div>
      <LogPanel />
      <StatusBar />
      <DocumentDrawer />
      {showHelp && <HelpModal onClose={() => setShowHelp(false)} />}
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
