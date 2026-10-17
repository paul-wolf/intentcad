import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { useThemeStore } from '@/theme';
import { useDocumentStore } from '@/stores/documentStore';
import { api, buildApi, errorText, ApiError, type RunResponse, type UsageResponse, type DimInfo, type ModelInfo, type SizeFix } from '@/api/client';
import { persistModelCode, persistChat, persistThumbnail, persistName, persistProductionNotes, getBackendId } from '@/api/autoSave';
import { DEFAULT_PRODUCTION_NOTES } from '@/utils/document';
import type { ChatMessage } from '@/types/document';
import { createViewer, type Viewer, type FaceRange, type AxisDir, type PlacedDim, type PlacedHandle } from '@/build/webglViewer';
import { handleOptions, add, scale, dot, len, sub, type HandleOption, type Vec3 } from '@/build/dragHandle';
import { VIEW_KEYS, type StandardView } from '@/build/viewOrient';
import { highlightPython, DARK_SYNTAX, LIGHT_SYNTAX } from '@/build/pyHighlight';
import { downloadTextFile } from '@/export/download';
import { buildKey, getCachedBuild, putCachedBuild, putCachedSens } from '@/build/buildCache';
import { importScript, importLabel, STEP_ACCEPT } from '@/build/importStep';
import { PartVersionsPanel } from './PartVersionsPanel';
import { PartHelpModal } from './PartHelpModal';

// the view buttons, in key order (1–6, then 0)
const VIEW_BUTTONS = (['1', '2', '3', '4', '5', '6', '0'] as const)
  .map((k) => [k, VIEW_KEYS[k]!] as [string, StandardView]);

interface Props {
  onClose: () => void;
  /** When the editor is a standalone page, breadcrumb nav (saves first). */
  onHome?: () => void;
  onProject?: () => void;
}

// stable empty reference so the zustand selector below doesn't return a fresh
// array every render (which would loop: new snapshot → re-render → new snapshot)
const humanBytes = (b: number): string =>
  b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1048576).toFixed(1)} MB`;

const NO_CHAT: ChatMessage[] = [];

// a sensitivity map cached before per-face `shifts` existed can't drive drag
// handles — treat it as missing so it's recomputed
const sensCurrent = (s: Record<string, DimInfo>) => Object.values(s).every((d) => d.shifts && d.radial);

// A starter model so an empty document shows something buildable. The whole CAD
// vocabulary is build123d's — this is just a seed to edit / for the AI to replace.
const STARTER = `# build123d — the model is this script. \`part\` is what gets built.
P = dict(plate=60, thick=6, boss_d=24, boss_h=24, bore_d=14, bolt_d=5)

part = Pos(0, 0, P["thick"]/2) * Box(P["plate"], P["plate"], P["thick"])

# a socket (tube) standing on the plate
zc = P["thick"] + P["boss_h"]/2
part += Pos(0, 0, zc) * (Cylinder(P["boss_d"]/2, P["boss_h"])
                         - Cylinder(P["bore_d"]/2, P["boss_h"]))

