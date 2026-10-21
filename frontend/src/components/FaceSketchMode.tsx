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
import { dot, len, scale, sub } from '@/build/dragHandle';
import { planeBasis, sketchCamera, fitViewport, type PlaneBasis, type Rect } from '@/build/sketchPlane';
import {
  BASE_PLANES, boundPlane, extrudeDirectionText, extrudeGhost, extrudeSpan, faceLabel, faceSketchMenu, newFaceSketch, partSide,
  newConstructionSketch, newPlaneSketch, onTangentPlane, refreshOutline, sketchBasePlane, sketchBounds, sketchLoops, sketchSegments, type BasePlane,
  type ConstructionPlane, type FaceSketchMenu, type SketchBindings,
} from '@/build/faceSketch';
import { resolveSketch } from '@/utils/resolveSketch';
import type { Sketch } from '@/types/document';

const FADE_MS = 250;
const TURN_MS = 260;   // the viewer's turn into / out of the extrude preview

// the extrude preview's colour per operation
const GHOST: Record<ExtrudeOptions['op'], [number, number, number]> = {
  cut: [0.95, 0.45, 0.35], join: [0.35, 0.85, 0.5], new: [0.25, 0.62, 1.0],
};

/** What the Extrude dialog asks for: the script line it becomes is built by
 *  the backend (/build/add_extrude). "new" makes the part (no part yet);
 *  `datum`: the sketch is on a base plane, not a part face; `both`: the depth
 *  goes each way from a base plane (symmetric). */
export interface ExtrudeOptions {
  op: 'cut' | 'join' | 'new'; depth: number; through: boolean; flip: boolean; both?: boolean; datum?: boolean;
}

interface Session {
  sketchId: string;
  label: string;
  face: number;            // highlighted face index (−1: none matched)
  plane: PlaneBasis;
  datum: boolean;          // on a base plane (no part face)
  prevActive: string;      // the document's active sketch before, restored after
  phase: 'enter' | 'on' | 'exit';
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

// the 3D face a stored sketch was drawn on, in the current build (on the
// plane the build put the sketch on: it follows its face)
function matchFace(sk: Sketch, faces: FaceRange[], bound?: SketchBindings): FaceRange | null {
  const plane = boundPlane(sk, bound);
  if (!plane || !sk.face) return null;
  const b = planeBasis(plane);
  let best: FaceRange | null = null, bestD = Infinity;
  for (const f of faces) {
    if (f.kind !== 'plane' || dot(f.normal, b.normal) < 0.999) continue;
    if (Math.abs(dot(sub(f.center, b.origin), b.normal)) > 0.01) continue;
    const off = sub(f.center, sk.face.center);
    const d = len(sub(off, scale(b.normal, dot(off, b.normal))));
    if (d < bestD) { bestD = d; best = f; }
  }
  return best;
}

// a base plane's sketch frames at least ±50 mm around the origin (its only
// geometry may be the origin marker)
const PLANE_VIEW = 50;
const initialFor = (sk: Sketch | undefined) => (w: number, h: number) => {
  let b = sk ? sketchBounds(sk) : null;
  if (sk && (sketchBasePlane(sk) || sk.planeRef)) {
    const m = PLANE_VIEW;
    b = { min: { x: Math.min(b?.min.x ?? 0, -m), y: Math.min(b?.min.y ?? 0, -m) },
          max: { x: Math.max(b?.max.x ?? 0, m), y: Math.max(b?.max.y ?? 0, m) } };
  }
  return b ? fitViewport(b.min, b.max, w, h) : { offset: { x: w / 2, y: h / 2 }, scale: 4 };
};

export interface FaceSketchApi {
  /** Sketching (including the enter / exit animations). */
  active: boolean;
  activeRef: RefObject<boolean>;
  /** The which-sketch menu is up (its Esc closes it). */
  menuOpen: boolean;
  /** Sketch on this planar face: reopen its sketch, or start one. */
  enter(face: FaceRange): void;
  /** Sketch on a base plane through the origin: reopen its sketch, or start one. */
  enterPlane(which: BasePlane): void;
  /** Sketch on the construction plane `name`: reopen its sketch, or start one. */
  enterConstruction(name: string, plane: ConstructionPlane): void;
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
  /** Sketching finished (saved): `extrude` when it ended with Extrude. */
  onDone?: (sketchName: string, extrude: ExtrudeOptions | null) => void,
  /** The script makes a part already: Extrude offers Cut / Join, else New body. */
  hasPart: () => boolean = () => true,
  /** The part's parameters (its P), for dimensions in the sketch to use. */
  partVars: () => Record<string, number> | null = () => null,
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
  const [extruding, setExtruding] = useState(false);   // the Extrude dialog is open
  const [ex, setEx] = useState<ExtrudeOptions>({ op: 'cut', depth: 5, through: true, flip: false });
  const pendingExtrude = useRef<ExtrudeOptions | null>(null);
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const timers = useRef<number[]>([]);
  const later = (ms: number, f: () => void) => { timers.current.push(window.setTimeout(f, ms)); };
  useEffect(() => () => timers.current.forEach((t) => clearTimeout(t)), []);

