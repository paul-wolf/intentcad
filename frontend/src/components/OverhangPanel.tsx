import type { CSSProperties } from 'react';
import type { ThemePalette } from '@/theme';
import { CEILING_DEG, THRESHOLD_MAX, THRESHOLD_MIN, THRESHOLD_STEP, type OverhangSummary } from '@/build/overhang';

/** The shader's colours (webglViewer.ts FRAG), for the legend. */
export const OVERHANG_COLORS = { steep: 'rgb(224, 71, 184)', ceiling: 'rgb(217, 26, 31)', bed: 'rgb(64, 140, 242)' };

interface Props {
  palette: ThemePalette;
  summary: OverhangSummary | null;
  threshold: number;
  /** the bed in words ("Z (the part's lowest side)", "the top face at (…)") */
  bed: string;
  /** the way into the bed in words ("−Z", "+X") */
  down: string;
  /** the bed face set for this part is gone: Z is used */
  bedMissing: boolean;
  /** a print bed face is set (Reset to Z can run) */
  bedSet: boolean;
  /** one flat face is selected (Set print bed face can run) */
  canSetBed: boolean;
  onThreshold(t: number): void;
  onSetBed(): void;
  onResetBed(): void;
  onAsk(): void;
  onOff(): void;
}

const mm2 = (a: number) => `${a < 10 ? a.toFixed(1) : Math.round(a).toLocaleString()} mm²`;

/** The overhang highlight's controls and summary, floating over the bottom of the 3D view. */
export function OverhangPanel({
  palette, summary, threshold, bed, down, bedMissing, bedSet, canSetBed, onThreshold, onSetBed, onResetBed, onAsk, onOff,
}: Props) {
  const btn = (enabled = true): CSSProperties => ({
    background: 'none', color: palette.text, border: `1px solid ${palette.border}`, borderRadius: '4px',
    fontSize: '12px', padding: '3px 8px', lineHeight: 1.3, cursor: enabled ? 'pointer' : 'default', opacity: enabled ? 1 : 0.45,
  });
  const swatch = (c: string, striped = false): CSSProperties => ({
    display: 'inline-block', width: 10, height: 10, borderRadius: 2, marginRight: 4, verticalAlign: '-1px',
    background: striped ? `repeating-linear-gradient(135deg, ${c} 0 2px, transparent 2px 5px)` : c,
    border: striped ? `1px solid ${c}` : 'none',
  });
  const steps: number[] = [];
  for (let t = THRESHOLD_MIN; t <= THRESHOLD_MAX; t += THRESHOLD_STEP) steps.push(t);
  const regions = summary?.regions.length ?? 0;
  return (
    <div data-overhang-panel style={{ pointerEvents: 'auto', background: palette.panelBg,
                  border: `1px solid ${palette.border}`, borderRadius: '6px', boxShadow: '0 4px 14px rgba(0,0,0,0.3)',
                  padding: '8px 10px', color: palette.text, fontSize: '12px', maxWidth: '100%' }}
         onMouseDown={(e) => { if (!(e.target instanceof HTMLSelectElement)) e.preventDefault(); }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '5px', flexWrap: 'wrap' }}>
        <span style={{ fontWeight: 600, marginRight: '4px' }}>Overhangs</span>
        <label style={{ display: 'flex', alignItems: 'center', gap: '4px', color: palette.textSecondary }}
               title="Faces steeper than this from vertical are flagged">
          past
          <select value={threshold} aria-label="Overhang threshold (degrees)" onChange={(e) => onThreshold(Number(e.target.value))}
                  onKeyDown={(e) => e.stopPropagation()}
                  style={{ background: palette.inputBg, color: palette.text, border: `1px solid ${palette.inputBorder}`,
                           borderRadius: '4px', padding: '1px 3px', fontSize: '12px' }}>
            {steps.map((t) => <option key={t} value={t}>{t}°</option>)}
          </select>
        </label>
        <button style={{ ...btn(canSetBed), marginLeft: '4px' }} disabled={!canSetBed} onClick={onSetBed}
                title={canSetBed ? 'Print with the selected face on the bed' : 'Select one flat face first'}>
          Set print bed face
        </button>
        <button style={btn(bedSet)} disabled={!bedSet} onClick={onResetBed}
                title={bedSet ? 'Print with the lowest side along Z on the bed again' : 'The bed is already Z'}>
          Reset to Z
        </button>
        <button style={btn(regions > 0)} disabled={!regions} onClick={onAsk}
                title={regions ? 'Put a request for printable fixes in the chat box (not sent); the flagged faces are selected'
                  : 'Nothing is flagged'}>
          Ask AI to fix
        </button>
        <button style={{ ...btn(), marginLeft: '4px' }} onClick={onOff} title="Turn the overhang highlight off (H)">Off</button>
      </div>
      <div style={{ marginTop: '5px', color: palette.textSecondary, lineHeight: 1.6, display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
        <span title={`Steeper than ${threshold}° from vertical, up to ${CEILING_DEG}°`}>
          <span style={swatch(OVERHANG_COLORS.steep)} />steep {threshold}–{CEILING_DEG}°: <b style={{ color: palette.text }}>{mm2(summary?.steepArea ?? 0)}</b>
        </span>
        <span title={`${CEILING_DEG}° and flatter: bridges and ceilings`}>
          <span style={swatch(OVERHANG_COLORS.ceiling)} />ceiling ≥ {CEILING_DEG}°: <b style={{ color: palette.text }}>{mm2(summary?.ceilingArea ?? 0)}</b>
        </span>
        <span>{regions === 0 ? 'no overhangs' : `${regions} region${regions === 1 ? '' : 's'}`}</span>
        <span style={{ color: palette.textMuted }}>areas as seen from the bed</span>
      </div>
      <div style={{ color: palette.textSecondary, lineHeight: 1.5 }}>
        <span style={swatch(OVERHANG_COLORS.bed, true)} />On the bed: {bed} · down is toward {down}
        {bedMissing && <span style={{ color: palette.warning ?? '#c78a1a' }}> · the print bed face is gone, so Z is used</span>}
      </div>
      <div style={{ color: palette.textMuted, fontSize: '11px', lineHeight: 1.45 }}>
        Hover a shaded area for its angle · select a flat face, then Set print bed face to print on it
      </div>
    </div>
  );
}
