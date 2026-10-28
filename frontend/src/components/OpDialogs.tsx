import { useEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react';
import { useThemeStore } from '@/theme';
import {
  ApiError, errorText, type ArgOpKind, type EdgeOpKind, type EdgeRefSpec, type ExtrudeExtent, type ExtrudeOp, type FaceRefSpec, type HoleKind,
  type HolePreset, type HolePresets, type HoleSizeKey, type HolesPayload, type KeepItem, type MirrorPlane, type RunFace,
  type RunResponse, type SizeFix,
} from '@/api/client';
import type { Viewer, ViewerMesh } from '@/build/webglViewer';
import type { Vec3 } from '@/build/dragHandle';
import { faceLabel } from '@/build/faceSketch';
import { DepthInput } from './DepthInput';
import { sameEdgeRef } from '@/build/edgePick';
import {
  amountText, amountValue, edgeSummary, offsetSummary, planeNameProblem, tangentRefLabel, tangentSummary, tangentZero,
  type Amount, type BaseName, type EdgePlaneValues, type OffsetPlaneValues, type TangentPlaneValues, type TangentRef,
} from '@/build/constructionPlanes';
import { mirrorBodyHint, mirrorBodySummary, mirrorStepsSummary } from '@/build/mirror';
import { dirWords, instanceCount, patternSummary, remapSkip, type PatternValues } from '@/build/pattern';
import { BODY_HUES } from '@/build/bodyColors';
import { axisLabel, type AxisChoice, type RevolveAxis, type RevolveValues } from '@/build/revolve';
import type { XY } from '@/build/faceSketch';
import { sketchWords } from '@/build/sketchToPart';
import { ParamExprInput } from './ParamExprInput';

// The part editor's explicit operations (Shell, Hole, Fillet, Chamfer; and reopened,
// Extrude, Round, Lighten): a dialog that writes one script line, with the result
// previewed as a ghost while it's open.

/** Mirror body's preview: the mirror image's colour (the hue a second body
 *  is shaded toward once built). */
export const MIRROR_COPY_COLOR: Vec3 = BODY_HUES[0]!;
/** Up to face / next: the piece the extrude adds or removes, in the preview */
export const UNTIL_PIECE_COLOR: Vec3 = BODY_HUES[0]!;

/** The colour the candidate result is drawn in. */
export const PREVIEW_COLOR: [number, number, number] = [0.36, 0.72, 0.86];

export interface PreviewState {
  state: 'idle' | 'running' | 'ok' | 'warning' | 'error';
  message: string;
  fix: SizeFix | null;
}
const IDLE: PreviewState = { state: 'idle', message: '', fix: null };

/** The candidate build of an open dialog, drawn as a ghost: `make` writes the
 *  candidate script (null: no dialog open), `key` names its inputs — a change
 *  rebuilds the preview ~300 ms after the last one. */
export function useOpPreview(
  viewerRef: RefObject<Viewer | null>,
  make: (() => Promise<string>) | null,
  key: string,
  run: (code: string, signal: AbortSignal) => Promise<RunResponse>,
  /** a second mesh to draw over the result in its own colour (Mirror body:
   *  the mirror image), made from the same candidate; null: none */
  extra?: (code: string, signal: AbortSignal) => Promise<{ mesh: ViewerMesh; color: Vec3 } | null>,
) {
  const [preview, setPreview] = useState<PreviewState>(IDLE);
  const makeRef = useRef(make);
  makeRef.current = make;
  const runRef = useRef(run);
  runRef.current = run;
  const extraRef = useRef(extra);
  extraRef.current = extra;
  // the last candidate built for `key` (OK applies it without writing it again)
  const done = useRef<{ key: string; code: string } | null>(null);
  const open = make !== null;
  useEffect(() => {
    if (!open) {
      viewerRef.current?.setPreviewMesh(null);
      setPreview(IDLE);
      done.current = null;
      return;
    }
    const ctrl = new AbortController();
    setPreview((p) => ({ ...p, state: 'running' }));
    const t = window.setTimeout(async () => {
      try {
        const code = await makeRef.current!();
        if (ctrl.signal.aborted) return;
        const [res, more] = await Promise.all([
          runRef.current(code, ctrl.signal),
          extraRef.current ? extraRef.current(code, ctrl.signal).catch(() => null) : null,
        ]);
        if (ctrl.signal.aborted) return;
        viewerRef.current?.setPreviewMesh({ mesh: res.mesh, color: PREVIEW_COLOR, extra: more });
        done.current = { key, code };
        setPreview(res.warning
          ? { state: 'warning', message: res.warning, fix: res.fix?.param || res.fix?.suggest ? res.fix : null }
          : { state: 'ok', message: '', fix: null });
      } catch (err) {
        if (ctrl.signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) return;
        viewerRef.current?.setPreviewMesh(null);
        setPreview({ state: 'error', message: errorText(err), fix: err instanceof ApiError && err.fix?.param ? err.fix : null });
      }
    }, 300);
    return () => { ctrl.abort(); window.clearTimeout(t); };
  }, [open, key]);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => viewerRef.current?.setPreviewMesh(null), []);   // eslint-disable-line react-hooks/exhaustive-deps
  return {
    preview,
    /** The candidate for `key` if the preview has built it. */
    built: (k: string) => (done.current?.key === k ? done.current.code : null),
  };
}

/** What a dialog row calls a face. */
export function faceHint(f: RunFace): string {
  return f.kind === 'plane' ? faceLabel(f.normal) : `${f.kind} face`;
}

/** The reference a script line stores for a face of the last build. */
export function refOf(f: RunFace): FaceRefSpec | null {
  return f.ref ? { ...f.ref, hint: faceHint(f) } : null;
}

/** The face of the last build a reference names, if it's there as it was. */
export function faceOfRef(faces: RunFace[], r: FaceRefSpec): RunFace | null {
  let best: RunFace | null = null, bestD = 1e-3 * Math.max(1, Math.sqrt(r.area));
  for (const f of faces) {
    if ((f.kind === 'plane') !== !r.kind) continue;
    const d = Math.hypot(f.center[0] - r.center[0], f.center[1] - r.center[1], f.center[2] - r.center[2]);
    const n = f.normal[0] * r.normal[0] + f.normal[1] * r.normal[1] + f.normal[2] * r.normal[2];
    // a curved face's reference holds its axis, not the normal shown: centre only.
    // The area too: a shell's rim sits where the top it removed was
    const sameArea = r.area > 0 && Math.abs(Math.log(f.area / r.area)) < 0.02;
    if (d <= bestD && sameArea && (r.kind || n > 0.999)) { best = f; bestD = d; }
  }
  return best;
}

export function sameRef(a: FaceRefSpec, b: FaceRefSpec): boolean {
  return a.center.every((x, i) => Math.abs(x - b.center[i]!) < 1e-3)
    && a.normal.every((x, i) => Math.abs(x - b.normal[i]!) < 1e-3);
}

// ---------------------------------------------------------------- the frame

function useStyles() {
  const palette = useThemeStore((s) => s.palette);
  const seg = (on: boolean): CSSProperties => ({
    flex: 1, padding: '3px 0', fontSize: '12px', cursor: 'pointer', border: `1px solid ${on ? palette.accent : palette.border}`,
    background: on ? palette.accent : palette.buttonBg, color: on ? '#fff' : palette.text,
  });
  const row: CSSProperties = { display: 'flex', alignItems: 'center', gap: '8px', color: palette.text };
  const num: CSSProperties = { width: 70, fontSize: '12px', padding: '2px 4px', background: palette.inputBg,
                               color: palette.text, border: `1px solid ${palette.border}`, borderRadius: '3px' };
  const note: CSSProperties = { color: palette.text, lineHeight: 1.4, padding: '4px 6px', borderRadius: '4px',
                                background: palette.buttonBg };
  return { palette, seg, row, num, note };
}

/** A dialog in the top left corner of the 3D view, clear of the part (the
 *  measure readout that sits there hides while it's open). */
function OpFrame({ title, children, preview, onApply, applyLabel, ok, onCancel, onFix, width = 270 }: {
  title: string; children: ReactNode; preview: PreviewState;
  onApply: () => void; applyLabel: string; ok: boolean; onCancel: () => void;
  onFix?: (fix: SizeFix) => void; width?: number;
}) {
  const { palette } = useStyles();
  const bad = preview.state === 'warning' || preview.state === 'error';
  const why = preview.message.split('\n').map((l) => l.trim()).filter(Boolean);
  return (
    <div role="dialog" aria-label={title} onMouseDown={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()}
         onKeyDown={(e) => {
           e.stopPropagation();
           if (e.key === 'Enter' && ok) onApply();
           else if (e.key === 'Escape') onCancel();
         }}
         style={{ position: 'absolute', left: 12, top: 12, width, maxHeight: 'calc(100% - 24px)', overflowY: 'auto',
                  padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: '9px', textAlign: 'left', zIndex: 3,
                  background: palette.panelBg, border: `1px solid ${palette.border}`, borderRadius: '6px',
                  boxShadow: '0 4px 14px rgba(0,0,0,0.3)', fontSize: '12px', boxSizing: 'border-box' }}>
      <div style={{ display: 'flex', alignItems: 'center', color: palette.text }}>
        <b style={{ flex: 1 }}>{title}</b>
        <span style={{ fontSize: '11px', color: palette.textSecondary }}>
          {preview.state === 'running' ? 'previewing…' : preview.state === 'ok' ? 'preview' : ''}
        </span>
      </div>
      {children}
      {bad && (
        <div style={{ color: palette.danger, lineHeight: 1.4, display: 'flex', flexDirection: 'column', gap: '5px' }}
             title={preview.message}>
          <span>{why[why.length - 1] ?? preview.message}</span>
          {(preview.fix?.value ?? preview.fix?.suggest) != null && onFix && (
            <button onClick={() => onFix(preview.fix!)}
                    style={{ alignSelf: 'flex-start', fontSize: '12px', padding: '2px 8px', cursor: 'pointer', borderRadius: '4px',
                             background: palette.buttonBg, color: palette.text, border: `1px solid ${palette.border}` }}>
              Use {preview.fix!.value ?? preview.fix!.suggest}
            </button>
          )}
        </div>
      )}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '6px' }}>
        <button onClick={onCancel} style={{ fontSize: '12px', padding: '2px 10px', cursor: 'pointer', borderRadius: '4px',
                                            background: palette.buttonBg, color: palette.text, border: `1px solid ${palette.border}` }}>
          Cancel
        </button>
        <button onClick={onApply} disabled={!ok}
                style={{ fontSize: '12px', padding: '2px 10px', cursor: ok ? 'pointer' : 'default', borderRadius: '4px',
                         opacity: ok ? 1 : 0.5, background: palette.accent, color: '#fff', border: `1px solid ${palette.accent}` }}>
          {applyLabel}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Shell

export interface ShellValues {
  remove: FaceRefSpec[];
  thickness: number;
  inside: boolean;
}

