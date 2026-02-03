import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useDocumentStore } from '@/stores/documentStore';
import { useThemeStore } from '@/theme';
import { createEmptyDocument, migrateDocument } from '@/utils/document';
import { api, type DocumentListItem } from '@/api/client';
import { setBackendId } from '@/api/autoSave';
import type { Document } from '@/types/document';

export function DocumentListPage() {
  const navigate = useNavigate();
  const setDocument = useDocumentStore((s) => s.setDocument);
  const palette = useThemeStore((s) => s.palette);
  const [docs, setDocs] = useState<DocumentListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchDocs = useCallback(async () => {
    try {
      setLoading(true);
      const list = await api.listDocuments();
      setDocs(list);
      setError(null);
    } catch {
      // Backend not available — fall back to local-only mode
      setError('offline');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchDocs(); }, [fetchDocs]);

  const handleNew = async () => {
    const doc = createEmptyDocument('Untitled');
    setDocument(doc);
    try {
      const saved = await api.createDocument(doc.name, doc as unknown as Record<string, unknown>);
      setBackendId(saved.id);
      navigate(`/edit/${saved.id}`);
    } catch {
      // Offline — navigate with local ID
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
      <h1 style={{ fontSize: '28px', fontWeight: 700, color: palette.text }}>
        IntentCAD
      </h1>
      <p style={{ fontSize: '14px', color: palette.textSecondary, marginBottom: '20px' }}>
        v0.1
      </p>
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
              <span
                style={{ flex: 1, cursor: 'pointer', color: palette.text, fontSize: '14px' }}
                onClick={() => handleOpen(d.id)}
              >
                {d.name}
              </span>
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
    </div>
  );
}
