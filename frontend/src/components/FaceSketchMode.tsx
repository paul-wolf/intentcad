/**
 * SPIKE: sketching on a planar face of the part, with the full 2D sketcher
 * (SketchWorkspace) laid over the 3D view. The sketch viewport owns the
 * camera: every sketch frame sets the 3D orthographic camera so the face
 * plane lines up with the drawing exactly.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from 'react';
import { SketchWorkspace, type SketchViewportController } from './SketchWorkspace';
import { Toolbar } from './Toolbar';
import { useThemeStore } from '@/theme';
import { useDocumentStore } from '@/stores/documentStore';
import { useEditorStore } from '@/stores/editorStore';
import { getBackendId, persistSketches } from '@/api/autoSave';
import type { RunResponse } from '@/api/client';
import type { FaceRange, Viewer } from '@/build/webglViewer';
import { dot, len, sub } from '@/build/dragHandle';
import { planeBasis, sketchCamera, fitViewport, type PlaneBasis, type Rect } from '@/build/sketchPlane';
import { findFaceSketch, newFaceSketch, sketchBounds, sketchSegments } from '@/build/faceSketch';
import type { Sketch } from '@/types/document';

const FADE_MS = 250;

interface Session {
  sketchId: string;
  label: string;
  face: number;            // highlighted face index (−1: none matched)
  plane: PlaneBasis;
  prevActive: string;      // the document's active sketch before, restored after
  phase: 'enter' | 'on' | 'exit';
}

/** "top face", "front face"… from the outward normal. */
export function faceLabel(n: readonly number[]): string {
  const names: [number, number, string][] = [
    [2, 1, 'top'], [2, -1, 'bottom'], [1, -1, 'front'], [1, 1, 'back'], [0, 1, 'right'], [0, -1, 'left'],
  ];
  for (const [axis, sign, name] of names) if (n[axis]! * sign > 0.999) return `${name} face`;
  return 'angled face';
}