export function ShellDialog({ value, onChange, editing, preview, faceIndex, onHoverFace, onApply, onCancel }: {
  value: ShellValues; onChange: (v: ShellValues) => void;
  /** reopened from its script line */
  editing: boolean;
  preview: PreviewState;
  /** the face of the shown part a row names (to light it), if it's there */
  faceIndex: (r: FaceRefSpec) => number | null;
  onHoverFace: (index: number | null) => void;
  onApply: () => void; onCancel: () => void;
}) {
  const { palette, seg, row, num, note } = useStyles();
  const set = (p: Partial<ShellValues>) => onChange({ ...value, ...p });
  const ok = value.thickness > 0 && preview.state !== 'running';
  const t = Number.isFinite(value.thickness) ? value.thickness : 0;
  return (
    <OpFrame title={editing ? 'Edit shell' : 'Shell'} preview={preview} ok={ok} onCancel={onCancel}
             onApply={onApply} applyLabel={editing ? 'Update' : 'Shell'}
             onFix={(f) => set({ thickness: (f.value ?? f.suggest)! })}>
      <label style={row}>
        <span style={{ width: 64 }}>Thickness</span>
        <input type="number" min={0} step={0.5} value={value.thickness} autoFocus
               onChange={(e) => set({ thickness: parseFloat(e.target.value) })} style={num} />
        <span style={{ color: palette.textSecondary }}>mm</span>
      </label>
      <div style={{ display: 'flex' }}>
        <button style={{ ...seg(value.inside), borderRadius: '4px 0 0 4px' }} onClick={() => set({ inside: true })}
                title="The walls grow into the part: its outside stays where it is">Inside</button>
        <button style={{ ...seg(!value.inside), borderRadius: '0 4px 4px 0', borderLeft: 'none' }}
                onClick={() => set({ inside: false })}
                title="The walls grow out of the part: its inside stays where it is">Outside</button>
      </div>
      <div style={note}>
        {value.inside
          ? <>Walls {t} mm thick grow <b>into</b> the part; its outside stays the same size.</>
          : <>Walls {t} mm thick grow <b>out of</b> the part; it gets {2 * t} mm bigger, its inside stays the same.</>}
      </div>
      <div>
        <div style={{ color: palette.textSecondary, marginBottom: '4px' }}>
          Open faces {value.remove.length ? `(${value.remove.length})` : ''}
        </div>
        {value.remove.length === 0 && (
          <div style={{ color: palette.textSecondary, lineHeight: 1.4 }}>
            None: the part is hollowed with no opening. Click a face of the part to open it.
          </div>
        )}
        {value.remove.map((r, i) => {
          const idx = faceIndex(r);
          return (
            <div key={`${r.center.join()}|${r.normal.join()}`}
                 onMouseEnter={() => onHoverFace(idx)} onMouseLeave={() => onHoverFace(null)}
                 title={idx == null ? 'Not on the part as shown (the shell removed it): it is found again when the line runs' : 'Lit in the view'}
                 style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '2px 4px', borderRadius: '3px',
                          color: palette.text, cursor: 'default' }}
                 onMouseOver={(e) => { e.currentTarget.style.background = palette.buttonBg; }}
                 onMouseOut={(e) => { e.currentTarget.style.background = 'transparent'; }}>
              <span style={{ flex: 1 }}>
                {r.hint ?? 'face'}
                <span style={{ color: palette.textSecondary }}> · {Math.round(r.area)} mm²</span>
              </span>
              <button aria-label={`Keep the ${r.hint ?? 'face'} closed`} title="Keep this face closed"
                      onClick={() => { onHoverFace(null); set({ remove: value.remove.filter((_, j) => j !== i) }); }}
                      style={{ background: 'none', border: 'none', color: palette.textSecondary, cursor: 'pointer',
                               fontSize: '14px', lineHeight: 1, padding: '0 2px' }}>&times;</button>
            </div>
          );
        })}
        <div style={{ color: palette.textSecondary, marginTop: '4px', fontSize: '11px' }}>
          Click a face of the part to open or close it.
        </div>
      </div>
    </OpFrame>
  );
}

// ---------------------------------------------------------------- Hole

/** The Hole dialog's state. A size left at its preset is null (or absent):
 *  it follows the kind and size; a changed one becomes a P key. */
export interface HoleValues {
  at: HolesPayload['at'];
  kind: HoleKind;
  size: string;
  fit: 'close' | 'normal';
  through: boolean;
  depth: number | null;
  sizes: Partial<Record<HoleSizeKey, number>>;
  standoff: boolean;
  standoffH: number;
  standoffD: number | null;
  fillet: number;
}

/** Where the holes can go: a face sketch's points, or a face's centre. */
export interface HolePlace {
  key: string;
  label: string;
  at: HolesPayload['at'];
  count: number;
  /** out of the face: the holes go the other way */
  normal: [number, number, number];
}

export function placeKey(at: HolesPayload['at']): string {
  return 'sketch' in at ? `sketch:${at.sketch}` : `face:${at.face.center.join()}|${at.face.normal.join()}`;
}

const KIND_NAMES: Record<HoleKind, string> = {
  clearance: 'Clearance', tapped: 'Tapped', insert: 'Insert', counterbore: 'Counterbore', countersink: 'Countersink',
};
const KIND_WORDS: Record<HoleKind, string> = {
  clearance: 'clearance', tapped: 'tapped', insert: 'heat-set insert', counterbore: 'counterbored', countersink: 'countersunk',
};
const KIND_TIPS: Record<HoleKind, string> = {
  clearance: 'A hole the screw passes through freely (ISO 273: close or normal fit)',
  tapped: 'The tap drill: tap a thread, or drive a screw straight into the plastic (self-tapping)',
  insert: 'A hole for a heat-set threaded insert (CNC Kitchen sizes), pressed in with a soldering iron',
  counterbore: 'A clearance hole with a bore for a socket head cap screw (ISO 4762), so the head sits below the face',
  countersink: 'A clearance hole with a 90° cone for a countersunk screw (ISO 10642), so the head sits flush',
};
const SOURCES: Record<HoleKind, string> = {
  clearance: 'ISO 273 clearance holes (close: fine, normal: medium series)',
  tapped: 'tap drill = nominal − coarse pitch; 3 × nominal deep for the thread',
  insert: 'CNC Kitchen\'s "Dimensions & Design Guidelines" poster: hole D2, depth insert length + 1',
  counterbore: 'socket head cap screws, ISO 4762 (Misumi counterbore table; M2/M2.5 by its rule)',
  countersink: 'countersunk screws, ISO 10642 (head diameter dk, 90°)',
};

export function holePreset(p: HolePresets, v: Pick<HoleValues, 'kind' | 'size' | 'fit'>): HolePreset | null {
  const table = p.presets[v.kind === 'clearance' && v.fit === 'close' ? 'clearance_close' : v.kind];
  return table?.[v.size] ?? null;
}

/** The depth a blind hole starts at when its kind is through by default. */
function blindDepth(size: string): number {
  return 3 * (parseFloat(size.replace(/^M/, '')) || 3);
}

/** What the dialog sends to add_holes. */
export function holesPayload(v: HoleValues, p: HolePresets): HolesPayload {
  const pre = holePreset(p, v);
  const keys = HOLE_FIELDS[v.kind].map((f) => f.key);
  return {
    at: v.at, kind: v.kind, size: v.size, fit: v.fit,
    depth: v.through ? null : (v.depth ?? pre?.depth ?? blindDepth(v.size)),
    sizes: Object.fromEntries(Object.entries(v.sizes).filter(([k, x]) => keys.includes(k as HoleSizeKey) && x != null)),
    standoff: v.standoff ? { h: v.standoffH, d: v.standoffD ?? pre?.standoff_d ?? 8, fillet: v.fillet } : null,
  };
}

/** A new dialog's values. */
export function newHoleValues(at: HolesPayload['at'], p: HolePresets, standoff = false): HoleValues {
  return {
    at, kind: 'clearance', size: 'M3', fit: 'normal', through: true, depth: null, sizes: {},
    standoff, standoffH: p.standoff.height, standoffD: null, fillet: p.standoff.fillet,
  };
}

/** A holes() line's values (op_at) as the dialog's: a value equal to its
 *  preset counts as the preset (so a size change moves it). */
export function holeValuesOf(a: Record<string, unknown>, p: HolePresets): HoleValues {
  const kind = (a.kind as HoleKind) ?? 'clearance';
  const v: HoleValues = {
    ...newHoleValues(a.at as HolesPayload['at'], p),
    kind, size: String(a.size ?? 'M3'), fit: a.fit === 'close' ? 'close' : 'normal',
  };
  const pre = holePreset(p, v);
  const depth = a.depth == null ? null : Number(a.depth);
  v.through = depth == null;
  v.depth = depth != null && depth !== (pre?.depth ?? null) ? depth : null;
  const sizes = (a.sizes ?? {}) as Partial<Record<HoleSizeKey, number>>;
  for (const [k, x] of Object.entries(sizes) as [HoleSizeKey, number][]) {
    if (x != null && x !== pre?.[k]) v.sizes[k] = Number(x);
  }
  const so = a.standoff as { h?: number; d?: number; fillet?: number } | null;
  if (so) {
    v.standoff = true;
    v.standoffH = Number(so.h ?? p.standoff.height);
    v.standoffD = so.d != null && Number(so.d) !== pre?.standoff_d ? Number(so.d) : null;
    v.fillet = Number(so.fillet ?? p.standoff.fillet);
  }
  return v;
}

const HOLE_FIELDS: Record<HoleKind, { key: HoleSizeKey; label: string }[]> = {
  clearance: [{ key: 'd', label: 'Hole Ø' }],
  tapped: [{ key: 'd', label: 'Hole Ø' }],
  insert: [{ key: 'd', label: 'Hole Ø' }],
  counterbore: [{ key: 'd', label: 'Hole Ø' }, { key: 'cbore_d', label: 'Bore Ø' }, { key: 'cbore_depth', label: 'Bore depth' }],
  countersink: [{ key: 'd', label: 'Hole Ø' }, { key: 'csk_d', label: 'Head Ø' }],
};

/** Which way a hole into a face facing `n` goes, in words. */
function intoWords(n: readonly number[]): string {
  if (n[2]! > 0.999) return 'straight down';
  if (n[2]! < -0.999) return 'straight up';
  return `in from the ${faceLabel(n)}`;
}

/** A size with its preset: shows the preset until changed; ↺ goes back to it. */
function SizeField({ label, preset, value, onChange, title, disabled }: {
  label: string; preset: number | null | undefined; value: number | null | undefined;
  onChange: (v: number | null) => void; title: string; disabled?: boolean;
}) {
  const { palette, row, num } = useStyles();
  const changed = value != null;
  return (
    <label style={{ ...row, opacity: disabled ? 0.5 : 1 }} title={title}>
      <span style={{ width: 74 }}>{label}</span>
      <input type="number" min={0} step={0.1} disabled={disabled}
             value={changed ? value : preset ?? ''}
             onChange={(e) => {
               const x = parseFloat(e.target.value);
               onChange(Number.isFinite(x) && x !== preset ? x : null);
             }}
             style={{ ...num, fontWeight: changed ? 600 : 400, borderColor: changed ? palette.accent : palette.border }} />
      <span style={{ color: palette.textSecondary, flex: 1 }}>mm</span>
      {changed ? (
        <button onClick={(e) => { e.preventDefault(); onChange(null); }} title={`Back to the preset, ${preset}`}
                style={{ background: 'none', border: 'none', color: palette.accent, cursor: 'pointer', fontSize: '11px', padding: 0 }}>
          ↺ {preset}
        </button>
      ) : (
        <span style={{ color: palette.textSecondary, fontSize: '11px' }}>preset</span>
      )}
    </label>
  );
}

