import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useDocumentStore } from '@/stores/documentStore';
import { createEmptyDocument, migrateDocument } from '@/utils/document';
import { api, type DocumentListItem } from '@/api/client';
import { setBackendId } from '@/api/autoSave';
import type { Document } from '@/types/document';

export function DocumentListPage() {
  const navigate = useNavigate();
  const setDocument = useDocumentStore((s) => s.setDocument);
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
    <div style={styles.container}>
      <h1 style={styles.title}>IntentCAD</h1>
      <p style={styles.subtitle}>v0.1</p>
      <button style={styles.button} onClick={handleNew}>
        New Document
      </button>

      {error === 'offline' && (
        <p style={styles.offline}>Backend offline — local mode</p>
      )}

      {!loading && docs.length > 0 && (
        <div style={styles.docList}>
          {docs.map((d) => (
            <div key={d.id} style={styles.docItem}>
              <span
                style={styles.docName}
                onClick={() => handleOpen(d.id)}
              >
                {d.name}
              </span>
              <span style={styles.docDate}>
                {new Date(d.updated_at).toLocaleDateString()}
              </span>
              <button
                style={styles.deleteBtn}
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

const styles = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    height: '100%',
    gap: '12px',
  } as React.CSSProperties,
  title: {
    fontSize: '28px',
    fontWeight: 700,
    color: '#e2e8f0',
  } as React.CSSProperties,
  subtitle: {
    fontSize: '14px',
    color: '#64748b',
    marginBottom: '20px',
  } as React.CSSProperties,
  button: {
    padding: '10px 24px',
    background: '#3b82f6',
    color: '#fff',
    border: 'none',
    borderRadius: '6px',
    fontSize: '15px',
    cursor: 'pointer',
  } as React.CSSProperties,
  offline: {
    fontSize: '12px',
    color: '#f59e0b',
    marginTop: '8px',
  } as React.CSSProperties,
  docList: {
    marginTop: '20px',
    width: '320px',
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
  } as React.CSSProperties,
  docItem: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '8px 12px',
    background: '#1e293b',
    borderRadius: '4px',
  } as React.CSSProperties,
  docName: {
    flex: 1,
    cursor: 'pointer',
    color: '#e2e8f0',
    fontSize: '14px',
  } as React.CSSProperties,
  docDate: {
    fontSize: '11px',
    color: '#64748b',
  } as React.CSSProperties,
  deleteBtn: {
    background: 'none',
    border: 'none',
    color: '#ef4444',
    cursor: 'pointer',
    fontSize: '14px',
  } as React.CSSProperties,
};
