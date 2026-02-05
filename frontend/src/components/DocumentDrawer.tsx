import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useDocumentStore } from '@/stores/documentStore';
import { useUIStateStore } from '@/stores/uiStateStore';
import { useThemeStore } from '@/theme';
import { createEmptyDocument, migrateDocument } from '@/utils/document';
import { api, type DocumentListItem } from '@/api/client';
import { setBackendId, getBackendId, flushSave } from '@/api/autoSave';
import type { Document } from '@/types/document';

export function DocumentDrawer() {
  const navigate = useNavigate();
  const setDocument = useDocumentStore((s) => s.setDocument);
  const setDocumentName = useDocumentStore((s) => s.setDocumentName);
  const drawerOpen = useUIStateStore((s) => s.drawerOpen);
  const palette = useThemeStore((s) => s.palette);

  const [docs, setDocs] = useState<DocumentListItem[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');

  const currentBackendId = getBackendId();

  useEffect(() => {
    if (!drawerOpen) return;
    let cancelled = false;
    (async () => {
      try {
        const list = await api.listDocuments();
        if (!cancelled) setDocs(list);
      } catch (err) {
        console.error('Failed to list documents:', err);
      }
    })();
    return () => { cancelled = true; };
  }, [drawerOpen]);

  const handleOpen = async (id: string) => {
    try {
      flushSave();
      const full = await api.getDocument(id);
      setDocument(migrateDocument(full.data as unknown as Document));
      setBackendId(full.id);
      navigate(`/edit/${id}`);
    } catch (err) {
      console.error('Failed to load document:', err);
    }
  };

  const handleNew = async () => {
    flushSave();
    const doc = createEmptyDocument('Untitled');
    setDocument(doc);
    try {
      const saved = await api.createDocument(doc.name, doc as unknown as Record<string, unknown>);
      setBackendId(saved.id);
      setDocs((prev) => [{ id: saved.id, name: saved.name, created_at: saved.created_at, updated_at: saved.updated_at }, ...prev]);
      navigate(`/edit/${saved.id}`);
    } catch {
      setBackendId(null);
      navigate(`/edit/${doc.id}`);
    }
  };

  const handleDelete = async (id: string) => {
    const doc = docs.find((d) => d.id === id);
    const name = doc?.name ?? 'this document';
    if (!window.confirm(`Delete "${name}"?`)) return;
    try {
      await api.deleteDocument(id);
      setDocs((prev) => prev.filter((d) => d.id !== id));
      if (currentBackendId === id) {
        navigate('/');
      }
    } catch (err) {
      console.error('Failed to delete document:', err);
    }
  };

  const startRename = (id: string, currentName: string) => {
    setEditingId(id);
    setEditName(currentName);
  };

  const commitRename = async () => {
    if (editingId && editName.trim()) {
      try {
        await api.updateDocument(editingId, { name: editName.trim() });
        setDocs((prev) =>
          prev.map((d) => (d.id === editingId ? { ...d, name: editName.trim() } : d)),
        );
        if (editingId === currentBackendId) {
          setDocumentName(editName.trim());
        }
      } catch (err) {
        console.error('Failed to rename document:', err);
      }
    }
    setEditingId(null);
  };

  return (
    <div
      style={{
        width: '220px',
        flexShrink: 0,
        background: palette.panelBg,
        borderRight: `1px solid ${palette.border}`,
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
          Documents
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
          onClick={handleNew}
          title="New document"
        >
          +
        </button>
      </div>
      <div style={{ flex: 1, overflowY: 'auto' as const }}>
        {docs.map((d) => {
          const isActive = d.id === currentBackendId;
          return (
            <div
              key={d.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                padding: '5px 10px',
                cursor: 'pointer',
                fontSize: '13px',
                borderLeft: '2px solid transparent',
                ...(isActive
                  ? { background: palette.activeItemBg, borderLeftColor: palette.accent }
                  : {}),
              }}
              onClick={() => handleOpen(d.id)}
            >
              {editingId === d.id ? (
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
                  onClick={(e) => e.stopPropagation()}
                  autoFocus
                />
              ) : (
                <span
                  style={{
                    flex: 1,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap' as const,
                    color: palette.text,
                  }}
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    startRename(d.id, d.name);
                  }}
                >
                  {d.name}
                </span>
              )}
              <span style={{ fontSize: '10px', color: palette.textSecondary, flexShrink: 0 }}>
                {new Date(d.updated_at).toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' })}
              </span>
              <button
                style={{
                  background: 'none',
                  border: 'none',
                  color: palette.danger,
                  cursor: 'pointer',
                  fontSize: '13px',
                  padding: '0 2px',
                  flexShrink: 0,
                }}
                onClick={(e) => {
                  e.stopPropagation();
                  handleDelete(d.id);
                }}
                title="Delete document"
              >
                x
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
