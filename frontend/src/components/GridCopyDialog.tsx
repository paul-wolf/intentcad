import { useState } from 'react';
import { useEditorStore } from '@/stores/editorStore';
import { useDocumentStore } from '@/stores/documentStore';
import { useThemeStore } from '@/theme';
import { requestSave } from '@/api/autoSave';

export function GridCopyDialog() {
  const gridCopyEntityIds = useEditorStore((s) => s.gridCopyEntityIds);
  const palette = useThemeStore((s) => s.palette);

  const [countX, setCountX] = useState(3);
  const [countY, setCountY] = useState(3);
  const [spacingX, setSpacingX] = useState(20);
  const [spacingY, setSpacingY] = useState(20);

  if (!gridCopyEntityIds) return null;

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
        position: 'absolute',
        top: '50%',
        left: '50%',
        transform: 'translate(-50%, -50%)',
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
          value={countX}
          onChange={(e) => setCountX(Math.max(1, parseInt(e.target.value) || 1))}
        />
      </div>

      <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
        <label style={{ color: palette.textSecondary, fontSize: '12px', width: '55px' }}>V Count</label>
        <input
          style={inputStyle}
          type="number"
          min={1}
          value={countY}
          onChange={(e) => setCountY(Math.max(1, parseInt(e.target.value) || 1))}
        />
      </div>

      <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
        <label style={{ color: palette.textSecondary, fontSize: '12px', width: '55px' }}>H Space</label>
        <input
          style={inputStyle}
          type="number"
          value={spacingX}
          onChange={(e) => setSpacingX(parseFloat(e.target.value) || 0)}
        />
      </div>

      <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
        <label style={{ color: palette.textSecondary, fontSize: '12px', width: '55px' }}>V Space</label>
        <input
          style={inputStyle}
          type="number"
          value={spacingY}
          onChange={(e) => setSpacingY(parseFloat(e.target.value) || 0)}
        />
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