export function HoleDialog({ value, onChange, editing, preview, presets, places, comp, onApply, onCancel }: {
  value: HoleValues; onChange: (v: HoleValues) => void;
  editing: boolean;
  preview: PreviewState;
  presets: HolePresets;
  /** the sketches with points, and the face picked, to choose from */
  places: HolePlace[];
  /** the script's P["hole_comp"] */
  comp: number;
  onApply: () => void; onCancel: () => void;
}) {
  const { palette, seg, row, num, note } = useStyles();
  const set = (p: Partial<HoleValues>) => onChange({ ...value, ...p });
  const pre = holePreset(presets, value);
  const place = places.find((pl) => pl.key === placeKey(value.at)) ?? null;
  const pay = holesPayload(value, presets);
  const ok = !!place && place.count > 0 && preview.state !== 'running'
    && (pay.depth == null || pay.depth > 0) && (!pay.standoff || (pay.standoff.h > 0 && pay.standoff.d > 0));
  // a new kind or size starts from its presets
  const choose = (p: Partial<Pick<HoleValues, 'kind' | 'size' | 'fit'>>) => {
    const next = { ...value, ...p, sizes: {}, depth: null, standoffD: null };
    if (p.kind && p.kind !== value.kind) next.through = holePreset(presets, next)?.depth == null;
    onChange(next);
  };
  const n = place?.count ?? 0;
  const depthText = pay.depth == null ? 'through' : `${pay.depth} mm deep`;
  return (
    <OpFrame title={editing ? 'Edit holes' : 'Hole'} preview={preview} ok={ok} onCancel={onCancel} width={300}
             onApply={onApply} applyLabel={editing ? 'Update' : n > 1 ? `Add ${n} holes` : 'Add hole'}
             onFix={(f) => set({ fillet: (f.value ?? f.suggest)! })}>
      <label style={row}>
        <span style={{ width: 40 }}>At</span>
        <select value={place?.key ?? ''} onChange={(e) => {
                  const pl = places.find((x) => x.key === e.target.value);
                  if (pl) set({ at: pl.at });
                }}
                style={{ ...num, width: 'auto', flex: 1, minWidth: 0 }}>
          {!place && <option value="">(not found: pick a face or sketch)</option>}
          {places.map((pl) => <option key={pl.key} value={pl.key}>{pl.label}</option>)}
        </select>
      </label>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '3px' }}>
        {presets.kinds.map((k) => (
          <button key={k} style={{ ...seg(value.kind === k), borderRadius: '4px' }} title={KIND_TIPS[k]}
                  onClick={() => choose({ kind: k })}>{KIND_NAMES[k]}</button>
        ))}
        <button style={{ ...seg(value.standoff), borderRadius: '4px' }}
                title="Grow a round boss out of the face at each place and put the hole in its top (e.g. PCB standoffs)"
                onClick={() => set({ standoff: !value.standoff })}>
          {value.standoff ? '✓ ' : ''}Standoff
        </button>
      </div>
      <div style={{ display: 'flex' }}>
        {presets.sizes.map((sz, i) => (
          <button key={sz} onClick={() => choose({ size: sz })}
                  style={{ ...seg(value.size === sz), borderLeft: i ? 'none' : undefined,
                           borderRadius: i === 0 ? '4px 0 0 4px' : i === presets.sizes.length - 1 ? '0 4px 4px 0' : 0 }}>
            {sz}
          </button>
        ))}
      </div>
      {value.kind === 'clearance' && (
        <div style={{ display: 'flex' }}>
          <button style={{ ...seg(value.fit === 'close'), borderRadius: '4px 0 0 4px' }} onClick={() => choose({ fit: 'close' })}
                  title="A snug fit, for locating parts">Close fit</button>
          <button style={{ ...seg(value.fit === 'normal'), borderRadius: '0 4px 4px 0', borderLeft: 'none' }}
                  onClick={() => choose({ fit: 'normal' })} title="The usual fit, with some play">Normal fit</button>
        </div>
      )}
      {HOLE_FIELDS[value.kind].map((f) => (
        <SizeField key={f.key} label={f.label} preset={pre?.[f.key]} value={value.sizes[f.key]}
                   title={`${value.size}: ${SOURCES[value.kind]}. Change it and it becomes a parameter.`}
                   onChange={(x) => {
                     const sizes = { ...value.sizes };
                     if (x == null) delete sizes[f.key]; else sizes[f.key] = x;
                     set({ sizes });
                   }} />
      ))}
      <SizeField label="Depth" preset={pre?.depth ?? blindDepth(value.size)} value={value.depth}
                 disabled={value.through} onChange={(x) => set({ depth: x })}
                 title={value.through ? 'Through the part' : `From the ${value.standoff ? "standoff's top" : 'face'}`} />
      <label style={{ ...row, marginTop: '-4px' }}>
        <input type="checkbox" checked={value.through} onChange={(e) => set({ through: e.target.checked })} />
        <span>Through {value.standoff ? 'the standoff and the part' : 'the part'}</span>
      </label>
      {value.kind === 'insert' && pre?.insert_d != null && (
        <div style={{ color: palette.textSecondary, lineHeight: 1.4 }}>
          CNC Kitchen {value.size} insert: {pre.insert_d} mm across, {pre.insert_l} mm long; keep {pre.wall} mm of wall round the hole.
        </div>
      )}
      {value.standoff && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', paddingLeft: '8px',
                      borderLeft: `2px solid ${palette.border}` }}>
          <label style={row}>
            <span style={{ width: 74 }}>Height</span>
            <input type="number" min={0} step={0.5} value={value.standoffH}
                   onChange={(e) => set({ standoffH: parseFloat(e.target.value) })} style={num} />
            <span style={{ color: palette.textSecondary }}>mm</span>
          </label>
          <SizeField label="Outer Ø" preset={pre?.standoff_d} value={value.standoffD}
                     onChange={(x) => set({ standoffD: x })}
                     title="The boss's diameter: preset is the hole plus a wall each side (the insert's minimum wall for inserts)" />
          <label style={row}>
            <span style={{ width: 74 }}>Foot fillet</span>
            <input type="number" min={0} step={0.5} value={value.fillet}
                   onChange={(e) => set({ fillet: parseFloat(e.target.value) || 0 })} style={num} />
            <span style={{ color: palette.textSecondary }}>mm</span>
          </label>
        </div>
      )}
      <div style={note}>
        {n
          ? <>{n} {value.size} {KIND_WORDS[value.kind]} hole{n > 1 ? 's' : ''}, {depthText},
              going <b>{intoWords(place!.normal)}</b> into the part
              {value.standoff && pay.standoff ? <>, each in a standoff {pay.standoff.h} mm high and {pay.standoff.d} mm across growing <b>out</b> of the face</> : null}.
              {comp ? <> Hole diameters +{comp} mm (hole_comp).</> : null}</>
          : <>Pick where the holes go: a sketch with points or circles, or click a flat face for one at its centre.</>}
      </div>
      <div style={{ color: palette.textSecondary, fontSize: '11px', lineHeight: 1.4 }}>
        Sizes: {SOURCES[value.kind]}. Click a face to put the holes on its sketch, or at its centre.
      </div>
    </OpFrame>
  );
}

// ---------------------------------------------------------------- Fillet, Chamfer

export interface EdgeOpValues {
  edges: EdgeRefSpec[];
  /** fillet: the radius; chamfer: the distance back along each face */
  size: number;
}

/** Add or remove an edge: a click on it while the dialog is open. */
export function toggleEdge(edges: EdgeRefSpec[], r: EdgeRefSpec): EdgeRefSpec[] {
  return edges.some((e) => sameEdgeRef(e, r)) ? edges.filter((e) => !sameEdgeRef(e, r)) : [...edges, r];
}

/** Add edges that aren't in the list yet (a double-clicked loop, the selection). */
export function addEdges(edges: EdgeRefSpec[], more: EdgeRefSpec[]): EdgeRefSpec[] {
  const out = [...edges];
  for (const r of more) if (!out.some((e) => sameEdgeRef(e, r))) out.push(r);
  return out;
}

const EDGE_WORDS: Record<EdgeOpKind, { title: string; size: string; verb: string }> = {
  fillet: { title: 'Fillet', size: 'Radius', verb: 'Round' },
  chamfer: { title: 'Chamfer', size: 'Distance', verb: 'Bevel' },
};

export function EdgeOpDialog({ op, value, onChange, editing, preview, edgeIndex, onHoverEdge, selection, shownAs = (r) => r,
                               mirrored, onApply, onCancel }: {
  op: EdgeOpKind;
  value: EdgeOpValues; onChange: (v: EdgeOpValues) => void;
  /** reopened from its script line */
  editing: boolean;
  preview: PreviewState;
  /** the edge of the shown part a row names (to light it), if it's there */
  edgeIndex: (r: EdgeRefSpec) => number | null;
  onHoverEdge: (index: number | null) => void;
  /** edges selected when the dialog opened, to add to the line */
  selection: EdgeRefSpec[];
  /** an edge as the part has it now (its length, middle and radius), when that
   *  differs from when it was picked */
  shownAs?: (r: EdgeRefSpec) => EdgeRefSpec;
  /** an unlinked mirrored copy: the plane's label (its edges are the
   *  original's, reflected when the line runs, so they aren't picked here) */
  mirrored?: string;
  onApply: () => void; onCancel: () => void;
}) {
  const { palette, row, num, note } = useStyles();
  const w = EDGE_WORDS[op];
  const set = (p: Partial<EdgeOpValues>) => onChange({ ...value, ...p });
  const s = Number.isFinite(value.size) ? value.size : 0;
  const ok = s > 0 && value.edges.length > 0 && preview.state !== 'running';
  const total = value.edges.reduce((a, e) => a + shownAs(e).length, 0);
  const toAdd = mirrored ? [] : selection.filter((r) => !value.edges.some((e) => sameEdgeRef(e, r)));
  const n = value.edges.length;
  return (
    <OpFrame title={editing ? `Edit ${op}` : w.title} preview={preview} ok={ok} onCancel={onCancel}
             onApply={onApply} applyLabel={editing ? 'Update' : w.title}
             onFix={(f) => set({ size: (f.value ?? f.suggest)! })}>
      <label style={row}>
        <span style={{ width: 64 }}>{w.size}</span>
        <input type="number" min={0} step={0.1} value={value.size} autoFocus
               onChange={(e) => set({ size: parseFloat(e.target.value) })} style={num} />
        <span style={{ color: palette.textSecondary }}>mm</span>
      </label>
      <div style={note}>
        {n === 0
          ? <>No edges yet: click edges of the part (double-click for a whole loop).</>
          : op === 'fillet'
            ? <>{w.verb}s {n === 1 ? 'the edge' : `${n} edges`} ({total.toFixed(1)} mm in all) to a <b>{s} mm</b> radius.</>
            : <>{w.verb}s {n === 1 ? 'the edge' : `${n} edges`} ({total.toFixed(1)} mm in all), cutting <b>{s} mm</b> back along each face.</>}
        {n > 0 && <span style={{ color: palette.textSecondary }}> Drag the handle on the first edge to change it.</span>}
      </div>
      <div>
        <div style={{ color: palette.textSecondary, marginBottom: '4px' }}>Edges {n ? `(${n})` : ''}</div>
        {value.edges.map((r, i) => {
          const idx = edgeIndex(r);
          const now = shownAs(r);
          return (
            <div key={`${r.kind}|${r.midpoint.join()}`}
                 onMouseEnter={() => onHoverEdge(idx)} onMouseLeave={() => onHoverEdge(null)}
                 title={idx == null ? `Not on the part as shown (the ${op} replaced it): it is found again when the line runs` : 'Lit in the view'}
                 style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '2px 4px', borderRadius: '3px',
                          color: palette.text, cursor: 'default' }}
                 onMouseOver={(e) => { e.currentTarget.style.background = palette.buttonBg; }}
                 onMouseOut={(e) => { e.currentTarget.style.background = 'transparent'; }}>
              <span style={{ flex: 1 }}>
                {r.hint ?? `${r.kind} edge`}
                <span style={{ color: palette.textSecondary }}>
                  {' · '}{now.radius != null ? `R ${now.radius.toFixed(2)}` : `${now.length.toFixed(1)} mm`}
                </span>
              </span>
              {!mirrored && <button aria-label={`Leave the ${r.hint ?? 'edge'} sharp`} title={`Leave this edge out of the ${op}`}
                      onClick={() => { onHoverEdge(null); set({ edges: value.edges.filter((_, j) => j !== i) }); }}
                      style={{ background: 'none', border: 'none', color: palette.textSecondary, cursor: 'pointer',
                               fontSize: '14px', lineHeight: 1, padding: '0 2px' }}>&times;</button>}
            </div>
          );
        })}
        {toAdd.length > 0 && (
          <button onClick={() => set({ edges: addEdges(value.edges, toAdd) })}
                  style={{ marginTop: '4px', fontSize: '12px', padding: '2px 8px', cursor: 'pointer', borderRadius: '4px',
                           background: palette.buttonBg, color: palette.text, border: `1px solid ${palette.border}` }}>
            Add the {toAdd.length === 1 ? 'selected edge' : `${toAdd.length} selected edges`}
          </button>
        )}
        <div style={{ color: palette.textSecondary, marginTop: '4px', fontSize: '11px' }}>
          {mirrored ? `Mirrored across ${mirrored}: these are the original's edges, reflected when the line runs.`
            : 'Click an edge to add or remove it; double-click for its whole loop.'}
        </div>
      </div>
    </OpFrame>
  );
}

// ---------------------------------------------------------------- Extrude (reopened)

/** An extrude line's values (op_at): the sketch it extrudes, how, and the P
 *  key its depth is in (null: through, or not one yet). `extent` says how far
 *  it goes: the depth, through the part (a cut; `through` mirrors it), up to
 *  the next face it meets, or up to `face` (`offset` past it, negative: short
 *  of it — a number or an expression of the parameters). */
export interface ExtrudeValues {
  sketch: string;
  op: ExtrudeOp;
  extent: ExtrudeExtent;
  depth: number;
  through: boolean;
  flip: boolean;
  both: boolean;
  datum: boolean;
  face: FaceRefSpec | null;
  offset: Amount;
}

const EXTENT_TEXT: Record<ExtrudeExtent, string> = {
  distance: 'Distance', through: 'Through all', face: 'Up to face', next: 'Up to next',
};
const EXTENT_TIP: Record<ExtrudeExtent, string> = {
  distance: 'A set depth (kept in a parameter)',
  through: 'Cut right through the part',
  face: 'Run until it reaches a face you pick: its end takes that face\'s shape (a slanted wall, a cylinder)',
  next: 'Run until the first face it meets: a boss stops where it meets the part, a cut where it breaks into empty space',
};

