import { useEffect, useRef, useState } from 'react';
import { useEditorStore } from '@/stores/editorStore';
import { useDocumentStore } from '@/stores/documentStore';
import { useThemeStore } from '@/theme';
import { applyOffset, offsetPreview, offsetSideWord, offsetSourceIds } from '@/tools/offsetTool';
import { canOffset } from '@/utils/offset';
import { evaluateExpression, isExpression } from '@/utils/expression';

const fmt = (v: number) => String(Math.round(v * 1000) / 1000);

/** The offset tool's distance (typed: a number, or a P / parameter
 *  expression; or dragged), side and corner joins, with what it will do.
 *  Sits at the top of the drawing, clear of the shapes. */
export function OffsetPanel() {
  const state = useEditorStore((s) => (s.toolState.type === 'offset' ? s.toolState : null));
  const partParams = useEditorStore((s) => s.partParams);
  const document = useDocumentStore((s) => s.document);
  const palette = useThemeStore((s) => s.palette);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [text, setText] = useState<string | null>(null);

  const sketch = document.sketches.find((s) => s.id === document.activeSketchId);
  const entities = sketch?.entities ?? [];
  const ids = state ? offsetSourceIds(state.sourceIds, entities) : [];
  const picked = ids.length;
  const distance = state?.distance ?? 0;
  const vars = { ...(document.parameters ?? {}), ...(partParams ?? {}) };

  const valueOf = (t: string): number | null => {
    try {
      const v = isExpression(t) ? evaluateExpression(t, vars) : parseFloat(t);
      return isFinite(v) && v > 0 ? v : null;
    } catch { return null; }
  };

  // a drag changes the distance: show it (unless the text already says it)
  useEffect(() => {
    if (text != null && valueOf(text) !== distance) setText(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [distance]);

  // something just picked: ready to type
  const hadPicked = useRef(false);
  useEffect(() => {
    if (picked > 0 && !hadPicked.current) { inputRef.current?.focus(); inputRef.current?.select(); }
    hadPicked.current = picked > 0;
  }, [picked]);

  if (!state) return null;

  const shown = text ?? fmt(distance);
  const typed = valueOf(shown);
  const byId = new Map(entities.map((e) => [e.id, e]));
  const valid = picked > 0 && canOffset(ids, (id) => byId.get(id));
  const closed = valid && offsetSideWord(ids, 1, entities) != null;
  const fits = valid && typed != null && !!offsetPreview(ids, typed, state.side, state.join, entities);

  const commit = () => {
    if (!typed || !fits) return;
    if (applyOffset(ids, typed, state.side, state.join, isExpression(shown) ? shown.trim() : undefined)) {
      setText(null);
      inputRef.current?.blur();
    }
  };

  let summary: string;
  let warn = false;
  if (!picked) summary = 'Click a closed shape, a circle or a chain of lines (Shift adds), then drag out to the side you want, or type the distance';
  else if (!valid) { summary = 'Pick one closed shape or circle, or lines joined end to end'; warn = true; }
  else if (!typed) { summary = 'Distance must be a positive number or expression'; warn = true; }
  else if (!fits) { summary = `Too large: the shape has no room ${offsetSideWord(ids, state.side, entities) ?? 'on that side'} for it`; warn = true; }
  else summary = `${picked === 1 ? '1 entity' : `a chain of ${picked} lines`}, ${offsetSideWord(ids, state.side, entities) ?? 'on the side the arrow shows'} · follows it · Enter to offset`;

  const toggle = (on: boolean) => ({
    padding: '2px 8px',
    border: `1px solid ${on ? palette.accent : palette.inputBorder}`,
    borderRadius: 4,
    background: on ? palette.accent : palette.buttonBg,
    color: on ? '#fff' : palette.text,
    cursor: 'pointer',
    fontSize: 12,
  });
  const setSide = (side: 1 | -1) => useEditorStore.getState().setToolState({ ...state, side });
  const setJoin = (join: 'arc' | 'miter') => useEditorStore.getState().setToolState({ ...state, join });

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
      <span style={{ fontWeight: 600 }}>Offset</span>
      <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        D
        <input
          ref={inputRef}
          value={shown}
          title="Distance: a number, or an expression using parameters / P"
          onChange={(e) => {
            setText(e.target.value);
            const v = valueOf(e.target.value);
            if (v != null) useEditorStore.getState().setToolState({ ...state, distance: v });
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); commit(); }
            if (e.key === 'Escape') {
              e.stopPropagation();
              setText(null);
              useEditorStore.getState().setToolState({ ...state, sourceIds: [] });
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
      {closed ? (
        <span style={{ display: 'flex', gap: 2 }}>
          <button style={toggle(state.side === 1)} onClick={() => setSide(1)} title="Offset outside the shape">Outside</button>
          <button style={toggle(state.side === -1)} onClick={() => setSide(-1)} title="Offset inside the shape">Inside</button>
        </span>
      ) : valid ? (
        <button style={toggle(false)} onClick={() => setSide(state.side === 1 ? -1 : 1)} title="Offset to the other side of the chain">Flip side</button>
      ) : null}
      <span style={{ display: 'flex', gap: 2 }} title="How the offset goes round sharp corners on the outside of a turn">
        <button style={toggle(state.join === 'arc')} onClick={() => setJoin('arc')}>Arcs</button>
        <button style={toggle(state.join === 'miter')} onClick={() => setJoin('miter')}>Miters</button>
      </span>
      <span style={{ color: warn ? '#e8a33d' : palette.textSecondary, fontSize: 12 }}>{summary}</span>
      {picked > 0 && (
        <button
          onClick={commit}
          disabled={!fits}
          style={{ padding: '2px 10px', border: `1px solid ${palette.inputBorder}`, borderRadius: 4, background: palette.buttonBg, color: palette.text, cursor: 'pointer', fontSize: 12 }}
        >
          Offset
        </button>
      )}
    </div>
  );
}
