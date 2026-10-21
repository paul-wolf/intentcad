import { useEditorStore } from '@/stores/editorStore';
import { useDocumentStore } from '@/stores/documentStore';
import { useThemeStore } from '@/theme';
import { requestSave } from '@/api/autoSave';
import type { LineEntity } from '@/types/document';
import { AXIS_H, AXIS_V, FACE_AXIS_H, FACE_AXIS_V } from '@/utils/sketchAxes';

// the sketch's axes the dialog offers, by name
const AXES: [string, string][] = [[AXIS_H, 'H axis'], [AXIS_V, 'V axis'], [FACE_AXIS_H, 'Face H centre line'], [FACE_AXIS_V, 'Face V centre line']];

export function MirrorDialog() {
  const mirrorEntityIds = useEditorStore((s) => s.mirrorEntityIds);
  const mirrorPickingLine = useEditorStore((s) => s.mirrorPickingLine);
  const palette = useThemeStore((s) => s.palette);
  const sketch = useDocumentStore((s) => s.getActiveSketch());

  if (!mirrorEntityIds || mirrorPickingLine) return null;

  const mirrorAxis = (lineA: { x: number; y: number }, lineB: { x: number; y: number }) => {
    useDocumentStore.getState().beginTransaction('Mirror');
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
      {AXES.map(([id, label]) => {
        const axis = sketch?.entities.find((e) => e.id === id) as LineEntity | undefined;
        return axis && (
          <button key={id} style={btnStyle} onClick={() => mirrorAxis(axis.points[0]!, axis.points[1]!)}>
            {label}
          </button>
        );
      })}
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
