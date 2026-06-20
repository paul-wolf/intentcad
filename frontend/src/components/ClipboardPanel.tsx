import { useClipboardStore } from '@/stores/clipboardStore';
import { useDocumentStore } from '@/stores/documentStore';
import { useEditorStore } from '@/stores/editorStore';
import { useThemeStore } from '@/theme';
import { migrateDocument } from '@/utils/document';
import { addLog } from '@/stores/logStore';
import { requestSave } from '@/api/autoSave';
import type { Document } from '@/types/document';

function relativeTime(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

export function ClipboardPanel() {
  const entry = useClipboardStore((s) => s.entry);
  const clear = useClipboardStore((s) => s.clear);
  const palette = useThemeStore((s) => s.palette);

  const pasteDocument = () => {
    if (!entry || entry.type !== 'document') return;
    try {
      const parsed = JSON.parse(entry.json) as Document;
      useDocumentStore.getState().beginTransaction('Paste document');
      useDocumentStore.getState().setDocument(migrateDocument({ ...parsed, name: `${parsed.name} copy` }));
      requestSave();
      addLog('info', 'Document restored from clipboard');
      setTimeout(() => useEditorStore.getState().setViewportCommand('fit-entities'), 0);
    } catch {
      addLog('error', 'Failed to paste document');
    }
  };

  const label = entry
    ? entry.type === 'document'
      ? `Doc: "${entry.name}" (${entry.entityCount} entities)`
      : (() => {
          const counts = entry.kinds.reduce<Record<string, number>>((acc, k) => {
            acc[k] = (acc[k] ?? 0) + 1; return acc;
          }, {});
          return `${entry.count} entities — ${Object.entries(counts).map(([k, n]) => `${n} ${k}`).join(', ')}`;
        })()
    : null;

  return (
    <div style={{
      width: '260px',
      flexShrink: 0,
      borderLeft: `1px solid ${palette.border}`,
      display: 'flex',
      flexDirection: 'column',
      fontSize: '11px',
      fontFamily: 'monospace',
    }}>
      {/* Header */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
        padding: '2px 10px',
        color: palette.textMuted,
        userSelect: 'none',
      }}>
        <span>Clipboard</span>
        {entry && (
          <>
            <span style={{ flex: 1 }} />
            <span
              style={{ cursor: 'pointer', color: palette.textMuted }}
              onClick={clear}
              title="Clear"
            >×</span>
          </>
        )}
      </div>

      {/* Content */}
      <div style={{ padding: '2px 10px 4px', color: palette.text, flex: 1, overflow: 'hidden' }}>
        {!entry && (
          <span style={{ color: palette.textMuted }}>
            Q — copy selected &nbsp; Shift+Q — copy doc
          </span>
        )}
        {entry && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <div style={{
              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
              color: palette.text,
            }} title={label ?? ''}>
              {label}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <span style={{ color: palette.textMuted }}>{relativeTime(entry.timestamp)}</span>
              {entry.type === 'document' && (
                <button
                  onClick={pasteDocument}
                  style={{
                    padding: '1px 8px',
                    background: palette.primaryBtn,
                    color: '#fff',
                    border: 'none',
                    borderRadius: '3px',
                    fontSize: '11px',
                    cursor: 'pointer',
                    fontFamily: 'monospace',
                  }}
                >
                  Paste (Shift+V)
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
