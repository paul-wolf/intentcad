import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { useThemeStore } from '@/theme';
import { useDocumentStore } from '@/stores/documentStore';
import { buildApi, type RunResponse, type UsageResponse, type DimInfo } from '@/api/client';
import { persistModelCode, persistChat, persistThumbnail, persistName, persistProductionNotes, getBackendId } from '@/api/autoSave';
import { DEFAULT_PRODUCTION_NOTES } from '@/utils/document';
import type { ChatMessage } from '@/types/document';
import { createViewer, type Viewer, type FaceRange, type AxisDir, type PlacedDim } from '@/build/webglViewer';
import { highlightPython, DARK_SYNTAX, LIGHT_SYNTAX } from '@/build/pyHighlight';
import { downloadTextFile } from '@/export/download';
import { buildKey, getCachedBuild, putCachedBuild, putCachedSens } from '@/build/buildCache';
import { PartVersionsPanel } from './PartVersionsPanel';

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
    buildApi.sensitivity(src)
      .then((r) => { if (sensKeyRef.current === key) { setSens(r.params); putCachedSens(key, r.params); } })
      .catch(() => { if (sensKeyRef.current === key) sensKeyRef.current = null; });
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

  const [code, setCode] = useState('');
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [flash, setFlash] = useState('');
  const [status, setStatus] = useState<'idle' | 'building' | 'done' | 'error'>('idle');
  const [message, setMessage] = useState('');
  const [warn, setWarn] = useState('');
  const [stats, setStats] = useState('');
  const [sel, setSel] = useState<number[]>([]);   // selected face indices (≤ 2)
  const resRef = useRef<RunResponse | null>(null);
  const selRef = useRef<number[]>([]);

  // click a face → toggle it in the selection (keep at most 2). With two faces
  // selected, highlight the edge(s) between them (an edge = two faces meeting).
  const onPick = (f: FaceRange | null) => {
    const res = resRef.current;
    let s = selRef.current;
    if (!f) s = [];
    else if (s.includes(f.index)) s = s.filter((i) => i !== f.index);
    else s = [...s, f.index].slice(-2);
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
    viewerRef.current?.highlightEdges(segs);
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

  const build = async (src: string, versionLabel?: string) => {
    if (!viewerRef.current) return;
    setStatus('building');
    setMessage('');
    const t0 = performance.now();
    try {
      // Deterministic: same code → same mesh. Serve an unchanged part from the
      // IndexedDB cache with no engine call.
      const key = buildKey(src);
      const cached = await getCachedBuild(key);
      const res = cached?.run ?? await buildApi.run(src);
      const took = Math.round(performance.now() - t0);
      setWarn(res.warning ?? '');
      viewerRef.current.update(res.mesh, res.faces);
      resRef.current = res;
      selRef.current = []; setSel([]);
      setParamVals(res.params);
      if (!cached) putCachedBuild(key, res);
      // sensitivity (perturbation = N rebuilds) is computed LAZILY — only when
      // something actually needs the param→face links (hover a param, ⌥, or a
      // selection). Just prime the state here; ensureSens() does the work.
      builtCodeRef.current = src;
      if (cached?.sens) { setSens(cached.sens); sensKeyRef.current = key; }
      else { setSens({}); sensKeyRef.current = null; }
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
    } catch (err) {
      setStatus('error');
      setMessage(String(err instanceof Error ? err.message : err));
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
          viewerRef.current = createViewer(canvasRef.current, { onFacePick: onPick, onAxes, onDims });
        } catch (err) {
          setStatus('error');
          setMessage(String(err instanceof Error ? err.message : err));
          return;
        }
      }
      build(initial);
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
  const [model, setModel] = useState<string>(() => localStorage.getItem('intentcad-edit-model') || 'claude-opus-4-8');
  const pickModel = (m: string) => { setModel(m); try { localStorage.setItem('intentcad-edit-model', m); } catch { /* ignore */ } };
  const [usage, setUsage] = useState<UsageResponse | null>(null);
  const chatScrollRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = chatScrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;   // keep the latest message in view
  }, [chat, asking]);
  const fetchUsage = () => buildApi.usage(getBackendId() ?? '').then(setUsage).catch(() => {});
  const [paramVals, setParamVals] = useState<Record<string, number>>({});
  const [sens, setSens] = useState<Record<string, DimInfo>>({});   // param -> what it controls

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

  // change a parameter's value: rewrite just that value in the script (comments
  // and formatting preserved), then rebuild + save.
  const applyParam = async (name: string, val: number) => {
    try {
      const r = await buildApi.setParams(code, { [name]: val });
      setCode(r.code);
      saveDraft(r.code);
      await build(r.code, `${name} = ${val}`);
    } catch (err) {
      setMessage(String(err instanceof Error ? err.message : err));
    }
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

  const sendChat = async () => {
    const instruction = ask.trim();
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
      const msg = `⚠ ${err instanceof Error ? err.message : err}`;
      persistChat([...base, { role: 'assistant', kind: 'question', text: msg, at: Date.now() }]);
    } finally {
      setAsking(false);
    }
  };

  const rebuild = () => { saveDraft(code); build(code, 'build'); };
  const [exporting, setExporting] = useState<'stl' | 'step' | 'stl-parts' | null>(null);
  const doExport = async (format: 'stl' | 'step' | 'stl-parts') => {
    if (status !== 'done' || exporting) return;
    setExporting(format);
    try {
      const r = await buildApi.export(code, format);
      if (format === 'stl-parts') {
        // r.data is a base64 zip of one STL per body
        const bytes = Uint8Array.from(atob(r.data), (c) => c.charCodeAt(0));
        const url = URL.createObjectURL(new Blob([bytes], { type: 'application/zip' }));
        const a = document.createElement('a');
        a.href = url; a.download = `${docName}-parts.zip`; a.click();
        URL.revokeObjectURL(url);
      } else {
        const mime = format === 'stl' ? 'model/stl' : 'application/step';
        downloadTextFile(r.data, `${docName}.${format}`, mime);
      }
    } catch (err) {
      setMessage(String(err instanceof Error ? err.message : err));
    } finally {
      setExporting(null);
    }
  };

  const btn: CSSProperties = {
    padding: '5px 14px', border: 'none', borderRadius: '4px', fontSize: '13px', cursor: 'pointer',
  };

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
          <button onClick={() => setShowVersions(true)} title="Browse and restore saved versions"
            style={{ ...btn, background: 'none', color: palette.textSecondary,
                     border: `1px solid ${palette.border}` }}>
            Versions
          </button>
          <button onClick={rebuild} disabled={status === 'building'}
            style={{ ...btn, background: palette.primaryBtn, color: '#fff', opacity: status === 'building' ? 0.6 : 1 }}>
            {status === 'building' ? 'Building…' : 'Build'}
          </button>
          {(['stl', 'step', 'stl-parts'] as const).map((f) => {
            const enabled = status === 'done' && !exporting;
            const label = f === 'stl-parts' ? 'Parts' : f.toUpperCase();
            return (
              <button key={f} onClick={() => doExport(f)} disabled={!enabled}
                title={f === 'stl-parts' ? 'Download one STL per body, zipped (for printing an assembly)' : undefined}
                style={{ ...btn, background: 'none', color: palette.textSecondary,
                         border: `1px solid ${palette.border}`, opacity: enabled ? 1 : 0.5,
                         cursor: enabled ? 'pointer' : 'default' }}>
                {exporting === f ? '…' : label}
              </button>
            );
          })}
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
                        onBlur={() => { if (paramVals[name] !== resRef.current?.params[name]) applyParam(name, paramVals[name]!); }}
                        style={{ width: '64px', padding: '3px 6px', background: palette.inputBg,
                                 border: `1px solid ${active ? palette.primaryBtn : palette.inputBorder}`,
                                 borderRadius: '4px', color: palette.text, fontSize: '12px' }}
                      />
                    </label>
                  );
                })}
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
            {/* orientation gizmo (bottom-left): X red, Y green, Z blue from origin */}
            <svg width={68} height={68} style={{ position: 'absolute', left: 10, bottom: 10, pointerEvents: 'none' }}>
              <circle cx={34} cy={34} r={2.5} fill={palette.textSecondary} />
              {(['X', 'Y', 'Z'] as const).map((n, i) => (
                <g key={n}>
                  <line ref={(el) => { gLine.current[i] = el; }} x1={34} y1={34} x2={34} y2={34}
                    stroke={['#d95555', '#5fb36a', '#6a8cd9'][i]} strokeWidth={2} strokeLinecap="round" />
                  <text ref={(el) => { gLabel.current[i] = el; }} x={34} y={34}
                    fill={['#d95555', '#5fb36a', '#6a8cd9'][i]} fontSize={12} fontWeight={700}
                    textAnchor="middle" style={{ paintOrder: 'stroke', stroke: 'rgba(0,0,0,0.5)', strokeWidth: 3 }}>{n}</text>
                </g>
              ))}
            </svg>
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
                            color: palette.danger, fontSize: '12px', whiteSpace: 'pre-wrap',
                            fontFamily: 'ui-monospace, Menlo, monospace' }}>
                {message || 'Build failed'}
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
            onKeyDown={(e) => { if (e.key === 'Enter') sendChat(); }}
            placeholder={sel.length ? 'e.g. chamfer this edge 2mm  (targets your selection)' : 'Describe a change — e.g. add four M4 corner bolt holes'}
            disabled={asking}
            style={{ flex: 1, padding: '6px 10px', background: palette.inputBg,
                     border: `1px solid ${palette.inputBorder}`, borderRadius: '4px',
                     color: palette.text, fontSize: '13px', outline: 'none' }}
          />
          <select value={model} onChange={(e) => pickModel(e.target.value)} disabled={asking}
            title="Model for AI edits — Fable 5 is stronger (and pricier); use it for hard tasks"
            style={{ padding: '6px 8px', background: palette.inputBg, color: palette.textSecondary,
                     border: `1px solid ${palette.inputBorder}`, borderRadius: '4px', fontSize: '12px', cursor: 'pointer' }}>
            <option value="claude-opus-4-8">Opus 4.8</option>
            <option value="claude-fable-5">Fable 5 ✦</option>
          </select>
          <button onClick={sendChat} disabled={asking || !ask.trim()}
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
            <span style={{ color: palette.warning ?? '#c78a1a' }}>
              ⚠ an operation failed (model shown up to it): {warn}
            </span>
          )}
          {status === 'done' && !warn && (() => {
            const res = resRef.current;
            const v = (a: [number, number, number]) => `(${a.map((n) => Math.round(n * 10) / 10).join(', ')})`;
            if (!res || sel.length === 0)
              return `${stats} · drag to orbit · scroll to zoom · click a face (click two for the edge between them)`;
            const faces = sel.map((i) => res.faces.find((f) => f.index === i)!).filter(Boolean);
            if (sel.length === 1) {
              const f = faces[0]!;
              return <span style={{ color: palette.text }}>
                Face #{f.index} · <b>{f.kind}</b> · normal {v(f.normal)} · center {v(f.center)} · area {Math.round(f.area)} mm²
              </span>;
            }
            const shared = res.edges.filter((e) => e.faceIndices.length === 2 && e.faceIndices.includes(sel[0]!) && e.faceIndices.includes(sel[1]!));
            return <span style={{ color: shared.length ? palette.text : palette.textSecondary }}>
              {faces.map((f) => `#${f.index} ${f.kind}`).join(' ∩ ')} → {shared.length
                ? <b>{shared.length} joining edge{shared.length > 1 ? 's' : ''} ({shared[0]!.kind})</b>
                : 'no shared edge (faces don’t meet)'}
            </span>;
          })()}
        </div>
      </div>
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