  const partVarsRef = useRef(partVars);
  partVarsRef.current = partVars;
  // K on a face with sketches already: which one (or a new one)
  const [menu, setMenu] = useState<(FaceSketchMenu & { x: number; y: number }) | null>(null);
  const pointer = useRef<{ x: number; y: number } | null>(null);
  useEffect(() => {
    const at = (e: PointerEvent) => { pointer.current = { x: e.clientX, y: e.clientY }; };
    window.addEventListener('pointermove', at, true);
    return () => window.removeEventListener('pointermove', at, true);
  }, []);

  const start = useCallback((sk: Sketch, face: number) => {
    if (sessionRef.current || !sk.plane) return;
    setMenu(null);
    const res = resRef.current;
    const vars = partVarsRef.current();
    // a face sketch: its reference outline drawn again from the face as it
    // is now (the part may have changed since), and anything constrained or
    // dimensioned to it solved again
    const f = face >= 0 ? res?.faces?.find((x) => x.index === face) : undefined;
    const plane = boundPlane(sk, res?.sketches, res?.planes) ?? sk.plane;
    const fresh = refreshOutline(sk, f, res?.edges ?? [], plane);
    if (fresh) {
      const r = resolveSketch(fresh, { ...useDocumentStore.getState().document.parameters, ...(vars ?? {}) });
      const next = r.sketch;
      useDocumentStore.setState((st) => ({
        document: { ...st.document, sketches: st.document.sketches.map((x) => (x.id === sk.id ? next : x)) },
      }));
      persistSketches();
      sk = next;
    }
    useEditorStore.getState().setPartParams(vars);
    const doc = useDocumentStore.getState().document;
    const prevActive = doc.activeSketchId;
    // undo inside sketch mode is the sketch's: start from an empty history
    useDocumentStore.setState((s) => ({
      document: { ...s.document, activeSketchId: sk.id }, undoStack: [], redoStack: [],
    }));
    const es = useEditorStore.getState();
    es.setActiveTool('select');
    es.clearSelection();
    setGlRect(null); setShown(false); setStrokes(false); setExtruding(false);
    pendingExtrude.current = null;
    const base = sketchBasePlane(sk);
    // drawn on a face: on that face where the last build found it
    const label = sk.planeRef ? `plane '${sk.planeRef}'` : base ? BASE_PLANES[base].name : faceLabel(plane.normal);
    const datum = !sk.face && !onTangentPlane(sk, res?.planes);
    // the part's edges, for the project tool (the part in front of a face is cut away)
    es.setProjectSource(res?.edges?.length ? { edges: res.edges, plane: planeBasis(plane), clipped: !datum } : null);
    setSession({ sketchId: sk.id, label, face,
                 plane: planeBasis(plane), datum, prevActive, phase: 'enter' });
  }, [resRef]);

  // a new sketch on the face
  const startNew = useCallback((f: FaceRange) => {
    const doc = useDocumentStore.getState().document;
    const base = `Sketch on ${faceLabel(f.normal)}`;
    let name = base;
    for (let i = 2; doc.sketches.some((s) => s.name === name); i++) name = `${base} ${i}`;
    const sk = newFaceSketch(name, f, resRef.current?.edges ?? []);
    useDocumentStore.setState((s) => ({ document: { ...s.document, sketches: [...s.document.sketches, sk] } }));
    start(sk, f.index);
  }, [resRef, start]);

