import { useEffect, useMemo, useState } from 'react';
import { useEditorStore } from '@/stores/editorStore';
import { useDocumentStore } from '@/stores/documentStore';
import { useThemeStore } from '@/theme';
import { requestSave } from '@/api/autoSave';
import { circularCopies } from '@/utils/circularCopy';
import type { CopyPattern } from '@/types/document';

const fmt = (n: number) => String(Number(n.toFixed(3)));

export function CircularCopyDialog() {
  const circularCopyEntityIds = useEditorStore((s) => s.circularCopyEntityIds);
  const circularCopyPickingCenter = useEditorStore((s) => s.circularCopyPickingCenter);
  const circularCopyCenter = useEditorStore((s) => s.circularCopyCenter);
  const circularCopyHover = useEditorStore((s) => s.circularCopyHover);
  const copyPatternId = useEditorStore((s) => s.copyPatternId);
  // the circular copy being changed, when opened from "Edit circular copy…"
  const editing = useDocumentStore((s) => s.document.sketches.find((sk) => sk.id === s.document.activeSketchId)
    ?.patterns?.find((p): p is Extract<CopyPattern, { kind: 'circular' }> => p.id === copyPatternId && p.kind === 'circular'));
  const palette = useThemeStore((s) => s.palette);

  // the fields as typed (so "-" or "" can be on the way to a value)
  const [countText, setCountText] = useState('6');
  const [xText, setXText] = useState('');
  const [yText, setYText] = useState('');
  const count = Math.max(2, parseInt(countText) || 2);

  // editing: start from the pattern as it was made
  useEffect(() => {
    if (!circularCopyEntityIds || !editing) return;
    setCountText(String(editing.count));
    setXText(fmt(editing.center.x));
    setYText(fmt(editing.center.y));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [circularCopyEntityIds, editing?.id]);

  // a centre picked in the sketch fills the fields
  useEffect(() => {
    if (!circularCopyCenter) return;
    setXText(fmt(circularCopyCenter.x));
    setYText(fmt(circularCopyCenter.y));
  }, [circularCopyCenter]);

  const x = parseFloat(xText);
  const y = parseFloat(yText);
  const typedCenter = isNaN(x) || isNaN(y) ? null : { x, y };
  // while picking, the copies follow the pointer
  const center = circularCopyPickingCenter ? circularCopyHover : typedCenter;
  // nothing to mark once the dialog has closed
  const cx = circularCopyEntityIds ? center?.x : undefined;
  const cy = circularCopyEntityIds ? center?.y : undefined;

  // the copies, drawn in the sketch while the dialog is open
  const entities = useDocumentStore((s) => s.document.sketches.find((sk) => sk.id === s.document.activeSketchId)?.entities);
  const preview = useMemo(() => {
    if (!circularCopyEntityIds || !entities || cx === undefined || cy === undefined) return null;
    let n = 0;
    return circularCopies(entities, circularCopyEntityIds, { x: cx, y: cy }, count, () => `circular-preview-${n++}`);
  }, [circularCopyEntityIds, entities, cx, cy, count]);
  // the copies being replaced are left out while their replacements show
  const hides = useMemo(() => (editing ? new Set(editing.copyIds) : null), [editing]);
  useEffect(() => {
    useEditorStore.getState().setCopyPreview(preview, cx === undefined || cy === undefined ? null : { x: cx, y: cy }, hides);
    return () => useEditorStore.getState().setCopyPreview(null);
  }, [preview, cx, cy, hides]);

  if (!circularCopyEntityIds) return null;
  const shapes = circularCopyEntityIds.filter((id) => entities?.some((e) => e.id === id && e.type !== 'dimension')).length;

  const cancel = () => {
    useEditorStore.getState().setCircularCopyEntityIds(null);
  };

  const togglePicking = () => {
    useEditorStore.getState().setCircularCopyPickingCenter(!circularCopyPickingCenter);
  };

  const apply = () => {
    if (!typedCenter || circularCopyPickingCenter) return;
    useDocumentStore.getState().beginTransaction(editing ? 'Edit circular copy' : 'Circular copy');
    const newIds = useDocumentStore.getState().copyPattern(
      circularCopyEntityIds,
      { kind: 'circular', center: typedCenter, count },
      editing?.id,
    );
    useEditorStore.getState().setCircularCopyEntityIds(null);
    if (newIds.length > 0) {
      useEditorStore.getState().setSelectedEntityIds(new Set(newIds));
    }
    requestSave();
  };

  const canApply = !!typedCenter && !circularCopyPickingCenter;

  const btnStyle: React.CSSProperties = {
    padding: '6px 16px',
    border: `1px solid ${palette.inputBorder}`,
    borderRadius: '4px',
    background: palette.buttonBg,
    color: palette.text,
    cursor: 'pointer',
    fontSize: '13px',
  };

  const inputStyle: React.CSSProperties = {
    width: '60px',
    padding: '4px 6px',
    border: `1px solid ${palette.inputBorder}`,
    borderRadius: '4px',
    background: palette.buttonBg,
    color: palette.text,
    fontSize: '13px',
    textAlign: 'center',
  };

  const labelStyle: React.CSSProperties = { color: palette.textSecondary, fontSize: '12px' };

  return (
    <div
      style={{
        // at the side, so the copies it previews stay in view
        position: 'absolute',
        top: '12px',
        right: '12px',
        background: palette.panelBg,
        border: `1px solid ${palette.border}`,
        borderRadius: '8px',
        padding: '16px',
        zIndex: 20,
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
        alignItems: 'center',
        minWidth: '220px',
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          cancel();
        }
      }}
    >
      <div style={{ color: palette.text, fontSize: '14px', fontWeight: 600, marginBottom: '4px' }}>
        {editing ? 'Edit Circular Copy' : 'Circular Copy'}
      </div>

      {editing && (
        <button
          style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontSize: '11px',
                   color: palette.textSecondary, textDecoration: 'underline' }}
          title="Leave the existing copies alone and add another set"
          onClick={() => useEditorStore.getState().setCircularCopyEntityIds(circularCopyEntityIds)}
        >
          Make a new one instead
        </button>
      )}

      <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
        <label style={labelStyle}>Centre X</label>
        <input
          style={inputStyle}
          type="number"
          value={xText}
          placeholder="—"
          disabled={circularCopyPickingCenter}
          onChange={(e) => setXText(e.target.value)}
        />
        <label style={labelStyle}>Y</label>
        <input
          style={inputStyle}
          type="number"
          value={yText}
          placeholder="—"
          disabled={circularCopyPickingCenter}
          onChange={(e) => setYText(e.target.value)}
        />
      </div>

      <button
        style={circularCopyPickingCenter ? { ...btnStyle, borderColor: palette.accent, color: palette.accent } : btnStyle}
        onClick={togglePicking}
        title="Click a point in the sketch to turn the copies about; it snaps to points and centres"
      >
        {circularCopyPickingCenter ? 'Click the centre in the sketch…' : 'Pick centre in sketch'}
      </button>

      <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
        <label style={labelStyle} title="How many round the circle, the original included">Count</label>
        <input
          style={inputStyle}
          type="number"
          min={2}
          value={countText}
          onChange={(e) => setCountText(e.target.value)}
        />
      </div>

      <div style={{ color: palette.textSecondary, fontSize: '12px', textAlign: 'center', lineHeight: 1.4 }}>
        {count} round the centre, every {fmt(360 / count)}° · {(count - 1) * shapes}{' '}
        {editing ? `copies (was ${editing.copyIds.length})` : 'new'}
        {shapes > 1 ? ` (${shapes} shapes)` : ''}
        <br />
        <span style={{ color: palette.accent }}>
          {center ? 'Preview shown in the sketch' : 'Set a centre to see the copies'}
        </span>
      </div>

      <button
        style={{ ...btnStyle, opacity: canApply ? 1 : 0.5, cursor: canApply ? 'pointer' : 'default' }}
        disabled={!canApply}
        onClick={apply}
      >
        {editing ? 'Update' : 'Apply'}
      </button>
      <button
        style={{ ...btnStyle, color: palette.textSecondary, fontSize: '12px' }}
        onClick={cancel}
      >
        Cancel
      </button>
    </div>
  );
}