/** What the extrude does, in words: "Cuts “Set screw” up to the next face". */
export function extrudeSummary(v: ExtrudeValues, offset: number | null): string {
  const what = v.op === 'cut' ? 'Cuts' : v.op === 'join' ? 'Grows' : 'Makes the part from';
  const extent = v.op !== 'cut' && v.extent === 'through' ? 'distance' : v.extent;
  const d = Number.isFinite(v.depth) ? v.depth : 0;
  const both = v.datum && extent === 'distance' && v.both;
  const how = extent === 'through' ? 'through the part'
    : extent === 'next' ? (v.op === 'cut' ? 'until it breaks into empty space' : 'until it meets the part')
    : extent === 'face' ? `up to the ${v.face?.hint ?? 'face'}${offset ? `, ${Math.abs(offset)} mm ${offset > 0 ? 'past it' : 'short of it'}` : ''}`
    : `${d} mm${both ? ' each way' : ''}`;
  return `${what} “${sketchWords(v.sketch)}” ${how}.`;
}

export function ExtrudeDialog({ value, onChange, editing = true, firstBody, param, params, direction, hoverHint, preview,
  placement, onEditSketch, onApply, onCancel }: {
  value: ExtrudeValues; onChange: (v: ExtrudeValues) => void;
  /** a project sketch: where its shapes go (its own plane, a plane, a face) */
  placement?: ReactNode;
  /** reopened from its line (Update) rather than new (Cut / Join) */
  editing?: boolean;
  /** the line makes the part: New body, and nothing else */
  firstBody: boolean;
  /** the P key the depth is in */
  param: string | null;
  params: Record<string, number>;
  /** which way it goes, in words */
  direction: string;
  /** Up to face: the face under the pointer, in words (null: none) */
  hoverHint?: string | null;
  preview: PreviewState;
  onEditSketch: () => void;
  onApply: () => void; onCancel: () => void;
}) {
  const { palette, seg, row, num, note } = useStyles();
  const set = (p: Partial<ExtrudeValues>) => onChange({ ...value, ...p });
  const extent: ExtrudeExtent = value.op !== 'cut' && value.extent === 'through' ? 'distance' : value.extent;
  const through = extent === 'through';
  const until = extent === 'next' || extent === 'face';
  const both = value.datum && extent === 'distance' && value.both;
  const flipOff = both || (through && value.datum);
  const d = Number.isFinite(value.depth) ? value.depth : 0;
  const off = extent === 'face' ? amountValue(value.offset, params) : 0;
  const bad = extent === 'face' && !value.face ? 'Click the face to extrude up to in the view'
    : off === null ? 'The offset must be a number or an expression of the parameters'
    : extent === 'distance' && !(d > 0) ? 'The depth must be more than 0' : null;
  const ok = !bad && preview.state !== 'running' && preview.state !== 'error';
  const shown: PreviewState = bad && extent === 'face' && !value.face ? { state: 'idle', message: '', fix: null }
    : bad ? { state: 'error', message: bad, fix: null } : preview;
  const extents: ExtrudeExtent[] = firstBody ? ['distance']
    : value.op === 'cut' ? ['distance', 'through', 'face', 'next'] : ['distance', 'face', 'next'];
  const pick = (e: ExtrudeExtent) => set({ extent: e, through: e === 'through', ...(e === 'distance' || e === 'through' ? {} : { both: false }) });
  const applyLabel = editing ? 'Update' : value.op === 'cut' ? 'Cut' : value.op === 'join' ? 'Join' : 'Create';
  return (
    <OpFrame title={editing ? 'Edit extrude' : 'Extrude'} preview={shown} ok={ok} onCancel={onCancel} onApply={onApply}
             applyLabel={applyLabel}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', color: palette.text }}>
        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
              title={value.sketch}>
          Sketch <b>{sketchWords(value.sketch)}</b>
        </span>
        <button onClick={onEditSketch} title="Open the sketch to change its shapes; Done brings you back here"
                style={{ fontSize: '12px', padding: '2px 8px', cursor: 'pointer', borderRadius: '4px',
                         background: palette.buttonBg, color: palette.text, border: `1px solid ${palette.border}` }}>
          Edit sketch
        </button>
      </div>
      {placement}
      {firstBody ? (
        <div style={{ color: palette.text, lineHeight: 1.4 }}>
          <b>New body</b>
          <div style={{ color: palette.textSecondary }}>This line makes the part: it stays a new body.</div>
        </div>
      ) : (
        <div style={{ display: 'flex' }}>
          <button style={{ ...seg(value.op === 'cut'), borderRadius: '4px 0 0 4px' }} onClick={() => set({ op: 'cut', flip: value.op === 'cut' && value.flip })}
                  title="Remove the shapes from the part (holes, pockets): into the part">Cut</button>
          <button style={{ ...seg(value.op === 'join'), borderRadius: '0 4px 4px 0', borderLeft: 'none' }}
                  onClick={() => set({ op: 'join', flip: value.op === 'join' && value.flip })}
                  title="Add the shapes to the part (pegs, bosses): out of the face">Join</button>
        </div>
      )}
      {extents.length > 1 && (
        <label style={row}>
          <span style={{ width: 56 }}>Extent</span>
          <select value={extent} onChange={(e) => pick(e.target.value as ExtrudeExtent)} aria-label="Extent"
                  title={EXTENT_TIP[extent]}
                  style={{ flex: 1, minWidth: 0, fontSize: '12px', padding: '2px 4px', background: palette.inputBg,
                           color: palette.text, border: `1px solid ${palette.border}`, borderRadius: '3px' }}>
            {extents.map((e) => (
              <option key={e} value={e} title={EXTENT_TIP[e]}>
                {EXTENT_TEXT[e]}{e === 'through' && value.datum ? ' (both ways)' : ''}
              </option>
            ))}
          </select>
        </label>
      )}
      {!until && (
        <label style={{ ...row, opacity: through ? 0.45 : 1 }}>
          <span style={{ width: 56 }}>{both ? 'Each way' : value.op === 'cut' ? 'Depth' : 'Height'}</span>
          <DepthInput depth={value.depth} flip={value.flip} both={both} disabled={through} autoFocus
                      onChange={set} style={num} />
          <span style={{ color: palette.textSecondary, flex: 1 }}>mm</span>
          {param && !through && <ParamChip name={param} />}
        </label>
      )}
      {until && param && (
        <div style={{ color: palette.textSecondary, lineHeight: 1.35 }}>
          The depth stays in <ParamChip name={param} /> for switching back to Distance.
        </div>
      )}
      {extent === 'face' && (
        <>
          <div style={{ ...row, alignItems: 'flex-start' }}>
            <span style={{ width: 56 }}>Face</span>
            <span style={{ flex: 1, minWidth: 0, lineHeight: 1.35 }}>
              {value.face ? <b>{value.face.hint ?? 'face'}</b>
                : <span style={{ color: palette.textSecondary }}>Click a face in the view</span>}
              {hoverHint && (
                <div style={{ color: palette.textSecondary }}>pointer on: {hoverHint}</div>
              )}
            </span>
          </div>
          <div style={{ ...row, alignItems: 'flex-start' }}>
            <span style={{ width: 56, paddingTop: 3 }}>Offset</span>
            <ParamExprInput value={amountText(value.offset)} onChange={(t) => set({ offset: t })} params={params} unit="mm"
                            width={80} title="Past the face (positive: overlap into it) or short of it (negative: a gap)" />
            <span style={{ color: palette.textSecondary, paddingTop: 3 }}>mm</span>
          </div>
        </>
      )}
      {value.datum && extent === 'distance' && (
        <label style={row} title="Extrude the depth to both sides of the plane, so the plane is the middle">
          <input type="checkbox" checked={both} onChange={(e) => set({ both: e.target.checked })} />
          Both ways (symmetric)
        </label>
      )}
      <label style={{ ...row, opacity: flipOff ? 0.45 : 1 }}
             title={extent === 'face' ? 'Which way to look for the face first (the other way is tried if it is not that way)'
               : 'Send it the other way along the face\'s normal — the preview shows where it goes'}>
        <input type="checkbox" checked={value.flip && !flipOff} disabled={flipOff}
               onChange={(e) => set({ flip: e.target.checked })} />
        Flip direction
      </label>
      <div style={note}>
        {until ? extrudeSummary({ ...value, extent }, off) : <b>{direction}</b>}
        {extent === 'next' && direction && <div><b>{direction}</b></div>}
        {extent === 'next' && (
          <div style={{ color: palette.textSecondary, marginTop: 2 }}>
            The preview shows where it stops.
          </div>
        )}
      </div>
    </OpFrame>
  );
}

// ---------------------------------------------------------------- Revolve

/** The Revolve dialog's drawing of the sketch: its shapes, the axis (long
 *  enough to run across it) and where they cross it, in sketch coordinates. */
export interface RevolveSketchView { loops: XY[][]; axis: [XY, XY] | null; crossings: XY[] }

const AXIS_KEY = (a: RevolveAxis | null): string =>
  !a ? '' : 'line' in a ? `line:${a.line}` : 'base' in a ? `base:${a.base}` : 'picked';

/** Revolve (new or reopened): the sketch, the axis (a line of the sketch, X /
 *  Y / Z, or an edge or cylinder clicked in the view), the angle, both ways,
 *  flip and the operation; a drawing of the sketch with the axis, any crossing
 *  in red; the result is previewed, its angle on a round handle. */
