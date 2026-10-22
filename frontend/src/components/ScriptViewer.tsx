import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { useThemeStore } from '@/theme';
import { useDocumentStore } from '@/stores/documentStore';
import {
  api, buildApi, errorText, ApiError, type RunResponse, type RunEdge, type FaceRefReport, type UsageResponse, type DimInfo, type ModelInfo, type ModelsResponse, type SizeFix,
  type FaceRefSpec, type HolePresets, type EdgeOpKind, type EdgeRefSpec, type ExtrudeExtent, type ExtrudeOp, type KeepItem, type Step,
  type PlaneReport, type MirrorPlane, type PatternReport, type PatternSpec, type PlaneOpKind, type RunFace,
} from '@/api/client';
import { persistModelCode, persistChat, persistThumbnail, persistName, persistProductionNotes, persistPrintBed, persistSketches, getBackendId } from '@/api/autoSave';
import { DEFAULT_PRODUCTION_NOTES } from '@/utils/document';
import type { ChatMessage } from '@/types/document';
import { createViewer, type Viewer, type FaceRange, type AxisDir, type PlacedDim, type PlacedHandle, type ViewerPick,
         type SectionMeasure, type PlacedPlaneLabel, type DragHandle, type MarkLines } from '@/build/webglViewer';
import {
  amountOut, amountValue, edgePayload, edgePlaneShape, faceBesideEdge, loadHiddenPlanes, newPlaneName, offsetBasePoint, offsetPayload,
  offsetPlaneShape, renameHidden, reopenedFromFace, saveHiddenPlanes, shownPlanes, type BaseName, type EdgePlaneValues,
  type Amount, type OffsetPlaneValues, type PlaneShape, clickAngle, cylinderOfFace, insideCylinder, tangentPayload, tangentPlaneShape,
  tangentZero, type Cylinder, type TangentPlaneValues,
} from '@/build/constructionPlanes';
import {
  atPosition, axisSection, cutNormal, flipSection, loadSection, saveSection, sectionAxis, sectionForView, sectionOnFace,
  sectionPosition, type Section,
} from '@/build/section';
import { SectionPanel } from './SectionPanel';
import { OverhangPanel } from './OverhangPanel';
import {
  bedWords, clampThreshold, DEFAULT_DOWN, dirWords, loadOverhangs, overhangInstruction, overhangSummary, saveOverhangs,
  type OverhangState,
} from '@/build/overhang';
import { useAuthStore } from '@/stores/authStore';
import {
  FILTER_KEY, PICK_FILTERS, clickSelect, edgeHandle, edgeLength, edgeLoop, edgeOfRef, faceEdges, measureEdges, nextFilter,
  sameEdgeRef, selectEdges, tangentChain, type PickFilter,
} from '@/build/edgePick';
import { handleOptions, add, scale, dot, len, sub, type HandleOption, type Vec3 } from '@/build/dragHandle';
import { VIEW_KEYS, type StandardView } from '@/build/viewOrient';
import { highlightPython, DARK_SYNTAX, LIGHT_SYNTAX } from '@/build/pyHighlight';
import { downloadTextFile } from '@/export/download';
import { buildKey, getCachedBuild, putCachedBuild, putCachedSens } from '@/build/buildCache';
import { importScript, importLabel, STEP_ACCEPT } from '@/build/importStep';
import { PartVersionsPanel } from './PartVersionsPanel';
import { PartHelpModal } from './PartHelpModal';
import { useFaceSketch, type ExtrudeOptions, type RevolveStart } from './FaceSketchMode';
import {
  ShellDialog, HoleDialog, EdgeOpDialog, ExtrudeDialog, RoundDialog, TrussDialog, useOpPreview, refOf, faceOfRef, sameRef, faceHint,
  holesPayload, holeValuesOf, newHoleValues, placeKey, toggleEdge, addEdges, argOpPayload, OffsetPlaneDialog, EdgePlaneDialog, TangentPlaneDialog,
  MirrorOpDialog, MirrorCopyDialog, MIRROR_COPY_COLOR, UNTIL_PIECE_COLOR, PatternOpDialog, RevolveDialog, type RevolveSketchView,
  type ShellValues, type HoleValues,
  type HolePlace, type EdgeOpValues, type ExtrudeValues, type ArgOpValues, type MirrorValues,
} from './OpDialogs';
import { untilPieceScript } from '@/build/extrudeUntil';
import { facePlane, mirrorCopyScript, mirrorPlaneShape, mirrorSkip, nextStepSelection, shiftedMirrorShape } from '@/build/mirror';
import { StepsList } from './StepsList';
import {
  axisWords, boxSegments, chipPoints, defaultPattern, dirOfEdge, dirOfFace, instanceCount, patternBodyLine, patternHandles,
  patternSkip, patternSpec, patternValues, placeInstances, remapSkip, reportsOn, toggleSkip, wayWords, type PatternValues,
} from '@/build/pattern';
import { messageLine, reopenableAt, stepIcon, stepInputs, stepLabel, stepProblems, suppressedNote } from '@/build/steps';
import {
  BASE_PLANES, boundPlane, extrudeDirectionText, faceLabel, findFaceSketch, partSide, referencedProfiles, referencedSketchNames,
  onTangentPlane, planeSketches, renamePlaneRefs, sketchBasePlane, sketchBindNotes, sketchHolePoints, sketchLoops, sketchSegments, type BasePlane,
  type SketchBindings,
} from '@/build/faceSketch';
import {
  buildFollowingSketches, followPartSketches, resolvePartSketches, sketchParamWarning, sketchVars,
} from '@/build/sketchParams';
import { brokenRefWarning, dimensionedToEdges } from '@/build/sketchRefs';
import {
  angleFromHandle, axisChoices, axisLabel, defaultAxis, lineProblem, revolvable, revolveHandle, revolveReport, revolveSummary,
  segmentPoints, type RevolveReport, type RevolveValues,
} from '@/build/revolve';
import { planeBasis, worldToSketch } from '@/build/sketchPlane';
import { partParams } from '@/build/scriptParams';
import { usesNames } from '@/utils/resolveSketch';
import {
  BAR_HINT, LAYOUTS, OPS_KEY, barOperations, isLayout, loadRecent, opById, opForKey, pushRecent,
  saveRecent, stepLayout, toggleOps, type Layout, type OpContext, type OpModel, type OpSelection, type Operation,
} from '@/build/operations';
import { OperationsPanel, Kbd } from './OperationsPanel';
import { OpIcon, OPS_GRID_ICON } from './OpIcons';
import { ContextChips, ContextPane, useContextFiles, type CtxColors } from './ContextPane';
import { acceptable, chatUsageNote, filesToSend, seesSpend, skipList, spendLine, spendNote, usageLabel } from '@/build/contextFiles';
import { chooseModel, modelsStale } from '@/build/modelList';

// the view buttons, in key order (1–6, then 0)
const VIEW_BUTTONS = (['1', '2', '3', '4', '5', '6', '0'] as const)
  .map((k) => [k, VIEW_KEYS[k]!] as [string, StandardView]);

// the window layouts (Code, Chat, 3D, Operations) and the switcher's keys
const LAYOUT_KEYS = `L or Ctrl/⌘+\\ next, Shift+L back, ${OPS_KEY} Operations and back`;

interface Props {
  onClose: () => void;
  /** When the editor is a standalone page, breadcrumb nav (saves first). */
  onHome?: () => void;
  onProject?: () => void;
  /** Offer sketching on a face (only where no other sketcher is mounted:
   *  the sketch stores are global, so not when opened over the 2D editor). */
  sketchOnFace?: boolean;
}

