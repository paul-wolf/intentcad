import { useEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react';
import { useThemeStore } from '@/theme';
import {
  ApiError, errorText, type FaceRefSpec, type HoleKind, type HolePreset, type HolePresets, type HoleSizeKey,
  type HolesPayload, type RunFace, type RunResponse, type SizeFix,
} from '@/api/client';
import type { Viewer } from '@/build/webglViewer';
import { faceLabel } from '@/build/faceSketch';

// The part editor's explicit operations (Shell, Hole): a dialog that writes
// one script line, with the result previewed as a ghost while it's open.

/** The colour the candidate result is drawn in. */
export const PREVIEW_COLOR: [number, number, number] = [0.36, 0.72, 0.86];

/** A script line the dialogs write or reopen: `part = shell(...)` / `part = holes(...)`. */
export const OP_LINE = /^\s*part\s*=\s*(shell|holes)\s*\(/;

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
) {
  const [preview, setPreview] = useState<PreviewState>(IDLE);
  const makeRef = useRef(make);
  makeRef.current = make;
  const runRef = useRef(run);
  runRef.current = run;
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
        const res = await runRef.current(code, ctrl.signal);
        if (ctrl.signal.aborted) return;
        viewerRef.current?.setPreviewMesh({ mesh: res.mesh, color: PREVIEW_COLOR });
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
