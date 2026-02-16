import { useState, useEffect, useCallback } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useDocumentStore } from '@/stores/documentStore';
import { useThemeStore } from '@/theme';
import { createEmptyDocument, migrateDocument, generateDateName } from '@/utils/document';
import { api, partApi, type DocumentListItem, type PartListItem } from '@/api/client';
import { setBackendId } from '@/api/autoSave';
import type { Document } from '@/types/document';
import { DocumentThumbnail } from './DocumentThumbnail';
import { PartListThumbnail } from './PartListThumbnail';

export function DocumentListPage() {
  const navigate = useNavigate();
  const { projectId } = useParams<{ projectId: string }>();
  const setDocument = useDocumentStore((s) => s.setDocument);
  const palette = useThemeStore((s) => s.palette);
  const [docs, setDocs] = useState<DocumentListItem[]>([]);
  const [parts, setParts] = useState<PartListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingType, setEditingType] = useState<'doc' | 'part'>('doc');
  const [editName, setEditName] = useState('');

  const fetchDocs = useCallback(async () => {
    try {
      setLoading(true);
      const [docList, partList] = await Promise.all([
        api.listDocuments(projectId),
        partApi.listParts(projectId),
      ]);
      setDocs(docList);
      setParts(partList);
      setError(null);
    } catch {
      setError('offline');
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { fetchDocs(); }, [fetchDocs]);

  const handleNew = async () => {
    const name = generateDateName(docs.map((d) => d.name));
    const doc = createEmptyDocument(name);
    setDocument(doc);
    try {
      const saved = await api.createDocument(doc.name, doc as unknown as Record<string, unknown>, projectId);
      setBackendId(saved.id);
      navigate(`/edit/${saved.id}`);
    } catch {
      setBackendId(null);
      navigate(`/edit/${doc.id}`);
    }
  };

  const handleOpen = async (id: string) => {
    try {
      const full = await api.getDocument(id);
      setDocument(migrateDocument(full.data as unknown as Document));
      setBackendId(full.id);
      navigate(`/edit/${id}`);
    } catch (err) {
      console.error('Failed to load document:', err);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await api.deleteDocument(id);
      setDocs((prev) => prev.filter((d) => d.id !== id));
    } catch (err) {
      console.error('Failed to delete document:', err);
    }
  };

  const handleNewPart = async () => {
    try {
      const partName = generateDateName(parts.map((p) => p.name));
      const saved = await partApi.createPart(partName, { id: crypto.randomUUID(), name: partName, features: [] }, projectId);
      navigate(`/part/${saved.id}`);
    } catch {
      console.error('Failed to create part');
    }
  };

  const handleDeletePart = async (id: string) => {
    try {
      await partApi.deletePart(id);
      setParts((prev) => prev.filter((p) => p.id !== id));
    } catch (err) {
      console.error('Failed to delete part:', err);
    }
  };

  const startRename = (id: string, currentName: string, type: 'doc' | 'part') => {
    setEditingId(id);
    setEditingType(type);
    setEditName(currentName);
  };

  const commitRename = async () => {
    if (!editingId || !editName.trim()) {
      setEditingId(null);
      return;
    }
    const trimmed = editName.trim();
    try {
      if (editingType === 'doc') {
        await api.updateDocument(editingId, { name: trimmed });
        setDocs((prev) => prev.map((d) => (d.id === editingId ? { ...d, name: trimmed } : d)));
      } else {
        await partApi.updatePart(editingId, { name: trimmed });
        setParts((prev) => prev.map((p) => (p.id === editingId ? { ...p, name: trimmed } : p)));
      }
    } catch (err) {
      console.error('Failed to rename:', err);
    }
    setEditingId(null);
  };

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column' as const,
        alignItems: 'center',
        justifyContent: 'center',
        height: '100%',
        gap: '12px',
      }}
    >
      <div
        style={{
          position: 'absolute',
          top: '12px',
          left: '16px',
        }}
      >
        <button
          onClick={() => navigate('/')}
          style={{
            padding: '6px 14px',
            background: palette.panelBg,
            color: palette.text,
            border: `1px solid ${palette.textSecondary}`,
            borderRadius: '4px',
            fontSize: '13px',
            cursor: 'pointer',
          }}
        >
          &larr; Projects
        </button>
      </div>

      <div style={{ display: 'flex', gap: '12px' }}>
        <button
          style={{
            padding: '10px 24px',
            background: palette.primaryBtn,
            color: '#fff',
            border: 'none',
            borderRadius: '6px',
            fontSize: '15px',
            cursor: 'pointer',
          }}
          onClick={handleNew}
        >
          New Document
        </button>
        <button
          style={{
            padding: '10px 24px',
            background: palette.primaryBtn,
            color: '#fff',
            border: 'none',
            borderRadius: '6px',
            fontSize: '15px',
            cursor: 'pointer',
          }}
          onClick={handleNewPart}
        >
          New Part
        </button>
      </div>

      {error === 'offline' && (
        <p style={{ fontSize: '12px', color: palette.warning, marginTop: '8px' }}>
          Backend offline — local mode
        </p>
      )}

      {!loading && docs.length > 0 && (
        <div
          style={{
            marginTop: '20px',
            width: '320px',
            display: 'flex',
            flexDirection: 'column' as const,
            gap: '4px',
          }}
        >
          <div style={{ fontSize: '12px', color: palette.textSecondary, marginBottom: '4px' }}>
            Sketches
          </div>
          {docs.map((d) => (
            <div
              key={d.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                padding: '8px 12px',
                background: palette.panelBg,
                borderRadius: '4px',
              }}
            >
              <DocumentThumbnail
                documentId={d.id}
                width={48}
                height={36}
                background={palette.background}
                stroke={palette.line}
              />
              {editingId === d.id && editingType === 'doc' ? (
                <input
                  style={{
                    flex: 1,
                    background: palette.panelBg,
                    border: `1px solid ${palette.textSecondary}`,
                    borderRadius: '2px',
                    color: palette.text,
                    fontSize: '14px',
                    padding: '2px 6px',
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
                  style={{ flex: 1, cursor: 'pointer', color: palette.text, fontSize: '14px' }}
                  onClick={() => handleOpen(d.id)}
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    startRename(d.id, d.name, 'doc');
                  }}
                >
                  {d.name}
                </span>
              )}
              <span style={{ fontSize: '11px', color: palette.textSecondary }}>
                {new Date(d.updated_at).toLocaleDateString()}
              </span>
              <button
                style={{
                  background: 'none',
                  border: 'none',
                  color: palette.danger,
                  cursor: 'pointer',
                  fontSize: '14px',
                }}
                onClick={() => handleDelete(d.id)}
              >
                x
              </button>
            </div>
          ))}
        </div>
      )}

      {!loading && parts.length > 0 && (
        <div
          style={{
            marginTop: '20px',
            width: '320px',
            display: 'flex',
            flexDirection: 'column' as const,
            gap: '4px',
          }}
        >
          <div style={{ fontSize: '12px', color: palette.textSecondary, marginBottom: '4px' }}>
            Parts
          </div>
          {parts.map((p) => (
            <div
              key={p.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                padding: '8px 12px',
                background: palette.panelBg,
                borderRadius: '4px',
              }}
            >
              <PartListThumbnail
                partId={p.id}
                width={48}
                height={36}
                background={palette.background}
              />
              {editingId === p.id && editingType === 'part' ? (
                <input
                  style={{
                    flex: 1,
                    background: palette.panelBg,
                    border: `1px solid ${palette.textSecondary}`,
                    borderRadius: '2px',
                    color: palette.text,
                    fontSize: '14px',
                    padding: '2px 6px',
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
                  style={{ flex: 1, cursor: 'pointer', color: palette.text, fontSize: '14px' }}
                  onClick={() => navigate(`/part/${p.id}`)}
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    startRename(p.id, p.name, 'part');
                  }}
                >
                  {p.name}
                </span>
              )}
              <span style={{ fontSize: '11px', color: palette.textSecondary }}>
                {new Date(p.updated_at).toLocaleDateString()}
              </span>
              <button
                style={{
                  background: 'none',
                  border: 'none',
                  color: palette.danger,
                  cursor: 'pointer',
                  fontSize: '14px',
                }}
                onClick={() => handleDeletePart(p.id)}
              >
                x
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
