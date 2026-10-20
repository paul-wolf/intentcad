import { useEffect, useState, type CSSProperties } from 'react';
import type { ThemePalette } from '@/theme';
import { cutSideText, sectionAxis, sectionPosition, type Section } from '@/build/section';

interface Props {
  plane: Section;
  palette: ThemePalette;
  /** a flat face is selected, so "Align to selected face" can run */
  canAlign: boolean;
  /** the arrow is being dragged (the box follows it but isn't typed into) */
  dragging: boolean;
  onAxis(axis: 0 | 1 | 2): void;
  onAlign(): void;
  onFlip(): void;
  /** a typed position: on an axis, that coordinate; else along the normal */
  onPosition(v: number): void;
  onOff(): void;
}

/** The section view's controls, floating over the bottom of the 3D view. */
export function SectionPanel({ plane, palette, canAlign, dragging, onAxis, onAlign, onFlip, onPosition, onOff }: Props) {
  const axis = sectionAxis(plane);
  const pos = sectionPosition(plane);
  const [draft, setDraft] = useState(pos.toFixed(2));
  const [typing, setTyping] = useState(false);
  useEffect(() => { if (!typing) setDraft(pos.toFixed(2)); }, [pos, typing]);
  const commit = () => {
    setTyping(false);
    const v = Number(draft.replace(',', '.'));
    if (draft.trim() && Number.isFinite(v) && Math.abs(v - pos) > 1e-9) onPosition(v);
    else setDraft(pos.toFixed(2));
  };

  const btn = (on = false, enabled = true): CSSProperties => ({
    background: on ? palette.accent : 'none', color: on ? '#fff' : palette.text,
    border: `1px solid ${on ? palette.accent : palette.border}`, borderRadius: '4px',
    fontSize: '12px', padding: '3px 8px', lineHeight: 1.3,
    cursor: enabled ? 'pointer' : 'default', opacity: enabled ? 1 : 0.45,
  });
  return (
    <div data-section-panel style={{ pointerEvents: 'auto', background: palette.panelBg,
                  border: `1px solid ${palette.border}`, borderRadius: '6px', boxShadow: '0 4px 14px rgba(0,0,0,0.3)',
                  padding: '8px 10px', color: palette.text, fontSize: '12px', maxWidth: '100%' }}
         onMouseDown={(e) => { if (!(e.target instanceof HTMLInputElement)) e.preventDefault(); }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '5px', flexWrap: 'wrap' }}>
        <span style={{ fontWeight: 600, marginRight: '4px' }}>Section</span>
        {(['X', 'Y', 'Z'] as const).map((a, i) => (
          <button key={a} style={btn(axis === a)} title={`Cut square to the ${a} axis, through the middle`}
                  onClick={() => onAxis(i as 0 | 1 | 2)}>{a}</button>
        ))}
        <button style={btn(false, canAlign)} disabled={!canAlign} onClick={onAlign}
                title={canAlign ? 'Put the plane just inside the selected face' : 'Select a flat face first'}>
          Align to selected face
        </button>
        <button style={btn()} onClick={onFlip} title="Cut away the other side instead">Flip</button>
        <label style={{ display: 'flex', alignItems: 'center', gap: '4px', marginLeft: '4px', color: palette.textSecondary }}
               title={axis ? `Where the plane is along ${axis}` : 'The plane\'s distance from the origin, along its normal'}>
          {axis ? `${axis} =` : 'at'}
          <input value={draft} inputMode="decimal" aria-label="Section position (mm)"
                 onChange={(e) => { setTyping(true); setDraft(e.target.value); }}
                 onFocus={() => setTyping(true)} onBlur={commit}
                 onKeyDown={(e) => {
                   if (e.key === 'Enter') { commit(); (e.target as HTMLInputElement).blur(); }
                   else if (e.key === 'Escape') { setTyping(false); setDraft(pos.toFixed(2)); (e.target as HTMLInputElement).blur(); }
                   e.stopPropagation();
                 }}
                 style={{ width: '68px', background: palette.inputBg, color: palette.text, textAlign: 'right',
                          border: `1px solid ${palette.inputBorder}`, borderRadius: '4px', padding: '2px 5px',
                          fontSize: '12px', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                          fontVariantNumeric: 'tabular-nums', opacity: dragging ? 0.7 : 1 }} />
          mm
        </label>
        <button style={{ ...btn(), marginLeft: '4px' }} onClick={onOff} title="Turn the section off (Z)">Off</button>
      </div>
      <div style={{ marginTop: '5px', color: palette.textSecondary, lineHeight: 1.45 }}>
        Cutting away {cutSideText(plane)} · drag the orange arrow to move it (Shift: 0.1 mm)
      </div>
      <div style={{ color: palette.textMuted, fontSize: '11px', lineHeight: 1.45 }}>
        Hover the cut for the wall thickness · click two points on its outline to measure · N looks at the cut
      </div>
    </div>
  );
}