export function RevolveDialog({ value, onChange, editing, firstBody, sketches, choices, params, view, problem, summary,
  preview, placement, onEditSketch, onApply, onCancel }: {
  value: RevolveValues; onChange: (v: RevolveValues) => void;
  /** a project sketch: where its shapes go (its own plane, a plane, a face) */
  placement?: ReactNode;
  editing: boolean;
  /** the line makes the part: New body, and nothing else */
  firstBody: boolean;
  /** the sketches it can turn */
  sketches: string[];
  /** the sketch's lines to turn about */
  choices: AxisChoice[];
  params: Record<string, number>;
  view: RevolveSketchView;
  /** why it can't be built as it is (the axis crosses the shapes, none picked...) */
  problem: string | null;
  summary: string;
  preview: PreviewState;
  onEditSketch: () => void;
  onApply: () => void; onCancel: () => void;
}) {
  const { palette, seg, row, note } = useStyles();
  const set = (p: Partial<RevolveValues>) => onChange({ ...value, ...p });
  const a = amountValue(value.angle, params);
  const angleBad = a === null ? 'The angle must be a number or an expression of the parameters'
    : a <= 0 || a > 360 ? 'The angle is more than 0° and at most 360°' : null;
  const bad = problem ?? angleBad;
  const full = a !== null && a >= 360 - 1e-9;
  const flipOff = value.both || full;
  const ok = !bad && preview.state !== 'running' && preview.state !== 'error';
  const shown: PreviewState = bad ? { state: 'error', message: bad, fix: null } : preview;
  const key = AXIS_KEY(value.axis);
  const pickAxis = (k: string) => {
    if (k.startsWith('line:')) set({ axis: { line: k.slice(5) } });
    else if (k.startsWith('base:')) set({ axis: { base: k.slice(5) as 'X' | 'Y' | 'Z' } });
  };
  const ops: ExtrudeOp[] = firstBody ? ['new'] : ['join', 'cut'];
  const opText = { new: 'New body', join: 'Join', cut: 'Cut' } as const;
  const opTip = { new: 'The turned shape is the part', join: 'Add the turned shape to the part (a boss, a rim)',
                  cut: 'Remove the turned shape from the part (a groove, a bore)' } as const;
  const field: CSSProperties = { flex: 1, minWidth: 0, fontSize: '12px', padding: '2px 4px', background: palette.inputBg,
                                 color: palette.text, border: `1px solid ${palette.border}`, borderRadius: '3px' };
  return (
    <OpFrame title={editing ? 'Edit revolve' : 'Revolve'} preview={shown} ok={ok} onCancel={onCancel} onApply={onApply}
             applyLabel={editing ? 'Update' : value.op === 'cut' ? 'Cut' : value.op === 'join' ? 'Join' : 'Create'} width={300}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', color: palette.text }}>
        <span style={{ width: 44 }}>Sketch</span>
        {sketches.length > 1 && !editing ? (
          <select value={value.sketch} onChange={(e) => set({ sketch: e.target.value })} style={field} aria-label="Sketch">
            {sketches.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        ) : (
          <b style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
             title={value.sketch}>{sketchWords(value.sketch)}</b>
        )}
        <button onClick={onEditSketch} title="Open the sketch to change its shapes or draw an axis line; Done brings you back here"
                style={{ fontSize: '12px', padding: '2px 8px', cursor: 'pointer', borderRadius: '4px',
                         background: palette.buttonBg, color: palette.text, border: `1px solid ${palette.border}` }}>
          Edit sketch
        </button>
      </div>
      {placement}
      <div style={{ display: 'flex' }}>
        {ops.map((o, i) => (
          <button key={o} style={{ ...seg(value.op === o), borderRadius: ops.length === 1 ? '4px' : i === 0 ? '4px 0 0 4px' : '0 4px 4px 0',
                                   borderLeft: i ? 'none' : undefined }}
                  onClick={() => set({ op: o })} title={opTip[o]}>{opText[o]}</button>
        ))}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
        <label style={row}>
          <span style={{ width: 44 }}>Axis</span>
          <select value={key} onChange={(e) => pickAxis(e.target.value)} style={field} aria-label="Axis"
                  title="The line the shapes turn round: it lies in the sketch plane">
            {!key && <option value="">Pick an axis…</option>}
            <optgroup label="In the sketch">
              {choices.map((c) => <option key={c.id} value={`line:${c.id}`}>{c.label}</option>)}
            </optgroup>
            <optgroup label="Through the origin">
              {(['X', 'Y', 'Z'] as const).map((b) => <option key={b} value={`base:${b}`}>{b} axis</option>)}
            </optgroup>
            {key === 'picked' && <option value="picked">{axisLabel(value.axis)}</option>}
          </select>
        </label>
        <span style={{ color: palette.textSecondary, lineHeight: 1.35 }}>
          or click a straight edge or a cylinder in the view (its centre line)
        </span>
      </div>
      <RevolveSketchDrawing view={view} />
      <div style={{ ...row, alignItems: 'flex-start' }}>
        <span style={{ width: 44, paddingTop: 3 }}>Angle</span>
        <ParamExprInput value={amountText(value.angle)} onChange={(t) => set({ angle: t })} params={params} unit="°"
                        width={80} title="Degrees to turn: 360 makes it fully round" />
        <span style={{ color: palette.textSecondary, paddingTop: 3 }}>°</span>
        <div style={{ display: 'flex', gap: '3px', marginLeft: 'auto' }}>
          {[90, 180, 360].map((d) => (
            <button key={d} onClick={() => set({ angle: d })}
                    style={{ fontSize: '11px', padding: '1px 5px', cursor: 'pointer', borderRadius: '3px',
                             background: a === d ? palette.accent : palette.buttonBg, color: a === d ? '#fff' : palette.text,
                             border: `1px solid ${a === d ? palette.accent : palette.border}` }}>{d}</button>
          ))}
        </div>
      </div>
      <label style={{ ...row, opacity: full ? 0.45 : 1 }} title="Spread the angle evenly either side of the sketch plane">
        <input type="checkbox" checked={value.both && !full} disabled={full} onChange={(e) => set({ both: e.target.checked })} />
        Both ways (symmetric about the sketch)
      </label>
      <label style={{ ...row, opacity: flipOff ? 0.45 : 1 }}
             title="Turn the other way round the axis — the preview shows where it goes">
        <input type="checkbox" checked={value.flip && !flipOff} disabled={flipOff} onChange={(e) => set({ flip: e.target.checked })} />
        Flip direction
      </label>
      <div style={note}>
        {summary}
        {!full && (
          <div style={{ color: palette.textSecondary, marginTop: 2 }}>
            Drag the round handle to set the angle (15° steps, Shift 1°).
          </div>
        )}
      </div>
    </OpFrame>
  );
}

/** The sketch's shapes, the axis and the crossings, fitted into a strip. */
function RevolveSketchDrawing({ view }: { view: RevolveSketchView }) {
  const { palette } = useStyles();
  const pts = view.loops.flat().concat(view.crossings);
  if (!pts.length) return null;
  let x0 = Math.min(...pts.map((p) => p[0])), x1 = Math.max(...pts.map((p) => p[0]));
  let y0 = Math.min(...pts.map((p) => p[1])), y1 = Math.max(...pts.map((p) => p[1]));
  if (view.axis) {
    // the axis's nearest point to the shapes, so it shows beside them
    const [a, b] = view.axis, dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy || 1;
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, t = ((cx - a[0]) * dx + (cy - a[1]) * dy) / l2;
    const fx = a[0] + dx * t, fy = a[1] + dy * t;
    x0 = Math.min(x0, fx); x1 = Math.max(x1, fx); y0 = Math.min(y0, fy); y1 = Math.max(y1, fy);
  }
  const size = Math.max(x1 - x0, y1 - y0, 1e-3), pad = size * 0.12;
  const vb = [x0 - pad, y0 - pad, x1 - x0 + 2 * pad, y1 - y0 + 2 * pad];
  const r = size * 0.035;
  const axisLine = view.axis && (() => {
    const [a, b] = view.axis!, dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1;
    const cx = vb[0]! + vb[2]! / 2, cy = vb[1]! + vb[3]! / 2, t = ((cx - a[0]) * dx + (cy - a[1]) * dy) / l;
    const fx = a[0] + (dx / l) * t, fy = a[1] + (dy / l) * t, k = size * 4;
    return [fx - (dx / l) * k, fy - (dy / l) * k, fx + (dx / l) * k, fy + (dy / l) * k];
  })();
  return (
    <svg viewBox={vb.join(' ')} preserveAspectRatio="xMidYMid meet" role="img" aria-label="The sketch and the axis"
         style={{ width: '100%', height: 110, background: palette.buttonBg, borderRadius: '4px' }}>
      {view.loops.map((l, i) => (
        <polygon key={i} points={l.map((p) => p.join(',')).join(' ')} fill={`${palette.accent}33`} stroke={palette.text}
                 strokeWidth={1.2} vectorEffect="non-scaling-stroke" />
      ))}
      {axisLine && (
        <line x1={axisLine[0]} y1={axisLine[1]} x2={axisLine[2]} y2={axisLine[3]} stroke={palette.accent}
              strokeWidth={1.4} strokeDasharray="6 3" vectorEffect="non-scaling-stroke" />
      )}
      {view.crossings.map((p, i) => (
        <circle key={i} cx={p[0]} cy={p[1]} r={r} fill="none" stroke={palette.danger} strokeWidth={2.2}
                vectorEffect="non-scaling-stroke" />
      ))}
    </svg>
  );
}

// ---------------------------------------------------------------- Round, Lighten (reopened)

/** An auto_round()/truss_windows() line's values (op_at), and what the dialog
 *  changes: `make` the literals to move into P. */
export interface ArgOpValues {
  op: ArgOpKind;
  values: Record<string, number | boolean | string>;
  /** auto_round: the kept faces, `item` their index in the line as read
   *  (their faces in the build: RunResponse.kept) */
  keep: (KeepItem & { item?: number })[] | null;
  /** argument -> the P key holding it */
  params: Record<string, string>;
  /** argument -> its source, when written as an expression (not edited here) */
  exprs: Record<string, string>;
  make: string[];
}

/** The P key `make` will give an argument (backend ARG_OPS bases). */
const P_BASE: Record<string, string> = {
  convex: 'round_r', concave: 'blend_r', rim: 'truss_rim', rib: 'truss_rib', corner_r: 'truss_corner_r',
  keep_clear: 'truss_clear',
};

/** What a dialog sends to /build/edit_args: the changed values, and those
 *  moved into P. */
export function argOpPayload(v: ArgOpValues, orig: ArgOpValues): { values: Record<string, unknown>; keep: KeepItem[] | null;
                                                                    make_param: string[] } {
  const values: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v.values)) {
    if (k in v.exprs) continue;
    if (x !== orig.values[k] || v.make.includes(k)) values[k] = x;
  }
  const keep = v.keep && orig.keep ? v.keep.map((k) => (k.src ? { src: k.src } : { ref: k.ref })) : null;
  return { values, keep, make_param: v.make.filter((k) => !(k in v.params) && !(k in v.exprs)) };
}

function ParamChip({ name }: { name: string }) {
  const { palette } = useStyles();
  return (
    <span title={`A parameter: changing this changes P["${name}"]`}
          style={{ fontSize: '11px', fontFamily: 'ui-monospace, Menlo, monospace', color: palette.accent,
                   padding: '0 4px', border: `1px solid ${palette.border}`, borderRadius: '3px', whiteSpace: 'nowrap' }}>
      {name}
    </span>
  );
}

/** A number argument: a P key shows its name; a literal offers "make this a
 *  parameter"; an expression is shown, not edited. */
function ArgField({ label, field, v, onChange, title, step = 0.5 }: {
  label: string; field: string; v: ArgOpValues; onChange: (v: ArgOpValues) => void; title: string; step?: number;
}) {
  const { palette, row, num } = useStyles();
  const expr = v.exprs[field];
  const key = v.params[field];
  const made = v.make.includes(field);
  const x = v.values[field];
  return (
    <label style={row} title={title}>
      <span style={{ width: 74 }}>{label}</span>
      {expr != null ? (
        <span title="Written as an expression: edit it in the code"
              style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                       fontFamily: 'ui-monospace, Menlo, monospace', fontSize: '11px', color: palette.textSecondary }}>
          {expr}
        </span>
      ) : (
        <>
          <input type="number" min={0} step={step} value={typeof x === 'number' ? x : ''}
                 onChange={(e) => onChange({ ...v, values: { ...v.values, [field]: parseFloat(e.target.value) } })}
                 style={num} />
          <span style={{ color: palette.textSecondary, flex: 1 }}>mm</span>
          {key ? <ParamChip name={key} /> : made ? (
            <button onClick={(e) => { e.preventDefault(); onChange({ ...v, make: v.make.filter((m) => m !== field) }); }}
                    title={`It becomes P["${P_BASE[field] ?? field}"] when you update; click to keep it a number`}
                    style={{ background: 'none', border: 'none', color: palette.accent, cursor: 'pointer', fontSize: '11px', padding: 0 }}>
              → {P_BASE[field] ?? field} ↺
            </button>
          ) : (
            <button onClick={(e) => { e.preventDefault(); onChange({ ...v, make: [...v.make, field] }); }}
                    title="Move this number into P, so it shows with the parameters and can be dragged"
                    style={{ background: 'none', border: 'none', color: palette.textSecondary, cursor: 'pointer',
                             fontSize: '11px', padding: 0, textDecoration: 'underline', textUnderlineOffset: '2px' }}>
              make parameter
            </button>
          )}
        </>
      )}
    </label>
  );
}

const num0 = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : 0);

