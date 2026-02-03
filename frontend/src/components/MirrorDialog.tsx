import { useEditorStore } from '@/stores/editorStore';
import { useDocumentStore } from '@/stores/documentStore';
import { useThemeStore } from '@/theme';
import { requestSave } from '@/api/autoSave';

export function MirrorDialog() {
  const mirrorEntityIds = useEditorStore((s) => s.mirrorEntityIds);
  const mirrorPickingLine = useEditorStore((s) => s.mirrorPickingLine);
  const palette = useThemeStore((s) => s.palette);

  if (!mirrorEntityIds || mirrorPickingLine) return null;

  const mirrorAxis = (lineA: { x: number; y: number }, lineB: { x: number; y: number }) => {
    useDocumentStore.getState().beginTransaction();
    const newIds = useDocumentStore.getState().mirrorEntities(mirrorEntityIds, lineA, lineB);
    useEditorStore.getState().setMirrorEntityIds(null);
    if (newIds.length > 0) {
      useEditorStore.getState().setSelectedEntityIds(new Set(newIds));
    }
    requestSave();
  };

  const cancel = () => {
    useEditorStore.getState().setMirrorEntityIds(null);
  };

  const pickLine = () => {
    useEditorStore.getState().setMirrorPickingLine(true);
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
        minWidth: '180px',
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          cancel();
        }
      }}
    >
      <div style={{ color: palette.text, fontSize: '14px', fontWeight: 600, marginBottom: '4px' }}>
        Mirror
      </div>
      <button style={btnStyle} onClick={() => mirrorAxis({ x: -1, y: 0 }, { x: 1, y: 0 })}>
        X Axis
      </button>
      <button style={btnStyle} onClick={() => mirrorAxis({ x: 0, y: -1 }, { x: 0, y: 1 })}>
        Y Axis
      </button>
      <button style={btnStyle} onClick={pickLine}>
        Pick Line…
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
