/**
 * The one control for a number parameter, everywhere one is edited (a
 * generated sketch's Parameters, a drawn sketch's parameters, a part's P
 * values, the project page's table): a number field, its unit and a slider.
 *
 * Moving the slider or typing only tries a value (onChange); nothing is saved
 * until the editor's Apply. The slider's range is the parameter's saved one or
 * about 0.5× to 2× its saved value (utils/paramRange.ts), so it stays put
 * while you drag; the number field can go beyond it. ⋯ sets the range.
 *
 * TrialBar is the one bar that lists the values being tried, with Reset and
 * Apply.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTokens, MONO, SANS } from '@/ui/tokens';
import { sliderRange, snap, type SavedRange } from '@/utils/paramRange';

const unitWord = (unit: string | undefined) => (unit === 'deg' ? '°' : unit ?? '');

/** A number as a person writes it: no trailing zeros, at most 4 decimals. */
export const fmt = (v: number | string | null | undefined): string =>
  typeof v === 'number' ? String(Number(v.toFixed(4))) : v == null ? '—' : String(v);

export interface ParamControlProps {
  /** the value shown: a trial value, or the saved one */
  value: number;
  /** the saved value: the automatic range comes from it */
  saved: number;
  unit?: string;
  range?: SavedRange | null;
  /** a value to try; `final` when the slider is released or Enter pressed */
  onChange: (v: number, final: boolean) => void;
  /** set the slider range (null: automatic); without it there is no ⋯ */
  onRange?: (r: SavedRange | null) => void;
  /** the word for the saved value beside a trial value: "saved", "project" */
  savedWord?: string;
  label?: ReactNode;
  title?: string;
  disabled?: boolean;
}

export function ParamControl({ value, saved, unit, range, onChange, onRange, savedWord = 'saved', label, title,
                               disabled }: ParamControlProps) {
  const t = useTokens();
  const r = sliderRange(saved, unit ?? '', range);
  const [text, setText] = useState(fmt(value));
  const [editing, setEditing] = useState(false);
  const [rangeOpen, setRangeOpen] = useState(false);
  const last = useRef(value);
  const trial = value !== saved;

  useEffect(() => { if (!editing) setText(fmt(value)); }, [value, editing]);

  const commit = () => {
    setEditing(false);
    const v = Number(text);
    if (text.trim() !== '' && isFinite(v)) { if (v !== value) onChange(v, true); }
    else setText(fmt(value));
  };
  const slide = (v: number) => { last.current = v; onChange(v, false); };
  const release = () => { if (last.current !== saved || trial) onChange(last.current, true); };

  return (
    <div title={title} style={{ fontFamily: SANS, position: 'relative' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        {label != null && (
          <span style={{ fontFamily: MONO, fontSize: '12px', color: t.text, minWidth: 0, flex: 1, overflow: 'hidden',
                         textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
        )}
        <input aria-label="Value" value={text} disabled={disabled}
          onFocus={() => setEditing(true)} onBlur={commit}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { commit(); (e.target as HTMLInputElement).blur(); }
            if (e.key === 'Escape') { setText(fmt(value)); setEditing(false); (e.target as HTMLInputElement).blur(); }
          }}
          style={{ width: 64, fontFamily: MONO, fontSize: '12px', padding: '2px 5px', borderRadius: 4, outline: 'none',
                   background: t.surface, color: t.text,
                   border: `1px solid ${trial ? t.accent : t.border2}`, boxShadow: trial ? `0 0 0 1px ${t.accent}` : 'none' }} />
        <span style={{ fontSize: '11.5px', color: t.textDim, minWidth: 18 }}>{unitWord(unit)}</span>
        {onRange && (
          <button title="Slider range" aria-label="Slider range" onClick={() => setRangeOpen((o) => !o)}
            style={{ background: 'none', border: 'none', color: t.textMute, cursor: 'pointer', padding: '0 2px', fontSize: '13px' }}>
            ⋯
          </button>
        )}
        {trial && (
          <span style={{ fontSize: '11px', color: t.textMute, whiteSpace: 'nowrap' }}>{savedWord} {fmt(saved)}</span>
        )}
      </div>
      <input type="range" aria-label="Slider" disabled={disabled}
        min={r.min} max={r.max} step={r.step} value={Math.min(r.max, Math.max(r.min, value))}
        onChange={(e) => slide(snap(Number(e.target.value), r))}
        onPointerUp={release} onKeyUp={release} onTouchEnd={release}
        style={{ width: '100%', margin: '4px 0 0', accentColor: t.accent, cursor: disabled ? 'default' : 'pointer' }} />
      {rangeOpen && onRange && (
        <RangeEditor range={range} auto={sliderRange(saved, unit ?? '', null)}
          onDone={(next) => { setRangeOpen(false); if (next !== undefined) onRange(next); }} />
      )}
    </div>
  );
}

function RangeEditor({ range, auto, onDone }: {
  range?: SavedRange | null; auto: { min: number; max: number; step: number };
  onDone: (r: SavedRange | null | undefined) => void;
}) {
  const t = useTokens();
  const [f, setF] = useState({
    min: range?.min != null ? String(range.min) : '',
    max: range?.max != null ? String(range.max) : '',
    step: range?.step != null ? String(range.step) : '',
  });
  const num = (s: string) => (s.trim() === '' || !isFinite(Number(s)) ? null : Number(s));
  const field = (k: 'min' | 'max' | 'step', word: string) => (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 2, fontSize: '11px', color: t.textDim }}>
      {word}
      <input value={f[k]} placeholder={fmt(auto[k])} aria-label={`Slider ${word}`}
        onChange={(e) => setF({ ...f, [k]: e.target.value })}
        style={{ width: 60, fontFamily: MONO, fontSize: '12px', padding: '2px 4px', borderRadius: 4,
                 border: `1px solid ${t.border2}`, background: t.surface, color: t.text }} />
    </label>
  );
  const btn = { padding: '3px 9px', borderRadius: 6, fontSize: '11.5px', cursor: 'pointer', border: `1px solid ${t.border2}`,
                background: t.surface, color: t.textDim } as const;
  return (
    <div role="dialog" aria-label="Slider range"
         style={{ position: 'absolute', right: 0, top: 26, zIndex: 20, background: t.surface, border: `1px solid ${t.border2}`,
                  borderRadius: 8, padding: 10, boxShadow: t.shadow, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ fontSize: '11.5px', color: t.text }}>Slider range <span style={{ color: t.textMute }}>(blank: automatic)</span></div>
      <div style={{ display: 'flex', gap: 8 }}>{field('min', 'Min')}{field('max', 'Max')}{field('step', 'Step')}</div>
      <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
        <button style={btn} onClick={() => onDone(undefined)}>Cancel</button>
        <button style={btn} onClick={() => onDone(null)}>Automatic</button>
        <button style={{ ...btn, background: t.accent, color: '#fff', border: 'none' }}
          onClick={() => onDone({ min: num(f.min), max: num(f.max), step: num(f.step) })}>Set</button>
      </div>
    </div>
  );
}

