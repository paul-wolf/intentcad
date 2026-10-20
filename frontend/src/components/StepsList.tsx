/**
 * The steps list (Operations layout, above the grid): the script's operations
 * in order, each with its icon, what it does and its line; runs of plain
 * script collapse to one row. Click selects the step (its line in the code,
 * its faces, edges or sketch in the view), double-click or Edit reopens it,
 * the eye switches it off and on, × deletes it (confirmed in the row).
 */
import { useState } from 'react';
import { useThemeStore } from '@/theme';
import type { Step } from '@/api/client';
import { stepIcon, stepLabel } from '@/build/steps';
import { OpIcon } from './OpIcons';

interface Props {
  steps: Step[];
  /** the build's problems by the step's first line */
  problems: Map<number, string[]>;
  /** the first line of the selected step */
  selected: number | null;
  onSelect(s: Step): void;
  onEdit(s: Step): void;
  onToggle(s: Step): void;
  onDelete(s: Step): void;
  /** a change is being written: the buttons wait */
  busy?: boolean;
  /** said in the delete confirm: what else goes wrong if this step goes
   *  (a construction plane: the sketches on it) */
  deleteNote?(s: Step): string | null;
}

export function StepsList({ steps, problems, selected, onSelect, onEdit, onToggle, onDelete, busy, deleteNote }: Props) {
  const palette = useThemeStore((s) => s.palette);
  const [confirm, setConfirm] = useState<number | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const ops = steps.filter((s) => s.kind === 'op').length;
  const small = { background: 'none', border: 'none', cursor: busy ? 'default' : 'pointer', padding: '0 3px',
                  fontSize: '12px', lineHeight: 1, color: palette.textSecondary, opacity: busy ? 0.5 : 1 } as const;
  return (
    <div data-steps-list style={{ borderBottom: `1px solid ${palette.border}`, display: 'flex', flexDirection: 'column',
                                  maxHeight: '42%', minHeight: 0, flexShrink: 0 }}>
      <div style={{ padding: '8px 12px 4px', fontSize: '11px', fontWeight: 600, letterSpacing: '0.04em',
                    textTransform: 'uppercase', color: palette.textSecondary }}>
        Steps {ops ? `(${ops})` : ''}
      </div>
      <div role="list" style={{ overflow: 'auto', padding: '0 6px 6px', fontSize: '12.5px' }}>
        {steps.length === 0 && (
          <div style={{ padding: '4px 6px 6px', color: palette.textSecondary }}>No steps yet: the script makes nothing.</div>
        )}
        {steps.map((s) => {
          const icon = stepIcon(s);
          const label = stepLabel(s);
          const probs = problems.get(s.line);
          const sel = selected === s.line;
          const editable = s.kind === 'op' && s.reopenable && !s.off;
          const lines = s.end_line > s.line ? `${s.line}–${s.end_line}` : `${s.line}`;
          const asking = confirm === s.line;
          return (
            <div key={`${s.line}:${s.kind}`} role="listitem"
                 onClick={() => onSelect(s)}
                 onDoubleClick={() => { if (editable) onEdit(s); }}
                 onMouseEnter={() => setHover(s.line)} onMouseLeave={() => setHover(null)}
                 title={[s.off ? 'Switched off: the build skips this line' : '',
                         editable ? 'Double-click to edit' : s.kind === 'op' && !s.off ? 'Written in a form the dialogs don’t reopen: edit it in the code' : '',
                         ...(probs ?? [])].filter(Boolean).join('\n')}
                 style={{ display: 'flex', alignItems: 'center', gap: '7px', padding: '3px 6px', borderRadius: '4px',
                          cursor: 'default', userSelect: 'none',
                          background: sel ? palette.buttonBg : hover === s.line ? `${palette.buttonBg}99` : 'transparent',
                          outline: sel ? `1px solid ${palette.border}` : 'none' }}>
              <span style={{ width: 16, display: 'flex', justifyContent: 'center', color: palette.textSecondary,
                             opacity: s.off ? 0.4 : 1 }}>
                {icon ? <OpIcon name={icon} size={16} /> : <span style={{ fontSize: '11px' }}>⋯</span>}
              </span>
              <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                             color: s.kind === 'script' ? palette.textSecondary : palette.text,
                             fontStyle: s.kind === 'script' ? 'italic' : 'normal',
                             opacity: s.off ? 0.45 : 1, textDecoration: s.off ? 'line-through' : 'none' }}>
                {label}
              </span>
              {probs && (
                <span title={probs.join('\n')} style={{ color: palette.warning ?? '#c78a1a', fontSize: '12px' }}>⚠</span>
              )}
              {asking ? (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', color: palette.text }}
                      onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
                  {(() => {
                    const note = deleteNote?.(s);
                    return note ? <span style={{ color: palette.warning ?? '#c78a1a' }}>{note}.</span> : null;
                  })()}
                  Delete?
                  <button disabled={busy} onClick={() => { setConfirm(null); onDelete(s); }}
                          style={{ ...small, color: palette.danger, fontWeight: 600 }}>Delete</button>
                  <button onClick={() => setConfirm(null)} style={small}>Keep</button>
                </span>
              ) : (
                <>
                  {s.kind === 'op' && (hover === s.line || sel) && (
                    <>
                      {editable && (
                        <button disabled={busy} title="Open its dialog with this step's values"
                                onClick={(e) => { e.stopPropagation(); onEdit(s); }} style={small}>Edit</button>
                      )}
                      <button disabled={busy} aria-label={s.off ? 'Switch on' : 'Switch off'}
                              title={s.off ? 'Switch this step back on' : 'Switch this step off: the build skips it, the line stays'}
                              onClick={(e) => { e.stopPropagation(); onToggle(s); }} style={small}>
                        {s.off ? '◌' : '◉'}
                      </button>
                      <button disabled={busy} aria-label="Delete the step" title="Delete this step (asks first)"
                              onClick={(e) => { e.stopPropagation(); setConfirm(s.line); }}
                              style={{ ...small, fontSize: '14px' }}>&times;</button>
                    </>
                  )}
                  <span style={{ color: palette.textSecondary, fontSize: '11px', fontVariantNumeric: 'tabular-nums',
                                 minWidth: 22, textAlign: 'right' }} title={`Script line${s.end_line > s.line ? 's' : ''} ${lines}`}>
                    {lines}
                  </span>
                </>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
