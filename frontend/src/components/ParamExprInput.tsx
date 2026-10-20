/**
 * A dialog's amount field: a number, or an expression of the part's P names
 * (`-width / 2`), as the sketch dimensions take them. The word at the caret
 * completes from P (arrows move, Tab or Enter accepts), and what the
 * expression comes to is shown under it.
 */
import { useRef, useState, type CSSProperties } from 'react';
import { useThemeStore } from '@/theme';
import { completeName, evaluateExpression, expressionNames, isExpression } from '@/utils/expression';

export function ParamExprInput({ value, onChange, params, unit, autoFocus, width = 110, title }: {
  /** the field's text (a number, or an expression of P names) */
  value: string;
  onChange: (text: string) => void;
  params: Record<string, number>;
  unit: string;
  autoFocus?: boolean;
  width?: number;
  title?: string;
}) {
  const palette = useThemeStore((s) => s.palette);
  const ref = useRef<HTMLInputElement | null>(null);
  const [caret, setCaret] = useState<number | null>(null);
  const [pick, setPick] = useState(0);
  const [focused, setFocused] = useState(false);
  const at = caret ?? value.length;
  const done = focused ? completeName(value, at, Object.keys(params)) : null;
  const matches = done?.matches.slice(0, 8) ?? [];
  const accept = (name: string) => {
    if (!done) return;
    const next = value.slice(0, done.start) + name + value.slice(at);
    const c = done.start + name.length;
    onChange(next);
    setCaret(c); setPick(0);
    window.setTimeout(() => ref.current?.setSelectionRange(c, c), 0);
  };
  let result: string | null = null, bad = false;
  if (isExpression(value)) {
    const missing = expressionNames(value).filter((n) => !(n in params));
    if (missing.length) { result = `unknown: ${missing.join(', ')}`; bad = true; }
    else {
      try {
        const v = evaluateExpression(value, params);
        result = `= ${Math.round(v * 1000) / 1000} ${unit}`;
        bad = !Number.isFinite(v);
      } catch { result = '…'; bad = true; }
    }
  } else if (value.trim() && !Number.isFinite(Number(value))) { result = 'not a number'; bad = true; }
  const box: CSSProperties = {
    width, fontSize: '12px', padding: '2px 4px', background: palette.inputBg, color: palette.text,
    border: `1px solid ${bad ? palette.danger : palette.border}`, borderRadius: '3px', fontFamily: 'ui-monospace, Menlo, monospace',
  };
  const track = (el: HTMLInputElement) => setCaret(el.selectionStart ?? el.value.length);
  return (
    <span style={{ position: 'relative', display: 'inline-flex', flexDirection: 'column', gap: '2px' }}>
      <input ref={ref} value={value} autoFocus={autoFocus} spellCheck={false} title={title}
             onChange={(e) => { onChange(e.target.value); track(e.currentTarget); setPick(0); }}
             onSelect={(e) => track(e.currentTarget)}
             onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
             onKeyDown={(e) => {
               if (!matches.length) return;
               if (e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); setPick((pick + 1) % matches.length); }
               else if (e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); setPick((pick + matches.length - 1) % matches.length); }
               else if (e.key === 'Tab' || e.key === 'Enter') {
                 e.preventDefault(); e.stopPropagation(); accept(matches[pick] ?? matches[0]!);
               }
             }}
             style={box} />
      {result && (
        <span style={{ fontSize: '11px', color: bad ? palette.danger : palette.textSecondary, fontFamily: 'ui-monospace, Menlo, monospace' }}>
          {result}
        </span>
      )}
      {matches.length > 0 && (
        <div role="listbox" style={{ position: 'absolute', top: 24, left: 0, minWidth: width, zIndex: 5,
                                    background: palette.panelBg, border: `1px solid ${palette.border}`, borderRadius: '4px',
                                    boxShadow: '0 2px 8px rgba(0,0,0,0.3)', fontFamily: 'ui-monospace, Menlo, monospace' }}>
          {matches.map((m, i) => (
            <div key={m} role="option" aria-selected={i === pick}
                 onMouseDown={(e) => { e.preventDefault(); accept(m); }}
                 style={{ padding: '2px 6px', display: 'flex', gap: '8px', justifyContent: 'space-between', cursor: 'pointer',
                          background: i === pick ? palette.buttonBg : 'transparent', color: palette.text }}>
              <span>{m}</span>
              <span style={{ color: palette.textSecondary }}>{Math.round((params[m] ?? 0) * 1000) / 1000}</span>
            </div>
          ))}
        </div>
      )}
    </span>
  );
}