export interface TrialItem {
  name: string;
  value: number | string;
  saved: number | string | null | undefined;
}

/** "Trying brace_r_in = 35 (project: 42). Not saved.  [Reset] [Apply to project…]" */
export function TrialBar({ items, savedWord = 'saved', busy, note, onReset, onApply, applyLabel = 'Apply', style }: {
  items: TrialItem[];
  savedWord?: string;
  busy?: boolean;
  note?: ReactNode;
  onReset: () => void;
  onApply: () => void;
  applyLabel?: string;
  style?: React.CSSProperties;
}) {
  const t = useTokens();
  if (!items.length) return null;
  const words = items.map((i) => `${i.name} = ${fmt(i.value)} (${savedWord}: ${fmt(i.saved)})`).join(', ');
  return (
    <div role="status" aria-label="Trial values"
         style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10, padding: '6px 10px', borderRadius: 8, fontFamily: SANS,
                  fontSize: '12.5px', background: t.accentSoft, border: `1px solid ${t.accent}`, color: t.text, ...style }}>
      {/* in a narrow panel the buttons wrap under the words */}
      <span style={{ flex: '1 1 180px', minWidth: 0 }}>
        Trying {words}. Not saved.
        {busy && <span style={{ color: t.textDim, marginLeft: 8 }}>building…</span>}
        {note && <span style={{ color: t.textDim, marginLeft: 8 }}>{note}</span>}
      </span>
      <span style={{ display: 'flex', gap: 8, marginLeft: 'auto' }}>
        <button onClick={onReset}
          style={{ padding: '4px 10px', borderRadius: 6, fontSize: '12px', cursor: 'pointer', background: t.surface,
                   color: t.textDim, border: `1px solid ${t.border2}` }}>Reset</button>
        <button onClick={onApply}
          style={{ padding: '4px 10px', borderRadius: 6, fontSize: '12px', fontWeight: 600, cursor: 'pointer',
                   background: t.accent, color: '#fff', border: 'none' }}>{applyLabel}</button>
      </span>
    </div>
  );
}
