import { useEffect, useRef, useState } from 'react';
import { useEditorStore } from '@/stores/editorStore';
import { useDocumentStore } from '@/stores/documentStore';
import { useThemeStore } from '@/theme';
import { applyFillet } from '@/tools/filletTool';
import { filletSketch } from '@/utils/fillet';
import { evaluateExpression, isExpression } from '@/utils/expression';

const fmt = (v: number) => String(Math.round(v * 1000) / 1000);

/** The fillet tool's radius: typed (a number, or a P / parameter expression)
 *  or dragged from a corner, with what it will do. Sits at the top of the
 *  drawing, clear of the shapes. */
export function FilletPanel() {
  const state = useEditorStore((s) => (s.toolState.type === 'fillet' ? s.toolState : null));
  const partParams = useEditorStore((s) => s.partParams);
  const document = useDocumentStore((s) => s.document);
  const palette = useThemeStore((s) => s.palette);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [text, setText] = useState<string | null>(null);

  const picked = state?.corners.length ?? 0;
  const radius = state?.radius ?? 0;
  const vars = { ...(document.parameters ?? {}), ...(partParams ?? {}) };

  const valueOf = (t: string): number | null => {
    try {
      const v = isExpression(t) ? evaluateExpression(t, vars) : parseFloat(t);
      return isFinite(v) && v > 0 ? v : null;
    } catch { return null; }
  };

  // a drag changes the radius: show it (unless the text already says it)
  useEffect(() => {
    if (text != null && valueOf(text) !== radius) setText(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [radius]);

  // corners just picked: ready to type
  const hadCorners = useRef(false);
  useEffect(() => {
    if (picked > 0 && !hadCorners.current) { inputRef.current?.focus(); inputRef.current?.select(); }
    hadCorners.current = picked > 0;
  }, [picked]);

  if (!state) return null;

  const shown = text ?? fmt(radius);
  const typed = valueOf(shown);

  const sketch = document.sketches.find((s) => s.id === document.activeSketchId);
  const outcome = picked && sketch && typed
    ? filletSketch(sketch.entities, sketch.constraints, state.corners, typed, () => 'preview')
    : null;

  const commit = () => {
    if (!typed || !picked) return;
    if (applyFillet(state.corners, typed, isExpression(shown) ? shown.trim() : undefined)) {
      setText(null);
      inputRef.current?.blur();
    }
  };

  let summary: string;
  let warn = false;
  if (!picked) summary = 'Click a corner, or drag a box over several (Shift adds). Drag from a corner to size it.';
  else if (!typed) { summary = 'Radius must be a positive number or expression'; warn = true; }
  else if (!outcome) { summary = 'These corners can’t be rounded'; warn = true; }
  else {
    summary = `${outcome.rounded} corner${outcome.rounded === 1 ? '' : 's'}`;
    if (outcome.clampedTo != null) { summary += ` · too large: clamped to R ${fmt(outcome.clampedTo)}`; warn = true; }
    if (outcome.skipped) summary += ` · ${outcome.skipped} can’t be rounded`;
    summary += ' · Enter to round';
  }

  return (
    <div
      style={{
        position: 'absolute',
        top: 8,
        left: '50%',
        transform: 'translateX(-50%)',
        background: palette.panelBg,
        border: `1px solid ${palette.border}`,
        borderRadius: 6,
        padding: '6px 10px',
        zIndex: 20,
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        fontSize: 13,
        color: palette.text,
        whiteSpace: 'nowrap',
      }}
    >
      <span style={{ fontWeight: 600 }}>Fillet</span>
      <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        R
        <input
          ref={inputRef}
          value={shown}
          title="Radius: a number, or an expression using parameters / P"
          onChange={(e) => {
            setText(e.target.value);
            const v = valueOf(e.target.value);
            if (v != null) useEditorStore.getState().setToolState({ ...state, radius: v });
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); commit(); }
            if (e.key === 'Escape') {
              e.stopPropagation();
              setText(null);
              useEditorStore.getState().setToolState({ ...state, corners: [] });
              inputRef.current?.blur();
            }
          }}
          style={{
            width: 80,
            padding: '2px 4px',
            background: palette.inputBg,
            color: palette.text,
            border: `1px solid ${typed ? palette.inputBorder : '#e55'}`,
            borderRadius: 3,
            fontSize: 13,
          }}
        />
      </label>
      <span style={{ color: warn ? '#e8a33d' : palette.textSecondary, fontSize: 12 }}>{summary}</span>
      {picked > 0 && (
        <button
          onClick={commit}
          disabled={!typed}
          style={{ padding: '2px 10px', border: `1px solid ${palette.inputBorder}`, borderRadius: 4, background: palette.buttonBg, color: palette.text, cursor: 'pointer', fontSize: 12 }}
        >
          Round
        </button>
      )}
    </div>
  );
}
