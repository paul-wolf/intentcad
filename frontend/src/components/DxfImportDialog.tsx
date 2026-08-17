import { useState } from 'react';
import { useEditorStore } from '@/stores/editorStore';
import { useDocumentStore } from '@/stores/documentStore';
import { useThemeStore } from '@/theme';
import { requestSave } from '@/api/autoSave';
import { addLog } from '@/stores/logStore';
import type { OriginAlignMode } from '@/types/document';

const MODES: { value: OriginAlignMode; label: string; hint: string }[] = [
  { value: 'center', label: 'Centre on origin', hint: 'Bounding-box centre at (0, 0)' },
  { value: 'min', label: 'Corner on origin', hint: 'Lower-left corner at (0, 0)' },
  { value: 'none', label: 'Keep file coordinates', hint: 'Import exactly as drawn' },
];

/** Remembered across imports within a session — most files come in batches
 *  that want the same treatment. */
let lastMode: OriginAlignMode = 'center';

export function DxfImportDialog() {
  const pending = useEditorStore((s) => s.pendingDxfImport);
  const palette = useThemeStore((s) => s.palette);
  const [mode, setMode] = useState<OriginAlignMode>(lastMode);

  if (!pending) return null;

  const width = pending.bounds.maxX - pending.bounds.minX;
  const height = pending.bounds.maxY - pending.bounds.minY;
  const cx = (pending.bounds.minX + pending.bounds.maxX) / 2;
  const cy = (pending.bounds.minY + pending.bounds.maxY) / 2;
  const offOrigin = Math.hypot(cx, cy) > Math.max(width, height) * 0.5;

  const cancel = () => {
    useEditorStore.getState().setPendingDxfImport(null);
  };

  const apply = () => {
    lastMode = mode;
    const store = useDocumentStore.getState();
    store.beginTransaction('Import DXF');
    for (const entity of pending.entities) store.addEntity(entity);

    // Align only what we just added, so existing sketch geometry stays put.
    const importedIds = pending.entities.map((e) => e.id);
    useDocumentStore.getState().alignToOrigin(mode, importedIds, true);

    useEditorStore.getState().setPendingDxfImport(null);
    useEditorStore.getState().setSelectedEntityIds(new Set(importedIds));
    requestSave();
    setTimeout(() => useEditorStore.getState().setViewportCommand('fit-entities'), 0);

    let msg = `Imported ${pending.entities.length} entities from ${pending.fileName}`;
    if (mode !== 'none') msg += ` (${mode === 'min' ? 'corner' : 'centred'} on origin)`;
    if (pending.skipped > 0) {
      msg += ` — ${pending.skipped} skipped: ${pending.skippedTypes.join(', ')}`;
    }
    addLog('info', msg);
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
        minWidth: '300px',
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          cancel();
        }
      }}
    >
      <div style={{ color: palette.text, fontSize: '14px', fontWeight: 600 }}>
        Import DXF
      </div>

      <div style={{ color: palette.textSecondary, fontSize: '12px', lineHeight: 1.5 }}>
        <div>{pending.fileName}</div>
        <div>
          {pending.entities.length} entities · {width.toFixed(1)} × {height.toFixed(1)}
        </div>
        <div>
          Drawn at ({cx.toFixed(1)}, {cy.toFixed(1)})
          {offOrigin && (
            <span style={{ color: palette.warning ?? palette.textSecondary }}>
              {' '}— far from origin
            </span>
          )}
        </div>
        {pending.skipped > 0 && (
          <div>{pending.skipped} unsupported: {pending.skippedTypes.join(', ')}</div>
        )}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
        {MODES.map((m) => (
          <label
            key={m.value}
            style={{
              display: 'flex',
              gap: '8px',
              alignItems: 'flex-start',
              color: palette.text,
              fontSize: '13px',
              cursor: 'pointer',
            }}
          >
            <input
              type="radio"
              name="dxf-origin-mode"
              checked={mode === m.value}
              onChange={() => setMode(m.value)}
              style={{ marginTop: '2px' }}
            />
            <span>
              {m.label}
              <span style={{ display: 'block', color: palette.textSecondary, fontSize: '11px' }}>
                {m.hint}
              </span>
            </span>
          </label>
        ))}
      </div>

      <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
        <button
          style={{ ...btnStyle, color: palette.textSecondary, fontSize: '12px' }}
          onClick={cancel}
        >
          Cancel
        </button>
        <button style={btnStyle} onClick={apply} autoFocus>
          Import
        </button>
      </div>
    </div>
  );
}