// stable empty reference so the zustand selector below doesn't return a fresh
// array every render (which would loop: new snapshot → re-render → new snapshot)
const humanBytes = (b: number): string =>
  b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1048576).toFixed(1)} MB`;

const NO_CHAT: ChatMessage[] = [];
/** What the code view's Edit button calls a line's dialog. */
const OP_NAMES = {
  shell: 'Shell', holes: 'Hole', fillet: 'Fillet', chamfer: 'Chamfer', extrude: 'Extrude', auto_round: 'Round',
  truss_windows: 'Lighten', offset_plane: 'Offset plane', edge_plane: 'Plane on edge', tangent_plane: 'Tangent plane', mirror_body: 'Mirror body',
  pattern_body: 'Pattern body', revolve: 'Revolve',
} as const;
/** An Offset plane, Plane on edge or Tangent plane dialog: `line` the line
 *  it was reopened from (null: a new plane), `own` the plane's name in the
 *  script then. */
type PlaneOp = { line: number | null; own: string | null }
  & ({ kind: 'offset'; v: OffsetPlaneValues } | { kind: 'edge'; v: EdgePlaneValues } | { kind: 'tangent'; v: TangentPlaneValues });
/** A reopened extrude line: its values, the P key its depth is in, and
 *  whether it makes the part (New body, nothing else). */
/** The Extrude dialog: reopened on its line, or new (`line` null: the
 *  sketcher's Up to face / Up to next, finished here with a 3D pick and preview). */
interface ExtrudeEdit { line: number | null; v: ExtrudeValues; param: string | null; firstBody: boolean }
/** The Revolve dialog: `line` the line it was reopened from (null: a new
 *  revolve), `firstBody` it makes the part (New body, nothing else). */
interface RevolveEdit { line: number | null; v: RevolveValues; firstBody: boolean }
// the drag preview can't show P moving a face sketch: said once a session
let sketchDragNoted = false;

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

export function ScriptViewer({ onClose, onHome, onProject, sketchOnFace = false }: Props) {
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
  // A build is a pure function of the script, the face sketches it extrudes
  // (sketch("name")) and the print bed face (auto_round's keep_bed): all go
  // to the engine and into the cache key.
  const buildInputs = (src: string) => {
    const doc = useDocumentStore.getState().document;
    const sketches = referencedProfiles(src, doc.sketches);
    const bed = doc.printBed ?? null;
    const extra = (Object.keys(sketches).length ? `\n# sketches ${JSON.stringify(sketches)}` : '')
      + (bed ? `\n# bed ${JSON.stringify(bed)}` : '');
    return { sketches, bed, key: buildKey(src + extra) };
  };
  // buildApi.run / export's last arguments for this script
  const runArgs = (src: string) => { const b = buildInputs(src); return [b.sketches, b.bed] as const; };
  const ensureSens = () => {
    const src = builtCodeRef.current;
    if (!src) return;
    const { key, sketches } = buildInputs(src);
    if (sensKeyRef.current === key) return;   // already computed or in flight
    sensKeyRef.current = key;
    setSensState('loading');
    buildApi.sensitivity(src, getBackendId() ?? '', sketches)
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
  // the handle is a Fillet / Chamfer dialog's (on its first edge), not a face's
  const edgeHandleOnRef = useRef(false);
  // that handle's value when its drag began, while it's dragged
  const edgeDragRef = useRef<number | null>(null);
  const setEdgeSizeRef = useRef<(v: number) => void>(() => {});
  const handleHintRef = useRef('');   // "Tab ⇄ 1/2" when several params move the face
  const dialogDragNoteRef = useRef('0.1 mm steps · Esc cancels');   // a dialog handle's, while dragged
  const handleUnitRef = useRef('');   // after the handle's value: '°' for an angle
  // the live preview moves faces by the engine's sensitivity map, worked out
  // with the face sketches' shapes fixed: a sketch dimension using this param
  // only moves when the drop rebuilds
  // (nor anything dimensioned to a face sketch's reference edges: those
  // follow the face's edges only after a full build)
  const noteSketchDrag = (param: string) => {
    const doc = useDocumentStore.getState().document;
    const used = new Set(referencedSketchNames(builtCodeRef.current));
    const sketches = doc.sketches.filter((s) => s.plane && used.has(s.name));
    const byParam = sketches.some((s) => usesNames(s, [param]));
    const byEdges = sketches.some(dimensionedToEdges);
    if (!byParam && !byEdges) return;
    sketchDragNoted = true;
    setNotice(byParam
      ? `The drag preview doesn't move sketches whose dimensions use ${param}; they move when you let go`
      : "The drag preview doesn't move sketch points dimensioned to their face's edges; they follow when you let go");
    window.setTimeout(() => setNotice(''), 10000);
  };
  // a pattern's instance numbers (buttons: a click leaves that copy out),
  // positioned every frame like the handle
  const chipEls = useRef(new Map<string, HTMLButtonElement>());
  const onMarks = (pts: PlacedDim[]) => {
    for (const p of pts) {
      const el = chipEls.current.get(p.key);
      if (!el) continue;
      el.style.visibility = p.visible ? 'visible' : 'hidden';
      el.style.transform = `translate(${p.x}px, ${p.y}px) translate(-50%, -50%)`;
    }
  };
  const onHandle = (p: PlacedHandle | null) => {
    const { line, knob, label, sub: subEl } = hEls.current;
    const h = handleRef.current;
    const show = !!(p && h && p.visible);
    for (const el of [line, knob, label, subEl]) el?.setAttribute('opacity', show ? '1' : '0');
    if (!show || !p || !h) return;
    const edge = edgeHandleOnRef.current;
    if (p.dragging && !sketchDragNoted && !edge) noteSketchDrag(h.name);
    line?.setAttribute('x1', `${p.x}`); line?.setAttribute('y1', `${p.y}`);
    line?.setAttribute('x2', `${p.ax}`); line?.setAttribute('y2', `${p.ay}`);
    knob?.setAttribute('cx', `${p.x}`); knob?.setAttribute('cy', `${p.y}`);
    const right = p.ax >= p.x;              // label past the arrow tip
    const lx = `${p.ax + (right ? 9 : -9)}`, anchor = right ? 'start' : 'end';
    if (label) {
      label.setAttribute('x', lx); label.setAttribute('y', `${p.ay + 4}`);
      label.setAttribute('text-anchor', anchor);
      label.textContent = p.dragging && p.value !== h.value
        ? `${h.name} ${dimFmt(h.value)}${handleUnitRef.current} → ${dimFmt(p.value)}${handleUnitRef.current}`
        : `${h.name} ${dimFmt(p.value)}${handleUnitRef.current}`;
    }
    if (subEl) {
      subEl.setAttribute('x', lx); subEl.setAttribute('y', `${p.ay + 18}`);
      subEl.setAttribute('text-anchor', anchor);
      const snapped = p.snapFace !== null;
      subEl.setAttribute('fill', snapped ? '#2dd4bf' : '#cfd6df');
      subEl.textContent = snapped ? `snap → face #${p.snapFace}`
        : p.dragging ? (edge ? dialogDragNoteRef.current : 'Shift: 0.1 steps · Esc cancels')
        : edge ? (handleHintRef.current ? `drag to change · ${handleHintRef.current}` : 'drag to change') : handleHintRef.current;
    }
  };

  // the section view (Z): a plane cutting the 3D view open. View-only: the
  // script never hears of it. The plane is reported back by the viewer as
  // it is dragged; state follows only when the drag ends
  const [secPlane, setSecPlane] = useState<Section | null>(null);
  const [secOn, setSecOn] = useState(false);
  const [secDragging, setSecDragging] = useState(false);
  const secLiveRef = useRef<Section | null>(null);    // the viewer's plane, also mid-drag
  const secFromRef = useRef<number | null>(null);     // its position when the drag began
  const secPointsRef = useRef(0);                     // outline points clicked for a distance
  const onSection = (sNow: Section, st: { dragging: boolean; snapFace: number | null }) => {
    secLiveRef.current = sNow;
    if (st.dragging) {
      if (secFromRef.current == null) { secFromRef.current = sectionPosition(secPlaneRef.current ?? sNow); setSecDragging(true); }
      return;
    }
    secFromRef.current = null;
    setSecDragging(false);
    setSecPlane(sNow);
  };
  const secPlaneRef = useRef<Section | null>(null);
  secPlaneRef.current = secPlane;

  // the overhang highlight (H): shades what would print as an overhang.
  // View-only, like the section; on/off and the threshold are per user. The
  // print bed face is the part's (Document.printBed): the build finds it again
  const userId = useAuthStore((s) => s.user?.id ?? '');
  const [ovState, setOvStateRaw] = useState<OverhangState>(() => loadOverhangs(userId));
  useEffect(() => { setOvStateRaw(loadOverhangs(userId)); }, [userId]);
  const setOvState = (f: (o: OverhangState) => OverhangState) => setOvStateRaw((o) => {
    const n = f(o); saveOverhangs(n, userId); return n;
  });
  const printBed = useDocumentStore((s) => s.document.printBed ?? null);
  // the last build, with the bed face it was built with
  const [ovBuilt, setOvBuilt] = useState<{ res: RunResponse; bed: string } | null>(null);
  const [ovTip, setOvTip] = useState<{ text: string; x: number; y: number } | null>(null);
  // the face a click would pick (the Up to face dialog names it)
  const [hoverPickFace, setHoverPickFace] = useState<number | null>(null);
  const facePickingRef = useRef(false);
  // the view buttons wrap onto two rows in a narrow view: the panels above them follow
  const [viewBarH, setViewBarH] = useState(20);
  const viewBarObs = useRef<ResizeObserver | null>(null);
  const viewBarRef = useCallback((el: HTMLDivElement | null) => {
    viewBarObs.current?.disconnect();
    viewBarObs.current = null;
    if (!el || typeof ResizeObserver === 'undefined') return;
    viewBarObs.current = new ResizeObserver(() => setViewBarH(el.offsetHeight));
    viewBarObs.current.observe(el);
  }, []);
  const ovLiveRef = useRef<{ down: Vec3; threshold: number } | null>(null);
  type SecEls = HandleEls & { wall: HTMLDivElement | null; dist: HTMLDivElement | null };
  const sEls = useRef<SecEls>({ line: null, knob: null, label: null, sub: null, wall: null, dist: null });
  const onSectionHandle = (p: PlacedHandle | null) => {
    const { line, knob, label, sub: subEl } = sEls.current;
    const plane = secLiveRef.current;
    const show = !!(p && p.visible && plane);
    for (const el of [line, knob, label, subEl]) el?.setAttribute('opacity', show ? '1' : '0');
    if (!show || !p || !plane) return;
    line?.setAttribute('x1', `${p.x}`); line?.setAttribute('y1', `${p.y}`);
    line?.setAttribute('x2', `${p.ax}`); line?.setAttribute('y2', `${p.ay}`);
    knob?.setAttribute('cx', `${p.x}`); knob?.setAttribute('cy', `${p.y}`);
    const right = p.ax >= p.x;
    const lx = `${p.ax + (right ? 9 : -9)}`, anchor = right ? 'start' : 'end';
    const name = sectionAxis(plane) ?? 'Plane';
    const at = sectionPosition(plane), from = secFromRef.current;
    if (label) {
      label.setAttribute('x', lx); label.setAttribute('y', `${p.ay + 4}`);
      label.setAttribute('text-anchor', anchor);
      label.textContent = p.dragging && from != null && Math.abs(from - at) > 1e-9
        ? `${name} ${from.toFixed(2)} → ${at.toFixed(2)} mm` : `${name} ${at.toFixed(2)} mm`;
    }
    if (subEl) {
      subEl.setAttribute('x', lx); subEl.setAttribute('y', `${p.ay + 18}`);
      subEl.setAttribute('text-anchor', anchor);
      const snapped = p.snapFace !== null;
      subEl.setAttribute('fill', snapped ? '#2dd4bf' : '#cfd6df');
      subEl.textContent = snapped ? `snap → face #${p.snapFace}`
        : p.dragging ? 'Shift: 0.1 steps · Esc cancels' : 'drag to move the cut';
    }
  };
  // the wall under the cursor and the two-point distance, beside what they measure
  const onSectionMeasure = (m: SectionMeasure | null) => {
    secPointsRef.current = m?.points ?? 0;
    const put = (el: HTMLDivElement | null, v: SectionMeasure['wall'], what: string) => {
      if (!el) return;
      el.style.display = v ? 'block' : 'none';
      if (!v) return;
      el.style.left = `${v.x + 14}px`; el.style.top = `${v.y + 12}px`;
      el.firstElementChild!.textContent = `${v.approx ? '≈ ' : ''}${v.mm.toFixed(2)} mm`;
      el.lastElementChild!.textContent = v.approx ? `${what} · curved: measured on the mesh` : what;
    };
    put(sEls.current.wall, m?.wall ?? null, 'wall');
    put(sEls.current.dist, m?.distance ?? null, 'distance');
  };

  const [code, setCode] = useState('');
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [flash, setFlash] = useState('');
  const [status, setStatus] = useState<'idle' | 'building' | 'done' | 'error'>('idle');
  const [message, setMessage] = useState('');
  const [warn, setWarn] = useState('');
  // face-sketch dimensions whose expression names something not in P (kept as they were)
  const [sketchWarns, setSketchWarns] = useState<string[]>([]);
  const [notice, setNotice] = useState('');
  // where the build before the last put each face sketch
  const prevBindRef = useRef<SketchBindings | null>(null);
  // what the last build did to the face sketches' reference outlines: the
  // sketches whose edges moved with the part, whether it built again to
  // apply that, and those that still moved after that second build
  const [followNote, setFollowNote] = useState<{ moved: string[]; rebuilt: boolean; unsettled: string[] }>(
    { moved: [], rebuilt: false, unsettled: [] });
  // the engine's one-click remedy for a fillet/chamfer that doesn't fit (a
  // param to set), from the last build error or warning
  const [fix, setFix] = useState<SizeFix | null>(null);
  const [stats, setStats] = useState('');
  const [sel, setSel] = useState<number[]>([]);   // selected face indices
  const [selE, setSelE] = useState<number[]>([]);  // selected edge indices
  const resRef = useRef<RunResponse | null>(null);
  const selRef = useRef<number[]>([]);
  const selERef = useRef<number[]>([]);
  // selected construction planes (by name): a click on a plane's outline or
  // label replaces the selection, Shift-click adds or drops it
  const [selP, setSelP] = useState<string[]>([]);
  const selPRef = useRef<string[]>([]);
  // what a click picks (E steps through): faces + edges, faces, edges
  const [pickFilter, setPickFilter] = useState<PickFilter>('both');
  const pickFilterRef = useRef<PickFilter>('both');
  pickFilterRef.current = pickFilter;
  const cyclePickFilter = () => setPickFilter(nextFilter(pickFilterRef.current));
  // a part to cut / join into: any script that assigns `part`, except the
  // unbuilt starter (New body replaces that)
  const hasPartRef = useRef(false);
  hasPartRef.current = !(code === STARTER && status !== 'done') && /^part\s*=[^=]/m.test(code);
  const codeRef = useRef(code);
  codeRef.current = code;
  const faceSketch = useFaceSketch(viewerRef, canvasRef, resRef, (name, ex, rev) => { void sketchDoneRef.current(name, ex, rev); },
                                   () => hasPartRef.current, () => partParams(codeRef.current, paramBase.current));
  const faceSketchRef = useRef(faceSketch);
  faceSketchRef.current = faceSketch;
  const [sketchTip, setSketchTip] = useState<{ name: string; x: number; y: number } | null>(null);
  // highlight the edges auto_round couldn't round (the footer's toggle)
  const [showSkipped, setShowSkipped] = useState(false);
  const showSkippedRef = useRef(false);
  const buildAbort = useRef<AbortController | null>(null);   // cancel an in-flight build
  const cancelBuild = () => { buildAbort.current?.abort(); };

  // the selection holds faces and edges: a click on one replaces it,
  // Shift-click adds or drops it, a click on empty space (or Esc) clears it.
  // An edge within a few px of the cursor wins over the face under it (the
  // filter, E, can limit it to one or the other). With two faces selected,
  // highlight the edge(s) between them (an edge = two faces meeting). While
  // an operation's dialog is open, a click goes to the dialog instead.
  const opPickRef = useRef<((p: ViewerPick, mods: { shift: boolean; alt: boolean }) => void) | null>(null);
  // a loop or chain double-clicked while a dialog that takes edges is open
  const opEdgesRef = useRef<((edges: number[]) => void) | null>(null);
  const onPick = (p: ViewerPick, mods: { shift: boolean; alt: boolean }) => {
    if (opPickRef.current) { opPickRef.current(p, mods); return; }
    if (p && 'plane' in p) { pickPlane(p.plane, mods.shift); return; }
    const s = clickSelect({ faces: selRef.current, edges: selERef.current },
                          p && ('edge' in p ? { edge: p.edge } : { face: p.face.index }), mods.shift);
    applySelection(s.faces, s.edges, mods.shift ? selPRef.current : []);
  };
  // a construction plane clicked (in the view, its label or the planes list)
  const pickPlane = (name: string, shift: boolean) => {
    if (!shift) { applySelection([], [], [name]); return; }
    const ps = selPRef.current.includes(name) ? selPRef.current.filter((n) => n !== name) : [...selPRef.current, name];
    applySelection(selRef.current, selERef.current, ps);
  };
  // double-click an edge: the loop round the face it borders (the one under
  // the cursor); Alt: the chain of edges running smoothly on from it
  const onEdgeDoubleClick = (hit: { edge: number; face: number | null }, mods: { shift: boolean; alt: boolean }) => {
    const res = resRef.current;
    if (!res) return;
    const list = mods.alt ? tangentChain(res.edges, hit.edge)
      : hit.face != null ? edgeLoop(res.edges, hit.edge, hit.face) : [hit.edge];
    if (opEdgesRef.current) { opEdgesRef.current(list); return; }
    if (opPickRef.current) return;
    const s = selectEdges({ faces: selRef.current, edges: selERef.current }, list, mods.shift);
    applySelection(s.faces, s.edges);
  };
  // "Edges of this face": the selected face's boundary, every loop of it
  const selectFaceEdges = () => {
    const res = resRef.current;
    const f = selRef.current[0];
    if (!res || f == null) return;
    applySelection([], faceEdges(res.edges, f));
  };
  const applySelection = (s: number[], es: number[] = [], ps: string[] = []) => {
    const res = resRef.current;
    selRef.current = s;
    selERef.current = es;
    selPRef.current = ps;
    setSel(s);
    setSelE(es);
    setSelP(ps);
    viewerRef.current?.selectPlanes(ps);
    if (s.length) ensureSens();   // selecting geometry → we want the param links
    viewerRef.current?.selectFaces(s);
    viewerRef.current?.selectEdges(es);
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
  const applySelectionRef = useRef(applySelection);
  applySelectionRef.current = applySelection;
  const cyclePickFilterRef = useRef(cyclePickFilter);
  cyclePickFilterRef.current = cyclePickFilter;
  const toggleSkipped = () => {
    showSkippedRef.current = !showSkippedRef.current;
    setShowSkipped(showSkippedRef.current);
    applySelection(selRef.current, selERef.current, selPRef.current);
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
    if (sel.length !== 2) return null;
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

  // Face sketches whose dimensions use the part's P (`floor + 2`): re-solved
  // with the script's P before anything reads their profiles — stored with
  // no undo step, one document update at most.
  const resolveSketches = (src: string) => {
    const st = useDocumentStore.getState();
    const r = resolvePartSketches(src, st.document.sketches, st.document.parameters, paramBase.current);
    if (r.changed.length) {
      useDocumentStore.setState({ document: { ...st.document, sketches: r.sketches } });
      persistSketches();
    }
    setSketchWarns(r.warnings.map(sketchParamWarning));
  };

  // After a build: each face sketch's reference outline moves onto the edges
  // of the face the build put it on, and what is dimensioned to those edges
  // follows — stored with no undo step, like the P re-solve. True when that
  // changed a profile the build used (so it must build again to show it).
  const followSketches = (src: string, res: RunResponse, moved: Set<string>, profiles: Set<string>): boolean => {
    const st = useDocumentStore.getState();
    const f = followPartSketches(st.document.sketches, res.sketches,
                                 sketchVars(src, st.document.parameters, res.params), res.edges, res.planes);
    profiles.clear();
    if (!f.changed.length) return false;
    useDocumentStore.setState({ document: { ...st.document, sketches: f.sketches } });
    persistSketches();
    f.moved.forEach((n) => moved.add(n));
    f.profileChanged.forEach((n) => profiles.add(n));
    return f.profileChanged.length > 0;
  };

  const build = async (src: string, versionLabel?: string): Promise<BuildOutcome> => {
    if (!viewerRef.current) return { kind: 'aborted' };
    buildAbort.current?.abort();                 // supersede any in-flight build
    const ctrl = new AbortController();
    buildAbort.current = ctrl;
    setStatus('building');
    setMessage('');
    const t0 = performance.now();
    try {
      resolveSketches(src);
      // Deterministic: same code → same mesh. Serve an unchanged part from the
      // IndexedDB cache with no engine call.
      const runOnce = async () => {
        const { key, sketches, bed } = buildInputs(src);
        const cached = await getCachedBuild(key);
        const run = cached?.run ?? await buildApi.run(src, ctrl.signal, getBackendId() ?? '', sketches, bed);
        if (!cached) putCachedBuild(key, run);
        return { run, key, cached };
      };
      // the face sketches follow what was built; when that moves a shape the
      // build extrudes, it builds once more to apply it (once only)
      const moved = new Set<string>(), unsettled = new Set<string>();
      const { result: { run: res, key, cached }, rebuilt } = await buildFollowingSketches(
        runOnce, (b) => followSketches(src, b.run, moved, unsettled));
      if (!rebuilt) unsettled.clear();
      setFollowNote({ moved: [...moved], rebuilt, unsettled: [...unsettled] });
      const took = Math.round(performance.now() - t0);
      setWarn(res.warning ?? '');
      setFix(res.fix?.param ? res.fix : null);
      viewerRef.current.update(res.mesh, res.faces);
      viewerRef.current.setEdges(res.edges);
      prevBindRef.current = resRef.current?.sketches ?? null;
      resRef.current = res;
      setOvBuilt({ res, bed: JSON.stringify(buildInputs(src).bed) });
      setBuiltPlanes(res.planes ?? {});
      if (sketchOnFace) faceSketchRef.current.pushLines();   // each on its face, where the build put it
      setParamVals(res.params);
      paramBase.current = res.params;
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
      // a selected plane is kept by name, while it's still there
      applySelection(keep, [], keep.length ? [] : selPRef.current.filter((n) => res.planes?.[n]));
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
    let done = false;
    let tries = 0;
    const start = (initial: string) => {
      setCode(initial);
      if (canvasRef.current && !viewerRef.current) {
        try {
          viewerRef.current = createViewer(canvasRef.current, {
            onPick, onEdgeDoubleClick, onAxes, onDims, onHandle, onHandleDrop, onHandleMove, onMarks,
            onSection, onSectionHandle, onSectionMeasure, onPlaneLabels, onOverhangHover: setOvTip,
            onHoverPick: (p) => setHoverPickFace(p && 'face' in p && facePickingRef.current ? p.face : null),
            ...(sketchOnFace ? {
              onSketchHover: (h: { name: string; x: number; y: number } | null) => setSketchTip(h),
              onSketchOpen: (id: string) => { setSketchTip(null); faceSketchRef.current.open(id); },
            } : {}),
          });
          if (sketchOnFace) faceSketchRef.current.pushLines();
          viewerRef.current.setSection(secLiveRef.current);
          viewerRef.current.setOverhangs(ovLiveRef.current);
        } catch (err) {
          setStatus('error');
          setMessage(errorText(err));
          return;
        }
      }
      // A brand-new part shows the STARTER seed but does NOT auto-build it —
      // you almost always replace it, so kicking off a build of the default is
      // wasted work. Saved parts build on open so you see the model immediately.
      if (initial === STARTER) {
        setStatus('idle');
        setMessage(sketchOnFace ? 'Edit the script or ask the AI, then Build — or press K to sketch the first shape.'
                                : 'Edit the script or ask the AI, then Build.');
      }
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
  // Model picker. The list comes from the server (which asks the Models API);
  // '' means "server default" until the list arrives. The page asks again when
  // its list is old — on coming back to the tab or focusing the picker — so a
  // new model shows up without a reload. Someone who never chose follows the
  // default; a remembered pick the API no longer offers falls back to it.
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [modelsSource, setModelsSource] = useState<ModelsResponse['source'] | null>(null);
  const modelsAt = useRef(0);
  const modelsLoading = useRef(false);
  const [model, setModel] = useState<string>(() => { try { return localStorage.getItem('intentcad-edit-model') || ''; } catch { return ''; } });
  const pickModel = (m: string) => { setModel(m); try { localStorage.setItem('intentcad-edit-model', m); } catch { /* ignore */ } };
  const loadModels = useRef((refresh: boolean) => {
    if (modelsLoading.current) return;
    modelsLoading.current = true;
    buildApi.models(refresh).then((r) => {
      modelsAt.current = Date.now();
      setModels(r.models);
      setModelsSource(r.source);
      let picked = false;
      try { picked = !!localStorage.getItem('intentcad-edit-model'); } catch { /* ignore */ }
      setModel((cur) => chooseModel(cur, r, picked));
    }).catch(() => { /* keep the free-text id; the server falls back to its default */ })
      .finally(() => { modelsLoading.current = false; });
  }).current;
  const modelsSourceRef = useRef(modelsSource);
  modelsSourceRef.current = modelsSource;
  const refreshModelsIfStale = () => {
    if (modelsStale(modelsAt.current, modelsSourceRef.current, Date.now())) loadModels(true);
  };
  useEffect(() => {
    loadModels(false);
    const onVisible = () => { if (document.visibilityState === 'visible') refreshModelsIfStale(); };
    window.addEventListener('focus', refreshModelsIfStale);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('focus', refreshModelsIfStale);
      document.removeEventListener('visibilitychange', onVisible);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const modelTitle = (m: ModelInfo) =>
    `${m.label} — ${m.note}. $${m.input_per_m}/M in · $${m.output_per_m}/M out (released ${m.released})`
    + (modelsSource === 'static' ? '. Offline list: the Models API could not be reached; retrying.' : '');
  // the AI spend (the status line, the chat's notes): staff and superusers only
  const user = useAuthStore((st) => st.user);
  const staff = seesSpend(user);
  const [usage, setUsage] = useState<UsageResponse | null>(null);
  // context files (reference PDFs and photos the AI reads): the part's and its
  // project's, once the part has a server id (a new part gets one on first save)
  const [docId, setDocId] = useState<string | null>(() => getBackendId());
  useEffect(() => {
    if (docId) return;
    const t = window.setInterval(() => { const id = getBackendId(); if (id) setDocId(id); }, 250);
    return () => window.clearInterval(t);
  }, [docId]);
  const ctxOwner = useMemo(() => (docId ? { document: docId } : null), [docId]);
  // the section is remembered per part
  useEffect(() => {
    if (!docId) return;
    const saved = loadSection(docId);
    if (saved) { setSecPlane(saved.plane); setSecOn(saved.on); }
  }, [docId]);
  useEffect(() => {
    if (docId && secPlane) saveSection(docId, { on: secOn, plane: secPlane });
  }, [docId, secPlane, secOn]);
  useEffect(() => {
    const live = secOn ? secPlane : null;
    secLiveRef.current = live;
    viewerRef.current?.setSection(live);
  }, [secOn, secPlane]);
  // which way is down: the bed face as the last build found it; while a new
  // one is being built, the face as it was picked; not found, Z
  const ovBedPending = !!ovBuilt && ovBuilt.bed !== JSON.stringify(printBed);
  const ovBedFound = ovBuilt?.res.bed?.normal && ovBuilt.res.bed.status !== 'not_found' ? ovBuilt.res.bed : null;
  const ovDown: Vec3 = !printBed ? DEFAULT_DOWN
    : ovBedPending ? printBed.normal : ovBedFound ? ovBedFound.normal! : DEFAULT_DOWN;
  const bedMissing = !!printBed && !!ovBuilt && !ovBedPending && !ovBedFound;
  const ovDownKey = ovDown.join(',');
  useEffect(() => {
    const live = ovState.on ? { down: ovDown, threshold: ovState.threshold } : null;
    ovLiveRef.current = live;
    viewerRef.current?.setOverhangs(live);
    if (!live) setOvTip(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ovState.on, ovState.threshold, ovDownKey]);
  const ovSummary = useMemo(() => {
    if (!ovState.on || !ovBuilt) return null;
    return overhangSummary(ovBuilt.res.mesh, ovBuilt.res.faces,
      { down: ovDown, threshold: ovState.threshold, inverted: viewerRef.current?.invertedRanges() ?? [] });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ovState.on, ovState.threshold, ovBuilt, ovDownKey]);
  const ctxStore = useContextFiles(ctxOwner);
  // files left out of the next message only (the chips' ×); cleared after it is sent
  const [skipCtx, setSkipCtx] = useState<ReadonlySet<string>>(new Set());
  const ctxPick = useRef<(() => void) | null>(null);
  const [chatUploading, setChatUploading] = useState('');
  // a message sent while its file was still uploading: sent once the upload is in
  const [sendQueued, setSendQueued] = useState<string | null>(null);
  const [chatDragging, setChatDragging] = useState(false);
  const chatFileRef = useRef<HTMLInputElement | null>(null);
  // the message box's width, for a placeholder that fits
  const [chatInputW, setChatInputW] = useState(0);
  const chatInputObs = useRef<ResizeObserver | null>(null);
  // what the window shows beside the 3D view: the script, the chat, or nothing
  // (the 3D view maximised); the parameters are shown or hidden separately
  // (or the Operations grid); the keys reach it through refs, and the
  // layout before is kept for U and Esc to go back to
  const [layout, setLayoutState] = useState<Layout>(() => {
    try { const l = localStorage.getItem('intentcad-part-layout'); return isLayout(l) ? l : 'code'; }
    catch { return 'code'; }
  });
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const prevLayout = useRef<Layout>(layout === 'ops' ? 'code' : layout);
  const setLayout = (l: Layout) => {
    const cur = layoutRef.current;
    if (l === cur) return;
    prevLayout.current = cur;
    layoutRef.current = l;
    setLayoutState(l);
    try { localStorage.setItem('intentcad-part-layout', l); } catch { /* ignore */ }
  };
  const cycleLayout = (dir: 1 | -1 = 1) => setLayout(stepLayout(layoutRef.current, dir));
  const toggleOpsLayout = () => setLayout(toggleOps(layoutRef.current, prevLayout.current));
  const leaveOps = () => { if (layoutRef.current === 'ops') setLayout(toggleOps('ops', prevLayout.current)); };
  const [showParams, setShowParamsState] = useState(() => {
    try { return localStorage.getItem('intentcad-part-params') !== 'hide'; } catch { return true; }
  });
  const toggleParams = () => setShowParamsState((cur) => {
    try { localStorage.setItem('intentcad-part-params', cur ? 'hide' : 'show'); } catch { /* ignore */ }
    return !cur;
  });
  const chatScrollRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = chatScrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;   // keep the latest message in view
  }, [chat, asking, layout]);
  const fetchUsage = () => {
    if (!seesSpend(useAuthStore.getState().user)) return;
    buildApi.usage(getBackendId() ?? '').then(setUsage).catch(() => {});
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (staff) fetchUsage(); else setUsage(null); }, [staff]);
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
    const down = (e: KeyboardEvent) => {
      if (e.key === 'Alt' && !faceSketchRef.current.activeRef.current) { setDimsOn(true); ensureSens(); }
    };
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
  // A face sketch was closed. Extrude asked for: append the script line (its
  // depth a new parameter) and build. Otherwise rebuild if the script already
  // extrudes this sketch — its shapes are part of the build's inputs.
  const sketchDone = async (name: string, ex: ExtrudeOptions | null, rev?: RevolveStart | null) => {
    const rback = revolveBackRef.current;
    if (rback) {
      // "Edit sketch" from the Revolve dialog: rebuild if the script uses the
      // sketch, then the dialog again (on the axis the sketcher's Revolve set)
      revolveBackRef.current = null;
      if (code.trim() && referencedProfiles(code, useDocumentStore.getState().document.sketches)[name]) {
        await build(code, `Edit sketch ${name}`);
      }
      setRevolveOp({ ...rback, v: { ...rback.v, sketch: name, ...(rev?.axis ? { axis: rev.axis } : {}) } });
      return;
    }
    if (rev) {
      // the sketcher's Revolve…: the dialog, for the angle and a 3D preview
      const firstBody = !hasPartRef.current;
      setRevolveOp({ line: null, firstBody,
                     v: { sketch: name, op: firstBody ? 'new' : 'join', axis: rev.axis, angle: 360, both: false, flip: false } });
      return;
    }
    const back = sketchBackRef.current;
    if (back) {
      // "Edit sketch" from a reopened extrude: rebuild with the new shapes, then
      // the panel again (with what the sketcher's own extrude panel set, if used)
      sketchBackRef.current = null;
      if (code.trim()) await build(code, `Edit sketch ${name}`);
      const v = ex ? {
        ...back.v, depth: ex.depth > 0 ? ex.depth : back.v.depth, through: ex.through, flip: ex.flip, both: !!ex.both,
        op: back.firstBody ? 'new' as const : ex.op === 'new' ? back.v.op : ex.op,
        extent: back.firstBody ? 'distance' as const : ex.extent ?? (ex.through ? 'through' as const : 'distance' as const),
      } : back.v;
      setExtrudeOp({ ...back, v });
      return;
    }
    if (!ex) {
      if (referencedProfiles(code, useDocumentStore.getState().document.sketches)[name]) await build(code);
      return;
    }
    if (ex.op !== 'new' && (ex.extent === 'face' || ex.extent === 'next')) {
      // Up to face / Up to next: the dialog on the part, to pick the face and
      // preview where it stops
      if (code.trim()) await build(code, `Edit sketch ${name}`);
      setExtrudeOp({ line: null, firstBody: false, param: null,
                     v: { sketch: name, op: ex.op, extent: ex.extent, depth: ex.depth > 0 ? ex.depth : 5, through: false,
                          flip: ex.flip, both: false, datum: !!ex.datum, face: null, offset: 0 } });
      return;
    }
    try {
      // New body starts the script over when it is still the unbuilt starter
      const base = ex.op === 'new' && code === STARTER ? '' : code;
      const r = await buildApi.addExtrude({ code: base, sketch: name, ...ex });
      setCode(r.code);
      const out = await build(r.code, `${{ cut: 'Cut', join: 'Join', new: 'New body from' }[ex.op]} ${name}`);
      if (out.kind === 'ok') saveDraft(r.code);
    } catch (err) {
      setMessage(errorText(err));
    }
  };
  // a reopened extrude whose sketch is being edited: its panel comes back on Done
  const sketchBackRef = useRef<ExtrudeEdit | null>(null);
  const sketchDoneRef = useRef(sketchDone);
  sketchDoneRef.current = sketchDone;

  // Shell: a dialog writing `part = shell(part, remove=[face_ref(...)], ...)`,
  // its result previewed as a ghost. `line` is the script line it was
  // reopened from (OK rewrites just that line), null for a new one.
  const [shellOp, setShellOp] = useState<{ line: number | null; v: ShellValues } | null>(null);
  const shellKey = shellOp ? JSON.stringify(shellOp) : '';
  const shellLine = (s: { line: number | null; v: ShellValues }) =>
    buildApi.addShell({ code: codeRef.current, remove: s.v.remove, thickness: s.v.thickness, inside: s.v.inside, line: s.line });
  const shellPreview = useOpPreview(
    viewerRef,
    shellOp && shellOp.v.thickness > 0 ? () => shellLine(shellOp).then((r) => r.code) : null,
    shellKey,
    (src, signal) => buildApi.run(src, signal, getBackendId() ?? '', ...runArgs(src)),
  );
  const startShell = () => {
    const res = resRef.current;
    if (!res) return;
    const remove = selRef.current.map((i) => res.faces.find((f) => f.index === i))
      .map((f) => (f ? refOf(f) : null)).filter((r): r is FaceRefSpec => !!r);
    setShellOp({ line: null, v: { remove, thickness: 2, inside: true } });
  };
  const closeOp = () => {
    setShellOp(null);
    setHoleOp(null);
    setEdgeOp(null);
    setExtrudeOp(null);
    setRevolveOp(null);
    setArgOp(null);
    setPlaneOp(null);
    setTangentAim((a) => { if (a != null) setNotice(''); return null; });
    setMirrorOp(null);
    setCopyOp(null);
    setPatternOp(null);
    setPatternShown(null);
    viewerRef.current?.hoverFace(null);
    viewerRef.current?.hoverEdge(null);
    applySelection([]);
  };
  const closeOpRef = useRef(closeOp);
  closeOpRef.current = closeOp;
  const applyShell = async () => {
    const s = shellOp;
    if (!s || !(s.v.thickness > 0)) return;
    try {
      const src = shellPreview.built(shellKey) ?? (await shellLine(s)).code;
      closeOp();
      setCode(src);
      const out = await build(src, s.line ? 'Edit shell' : 'Shell');
      if (out.kind === 'ok') saveDraft(src);
    } catch (err) {
      setNotice(`Shell: ${errorText(err)}`);
    }
  };
  // Hole: a dialog writing `part = holes(part, at=sketch_points("..."), ...)`
  // (or at=face_ref(...): a face's centre), previewed the same way.
  const [holeOp, setHoleOp] = useState<{ line: number | null; v: HoleValues } | null>(null);
  const [holePresets, setHolePresets] = useState<HolePresets | null>(null);
  // the face picked for "its centre" (it stays a choice while the dialog is open)
  const [holeFace, setHoleFace] = useState<{ ref: FaceRefSpec; normal: [number, number, number] } | null>(null);
  const holeKey = holeOp ? JSON.stringify(holeOp) : '';
  const holeLine = (h: { line: number | null; v: HoleValues }, p: HolePresets) =>
    buildApi.addHoles({ code: codeRef.current, ...holesPayload(h.v, p), line: h.line });
  const holePreview = useOpPreview(
    viewerRef,
    holeOp && holePresets ? () => holeLine(holeOp, holePresets).then((r) => r.code) : null,
    holeKey,
    (src, signal) => buildApi.run(src, signal, getBackendId() ?? '', ...runArgs(src)),
  );
  const loadHolePresets = async () => {
    if (holePresets) return holePresets;
    const p = await buildApi.holePresets();
    setHolePresets(p);
    return p;
  };
  const docSketches = useDocumentStore((s) => s.document.sketches);
  const holeSketches = docSketches.filter((sk) => sk.plane && sketchHolePoints(sk).length > 0);

  // The steps list: the script's operations, as the backend reads them (the
  // sketches on a base plane, and each one's hole points, tell it how)
  const stepInKey = JSON.stringify(stepInputs(docSketches.map((sk) => ({
    name: sk.name, basePlane: !!sketchBasePlane(sk) || (!!sk.planeRef && !onTangentPlane(sk, resRef.current?.planes)), points: sketchHolePoints(sk).length,
  }))));
  const stepIn = useMemo(() => JSON.parse(stepInKey) as ReturnType<typeof stepInputs>, [stepInKey]);
  const [steps, setSteps] = useState<Step[]>([]);
  useEffect(() => {
    const ac = new AbortController();
    const t = window.setTimeout(() => {
      buildApi.steps(code, stepIn.datum, stepIn.points)
        .then((r) => { if (!ac.signal.aborted) setSteps(r.steps); })
        .catch(() => { if (!ac.signal.aborted) setSteps([]); });   // a script that doesn't parse: none
    }, 250);
    return () => { ac.abort(); window.clearTimeout(t); };
  }, [code, stepIn]);
  // the steps chosen in the list (Ctrl/Shift-click for more: Mirror steps
  // copies them), the last one clicked first for Shift's run
  const [stepPick, setStepSel] = useState<number[]>([]);
  const stepAnchor = useRef<number | null>(null);
  const stepSel = stepPick.filter((l) => steps.some((s) => s.line === l));
  const [stepBusy, setStepBusy] = useState(false);
  const holePlaces: HolePlace[] = [
    ...holeSketches.map((sk) => {
      const n = sketchHolePoints(sk).length;
      const where = sk.face?.hint ? ` on the ${sk.face.hint}` : '';
      return {
        key: placeKey({ sketch: sk.name }), at: { sketch: sk.name }, count: n,
        label: `"${sk.name}"${where} · ${n} point${n > 1 ? 's' : ''}`,
        normal: (resRef.current?.sketches?.[sk.name]?.plane?.normal ?? sk.plane!.normal) as [number, number, number],
      };
    }),
    ...(holeFace ? [{ key: placeKey({ face: holeFace.ref }), at: { face: holeFace.ref }, count: 1,
                      label: `Centre of the ${holeFace.ref.hint ?? 'face'}`, normal: holeFace.normal }] : []),
  ];
  // where holes on face `f` go: the sketch with points drawn on it, else its centre
  const holeAt = (f: NonNullable<RunResponse['faces']>[number]) => {
    const sk = findFaceSketch(holeSketches, f, resRef.current?.sketches);
    if (sk) return { at: { sketch: sk.name }, face: null };
    const ref = refOf(f);
    return ref ? { at: { face: ref }, face: { ref, normal: f.normal as [number, number, number] } } : null;
  };
  const selPlane = (() => {
    const f = sel.length === 1 ? resRef.current?.faces.find((x) => x.index === sel[0]) : null;
    return f && f.kind === 'plane' ? f : null;
  })();
  const startHole = async () => {
    try {
      const p = await loadHolePresets();
      const picked = selPlane ? holeAt(selPlane) : null;
      const at = picked?.at ?? (holeSketches[0] ? { sketch: holeSketches[0].name } : null);
      if (!at) return;
      setHoleFace(picked?.face ?? null);
      setHoleOp({ line: null, v: newHoleValues(at, p) });
    } catch (err) {
      setNotice(`Hole: ${errorText(err)}`);
    }
  };
  const applyHoles = async () => {
    const h = holeOp;
    if (!h || !holePresets) return;
    try {
      const src = holePreview.built(holeKey) ?? (await holeLine(h, holePresets)).code;
      closeOp();
      setCode(src);
      const out = await build(src, h.line ? 'Edit holes' : 'Holes');
      if (out.kind === 'ok') saveDraft(src);
    } catch (err) {
      setNotice(`Hole: ${errorText(err)}`);
    }
  };
  const holeComp = Number(resRef.current?.params?.hole_comp ?? 0) || 0;

  // Fillet / Chamfer: a dialog writing `part = fillet(part, edges_ref([...]),
  // radius=P["fillet_r"])` (chamfer: length=P["chamfer_d"]) on the selected
  // edges, previewed the same way. `adds`: the edges selected when it was
  // reopened, offered to add to the line; `now`: where the line's edges are on
  // the part as built (its refs keep the length and middle they had when picked).
  type EdgeNow = { ref: EdgeRefSpec; length: number; midpoint: [number, number, number]; radius?: number };
  const [edgeOp, setEdgeOp] = useState<{ op: EdgeOpKind; line: number | null; v: EdgeOpValues; adds: EdgeRefSpec[];
                                         now: EdgeNow[]; mirrored?: string } | null>(null);
  const edgeKey = edgeOp ? JSON.stringify({ op: edgeOp.op, line: edgeOp.line, v: edgeOp.v }) : '';
  const edgeOpLine = (o: { op: EdgeOpKind; line: number | null; v: EdgeOpValues }) =>
    buildApi.addEdgeOp({ code: codeRef.current, op: o.op, edges: o.v.edges, size: o.v.size, line: o.line });
  const edgePreview = useOpPreview(
    viewerRef,
    edgeOp && edgeOp.v.size > 0 && edgeOp.v.edges.length ? () => edgeOpLine(edgeOp).then((r) => r.code) : null,
    edgeKey,
    (src, signal) => buildApi.run(src, signal, getBackendId() ?? '', ...runArgs(src)),
  );
  const selectedEdgeRefs = () => {
    const res = resRef.current;
    return selERef.current.map((i) => res?.edges.find((e) => e.index === i)?.ref)
      .filter((r): r is EdgeRefSpec => !!r);
  };
  const startEdgeOp = (op: EdgeOpKind) => {
    const edges = selectedEdgeRefs();
    if (!edges.length) return;
    setEdgeOp({ op, line: null, v: { edges, size: op === 'fillet' ? 1 : 0.5 }, adds: [], now: [] });
  };
  const applyEdgeOp = async () => {
    const o = edgeOp;
    if (!o || !(o.v.size > 0) || !o.v.edges.length) return;
    const name = o.op === 'fillet' ? 'Fillet' : 'Chamfer';
    try {
      const src = edgePreview.built(edgeKey) ?? (await edgeOpLine(o)).code;
      closeOp();
      setCode(src);
      const out = await build(src, o.line ? `Edit ${o.op}` : name);
      if (out.kind === 'ok') saveDraft(src);
    } catch (err) {
      setNotice(`${name}: ${errorText(err)}`);
    }
  };
  const opEdgeIndex = (r: EdgeRefSpec) => edgeOfRef(resRef.current?.edges ?? [], r);
  const edgeAsNow = (r: EdgeRefSpec): EdgeRefSpec => {
    const n = edgeOp?.now.find((x) => sameEdgeRef(x.ref, r));
    return n ? { ...r, length: n.length, midpoint: n.midpoint, ...(n.radius != null ? { radius: n.radius } : {}) } : r;
  };
  setEdgeSizeRef.current = (size: number) => setEdgeOp((o) => o && ({ ...o, v: { ...o.v, size } }));

  // ── Construction planes: the build's, which are shown (per part, kept in
  // localStorage, never in the script), and the Offset plane / Plane on edge
  // dialog, its preview drawn as a plane with a handle for the distance/angle
  const [builtPlanes, setBuiltPlanes] = useState<Record<string, PlaneReport>>({});
  const [hiddenPlanes, setHiddenState] = useState<string[]>(() => (docId ? loadHiddenPlanes(docId) : []));
  useEffect(() => { setHiddenState(docId ? loadHiddenPlanes(docId) : []); }, [docId]);
  const setHiddenPlanes = (names: string[]) => { setHiddenState(names); if (docId) saveHiddenPlanes(docId, names); };
  const [planeOp, setPlaneOp] = useState<PlaneOp | null>(null);
  // Tangent plane, before its dialog: the cylindrical face waiting for a
  // click where the plane should touch it (the angle comes from the click)
  const [tangentAim, setTangentAim] = useState<number | null>(null);
  const planeNames = [...new Set([...steps.flatMap((s) => (s.plane ? [s.plane] : [])), ...Object.keys(builtPlanes)])];
  // the one plane selected (and nothing else): K sketches on it, N looks at it, Z cuts along it
  const selectedPlane = () => {
    const ps = selPRef.current;
    const p = ps.length === 1 && !selRef.current.length && !selERef.current.length
      ? resRef.current?.planes?.[ps[0]!] : undefined;
    return p ? { name: ps[0]!, origin: p.origin as Vec3, normal: p.normal as Vec3, xAxis: p.xAxis as Vec3 } : null;
  };
  const planeNotice = (text: string) => { setNotice(text); window.setTimeout(() => setNotice(''), 6000); };
  // an edge's two faces, as the Plane on edge dialog lists them
  const edgeFacesOf = (ref: EdgeRefSpec, ends: [Vec3, Vec3] | null): EdgePlaneValues['faces'] => {
    const res = resRef.current, faces = res?.faces ?? [];
    return ref.faces.map((fr, i) => {
      const f = faceOfRef(faces, fr);
      const at = f && ends && res
        ? faceBesideEdge(res.mesh.positions, { ...f, normal: f.normal as Vec3 }, ends[0], ends[1], res.mesh.normals) : null;
      return { ref: fr, center: (f?.center ?? fr.center) as Vec3, normal: (f?.normal ?? fr.normal) as Vec3,
               hint: fr.hint ?? faceLabel(f?.normal ?? fr.normal), index: f?.index ?? -1 - i, at };
    });
  };
  const edgeEnds = (ref: EdgeRefSpec, poly?: [number, number, number][]): [Vec3, Vec3] | null => {
    if (poly && poly.length >= 2) return [poly[0] as Vec3, poly[poly.length - 1] as Vec3];
    if (!ref.direction) return null;
    const h = scale(ref.direction as Vec3, ref.length / 2);
    return [sub(ref.midpoint as Vec3, h), add(ref.midpoint as Vec3, h)];
  };
  const startOffsetPlane = () => {
    const res = resRef.current;
    if (!res) return;
    const f = selRef.current.length === 1 ? res.faces.find((x) => x.index === selRef.current[0]) : undefined;
    const ref = f && f.kind === 'plane' ? refOf(f) : null;
    setPlaneOp({ line: null, own: null, kind: 'offset', v: {
      name: newPlaneName(planeNames), base: ref ? 'face' : 'XY', distance: 10,
      face: ref && f ? { ref, center: f.center as Vec3, normal: f.normal as Vec3, hint: ref.hint ?? faceLabel(f.normal) } : null,
    } });
  };
  const startEdgePlane = () => {
    const res = resRef.current;
    const e = selERef.current.length === 1 ? res?.edges.find((x) => x.index === selERef.current[0]) : undefined;
    if (!res || !e) return;
    if (e.kind !== 'line' || !e.ref) { planeNotice('A plane on an edge goes through a straight edge: pick one'); return; }
    const ends = edgeEnds(e.ref, e.polyline);
    const faces = edgeFacesOf(e.ref, ends);
    if (!ends || !faces.length) { planeNotice('That edge has no face to measure the angle from'); return; }
    setPlaneOp({ line: null, own: null, kind: 'edge', v: {
      name: newPlaneName(planeNames), edge: e.ref, faces, from: 0, angle: 30, a: ends[0], b: ends[1],
    } });
  };
  // a cylindrical face of the build as a tangent plane sees it (null: not a cylinder)
  const cylOf = (f: RunFace): Cylinder | null => {
    const res = resRef.current;
    if (!res || f.kind !== 'cylinder' || !f.axis || !f.axis_point || !f.radius) return null;
    return cylinderOfFace(res.mesh.positions, res.mesh.normals,
                          { start: f.start, count: f.count, axis: f.axis, axis_point: f.axis_point, radius: f.radius },
                          f.ref?.normal);
  };
  const startTangentPlane = () => {
    const res = resRef.current;
    const f = selRef.current.length === 1 ? res?.faces.find((x) => x.index === selRef.current[0]) : undefined;
    if (!res || !f) return;
    if (!cylOf(f) || !f.ref) { planeNotice('A tangent plane touches a cylindrical face: pick one'); return; }
    setTangentAim(f.index);
    setNotice('Click the cylinder where the plane should touch it · Esc cancels');
  };
  // a flat face as a tangent plane's 0°
  // a flat inside the cylinder (a shaft's flat) is "the flat face": "the left
  // face" would name the way it faces, not the side it is on
  const tangentRefFace = (f: RunFace, cyl: Cylinder): TangentPlaneValues['refFace'] => {
    const found = f.kind === 'plane' ? refOf(f) : null;
    if (!found) return null;
    const hint = insideCylinder(f.center as Vec3, cyl) ? 'flat face' : found.hint ?? faceLabel(f.normal);
    return { ref: { ...found, hint }, center: f.center as Vec3, normal: f.normal as Vec3, hint };
  };
  // a plane line reopened: its dialog's values (null: its edge or cylinder isn't found)
  const planeValuesOf = (op: PlaneOpKind, args: Record<string, unknown>, exprs: Record<string, string>):
    ({ kind: 'offset'; v: OffsetPlaneValues } | { kind: 'edge'; v: EdgePlaneValues }
     | { kind: 'tangent'; v: TangentPlaneValues }) | null => {
    const res = resRef.current;
    const name = String(args.name ?? '');
    if (op === 'tangent_plane') {
      const a = args as { face: FaceRefSpec; angle: number; ref: null | 'X' | 'Y' | 'Z' | { face: FaceRefSpec } };
      // the cylinder as the build found it for this plane, else the face if it is there as it was
      const c = res?.planes?.[name]?.cylinder, f = res && !c ? faceOfRef(res.faces, a.face) : null;
      const cyl: Cylinder | null = c ? { start: c.center, axis: c.axis, radius: c.radius, length: c.length, inward: c.inward }
        : f ? cylOf(f) : null;
      if (!cyl) return null;
      let refFace: TangentPlaneValues['refFace'] = null;
      if (a.ref && typeof a.ref === 'object') {
        const rf = res ? faceOfRef(res.faces, a.ref.face) : null, r = a.ref.face;
        refFace = { ref: r, center: (rf?.center ?? r.center) as Vec3, normal: (rf?.normal ?? r.normal) as Vec3,
                    hint: r.hint ?? faceLabel(rf?.normal ?? r.normal) };
      }
      return { kind: 'tangent', v: { name, face: a.face, cyl, ref: !a.ref ? 'auto' : typeof a.ref === 'string' ? a.ref : 'face',
                                     refFace, angle: exprs.angle ?? a.angle } };
    }
    if (op === 'offset_plane') {
      const a = args as { base: BaseName | { face: FaceRefSpec }; distance: number };
      const distance = exprs.distance ?? a.distance;
      if (typeof a.base === 'string') return { kind: 'offset', v: { name, base: a.base, face: null, distance } };
      const ref = a.base.face;
      const f = res ? faceOfRef(res.faces, ref) : null;
      // where the face is now: as found, else back from the plane the build made
      const rep = res?.planes?.[name], d = amountValue(distance, paramVals);
      const center = (f?.center ?? (rep && d !== null ? sub(rep.origin as Vec3, scale(rep.normal as Vec3, d)) : ref.center)) as Vec3;
      const normal = (f?.normal ?? rep?.normal ?? ref.normal) as Vec3;
      return { kind: 'offset', v: { name, base: 'face', distance, face: { ref, center, normal, hint: ref.hint ?? faceLabel(normal) } } };
    }
    const a = args as { edge: EdgeRefSpec; angle: number; from_face?: FaceRefSpec | null };
    const ei = res ? edgeOfRef(res.edges, a.edge) : null;
    const e = ei != null ? res?.edges.find((x) => x.index === ei) : undefined;
    const ends = edgeEnds(a.edge, e?.polyline);
    const { faces, from } = reopenedFromFace(edgeFacesOf(e?.ref ?? a.edge, ends), a.from_face);
    if (!ends || !faces.length) return null;
    return { kind: 'edge', v: { name, edge: a.edge, faces, from, angle: exprs.angle ?? a.angle, a: ends[0], b: ends[1] } };
  };
  // the plane the dialog makes, as typed, and the handle on it
  const planePreview = ((): (PlaneShape & { w?: Vec3; n?: Vec3; mid?: Vec3 }) | null => {
    if (!planeOp) return null;
    const name = planeOp.v.name.trim() || '(new plane)';
    if (planeOp.kind === 'offset') {
      const v = planeOp.v, d = amountValue(v.distance, paramVals);
      const base = v.base === 'face' ? v.face : v.base;
      return d === null || !base ? null : { name, ...offsetPlaneShape(base, d) };
    }
    if (planeOp.kind === 'tangent') {
      const v = planeOp.v, a = amountValue(v.angle, paramVals), z = tangentZero(v.cyl, v.ref, v.refFace);
      return a === null || !z ? null : { name, ...tangentPlaneShape(v.cyl, z, a) };
    }
    const v = planeOp.v, a = amountValue(v.angle, paramVals), f = v.faces[v.from];
    return a === null || !f ? null : { name, ...edgePlaneShape(v.a, v.b, f, a) };
  })();
  const planeH: DragHandle | null = (() => {
    if (!planeOp || !planePreview) return null;
    if (planeOp.kind === 'edge') {
      const { mid, w, n } = planePreview;
      const value = amountValue(planeOp.v.angle, paramVals);
      return mid && w && n && value !== null ? { face: -1, at: mid, shift: n, turn: { w, n }, dr: 0, value, moves: [] } : null;
    }
    if (planeOp.kind === 'tangent') {
      // a ring round the cylinder's axis, its knob just outside the cylinder where the plane touches
      const { mid, w, n } = planePreview;
      const value = amountValue(planeOp.v.angle, paramVals);
      return mid && w && n && value !== null
        ? { face: -1, at: mid, shift: n, dr: 0, value, moves: [],
            turn: { w, n, step: 5, fine: 1, stick: 90, arm: planeOp.v.cyl.radius * 1.4 } } : null;
    }
    const m = resRef.current?.metrics;
    const base = planeOp.v.base === 'face' ? planeOp.v.face : planeOp.v.base;
    const value = amountValue(planeOp.v.distance, paramVals);
    if (!m || !base || value === null) return null;
    const center = scale(add(m.bbox_min as Vec3, m.bbox_max as Vec3), 0.5);
    return { face: -1, at: offsetBasePoint(base, center), shift: planePreview.normal, dr: 0, value, moves: [], snapFaces: true };
  })();
  const planeHKey = planeH ? JSON.stringify(planeH) : '';
  if (planeOp) {
    setEdgeSizeRef.current = (value: number) => setPlaneOp((o) => o && (o.kind === 'offset'
      ? { ...o, v: { ...o.v, distance: Math.round(value * 1000) / 1000 } }
      : o.kind === 'edge' ? { ...o, v: { ...o.v, angle: Math.round(value * 1000) / 1000 } }
      : { ...o, v: { ...o.v, angle: Math.round(value * 2) / 2 } }));
  }
  const applyPlaneOp = async () => {
    const o = planeOp;
    if (!o) return;
    const label = o.kind === 'offset' ? 'Offset plane' : o.kind === 'edge' ? 'Plane on edge' : 'Tangent plane';
    if (amountValue(o.kind === 'offset' ? o.v.distance : o.v.angle, paramVals) === null) return;
    try {
      const payload = o.kind === 'offset' ? offsetPayload(o.v) : o.kind === 'edge' ? edgePayload(o.v) : tangentPayload(o.v);
      const r = await buildApi.addPlane({ ...payload, code: codeRef.current, line: o.line });
      closeOp();
      if (r.renamed && r.renamed !== payload.name) {
        // the sketches on it follow the new name, and so does its show/hide
        const old = r.renamed;
        useDocumentStore.setState((s) => ({
          document: { ...s.document, sketches: renamePlaneRefs(s.document.sketches, old, payload.name) },
        }));
        persistSketches();
        setHiddenPlanes(renameHidden(hiddenPlanes, old, payload.name));
      }
      setCode(r.code);
      const out = await build(r.code, o.line != null ? 'Edit plane' : label);
      if (out.kind === 'ok') saveDraft(r.code);
    } catch (err) {
      setNotice(`${label}: ${errorText(err)}`);
    }
  };
  // ── Mirror: Mirror body writes `part = mirror_body(part, PLANE, join=…)`,
  // Mirror steps one linked `mirrored(...)` copy of each chosen step; both
  // previewed as a ghost, the plane drawn. `line`: a mirror_body() line reopened.
  type MirrorOp = { kind: 'body' | 'steps'; line: number | null; lines: number[]; v: MirrorValues };
  const [mirrorOp, setMirrorOp] = useState<MirrorOp | null>(null);
  // a linked copy reopened: edit its original, or unlink it
  const [copyOp, setCopyOp] = useState<{ line: number; of: number; across: string; original: string } | null>(null);
  const lastMirrorPlane = useRef<MirrorPlane | null>(null);
  const mirrorGap = mirrorOp?.kind === 'body' && !mirrorOp.v.join ? amountValue(mirrorOp.v.gap, paramVals) : 0;
  const mirrorKey = mirrorOp ? JSON.stringify([mirrorOp.kind, mirrorOp.line, mirrorOp.lines, mirrorOp.v.plane, mirrorOp.v.join,
                                               mirrorOp.kind === 'body' && !mirrorOp.v.join ? amountOut(mirrorOp.v.gap) : 0]) : '';
  // Mirror body's preview: the centre of the mirror image's box (which side
  // the gap moves the plane to)
  const [mirrorCopyAt, setMirrorCopyAt] = useState<Vec3 | null>(null);
  const mirrorLine = async (o: MirrorOp, plane: MirrorPlane) => {
    if (o.kind === 'body') {
      if (!o.v.join && amountValue(o.v.gap, paramVals) === null) throw new Error('The gap must be a number or an expression of the parameters');
      return (await buildApi.addMirrorBody({ code: codeRef.current, plane, join: o.v.join, line: o.line,
                                             ...(o.v.join ? {} : { gap: amountOut(o.v.gap) }) })).code;
    }
    const r = await buildApi.mirrorSteps(codeRef.current, o.lines, plane);
    if (!r.made.length) throw new Error(r.skipped[0] ? `Line ${r.skipped[0].line}: ${r.skipped[0].reason}` : 'Nothing to mirror');
    return r.code;
  };
  const mirrorPreview = useOpPreview(
    viewerRef,
    mirrorOp?.v.plane ? () => mirrorLine(mirrorOp, mirrorOp.v.plane!) : null,
    mirrorKey,
    (src, signal) => buildApi.run(src, signal, getBackendId() ?? '', ...runArgs(src)),
    // the mirror image alone, in its own colour (Mirror body)
    mirrorOp?.kind === 'body' ? async (src, signal) => {
      const copy = mirrorCopyScript(src, mirrorOp.line);
      if (!copy) return null;
      const r = await buildApi.run(copy, signal, getBackendId() ?? '', ...runArgs(copy));
      const { bbox_min: a, bbox_max: b } = r.metrics;
      setMirrorCopyAt([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2]);
      return { mesh: r.mesh, color: MIRROR_COPY_COLOR };
    } : undefined,
  );
  // where to mirror across from the selection: one flat face, or one construction plane
  const mirrorPlaneOfSelection = (): { plane: MirrorPlane | null; face: FaceRefSpec | null } => {
    const res = resRef.current;
    const f = selRef.current.length === 1 && !selERef.current.length ? res?.faces.find((x) => x.index === selRef.current[0]) : undefined;
    const ref = f && f.kind === 'plane' ? refOf(f) : null;
    if (ref && f) { const p = facePlane(ref, f.normal); return { plane: p, face: 'face' in p ? p.face : null }; }
    const pl = selectedPlane();
    return { plane: pl ? { plane: pl.name } : null, face: null };
  };
  const startMirrorBody = () => {
    if (!resRef.current) return;
    const { plane, face } = mirrorPlaneOfSelection();
    setMirrorCopyAt(null);
    setMirrorOp({ kind: 'body', line: null, lines: [], v: { plane, join: true, gap: 10, face } });
  };
  const startMirrorSteps = () => {
    if (!resRef.current) return;
    const lines = stepSel.filter((l) => steps.some((s) => s.line === l && !mirrorSkip(s)));
    if (!lines.length) { planeNotice('Choose extrudes, revolves, holes, fillets or chamfers in the steps list first (Ctrl-click for more)'); return; }
    // the steps' own faces and edges light up when chosen: only a plane picked in the view counts
    const pl = selectedPlane();
    const last = lastMirrorPlane.current;
    const plane: MirrorPlane | null = pl ? { plane: pl.name }
      : last && (!('plane' in last) || planeNames.includes(last.plane)) ? last : null;
    setMirrorOp({ kind: 'steps', line: null, lines: [...stepSel].sort((a, b) => a - b), v: {
      plane, join: true, gap: 0, face: plane && 'face' in plane ? plane.face : null } });
  };
  const mirrorRows = mirrorOp?.kind === 'steps'
    ? mirrorOp.lines.flatMap((l) => {
      const st = steps.find((s) => s.line === l);
      return st ? [{ line: l, label: stepLabel(st), reason: mirrorSkip(st) }] : [];
    }) : [];
  const mirrorAfter = mirrorOp?.kind === 'steps'
    ? Math.max(0, ...mirrorRows.filter((r) => !r.reason).map((r) => steps.find((s) => s.line === r.line)?.end_line ?? r.line)) || null
    : null;
  const applyMirror = async () => {
    const o = mirrorOp;
    if (!o?.v.plane) return;
    const label = o.kind === 'body' ? (o.line != null ? 'Edit mirror body' : 'Mirror body') : 'Mirror steps';
    try {
      const src = mirrorPreview.built(mirrorKey) ?? (await mirrorLine(o, o.v.plane));
      lastMirrorPlane.current = o.v.plane;
      closeOp();
      setStepSel([]);
      setCode(src);
      const out = await build(src, label);
      if (out.kind === 'ok') saveDraft(src);
    } catch (err) {
      setNotice(`${label}: ${errorText(err)}`);
    }
  };
  const unlinkCopy = async (line: number, label = 'Unlink mirrored copy') => {
    try {
      const r = await buildApi.unlinkStep(codeRef.current, line);
      closeOp();
      setCode(r.code);
      const out = await build(r.code, label);
      if (out.kind === 'ok') saveDraft(r.code);
    } catch (err) {
      setNotice(`Unlink: ${errorText(err)}`);
    }
  };
  // the mirror plane is drawn while the dialog is open (a face: where it is now)
  const mirrorShape = (() => {
    const p = mirrorOp?.v.plane;
    if (!p) return null;
    const f = 'face' in p ? faceOfRef(resRef.current?.faces ?? [], p.face) : null;
    const shape = mirrorPlaneShape(p, builtPlanes, f ? { center: f.center as Vec3, normal: f.normal as Vec3 } : null);
    if (!shape) return null;
    // Separate with a gap: the plane it mirrors across is moved gap/2 out (a construction plane stays drawn as built)
    if (mirrorGap) {
      const half = +(mirrorGap / 2).toFixed(3);
      return { ...shiftedMirrorShape(shape, mirrorGap, mirrorCopyAt), name: `Mirror · ${'face' in p ? p.face.hint ?? 'face' : shape.name} + ${half} mm` };
    }
    return 'face' in p ? { ...shape, name: `Mirror · ${p.face.hint ?? 'face'}` } : shape;
  })();
  // the face mirrored across shows as selected
  const mirrorFaceKey = mirrorOp ? JSON.stringify(mirrorOp.v.plane) : '';
  useEffect(() => {
    const v = viewerRef.current, p = mirrorOp?.v.plane;
    if (!mirrorOp || !v) return;
    const f = p && 'face' in p ? faceOfRef(resRef.current?.faces ?? [], p.face) : null;
    selRef.current = f ? [f.index] : [];
    setSel(selRef.current);
    v.selectFaces(selRef.current);
    v.selectEdges([]);
    v.selectPlanes(p && 'plane' in p ? [p.plane] : []);
  }, [mirrorFaceKey]);   // eslint-disable-line react-hooks/exhaustive-deps
  // ── Pattern: Pattern body writes `part = pattern_body(part, linear(…) | circular(…),
  // join=…)`, Pattern steps one linked `patterned(...)` copy of each chosen
  // step, and a pattern copy reopened rewrites its group's pattern. The result
  // is the ghost; each instance is drawn as a box and numbered (a number
  // clicked leaves that copy out), with handles for the spacing, the count or
  // the angle. `line`: the line reopened.
  type PatternOp = { kind: 'body' | 'steps' | 'copy'; line: number | null; lines: number[]; v: PatternValues; join: boolean;
                     of?: number; original?: string };
  const [patternOp, setPatternOp] = useState<PatternOp | null>(null);
  // the directions an instance layout was built with: the boxes and handles
  // follow a count or spacing typed at once, a direction changed only once built
  const patternDirKey = (v: PatternValues) => JSON.stringify([v.type, v.dir, v.flip, v.two && v.dir2, v.two && v.flip2, v.axis]);
  // the candidate's pattern lines (its report is filtered to them)
  const patternMade = useRef<{ code: string; lines: number[]; dirs: string } | null>(null);
  const [patternShown, setPatternShown] = useState<{ reports: PatternReport[]; dirs: string } | null>(null);
  const patternKey = patternOp ? JSON.stringify([patternOp.kind, patternOp.line, patternOp.lines, patternSpec(patternOp.v),
                                                  patternOp.join]) : '';
  const patternReady = (v: PatternValues) => instanceCount(v, paramVals) !== null
    && (v.type === 'linear' ? !!v.dir && (!v.two || !!v.dir2) : !!v.axis);
  const patternLine = async (o: PatternOp) => {
    const before = codeRef.current, pattern = patternSpec(o.v);
    let code: string, lines: number[];
    if (o.kind === 'body') {
      code = (await buildApi.addPatternBody({ code: before, pattern, join: o.join, line: o.line })).code;
      const l = patternBodyLine(code, o.line, before);
      lines = l != null ? [l] : [];
    } else if (o.kind === 'steps') {
      const r = await buildApi.patternSteps(before, o.lines, pattern);
      if (!r.made.length) throw new Error(r.skipped[0] ? `Line ${r.skipped[0].line}: ${r.skipped[0].reason}` : 'Nothing to pattern');
      code = r.code;
      lines = r.made.map((m) => m.line);
    } else {
      code = (await buildApi.setPattern(before, o.line!, pattern)).code;
      const grown = code.split('\n').length - before.split('\n').length;   // P keys added above
      lines = o.lines.map((l) => l + grown);
    }
    patternMade.current = { code, lines, dirs: patternDirKey(o.v) };
    return code;
  };
  const patternPreview = useOpPreview(
    viewerRef,
    patternOp && patternReady(patternOp.v) ? () => patternLine(patternOp) : null,
    patternKey,
    async (src, signal) => {
      const r = await buildApi.run(src, signal, getBackendId() ?? '', ...runArgs(src));
      const made = patternMade.current;
      if (made?.code === src) setPatternShown({ reports: reportsOn(r.patterns, made.lines), dirs: made.dirs });
      return r;
    },
  );
  // a body's pattern from the selection: a hole (its cylinder) or a round
  // edge turns round its axis; a straight edge or a flat face goes along it
  const patternOfSelection = (): PatternValues => {
    const res = resRef.current;
    const f = selRef.current.length === 1 && !selERef.current.length ? res?.faces.find((x) => x.index === selRef.current[0]) : undefined;
    const e = selERef.current.length === 1 && !selRef.current.length ? res?.edges.find((x) => x.index === selERef.current[0]) : undefined;
    const d = f ? dirOfFace(f) : e ? dirOfEdge(e) : null;
    const round = f?.kind === 'cylinder' || f?.kind === 'cone' || e?.ref?.kind === 'circle';
    return d && round ? defaultPattern('circular', d) : defaultPattern('linear', d);
  };
  const startPatternBody = () => {
    if (!resRef.current) return;
    setPatternShown(null);
    setPatternOp({ kind: 'body', line: null, lines: [], v: patternOfSelection(), join: true });
  };
  const startPatternSteps = () => {
    if (!resRef.current) return;
    const lines = stepSel.filter((l) => steps.some((s) => s.line === l && !patternSkip(s)));
    if (!lines.length) { planeNotice('Choose extrudes, revolves, holes, fillets or chamfers in the steps list first (Ctrl-click for more)'); return; }
    setPatternShown(null);
    setPatternOp({ kind: 'steps', line: null, lines: [...stepSel].sort((a, b) => a - b), v: defaultPattern('linear'), join: true });
  };
  const patternRows = patternOp?.kind === 'steps'
    ? patternOp.lines.flatMap((l) => {
      const st = steps.find((s) => s.line === l);
      return st ? [{ line: l, label: stepLabel(st), reason: patternSkip(st) }] : [];
    }) : [];
  const patternAfter = patternOp?.kind === 'steps'
    ? Math.max(0, ...patternRows.filter((r) => !r.reason).map((r) => steps.find((s) => s.line === r.line)?.end_line ?? r.line)) || null
    : null;
  const applyPattern = async () => {
    const o = patternOp;
    if (!o || !patternReady(o.v)) return;
    const label = o.kind === 'body' ? (o.line != null ? 'Edit pattern body' : 'Pattern body')
      : o.kind === 'steps' ? 'Pattern steps' : 'Edit pattern';
    try {
      const src = patternPreview.built(patternKey) ?? (await patternLine(o));
      closeOp();
      setStepSel([]);
      setCode(src);
      const out = await build(src, label);
      if (out.kind === 'ok') saveDraft(src);
    } catch (err) {
      setNotice(`${label}: ${errorText(err)}`);
    }
  };
  // the instances as the values say now (the build's layout, moved)
  const patternSame = !!patternOp && !!patternShown && patternShown.dirs === patternDirKey(patternOp.v);
  const patternPlaced = patternOp && patternShown
    ? patternShown.reports.map((r) => placeInstances(r, patternOp.v, paramVals, patternSame)) : [];
  const patternChips = chipPoints(patternPlaced);
  const patternFirst = patternSame ? patternShown!.reports[0] ?? null : null;
  const patternWays = { dir: wayWords(patternFirst?.dir), dir2: wayWords(patternFirst?.dir2), axis: axisWords(patternFirst) };
  const patternMarksKey = JSON.stringify(patternPlaced);
  useEffect(() => {
    const v = viewerRef.current;
    if (!v) return;
    if (!patternPlaced.length) { v.setMarks(null); return; }
    const segs = { original: [] as number[], copy: [] as number[], skipped: [] as number[] };
    for (const list of patternPlaced) {
      for (const i of list) {
        const into = i.index === 0 ? segs.original : i.skip ? segs.skipped : segs.copy;
        into.push(...boxSegments(i.corners, i.skip && i.index !== 0));
      }
    }
    const lines: MarkLines[] = [
      { segments: segs.skipped, color: [0.55, 0.57, 0.62], width: 1.3 },
      { segments: segs.copy, color: [0.3, 0.85, 0.45], width: 1.6 },
      { segments: segs.original, color: [1, 0.62, 0.2], width: 2.4 },
    ];
    v.setMarks({ lines, points: patternChips.map((c) => ({ key: String(c.index), label: String(c.index), point: c.point })) });
  }, [patternMarksKey]);   // eslint-disable-line react-hooks/exhaustive-deps
  // the edge or face a direction was picked from shows as selected
  const patternPicked = patternOp ? (patternOp.v.type === 'circular' ? patternOp.v.axis : patternOp.v[patternOp.v.target]) : null;
  const patternPickKey = patternOp ? JSON.stringify(patternPicked) : '';
  useEffect(() => {
    const v = viewerRef.current, d = patternPicked;
    if (!patternOp || !v) return;
    const f = d && 'face' in d ? faceOfRef(resRef.current?.faces ?? [], d.face) : null;
    const e = d && 'edge' in d ? opEdgeIndex(d.edge) : null;
    selRef.current = f ? [f.index] : [];
    selERef.current = e != null ? [e] : [];
    setSel(selRef.current);
    setSelE(selERef.current);
    v.selectFaces(selRef.current);
    v.selectEdges(selERef.current);
  }, [patternPickKey]);   // eslint-disable-line react-hooks/exhaustive-deps
  // the plane being edited is drawn as the preview, not as built
  const shownPlaneList = shownPlanes(builtPlanes, planeOp?.own ? [...hiddenPlanes, planeOp.own] : hiddenPlanes,
                                     planePreview ?? mirrorShape);
  const shownPlanesKey = JSON.stringify(shownPlaneList);
  useEffect(() => {
    viewerRef.current?.setPlanes(shownPlaneList);
  }, [shownPlanesKey]);   // eslint-disable-line react-hooks/exhaustive-deps
  // with a plane dialog open, the face it goes from (and the edge) show as selected
  const planeSelKey = planeOp ? JSON.stringify(planeOp.kind === 'offset' ? [planeOp.v.base, planeOp.v.face?.ref.center]
    : planeOp.kind === 'tangent' ? [planeOp.v.face.center, planeOp.v.ref, planeOp.v.refFace?.ref.center]
    : [planeOp.v.from, planeOp.v.edge.midpoint]) : '';
  useEffect(() => {
    const v = viewerRef.current, res = resRef.current;
    if (!planeOp || !v || !res) return;
    if (planeOp.kind === 'offset') {
      const f = planeOp.v.base === 'face' && planeOp.v.face ? faceOfRef(res.faces, planeOp.v.face.ref) : null;
      v.selectFaces(f ? [f.index] : []);
      v.selectEdges([]);
    } else if (planeOp.kind === 'tangent') {
      // the cylinder, and the flat face 0° is measured from
      const c = faceOfRef(res.faces, planeOp.v.face) ?? res.faces.find((x) => x.index === selRef.current[0]);
      const r = planeOp.v.ref === 'face' && planeOp.v.refFace ? faceOfRef(res.faces, planeOp.v.refFace.ref) : null;
      v.selectFaces([...(c?.kind === 'cylinder' ? [c.index] : []), ...(r ? [r.index] : [])]);
      v.selectEdges([]);
    } else {
      const f = planeOp.v.faces[planeOp.v.from];
      v.selectFaces(f && f.index >= 0 ? [f.index] : []);
      const ei = edgeOfRef(res.edges, planeOp.v.edge);
      v.selectEdges(ei != null ? [ei] : []);
    }
    v.selectPlanes([]);
  }, [planeSelKey]);   // eslint-disable-line react-hooks/exhaustive-deps

  // the planes' names in the view (placed every frame by onPlaneLabels):
  // clicking one selects the plane, Shift-click adds it; hovering lights it
  const planeLabelEls = useRef(new Map<string, HTMLDivElement>());
  const onPlaneLabels = (labels: PlacedPlaneLabel[]) => {
    const seen = new Set<string>();
    for (const l of labels) {
      const key = l.preview ? '\u0000preview' : l.name;
      const el = planeLabelEls.current.get(key);
      if (!el) continue;
      seen.add(key);
      el.style.display = l.visible ? 'block' : 'none';
      el.style.transform = `translate(${Math.round(l.x) + 4}px, ${Math.round(l.y) - 18}px)`;
    }
    for (const [k, el] of planeLabelEls.current) if (!seen.has(k)) el.style.display = 'none';
  };
  const planeColor = (name: string, preview?: boolean) =>
    preview ? '#5cb8db' : selP.includes(name) ? '#ff9e33' : '#b393f7';
  const planeLabelsView = faceSketch.active ? null : (
    <>
      {shownPlaneList.map((p) => {
        const key = p.preview ? '\u0000preview' : p.name;
        return (
          <div key={key} ref={(el) => { if (el) planeLabelEls.current.set(key, el); else planeLabelEls.current.delete(key); }}
               onClick={p.preview ? undefined : (e) => { e.stopPropagation(); pickPlane(p.name, e.shiftKey); }}
               onMouseEnter={p.preview ? undefined : () => viewerRef.current?.hoverPlane(p.name)}
               onMouseLeave={p.preview ? undefined : () => viewerRef.current?.hoverPlane(null)}
               title={p.preview ? undefined : `${p.name}: click to select (Shift adds)`}
               style={{ position: 'absolute', left: 0, top: 0, display: 'none', padding: '1px 6px', fontSize: '11px',
                        whiteSpace: 'nowrap', borderRadius: '3px', background: 'rgba(20,22,26,0.72)',
                        color: planeColor(p.name, p.preview), border: `1px solid ${planeColor(p.name, p.preview)}55`,
                        cursor: p.preview ? 'default' : 'pointer', pointerEvents: p.preview ? 'none' : 'auto',
                        userSelect: 'none', zIndex: 1 }}>
            {p.name}{p.preview ? ' (preview)' : ''}
          </div>
        );
      })}
      {Object.keys(builtPlanes).length > 0 && (
        <div style={{ position: 'absolute', right: 10, bottom: 30, minWidth: 130, maxWidth: 220, maxHeight: '35%',
                      overflow: 'auto', padding: '4px 0', background: palette.panelBg,
                      border: `1px solid ${palette.border}`, borderRadius: '5px', fontSize: '12px', zIndex: 1,
                      boxShadow: '0 2px 8px rgba(0,0,0,0.25)' }}>
          <div style={{ padding: '0 8px 2px', fontSize: '10px', color: palette.textSecondary, textTransform: 'uppercase',
                        letterSpacing: '0.05em' }}>Planes</div>
          {Object.entries(builtPlanes).map(([name, p]) => {
            const hidden = hiddenPlanes.includes(name);
            const bad = p.status === 'ambiguous';
            return (
              <div key={name} style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '1px 8px',
                                       background: selP.includes(name) ? palette.buttonBg : 'transparent' }}
                   onMouseEnter={() => viewerRef.current?.hoverPlane(name)}
                   onMouseLeave={() => viewerRef.current?.hoverPlane(null)}>
                <button title={hidden ? `Show ${name}` : `Hide ${name}`} aria-label={hidden ? `Show ${name}` : `Hide ${name}`}
                        onClick={() => setHiddenPlanes(hidden ? hiddenPlanes.filter((h) => h !== name) : [...hiddenPlanes, name])}
                        style={{ width: 18, height: 18, padding: 0, border: 'none', background: 'transparent',
                                 cursor: 'pointer', color: hidden ? palette.textSecondary : '#b393f7' }}>
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3">
                    <path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8 12.1 12.5 8 12.5 1.5 8 1.5 8z" />
                    <circle cx="8" cy="8" r="2" />
                    {hidden && <path d="M2.5 13.5l11-11" />}
                  </svg>
                </button>
                <span onClick={(e) => pickPlane(name, e.shiftKey)}
                      title={bad ? `${name}: more than one ${p.kind === 'edge' ? 'edge' : 'face'} matches its reference` : `Select ${name}`}
                      style={{ flex: 1, cursor: 'pointer', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                               color: hidden ? palette.textSecondary : palette.text }}>
                  {name}{bad ? ' ⚠' : ''}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </>
  );

  // Extrude, reopened: the options panel on its line (the sketch isn't
  // entered: "Edit sketch" does that, and Done comes back here)
  const [extrudeOp, setExtrudeOp] = useState<ExtrudeEdit | null>(null);
  const extrudeKey = extrudeOp ? JSON.stringify({ line: extrudeOp.line, v: extrudeOp.v }) : '';
  const extrudeLine = (o: ExtrudeEdit) => buildApi.addExtrude({
    code: codeRef.current, sketch: o.v.sketch, op: o.v.op, depth: o.v.depth, through: o.v.through, flip: o.v.flip,
    both: o.v.both, datum: o.v.datum, line: o.line, extent: o.v.extent, face: o.v.face,
    offset: o.v.extent === 'face' ? o.v.offset : 0, key: o.param,
  });
  const extrudeOk = (o: ExtrudeEdit) => o.v.extent === 'next' ? o.v.op !== 'new'
    : o.v.extent === 'face' ? o.v.op !== 'new' && !!o.v.face && amountValue(o.v.offset, paramVals) !== null
    : (o.v.op === 'cut' && o.v.through) || o.v.depth > 0;
  const extrudePreview = useOpPreview(
    viewerRef,
    extrudeOp && extrudeOk(extrudeOp) ? () => extrudeLine(extrudeOp).then((r) => r.code) : null,
    extrudeKey,
    (src, signal) => buildApi.run(src, signal, getBackendId() ?? '', ...runArgs(src)),
    // Up to face / next: the piece it adds or removes, seen through the part
    // (where a set screw stops inside the hub)
    extrudeOp && (extrudeOp.v.extent === 'next' || extrudeOp.v.extent === 'face') && extrudeOp.v.op !== 'new'
      ? async (src, signal) => {
        const piece = untilPieceScript(src, extrudeOp.line, extrudeOp.v.op === 'cut' ? 'cut' : 'join');
        if (!piece) return null;
        const r = await buildApi.run(piece, signal, getBackendId() ?? '', ...runArgs(piece));
        return { mesh: r.mesh, color: UNTIL_PIECE_COLOR, xray: true };
      } : undefined,
  );
  const extrudeSketch = extrudeOp ? docSketches.find((sk) => sk.name === extrudeOp.v.sketch) ?? null : null;
  const extrudeNormal = (extrudeOp && (resRef.current?.sketches?.[extrudeOp.v.sketch]?.plane?.normal
    ?? extrudeSketch?.plane?.normal)) as Vec3 | undefined;
  const extrudeOrigin = (extrudeOp && (resRef.current?.sketches?.[extrudeOp.v.sketch]?.plane?.origin
    ?? extrudeSketch?.plane?.origin)) as Vec3 | undefined;
  const partBox = resRef.current?.metrics;
  const extrudePartAt = extrudeNormal && extrudeOrigin && partBox && !extrudeOp?.firstBody
    ? partSide(extrudeOrigin, extrudeNormal, partBox.bbox_min, partBox.bbox_max) : undefined;
  const applyExtrude = async () => {
    const o = extrudeOp;
    if (!o || !extrudeOk(o)) return;
    try {
      const src = extrudePreview.built(extrudeKey) ?? (await extrudeLine(o)).code;
      closeOp();
      setCode(src);
      const out = await build(src, o.line != null ? `Edit extrude ${o.v.sketch}`
        : `${o.v.op === 'cut' ? 'Cut' : 'Join'} ${o.v.sketch} up to ${o.v.extent === 'next' ? 'next' : 'face'}`);
      if (out.kind === 'ok') saveDraft(src);
    } catch (err) {
      setNotice(`Extrude: ${errorText(err)}`);
    }
  };
  const editExtrudeSketch = () => {
    const o = extrudeOp;
    if (!o) return;
    if (!extrudeSketch) {
      setNotice(`There is no sketch named “${o.v.sketch}” to edit`);
      window.setTimeout(() => setNotice(''), 6000);
      return;
    }
    sketchBackRef.current = o;
    closeOp();
    faceSketchRef.current.open(extrudeSketch.id);
  };

  // Revolve: a sketch's closed shapes turned round an axis — new (Operations,
  // or the sketcher's Revolve…) or reopened on its line. The build's report on
  // it (where the axis is, where the shapes cross it) places the angle handle
  // and marks a crossing.
  const [revolveOp, setRevolveOp] = useState<RevolveEdit | null>(null);
  const revolveBackRef = useRef<RevolveEdit | null>(null);   // "Edit sketch": the dialog again on Done
  const revolveKey = revolveOp ? JSON.stringify({ line: revolveOp.line, v: revolveOp.v }) : '';
  const revolveKeyRef = useRef(revolveKey);
  revolveKeyRef.current = revolveKey;
  const [revolveRep, setRevolveRep] = useState<{ key: string; r: RevolveReport | null } | null>(null);
  const revolveSk = revolveOp ? docSketches.find((sk) => sk.name === revolveOp.v.sketch) ?? null : null;
  const revolveChoices = useMemo(() => (revolveSk ? axisChoices(revolveSk) : []), [revolveSk]);
  const revolveAxis = revolveOp?.v.axis ?? null;
  // a line of the sketch is checked here at once; the others by the build
  const revolveLocal = revolveSk && revolveAxis && 'line' in revolveAxis ? lineProblem(revolveSk, revolveAxis.line) : null;
  const revolveAngle = revolveOp ? amountValue(revolveOp.v.angle, paramVals) : null;
  const revolveReady = !!revolveSk && !!revolveAxis && !revolveLocal && revolveAngle !== null && revolveAngle > 0 && revolveAngle <= 360;
  const revolveLine = (o: RevolveEdit) => buildApi.addRevolve({
    // New body starts the script over when it is still the unbuilt starter
    code: o.v.op === 'new' && codeRef.current === STARTER ? '' : codeRef.current,
    sketch: o.v.sketch, op: o.v.op, axis: o.v.axis!, angle: amountOut(o.v.angle), both: o.v.both, flip: o.v.flip, line: o.line,
  });
  const revolvePreview = useOpPreview(
    viewerRef,
    revolveOp && revolveReady ? () => revolveLine(revolveOp).then((r) => r.code) : null,
    revolveKey,
    (src, signal) => {
      const key = revolveKeyRef.current, line = revolveOp?.line ?? null;
      // a reopened line moves down by the lines written above it (a new P key)
      const grown = src.split('\n').length - codeRef.current.split('\n').length;
      const keep = (r: Pick<RunResponse, 'revolves'>) => setRevolveRep({ key, r: revolveReport(r, line, grown) });
      return buildApi.run(src, signal, getBackendId() ?? '', ...runArgs(src)).then(
        (r) => { keep(r); return r; },
        (err: unknown) => { if (err instanceof ApiError && err.revolves) keep(err); throw err; },
      );
    },
  );
  const revolveNow = revolveRep && revolveRep.key === revolveKey ? revolveRep.r : null;
  const revolveErr = revolveNow?.error ? revolveNow.error.charAt(0).toUpperCase() + revolveNow.error.slice(1) : null;
  const revolveProblem = !revolveOp ? null
    : !revolveSk ? `There is no sketch named “${revolveOp.v.sketch}”`
    : !revolveAxis ? 'Pick an axis: a line of the sketch, X / Y / Z, or click a straight edge or a cylinder in the view'
    : revolveLocal?.message ?? revolveErr;
  const revolvePlane = revolveSk ? boundPlane(revolveSk, resRef.current?.sketches, resRef.current?.planes) : null;
  // the dialog's drawing: the shapes, the axis, the crossings, in the sketch's coordinates
  const revolveView = useMemo((): RevolveSketchView => {
    if (!revolveSk) return { loops: [], axis: null, crossings: [] };
    const loops = sketchLoops(revolveSk).loops.map((l) => l.flatMap((seg, i) => segmentPoints(seg).slice(i ? 1 : 0)));
    const on = revolveAxis && 'line' in revolveAxis ? revolveChoices.find((c) => c.id === revolveAxis.line) : undefined;
    const b = revolvePlane ? planeBasis(revolvePlane) : null;
    const flat = (w: number[]) => { const q = worldToSketch(b!, w as Vec3); return [q.x, q.y] as [number, number]; };
    const r = revolveNow;
    const axis: [[number, number], [number, number]] | null = on ? [on.a, on.b]
      : r && b ? [flat(r.origin), flat(add(r.origin as Vec3, r.axis as Vec3))] : null;
    const crossings = revolveLocal ? revolveLocal.crossings : r?.crossings && b ? r.crossings.map(flat) : [];
    return { loops, axis, crossings };
  }, [revolveSk, revolveAxis, revolveChoices, revolvePlane, revolveNow, revolveLocal]);
  const revolveNormal = (revolveOp && (resRef.current?.sketches?.[revolveOp.v.sketch]?.plane?.normal
    ?? revolveSk?.plane?.normal)) as Vec3 | undefined;
  // the angle handle: on the axis level with the shapes, from the last build's report
  const revolveH = revolveOp && !revolveProblem ? revolveHandle(revolveRep?.r ?? null, revolveAngle) : null;
  const revolveDH: DragHandle | null = revolveH
    ? { face: -1, at: revolveH.at, shift: revolveH.n, dr: 0, value: revolveH.value, moves: [],
        turn: { w: revolveH.w, n: revolveH.n, step: 15, fine: 1, arm: revolveH.arm } } : null;
  const revolveHKey = revolveDH ? JSON.stringify(revolveDH) : '';
  if (revolveOp) {
    setEdgeSizeRef.current = (value: number) =>
      setRevolveOp((o) => o && ({ ...o, v: { ...o.v, angle: angleFromHandle(value, o.v.both) } }));
  }
  const applyRevolve = async () => {
    const o = revolveOp;
    if (!o || !revolveReady || revolveProblem) return;
    try {
      const src = revolvePreview.built(revolveKey) ?? (await revolveLine(o)).code;
      closeOp();
      setCode(src);
      const out = await build(src, `${o.line != null ? 'Edit revolve' : 'Revolve'} ${o.v.sketch}`);
      if (out.kind === 'ok') saveDraft(src);
    } catch (err) {
      setNotice(`Revolve: ${errorText(err)}`);
    }
  };
  const editRevolveSketch = () => {
    const o = revolveOp;
    if (!o) return;
    if (!revolveSk) { planeNotice(`There is no sketch named “${o.v.sketch}” to edit`); return; }
    revolveBackRef.current = o;
    closeOp();
    faceSketchRef.current.open(revolveSk.id);
  };
  // a new revolve: on the active sketch if it can be turned, else the first that can
  const startRevolve = () => {
    const sks = revolvable(docSketches);
    if (!sks.length) return;
    const active = useDocumentStore.getState().document.activeSketchId;
    const sk = sks.find((x) => x.id === active) ?? sks[0]!;
    const firstBody = !hasPartRef.current;
    if (opOpen) closeOp();
    setRevolveOp({ line: null, firstBody,
                   v: { sketch: sk.name, op: firstBody ? 'new' : 'join', axis: defaultAxis(sk), angle: 360, both: false, flip: false } });
  };
  // another sketch picked in the dialog: its own default axis if the line isn't in it
  const changeRevolve = (v: RevolveValues) => setRevolveOp((o) => {
    if (!o) return o;
    if (v.sketch !== o.v.sketch) {
      const sk = docSketches.find((x) => x.name === v.sketch);
      if (sk && (!v.axis || ('line' in v.axis && !axisChoices(sk).some((c) => c.id === (v.axis as { line: string }).line)))) {
        return { ...o, v: { ...v, axis: defaultAxis(sk) } };
      }
    }
    return { ...o, v };
  });

  // Round (auto_round) and Lighten (truss_windows), reopened: their arguments
  // in a dialog; OK rewrites just those (and the P keys they're in)
  const [argOp, setArgOp] = useState<{ line: number; end: number; v: ArgOpValues; orig: ArgOpValues } | null>(null);
  const argKey = argOp ? JSON.stringify({ line: argOp.line, v: argOp.v }) : '';
  const argLine = (o: { line: number; v: ArgOpValues; orig: ArgOpValues }) =>
    buildApi.editArgs({ code: codeRef.current, line: o.line, op: o.v.op, ...argOpPayload(o.v, o.orig) });
  const argPreview = useOpPreview(
    viewerRef,
    argOp ? () => argLine(argOp).then((r) => r.code) : null,
    argKey,
    (src, signal) => buildApi.run(src, signal, getBackendId() ?? '', ...runArgs(src)),
  );
  const applyArgOp = async () => {
    const o = argOp;
    if (!o) return;
    const name = o.v.op === 'auto_round' ? 'round' : 'lighten';
    try {
      const src = argPreview.built(argKey) ?? (await argLine(o)).code;
      closeOp();
      setCode(src);
      const out = await build(src, `Edit ${name}`);
      if (out.kind === 'ok') saveDraft(src);
    } catch (err) {
      setNotice(`${name === 'round' ? 'Round' : 'Lighten'}: ${errorText(err)}`);
    }
  };
  // a kept face's faces on the part as shown: the build's report for that
  // item of the line, or where its face_ref is now (one added in the dialog)
  const keepFaces = (k: KeepItem & { item?: number }): number[] => {
    const res = resRef.current;
    if (!res || !argOp) return [];
    const rep = k.item != null
      ? res.kept?.find((x) => x.line != null && x.line >= argOp.line && x.line <= argOp.end && x.item === k.item) : undefined;
    const refs = rep ? rep.faces : k.ref ? [k.ref] : [];
    return refs.map((r) => faceOfRef(res.faces, r)?.index).filter((i): i is number => i != null);
  };
  // the face selected in the view, offered to the Round dialog's kept list
  const roundPick = (() => {
    if (argOp?.v.op !== 'auto_round' || sel.length !== 1) return null;
    const f = resRef.current?.faces.find((x) => x.index === sel[0]);
    return f ? refOf(f) : null;
  })();

  // while the Shell dialog is open, clicking a face opens or closes it, and
  // the faces it opens show as selected; in the Hole dialog it says where the
  // holes go
  opPickRef.current = extrudeOp?.v.extent === 'face' ? (p) => {
    // Up to face: the face it runs to (any face: flat, slanted, round)
    const face = p && 'face' in p ? resRef.current?.faces.find((x) => x.index === p.face.index) : undefined;
    const r = face ? refOf(face) : null;
    if (r) setExtrudeOp((o) => o && ({ ...o, v: { ...o.v, face: r } }));
  } : revolveOp ? (p) => {
    // the axis: along a straight edge, or a cylinder's centre line
    const res = resRef.current;
    if (!p || !res) return;
    const face = 'face' in p ? res.faces.find((x) => x.index === p.face.index) : undefined;
    const edge = 'edge' in p ? res.edges.find((x) => x.index === p.edge) : undefined;
    const d = face && (face.kind === 'cylinder' || face.kind === 'cone') ? dirOfFace(face)
      : edge?.ref?.kind === 'line' ? dirOfEdge(edge) : null;
    if (d) setRevolveOp((o) => o && ({ ...o, v: { ...o.v, axis: d } }));
    else if (face || edge) planeNotice('Revolve round a straight edge or a cylinder (its centre line): pick one of those');
  } : patternOp ? (p) => {
    // a direction (or the axis): a straight edge, a flat face's normal, a hole's or round edge's axis
    const res = resRef.current;
    if (!p || !res) return;
    const face = 'face' in p ? res.faces.find((x) => x.index === p.face.index) : undefined;
    const edge = 'edge' in p ? res.edges.find((x) => x.index === p.edge) : undefined;
    const d = face ? dirOfFace(face) : edge ? dirOfEdge(edge) : null;
    if (!d) {
      if (face || edge) planeNotice('Pick a straight or round edge, a flat face (its normal) or a hole (its axis)');
      return;
    }
    setPatternOp((o) => o && ({ ...o, v: o.v.type === 'circular' ? { ...o.v, axis: d } : { ...o.v, [o.v.target]: d } }));
  } : mirrorOp ? (p) => {
    const face = p && 'face' in p ? resRef.current?.faces.find((x) => x.index === p.face.index) : undefined;
    if (!face) return;
    const ref = face.kind === 'plane' ? refOf(face) : null;
    if (!ref) { planeNotice('Mirror across a flat face: pick a flat one'); return; }
    const pl = facePlane(ref, face.normal);
    setMirrorOp((o) => o && ({ ...o, v: { ...o.v, plane: pl, face: 'face' in pl ? pl.face : null } }));
  } : tangentAim != null ? (p) => {
    // Tangent plane: the click on the cylinder says where it touches
    const f = resRef.current?.faces.find((x) => x.index === tangentAim);
    const cyl = f ? cylOf(f) : null, ref = f ? refOf(f) : null;
    if (!p || !('face' in p) || p.face.index !== tangentAim || !p.point || !cyl || !ref) {
      setNotice('Click on the selected cylinder, where the plane should touch it · Esc cancels');
      return;
    }
    setTangentAim(null);
    setNotice('');
    setPlaneOp({ line: null, own: null, kind: 'tangent', v: {
      name: newPlaneName(planeNames), face: ref, cyl, ref: 'auto', refFace: null,
      angle: clickAngle(p.point, cyl, tangentZero(cyl, 'auto') ?? [1, 0, 0]),
    } });
  } : planeOp ? (p) => {
    const face = p && 'face' in p ? resRef.current?.faces.find((x) => x.index === p.face.index) : undefined;
    if (!face) return;
    if (planeOp.kind === 'tangent') {
      const v = planeOp.v;
      if (face.kind === 'plane') {
        // a flat face: 0° is toward it
        const refFace = tangentRefFace(face, v.cyl);
        if (refFace) setPlaneOp((o) => o && o.kind === 'tangent' ? { ...o, v: { ...o.v, ref: 'face', refFace } } : o);
        return;
      }
      // the cylinder itself: the plane touches it there
      const z = tangentZero(v.cyl, v.ref, v.refFace), own = faceOfRef(resRef.current?.faces ?? [], v.face);
      if (z && p && 'face' in p && p.point && (own ? own.index === face.index : face.kind === 'cylinder')) {
        const angle = clickAngle(p.point, v.cyl, z);
        setPlaneOp((o) => o && o.kind === 'tangent' ? { ...o, v: { ...o.v, angle } } : o);
      } else planeNotice('Click the cylinder to move the plane there, or a flat face to measure from it');
      return;
    }
    if (planeOp.kind === 'edge') {
      // one of the edge's two faces: it is 0°
      const i = planeOp.v.faces.findIndex((f) => f.index === face.index);
      if (i >= 0) setPlaneOp((o) => o && o.kind === 'edge' ? { ...o, v: { ...o.v, from: i } } : o);
      return;
    }
    const ref = face.kind === 'plane' ? refOf(face) : null;
    if (!ref) { setNotice('An offset plane goes from a flat face: pick a flat one'); window.setTimeout(() => setNotice(''), 5000); return; }
    setPlaneOp((o) => o && o.kind === 'offset' ? { ...o, v: { ...o.v, base: 'face', face: {
      ref, center: face.center as Vec3, normal: face.normal as Vec3, hint: ref.hint ?? faceLabel(face.normal) } } } : o);
  } : edgeOp?.mirrored ? null : edgeOp ? (p) => {
    const r = p && 'edge' in p ? resRef.current?.edges.find((e) => e.index === p.edge)?.ref : null;
    if (!r) return;
    setEdgeOp((o) => o && ({ ...o, v: { ...o.v, edges: toggleEdge(o.v.edges, r) } }));
  } : holeOp ? (p) => {
    const face = p && 'face' in p ? resRef.current?.faces.find((x) => x.index === p.face.index) : undefined;
    if (!face || face.kind !== 'plane') {
      if (face) { setNotice('Holes go on a flat face: pick a flat one'); window.setTimeout(() => setNotice(''), 5000); }
      return;
    }
    const picked = holeAt(face);
    if (!picked) return;
    if (picked.face) setHoleFace(picked.face);
    setHoleOp((o) => o && ({ ...o, v: { ...o.v, at: picked.at } }));
  } : shellOp ? (p) => {
    const face = p && 'face' in p ? resRef.current?.faces.find((x) => x.index === p.face.index) : undefined;
    const r = face ? refOf(face) : null;
    if (!r) return;
    setShellOp((o) => o && ({ ...o, v: { ...o.v, remove: o.v.remove.some((x) => sameRef(x, r))
      ? o.v.remove.filter((x) => !sameRef(x, r)) : [...o.v.remove, r] } }));
  } : null;
  // a double-clicked loop or chain goes into the Fillet / Chamfer list
  opEdgesRef.current = edgeOp && !edgeOp.mirrored ? (list) => {
    const res = resRef.current;
    const refs = list.map((i) => res?.edges.find((e) => e.index === i)?.ref).filter((r): r is EdgeRefSpec => !!r);
    setEdgeOp((o) => o && ({ ...o, v: { ...o.v, edges: addEdges(o.v.edges, refs) } }));
  } : null;
  const opFaceIndex = (r: FaceRefSpec) => faceOfRef(resRef.current?.faces ?? [], r)?.index ?? null;
  facePickingRef.current = extrudeOp?.v.extent === 'face';
  // Up to face: the picked face shows as selected
  const extrudeFace = extrudeOp?.v.extent === 'face' ? extrudeOp.v.face : null;
  const extrudeFaceKey = extrudeOp ? JSON.stringify(extrudeFace) : '';
  useEffect(() => {
    if (!extrudeOp) return;
    const i = extrudeFace ? opFaceIndex(extrudeFace) : null;
    const idx = i != null ? [i] : [];
    selRef.current = idx;
    setSel(idx);
    viewerRef.current?.selectFaces(idx);
  }, [extrudeFaceKey]);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!shellOp) return;
    const idx = shellOp.v.remove.map(opFaceIndex).filter((i): i is number => i != null);
    selRef.current = idx;
    setSel(idx);
    viewerRef.current?.selectFaces(idx);
  }, [shellKey]);   // eslint-disable-line react-hooks/exhaustive-deps
  // the face the holes are centred on shows as selected
  useEffect(() => {
    if (!holeOp) return;
    const i = 'face' in holeOp.v.at ? opFaceIndex(holeOp.v.at.face) : null;
    const idx = i != null ? [i] : [];
    selRef.current = idx;
    setSel(idx);
    viewerRef.current?.selectFaces(idx);
  }, [holeKey]);   // eslint-disable-line react-hooks/exhaustive-deps
  // the edges a Fillet / Chamfer line names show as selected (those on the part as shown)
  useEffect(() => {
    if (!edgeOp) return;
    // a mirrored copy's edges are the original's: they aren't lit
    const idx = edgeOp.mirrored ? [] : edgeOp.v.edges.map(opEdgeIndex).filter((i): i is number => i != null);
    selRef.current = [];
    selERef.current = idx;
    setSel([]);
    setSelE(idx);
    viewerRef.current?.selectFaces([]);
    viewerRef.current?.selectEdges(idx);
  }, [edgeKey]);   // eslint-disable-line react-hooks/exhaustive-deps
  const opOpen = !!shellOp || !!holeOp || !!edgeOp || !!extrudeOp || !!revolveOp || !!argOp || !!planeOp || tangentAim != null || !!mirrorOp || !!copyOp || !!patternOp;
  // Shell, Hole and Round work on faces: while one is open a click picks faces
  // only; Fillet and Chamfer, edges only; Pattern takes either, as the filter says
  const viewFilter: PickFilter = patternOp || revolveOp ? pickFilter : shellOp || holeOp || planeOp || extrudeOp?.v.extent === 'face' || tangentAim != null || mirrorOp || argOp?.v.op === 'auto_round' ? 'faces' : edgeOp ? 'edges'
    : pickFilter;
  useEffect(() => { viewerRef.current?.setPickFilter(viewFilter); }, [viewFilter]);
  // the dialogs sit at the top left of the view: draw the part beside them
  const opWidth = holeOp || argOp || planeOp || mirrorOp || patternOp || revolveOp ? 300 : shellOp || edgeOp || extrudeOp || copyOp ? 270 : 0;
  useEffect(() => {
    viewerRef.current?.setInset(opWidth ? opWidth + 24 : 0);
  }, [opWidth]);

  // Reopen an operation's line: its dialog with the line's values.
  const editOp = async (line: number) => {
    try {
      const op = await buildApi.opAt(codeRef.current, line, stepIn.datum);
      if (opOpen) closeOp();
      if (op.pattern?.of != null) {
        // a pattern copy: its pattern (all the copies made with it), or its original
        const orig = steps.find((s) => s.line === op.pattern!.of);
        setPatternShown(null);
        setPatternOp({ kind: 'copy', line: op.line, lines: op.pattern.lines, join: true, of: op.pattern.of,
                       v: patternValues(op.pattern.args, op.pattern.exprs),
                       original: orig ? stepLabel(orig) : `line ${op.pattern.of}` });
      } else if (op.op === 'pattern_body') {
        const a = op.args as { pattern: PatternSpec; join: boolean };
        setPatternShown(null);
        setPatternOp({ kind: 'body', line: op.line, lines: [], v: patternValues(a.pattern, op.exprs ?? {}), join: a.join !== false });
      } else if (op.mirror?.of != null) {
        // a linked copy follows its original: edit that, or unlink it
        const orig = steps.find((s) => s.line === op.mirror!.of);
        setCopyOp({ line: op.line, of: op.mirror.of, across: op.mirror.label,
                    original: orig ? stepLabel(orig) : `line ${op.mirror.of}` });
      } else if (op.op === 'mirror_body') {
        const a = op.args as { plane: MirrorPlane; join: boolean; gap?: number };
        const join = a.join !== false;
        // joined: the gap Separate would start from
        const gap: Amount = join ? 10 : op.exprs?.gap ?? a.gap ?? 0;
        setMirrorCopyAt(null);
        setMirrorOp({ kind: 'body', line: op.line, lines: [],
                      v: { plane: a.plane, join, gap, face: 'face' in a.plane ? a.plane.face : null } });
      } else if (op.op === 'extrude') {
        const a = op.args as { sketch: string; op: ExtrudeOp; extent?: ExtrudeExtent; depth: number | null; through: boolean;
                               flip: boolean; both: boolean; datum: boolean; face?: FaceRefSpec | null; offset?: number };
        setExtrudeOp({
          line: op.line, firstBody: a.op === 'new', param: op.params.depth ?? null,
          v: { sketch: a.sketch, op: a.op, extent: a.extent ?? (a.through ? 'through' : 'distance'), depth: a.depth ?? 5,
               through: a.through, flip: a.flip, both: a.both, datum: a.datum, face: a.face ?? null,
               offset: op.exprs?.offset ?? a.offset ?? 0 },
        });
      } else if (op.op === 'revolve') {
        const a = op.args as { sketch: string; op: ExtrudeOp; axis: RevolveValues['axis']; angle: number; both: boolean; flip: boolean };
        setRevolveOp({
          line: op.line, firstBody: a.op === 'new',
          v: { sketch: a.sketch, op: a.op, axis: a.axis, angle: op.exprs?.angle ?? a.angle, both: !!a.both, flip: !!a.flip },
        });
      } else if (op.op === 'auto_round' || op.op === 'truss_windows') {
        const { keep, ...values } = op.args as Record<string, number | boolean | string> & { keep?: unknown };
        const v: ArgOpValues = {
          op: op.op, values,
          keep: op.op === 'auto_round' && Array.isArray(keep)
            ? (keep as KeepItem[]).map((k, item) => ({ src: k.src, ref: k.ref ?? undefined, item })) : null,
          params: op.params, exprs: op.exprs ?? {}, make: [],
        };
        if (op.op === 'auto_round') applySelection([]);
        setArgOp({ line: op.line, end: op.end_line, v, orig: v });
      } else if (op.op === 'offset_plane' || op.op === 'edge_plane' || op.op === 'tangent_plane') {
        const p = planeValuesOf(op.op, op.args, op.exprs ?? {});
        if (!p) throw new Error(`the ${op.op === 'edge_plane' ? 'edge' : 'cylinder'} this plane is on isn't on the part as built`);
        setPlaneOp({ line: op.line, own: (op.args as { name: string }).name, ...p });
      } else if (op.op === 'shell') {
        const a = op.args as { remove?: FaceRefSpec[]; thickness?: number; inside?: boolean };
        setShellOp({ line: op.line, v: { remove: a.remove ?? [], thickness: Number(a.thickness ?? 2), inside: a.inside !== false } });
      } else if (op.op === 'holes') {
        const p = await loadHolePresets();
        const v = holeValuesOf(op.args, p);
        if ('face' in v.at) {
          const r = v.at.face;
          const shown = faceOfRef(resRef.current?.faces ?? [], r);
          setHoleFace({ ref: r, normal: (shown?.normal ?? r.normal) as [number, number, number] });
        } else setHoleFace(null);
        setHoleOp({ line: op.line, v });
      } else if (op.op === 'fillet' || op.op === 'chamfer') {
        const a = op.args as { edges?: EdgeRefSpec[]; size?: number };
        const edges = a.edges ?? [];
        const adds = selectedEdgeRefs();
        // the build's lookups from this line, in the order of its edges
        const found = (resRef.current?.edge_refs ?? [])
          .filter((x) => x.line != null && x.line >= op.line && x.line <= op.end_line);
        const now = edges.flatMap((ref, i): EdgeNow[] => {
          const f = found[i];
          return f?.length != null && f.midpoint
            ? [{ ref, length: f.length, midpoint: f.midpoint, radius: f.radius ?? undefined }] : [];
        });
        setEdgeOp({ op: op.op, line: op.line, v: { edges, size: Number(a.size ?? 1) }, adds: op.mirror ? [] : adds,
                    now: op.mirror ? [] : now, mirrored: op.mirror?.label });
      }
    } catch (err) {
      setNotice(`Can't edit line ${line}: ${errorText(err)}`);
      window.setTimeout(() => setNotice(''), 8000);
    }
  };
  // the script line the caret is on, when it's an operation the dialogs reopen
  const [caretLine, setCaretLine] = useState(0);
  const caretStep = reopenableAt(steps, caretLine);
  const caretOp = caretStep?.op && caretStep.op !== 'script' ? caretStep.op : null;
  const trackCaret = () => {
    const ta = taRef.current;
    if (ta) setCaretLine(ta.value.slice(0, ta.selectionStart).split('\n').length);
  };

  // a step clicked in the list: its lines selected in the code, and its
  // faces, edges or sketch lit in the view
  const selectStep = (clicked: Step, mode: 'only' | 'toggle' | 'range' = 'only', order: number[] = []) => {
    const next = nextStepSelection(stepSel, order, clicked.line, stepAnchor.current, mode);
    if (mode !== 'range') stepAnchor.current = clicked.line;
    setStepSel(next);
    const st = next.length === 1 ? steps.find((s) => s.line === next[0]) : undefined;
    if (!st) {
      // several chosen (for Mirror steps), or none: none of them lit in the view
      if (!opOpen) applySelection([]);
      return;
    }
    const ta = taRef.current;
    if (ta) {
      const lines = ta.value.split('\n');
      const at = (n: number) => lines.slice(0, n).reduce((k, l) => k + l.length + 1, 0);
      const start = at(st.line - 1);
      ta.setSelectionRange(start, Math.max(start, at(st.end_line) - 1));
      ta.scrollTop = Math.max(0, (st.line - 1) * 19.5 - ta.clientHeight / 3);
      syncScroll();
      setCaretLine(st.line);
    }
    const res = resRef.current;
    if (opOpen || !res) return;   // an open dialog has the selection
    if (st.plane && res.planes?.[st.plane]) { applySelection([], [], [st.plane]); return; }
    const faces = st.faces.map((r) => faceOfRef(res.faces, r)?.index).filter((i): i is number => i != null);
    const edges = st.edges.map((r) => edgeOfRef(res.edges, r)).filter((i): i is number => i != null);
    applySelection(faces, edges);
    if (!faces.length && !edges.length && st.sketch) {
      const sk = docSketches.find((x) => x.name === st.sketch);
      if (sk?.plane) viewerRef.current?.highlightEdges(sketchSegments(sk, boundPlane(sk, res.sketches)));
    }
  };
  // switch a step off or on, or delete it: the script changes, and rebuilds
  const changeStep = async (st: Step, what: 'off' | 'on' | 'delete', copies?: 'keep' | 'delete' | 'with') => {
    if (stepBusy) return;
    setStepBusy(true);
    try {
      if (opOpen) closeOp();
      const r = what === 'delete' ? await buildApi.deleteStep(codeRef.current, st.line, copies === 'with' ? undefined : copies)
        : await buildApi.suppressStep(codeRef.current, st.line, what === 'off', copies === 'with');
      setStepSel([]);
      setCode(r.code);
      const name = st.summary ?? `line ${st.line}`;
      const out = await build(r.code, `${what === 'delete' ? 'Delete' : what === 'off' ? 'Switch off' : 'Switch on'} ${name}`);
      // kept even when later steps now fail: the list says why, and switching it back on undoes it
      if (out.kind !== 'aborted') saveDraft(r.code);
    } catch (err) {
      setNotice(`Step: ${errorText(err)}`);
      window.setTimeout(() => setNotice(''), 8000);
    } finally {
      setStepBusy(false);
    }
  };
  // the build's problems, each on the step that caused it
  const failure = status === 'done' ? warn : status === 'error' ? message : '';
  const problems = stepProblems(steps, resRef.current, failure);
  const offNote = suppressedNote(steps, messageLine(failure));

  // the viewer keeps its mount-time callbacks, so a drop reaches the current
  // applyParam (which closes over the current code) through a ref
  const applyParamRef = useRef(applyParam);
  applyParamRef.current = applyParam;

  // Direct manipulation: with exactly one face selected, a drag handle for a
  // param that moves it (sensitivity `shifts`) — the one moving it most along
  // its normal first; Tab cycles when several do. Releasing goes through
  // applyParam (set_params → rebuild → version), never the AI.
  const selFace = sel.length === 1 && !opOpen ? resRef.current?.faces.find((f) => f.index === sel[0]) ?? null : null;
  const handleOpts = useMemo(() => (selFace ? handleOptions(selFace, sens) : []), [selFace, sens]);
  // with Pattern open: the spacing (or extent) on the last copy, the count
  // past it, or the angle — picked by name, so one dragged stays the one
  // dragged when the list changes under it (a count going from 1 to 2)
  const patHs = patternOp && patternSame ? patternHandles(patternFirst, patternOp.v, paramVals) : [];
  const [patPick, setPatPick] = useState('');
  const handleKey = patternOp ? `pattern|${patHs.map((h) => h.name).join()}` : `${sel.join()}|${handleOpts.map((h) => h.name).join()}`;
  const [handlePick, setHandlePick] = useState({ key: '', i: 0 });
  const nHandles = patternOp ? patHs.length : handleOpts.length;
  const hi = nHandles ? ((((handlePick.key === handleKey ? handlePick.i : 0) % nHandles) + nHandles) % nHandles) : 0;
  const faceHandle = nHandles && !patternOp ? handleOpts[hi]! : null;
  const patH = patHs.find((h) => h.name === patPick) ?? patHs[0] ?? null;
  const patHKey = patH ? JSON.stringify(patH) : '';
  const patNamesRef = useRef<string[]>([]);
  patNamesRef.current = patHs.map((h) => h.name);
  const patHNameRef = useRef('');
  patHNameRef.current = patH?.name ?? '';
  if (patternOp) {
    setEdgeSizeRef.current = (value: number) => {
      const name = patHNameRef.current;
      setPatPick(name);
      setPatternOp((o) => {
        if (!o) return o;
        const r3 = Math.round(value * 1000) / 1000;
        const next: PatternValues = { ...o.v, ...(name === 'count' ? { count: Math.max(1, Math.round(value)) }
          : name === 'spacing' ? { spacing: r3 } : name === 'extent' ? { extent: r3 } : name === 'angle' ? { angle: r3 } : {}) };
        next.skip = remapSkip(o.v.skip, o.v, next, paramVals);
        return { ...o, v: next };
      });
    };
  }
  // with Fillet / Chamfer open: a handle on its first edge drags the size
  // (0.1 mm steps), live — the ghost follows ~300 ms behind
  const edgeH = edgeOp?.v.edges[0] ? edgeHandle(edgeAsNow(edgeOp.v.edges[0])) : null;
  const edgeHKey = edgeH ? JSON.stringify(edgeH) : '';
  const edgeSize = edgeOp?.v.size ?? 0;
  const handle: HandleOption | null = revolveOp
    ? (revolveDH ? { name: 'angle', value: edgeDragRef.current ?? revolveDH.value, shift: revolveDH.shift, dr: 0, moves: [] } : null)
    : patternOp
    ? (patH ? { name: patH.name, value: edgeDragRef.current ?? patH.value, shift: patH.shift, dr: 0, moves: [] } : null)
    : planeOp
    ? (planeH ? { name: planeOp.kind === 'offset' ? 'distance' : 'angle', value: edgeDragRef.current ?? planeH.value,
                  shift: planeH.shift, dr: 0, moves: [] } : null)
    : edgeOp
    ? (edgeH && edgeSize > 0 ? { name: edgeOp.op === 'fillet' ? 'radius' : 'distance',
                                  value: edgeDragRef.current ?? edgeSize, shift: edgeH.dir, dr: 0, moves: [] } : null)
    : faceHandle;
  handleRef.current = handle;
  edgeHandleOnRef.current = !!edgeOp || !!planeOp || !!patternOp || !!revolveOp;
  handleUnitRef.current = revolveOp || planeOp?.kind === 'edge' || planeOp?.kind === 'tangent' || patH?.name === 'angle' ? '°' : '';
  dialogDragNoteRef.current = revolveOp ? '15° steps · Shift: 1° · Esc cancels'
    : patH?.name === 'count' ? 'drag to add or remove copies · Esc cancels'
    : patH?.name === 'angle' ? 'Shift: 0.1° · Esc cancels' : patternOp ? 'Shift: 0.1 mm · Esc cancels'
    : planeOp?.kind === 'offset' ? 'Shift: 0.1 mm · snaps to faces · Esc cancels'
    : planeOp?.kind === 'tangent' ? 'Shift: 1° · holds at 90° steps · Esc cancels'
    : planeOp ? 'Shift: 0.1° · Esc cancels' : '0.1 mm steps · Esc cancels';
  handleHintRef.current = nHandles > 1 ? `Tab ⇄ ${hi + 1}/${nHandles}` : '';
  const handleKeyRef = useRef(handleKey);
  handleKeyRef.current = handleKey;
  const nHandlesRef = useRef(0);
  nHandlesRef.current = nHandles;
  useEffect(() => {
    if (revolveOp) {
      if (edgeDragRef.current != null) return;   // its own drag changed the angle: leave it be
      viewerRef.current?.setHandle(revolveDH);
      return;
    }
    if (patternOp) {
      if (edgeDragRef.current != null) return;   // its own drag changed the value: leave it be
      viewerRef.current?.setHandle(patH ? { face: -1, at: patH.at, shift: patH.shift, dr: 0, value: patH.value, moves: [],
                                            ...('turn' in patH ? { turn: patH.turn } : { step: patH.step, min: patH.min }) } : null);
      return;
    }
    if (planeOp) {
      if (edgeDragRef.current != null) return;   // its own drag changed the value: leave it be
      viewerRef.current?.setHandle(planeH);
      return;
    }
    if (edgeOp) {
      if (edgeDragRef.current != null) return;   // its own drag changed the size: leave it be
      viewerRef.current?.setHandle(edgeH && edgeSize > 0
        ? { face: -1, at: edgeH.at, shift: edgeH.dir, dr: 0, value: edgeSize, moves: [], step: 0.1, min: 0.1 }
        : null);
      return;
    }
    viewerRef.current?.setHandle(faceHandle && selFace
      ? { face: selFace.index, shift: faceHandle.shift, dr: faceHandle.dr, value: faceHandle.value, moves: faceHandle.moves }
      : null);
  }, [faceHandle, selFace, !!edgeOp, edgeHKey, edgeSize, planeHKey, patHKey, !!patternOp, revolveHKey, !!revolveOp]);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab' || nHandlesRef.current < 2 || faceSketchRef.current.activeRef.current) return;
      // only when nothing has focus (the canvas isn't focusable), so Tab still
      // moves between the editor's fields
      if (e.target instanceof HTMLElement && e.target !== document.body) return;
      e.preventDefault();
      if (handleKeyRef.current.startsWith('pattern|')) {
        const names = patNamesRef.current, i = Math.max(0, names.indexOf(patHNameRef.current));
        setPatPick(names[(i + (e.shiftKey ? -1 : 1) + names.length) % names.length]!);
        return;
      }
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
      if (e.key !== '?' || (e.target instanceof HTMLElement && e.target !== document.body
                            && !e.target.closest('[data-ops-panel]'))) return;
      if (faceSketchRef.current.activeRef.current) return;   // the sketcher's own help
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
  // N / the Normal button: the last face clicked; with the section on,
  // straight at the cut (from the side it cuts away)
  const lookAtSelection = () => {
    const cut = secLiveRef.current;
    if (cut) { viewerRef.current?.lookAlong(cutNormal(cut)); return; }
    const s = selRef.current;
    const f = s.length ? resRef.current?.faces.find((x) => x.index === s[s.length - 1]) : undefined;
    if (f) { viewerRef.current?.lookAlong(f.normal); return; }
    const pl = selectedPlane();
    if (pl) { viewerRef.current?.lookAlong(pl.normal); return; }
    setViewHint('Select a face, then press N');
    window.clearTimeout(viewHintTimer.current);
    viewHintTimer.current = window.setTimeout(() => setViewHint(''), 2500);
  };
  // K / "Sketch": on the one selected face, if it's flat; with nothing
  // selected, pick a base plane (Top / Front / Right)
  const [planeMenu, setPlaneMenu] = useState(false);
  const planeMenuRef = useRef(false);
  planeMenuRef.current = planeMenu;
  const sketchOnPlane = (which: BasePlane) => {
    setPlaneMenu(false);
    setSketchTip(null);
    faceSketchRef.current.enterPlane(which);
  };
  const sketchOnSelection = () => {
    const s = selRef.current;
    const pl = selectedPlane();
    if (pl) {
      setPlaneMenu(false); setSketchTip(null);
      faceSketchRef.current.enterConstruction(pl.name, pl);
      return;
    }
    if (!s.length) { setPlaneMenu((o) => !o); return; }
    setPlaneMenu(false);
    const f = s.length === 1 ? resRef.current?.faces.find((x) => x.index === s[0]) : undefined;
    if (f && f.kind === 'plane') { setSketchTip(null); faceSketchRef.current.enter(f); return; }
    setViewHint('Select one flat face or construction plane (or nothing, for a base plane), then press K');
    window.clearTimeout(viewHintTimer.current);
    viewHintTimer.current = window.setTimeout(() => setViewHint(''), 2500);
  };
  // the operations' keys (K, N, O, P, 1–6, 0) run the registry's entries,
  // as the tiles and the top bar do; the current context and state reach the
  // handler (set up once) through this ref
  const opsRef = useRef<{ ctx: OpContext; model: OpModel; sel: OpSelection; run: (op: Operation) => void;
                          modal: boolean } | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (faceSketchRef.current.activeRef.current) return;   // the sketcher owns the keys
      if ((e.metaKey || e.ctrlKey) && (e.key === '\\' || e.key === '|')) {   // works while typing, too
        cycleLayout(e.shiftKey ? -1 : 1); e.preventDefault(); e.stopPropagation(); return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      // not while typing in a field; a tile of the Operations grid keeps the keys
      if (e.target instanceof HTMLElement && e.target !== document.body && !e.target.closest('[data-ops-panel]')) return;
      const v = viewerRef.current;
      if (!v) return;
      if (planeMenuRef.current) {   // the plane chooser: T / F / R, Esc closes
        const pick = ({ t: 'top', f: 'front', r: 'right' } as Record<string, BasePlane>)[e.key.toLowerCase()];
        if (pick) sketchOnPlane(pick);
        else if (e.key === 'Escape') setPlaneMenu(false);
        if (pick || e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); return; }
      }
      const ops = opsRef.current;
      const op = opForKey(e.key);
      if (e.key === 'Escape' && v.cancelDrag()) {   // a drag in the view: back to where it began
        e.preventDefault(); e.stopPropagation(); return;
      }
      if (e.key === 'Escape') {
        if (faceSketchRef.current.menuOpen) return;
        // a dialog closes first, then the selection clears; then (Operations)
        // back to the layout before
        if (ops?.modal) return;
        if (ops?.model.dialogOpen) closeOpRef.current();
        else if (secPointsRef.current) v.clearSectionPoints();
        else if (selRef.current.length || selERef.current.length || selPRef.current.length) applySelectionRef.current([], []);
        else if (layoutRef.current === 'ops') leaveOps();
        else return;
      } else if (e.key.toUpperCase() === FILTER_KEY && !e.shiftKey) cyclePickFilterRef.current();
      else if (e.key === 'l' || e.key === 'L') cycleLayout(e.shiftKey ? -1 : 1);
      else if (e.key.toUpperCase() === OPS_KEY) toggleOpsLayout();
      else if (op && ops && (op.group !== 'Sketch' || sketchOnFace)) {
        // as the keys always did: K with nothing selected opens the plane
        // menu, N says what it needs — so the key runs it either way
        if (op.needs(ops.sel, ops.model).ok) ops.run(op);
        else op.run(ops.ctx);
      } else return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener('keydown', onKey, true);
    return () => { window.removeEventListener('keydown', onKey, true); window.clearTimeout(viewHintTimer.current); };
  }, []);

  // after a drop, build() reselects the face found where the drag put it
  const reselectRef = useRef<{ param: string; value: number; center: Vec3; normal: Vec3; tol: number } | null>(null);
  const onHandleMove = (value: number, done: boolean) => {
    if (!edgeHandleOnRef.current) return;
    if (edgeDragRef.current == null && !done) edgeDragRef.current = handleRef.current?.value ?? value;
    if (done) edgeDragRef.current = null;
    setEdgeSizeRef.current(value);
  };
  const onHandleDrop = (value: number) => {
    if (edgeHandleOnRef.current) {
      edgeDragRef.current = null;
      setEdgeSizeRef.current(value);
      return;
    }
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
    if (res && selP.length && !sel.length && !selE.length) {
      return `${selP.length === 1 ? 'this construction plane' : 'these construction planes'}: `
        + `${selP.map((n) => `PLANES[${JSON.stringify(n)}]`).join(', ')} (use it by name, so what is built on it follows it)`;
    }
    if (!res || (sel.length === 0 && selE.length === 0)) return '';
    const v = (a: [number, number, number]) => `(${a.map((n) => Math.round(n * 10) / 10).join(', ')})`;
    const desc = (i: number) => {
      const f = res.faces.find((x) => x.index === i)!;
      return `${f.kind} face (center ${v(f.center)}, normal ${v(f.normal)})`;
    };
    if (selE.length) {
      // each edge in words, and its edge_ref() spec so a line can name it the
      // way the Fillet / Chamfer buttons do
      const es = selE.map((i) => res.edges.find((e) => e.index === i)).filter((e): e is RunEdge => !!e);
      const words = es.map((e) => {
        const r = e.ref;
        const size = r?.radius ? `radius ${Math.round(r.radius * 100) / 100} mm` : `length ${Math.round(edgeLength(e) * 100) / 100} mm`;
        const between = r?.faces.map((f) => f.hint).filter(Boolean).join(' and ');
        return `the ${r?.hint ?? `${e.kind} edge`} (${e.kind}, ${size}${between ? `, between the ${between}` : ''})`;
      });
      const refs = es.filter((e) => e.ref).map((e) => JSON.stringify(e.ref));
      const faces = sel.length ? `; and ${sel.map((i) => `the ${desc(i)}`).join('; ')}` : '';
      return `${es.length === 1 ? 'this edge' : `these ${es.length} edges`}: ${words.join('; ')}${faces}.\n`
        + `In the script: edges_ref([${refs.join(', ')}])`;
    }
    if (sel.length === 1) return `the ${desc(sel[0]!)}`;
    if (sel.length > 2) return `these ${sel.length} faces: ${sel.map((i) => `the ${desc(i)}`).join('; ')}`;
    const shared = res.edges.filter((e) => e.faceIndices.length === 2 && e.faceIndices.includes(sel[0]!) && e.faceIndices.includes(sel[1]!));
    const edge = shared[0] ? `the ${shared[0].kind} edge between ` : 'the geometry between ';
    return `${edge}the ${desc(sel[0]!)} and the ${desc(sel[1]!)}`;
  };

  const sendChat = async (text?: string) => {
    const instruction = (text ?? ask).trim();
    if (!instruction || asking) return;
    // a file still uploading goes with this message: wait for it (see the effect below)
    if (chatUploading) { setSendQueued(instruction); return; }
    setAsking(true);
    const sent = filesToSend(ctxStore.files, skipCtx);
    const userMsg: ChatMessage = { role: 'user', text: instruction, at: Date.now(),
                                   ...(sent.length ? { files: sent.map((f) => f.title) } : {}) };
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
        // the context files go with it, except those removed for this message
        skip_context: skipList(ctxStore.files, skipCtx),
      });
      setSkipCtx(new Set());
      const spent = spendNote(r);
      if (r.kind === 'question') {
        persistChat([...base, { role: 'assistant', kind: 'question', text: r.question, usage: spent, at: Date.now() }]);
      } else {
        persistChat([...base, { role: 'assistant', kind: 'edit', text: r.note || 'Done.', code: r.code, usage: spent, at: Date.now() }]);
        setCode(r.code);
        saveDraft(r.code);
        await build(r.code, r.note || instruction);
      }
      fetchUsage();
    } catch (err) {
      const msg = `⚠ ${errorText(err)}`;
      // a failed edit can still have been billed (a script that didn't build, then a retry)
      const spent = err instanceof ApiError && err.usage ? usageLabel(err.usage) : undefined;
      persistChat([...base, { role: 'assistant', kind: 'question', text: msg, usage: spent, at: Date.now() }]);
      if (spent) fetchUsage();
    } finally {
      setAsking(false);
    }
  };

  // the upload is in and the skip set updated (same render): now send
  useEffect(() => {
    if (chatUploading || sendQueued === null) return;
    setSendQueued(null);
    void sendChat(sendQueued);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatUploading, sendQueued]);

  const rebuild = () => { setParamReject(null); saveDraft(code); build(code, 'build'); };
  const [exporting, setExporting] = useState<'stl' | 'step' | 'stl-parts' | 'dxf' | 'dxf-views' | null>(null);
  const doExport = async (format: 'stl' | 'step' | 'stl-parts' | 'dxf' | 'dxf-views') => {
    if (status !== 'done' || exporting) return;
    setExporting(format);
    try {
      resolveSketches(code);
      const r = await buildApi.export(code, format, getBackendId() ?? '', ...runArgs(code));
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

  const hasParams = Object.keys(paramVals).length > 0;
  // ---- the operations (build/operations.ts): the Operations grid, the top
  // bar's buttons and the keys all run these, with this context ----
  const hint = (text: string) => {
    setViewHint(text);
    window.clearTimeout(viewHintTimer.current);
    viewHintTimer.current = window.setTimeout(() => setViewHint(''), 2500);
  };
  const edgeMeasure = (() => {
    const res = resRef.current;
    if (!res || !selE.length) return null;
    return measureEdges(selE.map((i) => res.edges.find((e) => e.index === i)).filter((e): e is RunEdge => !!e));
  })();
  const measureText = edgeMeasure ? `${edgeMeasure.main}${edgeMeasure.sub ? ` (${edgeMeasure.sub})` : ''}`
    : !measure ? null : measure.single
    ? (measure.dia != null ? `⌀ ${measure.dia.toFixed(2)} mm` : `${measure.w!.toFixed(1)} × ${measure.h!.toFixed(1)} mm`)
    : `${measure.dist.toFixed(2)} mm (X ${measure.dx.toFixed(1)}, Y ${measure.dy.toFixed(1)}, Z ${measure.dz.toFixed(1)})`;
  const holeAtText = (() => {
    if (!selPlane) return null;
    const n = holeAt(selPlane);
    return n && 'sketch' in n.at ? `at the points of "${n.at.sketch}"` : `at the centre of the ${faceLabel(selPlane.normal)}`;
  })();
  const opSel: OpSelection = {
    faces: sel.map((i) => ({ kind: resRef.current?.faces.find((f) => f.index === i)?.kind ?? '' })),
    edges: selE.map((i) => ({ kind: resRef.current?.edges.find((e) => e.index === i)?.kind ?? '' })),
    planes: selP.map((name) => ({ name })),
  };
  // Z: on just inside the selected flat face, else through the middle,
  // square to the axis nearest the view; off again
  const lastFace = () => {
    const s = selRef.current;
    const f = s.length ? resRef.current?.faces.find((x) => x.index === s[s.length - 1]) : undefined;
    return f && f.kind === 'plane' ? f : null;
  };
  const toggleSection = () => {
    if (secOn) { setSecOn(false); return; }
    const v = viewerRef.current;
    if (!v || !resRef.current?.faces.length) { hint('Build the part first, then press Z'); return; }
    const f = lastFace();
    const pl = selectedPlane();
    const { back, center } = v.sectionFrame();
    setSecPlane(f ? sectionOnFace(f) : pl ? sectionOnFace({ center: pl.origin, normal: pl.normal }, 0)
      : sectionForView(back, center));
    setSecOn(true);
  };
  // H: the overhang highlight on / off
  const toggleOverhangs = () => {
    if (!ovState.on && !resRef.current?.faces.length) { hint('Build the part first, then press H'); return; }
    setOvState((o) => ({ ...o, on: !o.on }));
  };
  // the selected flat face becomes the print bed: stored with the part, found again on each build
  const setBedFace = () => {
    const f = lastFace();
    if (!f?.ref) { hint('Select one flat face first'); return; }
    persistPrintBed({ ...f.ref, kind: 'plane', hint: f.ref.hint ?? faceLabel(f.normal) });
    hint(`Prints on the ${f.ref.hint ?? faceLabel(f.normal)} now`);
    void rebuild();
  };
  const resetBed = () => {
    if (!printBed) return;
    persistPrintBed(null);
    hint('Prints on the lowest side along Z again');
    void rebuild();
  };
  // the flagged regions into the chat box (not sent), their faces selected as its context
  const askFixOverhangs = () => {
    const res = resRef.current;
    if (!ovSummary || !res || !ovSummary.regions.length) return;
    applySelection(ovSummary.faces, [], []);
    putInChat(overhangInstruction(ovSummary, res.faces, printBed && !bedMissing ? printBed : null));
  };
  const sectionAxisTo = (axis: 0 | 1 | 2) => {
    const v = viewerRef.current;
    if (!v || !secPlane || sectionAxis(secPlane) === 'XYZ'[axis]) return;
    const { back, center } = v.sectionFrame();
    setSecPlane(axisSection(axis, center, back));
  };
  const opModel: OpModel = {
    status, hasCode: !!code.trim(), dialogOpen: opOpen, sketching: faceSketch.active, canSketch: sketchOnFace,
    asking, holeSketches: holeSketches.length, holeAt: holeAtText, autoRound: !!resRef.current?.auto_round,
    exporting: !!exporting, importing, hasParams, showParams, ortho, measure: measureText, section: secOn,
    overhangs: ovState.on,
    mirrorSteps: stepSel.filter((l) => steps.some((s) => s.line === l && !mirrorSkip(s))).length,
    patternSteps: stepSel.filter((l) => steps.some((s) => s.line === l && !patternSkip(s))).length,
    revolveSketches: revolvable(docSketches).length,
  };
  const opCtx: OpContext = {
    sketchOnSelection, sketchOnPlane,
    offsetPlane: startOffsetPlane,
    edgePlane: startEdgePlane,
    tangentPlane: startTangentPlane,
    shell: startShell,
    hole: () => void startHole(),
    fillet: () => startEdgeOp('fillet'),
    chamfer: () => startEdgeOp('chamfer'),
    ask: (instruction) => void sendChat(instruction),
    build: () => (status === 'building' ? cancelBuild() : rebuild()),
    importStep: () => stepInput.current?.click(),
    exportAs: (format) => void doExport(format),
    versions: () => setShowVersions(true),
    process: openProduction,
    addContextFile: () => {
      setLayout('context');
      // the pane's file input mounts with the layout
      window.setTimeout(() => ctxPick.current?.(), 30);
    },
    toggleParams,
    setView: (view) => viewerRef.current?.setView(view),
    lookAtSelection,
    toggleOrtho: () => { const v = viewerRef.current; if (v) setOrtho(v.toggleOrtho()); },
    copyMeasure: () => {
      const text = measureText;
      if (!text) return;
      try {
        void navigator.clipboard.writeText(text).then(() => hint(`Copied ${text}`), () => hint(text));
      } catch { hint(text); }
    },
    section: toggleSection,
    overhangs: toggleOverhangs,
    mirrorBody: startMirrorBody,
    mirrorSteps: startMirrorSteps,
    patternBody: startPatternBody,
    patternSteps: startPatternSteps,
    revolve: startRevolve,
  };
  // the last few operations used, for the grid's Recent row
  const [recent, setRecent] = useState<string[]>(loadRecent);
  const recentRef = useRef(recent);
  const runOp = (op: Operation) => {
    const next = pushRecent(recentRef.current, op.id);
    if (next !== recentRef.current) { recentRef.current = next; setRecent(next); saveRecent(next); }
    op.run(opCtx);
  };
  // the top bar's: Build and Operations always, and up to five the selection makes possible
  const barOps = barOperations(opSel, opModel);
  opsRef.current = { ctx: opCtx, model: opModel, sel: opSel, run: runOp,
                     modal: showHelp || showVersions || showProduction };
  // "or ask: …" on the help card: into the chat box, not sent
  const chatInputRef = useRef<HTMLInputElement | null>(null);
  const setChatInputEl = useCallback((el: HTMLInputElement | null) => {
    chatInputRef.current = el;
    chatInputObs.current?.disconnect();
    if (!el || typeof ResizeObserver === 'undefined') return;
    chatInputObs.current = new ResizeObserver(() => setChatInputW(el.offsetWidth));
    chatInputObs.current.observe(el);
  }, []);
  const putInChat = (text: string) => {
    setAsk(text);
    setLayout('chat');
    window.setTimeout(() => chatInputRef.current?.focus(), 0);
  };
  const runById = (id: string) => { const op = opById(id); if (op) runOp(op); };
  // a top-bar button for an operation: the same entry, the same reason when
  // it can't run (only Build can't: the others are there because they can)
  const barButton = (op: Operation) => {
    const n = op.needs(opSel, opModel);
    const name = op.label?.(opModel) ?? op.name;
    const isBuild = op.id === 'build';
    const cancel = isBuild && status === 'building';
    const tone = cancel ? { background: 'none', color: palette.danger ?? '#f87171', border: `1px solid ${palette.danger ?? '#f87171'}` }
      : isBuild ? { background: palette.primaryBtn, color: '#fff' }
      : { background: 'none', color: palette.textSecondary, border: `1px solid ${palette.border}` };
    return (
      <button key={op.id} className={isBuild ? undefined : 'bar-fade'} onClick={() => { if (n.ok) runOp(op); }}
        aria-disabled={!n.ok} onMouseDown={(e) => e.preventDefault()}
        title={`${op.help}${op.shortcut ? ` (${op.shortcut})` : ''}${n.ok ? '' : ` — ${n.reason}`} · or ask: "${op.example}"`}
        style={{ ...btn, ...tone, display: 'flex', alignItems: 'center', gap: '6px', padding: '5px 11px',
                 whiteSpace: 'nowrap', flexShrink: 0, opacity: n.ok ? 1 : 0.5, cursor: n.ok ? 'pointer' : 'default' }}>
        {!isBuild && <OpIcon name={op.icon} size={16} />}
        {name}
      </button>
    );
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

  // the pieces the layouts arrange (see LAYOUTS): the parameters stand on
  // their own, at the top of the left column or floating over the 3D view
  const paramsPane = (style: CSSProperties) => (
    <div style={{ padding: '8px 12px', display: 'flex', flexWrap: 'wrap', gap: '8px 14px',
                  overflowY: 'auto', alignContent: 'flex-start', ...style }}>
      <div style={{ width: '100%', display: 'flex', alignItems: 'center', fontSize: '11px', fontWeight: 600,
                    letterSpacing: '0.5px', textTransform: 'uppercase', color: palette.textSecondary }}>
        <span style={{ flex: 1 }}>Parameters</span>
        <button onClick={toggleParams} onMouseDown={(e) => e.preventDefault()} title="Hide the parameters (P)"
          aria-label="Hide the parameters"
          style={{ background: 'none', border: 'none', color: palette.textSecondary, cursor: 'pointer',
                   fontSize: '14px', lineHeight: 1, padding: '0 2px' }}>&times;</button>
      </div>
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
  );
  // the script stays mounted when another layout hides it, keeping its scroll
  const codePane = (() => {
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
      <div style={{ flex: 1, display: layout === 'code' ? 'block' : 'none', position: 'relative', minHeight: 0, overflow: 'hidden',
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
          onSelect={trackCaret}
          // double-click an operation's line: its dialog
          onDoubleClick={() => {
            const ta = taRef.current;
            if (!ta) return;
            const line = ta.value.slice(0, ta.selectionStart).split('\n').length;
            const st = reopenableAt(steps, line);
            if (st) void editOp(st.line);
          }}
          onKeyDown={(e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); rebuild(); } }}
          spellCheck={false} autoCapitalize="off" autoCorrect="off" wrap="off"
          style={{ ...editorStyle, position: 'absolute', inset: 0, resize: 'none',
                   background: 'transparent', color: 'transparent',
                   caretColor: palette.text, outline: 'none', overflow: 'auto' }}
        />
        {/* line-number gutter (opaque; scrolls vertically with the editor) */}
        <div ref={gutterRef}
          style={{ ...monoBase, position: 'absolute', left: 0, top: 0, bottom: 0, width: GUTTER,
                   overflow: 'hidden', padding: '12px 8px 12px 0', boxSizing: 'border-box',
                   textAlign: 'right', color: palette.textSecondary, background: palette.inputBg,
                   borderRight: `1px solid ${palette.border}`, userSelect: 'none', pointerEvents: 'none' }}>
          <span aria-hidden>{Array.from({ length: lineCount }, (_, i) => i + 1).join('\n')}</span>
          {/* an operation the dialogs reopen: its icon, click to edit */}
          {steps.filter((st) => st.kind === 'op' && st.reopenable && !st.off && st.line <= lineCount).map((st) => {
            const icon = stepIcon(st);
            const name = st.op && st.op !== 'script' ? OP_NAMES[st.op] : 'step';
            return (
              <button key={st.line} onClick={() => void editOp(st.line)} onMouseDown={(e) => e.preventDefault()}
                aria-label={`Edit the ${name.toLowerCase()} on line ${st.line}`}
                title={`${st.summary ?? name}: click to open its dialog (OK rewrites just this line)`}
                style={{ position: 'absolute', left: 2, top: 12 + (st.line - 1) * 19.5 + 3, width: 15, height: 14,
                         padding: 0, border: 'none', background: 'none', cursor: 'pointer', pointerEvents: 'auto',
                         color: palette.accent, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                {icon ? <OpIcon name={icon} size={13} /> : '✎'}
              </button>
            );
          })}
        </div>
        {caretOp && !opOpen && (
          <button onClick={() => void editOp(caretStep?.line ?? caretLine)} onMouseDown={(e) => e.preventDefault()}
            title={`Open the ${OP_NAMES[caretOp]} dialog with this line's values; OK rewrites just this line (or double-click the line, or click its icon)`}
            style={{ ...btn, position: 'absolute', top: 8, right: 12, padding: '3px 10px', fontSize: '12px',
                     background: palette.primaryBtn, color: '#fff' }}>
            Edit {OP_NAMES[caretOp].toLowerCase()} (line {caretStep?.line ?? caretLine})
          </button>
        )}
      </div>
    );
  })();
  const ctxColors: CtxColors = {
    text: palette.text, dim: palette.textSecondary, mute: palette.textMuted, border: palette.border,
    surface: palette.background, card: palette.inputBg, accent: palette.accent, primary: palette.primaryBtn,
    danger: palette.danger, warning: palette.warning,
  };
  // images pasted or dropped into the chat: added to this part, in context
  const attachToChat = async (list: File[]) => {
    const ok = list.filter(acceptable);
    if (!ok.length) { ctxStore.setError('Only PDF, PNG, JPEG, WebP or HEIC files can go with a message.'); return; }
    for (const f of ok) {
      setChatUploading(f.name || 'image');
      // a pasted screenshot is called image.png; give it a name worth citing
      const named = f.name && f.name !== 'image.png' ? f
        : new File([f], `pasted-${new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '')}.${f.type.split('/')[1] || 'png'}`, { type: f.type });
      const added = await ctxStore.upload('part', named);
      if (added && !added.in_context) await ctxStore.update(added.id, { in_context: true });
      if (added) setSkipCtx((cur) => { if (!cur.has(added.id)) return cur; const n = new Set(cur); n.delete(added.id); return n; });
    }
    setChatUploading('');
    chatInputRef.current?.focus();
  };
  const pickChatFiles = () => chatFileRef.current?.click();
  const paperclip = (size: number) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
    </svg>
  );
  const chatHistory = (
    <div ref={chatScrollRef} style={{ ...(layout === 'chat' ? { flex: 1, minHeight: 0 } : { maxHeight: '30vh' }), overflowY: 'auto', padding: '10px 16px',
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
              {m.files?.length ? (
                <span style={{ display: 'block', fontSize: '11px', opacity: 0.75, marginTop: 3 }}>
                  📎 {m.files.join(', ')}
                </span>
              ) : null}
              {revertable && (
                <span style={{ display: 'block', fontSize: '11px', opacity: 0.6, marginTop: 3 }}>
                  ↩ click to revert here
                </span>
              )}
            </div>
            {!mine && isQ && i === chat.length - 1 && !m.text.startsWith('⚠') && (
              <button onClick={pickChatFiles} disabled={!!chatUploading}
                title="Answer with a photo, drawing or datasheet (or type your answer below); add a sentence before you send"
                style={{ marginTop: 4, display: 'inline-flex', alignItems: 'center', gap: 5, padding: '3px 9px',
                         background: 'none', color: palette.accent ?? palette.text, border: `1px solid ${palette.border}`,
                         borderRadius: '4px', fontSize: '12px', cursor: 'pointer' }}>
                {paperclip(12)} Attach a file
              </button>
            )}
            {chatUsageNote(user, m.usage) && (
              <div title="This call: input tokens (of them, read from the prompt cache) · output tokens · cost"
                style={{ fontSize: '10.5px', color: palette.textSecondary, marginTop: 2, paddingLeft: 4 }}>
                {m.usage}
              </div>
            )}
          </div>
        );
      })}
      {asking && (
        <div style={{ alignSelf: 'flex-start', fontSize: '12px', color: palette.textSecondary }}>thinking…</div>
      )}
    </div>
  );
  const chatInput = (
  <div onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setChatDragging(true); } }}
    onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setChatDragging(false); }}
    onDrop={(e) => { setChatDragging(false); const l = [...e.dataTransfer.files]; if (l.length) { e.preventDefault(); void attachToChat(l); } }}
    style={{ position: 'relative', outline: chatDragging ? `2px dashed ${palette.accent ?? palette.border}` : 'none', outlineOffset: -3 }}>
  {chatDragging && (
    <div style={{ position: 'absolute', inset: 0, zIndex: 2, pointerEvents: 'none', display: 'flex', alignItems: 'center',
                  justifyContent: 'center', gap: 6, background: `${palette.background}d9`, color: palette.accent ?? palette.text,
                  fontSize: '13px', fontWeight: 600 }}>
      {paperclip(14)} Drop to attach
    </div>
  )}
  <input ref={chatFileRef} type="file" multiple accept="image/*,application/pdf" style={{ display: 'none' }}
    onChange={(e) => { const l = [...(e.target.files ?? [])]; e.target.value = ''; if (l.length) void attachToChat(l); }} />
  <ContextChips files={filesToSend(ctxStore.files, new Set())} skipped={skipCtx} c={ctxColors}
    onOpen={() => setLayout('context')}
    onSkip={(id, skip) => setSkipCtx((cur) => { const n = new Set(cur); if (skip) n.add(id); else n.delete(id); return n; })} />
  {(chatUploading || (ctxStore.error && layout !== 'context')) && (
    <div onClick={() => ctxStore.setError('')}
      style={{ padding: '4px 16px 0', fontSize: '12px', color: chatUploading ? palette.textSecondary : palette.danger }}>
      {chatUploading ? `Attaching ${chatUploading}…${sendQueued !== null ? ' Your message goes once it’s attached.' : ''}` : ctxStore.error}
    </div>
  )}
  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 16px' }}>
  <button onClick={pickChatFiles} disabled={!!chatUploading} aria-label="Attach a file"
    title="Attach a photo, drawing or datasheet (or drop or paste one here); the AI reads it with your message"
    style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 30, height: 30, flex: 'none',
             background: 'none', color: palette.textSecondary, border: `1px solid ${palette.inputBorder}`,
             borderRadius: '4px', cursor: !chatUploading ? 'pointer' : 'default',
             opacity: !chatUploading ? 1 : 0.5 }}>
    {paperclip(15)}
  </button>
  <input
    ref={setChatInputEl}
    value={ask}
    onChange={(e) => setAsk(e.target.value)}
    onKeyDown={(e) => { if (e.key === 'Enter') void sendChat(); }}
    onPaste={(e) => {
      // a pasted photo or screenshot becomes a context file of this part
      const l = [...e.clipboardData.files];
      if (l.length) { e.preventDefault(); void attachToChat(l); }
    }}
    placeholder={sel.length ? 'e.g. chamfer this edge 2mm  (targets your selection)'
                 : chatInputW >= 560 ? 'Describe a change — e.g. add four M4 corner bolt holes — or attach a photo or datasheet'
                 : chatInputW >= 330 ? 'Describe a change — or attach a photo or datasheet' : 'Describe a change'}
    disabled={asking}
    style={{ flex: 1, padding: '6px 10px', background: palette.inputBg,
             border: `1px solid ${palette.inputBorder}`, borderRadius: '4px',
             color: palette.text, fontSize: '13px', outline: 'none' }}
  />
  <select value={model} onChange={(e) => pickModel(e.target.value)} onFocus={refreshModelsIfStale}
    disabled={asking || models.length === 0}
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
  );

  return (
    <div style={{ position: 'fixed', inset: 0, background: palette.panelBg, zIndex: 1000,
                  display: 'flex', flexDirection: 'column' }}>
      <div style={{ background: palette.panelBg, flex: 1, minHeight: 0,
                    display: 'flex', flexDirection: 'column' }}>
        {/* header: a fixed height, so the selection's buttons come and go without it moving */}
        <style>{'@keyframes bar-fade { from { opacity: 0 } } .bar-fade { animation: bar-fade 160ms ease-out; }'}</style>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '0 16px', height: 54,
                      boxSizing: 'border-box', flexShrink: 0,
                      borderBottom: staff ? 'none' : `1px solid ${palette.border}` }}>
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
          {/* layout: what sits beside the 3D view; not focusable on click, so keys keep working */}
          <div role="group" aria-label="Layout" onMouseDown={(e) => e.preventDefault()}
            style={{ display: 'flex', flexShrink: 0, border: `1px solid ${palette.border}`, borderRadius: '4px', overflow: 'hidden' }}>
            {LAYOUTS.map(([k, label, title], i) => (
              <button key={k} onClick={() => setLayout(k)} aria-pressed={layout === k} aria-label={label}
                title={`${k === 'ops' ? `${label}: ` : ''}${title} (${LAYOUT_KEYS})`}
                style={{ ...btn, padding: k === 'ops' ? '5px 8px' : '5px 10px', borderRadius: 0, whiteSpace: 'nowrap',
                         display: 'flex', alignItems: 'center',
                         borderLeft: i ? `1px solid ${palette.border}` : 'none',
                         background: layout === k ? palette.buttonBg : 'none',
                         color: layout === k ? palette.accent : palette.textSecondary,
                         fontWeight: layout === k ? 600 : 400 }}>
                {k === 'ops' ? <OpIcon size={16}>{OPS_GRID_ICON}</OpIcon> : label}
              </button>
            ))}
          </div>
          {/* what the selection makes possible (the rest are in the Operations layout), right
              up against Build and Operations, which stay put */}
          <input ref={stepInput} type="file" accept={STEP_ACCEPT} style={{ display: 'none' }}
            onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void importStep(f); }} />
          <div role="group" aria-label="Operations for the selection"
            style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', justifyContent: 'flex-end',
                     gap: '8px', overflow: 'hidden' }}>
            {barOps.length ? barOps.map(barButton) : (
              <span key="hint" className="bar-fade"
                style={{ fontSize: '12px', color: palette.textSecondary, whiteSpace: 'nowrap' }}>{BAR_HINT}</span>
            )}
          </div>
          {barButton(opById('build')!)}
          <button onClick={toggleOpsLayout} onMouseDown={(e) => e.preventDefault()} aria-pressed={layout === 'ops'}
            title={layout === 'ops' ? `Back to the layout before (${OPS_KEY} or Esc)`
              : `Every operation, enabled by what is selected (${OPS_KEY})`}
            style={{ ...btn, display: 'flex', alignItems: 'center', gap: '6px', padding: '5px 11px', flexShrink: 0,
                     whiteSpace: 'nowrap', background: layout === 'ops' ? palette.buttonBg : 'none',
                     color: layout === 'ops' ? palette.accent : palette.textSecondary,
                     border: `1px solid ${layout === 'ops' ? palette.accent : palette.border}` }}>
            <OpIcon size={16}>{OPS_GRID_ICON}</OpIcon>
            Operations
            <Kbd keys={OPS_KEY} />
          </button>
          <button onClick={() => setShowHelp(true)} title="What everything here does (?)" aria-label="Help"
            style={{ ...btn, padding: '5px 10px', background: 'none', color: palette.textSecondary,
                     border: `1px solid ${palette.border}`, borderRadius: '50%' }}>?</button>
          <button onClick={handleClose} style={{ background: 'none', border: 'none',
                   color: palette.textSecondary, fontSize: '18px', cursor: 'pointer', padding: '0 4px' }}>&times;</button>
        </div>
        {/* the AI spend, for staff: a slim line under the bar */}
        {staff && (
          <div style={{ height: 22, flexShrink: 0, display: 'flex', alignItems: 'center', padding: '0 16px',
                        fontSize: '11.5px', color: palette.textSecondary, borderBottom: `1px solid ${palette.border}` }}>
            {usage && (
              <span title={`This model: ${usage.document.tokens_in.toLocaleString()} in (${(usage.document.cache_read_tokens ?? 0).toLocaleString()} from the prompt cache) / ${usage.document.tokens_out.toLocaleString()} out.  All-time: ${usage.all_time.tokens_in.toLocaleString()} in (${(usage.all_time.cache_read_tokens ?? 0).toLocaleString()} cached) / ${usage.all_time.tokens_out.toLocaleString()} out.`}>
                {spendLine(user, usage)}
              </span>
            )}
          </div>
        )}

        {/* body: parameters + script or chat (left) | 3D view (right) */}
        <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
          <div style={{ width: '46%', display: layout === 'model' ? 'none' : 'flex', flexDirection: 'column',
                        minHeight: 0, borderRight: `1px solid ${palette.border}` }}>
            {hasParams && showParams && paramsPane({ borderBottom: `1px solid ${palette.border}`, maxHeight: '30%' })}
            {codePane}
            {layout === 'chat' && (
              <>
                {chat.length > 0 ? chatHistory : (
                  <div style={{ flex: 1, padding: '14px 16px', fontSize: '13px', lineHeight: 1.5,
                                color: palette.textSecondary }}>
                    No conversation yet. Describe a change below; each edit the AI makes is kept
                    here, and clicking one reverts the part to that version.
                  </div>
                )}
                <div style={{ borderTop: `1px solid ${palette.border}` }}>{chatInput}</div>
              </>
            )}
            {layout === 'context' && (
              <ContextPane store={ctxStore} c={ctxColors} partOwned pickRef={ctxPick}
                pricePerM={models.find((m) => m.id === model)?.input_per_m} />
            )}
            {layout === 'ops' && (
              <StepsList steps={steps} problems={problems} selected={stepSel} busy={stepBusy}
                onSelect={selectStep} onEdit={(st) => void editOp(st.line)}
                onToggle={(st, withCopies) => void changeStep(st, st.off ? 'on' : 'off', withCopies ? 'with' : undefined)}
                onDelete={(st, copies) => void changeStep(st, 'delete', copies)}
                onMirror={opModel.mirrorSteps > 0 && !opOpen ? startMirrorSteps : undefined}
                onPattern={opModel.patternSteps! > 0 && !opOpen ? startPatternSteps : undefined}
                deleteNote={(st) => {
                  const used = st.plane ? planeSketches(docSketches, st.plane) : [];
                  return used.length ? `Used by ${used.length > 1 ? 'sketches' : 'sketch'} ${used.map((x) => `“${x.name}”`).join(', ')}` : null;
                }} />
            )}
            {layout === 'ops' && (
              <OperationsPanel sel={opSel} model={opModel} recent={recent} onRun={runOp} onExample={putInChat}
                onBack={() => { if (opOpen) closeOp(); else leaveOps(); }} />
            )}
          </div>
          <div style={{ flex: 1, position: 'relative', minHeight: 0, overflow: 'hidden' }}>
            <canvas ref={canvasRef} style={{ width: '100%', height: '100%', display: 'block',
                     cursor: 'grab', touchAction: 'none', ...faceSketch.canvasStyle }} />
            {/* the parameters float over the maximised 3D view */}
            {layout === 'model' && hasParams && showParams && !faceSketch.active && paramsPane({
              position: 'absolute', top: 12, right: 12, maxWidth: 'min(440px, 60%)', maxHeight: '45%',
              background: palette.panelBg, border: `1px solid ${palette.border}`, borderRadius: '6px',
              boxShadow: '0 4px 14px rgba(0,0,0,0.3)', zIndex: 2,
            })}
            {ovTip && ovState.on && !faceSketch.active && (
              <div style={{ position: 'absolute', left: ovTip.x + 14, top: ovTip.y + 12, padding: '3px 8px',
                            background: 'rgba(20,22,26,0.86)', border: '1px solid rgba(255,255,255,0.12)',
                            borderRadius: '4px', color: '#eef1f5', fontSize: '12px', pointerEvents: 'none',
                            whiteSpace: 'nowrap', zIndex: 3 }}>
                {ovTip.text}
              </div>
            )}
            {sketchTip && !faceSketch.active && (
              <div style={{ position: 'absolute', left: sketchTip.x + 12, top: sketchTip.y + 12, padding: '3px 8px',
                            background: 'rgba(20,22,26,0.86)', border: '1px solid rgba(255,255,255,0.12)',
                            borderRadius: '4px', color: '#eef1f5', fontSize: '12px', pointerEvents: 'none',
                            whiteSpace: 'nowrap' }}>
                {sketchTip.name} <span style={{ opacity: 0.6 }}>· double-click to edit</span>
              </div>
            )}
            {shellOp && (
              <ShellDialog value={shellOp.v} editing={shellOp.line != null} preview={shellPreview.preview}
                onChange={(v) => setShellOp((o) => o && { ...o, v })}
                faceIndex={opFaceIndex} onHoverFace={(i) => viewerRef.current?.hoverFace(i)}
                onApply={() => void applyShell()} onCancel={closeOp} />
            )}
            {edgeOp && (
              <EdgeOpDialog op={edgeOp.op} value={edgeOp.v} editing={edgeOp.line != null} preview={edgePreview.preview}
                onChange={(v) => setEdgeOp((o) => o && { ...o, v })}
                edgeIndex={opEdgeIndex} onHoverEdge={(i) => viewerRef.current?.hoverEdge(i)}
                selection={edgeOp.adds} shownAs={edgeAsNow} mirrored={edgeOp.mirrored}
                onApply={() => void applyEdgeOp()} onCancel={closeOp} />
            )}
            {extrudeOp && (
              <ExtrudeDialog value={extrudeOp.v} onChange={(v) => setExtrudeOp((o) => o && { ...o, v })}
                editing={extrudeOp.line != null} params={paramVals}
                hoverHint={extrudeOp.v.extent === 'face' && hoverPickFace != null
                  ? (() => { const f = resRef.current?.faces.find((x) => x.index === hoverPickFace); return f ? faceHint(f) : null; })()
                  : null}
                firstBody={extrudeOp.firstBody} param={extrudeOp.param} preview={extrudePreview.preview}
                direction={extrudeNormal ? extrudeDirectionText(extrudeOp.v, extrudeNormal, extrudePartAt) : ''}
                onEditSketch={editExtrudeSketch} onApply={() => void applyExtrude()} onCancel={closeOp} />
            )}
            {revolveOp && (
              <RevolveDialog value={revolveOp.v} onChange={changeRevolve} editing={revolveOp.line != null}
                firstBody={revolveOp.firstBody} sketches={revolvable(docSketches).map((x) => x.name)}
                choices={revolveChoices} params={paramVals} view={revolveView} problem={revolveProblem}
                summary={revolveSummary(revolveOp.v, revolveAngle, axisLabel(revolveAxis, revolveChoices), revolveNormal)}
                preview={revolvePreview.preview} onEditSketch={editRevolveSketch}
                onApply={() => void applyRevolve()} onCancel={closeOp} />
            )}
            {argOp?.v.op === 'auto_round' && (
              <RoundDialog value={argOp.v} onChange={(v) => setArgOp((o) => o && { ...o, v })}
                preview={argPreview.preview} keepFaces={keepFaces} picked={roundPick}
                onHoverFace={(i) => viewerRef.current?.hoverFace(i)}
                onApply={() => void applyArgOp()} onCancel={closeOp} />
            )}
            {argOp?.v.op === 'truss_windows' && (
              <TrussDialog value={argOp.v} onChange={(v) => setArgOp((o) => o && { ...o, v })}
                preview={argPreview.preview} onApply={() => void applyArgOp()} onCancel={closeOp} />
            )}
            {planeOp?.kind === 'offset' && (
              <OffsetPlaneDialog value={planeOp.v} editing={planeOp.line != null} params={paramVals}
                used={planeNames} own={planeOp.own ?? undefined}
                onChange={(v) => setPlaneOp((o) => o && o.kind === 'offset' ? { ...o, v } : o)}
                onApply={() => void applyPlaneOp()} onCancel={closeOp} />
            )}
            {planeOp?.kind === 'tangent' && (
              <TangentPlaneDialog value={planeOp.v} editing={planeOp.line != null} params={paramVals}
                used={planeNames} own={planeOp.own ?? undefined}
                onChange={(v) => setPlaneOp((o) => o && o.kind === 'tangent' ? { ...o, v } : o)}
                onApply={() => void applyPlaneOp()} onCancel={closeOp} />
            )}
            {planeOp?.kind === 'edge' && (
              <EdgePlaneDialog value={planeOp.v} editing={planeOp.line != null} params={paramVals}
                used={planeNames} own={planeOp.own ?? undefined}
                onChange={(v) => setPlaneOp((o) => o && o.kind === 'edge' ? { ...o, v } : o)}
                onHoverFace={(i) => viewerRef.current?.hoverFace(i)}
                onApply={() => void applyPlaneOp()} onCancel={closeOp} />
            )}
            {mirrorOp && (
              <MirrorOpDialog kind={mirrorOp.kind} value={mirrorOp.v} editing={mirrorOp.line != null}
                preview={mirrorPreview.preview} planes={planeNames} params={paramVals} steps={mirrorRows} after={mirrorAfter}
                onChange={(v) => setMirrorOp((o) => o && { ...o, v })}
                onApply={() => void applyMirror()} onCancel={closeOp} />
            )}
            {patternOp && (
              <PatternOpDialog kind={patternOp.kind} value={patternOp.v} editing={patternOp.line != null}
                onChange={(v) => setPatternOp((o) => o && { ...o, v })}
                join={patternOp.join} onJoin={(join) => setPatternOp((o) => o && { ...o, join })}
                preview={patternPreview.preview} params={paramVals} steps={patternRows} after={patternAfter}
                ways={patternWays} original={patternOp.original}
                onEditOriginal={() => { const of = patternOp.of; closeOp(); if (of != null) void editOp(of); }}
                onUnlink={() => { if (patternOp.line != null) void unlinkCopy(patternOp.line, 'Unlink pattern copy'); }}
                onApply={() => void applyPattern()} onCancel={closeOp} />
            )}
            {copyOp && (
              <MirrorCopyDialog of={copyOp.of} across={copyOp.across} original={copyOp.original}
                onEditOriginal={() => { const of = copyOp.of; closeOp(); void editOp(of); }}
                onUnlink={() => void unlinkCopy(copyOp.line)} onCancel={closeOp} />
            )}
            {planeLabelsView}
            {holeOp && holePresets && (
              <HoleDialog value={holeOp.v} editing={holeOp.line != null} preview={holePreview.preview}
                onChange={(v) => setHoleOp((o) => o && { ...o, v })}
                presets={holePresets} places={holePlaces} comp={holeComp}
                onApply={() => void applyHoles()} onCancel={closeOp} />
            )}
            {/* measure readout: center-to-center distance for a 2-face selection;
                an edge's length or radius, two edges' distance or angle */}
            {(measure || edgeMeasure || sel.length === 1) && !opOpen && (
              <div style={{ position: 'absolute', left: 12, top: 12, padding: '8px 11px',
                            background: 'rgba(20,22,26,0.82)', border: '1px solid rgba(255,255,255,0.12)',
                            borderRadius: '6px', color: '#eef1f5', pointerEvents: 'none',
                            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                            fontVariantNumeric: 'tabular-nums' }}>
                {edgeMeasure ? (
                  <>
                    <div style={{ fontSize: '15px', fontWeight: 600 }}>
                      {edgeMeasure.main.replace(/ mm$/, '')}
                      {edgeMeasure.main.endsWith(' mm') && <span style={{ fontSize: '11px', opacity: 0.6 }}> mm</span>}
                    </div>
                    {edgeMeasure.sub && <div style={{ fontSize: '11px', opacity: 0.7, marginTop: '2px' }}>{edgeMeasure.sub}</div>}
                  </>
                ) : !measure ? null : measure.single ? (
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
                {sel.length === 1 && !selE.length && (
                  <button onClick={selectFaceEdges} onMouseDown={(e) => e.preventDefault()}
                    title="Select this face's boundary edges (every loop of it), e.g. to fillet them"
                    style={{ pointerEvents: 'auto', marginTop: measure ? '7px' : 0, display: 'block', fontSize: '11px',
                             padding: '2px 8px', borderRadius: '4px', cursor: 'pointer', color: '#eef1f5',
                             background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.2)',
                             fontFamily: 'inherit' }}>
                    Edges of this face
                  </button>
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
            <div ref={viewBarRef} style={{ position: 'absolute', left: 84, right: 130, bottom: 12, display: 'flex', alignItems: 'center',
                          flexWrap: 'wrap', gap: '4px', fontSize: '11px', color: palette.textSecondary }}
                 onMouseDown={(e) => e.preventDefault()}>{/* don't take focus: keys keep working */}
              {VIEW_BUTTONS.map(([key, view]) => (
                <button key={view} style={viewBtn} title={`${view[0]!.toUpperCase()}${view.slice(1)} view (${key})`}
                        onClick={() => viewerRef.current?.setView(view)}>
                  {view === 'iso' ? 'Iso' : `${view[0]!.toUpperCase()}${view.slice(1)}`}
                </button>
              ))}
              <button style={{ ...viewBtn, marginLeft: '6px', opacity: sel.length || secOn ? 1 : 0.45,
                               cursor: sel.length || secOn ? 'pointer' : 'default' }}
                      disabled={!sel.length && !secOn} onClick={lookAtSelection}
                      title={secOn ? 'Look straight at the cut (N)' : sel.length ? 'Look straight at the selected face (N)'
                        : 'Select a face first (then N or this button)'}>
                Normal
              </button>
              {sketchOnFace && (() => {
                const onFace = !!selFace && selFace.kind === 'plane';
                const ok = onFace || !sel.length;
                return (
                  <span style={{ position: 'relative', marginLeft: '6px' }}>
                    <button style={{ ...viewBtn, opacity: ok ? 1 : 0.45, cursor: ok ? 'pointer' : 'default',
                                     ...(planeMenu ? { color: palette.accent, borderColor: palette.accent } : {}) }}
                            disabled={!ok} onClick={sketchOnSelection}
                            title={onFace ? 'Sketch on the selected face (K)'
                              : ok ? 'Sketch on a base plane: Top, Front or Right (K)'
                                : 'Select one flat face, or nothing for a base plane (then K or this button)'}>
                      {onFace ? 'Sketch on face' : 'Sketch…'}
                    </button>
                    {planeMenu && (
                      <div role="menu" aria-label="Sketch on a plane"
                           style={{ position: 'absolute', bottom: 'calc(100% + 6px)', left: 0, minWidth: 150, padding: '4px',
                                    display: 'flex', flexDirection: 'column', gap: '2px', background: palette.panelBg,
                                    border: `1px solid ${palette.border}`, borderRadius: '6px',
                                    boxShadow: '0 4px 14px rgba(0,0,0,0.3)' }}>
                        <div style={{ padding: '2px 6px 4px', color: palette.textSecondary }}>Sketch on</div>
                        {(Object.keys(BASE_PLANES) as BasePlane[]).map((k) => (
                          <button key={k} role="menuitem" onClick={() => sketchOnPlane(k)}
                                  style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', padding: '4px 8px',
                                           background: 'none', border: 'none', borderRadius: '4px', cursor: 'pointer',
                                           color: palette.text, fontSize: '12px', textAlign: 'left' }}
                                  onMouseEnter={(e) => { e.currentTarget.style.background = palette.buttonBg; }}
                                  onMouseLeave={(e) => { e.currentTarget.style.background = 'none'; }}>
                            <span><u>{BASE_PLANES[k].name[0]}</u>{BASE_PLANES[k].name.slice(1)}</span>
                            <span style={{ color: palette.textSecondary }}>{BASE_PLANES[k].axes}</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </span>
                );
              })()}
              <button style={{ ...viewBtn, marginLeft: '6px', ...(ortho ? { color: palette.accent, borderColor: palette.accent } : {}) }}
                      onClick={() => { const v = viewerRef.current; if (v) setOrtho(v.toggleOrtho()); }}
                      title={ortho ? 'Orthographic: click for perspective (O)' : 'Perspective: click for orthographic (O)'}>
                {ortho ? 'Ortho' : 'Persp'}
              </button>
              <button style={{ ...viewBtn, marginLeft: '6px', ...(ovState.on ? { color: palette.accent, borderColor: palette.accent } : {}) }}
                      aria-pressed={ovState.on} onClick={toggleOverhangs}
                      title={ovState.on ? 'Overhangs shown: click to hide (H)' : 'Shade the faces that would print as overhangs (H)'}>
                Overhangs
              </button>
              {/* what a click picks (E steps through) */}
              <span role="radiogroup" aria-label="What a click picks"
                    style={{ display: 'inline-flex', marginLeft: '6px', border: `1px solid ${palette.border}`, borderRadius: '4px', overflow: 'hidden' }}>
                {PICK_FILTERS.map(([k, label, tip]) => (
                  <button key={k} role="radio" aria-checked={pickFilter === k} onClick={() => setPickFilter(k)}
                          title={`${tip} (${FILTER_KEY} to switch)`}
                          style={{ ...viewBtn, border: 'none', borderRadius: 0,
                                   ...(pickFilter === k ? { color: palette.accent, background: 'rgba(0,0,0,0.45)' } : {}) }}>
                    {label}
                  </button>
                ))}
              </span>
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
            {/* a pattern's instance numbers (positioned per frame by onMarks): a click leaves that copy out */}
            {patternOp && patternChips.map((c) => (
              <button key={c.index}
                ref={(el) => { if (el) chipEls.current.set(String(c.index), el); else chipEls.current.delete(String(c.index)); }}
                onClick={() => { if (c.index) setPatternOp((o) => o && { ...o, v: { ...o.v, skip: toggleSkip(o.v.skip, c.index) } }); }}
                onWheel={(e) => { canvasRef.current?.dispatchEvent(new WheelEvent('wheel', e.nativeEvent)); }}   // zoom on through a chip
                title={c.index === 0 ? 'The original (#0): it stays' : c.skip ? `#${c.index} is left out: click to put it back`
                  : `#${c.index}: click to leave it out`}
                style={{ position: 'absolute', left: 0, top: 0, visibility: 'hidden', pointerEvents: 'auto',
                         minWidth: 20, height: 18, padding: '0 4px', borderRadius: 9, fontSize: 11, fontWeight: 700,
                         lineHeight: '16px', cursor: c.index ? 'pointer' : 'default',
                         textDecoration: c.skip ? 'line-through' : 'none',
                         background: c.index === 0 ? '#f59e33' : c.skip ? 'rgba(60,63,70,0.85)' : 'rgba(30,140,70,0.92)',
                         color: c.skip ? '#aab0ba' : '#fff', border: '1px solid rgba(255,255,255,0.55)' }}>
                {c.index}
              </button>
            ))}
            {/* the section plane's arrow (positioned per frame by onSectionHandle) */}
            <svg style={{ position: 'absolute', inset: 0, width: '100%', height: '100%',
                          pointerEvents: 'none', overflow: 'hidden' }}>
              <defs>
                <marker id="sectionArrow" markerUnits="userSpaceOnUse" markerWidth="12" markerHeight="12"
                        refX="4" refY="6" orient="auto">
                  <path d="M0,1 L11,6 L0,11 Z" fill="#e0784a" />
                </marker>
              </defs>
              <line ref={(el) => { sEls.current.line = el; }} opacity={0}
                    stroke="#e0784a" strokeWidth={2.5} strokeLinecap="round" markerEnd="url(#sectionArrow)" />
              <circle ref={(el) => { sEls.current.knob = el; }} opacity={0} r={4.5}
                      fill="#e0784a" stroke="#fff" strokeWidth={1.5} />
              <text ref={(el) => { sEls.current.label = el; }} opacity={0}
                    fontSize={12} fontWeight={600} fill="#f5b08e"
                    style={{ paintOrder: 'stroke', stroke: 'rgba(0,0,0,0.7)', strokeWidth: 3.5 }} />
              <text ref={(el) => { sEls.current.sub = el; }} opacity={0} fontSize={10.5}
                    style={{ paintOrder: 'stroke', stroke: 'rgba(0,0,0,0.7)', strokeWidth: 3 }} />
            </svg>
            {/* the section's readouts: the wall under the cursor, two points' distance */}
            {(['wall', 'dist'] as const).map((k) => (
              <div key={k} ref={(el) => { sEls.current[k] = el; }}
                   style={{ display: 'none', position: 'absolute', padding: '4px 8px', pointerEvents: 'none',
                            background: 'rgba(20,22,26,0.86)', border: '1px solid rgba(255,255,255,0.12)',
                            borderRadius: '4px', color: '#eef1f5', whiteSpace: 'nowrap', zIndex: 3,
                            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontVariantNumeric: 'tabular-nums' }}>
                <div style={{ fontSize: '14px', fontWeight: 600, color: '#f2ca63' }} />
                <div style={{ fontSize: '10.5px', opacity: 0.7 }} />
              </div>
            ))}
            {((secOn && secPlane) || ovState.on) && !faceSketch.active && (
              <div style={{ position: 'absolute', left: opWidth ? opWidth + 24 : 12, right: 12, bottom: viewBarH + 24, zIndex: 2,
                            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '6px', pointerEvents: 'none' }}>
                {ovState.on && (
                  <OverhangPanel palette={palette} summary={ovSummary} threshold={ovState.threshold}
                    bed={bedWords(printBed && !bedMissing ? printBed : null)} down={dirWords(ovDown)}
                    bedMissing={bedMissing} bedSet={!!printBed} canSetBed={sel.length === 1 && !!lastFace()?.ref}
                    onThreshold={(t) => setOvState((o) => ({ ...o, threshold: clampThreshold(t) }))}
                    onSetBed={setBedFace} onResetBed={resetBed} onAsk={askFixOverhangs}
                    onOff={() => setOvState((o) => ({ ...o, on: false }))} />
                )}
                {secOn && secPlane && <SectionPanel plane={secPlane} palette={palette} canAlign={!!lastFace() || !!selectedPlane()} dragging={secDragging}
                  onAxis={sectionAxisTo}
                  onAlign={() => {
                    const f = lastFace(), pl = selectedPlane();
                    if (f) setSecPlane(sectionOnFace(f));
                    else if (pl) setSecPlane(sectionOnFace({ center: pl.origin, normal: pl.normal }, 0));
                  }}
                  onFlip={() => setSecPlane((p) => p && flipSection(p))}
                  onPosition={(v) => setSecPlane((p) => p && atPosition(p, v))}
                  onOff={() => setSecOn(false)} />}
              </div>
            )}
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
                {offNote && <div style={{ color: palette.warning ?? '#c78a1a', fontSize: '12px' }}>⚠ {offNote}</div>}
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
                  {fix && fixButton(fix)}
                  <button onClick={() => runById('fix')} disabled={asking}
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
            checkpoint you can click to revert to. In the Chat layout it fills the
            left column instead; the 3D layout leaves it out */}
        {(layout === 'code' || layout === 'context') && (
          <div style={{ borderTop: `1px solid ${palette.border}`, display: 'flex', flexDirection: 'column' }}>
            {chat.length > 0 && chatHistory}
            {chatInput}
          </div>
        )}

        {/* footer */}
        <div style={{ padding: '8px 16px', borderTop: `1px solid ${palette.border}`,
                      fontSize: '12px', color: palette.textSecondary, minHeight: '20px' }}>
          {flash && <span style={{ color: palette.primaryBtn, fontWeight: 600 }}>↩ {flash}</span>}
          {!flash && status === 'building' && 'Building…'}
          {status === 'error' && <span style={{ color: palette.danger }}>Build failed — see the editor side.</span>}
          {status === 'done' && warn && (
            <span style={{ color: palette.warning ?? '#c78a1a', display: 'inline-flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
              <span>⚠ an operation failed (model shown up to it): {warn}</span>
              {offNote && <span>{offNote}</span>}
              {fix && fixButton(fix)}
            </span>
          )}
          {status === 'done' && bedMissing && (
            <span style={{ color: palette.warning ?? '#c78a1a', marginRight: '10px' }}
                  title="The face set as the print bed is no longer on the part: the overhangs and auto_round's bed use Z">
              ⚠ Print bed face not found; using Z
            </span>
          )}
          {status === 'done' && resRef.current?.sketches && (() => {
            const docSketches = useDocumentStore.getState().document.sketches;
            const { moved, warnings } = sketchBindNotes(resRef.current.sketches, docSketches, prevBindRef.current);
            // reference edges whose face edge is gone, in the sketches this build used
            const used = new Set(Object.keys(resRef.current.sketches));
            const broken = docSketches.flatMap((s) => (used.has(s.name) ? [brokenRefWarning(s)] : []))
              .filter((w): w is string => !!w);
            const { moved: edges, rebuilt, unsettled } = followNote;
            if (!moved && !warnings.length && !broken.length && !edges.length && !rebuilt) return null;
            const warnStyle = { color: palette.warning ?? '#c78a1a' };
            const notes = [
              moved > 0 && <span key="m" title="A face sketch moves along its face's normal when the part changes">
                {moved} sketch{moved === 1 ? '' : 'es'} followed {moved === 1 ? 'its face' : 'their faces'}
              </span>,
              ...edges.map((n) => <span key={`e:${n}`}
                title="What is dimensioned or constrained to the face's edges kept its distance from them">
                Sketch '{n}' followed its face's edges
              </span>),
              rebuilt && <span key="r" title="The sketch changes moved a shape the part is built from, so it was built once more">
                rebuilt to apply sketch changes
              </span>,
              ...unsettled.map((n) => <span key={`u:${n}`} style={warnStyle}
                title="The rebuild moved the face's edges again; it builds at most once more, so build again to apply it">
                ⚠ Sketch '{n}' changed again after the rebuild; build again to apply it
              </span>),
              ...warnings.map((w) => <span key={w} style={warnStyle}>⚠ {w}</span>),
              ...broken.map((w) => <span key={w} style={warnStyle}
                title="Open the sketch (K on its face): the dimensions on the missing edge are shown in red. Dimension them to another edge, or delete them">
                ⚠ {w}
              </span>),
            ].filter(Boolean);
            return <span style={{ marginRight: '10px', display: 'inline-flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
              {notes.flatMap((x, i) => (i ? [<span key={`s${i}`}>·</span>, x] : [x]))}
              <span>·</span>
            </span>;
          })()}
          {status === 'done' && (() => {
            // face_ref() lookups that went wrong: the face is gone (the build's
            // warning says which line), or two faces match it equally well
            // (edge_ref() the same, for edges)
            const what = (k: 'face' | 'edge') => (r: FaceRefReport) => ({ ...r, k });
            const bad = [...(resRef.current?.face_refs ?? []).map(what('face')),
                         ...(resRef.current?.edge_refs ?? []).map(what('edge'))].filter((r) => r.status !== 'found');
            if (!bad.length) return null;
            return <span style={{ marginRight: '10px', display: 'inline-flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
              {bad.map((r, i) => (
                <span key={i} style={{ color: palette.warning ?? '#c78a1a' }}
                  title={r.status === 'ambiguous'
                    ? `Another ${r.k} looks almost the same (or its faces changed); the nearest was used. Reopen the step (Edit in the code view) to check`
                    : `Reopen the step (Edit in the code view) and pick the ${r.k} again`}>
                  ⚠ {r.status === 'ambiguous' ? `the ${r.hint}: not certain, used the nearest ${r.k}` : `the ${r.hint} wasn't found`}
                </span>
              ))}
              <span>·</span>
            </span>;
          })()}
          {sketchWarns.length > 0 && status !== 'building' && (
            <span style={{ marginRight: '10px', display: 'inline-flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
              {sketchWarns.map((w) => <span key={w} style={{ color: palette.warning ?? '#c78a1a' }}>⚠ {w}</span>)}
              <span>·</span>
            </span>
          )}
          {notice && <span style={{ marginRight: '10px' }}>{notice} ·</span>}
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
            if (!res || (sel.length === 0 && selE.length === 0))
              return `${stats} · drag to orbit · scroll to zoom · click a face or an edge (Shift-click for more; double-click an edge for its loop)`;
            if (selE.length) {
              const es = selE.map((i) => res.edges.find((e) => e.index === i)).filter((e): e is RunEdge => !!e);
              const named = es.map((e) => e.ref?.hint ?? `${e.kind} edge`);
              return <span style={{ color: palette.text }}>
                {es.length === 1 ? <b>{named[0]}</b> : <><b>{es.length} edges</b> · {[...new Set(named)].slice(0, 4).join(', ')}{new Set(named).size > 4 ? ', …' : ''}</>}
                {sel.length > 0 && <> · {sel.length} face{sel.length === 1 ? '' : 's'}</>}
                <span style={{ color: palette.textSecondary }}>
                  {' · Shift-click to add or drop one · double-click for a loop (Alt: the smooth chain) · Esc clears'}
                </span>
              </span>;
            }
            const faces = sel.map((i) => res.faces.find((f) => f.index === i)!).filter(Boolean);
            const protect = res.auto_round && (
              <button onClick={() => runById('protect')} disabled={asking}
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
            if (sel.length > 2) {
              return <span style={{ color: palette.text }}>
                {sel.length} faces · {faces.map((f) => `#${f.index} ${f.kind}`).join(', ')}
                <span style={{ color: palette.textSecondary }}> · Shift-click to add or drop one</span>
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
      {faceSketch.overlay}
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