# retaining cross-hole through the socket wall
part -= Pos(0, 0, zc) * Rot(90, 0, 0) * Cylinder(P["bolt_d"]/2, P["boss_d"]*2)
`;

export function ScriptViewer({ onClose, onHome, onProject }: Props) {
  const palette = useThemeStore((s) => s.palette);
  const isDark = useThemeStore((s) => s.theme === 'dark');
  const docName = useDocumentStore((s) => s.document.name);
  const chat = useDocumentStore((s) => s.document.chat ?? NO_CHAT);
  const productionNotes = useDocumentStore((s) => s.document.productionNotes ?? DEFAULT_PRODUCTION_NOTES);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const viewerRef = useRef<Viewer | null>(null);
  const thumbTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // lazy sensitivity: compute the param→face map only when first needed
  const builtCodeRef = useRef<string>('');
  const sensKeyRef = useRef<string | null>(null);
  const ensureSens = () => {
    const src = builtCodeRef.current;
    if (!src) return;
    const key = buildKey(src);
    if (sensKeyRef.current === key) return;   // already computed or in flight
    sensKeyRef.current = key;
    setSensState('loading');
    buildApi.sensitivity(src, getBackendId() ?? '')
      .then((r) => {
        if (sensKeyRef.current !== key) return;
        setSens(r.params); setSensState('ready'); putCachedSens(key, r.params);
      })
      .catch(() => { if (sensKeyRef.current === key) { sensKeyRef.current = null; setSensState('error'); } });
  };
  // syntax-highlight overlay: a highlighted <pre> behind a transparent <textarea>
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const preRef = useRef<HTMLPreElement | null>(null);
  const gutterRef = useRef<HTMLDivElement | null>(null);
  const syncScroll = () => {
    const ta = taRef.current, pre = preRef.current, g = gutterRef.current;
    if (ta && pre) { pre.scrollTop = ta.scrollTop; pre.scrollLeft = ta.scrollLeft; }
    if (ta && g) g.scrollTop = ta.scrollTop;   // line numbers follow the vertical scroll
  };
  // orientation gizmo: three labeled axes from a shared origin, updated via refs
  // each frame (no React re-render on orbit)
  const gLine = useRef<(SVGLineElement | null)[]>([]);
  const gLabel = useRef<(SVGTextElement | null)[]>([]);
  const gHit = useRef<(SVGCircleElement | null)[]>([]);   // click targets over the labels
  const onAxes = (dirs: AxisDir[]) => {
    const C = 34, R = 22;
    dirs.forEach((d, i) => {
      const op = (0.35 + 0.65 * ((d.z + 1) / 2)).toFixed(2);   // dim axes pointing away
      const ln = gLine.current[i], lb = gLabel.current[i];
      if (ln) {
        ln.setAttribute('x2', `${C + d.x * R}`); ln.setAttribute('y2', `${C - d.y * R}`);
        ln.setAttribute('opacity', op);
      }
      if (lb) {
        lb.setAttribute('x', `${C + d.x * (R + 8)}`); lb.setAttribute('y', `${C - d.y * (R + 8) + 4}`);
        lb.setAttribute('opacity', op);
      }
      const hit = gHit.current[i];
      if (hit) { hit.setAttribute('cx', `${C + d.x * (R + 8)}`); hit.setAttribute('cy', `${C - d.y * (R + 8)}`); }
    });
  };

  // dimension overlay (hold Opt/Alt): each param's value drawn on the geometry
  // it controls. The label DOM is rendered from `dimList` (changes rarely) and
  // positioned every frame via these refs — no React re-render on orbit.
  type DimEls = { arrow: SVGLineElement | null; lead: SVGLineElement | null; label: SVGTextElement | null };
  const dimG = useRef<Map<string, DimEls>>(new Map());
  const setDimRef = (key: string, k: keyof DimEls, el: SVGLineElement | SVGTextElement | null) => {
    const g = dimG.current.get(key) ?? { arrow: null, lead: null, label: null };
    g[k] = el as never; dimG.current.set(key, g);
  };
  // Anchors cluster in the middle of a small part, so labels are offset to their
  // dimension-arrow tip and pushed apart vertically so they never overlap; a thin
  // leader ties each value back to its feature. No dependency on viewport size,
  // so a label is shown whenever its feature is facing the camera.
  const onDims = (placed: PlacedDim[]) => {
    const vis = placed.filter((p) => p.visible).sort((a, b) => a.ay - b.ay);
    const GAP = 16;
    const ly = new Map<string, number>();
    let prev = -Infinity;
    for (const p of vis) {
      const y = Math.max(p.ay, prev + GAP);
      prev = y;
      ly.set(p.key, y);
    }
    for (const p of placed) {
      const g = dimG.current.get(p.key);
      if (!g) continue;
      const op = p.visible ? '1' : '0';
      const labY = ly.get(p.key) ?? p.ay;
      const right = p.ax >= p.x;              // arrow tip points right → text to the right
      const labX = p.ax + (right ? 4 : -4);
      if (g.arrow) {                          // short double-arrow along the dim axis
        const dx = p.ax - p.x, dy = p.ay - p.y;
        g.arrow.setAttribute('x1', `${p.x - dx}`); g.arrow.setAttribute('y1', `${p.y - dy}`);
        g.arrow.setAttribute('x2', `${p.ax}`); g.arrow.setAttribute('y2', `${p.ay}`);
        g.arrow.setAttribute('opacity', op);
      }
      if (g.lead) {                           // leader: feature → offset label
        g.lead.setAttribute('x1', `${p.x}`); g.lead.setAttribute('y1', `${p.y}`);
        g.lead.setAttribute('x2', `${labX}`); g.lead.setAttribute('y2', `${labY}`);
        g.lead.setAttribute('opacity', p.visible ? '0.45' : '0');
      }
      if (g.label) {
        g.label.setAttribute('x', `${labX}`); g.label.setAttribute('y', `${labY + 4}`);
        g.label.setAttribute('text-anchor', right ? 'start' : 'end');
        g.label.setAttribute('opacity', op);
      }
    }
  };

  // drag handle (one face selected): an arrow along the shift of the param
  // that moves the face, positioned every frame via refs like the dims
  type HandleEls = { line: SVGLineElement | null; knob: SVGCircleElement | null;
                     label: SVGTextElement | null; sub: SVGTextElement | null };
  const hEls = useRef<HandleEls>({ line: null, knob: null, label: null, sub: null });
  const handleRef = useRef<HandleOption | null>(null);
  const handleHintRef = useRef('');   // "Tab ⇄ 1/2" when several params move the face
  const onHandle = (p: PlacedHandle | null) => {
    const { line, knob, label, sub: subEl } = hEls.current;
    const h = handleRef.current;
    const show = !!(p && h && p.visible);
    for (const el of [line, knob, label, subEl]) el?.setAttribute('opacity', show ? '1' : '0');
    if (!show || !p || !h) return;
    line?.setAttribute('x1', `${p.x}`); line?.setAttribute('y1', `${p.y}`);
    line?.setAttribute('x2', `${p.ax}`); line?.setAttribute('y2', `${p.ay}`);
    knob?.setAttribute('cx', `${p.x}`); knob?.setAttribute('cy', `${p.y}`);
    const right = p.ax >= p.x;              // label past the arrow tip
    const lx = `${p.ax + (right ? 9 : -9)}`, anchor = right ? 'start' : 'end';
    if (label) {
      label.setAttribute('x', lx); label.setAttribute('y', `${p.ay + 4}`);
      label.setAttribute('text-anchor', anchor);
      label.textContent = p.dragging && p.value !== h.value
        ? `${h.name} ${dimFmt(h.value)} → ${dimFmt(p.value)}`
        : `${h.name} ${dimFmt(p.value)}`;
    }
    if (subEl) {
      subEl.setAttribute('x', lx); subEl.setAttribute('y', `${p.ay + 18}`);
      subEl.setAttribute('text-anchor', anchor);
      const snapped = p.snapFace !== null;
      subEl.setAttribute('fill', snapped ? '#2dd4bf' : '#cfd6df');
      subEl.textContent = snapped ? `snap → face #${p.snapFace}`
        : p.dragging ? 'Shift: 0.1 steps · Esc cancels' : handleHintRef.current;
    }
  };

  const [code, setCode] = useState('');
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [flash, setFlash] = useState('');
  const [status, setStatus] = useState<'idle' | 'building' | 'done' | 'error'>('idle');
  const [message, setMessage] = useState('');
  const [warn, setWarn] = useState('');
  // the engine's one-click remedy for a fillet/chamfer that doesn't fit (a
  // param to set), from the last build error or warning
  const [fix, setFix] = useState<SizeFix | null>(null);
  const [stats, setStats] = useState('');
  const [sel, setSel] = useState<number[]>([]);   // selected face indices (≤ 2)
  const resRef = useRef<RunResponse | null>(null);
  const selRef = useRef<number[]>([]);
  // highlight the edges auto_round couldn't round (the footer's toggle)
  const [showSkipped, setShowSkipped] = useState(false);
  const showSkippedRef = useRef(false);
  const buildAbort = useRef<AbortController | null>(null);   // cancel an in-flight build
  const cancelBuild = () => { buildAbort.current?.abort(); };

  // click a face → toggle it in the selection (keep at most 2). With two faces
  // selected, highlight the edge(s) between them (an edge = two faces meeting).
  const onPick = (f: FaceRange | null) => {
    let s = selRef.current;
    if (!f) s = [];
    else if (s.includes(f.index)) s = s.filter((i) => i !== f.index);
    else s = [...s, f.index].slice(-2);
    applySelection(s);
  };
  const applySelection = (s: number[]) => {
    const res = resRef.current;
    selRef.current = s;
    setSel(s);
    if (s.length) ensureSens();   // selecting geometry → we want the param links
    viewerRef.current?.selectFaces(s);
    const segs: number[] = [];
    if (res && s.length === 2) {
      for (const e of res.edges) {
        if (e.faceIndices.length === 2 && e.faceIndices.includes(s[0]!) && e.faceIndices.includes(s[1]!)) {
          for (let i = 0; i < e.polyline.length - 1; i++) segs.push(...e.polyline[i]!, ...e.polyline[i + 1]!);
        }
      }
      // measurement line: straight between the two face centers (e.g. hole-to-hole)
      const a = res.faces.find((x) => x.index === s[0]);
      const b = res.faces.find((x) => x.index === s[1]);
      if (a && b) segs.push(...a.center, ...b.center);
    }
    if (res?.auto_round && showSkippedRef.current) {
      for (const e of res.auto_round.skipped) {
        for (let i = 0; i < e.polyline.length - 1; i++) segs.push(...e.polyline[i]!, ...e.polyline[i + 1]!);
      }
    }
    viewerRef.current?.highlightEdges(segs);
  };
  const toggleSkipped = () => {
    showSkippedRef.current = !showSkippedRef.current;
    setShowSkipped(showSkippedRef.current);
    applySelection(selRef.current);
  };

  // readout for the current selection: a hole's diameter (1 face) or the
  // center-to-center distance (2 faces), plus each selected hole's diameter.
  const measure = (() => {
    const res = resRef.current;
    if (!res || sel.length === 0) return null;
    const faceOf = (i: number) => res.faces.find((x) => x.index === i);
    const dia = (f?: FaceRange) => (f && f.kind === 'cylinder' && f.radius ? f.radius * 2 : null);
    if (sel.length === 1) {
      const f = faceOf(sel[0]!);
      if (!f) return null;
      const d = dia(f);
      if (d) return { single: true as const, dia: d, w: null as number | null, h: null as number | null };
      const s = f.size ? [...f.size].sort((a, b) => b - a) : null;   // two largest extents
      if (s && s[0]! > 1e-6) return { single: true as const, dia: null as number | null, w: s[0]!, h: s[1]! };
      return null;
    }
    const a = faceOf(sel[0]!), b = faceOf(sel[1]!);
    if (!a || !b) return null;
    const dx = b.center[0] - a.center[0], dy = b.center[1] - a.center[1], dz = b.center[2] - a.center[2];
    return { single: false as const, dist: Math.hypot(dx, dy, dz), dx, dy, dz, diaA: dia(a), diaB: dia(b) };
  })();

  // What a build came to — so a caller (a parameter edit) can act on it.
  type BuildOutcome =
    | { kind: 'ok' }
    | { kind: 'aborted' }
    | { kind: 'warning' | 'error'; message: string; fix: SizeFix | null };

  const build = async (src: string, versionLabel?: string): Promise<BuildOutcome> => {
    if (!viewerRef.current) return { kind: 'aborted' };
    buildAbort.current?.abort();                 // supersede any in-flight build
    const ctrl = new AbortController();
    buildAbort.current = ctrl;
    setStatus('building');
    setMessage('');
    const t0 = performance.now();
    try {
      // Deterministic: same code → same mesh. Serve an unchanged part from the
      // IndexedDB cache with no engine call.
      const key = buildKey(src);
      const cached = await getCachedBuild(key);
      const res = cached?.run ?? await buildApi.run(src, ctrl.signal, getBackendId() ?? '');
      const took = Math.round(performance.now() - t0);
      setWarn(res.warning ?? '');
      setFix(res.fix?.param ? res.fix : null);
      viewerRef.current.update(res.mesh, res.faces);
      resRef.current = res;
      setParamVals(res.params);
      paramBase.current = res.params;
      if (!cached) putCachedBuild(key, res);
      // sensitivity (perturbation = N rebuilds) is computed LAZILY — only when
      // something actually needs the param→face links (hover a param, ⌥, or a
      // selection). Just prime the state here; ensureSens() does the work.
      builtCodeRef.current = src;
      if (cached?.sens && sensCurrent(cached.sens)) { setSens(cached.sens); setSensState('ready'); sensKeyRef.current = key; }
      else { setSens({}); setSensState('idle'); sensKeyRef.current = null; }
      // a handle drop rebuilt this: keep the dragged face selected — found
      // where the drag put it — so it can be dragged again. Otherwise clear.
      const want = reselectRef.current;
      let keep: number[] = [];
      if (want && Math.abs((res.params[want.param] ?? NaN) - want.value) < 1e-9) {
        reselectRef.current = null;
        let best = want.tol;
        for (const f of res.faces) {
          if (dot(f.normal, want.normal) < 0.99) continue;
          const d = len(sub(f.center, want.center));
          if (d < best) { best = d; keep = [f.index]; }
        }
      }
      applySelection(keep);
      const m = res.metrics;
      const sz = [0, 1, 2].map((i) => Math.round((m.bbox_max[i]! - m.bbox_min[i]!) * 10) / 10);
      const tris = res.mesh.triangle_count;
      const verts = res.mesh.positions.length / 3;
      const stlBytes = 84 + tris * 50;   // binary STL: 84B header + 50B/triangle
      setStats(
        `${cached ? 'cached' : `${took} ms`} · ${humanBytes(stlBytes)} · ` +
        `${res.faces.length} faces · ${tris.toLocaleString()} triangles (${verts.toLocaleString()} verts) · ` +
        `${sz[0]}×${sz[1]}×${sz[2]} mm · vol ${Math.round(m.volume).toLocaleString()} mm³ · area ${Math.round(m.area).toLocaleString()} mm²`,
      );
      setStatus('done');
      // The build succeeded, so this code is a coherent, buildable snapshot —
      // record it as an immutable version (deduped server-side; a rebuild of
      // unchanged code adds nothing).
      snapshotVersion(src, versionLabel);
      // capture a thumbnail from the freshly-framed view (debounced so rapid
      // rebuilds coalesce into one save)
      if (thumbTimer.current) clearTimeout(thumbTimer.current);
      thumbTimer.current = setTimeout(() => {
        const url = viewerRef.current?.capture();
        if (url) persistThumbnail(url);
      }, 1400);
      if (res.warning) return { kind: 'warning', message: res.warning, fix: res.fix?.param ? res.fix : null };
      return { kind: 'ok' };
    } catch (err) {
      // Cancelled by the user (or superseded by a newer build) — not an error.
      if (err instanceof DOMException && err.name === 'AbortError') {
        if (buildAbort.current === ctrl) { setStatus('idle'); setMessage(''); }
        return { kind: 'aborted' };
      }
      const fix = err instanceof ApiError && err.fix?.param ? err.fix : null;
      setStatus('error');
      setMessage(errorText(err));
      setFix(fix);
      // nothing built, but the script's params are known — keep the parameter
      // editor up so there's a way to change the offending value
      if (err instanceof ApiError && err.params && Object.keys(err.params).length) {
        setParamVals(err.params);
        paramBase.current = err.params;
      }
      return { kind: 'error', message: errorText(err), fix };
    } finally {
      if (buildAbort.current === ctrl) buildAbort.current = null;
    }
  };

  // A version is recorded only on a successful BUILD — a coherent, buildable
  // snapshot. In-progress hand edits persist as DRAFTS (saved for durability but
  // not versioned), so half-finished states between builds don't clutter history.
  // Never persist the untouched STARTER seed — that is how saved work got
  // clobbered (seeded before the document had loaded, then written back).
  const saveDraft = (c: string) => { if (c.trim() && c !== STARTER) persistModelCode(c, undefined, false); };
  const snapshotVersion = (c: string, label?: string) => { if (c.trim() && c !== STARTER) persistModelCode(c, label, true); };

  // mount: create the viewer, then seed the code — but WAIT until the document
  // has actually loaded (getBackendId is set only after setDocument), so we
  // never seed the starter over a document that simply hasn't arrived yet.
  useEffect(() => {
    fetchUsage();
    let done = false;
    let tries = 0;
    const start = (initial: string) => {
      setCode(initial);
      if (canvasRef.current && !viewerRef.current) {
        try {
          viewerRef.current = createViewer(canvasRef.current, { onFacePick: onPick, onAxes, onDims, onHandle, onHandleDrop });
        } catch (err) {
          setStatus('error');
          setMessage(errorText(err));
          return;
        }
      }
      // A brand-new part shows the STARTER seed but does NOT auto-build it —
      // you almost always replace it, so kicking off a build of the default is
      // wasted work. Saved parts build on open so you see the model immediately.
      if (initial === STARTER) { setStatus('idle'); setMessage('Edit the script or ask the AI, then Build.'); }
      else build(initial);
    };
    const seedWhenLoaded = () => {
      if (done) return;
      if (getBackendId() || tries > 60) {   // loaded, or give up after ~3s (new doc)
        done = true;
        const saved = useDocumentStore.getState().document.modelCode;
        start(saved && saved.trim() ? saved : STARTER);
      } else {
        tries += 1;
        setTimeout(seedWhenLoaded, 50);
      }
    };
    seedWhenLoaded();
    return () => { done = true; viewerRef.current?.dispose(); viewerRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-save code edits (typed by hand, not just on Build) — debounced. The
  // first value we see is the seed we just loaded, so record it without saving.
  const codeBaseline = useRef<string | null>(null);
  useEffect(() => {
    if (codeBaseline.current === null) { codeBaseline.current = code; return; }
    if (code === codeBaseline.current) return;
    const t = setTimeout(() => { codeBaseline.current = code; saveDraft(code); }, 600);
    return () => clearTimeout(t);
  }, [code]);

  // save the current code on close, so nothing typed is lost
  const handleClose = () => { if (code.trim()) saveDraft(code); onClose(); };
  // breadcrumb nav: persist the current code, then navigate away
  const navAway = (fn: () => void) => { if (code.trim()) saveDraft(code); fn(); };

  // rename the part (persists immediately; a rename is not a new model version)
  const startRename = () => { setNameDraft(docName); setEditingName(true); };
  const commitName = () => {
    const trimmed = nameDraft.trim();
    setEditingName(false);
    if (trimmed && trimmed !== docName) persistName(trimmed);
  };

  // Versions: browse the immutable server-side snapshots and restore one.
  // Restoring re-saves that code (which itself creates a new version), so the
  // current model is never lost.
  const [showVersions, setShowVersions] = useState(false);
  const [showProduction, setShowProduction] = useState(false);
  const [prodDraft, setProdDraft] = useState('');
  const openProduction = () => { setProdDraft(productionNotes); setShowProduction(true); };
  const saveProduction = () => { setShowProduction(false); persistProductionNotes(prodDraft); };
  // Import STEP: upload the file (the server trial-builds it), then replace the
  // script with one that imports it by hash, build, and version it. The script
  // being replaced is kept: a built one is already a version, and the server
  // files an overwritten draft under modelCodeHistory.
  const stepInput = useRef<HTMLInputElement | null>(null);
  const [importing, setImporting] = useState(false);
  const importStep = async (file: File) => {
    const docId = getBackendId();
    if (!docId) { setStatus('error'); setMessage('Save this part before importing a file.'); return; }
    if (code.trim() && code !== STARTER &&
        !window.confirm(`Replace the current script with an import of ${file.name}? It stays in Versions.`)) return;
    setImporting(true);
    setMessage(`Importing ${file.name}…`);
    try {
      const asset = await api.uploadAsset(docId, file);
      const c = importScript(asset);
      setCode(c);
      saveDraft(c);
      await build(c, importLabel(asset.filename));
    } catch (err) {
      setStatus('error');
      setMessage(errorText(err));
    } finally {
      setImporting(false);
    }
  };

  const restoreVersion = (c: string) => {
    setShowVersions(false);
    if (!c.trim()) return;
    setCode(c);
    saveDraft(c);
    build(c, 'restored');
    setFlash('Restored this version');
    setTimeout(() => setFlash(''), 2500);
  };

  const [ask, setAsk] = useState('');
  const [asking, setAsking] = useState(false);
  // Model picker. The list comes from the server (which asks the Models API),
  // so it never goes stale; '' means "server default" until the list arrives.
  // A remembered pick that the API no longer offers (a retired model) is
  // dropped in favour of the default.
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [model, setModel] = useState<string>(() => { try { return localStorage.getItem('intentcad-edit-model') || ''; } catch { return ''; } });
  const pickModel = (m: string) => { setModel(m); try { localStorage.setItem('intentcad-edit-model', m); } catch { /* ignore */ } };
  useEffect(() => {
    buildApi.models().then((r) => {
      setModels(r.models);
      setModel((cur) => (cur && r.models.some((m) => m.id === cur) ? cur : r.default));
    }).catch(() => { /* keep the free-text id; the server falls back to its default */ });
  }, []);
  const modelTitle = (m: ModelInfo) =>
    `${m.label} — ${m.note}. $${m.input_per_m}/M in · $${m.output_per_m}/M out (released ${m.released})`;
  const [usage, setUsage] = useState<UsageResponse | null>(null);
  const chatScrollRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = chatScrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;   // keep the latest message in view
  }, [chat, asking]);
  const fetchUsage = () => buildApi.usage(getBackendId() ?? '').then(setUsage).catch(() => {});
  const [paramVals, setParamVals] = useState<Record<string, number>>({});
  const paramBase = useRef<Record<string, number>>({});   // values as of the last build (good or failed)
  const [sens, setSens] = useState<Record<string, DimInfo>>({});   // param -> what it controls
  // where `sens` stands for the current build, so the status bar can tell
  // "still working out the handles" from "nothing moves this face"
  const [sensState, setSensState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');

  // hold Opt/Alt to reveal every parameter as a dimension on the geometry it
  // drives (like the sketch editor's dimension overlay).
  const [dimsOn, setDimsOn] = useState(false);
  useEffect(() => {
    const down = (e: KeyboardEvent) => { if (e.key === 'Alt') { setDimsOn(true); ensureSens(); } };
    const up = (e: KeyboardEvent) => { if (e.key === 'Alt') setDimsOn(false); };
    const off = () => setDimsOn(false);
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', off);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', off);
    };
  }, []);

  const dimFmt = (v: number) => `${Math.round(v * 100) / 100}`;
  // the params that have a place to be drawn (list drives the label DOM)
  const dimList = dimsOn
    ? Object.entries(sens)
        .filter(([, d]) => d.anchor)
        .map(([name, d]) => ({ key: name, label: `${name} ${dimFmt(d.value)}`, kind: d.kind }))
    : [];
  useEffect(() => {
    const v = viewerRef.current;
    if (!v) return;
    v.setDims(
      dimsOn
        ? Object.entries(sens)
            .filter(([, d]) => d.anchor)
            .map(([name, d]) => ({
              key: name,
              label: `${name} ${dimFmt(d.value)}`,
              point: d.anchor as [number, number, number],
              dir: d.dir,
            }))
        : [],
    );
  }, [dimsOn, sens]);

  // A parameter edit that didn't build: what was tried, what was kept, and why.
  const [paramReject, setParamReject] = useState<{
    name: string; tried: number; kept: number | undefined; message: string; fix: SizeFix | null;
  } | null>(null);
  const applying = useRef<string | null>(null);   // "name=val" in flight (Enter + blur both fire)

  // change a parameter's value: rewrite just that value in the script (comments
  // and formatting preserved), then rebuild + save. A value that doesn't build
  // cleanly is REJECTED: the last good script and value come back (the model
  // stays rendered, the draft stays buildable) and the reason is shown — with
  // the engine's one-click fix when it measured a value that fits.
  const applyParam = async (name: string, val: number) => {
    const key = `${name}=${val}`;
    if (applying.current === key) return;
    applying.current = key;
    const prevCode = code;
    const prevVal = paramBase.current[name];
    // Only guard when there IS a good state to keep. If the script is already
    // broken, a param change is the way out — let it through, saved or not.
    const guarded = status === 'done' && !warn;
    setParamReject(null);
    try {
      const r = await buildApi.setParams(code, { [name]: val });
      setCode(r.code);
      if (!guarded) { saveDraft(r.code); await build(r.code, `${name} = ${val}`); return; }
      const out = await build(r.code, `${name} = ${val}`);
      if (out.kind === 'ok') { saveDraft(r.code); return; }
      if (out.kind === 'aborted') return;
      setCode(prevCode);
      setParamReject({ name, tried: val, kept: prevVal, message: out.message, fix: out.fix });
      await build(prevCode);          // the last good build — served from cache
    } catch (err) {
      setMessage(errorText(err));
    } finally {
      if (applying.current === key) applying.current = null;
    }
  };
  // the viewer keeps its mount-time callbacks, so a drop reaches the current
  // applyParam (which closes over the current code) through a ref
  const applyParamRef = useRef(applyParam);
  applyParamRef.current = applyParam;

  // Direct manipulation: with exactly one face selected, a drag handle for a
  // param that moves it (sensitivity `shifts`) — the one moving it most along
  // its normal first; Tab cycles when several do. Releasing goes through
  // applyParam (set_params → rebuild → version), never the AI.
  const selFace = sel.length === 1 ? resRef.current?.faces.find((f) => f.index === sel[0]) ?? null : null;
  const handleOpts = useMemo(() => (selFace ? handleOptions(selFace, sens) : []), [selFace, sens]);
  const handleKey = `${sel.join()}|${handleOpts.map((h) => h.name).join()}`;
  const [handlePick, setHandlePick] = useState({ key: '', i: 0 });
  const nHandles = handleOpts.length;
  const hi = nHandles ? ((((handlePick.key === handleKey ? handlePick.i : 0) % nHandles) + nHandles) % nHandles) : 0;
  const handle = nHandles ? handleOpts[hi]! : null;
  handleRef.current = handle;
  handleHintRef.current = nHandles > 1 ? `Tab ⇄ ${hi + 1}/${nHandles}` : '';
  const handleKeyRef = useRef(handleKey);
  handleKeyRef.current = handleKey;
  const nHandlesRef = useRef(0);
  nHandlesRef.current = nHandles;
  useEffect(() => {
    viewerRef.current?.setHandle(handle && selFace
      ? { face: selFace.index, shift: handle.shift, dr: handle.dr, value: handle.value, moves: handle.moves }
      : null);
  }, [handle, selFace]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab' || nHandlesRef.current < 2) return;
      // only when nothing has focus (the canvas isn't focusable), so Tab still
      // moves between the editor's fields
      if (e.target instanceof HTMLElement && e.target !== document.body) return;
      e.preventDefault();
      const key = handleKeyRef.current;
      setHandlePick((p) => ({ key, i: (p.key === key ? p.i : 0) + (e.shiftKey ? -1 : 1) }));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  // "?" opens the help, as in the sketch editor — not while typing in a field
  const [showHelp, setShowHelp] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '?' || (e.target instanceof HTMLElement && e.target !== document.body)) return;
      setShowHelp((v) => !v);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // standard views: 1–6 front/back/left/right/top/bottom, 0 iso; N looks
  // straight at the (last) selected face; O toggles orthographic. Capture
  // phase + stopPropagation: when this opens over the sketch editor, its
  // tools mustn't also see the key (N there toggles parallel).
  const [ortho, setOrtho] = useState(false);
  const [viewHint, setViewHint] = useState('');
  const viewHintTimer = useRef(0);
  const viewBtn: CSSProperties = {
    background: 'rgba(0,0,0,0.25)', border: `1px solid ${palette.border}`, borderRadius: '4px',
    color: palette.textSecondary, fontSize: '11px', padding: '2px 7px', cursor: 'pointer', lineHeight: 1.4,
  };
  // N / the Normal button: the last face clicked
  const lookAtSelection = () => {
    const s = selRef.current;
    const f = s.length ? resRef.current?.faces.find((x) => x.index === s[s.length - 1]) : undefined;
    if (f) { viewerRef.current?.lookAlong(f.normal); return; }
    setViewHint('Select a face, then press N');
    window.clearTimeout(viewHintTimer.current);
    viewHintTimer.current = window.setTimeout(() => setViewHint(''), 2500);
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.target instanceof HTMLElement && e.target !== document.body) return;
      const v = viewerRef.current;
      if (!v) return;
      const view = VIEW_KEYS[e.key];
      if (view) v.setView(view);
      else if (e.key === 'n' || e.key === 'N') lookAtSelection();
      else if (e.key === 'o' || e.key === 'O') setOrtho(v.toggleOrtho());
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener('keydown', onKey, true);
    return () => { window.removeEventListener('keydown', onKey, true); window.clearTimeout(viewHintTimer.current); };
  }, []);

  // after a drop, build() reselects the face found where the drag put it
  const reselectRef = useRef<{ param: string; value: number; center: Vec3; normal: Vec3; tol: number } | null>(null);
  const onHandleDrop = (value: number) => {
    const h = handleRef.current;
    const f = resRef.current?.faces.find((x) => x.index === selRef.current[0]);
    if (!h || !f || selRef.current.length !== 1) { viewerRef.current?.clearDragPreview(); return; }
    const move = scale(h.shift, value - h.value);
    reselectRef.current = { param: h.name, value, center: add(f.center, move), normal: f.normal,
                            tol: Math.max(1, len(move) * 0.25) };
    void applyParamRef.current(h.name, value).finally(() => {
      reselectRef.current = null;
      viewerRef.current?.clearDragPreview();   // if nothing rebuilt (e.g. set_params failed)
    });
  };

  // describe the current selection so the assistant can target it in build123d
  const selectionContext = (): string => {
    const res = resRef.current;
    if (!res || sel.length === 0) return '';
    const v = (a: [number, number, number]) => `(${a.map((n) => Math.round(n * 10) / 10).join(', ')})`;
    const desc = (i: number) => {
      const f = res.faces.find((x) => x.index === i)!;
      return `${f.kind} face (center ${v(f.center)}, normal ${v(f.normal)})`;
    };
    if (sel.length === 1) return `the ${desc(sel[0]!)}`;
    const shared = res.edges.filter((e) => e.faceIndices.length === 2 && e.faceIndices.includes(sel[0]!) && e.faceIndices.includes(sel[1]!));
    const edge = shared[0] ? `the ${shared[0].kind} edge between ` : 'the geometry between ';
    return `${edge}the ${desc(sel[0]!)} and the ${desc(sel[1]!)}`;
  };

  // The instruction the "Fix with AI" button sends: the build error itself
  // travels as `build_error` context, so this only needs to state the goal.
  const FIX_INSTRUCTION = 'Fix the build error, keeping the design intent.';
  // The "Protect" action on a face selection: the selection travels as context.
  const PROTECT_INSTRUCTION = "Add the selected face(s) to auto_round's keep list with a robust selector, change nothing else.";
  // The "Lighten" button: the organic-shapes design pattern from the system
  // prompt, so it can be reached without knowing what to ask for.
  const LIGHTEN_INSTRUCTION = 'Make this part lighter and more organic: aim to remove 30-40% of its mass. '
    + 'Keep every hole, boss and mating face exact. '
    + 'Lighten its flat plates with truss_windows() anchored at the mounts, sized to hit that target '
    + '(only the selected face, if one is selected), '
    + 'or, if it is an open bracket, rebuild it as a frame() of tapered, gently bowed members between the mount points. '
    + 'Then auto_round() last.';
  // The "Round" button: auto_round on its own.
  const ROUND_INSTRUCTION = 'Round every edge of this part with auto_round() as the last line, with the convex and '
    + 'concave radii as P["round_r"] and P["blend_r"] sized to suit the part. Keep holes and mating faces exact '
    + '(and the selected face, if one is selected). If the script already calls auto_round, leave it in place and '
    + 'only fix what stops it rounding.';

  const sendChat = async (text?: string) => {
    const instruction = (text ?? ask).trim();
    if (!instruction || asking) return;
    setAsking(true);
    const userMsg: ChatMessage = { role: 'user', text: instruction, at: Date.now() };
    const base = [...chat, userMsg];
    persistChat(base);          // show the user's message immediately (and persist)
    setAsk('');
    try {
      const history = chat.slice(-8).map((m) => ({ role: m.role, text: m.text }));
      const r = await buildApi.edit({
        code, instruction, context: selectionContext(),
        document_id: getBackendId() ?? '', history, model,
        production: productionNotes,
        // if the current script doesn't build, the assistant repairs it as part
        // of this edit (see assistant.py) — no need to paste the error
        build_error: status === 'error' ? message : '',
      });
      if (r.kind === 'question') {
        persistChat([...base, { role: 'assistant', kind: 'question', text: r.question, at: Date.now() }]);
      } else {
        persistChat([...base, { role: 'assistant', kind: 'edit', text: r.note || 'Done.', code: r.code, at: Date.now() }]);
        setCode(r.code);
        saveDraft(r.code);
        await build(r.code, r.note || instruction);
      }
      fetchUsage();
    } catch (err) {
      const msg = `⚠ ${errorText(err)}`;
      persistChat([...base, { role: 'assistant', kind: 'question', text: msg, at: Date.now() }]);
    } finally {
      setAsking(false);
    }
  };

  const rebuild = () => { setParamReject(null); saveDraft(code); build(code, 'build'); };
  const [exporting, setExporting] = useState<'stl' | 'step' | 'stl-parts' | 'dxf' | 'dxf-views' | null>(null);
  const doExport = async (format: 'stl' | 'step' | 'stl-parts' | 'dxf' | 'dxf-views') => {
    if (status !== 'done' || exporting) return;
    setExporting(format);
    try {
      const r = await buildApi.export(code, format, getBackendId() ?? '');
      if (format === 'stl-parts' || format === 'dxf-views') {
        // r.data is a base64 zip (STL per body, or top/front/side DXFs)
        const bytes = Uint8Array.from(atob(r.data), (c) => c.charCodeAt(0));
        const url = URL.createObjectURL(new Blob([bytes], { type: 'application/zip' }));
        const suffix = format === 'stl-parts' ? 'parts' : 'views';
        const a = document.createElement('a');
        a.href = url; a.download = `${docName}-${suffix}.zip`; a.click();
        URL.revokeObjectURL(url);
      } else {
        const mime = format === 'stl' ? 'model/stl'
          : format === 'dxf' ? 'application/dxf'
          : 'application/step';
        downloadTextFile(r.data, `${docName}.${format}`, mime);
      }
    } catch (err) {
      setMessage(errorText(err));
    } finally {
      setExporting(null);
    }
  };

  const btn: CSSProperties = {
    padding: '5px 14px', border: 'none', borderRadius: '4px', fontSize: '13px', cursor: 'pointer',
  };

  // "Set r = 1.42 and rebuild": the engine measured the largest size that fits
  // and it's a param — apply it, no AI round-trip.
  const fixButton = (f: SizeFix) => (
    <button onClick={() => void applyParam(f.param!, f.value!)}
      title={`The largest ${f.kind} that fits is about ${f.max?.toPrecision(3)}; sets ${f.param} just under that and rebuilds`}
      style={{ ...btn, background: palette.primaryBtn, color: '#fff' }}>
      Set {f.param} = {f.value} and rebuild
    </button>
  );

  return (
    <div style={{ position: 'fixed', inset: 0, background: palette.panelBg, zIndex: 1000,
                  display: 'flex', flexDirection: 'column' }}>
      <div style={{ background: palette.panelBg, flex: 1, minHeight: 0,
                    display: 'flex', flexDirection: 'column' }}>
        {/* header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '12px 16px',
                      borderBottom: `1px solid ${palette.border}` }}>
          {(onHome || onProject) && (
            <div style={{ display: 'flex', gap: '6px' }}>
              {onHome && (
                <button onClick={() => navAway(onHome)} title="Back to projects"
                  style={{ ...btn, background: 'none', color: palette.textSecondary,
                           border: `1px solid ${palette.border}` }}>Home</button>
              )}
              {onProject && (
                <button onClick={() => navAway(onProject)} title="Back to this project"
                  style={{ ...btn, background: 'none', color: palette.textSecondary,
                           border: `1px solid ${palette.border}` }}>Project</button>
              )}
            </div>
          )}
          {editingName ? (
            <input value={nameDraft} autoFocus
              onChange={(e) => setNameDraft(e.target.value)}
              onBlur={commitName}
              onKeyDown={(e) => { if (e.key === 'Enter') commitName(); if (e.key === 'Escape') setEditingName(false); }}
              style={{ fontSize: '15px', color: palette.text, background: palette.inputBg,
                       border: `1px solid ${palette.accent ?? palette.border}`, borderRadius: '5px',
                       padding: '3px 8px', outline: 'none', minWidth: '160px' }} />
          ) : (
            <h2 onDoubleClick={startRename} title="Double-click to rename"
                style={{ margin: 0, fontSize: '15px', color: palette.text, cursor: 'text', display: 'flex', alignItems: 'center', gap: '7px' }}>
              {docName}
              <button onClick={startRename} title="Rename"
                style={{ display: 'flex', padding: '2px', background: 'none', border: 'none', color: palette.textSecondary, cursor: 'pointer' }}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9" /><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z" /></svg>
              </button>
              <span style={{ color: palette.textSecondary, fontSize: '12px' }}>(build123d · script)</span>
            </h2>
          )}
          {usage && (usage.all_time.edits > 0) && (
            <span title={`This model: ${usage.document.tokens_in.toLocaleString()} in / ${usage.document.tokens_out.toLocaleString()} out.  All-time: ${usage.all_time.tokens_in.toLocaleString()} in / ${usage.all_time.tokens_out.toLocaleString()} out.`}
              style={{ fontSize: '12px', color: palette.textSecondary }}>
              AI spend · this model ${usage.document.cost_usd.toFixed(3)} ({usage.document.edits}) · all-time ${usage.all_time.cost_usd.toFixed(2)} ({usage.all_time.edits})
            </span>
          )}
          <div style={{ flex: 1 }} />
          <button onClick={openProduction} title="Target production process — the AI designs to this (clearances, fits, wall thickness)"
            style={{ ...btn, background: 'none', color: palette.textSecondary,
                     border: `1px solid ${palette.border}` }}>
            Process
          </button>
          <input ref={stepInput} type="file" accept={STEP_ACCEPT} style={{ display: 'none' }}
            onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void importStep(f); }} />
          <button onClick={() => stepInput.current?.click()} disabled={importing || status === 'building'}
            title="Start this part from a STEP file (.step/.stp): replaces the script with one that imports it"
            style={{ ...btn, background: 'none', color: palette.textSecondary,
                     border: `1px solid ${palette.border}`, opacity: importing ? 0.5 : 1 }}>
            {importing ? 'Importing…' : 'Import STEP'}
          </button>
          <button onClick={() => setShowVersions(true)} title="Browse and restore saved versions"
            style={{ ...btn, background: 'none', color: palette.textSecondary,
                     border: `1px solid ${palette.border}` }}>
            Versions
          </button>
          {([['Lighten', LIGHTEN_INSTRUCTION, 'AI: cut 30–40% of the mass with windows or spokes, then round (? for more)'],
             ['Round', ROUND_INSTRUCTION, 'AI: round every edge, keeping holes and mating faces exact (? for more)']] as const)
            .map(([label, instruction, title]) => (
              <button key={label} onClick={() => void sendChat(instruction)}
                disabled={asking || status === 'building' || !code.trim()} title={title}
                style={{ ...btn, background: 'none', color: palette.textSecondary,
                         border: `1px solid ${palette.border}`, opacity: asking || status === 'building' ? 0.5 : 1 }}>
                {label}
              </button>
            ))}
          {status === 'building' ? (
            <button onClick={cancelBuild} title="Cancel this build"
              style={{ ...btn, background: 'none', color: palette.danger ?? '#f87171',
                       border: `1px solid ${palette.danger ?? '#f87171'}` }}>
              Cancel build
            </button>
          ) : (
            <button onClick={rebuild}
              style={{ ...btn, background: palette.primaryBtn, color: '#fff' }}>
              Build
            </button>
          )}
          {(['stl', 'step', 'stl-parts', 'dxf', 'dxf-views'] as const).map((f) => {
            const enabled = status === 'done' && !exporting;
            const label = f === 'stl-parts' ? 'Parts' : f === 'dxf-views' ? '3-View' : f.toUpperCase();
            const title = f === 'stl-parts' ? 'Download one STL per body, zipped (for printing an assembly)'
              : f === 'dxf' ? 'Flat top-down outline as DXF, for 2D CAM / CNC routing'
              : f === 'dxf-views' ? 'Top, front and side outlines as three DXF files, zipped'
              : undefined;
            return (
              <button key={f} onClick={() => doExport(f)} disabled={!enabled}
                title={title}
                style={{ ...btn, background: 'none', color: palette.textSecondary,
                         border: `1px solid ${palette.border}`, opacity: enabled ? 1 : 0.5,
                         cursor: enabled ? 'pointer' : 'default' }}>
                {exporting === f ? '…' : label}
              </button>
            );
          })}
          <button onClick={() => setShowHelp(true)} title="What everything here does (?)" aria-label="Help"
            style={{ ...btn, padding: '5px 10px', background: 'none', color: palette.textSecondary,
                     border: `1px solid ${palette.border}`, borderRadius: '50%' }}>?</button>
          <button onClick={handleClose} style={{ background: 'none', border: 'none',
                   color: palette.textSecondary, fontSize: '18px', cursor: 'pointer', padding: '0 4px' }}>&times;</button>
        </div>

        {/* body: parameters + code editor (left) | viewport (right) */}
        <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
          <div style={{ width: '46%', display: 'flex', flexDirection: 'column', minHeight: 0,
                        borderRight: `1px solid ${palette.border}` }}>
            {Object.keys(paramVals).length > 0 && (
              <div style={{ padding: '8px 12px', borderBottom: `1px solid ${palette.border}`,
                            display: 'flex', flexWrap: 'wrap', gap: '8px 14px', maxHeight: '30%',
                            overflowY: 'auto', alignContent: 'flex-start' }}>
                <div style={{ width: '100%', fontSize: '11px', fontWeight: 600, letterSpacing: '0.5px',
                              textTransform: 'uppercase', color: palette.textSecondary }}>Parameters</div>
                {Object.entries(paramVals).map(([name, val]) => {
                  const controls = sens[name]?.faces ?? [];
                  const active = sel.length > 0 && controls.some((i) => sel.includes(i));
                  return (
                    <label key={name}
                      onMouseEnter={() => { ensureSens(); if (controls.length) viewerRef.current?.selectFaces(controls); }}
                      onMouseLeave={() => viewerRef.current?.selectFaces(sel)}
                      title={controls.length ? `controls ${controls.length} face(s) — hover to preview` : ''}
                      style={{ display: 'flex', alignItems: 'center', gap: '5px', fontSize: '12px',
                               color: active ? palette.text : palette.textSecondary,
                               fontWeight: active ? 600 : 400 }}>
                      {name}
                      <input
                        type="number" value={val} step="any"
                        onChange={(e) => setParamVals((p) => ({ ...p, [name]: Number(e.target.value) }))}
                        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); applyParam(name, paramVals[name]!); } }}
                        onBlur={() => { if (paramVals[name] !== paramBase.current[name]) applyParam(name, paramVals[name]!); }}
                        style={{ width: '64px', padding: '3px 6px', background: palette.inputBg,
                                 border: `1px solid ${active ? palette.primaryBtn : palette.inputBorder}`,
                                 borderRadius: '4px', color: palette.text, fontSize: '12px' }}
                      />
                    </label>
                  );
                })}
                {paramReject && (() => {
                  const pr = paramReject;
                  const lines = pr.message.split('\n').map((l) => l.trim()).filter(Boolean);
                  const why = lines[lines.length - 1] ?? pr.message;   // the plain-language line
                  return (
                    <div title={pr.message}
                      style={{ width: '100%', display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap',
                               fontSize: '11px', color: palette.danger }}>
                      <span>
                        {pr.name} = {pr.tried} doesn't build{pr.kept !== undefined ? ` — kept ${pr.kept}` : ''}. {why}
                      </span>
                      {pr.fix?.param && fixButton(pr.fix)}
                    </div>
                  );
                })()}
              </div>
            )}
            {(() => {
              // no soft-wrap so line numbers line up 1:1 with logical lines
              const GUTTER = 46;
              const monoBase: CSSProperties = {
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '13px',
                lineHeight: 1.5, tabSize: 4, whiteSpace: 'pre',
              };
              const editorStyle: CSSProperties = {
                ...monoBase, margin: 0, padding: `12px 14px 12px ${GUTTER + 8}px`,
                border: 0, boxSizing: 'border-box',
              };
              let html = highlightPython(code, isDark ? DARK_SYNTAX : LIGHT_SYNTAX);
              if (code.endsWith('\n')) html += '\n';   // keep the empty last line in sync
              const lineCount = code.split('\n').length;
              return (
                <div style={{ flex: 1, position: 'relative', minHeight: 0, overflow: 'hidden',
                              background: palette.inputBg }}>
                  <pre ref={preRef} aria-hidden
                    style={{ ...editorStyle, position: 'absolute', inset: 0, overflow: 'auto',
                             color: palette.text, pointerEvents: 'none' }}
                    dangerouslySetInnerHTML={{ __html: html }} />
                  <textarea
                    ref={taRef}
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    onScroll={syncScroll}
                    onKeyDown={(e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); rebuild(); } }}
                    spellCheck={false} autoCapitalize="off" autoCorrect="off" wrap="off"
                    style={{ ...editorStyle, position: 'absolute', inset: 0, resize: 'none',
                             background: 'transparent', color: 'transparent',
                             caretColor: palette.text, outline: 'none', overflow: 'auto' }}
                  />
                  {/* line-number gutter (opaque; scrolls vertically with the editor) */}
                  <div ref={gutterRef} aria-hidden
                    style={{ ...monoBase, position: 'absolute', left: 0, top: 0, bottom: 0, width: GUTTER,
                             overflow: 'hidden', padding: '12px 8px 12px 0', boxSizing: 'border-box',
                             textAlign: 'right', color: palette.textSecondary, background: palette.inputBg,
                             borderRight: `1px solid ${palette.border}`, userSelect: 'none', pointerEvents: 'none' }}>
                    {Array.from({ length: lineCount }, (_, i) => i + 1).join('\n')}
                  </div>
                </div>
              );
            })()}
          </div>
          <div style={{ flex: 1, position: 'relative', minHeight: 0, overflow: 'hidden' }}>
            <canvas ref={canvasRef} style={{ width: '100%', height: '100%', display: 'block',
                     cursor: 'grab', touchAction: 'none' }} />
            {/* measure readout: center-to-center distance for a 2-face selection */}
            {measure && (
              <div style={{ position: 'absolute', left: 12, top: 12, padding: '8px 11px',
                            background: 'rgba(20,22,26,0.82)', border: '1px solid rgba(255,255,255,0.12)',
                            borderRadius: '6px', color: '#eef1f5', pointerEvents: 'none',
                            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                            fontVariantNumeric: 'tabular-nums' }}>
                {measure.single ? (
                  measure.dia != null ? (
                    <>
                      <div style={{ fontSize: '15px', fontWeight: 600 }}>
                        ⌀ {measure.dia.toFixed(2)} <span style={{ fontSize: '11px', opacity: 0.6 }}>mm</span>
                      </div>
                      <div style={{ fontSize: '11px', opacity: 0.7, marginTop: '2px' }}>diameter</div>
                    </>
                  ) : (
                    <>
                      <div style={{ fontSize: '15px', fontWeight: 600 }}>
                        {measure.w!.toFixed(1)} × {measure.h!.toFixed(1)} <span style={{ fontSize: '11px', opacity: 0.6 }}>mm</span>
                      </div>
                      <div style={{ fontSize: '11px', opacity: 0.7, marginTop: '2px' }}>face size (bounding box)</div>
                    </>
                  )
                ) : (
                  <>
                    <div style={{ fontSize: '15px', fontWeight: 600 }}>
                      {measure.dist.toFixed(2)} <span style={{ fontSize: '11px', opacity: 0.6 }}>mm</span>
                    </div>
                    <div style={{ fontSize: '11px', opacity: 0.7, marginTop: '2px' }}>center-to-center</div>
                    <div style={{ fontSize: '12px', marginTop: '5px', display: 'flex', gap: '10px' }}>
                      <span><span style={{ color: '#d95555' }}>X</span> {measure.dx.toFixed(1)}</span>
                      <span><span style={{ color: '#5fb36a' }}>Y</span> {measure.dy.toFixed(1)}</span>
                      <span><span style={{ color: '#6a8cd9' }}>Z</span> {measure.dz.toFixed(1)}</span>
                    </div>
                    {(measure.diaA || measure.diaB) && (
                      <div style={{ fontSize: '11px', opacity: 0.7, marginTop: '5px' }}>
                        ⌀ {measure.diaA ? measure.diaA.toFixed(1) : '—'} · ⌀ {measure.diaB ? measure.diaB.toFixed(1) : '—'}
                      </div>
                    )}
                  </>
                )}
              </div>
            )}
            {/* orientation gizmo (bottom-left): X red, Y green, Z blue from origin.
                Click a label to view from that axis; again for the opposite side. */}
            <svg width={68} height={68} style={{ position: 'absolute', left: 10, bottom: 10, pointerEvents: 'none', overflow: 'visible' }}>
              <circle cx={34} cy={34} r={2.5} fill={palette.textSecondary} />
              {(['X', 'Y', 'Z'] as const).map((n, i) => (
                <g key={n}>
                  <line ref={(el) => { gLine.current[i] = el; }} x1={34} y1={34} x2={34} y2={34}
                    stroke={['#d95555', '#5fb36a', '#6a8cd9'][i]} strokeWidth={2} strokeLinecap="round" />
                  <text ref={(el) => { gLabel.current[i] = el; }} x={34} y={34}
                    fill={['#d95555', '#5fb36a', '#6a8cd9'][i]} fontSize={12} fontWeight={700}
                    textAnchor="middle" style={{ paintOrder: 'stroke', stroke: 'rgba(0,0,0,0.5)', strokeWidth: 3 }}>{n}</text>
                  <circle ref={(el) => { gHit.current[i] = el; }} cx={34} cy={34} r={9} fill="transparent"
                    style={{ pointerEvents: 'all', cursor: 'pointer' }} onClick={() => viewerRef.current?.viewAxis(n)}>
                    <title>{`View from +${n} (click again for −${n})`}</title>
                  </circle>
                </g>
              ))}
            </svg>
            {/* view buttons (keys 1–6, 0, N, O do the same) */}
            <div style={{ position: 'absolute', left: 84, right: 130, bottom: 12, display: 'flex', alignItems: 'center',
                          flexWrap: 'wrap', gap: '4px', fontSize: '11px', color: palette.textSecondary }}
                 onMouseDown={(e) => e.preventDefault()}>{/* don't take focus: keys keep working */}
              {VIEW_BUTTONS.map(([key, view]) => (
                <button key={view} style={viewBtn} title={`${view[0]!.toUpperCase()}${view.slice(1)} view (${key})`}
                        onClick={() => viewerRef.current?.setView(view)}>
                  {view === 'iso' ? 'Iso' : `${view[0]!.toUpperCase()}${view.slice(1)}`}
                </button>
              ))}
              <button style={{ ...viewBtn, marginLeft: '6px', opacity: sel.length ? 1 : 0.45,
                               cursor: sel.length ? 'pointer' : 'default' }}
                      disabled={!sel.length} onClick={lookAtSelection}
                      title={sel.length ? 'Look straight at the selected face (N)' : 'Select a face first (then N or this button)'}>
                Normal
              </button>
              <button style={{ ...viewBtn, marginLeft: '6px', ...(ortho ? { color: palette.accent, borderColor: palette.accent } : {}) }}
                      onClick={() => { const v = viewerRef.current; if (v) setOrtho(v.toggleOrtho()); }}
                      title={ortho ? 'Orthographic: click for perspective (O)' : 'Perspective: click for orthographic (O)'}>
                {ortho ? 'Ortho' : 'Persp'}
              </button>
              {viewHint && <span style={{ color: palette.text, marginLeft: '6px', pointerEvents: 'none' }}>{viewHint}</span>}
            </div>
            {/* dimension overlay (hold Opt/Alt): each param drawn on its geometry */}
            <svg style={{ position: 'absolute', inset: 0, width: '100%', height: '100%',
                          pointerEvents: 'none', overflow: 'hidden' }}>
              <defs>
                <marker id="dimArrow" markerWidth="8" markerHeight="8" refX="4" refY="4"
                        orient="auto-start-reverse">
                  <path d="M1,1 L7,4 L1,7" fill="none" stroke="#e0b24a" strokeWidth={1.3} />
                </marker>
              </defs>
              {dimList.map((d) => (
                <g key={d.key}>
                  <line ref={(el) => setDimRef(d.key, 'lead', el)} opacity={0}
                        stroke="#e0b24a" strokeWidth={0.75} />
                  {d.kind === 'length' && (
                    <line ref={(el) => setDimRef(d.key, 'arrow', el)} opacity={0}
                          stroke="#e0b24a" strokeWidth={1.5}
                          markerStart="url(#dimArrow)" markerEnd="url(#dimArrow)" />
                  )}
                  <text ref={(el) => setDimRef(d.key, 'label', el)} opacity={0}
                        fontSize={12} fontWeight={600} fill="#f2ca63"
                        style={{ paintOrder: 'stroke', stroke: 'rgba(0,0,0,0.7)', strokeWidth: 3.5 }}>
                    {d.label}
                  </text>
                </g>
              ))}
            </svg>
            {/* drag handle on the selected face (positioned per frame by onHandle) */}
            <svg style={{ position: 'absolute', inset: 0, width: '100%', height: '100%',
                          pointerEvents: 'none', overflow: 'hidden' }}>
              <defs>
                <marker id="handleArrow" markerUnits="userSpaceOnUse" markerWidth="12" markerHeight="12"
                        refX="4" refY="6" orient="auto">
                  <path d="M0,1 L11,6 L0,11 Z" fill="#4aa8ff" />
                </marker>
              </defs>
              <line ref={(el) => { hEls.current.line = el; }} opacity={0}
                    stroke="#4aa8ff" strokeWidth={2.5} strokeLinecap="round" markerEnd="url(#handleArrow)" />
              <circle ref={(el) => { hEls.current.knob = el; }} opacity={0} r={4.5}
                      fill="#4aa8ff" stroke="#fff" strokeWidth={1.5} />
              <text ref={(el) => { hEls.current.label = el; }} opacity={0}
                    fontSize={12} fontWeight={600} fill="#a8d4ff"
                    style={{ paintOrder: 'stroke', stroke: 'rgba(0,0,0,0.7)', strokeWidth: 3.5 }} />
              <text ref={(el) => { hEls.current.sub = el; }} opacity={0} fontSize={10.5}
                    style={{ paintOrder: 'stroke', stroke: 'rgba(0,0,0,0.7)', strokeWidth: 3 }} />
            </svg>
            {Object.keys(paramVals).length > 0 && status === 'done' && (
              <div style={{ position: 'absolute', right: 10, bottom: 10, fontSize: '11px',
                            color: dimsOn ? '#e0b24a' : palette.textSecondary, pointerEvents: 'none',
                            opacity: 0.85 }}>
                {dimsOn ? 'dimensions' : 'hold ⌥ for dimensions'}
              </div>
            )}
            {status === 'error' && (
              <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, maxHeight: '45%',
                            overflow: 'auto', padding: '12px 14px', background: 'rgba(0,0,0,0.35)',
                            display: 'flex', flexDirection: 'column', gap: '8px' }}>
                <div style={{ color: palette.danger, fontSize: '12px', whiteSpace: 'pre-wrap',
                              fontFamily: 'ui-monospace, Menlo, monospace' }}>
                  {message || 'Build failed'}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
                  {fix && fixButton(fix)}
                  <button onClick={() => void sendChat(FIX_INSTRUCTION)} disabled={asking}
                    title="Send the script and this error to the AI; it repairs the failing line and rebuilds"
                    style={{ ...btn, background: palette.primaryBtn, color: '#fff',
                             opacity: asking ? 0.5 : 1, cursor: asking ? 'default' : 'pointer' }}>
                    {asking ? 'Fixing…' : 'Fix with AI'}
                  </button>
                  <span style={{ fontSize: '11px', color: palette.textSecondary }}>
                    or edit the script / a parameter and Build again
                  </span>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* chat — the AI modeling conversation: history is fed back to the model,
            it can ask a question instead of guessing, and each edit is a
            checkpoint you can click to revert to */}
        <div style={{ borderTop: `1px solid ${palette.border}`, display: 'flex', flexDirection: 'column' }}>
          {chat.length > 0 && (
            <div ref={chatScrollRef} style={{ maxHeight: '30vh', overflowY: 'auto', padding: '10px 16px',
                                              display: 'flex', flexDirection: 'column', gap: '7px' }}>
              {chat.map((m, i) => {
                const mine = m.role === 'user';
                const revertable = m.role === 'assistant' && m.kind === 'edit' && !!m.code;
                const isQ = m.kind === 'question';
                return (
                  <div key={`${m.at}-${i}`} style={{ alignSelf: mine ? 'flex-end' : 'flex-start', maxWidth: '82%' }}>
                    <div onClick={revertable ? () => restoreVersion(m.code!) : undefined}
                      title={revertable ? 'Revert the model to this version' : undefined}
                      style={{ padding: '7px 11px', borderRadius: '10px', fontSize: '13px', lineHeight: 1.45,
                               whiteSpace: 'pre-wrap', color: mine ? '#fff' : palette.text,
                               background: mine ? palette.primaryBtn : palette.inputBg,
                               border: `1px solid ${isQ ? (palette.warning ?? '#c78a1a') : palette.border}`,
                               cursor: revertable ? 'pointer' : 'default' }}>
                      {isQ && <span style={{ color: palette.warning ?? '#c78a1a', fontWeight: 700, marginRight: 5 }}>?</span>}
                      {m.text}
                      {revertable && (
                        <span style={{ display: 'block', fontSize: '11px', opacity: 0.6, marginTop: 3 }}>
                          ↩ click to revert here
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
              {asking && (
                <div style={{ alignSelf: 'flex-start', fontSize: '12px', color: palette.textSecondary }}>thinking…</div>
              )}
            </div>
          )}
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 16px' }}>
          <input
            value={ask}
            onChange={(e) => setAsk(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void sendChat(); }}
            placeholder={sel.length ? 'e.g. chamfer this edge 2mm  (targets your selection)' : 'Describe a change — e.g. add four M4 corner bolt holes'}
            disabled={asking}
            style={{ flex: 1, padding: '6px 10px', background: palette.inputBg,
                     border: `1px solid ${palette.inputBorder}`, borderRadius: '4px',
                     color: palette.text, fontSize: '13px', outline: 'none' }}
          />
          <select value={model} onChange={(e) => pickModel(e.target.value)} disabled={asking || models.length === 0}
            title={models.find((m) => m.id === model) ? modelTitle(models.find((m) => m.id === model)!)
                   : 'Model for AI edits — stronger tiers cost more; use them for hard tasks'}
            style={{ padding: '6px 8px', background: palette.inputBg, color: palette.textSecondary,
                     border: `1px solid ${palette.inputBorder}`, borderRadius: '4px', fontSize: '12px', cursor: 'pointer' }}>
            {models.length === 0 && <option value={model}>{model || 'default model'}</option>}
            {models.map((m) => (
              <option key={m.id} value={m.id} title={modelTitle(m)}>
                {m.label}{m.tier === 'fable' || m.tier === 'mythos' ? ' ✦' : ''}
              </option>
            ))}
          </select>
          <button onClick={() => void sendChat()} disabled={asking || !ask.trim()}
            style={{ padding: '6px 14px', background: palette.primaryBtn, color: '#fff', border: 'none',
                     borderRadius: '4px', fontSize: '13px', cursor: ask.trim() && !asking ? 'pointer' : 'default',
                     opacity: ask.trim() && !asking ? 1 : 0.5 }}>
            {asking ? 'Editing…' : 'Ask'}
          </button>
          {chat.length > 0 && (
            <button onClick={() => persistChat([])} title="Clear the conversation"
              style={{ padding: '6px 10px', background: 'none', color: palette.textSecondary,
                       border: `1px solid ${palette.border}`, borderRadius: '4px', fontSize: '12px', cursor: 'pointer' }}>
              Clear
            </button>
          )}
          </div>
        </div>

        {/* footer */}
        <div style={{ padding: '8px 16px', borderTop: `1px solid ${palette.border}`,
                      fontSize: '12px', color: palette.textSecondary, minHeight: '20px' }}>
          {flash && <span style={{ color: palette.primaryBtn, fontWeight: 600 }}>↩ {flash}</span>}
          {!flash && status === 'building' && 'Building…'}
          {status === 'error' && <span style={{ color: palette.danger }}>Build failed — see the editor side.</span>}
          {status === 'done' && warn && (
            <span style={{ color: palette.warning ?? '#c78a1a', display: 'inline-flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
              <span>⚠ an operation failed (model shown up to it): {warn}</span>
              {fix && fixButton(fix)}
            </span>
          )}
          {status === 'done' && resRef.current?.auto_round && (() => {
            const r = resRef.current.auto_round;
            return <span style={{ marginRight: '10px', display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
              <span title={`auto_round: ${r.protected} protected face${r.protected === 1 ? '' : 's'}, ${r.elapsed.toFixed(1)} s`}>
                rounded {r.rounded} edge{r.rounded === 1 ? '' : 's'} · {r.skipped.length} skipped · {r.capped} capped
              </span>
              {r.skipped.length > 0 && (
                <button onClick={toggleSkipped} aria-pressed={showSkipped}
                  title={r.skipped.map((e) => e.reason).filter((x, i, a) => a.indexOf(x) === i).join(', ')}
                  style={{ ...btn, padding: '1px 7px', fontSize: '11px',
                           ...(showSkipped ? { background: palette.primaryBtn, color: '#fff' } : {}) }}>
                  {showSkipped ? 'hide skipped' : 'show skipped'}
                </button>
              )}
              <span>·</span>
            </span>;
          })()}
          {status === 'done' && resRef.current?.organic && (() => {
            const o = resRef.current.organic;
            const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
            const bits: string[] = [];
            if (o.members || o.failed_members.length)
              bits.push(plural(o.members, 'member') + (o.failed_members.length ? ` (${o.failed_members.length} failed)` : ''));
            if (o.windows || o.dropped.length)
              bits.push(plural(o.windows, 'window') + (o.dropped.length ? ` (${o.dropped.length} dropped)` : ''));
            if (o.removed_pct != null) bits.push(`−${o.removed_pct.toFixed(0)}% mass`);
            const why = [...o.failed_members,
                         ...o.dropped.map((d) => `window dropped: ${d.reason}`)
                           .filter((x, i, a) => a.indexOf(x) === i)];
            return <span style={{ marginRight: '10px', display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
              {bits.length > 0 && <span title={why.join('\n') || undefined}>{bits.join(' · ')}</span>}
              {o.warnings.length > 0 && (
                <span title={o.warnings.map((w) => w.message).join('\n')}
                  style={{ color: palette.warning ?? '#c78a1a' }}>
                  ⚠ {plural(o.warnings.length, 'warning')}
                </span>
              )}
              <span>·</span>
            </span>;
          })()}
          {status === 'done' && !warn && (() => {
            const res = resRef.current;
            const v = (a: [number, number, number]) => `(${a.map((n) => Math.round(n * 10) / 10).join(', ')})`;
            if (!res || sel.length === 0)
              return `${stats} · drag to orbit · scroll to zoom · click a face (click two for the edge between them)`;
            const faces = sel.map((i) => res.faces.find((f) => f.index === i)!).filter(Boolean);
            const protect = res.auto_round && (
              <button onClick={() => void sendChat(PROTECT_INSTRUCTION)} disabled={asking}
                title="Ask the AI to add the selected face(s) to auto_round's keep list, so they stay flat and sharp-edged"
                style={{ ...btn, padding: '1px 7px', fontSize: '11px', marginLeft: '8px' }}>
                Protect
              </button>
            );
            if (sel.length === 1) {
              const f = faces[0]!;
              return <span style={{ color: palette.text }}>
                Face #{f.index} · <b>{f.kind}</b> · normal {v(f.normal)} · center {v(f.center)} · area {Math.round(f.area)} mm²
                <span style={{ color: palette.textSecondary }}>
                  {handle
                    ? <> · drag the arrow to change <b>{handle.name}</b>{nHandles > 1 ? ' (Tab for others)' : ''}</>
                    : Object.keys(paramVals).length === 0
                      ? ' · no parameters to drag (add some to P, or ask the AI)'
                      : sensState === 'error'
                        ? ' · couldn’t work out which parameters move it (reselect the face to retry)'
                        : sensState === 'ready'
                          ? ' · no parameter moves this face'
                          : ' · finding the parameters that move it…'}
                </span>
                {protect}
              </span>;
            }
            const shared = res.edges.filter((e) => e.faceIndices.length === 2 && e.faceIndices.includes(sel[0]!) && e.faceIndices.includes(sel[1]!));
            return <span style={{ color: shared.length ? palette.text : palette.textSecondary }}>
              {faces.map((f) => `#${f.index} ${f.kind}`).join(' ∩ ')} → {shared.length
                ? <b>{shared.length} joining edge{shared.length > 1 ? 's' : ''} ({shared[0]!.kind})</b>
                : 'no shared edge (faces don’t meet)'}
              {protect}
            </span>;
          })()}
        </div>
      </div>
      {showHelp && <PartHelpModal onClose={() => setShowHelp(false)} />}
      {showVersions && getBackendId() && (
        <PartVersionsPanel docId={getBackendId()!} currentCode={code}
          onRestore={restoreVersion} onClose={() => setShowVersions(false)} />
      )}
      {showProduction && (
        <div onClick={() => setShowProduction(false)}
          style={{ position: 'fixed', inset: 0, zIndex: 200, background: 'rgba(0,0,0,0.5)',
                   display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
          <div onClick={(e) => e.stopPropagation()}
            style={{ width: 'min(640px, 94vw)', display: 'flex', flexDirection: 'column', gap: 12,
                     background: palette.panelBg, border: `1px solid ${palette.border}`, borderRadius: 12,
                     boxShadow: '0 12px 40px rgba(0,0,0,0.45)', padding: 18 }}>
            <div>
              <div style={{ fontSize: '15px', fontWeight: 600, color: palette.text }}>Production process</div>
              <div style={{ fontSize: '12.5px', color: palette.textSecondary, marginTop: 4 }}>
                Standing context for the AI — it designs every edit to this (clearances, fits, wall thickness).
                Describe how this part is made.
              </div>
            </div>
            <textarea value={prodDraft} autoFocus onChange={(e) => setProdDraft(e.target.value)}
              spellCheck={false} rows={10}
              style={{ width: '100%', resize: 'vertical', boxSizing: 'border-box', padding: '10px 12px',
                       background: palette.inputBg, color: palette.text, border: `1px solid ${palette.border}`,
                       borderRadius: 8, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                       fontSize: '12.5px', lineHeight: 1.5, outline: 'none' }} />
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <button onClick={() => setProdDraft(DEFAULT_PRODUCTION_NOTES)}
                style={{ ...btn, background: 'none', color: palette.textSecondary, border: `1px solid ${palette.border}` }}>
                Reset to FDM default
              </button>
              <div style={{ flex: 1 }} />
              <button onClick={() => setShowProduction(false)}
                style={{ ...btn, background: 'none', color: palette.textSecondary, border: `1px solid ${palette.border}` }}>
                Cancel
              </button>
              <button onClick={saveProduction}
                style={{ ...btn, background: palette.primaryBtn, color: '#fff', border: 'none' }}>
                Save
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
