import { useState } from 'react';
import { useDocumentStore } from '@/stores/documentStore';

export function SketchPanel() {
  const sketches = useDocumentStore((s) => s.document.sketches);
  const activeSketchId = useDocumentStore((s) => s.document.activeSketchId);
  const addSketch = useDocumentStore((s) => s.addSketch);
  const renameSketch = useDocumentStore((s) => s.renameSketch);
  const toggleVisibility = useDocumentStore((s) => s.toggleSketchVisibility);
  const setActiveSketch = useDocumentStore((s) => s.setActiveSketch);

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
    <div style={styles.container}>
      <div style={styles.header}>
        <span style={styles.title}>Sketches</span>
        <button
          style={styles.addBtn}
          onClick={() => addSketch(`Sketch ${sketches.length + 1}`)}
          title="Add sketch"
        >
          +
        </button>
      </div>
      <div style={styles.list}>
        {sketches.map((sk) => (
          <div
            key={sk.id}
            style={{
              ...styles.item,
              ...(sk.id === activeSketchId ? styles.activeItem : {}),
            }}
            onClick={() => setActiveSketch(sk.id)}
          >
            <button
              style={styles.visBtn}
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
                style={styles.input}
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
                style={styles.name}
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

const styles = {
  container: {
    width: '180px',
    background: '#1e293b',
    borderLeft: '1px solid #334155',
    display: 'flex',
    flexDirection: 'column',
  } as React.CSSProperties,
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '8px 10px',
    borderBottom: '1px solid #334155',
  } as React.CSSProperties,
  title: {
    fontSize: '12px',
    fontWeight: 600,
    textTransform: 'uppercase',
    letterSpacing: '0.5px',
    color: '#94a3b8',
  } as React.CSSProperties,
  addBtn: {
    background: 'none',
    border: '1px solid #475569',
    borderRadius: '3px',
    color: '#94a3b8',
    cursor: 'pointer',
    fontSize: '14px',
    width: '22px',
    height: '22px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  } as React.CSSProperties,
  list: {
    flex: 1,
    overflowY: 'auto',
  } as React.CSSProperties,
  item: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    padding: '5px 10px',
    cursor: 'pointer',
    fontSize: '13px',
    borderLeft: '2px solid transparent',
  } as React.CSSProperties,
  activeItem: {
    background: '#0f172a',
    borderLeftColor: '#60a5fa',
  } as React.CSSProperties,
  visBtn: {
    background: 'none',
    border: 'none',
    color: '#64748b',
    cursor: 'pointer',
    fontSize: '11px',
    width: '16px',
    fontFamily: 'monospace',
  } as React.CSSProperties,
  name: {
    flex: 1,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  } as React.CSSProperties,
  input: {
    flex: 1,
    background: '#0f172a',
    border: '1px solid #475569',
    borderRadius: '2px',
    color: '#e2e8f0',
    fontSize: '13px',
    padding: '1px 4px',
    outline: 'none',
  } as React.CSSProperties,
};