export function RoundDialog({ value, onChange, preview, keepFaces, onHoverFace, picked, onApply, onCancel }: {
  value: ArgOpValues; onChange: (v: ArgOpValues) => void;
  preview: PreviewState;
  /** the faces of the shown part a kept item names (to light them) */
  keepFaces: (k: KeepItem & { item?: number }) => number[];
  onHoverFace: (index: number | null) => void;
  /** the face picked in the view, to add to the kept list */
  picked: FaceRefSpec | null;
  onApply: () => void; onCancel: () => void;
}) {
  const { palette, row, note } = useStyles();
  const a = value.values;
  const keep = value.keep ?? [];
  const exprOk = (f: string) => f in value.exprs || num0(a[f]) >= 0;
  const ok = exprOk('convex') && exprOk('concave') && preview.state !== 'running';
  const canAdd = !!picked && value.keep != null && !keep.some((k) => k.ref && sameRef(k.ref, picked));
  const r = (f: string) => (f in value.exprs ? value.exprs[f] : `${num0(a[f])} mm`);
  return (
    <OpFrame title="Edit round" preview={preview} ok={ok} onCancel={onCancel} onApply={onApply} applyLabel="Update" width={300}>
      <ArgField label="Convex" field="convex" v={value} onChange={onChange} step={0.25}
                title="The radius outside edges are rounded to (0: leave them sharp)" />
      <ArgField label="Concave" field="concave" v={value} onChange={onChange} step={0.25}
                title="The radius inside corners are filled to (0: leave them sharp)" />
      <label style={row} title="Leave the face the part prints on, and the edges round it, sharp">
        <input type="checkbox" checked={a.keep_bed !== false}
               onChange={(e) => onChange({ ...value, values: { ...a, keep_bed: e.target.checked } })} />
        Keep the print bed face sharp
      </label>
      <label style={row} title="Leave the walls of small holes, and their edges, sharp">
        <input type="checkbox" checked={a.protect_holes !== false}
               onChange={(e) => onChange({ ...value, values: { ...a, protect_holes: e.target.checked } })} />
        Keep small holes sharp
      </label>
      <div style={note}>
        Rounds outside edges to <b>{r('convex')}</b> and fills inside corners to <b>{r('concave')}</b>, each capped to
        the wall there{a.keep_bed !== false ? '; the bed face stays sharp' : ''}{keep.length ? `; ${keep.length} kept face${keep.length > 1 ? 's' : ''} stay sharp` : ''}.
      </div>
      <div>
        <div style={{ color: palette.textSecondary, marginBottom: '4px' }}>Kept sharp {keep.length ? `(${keep.length})` : ''}</div>
        {value.keep == null && (
          <div style={{ color: palette.textSecondary, lineHeight: 1.4 }}>Written as an expression: edit it in the code.</div>
        )}
        {value.keep != null && keep.length === 0 && (
          <div style={{ color: palette.textSecondary, lineHeight: 1.4 }}>None besides the bed and holes.</div>
        )}
        {keep.map((k, i) => {
          const faces = keepFaces(k);
          const name = k.ref?.hint ?? k.src ?? 'face';
          return (
            <div key={`${i}|${k.src ?? ''}|${k.ref?.center.join() ?? ''}`}
                 onMouseEnter={() => onHoverFace(faces[0] ?? null)} onMouseLeave={() => onHoverFace(null)}
                 title={faces.length ? `Lit in the view${faces.length > 1 ? ` (the first of ${faces.length} faces)` : ''}${k.src ? `\n${k.src}` : ''}`
                   : `Not on the part as shown${k.src ? `\n${k.src}` : ''}`}
                 style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '2px 4px', borderRadius: '3px',
                          color: palette.text, cursor: 'default' }}
                 onMouseOver={(e) => { e.currentTarget.style.background = palette.buttonBg; }}
                 onMouseOut={(e) => { e.currentTarget.style.background = 'transparent'; }}>
              <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                             ...(k.ref ? {} : { fontFamily: 'ui-monospace, Menlo, monospace', fontSize: '11px' }) }}>
                {name}
                {faces.length > 1 && <span style={{ color: palette.textSecondary }}> · {faces.length} faces</span>}
              </span>
              <button aria-label={`Round the ${name} too`} title="Round this face too (take it off the list)"
                      onClick={() => { onHoverFace(null); onChange({ ...value, keep: keep.filter((_, j) => j !== i) }); }}
                      style={{ background: 'none', border: 'none', color: palette.textSecondary, cursor: 'pointer',
                               fontSize: '14px', lineHeight: 1, padding: '0 2px' }}>&times;</button>
            </div>
          );
        })}
        {value.keep != null && (
          <button disabled={!canAdd}
                  onClick={() => picked && onChange({ ...value, keep: [...keep, { ref: picked }] })}
                  title={canAdd ? 'Keep this face and its edges sharp' : 'Click a face of the part first'}
                  style={{ marginTop: '4px', fontSize: '12px', padding: '2px 8px', cursor: canAdd ? 'pointer' : 'default',
                           borderRadius: '4px', opacity: canAdd ? 1 : 0.5,
                           background: palette.buttonBg, color: palette.text, border: `1px solid ${palette.border}` }}>
            Add the selected face{picked?.hint ? ` (${picked.hint})` : ''}
          </button>
        )}
        <div style={{ color: palette.textSecondary, marginTop: '4px', fontSize: '11px' }}>
          Click a face of the part to select it, then add it to keep it sharp (mounting and mating faces).
        </div>
      </div>
    </OpFrame>
  );
}

export const TRUSS_PATTERNS = ['fan', 'triangulate'] as const;

export function TrussDialog({ value, onChange, preview, onApply, onCancel }: {
  value: ArgOpValues; onChange: (v: ArgOpValues) => void;
  preview: PreviewState;
  onApply: () => void; onCancel: () => void;
}) {
  const { seg, note } = useStyles();
  const a = value.values;
  const pos = (f: string) => f in value.exprs || num0(a[f]) > 0;
  const ok = pos('rim') && pos('rib') && pos('corner_r') && preview.state !== 'running';
  const t = (f: string) => (f in value.exprs ? value.exprs[f] : `${num0(a[f])} mm`);
  return (
    <OpFrame title="Edit lighten" preview={preview} ok={ok} onCancel={onCancel} onApply={onApply} applyLabel="Update" width={300}>
      <ArgField label="Rim" field="rim" v={value} onChange={onChange}
                title="The solid band kept round the plate's edge and round each hole" />
      <ArgField label="Rib" field="rib" v={value} onChange={onChange} title="The width of the ribs between the windows" />
      <ArgField label="Corner R" field="corner_r" v={value} onChange={onChange} step={0.25}
                title="The radius the windows' corners are rounded to" />
      <ArgField label="Keep clear" field="keep_clear" v={value} onChange={onChange}
                title="How far the windows stay from protected faces and bosses" />
      <div style={{ display: 'flex' }}>
        {TRUSS_PATTERNS.map((p, i) => (
          <button key={p} onClick={() => onChange({ ...value, values: { ...a, pattern: p } })}
                  style={{ ...seg(a.pattern === p), borderRadius: i ? '0 4px 4px 0' : '4px 0 0 4px', borderLeft: i ? 'none' : undefined }}
                  title={p === 'fan' ? 'Ribs radiate from the anchors' : 'Ribs join the anchors in triangles'}>
            {p === 'fan' ? 'Fan' : 'Triangulate'}
          </button>
        ))}
      </div>
      <div style={note}>
        Cuts windows between ribs <b>{t('rib')}</b> wide that {a.pattern === 'triangulate' ? 'join the anchors in triangles' : 'fan out from the anchors'},
        keeping a <b>{t('rim')}</b> rim round the edge and holes and {t('keep_clear')} clear of protected faces; window corners
        rounded {t('corner_r')}.
      </div>
    </OpFrame>
  );
}

// ---------------------------------------------------------------- construction planes

/** The plane previews are drawn in the view as they are typed (no candidate
 *  build): the frame says "preview" while the values make a plane. */
const planePreview = (problem: string | null): PreviewState =>
  problem ? { state: 'error', message: problem, fix: null } : { state: 'ok', message: '', fix: null };

const BASE_WORDS: Record<BaseName, string> = { XY: 'XY plane', XZ: 'XZ plane', YZ: 'YZ plane' };

/** Offset plane: a name, what it is offset from (the face picked, or a base
 *  plane) and the distance (a number or an expression of P names). */
export function OffsetPlaneDialog({ value, onChange, editing, params, used, own, onApply, onCancel }: {
  value: OffsetPlaneValues; onChange: (v: OffsetPlaneValues) => void;
  editing: boolean;
  params: Record<string, number>;
  /** the planes already defined (a new name must differ), and this one's own name */
  used: string[]; own?: string;
  onApply: () => void; onCancel: () => void;
}) {
  const { palette, seg, row, note } = useStyles();
  const set = (p: Partial<OffsetPlaneValues>) => onChange({ ...value, ...p });
  const d = amountValue(value.distance, params);
  const nameBad = planeNameProblem(value.name, used, own);
  const problem = nameBad ?? (d === null ? 'The distance must be a number or an expression of the parameters' : null)
    ?? (value.base === 'face' && !value.face ? 'Click a flat face in the view, or pick a base plane' : null);
  const baseText = value.base === 'face' ? (value.face?.hint ?? 'face') : BASE_WORDS[value.base];
  const bases: (BaseName | 'face')[] = ['face', 'XY', 'XZ', 'YZ'];
  return (
    <OpFrame title={editing ? 'Edit offset plane' : 'Offset plane'} preview={planePreview(problem)} ok={!problem}
             onCancel={onCancel} onApply={onApply} applyLabel={editing ? 'Update' : 'Add plane'} width={300}>
      <label style={row}>
        <span style={{ width: 56 }}>Name</span>
        <input value={value.name} onChange={(e) => set({ name: e.target.value })} spellCheck={false}
               style={{ flex: 1, fontSize: '12px', padding: '2px 4px', background: palette.inputBg, color: palette.text,
                        border: `1px solid ${nameBad ? palette.danger : palette.border}`, borderRadius: '3px' }} />
      </label>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
        <span style={{ color: palette.textSecondary }}>Offset from</span>
        <div style={{ display: 'flex' }}>
          {bases.map((b, i) => (
            <button key={b} onClick={() => set({ base: b })}
                    title={b === 'face' ? (value.face ? `The ${value.face.hint} (click another flat face to change it)`
                      : 'Click a flat face in the view') : `The ${BASE_WORDS[b]} through the origin`}
                    style={{ ...seg(value.base === b), borderRadius: i === 0 ? '4px 0 0 4px' : i === bases.length - 1 ? '0 4px 4px 0' : 0,
                             borderLeft: i ? 'none' : undefined }}>
              {b === 'face' ? 'Face' : b}
            </button>
          ))}
        </div>
        {value.base === 'face' && (
          <span style={{ color: value.face ? palette.text : palette.textSecondary }}>
            {value.face ? <>The <b>{value.face.hint}</b> · click another flat face to change it</> : 'Click a flat face in the view'}
          </span>
        )}
      </div>
      <div style={{ ...row, alignItems: 'flex-start' }}>
        <span style={{ width: 56, paddingTop: 3 }}>Distance</span>
        <ParamExprInput value={amountText(value.distance)} onChange={(t) => set({ distance: t })} params={params}
                        unit="mm" autoFocus title="A number, or an expression of the parameters (e.g. -width / 2); negative goes into the part" />
        <span style={{ color: palette.textSecondary, paddingTop: 3 }}>mm</span>
      </div>
      <div style={note}>
        <b>{value.name.trim() || 'The plane'}</b>: {offsetSummary(baseText, d)}.
        <div style={{ color: palette.textSecondary, marginTop: 2 }}>
          Drag the arrow on the plane to change the distance (it snaps to parallel faces).
        </div>
      </div>
    </OpFrame>
  );
}

/** Plane on edge: a name, the angle (a number or an expression of P names)
 *  and which of the edge's two faces is 0°. */
