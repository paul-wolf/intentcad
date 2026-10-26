/**
 * A generated sketch's code, editable: Run (⌘/Ctrl+Enter) saves it and runs
 * it; the line it stopped at is marked, with the message under the code.
 * Earlier versions (each AI change and each Run of changed code keeps the
 * code before it) load back into the editor, to Run again.
 */
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { useThemeStore } from '@/theme';
import { highlightPython, DARK_SYNTAX, LIGHT_SYNTAX } from '@/build/pyHighlight';
import type { BrokenOutput, CodeVersion, GenError } from '@/types/generated';

const GUTTER = 46;
const LINE_H = 19.5;
const PAD = 12;

export function CodeView({ code, onChange, onRun, running, dirty, error, broken, onUndo, onSaveAnyway, history, goToLine }: {
  code: string;
  onChange: (code: string) => void;
  onRun: () => void;
  running: boolean;
  /** the code differs from the saved code */
  dirty: boolean;
  error: GenError | null;
  /** outputs parts use that the Run would drop: not saved until Save anyway */
  broken: BrokenOutput[] | null;
  onUndo: () => void;
  onSaveAnyway: () => void;
  history: CodeVersion[];
  /** scroll to this line and put the caret there ({line, n}: n changes each ask) */
  goToLine?: { line: number; n: number } | null;
}) {
  const palette = useThemeStore((s) => s.palette);
  const isDark = useThemeStore((s) => s.theme === 'dark');
  const ta = useRef<HTMLTextAreaElement | null>(null);
  const pre = useRef<HTMLPreElement | null>(null);
  const gutter = useRef<HTMLDivElement | null>(null);
  const [versions, setVersions] = useState(false);
  const [scrollTop, setScrollTop] = useState(0);

  const sync = () => {
    if (!ta.current) return;
    if (pre.current) { pre.current.scrollTop = ta.current.scrollTop; pre.current.scrollLeft = ta.current.scrollLeft; }
    if (gutter.current) gutter.current.scrollTop = ta.current.scrollTop;
    setScrollTop(ta.current.scrollTop);
  };
  useEffect(() => {
    const el = ta.current;
    if (!goToLine || !el) return;
    const lines = el.value.split('\n');
    const at = lines.slice(0, Math.max(0, goToLine.line - 1)).reduce((n, l) => n + l.length + 1, 0);
    el.focus();
    el.setSelectionRange(at, at + (lines[goToLine.line - 1]?.length ?? 0));
    el.scrollTop = Math.max(0, PAD + (goToLine.line - 1) * LINE_H - el.clientHeight / 3);
    sync();
  }, [goToLine]);

  const mono: CSSProperties = {
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '13px', lineHeight: `${LINE_H}px`, tabSize: 4,
    whiteSpace: 'pre',
  };
  const editor: CSSProperties = { ...mono, margin: 0, padding: `${PAD}px 14px ${PAD}px ${GUTTER + 8}px`, border: 0, boxSizing: 'border-box' };
  let html = highlightPython(code, isDark ? DARK_SYNTAX : LIGHT_SYNTAX);
  if (code.endsWith('\n')) html += '\n';
  const lineCount = code.split('\n').length;
  const errLine = error?.line && !dirty ? error.line : null;
  const btn: CSSProperties = {
    border: `1px solid ${palette.inputBorder}`, background: 'none', color: palette.text, borderRadius: 4, cursor: 'pointer',
    fontSize: '12px', padding: '3px 10px',
  };

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', background: palette.inputBg }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', borderBottom: `1px solid ${palette.border}`,
                    background: palette.panelBg, fontSize: '12px', color: palette.textMuted, position: 'relative' }}>
        <button onClick={onRun} disabled={running}
          title="Save the code and draw it again (⌘/Ctrl+Enter). The code before becomes a version you can go back to."
          style={{ ...btn, background: palette.primaryBtn, color: '#fff', border: 'none', opacity: running ? 0.6 : 1 }}>
          {running ? 'Running…' : 'Run'}
        </button>
        <span>{dirty ? 'Not saved: Run saves it.' : 'Saved.'}</span>
        <span style={{ flex: 1 }} />
        <button style={btn} disabled={!history.length} onClick={() => setVersions((o) => !o)}
          title={history.length ? 'The code before each change' : 'No earlier versions yet'}>
          Earlier versions ({history.length})
        </button>
        {versions && (
          <div role="menu" style={{ position: 'absolute', right: 10, top: 34, zIndex: 20, background: palette.panelBg,
                                    border: `1px solid ${palette.border}`, borderRadius: 6, boxShadow: '0 4px 14px rgba(0,0,0,0.25)',
                                    maxHeight: 300, overflowY: 'auto', minWidth: 260 }}>
            {[...history].reverse().map((h, i) => (
              <button key={`${h.at}-${i}`} role="menuitem"
                onClick={() => { setVersions(false); onChange(h.code); }}
                title="Put this code in the editor; Run saves it"
                style={{ display: 'block', width: '100%', textAlign: 'left', background: 'none', border: 'none',
                         borderBottom: `1px solid ${palette.border}`, color: palette.text, padding: '6px 10px', cursor: 'pointer',
                         fontSize: '12px' }}>
                <div>{h.label || 'before a change'}</div>
                <div style={{ color: palette.textMuted, fontSize: '11px' }}>{new Date(h.at).toLocaleString()}</div>
              </button>
            ))}
          </div>
        )}
      </div>
      {broken && broken.length > 0 && (
        <div role="alert" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', fontSize: '12.5px',
                                   background: palette.panelBg, borderBottom: `1px solid ${palette.warning}`, color: palette.text }}>
          <span style={{ flex: 1 }}>
            Not saved yet: this change would break {brokenParts(broken)} this sketch. {broken.map((b) => `${b.parts.join(', ')} use${b.parts.length === 1 ? 's' : ''} ${b.name}`).join('; ')}.
          </span>
          <button style={btn} onClick={onUndo}>Undo</button>
          <button style={{ ...btn, borderColor: palette.warning, color: palette.warning }} onClick={onSaveAnyway}>Save anyway</button>
        </div>
      )}
      <div style={{ flex: 1, position: 'relative', minHeight: 0, overflow: 'hidden' }}>
        {errLine && (
          <div aria-hidden style={{ position: 'absolute', left: 0, right: 0, height: LINE_H, pointerEvents: 'none',
                                    top: PAD + (errLine - 1) * LINE_H - scrollTop,
                                    background: `${palette.danger}26` }} />
        )}
        <pre ref={pre} aria-hidden style={{ ...editor, position: 'absolute', inset: 0, overflow: 'auto', color: palette.text,
                                             pointerEvents: 'none' }}
          dangerouslySetInnerHTML={{ __html: html }} />
        <textarea ref={ta} value={code} aria-label="Code"
          onChange={(e) => onChange(e.target.value)} onScroll={sync}
          onKeyDown={(e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); onRun(); } }}
          spellCheck={false} autoCapitalize="off" autoCorrect="off" wrap="off"
          style={{ ...editor, position: 'absolute', inset: 0, resize: 'none', background: 'transparent', color: 'transparent',
                   caretColor: palette.text, outline: 'none', overflow: 'auto' }} />
        <div ref={gutter} style={{ ...mono, position: 'absolute', left: 0, top: 0, bottom: 0, width: GUTTER, overflow: 'hidden',
                                   padding: `${PAD}px 8px ${PAD}px 0`, boxSizing: 'border-box', textAlign: 'right',
                                   color: palette.textSecondary, background: palette.inputBg, borderRight: `1px solid ${palette.border}`,
                                   userSelect: 'none', pointerEvents: 'none' }}>
          {Array.from({ length: lineCount }, (_, i) => (
            <div key={i} style={i + 1 === errLine ? { color: palette.danger, fontWeight: 700 } : undefined}>
              {i + 1 === errLine ? `▶ ${i + 1}` : i + 1}
            </div>
          ))}
        </div>
      </div>
      {error && !dirty && (
        <div role="alert" style={{ padding: '7px 10px', fontSize: '12.5px', color: palette.danger, background: palette.panelBg,
                                   borderTop: `1px solid ${palette.danger}` }}>
          {error.line ? `Line ${error.line}: ` : ''}{error.message}
        </div>
      )}
    </div>
  );
}

/** "3 parts that use", "a part that uses" */
export function brokenParts(broken: BrokenOutput[]): string {
  const n = new Set(broken.flatMap((b) => b.parts)).size;
  return n === 1 ? 'a part that uses' : `${n} parts that use`;
}
