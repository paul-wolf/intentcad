import { useState } from 'react';
import { useEditorStore } from '@/stores/editorStore';
import { useDocumentStore } from '@/stores/documentStore';
import { useThemeStore } from '@/theme';
import { requestSave } from '@/api/autoSave';

export function CircularCopyDialog() {
  const circularCopyEntityIds = useEditorStore((s) => s.circularCopyEntityIds);
  const circularCopyPickingCenter = useEditorStore((s) => s.circularCopyPickingCenter);
  const circularCopyCenter = useEditorStore((s) => s.circularCopyCenter);
  const palette = useThemeStore((s) => s.palette);

  const [count, setCount] = useState(6);
  const [manualX, setManualX] = useState('');
  const [manualY, setManualY] = useState('');

  if (!circularCopyEntityIds || circularCopyPickingCenter) return null;

  const cancel = () => {
    useEditorStore.getState().setCircularCopyEntityIds(null);
  };

  const pickCenter = () => {
    useEditorStore.getState().setCircularCopyPickingCenter(true);
  };

  const applyManualCenter = () => {
    const x = parseFloat(manualX);
    const y = parseFloat(manualY);
    if (isNaN(x) || isNaN(y)) return;
    useEditorStore.getState().setCircularCopyCenter({ x, y });
  };

  const apply = () => {
    if (!circularCopyCenter) return;
    const validCount = Math.max(2, Math.round(count));
    useDocumentStore.getState().beginTransaction();
    const newIds = useDocumentStore.getState().circularCopyEntities(
      circularCopyEntityIds,
      circularCopyCenter,
      validCount,
    );
    useEditorStore.getState().setCircularCopyEntityIds(null);
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
        minWidth: '200px',
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          cancel();
        }
      }}
    >
      <div style={{ color: palette.text, fontSize: '14px', fontWeight: 600, marginBottom: '4px' }}>
        Circular Copy
      </div>

      {!circularCopyCenter ? (
        <>
          <button style={btnStyle} onClick={pickCenter}>
            Pick Center...
          </button>
          <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
            <label style={{ color: palette.textSecondary, fontSize: '12px' }}>X</label>
            <input
              style={inputStyle}
              value={manualX}
              onChange={(e) => setManualX(e.target.value)}
              placeholder="0"
            />
            <label style={{ color: palette.textSecondary, fontSize: '12px' }}>Y</label>
            <input
              style={inputStyle}
              value={manualY}
              onChange={(e) => setManualY(e.target.value)}
              placeholder="0"
            />
            <button
              style={{ ...btnStyle, padding: '4px 10px' }}
              onClick={applyManualCenter}
            >
              Set
            </button>
          </div>
          <button
            style={{ ...btnStyle, color: palette.textSecondary, fontSize: '12px' }}
            onClick={cancel}
          >
            Cancel
          </button>
        </>
      ) : (
        <>
          <div style={{ color: palette.textSecondary, fontSize: '12px' }}>
            Center: ({circularCopyCenter.x.toFixed(1)}, {circularCopyCenter.y.toFixed(1)})
          </div>
          <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
            <label style={{ color: palette.textSecondary, fontSize: '12px' }}>Count</label>
            <input
              style={inputStyle}
              type="number"
              min={2}
              value={count}
              onChange={(e) => setCount(Math.max(2, parseInt(e.target.value) || 2))}
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
        </>
      )}
    </div>
  );
}