  const enter = useCallback((f: FaceRange) => {
    if (sessionRef.current || f.kind !== 'plane') return;
    const doc = useDocumentStore.getState().document;
    const m = faceSketchMenu(doc.sketches, f, resRef.current?.sketches);
    if (!m) { startNew(f); return; }
    // the face has sketches: ask which (even with one — a second sketch on a face is a fair thing to want)
    const r = canvasRef.current?.getBoundingClientRect();
    const at = pointer.current ?? (r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : { x: 200, y: 200 });
    setMenu({ ...m, x: at.x, y: at.y });
  }, [resRef, canvasRef, startNew]);

  const pick = useCallback((id: string | null) => {
    const m = menu;
    setMenu(null);
    if (!m) return;
    const f = m.face as FaceRange;
    if (id == null) { startNew(f); return; }
    const sk = useDocumentStore.getState().document.sketches.find((s) => s.id === id);
    if (sk) start(sk, f.index);
  }, [menu, start, startNew]);

  useEffect(() => {
    if (!menu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault(); e.stopPropagation();
      setMenu(null);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [menu]);

  const enterPlane = useCallback((which: BasePlane) => {
    if (sessionRef.current) return;
    const doc = useDocumentStore.getState().document;
    let sk = doc.sketches.find((s) => sketchBasePlane(s) === which);
    if (!sk) {
      const base = `Sketch on ${BASE_PLANES[which].name}`;
      let name = base;
      for (let i = 2; doc.sketches.some((s) => s.name === name); i++) name = `${base} ${i}`;
      sk = newPlaneSketch(name, which);
      const added = sk;
      useDocumentStore.setState((s) => ({ document: { ...s.document, sketches: [...s.document.sketches, added] } }));
    }
    start(sk, -1);
  }, [start]);

  const enterConstruction = useCallback((name: string, plane: ConstructionPlane) => {
    if (sessionRef.current) return;
    const doc = useDocumentStore.getState().document;
    let sk = doc.sketches.find((s) => s.planeRef === name);
    if (!sk) {
      const base = `Sketch on ${name}`;
      let label = base;
      for (let i = 2; doc.sketches.some((s) => s.name === label); i++) label = `${base} ${i}`;
      sk = newConstructionSketch(label, name, plane);
      const added = sk;
      useDocumentStore.setState((s) => ({ document: { ...s.document, sketches: [...s.document.sketches, added] } }));
    }
    start(sk, -1);
  }, [start]);

  const open = useCallback((id: string) => {
    const sk = useDocumentStore.getState().document.sketches.find((s) => s.id === id);
    if (!sk) return;
    start(sk, matchFace(sk, resRef.current?.faces ?? [], resRef.current?.sketches)?.index ?? -1);
  }, [resRef, start]);

  const exit = useCallback(() => {
    const s = sessionRef.current;
    if (!s || s.phase === 'exit') return;
    setStrokes(false);   // the 3D lines take over in place
    setShown(false);
    setExtruding(false);
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
      v.enterSketch({ plane: s.plane, face: s.face, bg: hexRgb(palette.background), center: cam.center, halfH: cam.halfH,
                      clip: !s.datum });
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
        useEditorStore.getState().setPartParams(null);
        useEditorStore.getState().setProjectSource(null);
        if (useEditorStore.getState().activeTool === 'project') useEditorStore.getState().setActiveTool('select');
        setSession(null);
        const extrude = pendingExtrude.current;
        pendingExtrude.current = null;
        if (sk && !empty) onDoneRef.current?.(sk.name, extrude);
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

  const extrudingRef = useRef(false);
  extrudingRef.current = extruding;
  // Esc finishes — only once the sketcher has nothing left to cancel
  useEffect(() => {
    if (!session?.sketchId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const t = e.target as HTMLElement;
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA') return;
      if (document.querySelector('[data-modal]')) return;   // the shortcuts help is open
      if (extrudingRef.current) { e.preventDefault(); e.stopPropagation(); setExtruding(false); return; }
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

  // the stored face sketches, drawn on the part — where the last build put
  // them (each follows its face); ScriptViewer pushes again after a build
  const sketches = useDocumentStore((s) => s.document.sketches);
  const pushLines = useCallback(() => {
    const bound = resRef.current?.sketches;
    viewerRef.current?.setSketchLines(
      useDocumentStore.getState().document.sketches
        .filter((s) => s.plane && s.visible !== false)
        .map((s) => ({ id: s.id, name: s.name, segments: sketchSegments(s, boundPlane(s, bound, resRef.current?.planes)) })),
    );
  }, [viewerRef, resRef]);
  useEffect(() => { pushLines(); }, [sketches, pushLines]);

  const current = session ? sketches.find((x) => x.id === session.sketchId) : undefined;
  const shapes = useMemo(() => (current ? sketchLoops(current) : { loops: [], open: 0 }), [current]);
  const hasPartRef = useRef(hasPart);
  hasPartRef.current = hasPart;
  // the dialog offers New body only while there is no part, Cut / Join after
  const toggleExtrude = () => {
    if (!extruding) {
      const part = hasPartRef.current();
      setEx((e) => (part ? (e.op === 'new' ? { ...e, op: 'cut' } : e) : { ...e, op: 'new', depth: e.op === 'new' ? e.depth : 10 }));
    }
    setExtruding((o) => !o);
  };
  const applyExtrude = () => {
    if (!shapes.loops.length || !(ex.depth > 0 || (ex.op === 'cut' && ex.through))) return;
    pendingExtrude.current = shapeOf(ex, !!session?.datum);
    exit();
  };

  // while the dialog is open the view turns off the plane and shows what the
  // extrude makes: the shapes at each end, and arrows the way it goes
  const previewing = useRef(false);
  const phase = session?.phase;
  useEffect(() => {
    const v = viewerRef.current, s = sessionRef.current;
    if (!v || !s || phase === 'exit') { previewing.current = false; return; }
    if (!extruding || !current) {
      if (!previewing.current) return;
      previewing.current = false;
      v.setExtrudePreview(null);
      later(TURN_MS, () => { if (sessionRef.current && sessionRef.current.phase !== 'exit') setStrokes(true); });
      return;
    }
    const o = shapeOf(ex, s.datum);
    const m = resRef.current?.metrics;
    let extent: [number, number] | null = null;
    if (m && hasPartRef.current()) {
      const ds: number[] = [];
      for (const x of [m.bbox_min[0], m.bbox_max[0]]) for (const y of [m.bbox_min[1], m.bbox_max[1]])
        for (const z of [m.bbox_min[2], m.bbox_max[2]]) ds.push(dot(sub([x, y, z], s.plane.origin), s.plane.normal));
      extent = [Math.min(...ds), Math.max(...ds)];
    }
    const g = extrudeGhost(current, extrudeSpan(o, extent), { origin: s.plane.origin, normal: s.plane.normal, xAxis: s.plane.xDir });
    setStrokes(false);   // the flat drawing doesn't line up once the view turns
    previewing.current = true;
    v.setExtrudePreview({ ...g, color: GHOST[ex.op] });
  }, [extruding, ex, current, phase, viewerRef, resRef]);
  // where the part is from the plane: the extrude's words for a tilted plane
  const partM = session && hasPart() ? resRef.current?.metrics : undefined;
  const partAt = session && partM ? partSide(session.plane.origin, session.plane.normal, partM.bbox_min, partM.bbox_max) : undefined;

  const fade = `opacity ${FADE_MS}ms ease`;
  const btn: CSSProperties = {
    background: palette.buttonBg, border: `1px solid ${palette.border}`, borderRadius: '4px',
    color: palette.text, fontSize: '12px', padding: '2px 9px', cursor: 'pointer',
  };
  const menuOverlay = menu && !session && (
    <>
      <div style={{ position: 'fixed', inset: 0, zIndex: 30 }} onMouseDown={() => setMenu(null)} />
      <div role="menu" aria-label="Sketch on this face"
           style={{ position: 'fixed', zIndex: 31, minWidth: 220,
                    left: Math.max(8, Math.min(menu.x, window.innerWidth - 240)),
                    top: Math.max(8, Math.min(menu.y, window.innerHeight - 60 - 30 * menu.items.length)),
                    padding: '4px', background: palette.panelBg, border: `1px solid ${palette.border}`,
                    borderRadius: '6px', boxShadow: '0 4px 14px rgba(0,0,0,0.3)', fontSize: '12px', color: palette.text }}>
        <div style={{ padding: '3px 8px 5px', color: palette.textSecondary }}>
          Sketches on the {faceLabel(menu.face.normal)}
        </div>
        {menu.items.map((it) => (
          <MenuItem key={it.id} onClick={() => pick(it.id)}>
            <span>{it.name}</span>
            <span style={{ color: palette.textSecondary }}>{it.count} {it.count === 1 ? 'shape' : 'shapes'}</span>
          </MenuItem>
        ))}
        <div style={{ borderTop: `1px solid ${palette.border}`, margin: '4px 0' }} />
        <MenuItem onClick={() => pick(null)}><span>New sketch on this face</span></MenuItem>
      </div>
    </>
  );

  const overlay = menuOverlay || session && (
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
              <button style={{ ...btn, ...(extruding ? { color: palette.accent, borderColor: palette.accent } : {}) }}
                      onClick={toggleExtrude}
                      title="Turn the closed shapes into 3D: the part's first shape, or cut into / grow out of it">Extrude…</button>
              <button style={{ ...btn, background: palette.accent, borderColor: palette.accent, color: '#fff' }}
                      onClick={exit}>Done</button>
              {extruding && (
                <ExtrudeDialog value={ex} onChange={setEx} shapes={shapes.loops.length} open={shapes.open} datum={session.datum}
                               direction={extrudeDirectionText(shapeOf(ex, session.datum), session.plane.normal, partAt)}
                               onApply={applyExtrude} onCancel={() => setExtruding(false)} />
              )}
            </div>
          }
        />
      </div>
    </>
  );

  return {
    active: !!session,
    activeRef,
    /** the which-sketch menu is up (its Esc closes it) */
    menuOpen: !!menu,
    enter,
    enterPlane,
    enterConstruction,
    open,
    exit,
    canvasStyle: glRect
      ? { position: 'fixed', left: glRect.left, top: glRect.top, width: glRect.width, height: glRect.height, zIndex: 21 }
      : null,
    pushLines,
    overlay,
  };
}

/** The options as the script line will take them: through is for cuts, and
 *  both ways is for base planes, not with through. */
function shapeOf(ex: ExtrudeOptions, datum: boolean): ExtrudeOptions {
  const through = ex.op === 'cut' && ex.through;
  return { ...ex, through, both: datum && !through && !!ex.both, datum };
}

function MenuItem({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  const palette = useThemeStore((s) => s.palette);
  const [hover, setHover] = useState(false);
  return (
    <button role="menuitem" onClick={onClick} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
            style={{ display: 'flex', justifyContent: 'space-between', gap: '16px', width: '100%', padding: '5px 8px',
                     border: 'none', borderRadius: '4px', cursor: 'pointer', fontSize: '12px', textAlign: 'left',
                     background: hover ? palette.buttonBg : 'transparent', color: palette.text }}>
      {children}
    </button>
  );
}

function ExtrudeDialog({ value, onChange, shapes, open, datum, direction, onApply, onCancel }: {
  value: ExtrudeOptions; onChange: (v: ExtrudeOptions) => void;
  shapes: number; open: number; datum: boolean; direction: string; onApply: () => void; onCancel: () => void;
}) {
  const palette = useThemeStore((s) => s.palette);
  const through = value.op === 'cut' && value.through;
  const both = datum && !through && !!value.both;
  const ok = shapes > 0 && (through || value.depth > 0);
  const set = (p: Partial<ExtrudeOptions>) => onChange({ ...value, ...p });
  const seg = (on: boolean): CSSProperties => ({
    flex: 1, padding: '3px 0', fontSize: '12px', cursor: 'pointer', border: `1px solid ${on ? palette.accent : palette.border}`,
    background: on ? palette.accent : palette.buttonBg, color: on ? '#fff' : palette.text,
  });
  const row: CSSProperties = { display: 'flex', alignItems: 'center', gap: '8px', color: palette.text };
  return (
    // the banner swallows mousedown (keeps the sketch focused): let the fields have it
    <div role="dialog" aria-label="Extrude" onMouseDown={(e) => e.stopPropagation()}
         onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter' && ok) onApply(); }}
         style={{ position: 'absolute', top: 'calc(100% + 6px)', right: 0, width: 230, padding: '10px 12px',
                  display: 'flex', flexDirection: 'column', gap: '9px', textAlign: 'left',
                  background: palette.panelBg, border: `1px solid ${palette.border}`, borderRadius: '6px',
                  boxShadow: '0 4px 14px rgba(0,0,0,0.3)', fontSize: '12px' }}>
      {value.op === 'new' ? (
        <div style={{ color: palette.text, lineHeight: 1.4 }}>
          <b>New body</b>
          <div style={{ color: palette.textSecondary }}>The shapes become the part, extruded to a height.</div>
        </div>
      ) : (
        <div style={{ display: 'flex' }}>
          <button style={{ ...seg(value.op === 'cut'), borderRadius: '4px 0 0 4px' }} onClick={() => set({ op: 'cut' })}
                  title="Remove the shapes from the part (holes, pockets)">Cut</button>
          <button style={{ ...seg(value.op === 'join'), borderRadius: '0 4px 4px 0', borderLeft: 'none' }}
                  onClick={() => set({ op: 'join' })} title="Add the shapes to the part (pegs, bosses)">Join</button>
        </div>
      )}
      {value.op === 'cut' && (
        <label style={row}>
          <input type="checkbox" checked={value.through} onChange={(e) => set({ through: e.target.checked })} />
          Through all{datum ? ' (both ways)' : ''}
        </label>
      )}
      <label style={{ ...row, opacity: through ? 0.45 : 1 }}>
        <span style={{ width: 52 }}>{both ? 'Each way' : value.op === 'cut' ? 'Depth' : 'Height'}</span>
        <input type="number" min={0} step={0.5} value={value.depth} disabled={through}
               onChange={(e) => set({ depth: parseFloat(e.target.value) })}
               style={{ width: 70, fontSize: '12px', padding: '2px 4px', background: palette.inputBg,
                        color: palette.text, border: `1px solid ${palette.border}`, borderRadius: '3px' }} />
        <span style={{ color: palette.textSecondary }}>mm</span>
      </label>
      {datum && !through && (
        <label style={row} title="Extrude the depth to both sides of the plane, so the plane is the middle">
          <input type="checkbox" checked={both} onChange={(e) => set({ both: e.target.checked })} />
          Both ways (symmetric)
        </label>
      )}
      <label style={{ ...row, opacity: both || (through && datum) ? 0.45 : 1 }}
             title="Send it the other way along the face's normal — the arrows in the view show where it goes">
        <input type="checkbox" checked={value.flip && !(both || (through && datum))} disabled={both || (through && datum)}
               onChange={(e) => set({ flip: e.target.checked })} />
        Flip direction
      </label>
      <div style={{ color: palette.text, lineHeight: 1.4, padding: '4px 6px', borderRadius: '4px',
                    background: palette.buttonBg }}>
        {direction}
      </div>
      <div style={{ color: shapes ? palette.textSecondary : palette.danger, lineHeight: 1.4 }}>
        {shapes ? `${shapes} closed shape${shapes > 1 ? 's' : ''}` : 'No closed shapes to extrude'}
        {open ? ` · ${open} open (ignored)` : ''}
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '6px' }}>
        <button onClick={onCancel} style={{ fontSize: '12px', padding: '2px 10px', cursor: 'pointer', borderRadius: '4px',
                                            background: palette.buttonBg, color: palette.text, border: `1px solid ${palette.border}` }}>
          Cancel
        </button>
        <button onClick={onApply} disabled={!ok}
                style={{ fontSize: '12px', padding: '2px 10px', cursor: ok ? 'pointer' : 'default', borderRadius: '4px', opacity: ok ? 1 : 0.5,
                         background: palette.accent, color: '#fff', border: `1px solid ${palette.accent}` }}>
          {value.op === 'cut' ? 'Cut' : value.op === 'join' ? 'Join' : 'Create'}
        </button>
      </div>
    </div>
  );
}
