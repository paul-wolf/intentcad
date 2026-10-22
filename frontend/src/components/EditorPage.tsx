import { useMemo, useEffect, useRef, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import { DocumentDrawer } from './DocumentDrawer';
import { SketchWorkspace } from './SketchWorkspace';
import { CamCanvasHint, CamHeader, CamStepPanel } from './cam/CamMode';
import { useEditorStore } from '@/stores/editorStore';
import { useDocumentStore } from '@/stores/documentStore';
import { useCamStore, setCamDocumentId } from '@/stores/camStore';
import { useBuildStore } from '@/stores/buildStore';
import { useThemeStore } from '@/theme';
import { startAutoSave, setBackendId, getBackendId, setProjectContext, requestSave } from '@/api/autoSave';
import { api } from '@/api/cachedClient';
import { projectApi } from '@/api/projectClient';
import { migrateDocument } from '@/utils/document';
import type { Document } from '@/types/document';
import { addLog } from '@/stores/logStore';

function SimDepthIndicator() {
  const simState = useCamStore((s) => s.simState);
  const simZ = useCamStore((s) => s.simZ);
  const simMoveIndex = useCamStore((s) => s.simMoveIndex);
  const simProgress = useCamStore((s) => s.simProgress);
  const toolpath = useCamStore((s) => s.toolpath);
  const stockTop = useCamStore((s) => s.jobConfig.stock.zTop);
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
    let lo = stockTop, hi = stockTop;
    for (const m of toolpath) {
      if (m.z < lo) lo = m.z;
      if (m.z > hi) hi = m.z;
    }
    return { minZ: lo - 1, maxZ: hi + 1 };
  }, [toolpath, stockTop]);

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

    // Stock top reference line
    const zeroY = toY(stockTop);
    ctx.strokeStyle = palette.text + '40';
    ctx.lineWidth = dpr;
    ctx.setLineDash([4 * dpr, 4 * dpr]);
    ctx.beginPath();
    ctx.moveTo(0, zeroY);
    ctx.lineTo(w, zeroY);
    ctx.stroke();
    ctx.setLineDash([]);

    // Stock top label
    ctx.fillStyle = palette.text + '60';
    ctx.font = `${9 * dpr}px monospace`;
    ctx.fillText(String(stockTop), 2 * dpr, zeroY - 2 * dpr);

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
  }, [maxZ, minZ, totalMoves, palette.text, stockTop]);

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
        color: simZ < stockTop ? '#ff8c00' : palette.text,
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

export function EditorPage() {
  const { id } = useParams<{ id: string }>();
  const camPanelOpen = useCamStore((s) => s.camPanelOpen);

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

  // CAM shortcuts; the sketch shortcuts live in SketchWorkspace. Pasting a
  // document replaces the whole document, so it belongs to this page too.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return;
      // The 3D Build panel owns the keyboard while open
      if (useBuildStore.getState().panelOpen) return;
      const camState = useCamStore.getState();
      if (!camState.camPanelOpen) return;

      // Escape: cancel a pick on the canvas, or stop the simulator, or close
      // the open operation, and only then exit CAM
      if (e.key === 'Escape') {
        if (camState.pickingOrigin) { camState.setPickingOrigin(false); return; }
        if (camState.drawingClamp) { camState.setDrawingClamp(false); return; }
        if (camState.simState !== 'idle') {
          camState.simStop();
          return;
        }
        if (camState.openedOpId) { camState.openOperation(null); return; }
        camState.toggleCamPanel();
        return;
      }
      if (e.key === ' ') {
        e.preventDefault();
        if (camState.simState === 'playing') {
          camState.simPause();
        } else {
          camState.simPlay();
        }
        return;
      }
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        camState.simStep();
      }
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
  }, []);

  return (
    <>
      <SketchWorkspace
        docId={id}
        // In CAM mode, force select tool
        toolOverride={camPanelOpen ? 'select' : undefined}
        keys={camPanelOpen ? 'viewport' : 'all'}
        toolbar={camPanelOpen ? <CamHeader /> : undefined}
        left={camPanelOpen ? <CamStepPanel /> : undefined}
        overlay={camPanelOpen ? <><SimDepthIndicator /><CamCanvasHint /></> : undefined}
        right={camPanelOpen ? <></> : undefined}
      />
      <DocumentDrawer />
    </>
  );
}
