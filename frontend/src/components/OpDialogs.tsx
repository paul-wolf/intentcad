import { useEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react';
import { useThemeStore } from '@/theme';
import { ApiError, errorText, type FaceRefSpec, type RunFace, type RunResponse, type SizeFix } from '@/api/client';
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
          ? { state: 'warning', message: res.warning, fix: res.fix?.param ? res.fix : null }
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
function OpFrame({ title, children, preview, onApply, applyLabel, ok, onCancel, onFix }: {
  title: string; children: ReactNode; preview: PreviewState;
  onApply: () => void; applyLabel: string; ok: boolean; onCancel: () => void;
  onFix?: (fix: SizeFix) => void;
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
         style={{ position: 'absolute', left: 12, top: 12, width: 270, maxHeight: 'calc(100% - 24px)', overflowY: 'auto',
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
          {preview.fix?.value != null && onFix && (
            <button onClick={() => onFix(preview.fix!)}
                    style={{ alignSelf: 'flex-start', fontSize: '12px', padding: '2px 8px', cursor: 'pointer', borderRadius: '4px',
                             background: palette.buttonBg, color: palette.text, border: `1px solid ${palette.border}` }}>
              Use {preview.fix.value}
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
             onFix={(f) => set({ thickness: f.value! })}>
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
