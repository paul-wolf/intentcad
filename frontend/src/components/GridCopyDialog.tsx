import { useEffect, useMemo, useState } from 'react';
import { useEditorStore } from '@/stores/editorStore';
import { useDocumentStore } from '@/stores/documentStore';
import { useThemeStore } from '@/theme';
import { requestSave } from '@/api/autoSave';
import { gridCopies } from '@/utils/gridCopy';

export function GridCopyDialog() {
  const gridCopyEntityIds = useEditorStore((s) => s.gridCopyEntityIds);
  const palette = useThemeStore((s) => s.palette);

  // the fields as typed (so "-" or "" can be on the way to a value)
  const [cx, setCx] = useState('3');
  const [cy, setCy] = useState('3');
  const [sx, setSx] = useState('20');
  const [sy, setSy] = useState('20');
  const countX = Math.max(1, parseInt(cx) || 1);
  const countY = Math.max(1, parseInt(cy) || 1);
  const spacingX = parseFloat(sx) || 0;
  const spacingY = parseFloat(sy) || 0;

  // the copies, drawn in the sketch while the dialog is open
  const entities = useDocumentStore((s) => s.document.sketches.find((sk) => sk.id === s.document.activeSketchId)?.entities);
  const preview = useMemo(() => {
    if (!gridCopyEntityIds || !entities) return null;
    let n = 0;
    return gridCopies(entities, gridCopyEntityIds, countX, countY, spacingX, spacingY, () => `grid-preview-${n++}`);
  }, [gridCopyEntityIds, entities, countX, countY, spacingX, spacingY]);
  useEffect(() => {
    useEditorStore.getState().setCopyPreview(preview);
    return () => useEditorStore.getState().setCopyPreview(null);
  }, [preview]);

  if (!gridCopyEntityIds) return null;
  const shapes = gridCopyEntityIds.filter((id) => entities?.some((e) => e.id === id && e.type !== 'dimension')).length;

  const cancel = () => {
    useEditorStore.getState().setGridCopyEntityIds(null);
  };

  const apply = () => {
    const validCountX = Math.max(1, Math.round(countX));
    const validCountY = Math.max(1, Math.round(countY));
    useDocumentStore.getState().beginTransaction('Grid copy');
    const newIds = useDocumentStore.getState().gridCopyEntities(
      gridCopyEntityIds,
      validCountX,
      validCountY,
      spacingX,
      spacingY,
    );
    useEditorStore.getState().setGridCopyEntityIds(null);
    if (newIds.length > 0) {
      useEditorStore.getState().setSelectedEntityIds(new Set(newIds));
    }
    requestSave();
  };

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
        Grid Copy
      </div>

      <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
        <label style={{ color: palette.textSecondary, fontSize: '12px', width: '55px' }}>H Count</label>
        <input
          style={inputStyle}
          type="number"
          min={1}
          value={cx}
          onChange={(e) => setCx(e.target.value)}
        />
      </div>

      <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
        <label style={{ color: palette.textSecondary, fontSize: '12px', width: '55px' }}>V Count</label>
        <input
          style={inputStyle}
          type="number"
          min={1}
          value={cy}
          onChange={(e) => setCy(e.target.value)}
        />
      </div>

      <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
        <label style={{ color: palette.textSecondary, fontSize: '12px', width: '55px' }}
               title="Centre to centre: the copies overlap if it is smaller than the shape">H Space</label>
        <input
          style={inputStyle}
          type="number"
          value={sx}
          onChange={(e) => setSx(e.target.value)}
        />
      </div>

      <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
        <label style={{ color: palette.textSecondary, fontSize: '12px', width: '55px' }}
               title="Centre to centre: the copies overlap if it is smaller than the shape">V Space</label>
        <input
          style={inputStyle}
          type="number"
          value={sy}
          onChange={(e) => setSy(e.target.value)}
        />
      </div>

      <div style={{ color: palette.textSecondary, fontSize: '12px', textAlign: 'center', lineHeight: 1.4 }}>
        {countX} × {countY} grid · {(countX * countY - 1) * shapes} new
        {shapes > 1 ? ` (${shapes} shapes)` : ''}
        <br />
        <span style={{ color: palette.accent }}>Preview shown in the sketch</span>
      </div>

      <button style={btnStyle} onClick={apply}>
        Apply
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