function hexRgb(c: string): [number, number, number] {
  const m = /^#([0-9a-f]{6})$/i.exec(c.trim());
  if (!m) return [0.06, 0.09, 0.16];
  const v = parseInt(m[1]!, 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}

const sameRect = (a: Rect, b: Rect) =>
  Math.abs(a.left - b.left) < 0.5 && Math.abs(a.top - b.top) < 0.5
  && Math.abs(a.width - b.width) < 0.5 && Math.abs(a.height - b.height) < 0.5;

// the 3D face a stored sketch was drawn on, in the current build
function matchFace(sk: Sketch, faces: FaceRange[]): FaceRange | null {
  if (!sk.plane || !sk.face) return null;
  const b = planeBasis(sk.plane);
  let best: FaceRange | null = null, bestD = Infinity;
  for (const f of faces) {
    if (f.kind !== 'plane' || dot(f.normal, b.normal) < 0.999) continue;
    if (Math.abs(dot(sub(f.center, b.origin), b.normal)) > 0.01) continue;
    const d = len(sub(f.center, sk.face.center));
    if (d < bestD) { bestD = d; best = f; }
  }
  return best;
}

const initialFor = (sk: Sketch | undefined) => (w: number, h: number) => {
  const b = sk ? sketchBounds(sk) : null;
  return b ? fitViewport(b.min, b.max, w, h) : { offset: { x: w / 2, y: h / 2 }, scale: 4 };
};

export interface FaceSketchApi {
  /** Sketching (including the enter / exit animations). */
  active: boolean;
  activeRef: RefObject<boolean>;
  /** Sketch on this planar face: reopen its sketch, or start one. */
  enter(face: FaceRange): void;
  /** Reopen a stored face sketch (double-click on the part). */
  open(sketchId: string): void;
  exit(): void;
  /** Style for the 3D canvas: pinned under the sketch canvas while sketching. */
  canvasStyle: CSSProperties | null;
  /** Push the stored face sketches to the viewer as 3D lines. */
  pushLines(): void;
  overlay: React.ReactNode;
}

export function useFaceSketch(
  viewerRef: RefObject<Viewer | null>,
  canvasRef: RefObject<HTMLCanvasElement | null>,
  resRef: RefObject<RunResponse | null>,
): FaceSketchApi {
  const palette = useThemeStore((s) => s.palette);
  const [session, setSession] = useState<Session | null>(null);
  const sessionRef = useRef<Session | null>(null);
  sessionRef.current = session;
  const activeRef = useRef(false);
  activeRef.current = !!session;
  const [glRect, setGlRect] = useState<Rect | null>(null);
  const glRectRef = useRef<Rect | null>(null);
  glRectRef.current = glRect;
  const [shown, setShown] = useState(false);       // panels faded in
  const [strokes, setStrokes] = useState(false);   // the sketch canvas showing
  const [grid, setGrid] = useState(false);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const timers = useRef<number[]>([]);
  const later = (ms: number, f: () => void) => { timers.current.push(window.setTimeout(f, ms)); };
  useEffect(() => () => timers.current.forEach((t) => clearTimeout(t)), []);

  const start = useCallback((sk: Sketch, face: number) => {
    if (sessionRef.current || !sk.plane) return;
    const doc = useDocumentStore.getState().document;
    const prevActive = doc.activeSketchId;
    // undo inside sketch mode is the sketch's: start from an empty history
    useDocumentStore.setState((s) => ({
      document: { ...s.document, activeSketchId: sk.id }, undoStack: [], redoStack: [],
    }));
    const es = useEditorStore.getState();
    es.setActiveTool('select');
    es.clearSelection();
    setGlRect(null); setShown(false); setStrokes(false);
    setSession({ sketchId: sk.id, label: faceLabel(sk.plane.normal), face, plane: planeBasis(sk.plane),
                 prevActive, phase: 'enter' });
  }, []);

  const enter = useCallback((f: FaceRange) => {
    if (sessionRef.current || f.kind !== 'plane') return;
    const doc = useDocumentStore.getState().document;
    let sk = findFaceSketch(doc.sketches, f);
    if (!sk) {
      const base = `Sketch on ${faceLabel(f.normal)}`;
      let name = base;
      for (let i = 2; doc.sketches.some((s) => s.name === name); i++) name = `${base} ${i}`;
      sk = newFaceSketch(name, f, resRef.current?.edges ?? []);
      const added = sk;
      useDocumentStore.setState((s) => ({ document: { ...s.document, sketches: [...s.document.sketches, added] } }));
    }
    start(sk, f.index);
  }, [resRef, start]);

  const open = useCallback((id: string) => {
    const sk = useDocumentStore.getState().document.sketches.find((s) => s.id === id);
    if (!sk) return;
    start(sk, matchFace(sk, resRef.current?.faces ?? [])?.index ?? -1);
  }, [resRef, start]);

  const exit = useCallback(() => {
    const s = sessionRef.current;
    if (!s || s.phase === 'exit') return;
    setStrokes(false);   // the 3D lines take over in place
    setShown(false);
    setGlRect(null);
    setSession({ ...s, phase: 'exit' });
  }, []);

  // 1) overlay mounted (invisible): pin the 3D canvas under the sketch canvas
  useLayoutEffect(() => {
    if (session?.phase !== 'enter' || glRect) return;
    const box = overlayRef.current?.querySelector('canvas')?.parentElement;
    if (!box) return;
    const r = box.getBoundingClientRect();
    setGlRect({ left: r.left, top: r.top, width: box.clientWidth, height: box.clientHeight });
  }, [session, glRect]);

  // 2) the canvas moved: start the camera animation (compensated for the move),
  //    fade the panels in, show the strokes once the part has turned
  const entered = useRef(false);
  useLayoutEffect(() => {
    const s = sessionRef.current, v = viewerRef.current, gl = canvasRef.current;
    if (!s || !v || !gl) return;
    if (s.phase === 'enter' && glRect && !entered.current) {
      entered.current = true;
      const sk = useDocumentStore.getState().document.sketches.find((x) => x.id === s.sketchId);
      const vp = initialFor(sk)(glRect.width, glRect.height);
      const cam = sketchCamera(s.plane, vp, glRect, gl.getBoundingClientRect());
      v.enterSketch({ plane: s.plane, face: s.face, bg: hexRgb(palette.background), center: cam.center, halfH: cam.halfH });
      requestAnimationFrame(() => setShown(true));
      later(FADE_MS, () => {
        setStrokes(true);
        setSession((p) => (p && p.phase === 'enter' ? { ...p, phase: 'on' } : p));
      });
    } else if (s.phase === 'exit' && !glRect && entered.current) {
      entered.current = false;
      v.exitSketch();
      later(FADE_MS + 10, () => {
        const doc = useDocumentStore.getState().document;
        const sk = doc.sketches.find((x) => x.id === s.sketchId);
        // leaving without drawing anything leaves no sketch behind
        const empty = sk && !sk.entities.some((e) => !('construction' in e && e.construction));
        const sketches = empty ? doc.sketches.filter((x) => x.id !== s.sketchId) : doc.sketches;
        const prev = sketches.some((x) => x.id === s.prevActive) ? s.prevActive : sketches[0]?.id ?? doc.activeSketchId;
        useDocumentStore.setState((st) => ({
          document: { ...st.document, sketches, activeSketchId: prev }, undoStack: [], redoStack: [],
        }));
        persistSketches();
        setSession(null);
      });
    }
  }, [glRect, session?.phase, viewerRef, canvasRef, palette.background]);

  // the sketch viewport drives the 3D camera, every frame
  const controller = useMemo<SketchViewportController | undefined>(() => {
    if (!session) return undefined;
    const sk = useDocumentStore.getState().document.sketches.find((x) => x.id === session.sketchId);
    const plane = session.plane;
    return {
      initial: initialFor(sk),
      onFrame: (vp, canvas) => {
        const s = sessionRef.current, v = viewerRef.current, gl = canvasRef.current;
        if (!s || s.phase === 'exit' || !v || !gl) return;
        const r = canvas.getBoundingClientRect();
        const sk2: Rect = { left: r.left, top: r.top, width: r.width, height: r.height };
        const cur = glRectRef.current;
        if (cur && !sameRect(cur, sk2)) setGlRect(sk2);   // window resized
        const cam = sketchCamera(plane, vp, sk2, gl.getBoundingClientRect());
        v.setSketchCamera(cam.center, cam.halfH);
      },
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.sketchId]);

  // parts don't autosave from store changes: save the sketch as it's drawn
  useEffect(() => {
    if (!session?.sketchId) return;
    let t = 0;
    const unsub = useDocumentStore.subscribe((st, prev) => {
      if (st.document.sketches === prev.document.sketches) return;
      clearTimeout(t);
      t = window.setTimeout(persistSketches, 800);
    });
    return () => { unsub(); clearTimeout(t); };
  }, [session?.sketchId]);

  // Esc finishes — only once the sketcher has nothing left to cancel
  useEffect(() => {
    if (!session?.sketchId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const t = e.target as HTMLElement;
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA') return;
      if (document.querySelector('[data-modal]')) return;   // the shortcuts help is open
      const es = useEditorStore.getState();
      if (es.activeTool !== 'select' || es.selectedEntityIds.size || es.selectedPoints.length
          || es.selectedSegments.length || es.editingDimensionId || es.mirrorEntityIds || es.mirrorPickingLine
          || es.circularCopyEntityIds || es.circularCopyPickingCenter || es.gridCopyEntityIds) return;
      e.preventDefault();
      e.stopPropagation();
      exit();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [session?.sketchId, exit]);

  // the stored face sketches, drawn on the part
  const sketches = useDocumentStore((s) => s.document.sketches);
  const pushLines = useCallback(() => {
    viewerRef.current?.setSketchLines(
      useDocumentStore.getState().document.sketches
        .filter((s) => s.face && s.plane && s.visible !== false)
        .map((s) => ({ id: s.id, name: s.name, segments: sketchSegments(s) })),
    );
  }, [viewerRef]);
  useEffect(() => { pushLines(); }, [sketches, pushLines]);

  const fade = `opacity ${FADE_MS}ms ease`;
  const btn: CSSProperties = {
    background: palette.buttonBg, border: `1px solid ${palette.border}`, borderRadius: '4px',
    color: palette.text, fontSize: '12px', padding: '2px 9px', cursor: 'pointer',
  };
  const overlay = session && (
    <>
      <div style={{ position: 'fixed', inset: 0, zIndex: 20, background: palette.background,
                    opacity: shown ? 1 : 0, transition: fade, pointerEvents: 'none' }} />
      <div ref={overlayRef} className={strokes ? undefined : 'sof-hide-strokes'}
           style={{ position: 'fixed', inset: 0, zIndex: 22, opacity: shown ? 1 : 0, transition: fade,
                    pointerEvents: session.phase === 'exit' ? 'none' : 'auto' }}>
        <style>{'.sof-hide-strokes canvas { visibility: hidden; }'}</style>
        <SketchWorkspace
          docId={getBackendId() ?? undefined}
          transparent
          grid={grid}
          soloActiveSketch
          ownsKeyboard
          keys={session.phase === 'exit' ? 'viewport' : 'all'}   // no tool keys while fading out
          viewport={controller}
          toolbar={<Toolbar embedded />}
          overlay={
            <div style={{ position: 'absolute', top: 10, left: '50%', transform: 'translateX(-50%)', zIndex: 5,
                          display: 'flex', alignItems: 'center', gap: '8px', padding: '4px 6px 4px 12px',
                          background: palette.panelBg, border: `1px solid ${palette.border}`, borderRadius: '6px',
                          color: palette.textSecondary, fontSize: '12px', boxShadow: '0 2px 8px rgba(0,0,0,0.25)' }}
                 onMouseDown={(e) => e.preventDefault()}>
              <span>Sketching on <b style={{ color: palette.text }}>{session.label}</b> · Esc to finish</span>
              <button style={{ ...btn, ...(grid ? { color: palette.accent, borderColor: palette.accent } : {}) }}
                      onClick={() => setGrid((g) => !g)} title="Show the grid on the face plane">Grid</button>
              <button style={{ ...btn, background: palette.accent, borderColor: palette.accent, color: '#fff' }}
                      onClick={exit}>Done</button>
            </div>
          }
        />
      </div>
    </>
  );

  return {
    active: !!session,
    activeRef,
    enter,
    open,
    exit,
    canvasStyle: glRect
      ? { position: 'fixed', left: glRect.left, top: glRect.top, width: glRect.width, height: glRect.height, zIndex: 21 }
      : null,
    pushLines,
    overlay,
  };
}
