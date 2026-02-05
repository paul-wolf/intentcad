import { useState } from 'react';
import { useDocumentStore } from '@/stores/documentStore';
import { useThemeStore } from '@/theme';

export function SketchPanel() {
  const sketches = useDocumentStore((s) => s.document.sketches);
  const activeSketchId = useDocumentStore((s) => s.document.activeSketchId);
  const addSketch = useDocumentStore((s) => s.addSketch);
  const renameSketch = useDocumentStore((s) => s.renameSketch);
  const toggleVisibility = useDocumentStore((s) => s.toggleSketchVisibility);
  const toggleSuppressed = useDocumentStore((s) => s.toggleSketchSuppressed);
  const moveSketch = useDocumentStore((s) => s.moveSketch);
  const setActiveSketch = useDocumentStore((s) => s.setActiveSketch);
  const palette = useThemeStore((s) => s.palette);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [hoveredId, setHoveredId] = useState<string | null>(null);

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
        display: 'flex',
        flexDirection: 'column',
        borderBottom: `1px solid ${palette.border}`,
      }}
    >
      {/* Header */}
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
            textTransform: 'uppercase',
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

      {/* Sketch list */}
      <div style={{ overflowY: 'auto', maxHeight: '200px' }}>
        {sketches.map((sk, idx) => (
          <div
            key={sk.id}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '4px',
              padding: '5px 10px',
              cursor: 'pointer',
              fontSize: '13px',
              borderLeft: '2px solid transparent',
              ...(sk.id === activeSketchId
                ? { background: palette.activeItemBg, borderLeftColor: palette.accent }
                : {}),
            }}
            onClick={() => setActiveSketch(sk.id)}
            onMouseEnter={() => setHoveredId(sk.id)}
            onMouseLeave={() => setHoveredId(null)}
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
                padding: 0,
              }}
              onClick={(e) => {
                e.stopPropagation();
                toggleVisibility(sk.id);
              }}
              title={sk.visible ? 'Hide' : 'Show'}
            >
              {sk.visible ? 'V' : '-'}
            </button>
            <button
              style={{
                background: 'none',
                border: 'none',
                color: sk.suppressed ? palette.textMuted : palette.textSecondary,
                cursor: 'pointer',
                fontSize: '11px',
                width: '16px',
                fontFamily: 'monospace',
                padding: 0,
                opacity: sk.suppressed ? 0.5 : 1,
              }}
              onClick={(e) => {
                e.stopPropagation();
                toggleSuppressed(sk.id);
              }}
              title={sk.suppressed ? 'Unsuppress' : 'Suppress'}
            >
              {sk.suppressed ? 'S' : '-'}
            </button>
            {editingId === sk.id ? (
              <input
                style={{
                  flex: 1,
                  minWidth: 0,
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
                  minWidth: 0,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  ...(sk.suppressed
                    ? { textDecoration: 'line-through', opacity: 0.5 }
                    : {}),
                }}
                onDoubleClick={() => startRename(sk.id, sk.name)}
              >
                {sk.name}
              </span>
            )}
            {hoveredId === sk.id && (
              <>
                <button
                  style={{
                    background: 'none',
                    border: 'none',
                    color: idx === 0 ? palette.textMuted : palette.textSecondary,
                    cursor: idx === 0 ? 'default' : 'pointer',
                    fontSize: '10px',
                    width: '16px',
                    fontFamily: 'monospace',
                    padding: 0,
                    opacity: idx === 0 ? 0.3 : 1,
                  }}
                  disabled={idx === 0}
                  onClick={(e) => {
                    e.stopPropagation();
                    moveSketch(sk.id, 'up');
                  }}
                  title="Move up"
                >
                  ▲
                </button>
                <button
                  style={{
                    background: 'none',
                    border: 'none',
                    color: idx === sketches.length - 1 ? palette.textMuted : palette.textSecondary,
                    cursor: idx === sketches.length - 1 ? 'default' : 'pointer',
                    fontSize: '10px',
                    width: '16px',
                    fontFamily: 'monospace',
                    padding: 0,
                    opacity: idx === sketches.length - 1 ? 0.3 : 1,
                  }}
                  disabled={idx === sketches.length - 1}
                  onClick={(e) => {
                    e.stopPropagation();
                    moveSketch(sk.id, 'down');
                  }}
                  title="Move down"
                >
                  ▼
                </button>
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