export function EdgePlaneDialog({ value, onChange, editing, params, used, own, onHoverFace, onApply, onCancel }: {
  value: EdgePlaneValues; onChange: (v: EdgePlaneValues) => void;
  editing: boolean;
  params: Record<string, number>;
  used: string[]; own?: string;
  onHoverFace: (index: number | null) => void;
  onApply: () => void; onCancel: () => void;
}) {
  const { palette, seg, row, note } = useStyles();
  const set = (p: Partial<EdgePlaneValues>) => onChange({ ...value, ...p });
  const a = amountValue(value.angle, params);
  const nameBad = planeNameProblem(value.name, used, own);
  const problem = nameBad ?? (a === null ? 'The angle must be a number or an expression of the parameters' : null);
  const face = value.faces[value.from];
  return (
    <OpFrame title={editing ? 'Edit plane on edge' : 'Plane on edge'} preview={planePreview(problem)} ok={!problem}
             onCancel={onCancel} onApply={onApply} applyLabel={editing ? 'Update' : 'Add plane'} width={300}>
      <label style={row}>
        <span style={{ width: 56 }}>Name</span>
        <input value={value.name} onChange={(e) => set({ name: e.target.value })} spellCheck={false}
               style={{ flex: 1, fontSize: '12px', padding: '2px 4px', background: palette.inputBg, color: palette.text,
                        border: `1px solid ${nameBad ? palette.danger : palette.border}`, borderRadius: '3px' }} />
      </label>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
        <span style={{ color: palette.textSecondary }}>0° is in the</span>
        <div style={{ display: 'flex' }} onMouseLeave={() => onHoverFace(face?.index ?? null)}>
          {value.faces.map((f, i) => (
            <button key={i} onClick={() => set({ from: i })} onMouseEnter={() => onHoverFace(f.index)}
                    title={`At 0° the plane lies in the ${f.hint}`}
                    style={{ ...seg(value.from === i), borderRadius: i === 0 ? '4px 0 0 4px' : '0 4px 4px 0',
                             borderLeft: i ? 'none' : undefined, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {f.hint}
            </button>
          ))}
        </div>
      </div>
      <div style={{ ...row, alignItems: 'flex-start' }}>
        <span style={{ width: 56, paddingTop: 3 }}>Angle</span>
        <ParamExprInput value={amountText(value.angle)} onChange={(t) => set({ angle: t })} params={params} unit="°"
                        autoFocus title="Degrees about the edge: positive tilts out of the part, negative into it" />
        <span style={{ color: palette.textSecondary, paddingTop: 3 }}>°</span>
      </div>
      <div style={note}>
        <b>{value.name.trim() || 'The plane'}</b>: through the edge, {edgeSummary(face?.hint ?? 'face', a)}.
        <div style={{ color: palette.textSecondary, marginTop: 2 }}>
          Drag the round handle to turn it about the edge (1° steps, Shift 0.1°).
        </div>
      </div>
    </OpFrame>
  );
}

const TANGENT_REFS: TangentRef[] = ['auto', 'X', 'Y', 'Z', 'face'];

/** Tangent plane: a name, the angle round the cylinder (a number or an
 *  expression of P names) and what 0° is (the base axis most nearly square
 *  to the cylinder, X / Y / Z, or a flat face picked in the view). */
export function TangentPlaneDialog({ value, onChange, editing, params, used, own, onApply, onCancel }: {
  value: TangentPlaneValues; onChange: (v: TangentPlaneValues) => void;
  editing: boolean;
  params: Record<string, number>;
  used: string[]; own?: string;
  onApply: () => void; onCancel: () => void;
}) {
  const { palette, seg, row, note } = useStyles();
  const set = (p: Partial<TangentPlaneValues>) => onChange({ ...value, ...p });
  const a = amountValue(value.angle, params);
  const nameBad = planeNameProblem(value.name, used, own);
  const zero = tangentZero(value.cyl, value.ref, value.refFace);
  const refBad = zero ? null : value.ref === 'face'
    ? (value.refFace ? `The ${value.refFace.hint} is square to the cylinder's axis: pick another face or an axis`
      : 'Click a flat face in the view to measure the angle from')
    : `${value.ref === 'auto' ? 'No axis' : value.ref} runs along the cylinder's axis: pick another reference`;
  const problem = nameBad ?? (a === null ? 'The angle must be a number or an expression of the parameters' : null) ?? refBad;
  const cylText = `Ø${+(value.cyl.radius * 2).toFixed(3)} ${value.cyl.inward ? 'bore' : 'cylinder'}`;
  return (
    <OpFrame title={editing ? 'Edit tangent plane' : 'Tangent plane'} preview={planePreview(problem)} ok={!problem}
             onCancel={onCancel} onApply={onApply} applyLabel={editing ? 'Update' : 'Add plane'} width={300}>
      <label style={row}>
        <span style={{ width: 56 }}>Name</span>
        <input value={value.name} onChange={(e) => set({ name: e.target.value })} spellCheck={false}
               style={{ flex: 1, fontSize: '12px', padding: '2px 4px', background: palette.inputBg, color: palette.text,
                        border: `1px solid ${nameBad ? palette.danger : palette.border}`, borderRadius: '3px' }} />
      </label>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
        <span style={{ color: palette.textSecondary }}>0° is toward</span>
        <div style={{ display: 'flex' }}>
          {TANGENT_REFS.map((r, i) => (
            <button key={r} onClick={() => set({ ref: r })}
                    title={r === 'auto' ? 'The base axis most nearly square to the cylinder'
                      : r === 'face' ? (value.refFace ? `The ${value.refFace.hint} (click another flat face to change it)`
                        : 'A flat face, e.g. a shaft\'s flat: click it in the view')
                      : `The ${r} axis, seen square to the cylinder`}
                    style={{ ...seg(value.ref === r), borderRadius: i === 0 ? '4px 0 0 4px' : i === TANGENT_REFS.length - 1 ? '0 4px 4px 0' : 0,
                             borderLeft: i ? 'none' : undefined }}>
              {r === 'auto' ? 'Auto' : r === 'face' ? 'Face' : r}
            </button>
          ))}
        </div>
        {value.ref === 'face' && (
          <span style={{ color: value.refFace ? palette.text : palette.textSecondary }}>
            {value.refFace ? <>The <b>{value.refFace.hint}</b> · click another flat face to change it</>
              : 'Click a flat face in the view (a shaft\'s flat, a side)'}
          </span>
        )}
      </div>
      <div style={{ ...row, alignItems: 'flex-start' }}>
        <span style={{ width: 56, paddingTop: 3 }}>Angle</span>
        <ParamExprInput value={amountText(value.angle)} onChange={(t) => set({ angle: t })} params={params} unit="°"
                        autoFocus title="Degrees round the cylinder's axis from 0° (right-handed about the axis)" />
        <span style={{ color: palette.textSecondary, paddingTop: 3 }}>°</span>
      </div>
      <div style={note}>
        <b>{value.name.trim() || 'The plane'}</b>: {tangentSummary(cylText, tangentRefLabel(value), a, value.cyl.inward)}.
        Sketch x runs along the cylinder from its end, y round it.
        <div style={{ color: palette.textSecondary, marginTop: 2 }}>
          Drag the round handle to turn it round the cylinder (5° steps, Shift 1°; it holds at 0°, 90°, 180°), or click
          the cylinder where it should touch.
        </div>
      </div>
    </OpFrame>
  );
}

// ---------------------------------------------------------------- Mirror

/** A Mirror dialog's values: the plane, and (Mirror body) whether the mirror
 *  image joins the part, and when it doesn't how far apart (`gap`: mm, or an
 *  expression of P names). `face`: the flat face picked, kept while another
 *  plane is tried. */
export interface MirrorValues {
  plane: MirrorPlane | null;
  join: boolean;
  gap: Amount;
  face: FaceRefSpec | null;
}

/** A step Mirror steps was given: what it is, and why it can't be mirrored (null: it can). */
export interface MirrorStepRow { line: number; label: string; reason: string | null }

/** Mirror body / Mirror steps: the plane (the face picked, XY, XZ, YZ or a
 *  construction plane), Join or Separate body (Mirror body), the steps it
 *  copies and those it can't (Mirror steps); the result is previewed. */
export function MirrorOpDialog({ kind, value, onChange, editing, preview, planes, params = {}, steps = [], after = null,
                                 onApply, onCancel }: {
  kind: 'body' | 'steps';
  value: MirrorValues; onChange: (v: MirrorValues) => void;
  editing: boolean;
  preview: PreviewState;
  /** the P values, for a gap written as an expression */
  params?: Record<string, number>;
  /** the construction planes the script defines */
  planes: string[];
  steps?: MirrorStepRow[];
  /** the line the copies go after */
  after?: number | null;
  onApply: () => void; onCancel: () => void;
}) {
  const { palette, seg, row, note } = useStyles();
  const set = (p: Partial<MirrorValues>) => onChange({ ...value, ...p });
  const p = value.plane;
  const on = (b: 'face' | 'XY' | 'XZ' | 'YZ') => (b === 'face' ? !!p && 'face' in p : !!p && 'base' in p && p.base === b);
  const named = p && 'plane' in p ? p.plane : '';
  const gap = kind === 'body' && !value.join ? amountValue(value.gap, params) : 0;
  const ok = !!p && gap !== null && preview.state !== 'running' && preview.state !== 'error'
    && (kind === 'body' || steps.some((s) => !s.reason));
  const bases: ('face' | 'XY' | 'XZ' | 'YZ')[] = ['face', 'XY', 'XZ', 'YZ'];
  const can = steps.filter((s) => !s.reason);
  const cant = steps.filter((s) => s.reason);
  const title = kind === 'body' ? (editing ? 'Edit mirror body' : 'Mirror body') : 'Mirror steps';
  return (
    <OpFrame title={title} preview={preview} ok={ok} onCancel={onCancel} onApply={onApply} width={300}
             applyLabel={editing ? 'Update' : kind === 'body' ? 'Mirror' : `Mirror ${can.length === 1 ? 'step' : `${can.length} steps`}`}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
        <span style={{ color: palette.textSecondary }}>Across</span>
        <div style={{ display: 'flex' }}>
          {bases.map((b, i) => (
            <button key={b} disabled={b === 'face' && !value.face}
                    onClick={() => set({ plane: b === 'face' ? (value.face ? { face: value.face } : null) : { base: b } })}
                    title={b === 'face' ? (value.face ? `The ${value.face.hint ?? 'face'} (click another flat face to change it)`
                      : 'Click a flat face in the view') : `The ${b} plane through the origin`}
                    style={{ ...seg(on(b)), borderRadius: i === 0 ? '4px 0 0 4px' : i === bases.length - 1 ? '0 4px 4px 0' : 0,
                             borderLeft: i ? 'none' : undefined, opacity: b === 'face' && !value.face ? 0.5 : 1 }}>
              {b === 'face' ? 'Face' : b}
            </button>
          ))}
        </div>
        {planes.length > 0 && (
          <label style={{ display: 'flex', alignItems: 'center', gap: '6px', color: palette.text }}>
            <span style={{ color: palette.textSecondary }}>or plane</span>
            <select value={named} onChange={(e) => { if (e.target.value) set({ plane: { plane: e.target.value } }); }}
                    style={{ flex: 1, fontSize: '12px', padding: '2px 4px', background: named ? palette.accent : palette.inputBg,
                             color: named ? '#fff' : palette.text, border: `1px solid ${named ? palette.accent : palette.border}`,
                             borderRadius: '3px' }}>
              <option value="">{named ? '' : 'a construction plane…'}</option>
              {planes.map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
        )}
        <span style={{ color: p ? palette.text : palette.textSecondary }}>
          {p && 'face' in p ? <>The <b>{p.face.hint ?? 'face'}</b> · click another flat face to change it</>
            : p ? 'Or click a flat face in the view' : 'Click a flat face in the view, or pick a plane'}
        </span>
      </div>
      {kind === 'body' && (
        <div style={{ display: 'flex' }}>
          {([true, false] as const).map((j, i) => (
            <button key={String(j)} onClick={() => set({ join: j })}
                    title={j ? 'Fuse the mirror image with the part: one solid' : 'Keep the mirror image as its own body'}
                    style={{ ...seg(value.join === j), borderRadius: i === 0 ? '4px 0 0 4px' : '0 4px 4px 0',
                             borderLeft: i ? 'none' : undefined }}>
              {j ? 'Join' : 'Separate body'}
            </button>
          ))}
        </div>
      )}
      {kind === 'body' && !value.join && (
        <div style={{ ...row, alignItems: 'flex-start' }}>
          <span style={{ width: 56, paddingTop: 3 }}>Gap</span>
          <ParamExprInput value={amountText(value.gap)} onChange={(t) => set({ gap: t })} params={params} unit="mm"
                          title="How far the copy sits from the part: a number, or an expression of the parameters (e.g. wall * 2)" />
          <span style={{ color: palette.textSecondary, paddingTop: 3 }}>mm</span>
        </div>
      )}
      {kind === 'body' && (
        <div style={{ color: palette.textSecondary, marginTop: -2 }}>{mirrorBodyHint(value.join)}</div>
      )}
      {kind === 'steps' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
          {can.map((s) => (
            <div key={s.line} style={{ color: palette.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                 title={s.label}>
              ✓ {s.label} <span style={{ color: palette.textSecondary }}>· line {s.line}</span>
            </div>
          ))}
          {cant.map((s) => (
            <div key={s.line} style={{ color: palette.textSecondary }} title={s.label}>
              <span style={{ textDecoration: 'line-through' }}>{s.label}</span> · can't be mirrored: {s.reason}
            </div>
          ))}
        </div>
      )}
      <div style={note}>
        {kind === 'body' ? (gap === null ? 'The gap must be a number or an expression of the parameters.'
          : mirrorBodySummary(p, value.join, gap)) : mirrorStepsSummary(p, can.length, after)}
        <div style={{ color: palette.textSecondary, marginTop: 2 }}>
          {kind === 'body' ? 'The mirror plane is drawn in the view; the blue ghost is the result, the green part of it the mirror image.'
            : 'The plane is drawn in the view; the blue ghost is the result.'}
        </div>
      </div>
    </OpFrame>
  );
}

/** A mirrored copy reopened: it follows its original, so the original's
 *  dialog changes both; Unlink makes it a step of its own. */
export function MirrorCopyDialog({ of, across, original, onEditOriginal, onUnlink, onCancel }: {
  of: number; across: string; original: string;
  onEditOriginal: () => void; onUnlink: () => void; onCancel: () => void;
}) {
  const { palette, note } = useStyles();
  return (
    <OpFrame title="Mirrored copy" preview={IDLE} ok onCancel={onCancel} onApply={onEditOriginal} applyLabel="Edit the original">
      <div style={note}>
        This step is the mirror of <b>{original}</b> (line {of}) across <b>{across}</b>. It follows the original: edit the
        original and both change.
      </div>
      <button onClick={onUnlink} title="Drop the link: the copy keeps its values and no longer follows the original"
              style={{ alignSelf: 'flex-start', fontSize: '12px', padding: '2px 8px', cursor: 'pointer', borderRadius: '4px',
                       background: palette.buttonBg, color: palette.text, border: `1px solid ${palette.border}` }}>
        Unlink, edit it on its own
      </button>
    </OpFrame>
  );
}

// ---------------------------------------------------------------- Pattern

/** A step Pattern steps was given: what it is, and why it can't be patterned (null: it can). */
export interface PatternStepRow { line: number; label: string; reason: string | null }

/** Pattern body / Pattern steps / a pattern copy reopened: Linear (a
 *  direction, count, spacing or extent, both ways, reversed, and a second
 *  direction for a grid) or Circular (an axis, count, angle, both ways);
 *  Join or Separate (Pattern body); the steps it copies (Pattern steps).
 *  The directions are picked in the view; the instances are drawn there,
 *  numbered, and a number clicked leaves that copy out. */
export function PatternOpDialog({ kind, value, onChange, join = true, onJoin, editing, preview, params = {}, steps = [],
                                  after = null, ways, original, onEditOriginal, onUnlink, onApply, onCancel }: {
  kind: 'body' | 'steps' | 'copy';
  value: PatternValues; onChange: (v: PatternValues) => void;
  join?: boolean; onJoin?: (join: boolean) => void;
  editing: boolean;
  preview: PreviewState;
  params?: Record<string, number>;
  steps?: PatternStepRow[];
  /** the line the copies go after */
  after?: number | null;
  /** which way the directions point, as the preview built them ("+X") */
  ways: { dir: string; dir2: string; axis: string };
  /** a copy: the step it follows, in words */
  original?: string;
  onEditOriginal?: () => void; onUnlink?: () => void;
  onApply: () => void; onCancel: () => void;
}) {
  const { palette, seg, row, note } = useStyles();
  // a count changed: the skipped copies stay the same ones (where they still are)
  const set = (p: Partial<PatternValues>) => {
    const next = { ...value, ...p };
    if (!('skip' in p)) next.skip = remapSkip(value.skip, value, next, params);
    onChange(next);
  };
  const total = instanceCount(value, params);
  const can = steps.filter((s) => !s.reason);
  const cant = steps.filter((s) => s.reason);
  const num = (a: Amount) => amountValue(a, params) !== null;
  const linear = value.type === 'linear';
  const full = !linear && (() => { const a = amountValue(value.angle, params); return a !== null && Math.abs(Math.abs(a) - 360) < 1e-9; })();
  const valid = total !== null && (linear
    ? !!value.dir && num(value.mode === 'spacing' ? value.spacing : value.extent)
      && (!value.two || (!!value.dir2 && num(value.mode2 === 'spacing' ? value.spacing2 : value.extent2)))
    : !!value.axis && num(value.angle));
  const ok = valid && preview.state !== 'running' && preview.state !== 'error' && (kind !== 'steps' || can.length > 0);
  const title = kind === 'copy' ? 'Pattern copy' : kind === 'body' ? (editing ? 'Edit pattern body' : 'Pattern body') : 'Pattern steps';
  const ends = (i: number, n: number) => (i === 0 ? '4px 0 0 4px' : i === n - 1 ? '0 4px 4px 0' : 0);
  const small: CSSProperties = { fontSize: '12px', padding: '1px 7px', cursor: 'pointer', borderRadius: '4px',
                                 background: palette.buttonBg, color: palette.text, border: `1px solid ${palette.border}` };
  // a direction (or the axis): X / Y / Z, or what was picked in the view
  const dirRow = (which: 'dir' | 'dir2' | 'axis', label: string) => {
    const d = value[which];
    const picking = which === 'axis' || value.target === which;
    const flipKey = which === 'dir2' ? 'flip2' : 'flip';
    // The report's words lag the preview; X/Y/Z can be named at once.
    const way = ways[which] || (d && 'base' in d ? `${value[flipKey] ? '−' : '+'}${d.base}` : undefined);
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}
           onClick={() => { if (which !== 'axis' && value.target !== which) set({ target: which }); }}>
        <span style={{ color: palette.textSecondary }}>{label}</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <div style={{ display: 'flex', flex: 1 }}>
            {(['X', 'Y', 'Z'] as const).map((b, i) => (
              <button key={b} onClick={() => set({ [which]: { base: b }, ...(which !== 'axis' ? { target: which } : {}) })}
                      title={which === 'axis' ? `Round the ${b} axis through the origin` : `Along ${b}`}
                      style={{ ...seg(!!d && 'base' in d && d.base === b), borderRadius: ends(i, 3), borderLeft: i ? 'none' : undefined }}>
                {b}
              </button>
            ))}
          </div>
          {flipKey && (
            <button onClick={() => set({ [flipKey]: !value[flipKey] })}
                    title={which === 'axis' ? 'Turn the other way round the axis' : 'Reverse the direction'}
                    style={{ ...small, background: value[flipKey] ? palette.accent : palette.buttonBg,
                             color: value[flipKey] ? '#fff' : palette.text }}>
              ⇄ Flip
            </button>
          )}
        </div>
        <span style={{ color: palette.text, outline: picking && which !== 'axis' && value.two ? `1px dashed ${palette.accent}` : 'none',
                       borderRadius: '3px', padding: picking && which !== 'axis' && value.two ? '1px 3px' : 0 }}>
          {d && !('base' in d) ? <><b>{dirWords(d).replace(/^the /, '')}</b>{way ? <> · {which === 'axis' ? 'axis ' : 'toward '}{way}</> : null}</>
            : d && way ? <>{which === 'axis' ? 'Axis' : 'Toward'} {way}</> : null}
          {picking && (
            <span style={{ color: palette.textSecondary }}>
              {d ? ' · ' : ''}{which === 'axis'
                ? 'click a hole, a round edge or a straight edge in the view'
                : 'click an edge or a face in the view'}
            </span>
          )}
          {!picking && <span style={{ color: palette.textSecondary }}>{d ? ' · ' : ''}click here to pick an edge or face</span>}
        </span>
      </div>
    );
  };
  const amountRow = (label: string, field: keyof PatternValues, unit: string, tip: string) => (
    <div style={{ ...row, alignItems: 'flex-start' }}>
      <span style={{ width: 56, paddingTop: 3 }}>{label}</span>
      <ParamExprInput value={amountText(value[field] as Amount)} onChange={(t) => set({ [field]: t })} params={params}
                      unit={unit} width={90} title={tip} />
      <span style={{ color: palette.textSecondary, paddingTop: 3 }}>{unit}</span>
    </div>
  );
  const spacingRow = (second: boolean) => {
    const mode = second ? value.mode2 : value.mode;
    const modeKey = second ? 'mode2' : 'mode';
    return (
      <>
        {amountRow('Count', second ? 'count2' : 'count', '', second ? 'How many rows, the first among them' : 'How many, the original among them')}
        <div style={{ display: 'flex' }}>
          {(['spacing', 'extent'] as const).map((m, i) => (
            <button key={m} onClick={() => set({ [modeKey]: m })}
                    title={m === 'spacing' ? 'The distance from one to the next' : 'The distance from the first to the last: the count is fitted evenly within it'}
                    style={{ ...seg(mode === m), borderRadius: ends(i, 2), borderLeft: i ? 'none' : undefined }}>
              {m === 'spacing' ? 'Spacing' : 'Extent'}
            </button>
          ))}
        </div>
        {amountRow(mode === 'spacing' ? 'Spacing' : 'Extent',
                   (second ? (mode === 'spacing' ? 'spacing2' : 'extent2') : mode) as keyof PatternValues, 'mm',
                   'A number, or an expression of the parameters')}
      </>
    );
  };
  const check = (label: string, on: boolean, flip: () => void, tip: string, disabled = false) => (
    <label title={tip} style={{ ...row, cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.5 : 1 }}>
      <input type="checkbox" checked={on} disabled={disabled} onChange={flip} /> {label}
    </label>
  );
  const shownSkip = value.skip.filter((i) => total === null || i < total);
  return (
    <OpFrame title={title} preview={preview} ok={ok} onCancel={onCancel} onApply={onApply} width={300}
             applyLabel={editing || kind === 'copy' ? 'Update' : kind === 'body' ? 'Pattern'
               : `Pattern ${can.length === 1 ? 'step' : `${can.length} steps`}`}>
      {kind === 'copy' && (
        <div style={note}>
          A copy of <b>{original}</b>: it follows the original. Change the pattern here (all the copies made with it
          change), or edit the original.
          <div style={{ display: 'flex', gap: '6px', marginTop: 5, flexWrap: 'wrap' }}>
            <button onClick={onEditOriginal} style={small}>Edit the original</button>
            <button onClick={onUnlink} style={small} title="Drop the link: the copy keeps its values and no longer follows the original">
              Unlink
            </button>
          </div>
        </div>
      )}
      <div style={{ display: 'flex' }}>
        {(['linear', 'circular'] as const).map((t, i) => (
          <button key={t} onClick={() => {
            if (t === value.type) return;
            // the direction picked carries over as the axis, and back
            const keep = t === 'circular' ? value.dir : value.axis;
            onChange({ ...value, type: t, skip: [], ...(t === 'circular'
              ? { axis: value.axis ?? (keep && !('base' in keep) ? keep : { base: 'Z' }), count: 6, angle: 360 }
              : { dir: value.dir ?? (keep && !('base' in keep) ? keep : { base: 'X' }), count: 3 }) });
          }} title={t === 'linear' ? 'In a row, or a grid' : 'Round an axis'}
                  style={{ ...seg(value.type === t), borderRadius: ends(i, 2), borderLeft: i ? 'none' : undefined }}>
            {t === 'linear' ? 'Linear' : 'Circular'}
          </button>
        ))}
      </div>
      {linear ? (
        <>
          {dirRow('dir', value.two ? 'First direction' : 'Direction')}
          {spacingRow(false)}
          {check('Both ways (symmetric)', value.symmetric, () => set({ symmetric: !value.symmetric }),
                 'As many copies again the other way from the original')}
          {check('Second direction (a grid)', value.two, () => set({ two: !value.two, target: value.two ? 'dir' : 'dir2' }),
                 'Rows of them along a second direction')}
          {value.two && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '9px', paddingLeft: 10,
                          borderLeft: `2px solid ${palette.border}` }}>
              {dirRow('dir2', 'Second direction')}
              {spacingRow(true)}
            </div>
          )}
        </>
      ) : (
        <>
          {dirRow('axis', 'Axis')}
          {amountRow('Count', 'count', '', 'How many, the original among them')}
          {amountRow('Angle', 'angle', '°', '360: spread evenly round the full circle; less: from the first to the last')}
          {check('Both ways (symmetric)', value.symmetric && !full, () => set({ symmetric: !value.symmetric }),
                 full ? 'Round the full circle there is no other way' : 'As many again turning the other way', full)}
        </>
      )}
      {kind === 'body' && onJoin && (
        <div style={{ display: 'flex' }}>
          {([true, false] as const).map((j, i) => (
            <button key={String(j)} onClick={() => onJoin(j)}
                    title={j ? 'Fuse the copies with the part: one solid' : 'Keep each copy as its own body'}
                    style={{ ...seg(join === j), borderRadius: ends(i, 2), borderLeft: i ? 'none' : undefined }}>
              {j ? 'Join' : 'Separate bodies'}
            </button>
          ))}
        </div>
      )}
      {kind === 'steps' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
          {can.map((s) => (
            <div key={s.line} style={{ color: palette.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                 title={s.label}>
              ✓ {s.label} <span style={{ color: palette.textSecondary }}>· line {s.line}</span>
            </div>
          ))}
          {cant.map((s) => (
            <div key={s.line} style={{ color: palette.textSecondary }} title={s.label}>
              <span style={{ textDecoration: 'line-through' }}>{s.label}</span> · can't be patterned: {s.reason}
            </div>
          ))}
        </div>
      )}
      <div style={{ color: palette.text }}>
        {shownSkip.length ? <>Left out: {shownSkip.map((i) => `#${i}`).join(', ')}{' '}
          <button onClick={() => set({ skip: [] })} style={{ ...small, padding: '0 5px' }}>Restore all</button></>
          : <span style={{ color: palette.textSecondary }}>Click a copy's number in the view to leave it out.</span>}
      </div>
      <div style={note}>
        {patternSummary(value, params, kind === 'body' ? { kind: 'body', join } : kind === 'copy' ? { kind: 'copy', of: original ?? 'the step' }
          : { kind: 'steps', n: can.length, after })}
        <div style={{ color: palette.textSecondary, marginTop: 2 }}>
          The blue ghost is the result; in the view the orange box is the original (#0), green boxes the copies,
          crossed grey ones left out. {linear ? 'Drag the arrow on the last copy for the spacing; Tab switches to the count.'
            : full ? '' : 'Drag the arc handle for the angle.'}
        </div>
      </div>
    </OpFrame>
  );
}
