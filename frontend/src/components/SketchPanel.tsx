import { useState } from 'react';
import { useDocumentStore } from '@/stores/documentStore';
import { useThemeStore } from '@/theme';

export function SketchPanel() {
  const sketches = useDocumentStore((s) => s.document.sketches);
  const activeSketchId = useDocumentStore((s) => s.document.activeSketchId);
  const addSketch = useDocumentStore((s) => s.addSketch);
  const renameSketch = useDocumentStore((s) => s.renameSketch);
  const toggleVisibility = useDocumentStore((s) => s.toggleSketchVisibility);
  const setActiveSketch = useDocumentStore((s) => s.setActiveSketch);
  const palette = useThemeStore((s) => s.palette);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');

  const startRename = (id: string, currentName: string) => {
    setEditingId(id);
    setEditName(currentName);
  };

  const commitRename = () => {
    if (editingId && editName.trim()) {
      renameSketch(editingId, editName.trim());
    }
    setEditingId(null);
  };

  return (
    <div
      style={{
        width: '180px',
        background: palette.panelBg,
        borderLeft: `1px solid ${palette.border}`,
        display: 'flex',
        flexDirection: 'column' as const,
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          padding: '8px 10px',
          borderBottom: `1px solid ${palette.border}`,
        }}
      >
        <span
          style={{
            fontSize: '12px',
            fontWeight: 600,
            textTransform: 'uppercase' as const,
            letterSpacing: '0.5px',
            color: palette.textMuted,
          }}
        >
          Sketches
        </span>
        <button
          style={{
            background: 'none',
            border: `1px solid ${palette.inputBorder}`,
            borderRadius: '3px',
            color: palette.textMuted,
            cursor: 'pointer',
            fontSize: '14px',
            width: '22px',
            height: '22px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
          onClick={() => addSketch(`Sketch ${sketches.length + 1}`)}
          title="Add sketch"
        >
          +
        </button>
      </div>
      <div style={{ flex: 1, overflowY: 'auto' as const }}>
        {sketches.map((sk) => (
          <div
            key={sk.id}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              padding: '5px 10px',
              cursor: 'pointer',
              fontSize: '13px',
              borderLeft: '2px solid transparent',
              ...(sk.id === activeSketchId
                ? { background: palette.activeItemBg, borderLeftColor: palette.accent }
                : {}),
            }}
            onClick={() => setActiveSketch(sk.id)}
          >
            <button
              style={{
                background: 'none',
                border: 'none',
                color: palette.textSecondary,
                cursor: 'pointer',
                fontSize: '11px',
                width: '16px',
                fontFamily: 'monospace',
              }}
              onClick={(e) => {
                e.stopPropagation();
                toggleVisibility(sk.id);
              }}
              title={sk.visible ? 'Hide' : 'Show'}
            >
              {sk.visible ? 'V' : '-'}
            </button>
            {editingId === sk.id ? (
              <input
                style={{
                  flex: 1,
                  background: palette.inputBg,
                  border: `1px solid ${palette.inputBorder}`,
                  borderRadius: '2px',
                  color: palette.text,
                  fontSize: '13px',
                  padding: '1px 4px',
                  outline: 'none',
                }}
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                onBlur={commitRename}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitRename();
                  if (e.key === 'Escape') setEditingId(null);
                }}
                autoFocus
              />
            ) : (
              <span
                style={{
                  flex: 1,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap' as const,
                }}
                onDoubleClick={() => startRename(sk.id, sk.name)}
              >
                {sk.name}
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
