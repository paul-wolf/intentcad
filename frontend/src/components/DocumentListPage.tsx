import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useDocumentStore } from '@/stores/documentStore';
import { useThemeStore } from '@/theme';
import { createEmptyDocument, createEmptyPart, migrateDocument, generateDateName } from '@/utils/document';
import { api, type DocumentListItem } from '@/api/cachedClient';
import { setBackendId, setProjectContext } from '@/api/autoSave';
import type { Document } from '@/types/document';
import { DocumentThumbnail } from './DocumentThumbnail';
import { projectApi } from '@/api/projectClient';

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

export function DocumentListPage() {
  const navigate = useNavigate();
  const { projectId } = useParams<{ projectId: string }>();
  const setDocument = useDocumentStore((s) => s.setDocument);
  const palette = useThemeStore((s) => s.palette);
  const [docs, setDocs] = useState<DocumentListItem[]>([]);
  const [projectName, setProjectName] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editingProjectName, setEditingProjectName] = useState(false);
  const [editProjectName, setEditProjectName] = useState('');
  const clickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchDocs = useCallback(async () => {
    try {
      setLoading(true);
      const [docList] = await Promise.all([
        api.listDocuments(projectId),
        projectId ? projectApi.getProject(projectId).then((p) => setProjectName(p.name)).catch(() => {}) : Promise.resolve(),
      ]);
      setDocs(docList);
      setError(null);
    } catch {
      setError('offline');
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { fetchDocs(); }, [fetchDocs]);

  const createAndOpen = async (doc: Document, route: (id: string) => string) => {
    setDocument(doc);
    try {
      const saved = await api.createDocument(doc.name, doc as unknown as Record<string, unknown>, projectId);
      setBackendId(saved.id);
      setProjectContext(projectId ?? null, projectName);
      navigate(route(saved.id));
    } catch {
      setBackendId(null);
      navigate(route(doc.id));
    }
  };

  const handleNew = () =>
    createAndOpen(createEmptyDocument(generateDateName(docs.map((d) => d.name))), (id) => `/edit/${id}`);
  const handleNewPart = () =>
    createAndOpen(createEmptyPart(generateDateName(docs.map((d) => d.name))), (id) => `/part/${id}`);

  const handleOpen = async (id: string, kind?: string) => {
    try {
      const full = await api.getDocument(id);
      setDocument(migrateDocument(full.data as unknown as Document));
      setBackendId(full.id);
      setProjectContext(projectId ?? null, projectName);
      navigate(kind === 'part' ? `/part/${id}` : `/edit/${id}`);
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

  const startRename = (id: string, currentName: string) => {
    setEditingId(id);
    setEditName(currentName);
  };

  const commitRename = async () => {
    if (!editingId || !editName.trim()) {
      setEditingId(null);
      return;
    }
    const trimmed = editName.trim();
    try {
      await api.updateDocument(editingId, { name: trimmed });
      setDocs((prev) => prev.map((d) => (d.id === editingId ? { ...d, name: trimmed } : d)));
    } catch (err) {
      console.error('Failed to rename:', err);
    }
    setEditingId(null);
  };

  const commitProjectRename = async () => {
    setEditingProjectName(false);
    const trimmed = editProjectName.trim();
    if (!trimmed || trimmed === projectName || !projectId) return;
    try {
      await projectApi.updateProject(projectId, { name: trimmed });
      setProjectName(trimmed);
    } catch (err) {
      console.error('Failed to rename project:', err);
    }
  };

  const lowerSearch = search.toLowerCase();
  const filteredDocs = lowerSearch ? docs.filter((d) => d.name.toLowerCase().includes(lowerSearch)) : docs;
  const parts = filteredDocs.filter((d) => d.kind === 'part');
  const sketches = filteredDocs.filter((d) => d.kind !== 'part');

  const renderDoc = (d: DocumentListItem) => (
    <div
      key={d.id}
      style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '8px 12px',
               background: palette.panelBg, borderRadius: '4px', cursor: 'pointer' }}
      onClick={() => {
        if (editingId === d.id) return;
        if (clickTimer.current) clearTimeout(clickTimer.current);
        clickTimer.current = setTimeout(() => { clickTimer.current = null; handleOpen(d.id, d.kind); }, 250);
      }}
      onDoubleClick={() => {
        if (clickTimer.current) { clearTimeout(clickTimer.current); clickTimer.current = null; }
        startRename(d.id, d.name);
      }}
    >
      {d.kind === 'part' ? (
        <div style={{ width: 56, height: 42, display: 'flex', alignItems: 'center', justifyContent: 'center',
                      fontSize: '20px', background: palette.background, borderRadius: '3px' }}>⬛</div>
      ) : (
        <DocumentThumbnail documentId={d.id} width={56} height={42}
          background={palette.background} stroke={palette.line} />
      )}
      {editingId === d.id ? (
        <input
          style={{ flex: 1, background: palette.panelBg, border: `1px solid ${palette.textSecondary}`,
                   borderRadius: '2px', color: palette.text, fontSize: '14px', padding: '2px 6px', outline: 'none' }}
          value={editName}
          onChange={(e) => setEditName(e.target.value)}
          onBlur={commitRename}
          onKeyDown={(e) => { if (e.key === 'Enter') commitRename(); if (e.key === 'Escape') setEditingId(null); }}
          onClick={(e) => e.stopPropagation()}
          autoFocus
        />
      ) : (
        <span style={{ flex: 1, color: palette.text, fontSize: '14px' }}>{d.name}</span>
      )}
      <span style={{ fontSize: '12px', color: palette.textSecondary, whiteSpace: 'nowrap' }}>
        {relativeTime(d.updated_at)}
      </span>
      <button
        style={{ background: 'none', border: 'none', color: palette.danger, cursor: 'pointer',
                 fontSize: '18px', padding: '0 4px', lineHeight: 1 }}
        onClick={(e) => { e.stopPropagation(); handleDelete(d.id); }}
      >
        &times;
      </button>
    </div>
  );

  const section = (title: string, list: DocumentListItem[]) => list.length > 0 && (
    <div style={{ marginBottom: '24px' }}>
      <div style={{ fontSize: '13px', color: palette.textSecondary, fontWeight: 600,
                    textTransform: 'uppercase' as const, letterSpacing: '0.5px', marginBottom: '8px' }}>
        {title}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column' as const, gap: '4px' }}>
        {list.map(renderDoc)}
      </div>
    </div>
  );

  const btnStyle: React.CSSProperties = {
    padding: '8px 18px',
    background: palette.primaryBtn,
    color: '#fff',
    border: 'none',
    borderRadius: '6px',
    fontSize: '14px',
    cursor: 'pointer',
  };

  return (
    <div style={{ height: '100%', overflow: 'auto' }}>
      <div style={{ maxWidth: '720px', margin: '0 auto', padding: '32px 24px' }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '20px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
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
            {editingProjectName ? (
              <input
                style={{
                  fontSize: '18px',
                  fontWeight: 700,
                  color: palette.text,
                  background: palette.inputBg,
                  border: `1px solid ${palette.inputBorder}`,
                  borderRadius: '4px',
                  padding: '2px 8px',
                  outline: 'none',
                  minWidth: '180px',
                }}
                value={editProjectName}
                onChange={(e) => setEditProjectName(e.target.value)}
                onBlur={commitProjectRename}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitProjectRename();
                  if (e.key === 'Escape') setEditingProjectName(false);
                }}
                autoFocus
              />
            ) : (
              <span
                style={{ fontSize: '18px', fontWeight: 700, color: palette.text, cursor: 'text' }}
                title="Click to rename project"
                onClick={() => { setEditProjectName(projectName); setEditingProjectName(true); }}
              >
                {projectName}
              </span>
            )}
          </div>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button style={btnStyle} onClick={handleNewPart}>+ New Part</button>
            <button
              style={{ ...btnStyle, background: palette.panelBg, color: palette.text,
                       border: `1px solid ${palette.textSecondary}` }}
              onClick={handleNew}
            >
              + New Sketch
            </button>
          </div>
        </div>

        {error === 'offline' && (
          <p style={{ fontSize: '12px', color: palette.warning, marginBottom: '12px' }}>
            Backend offline — local mode
          </p>
        )}

        {/* Search */}
        {!loading && docs.length > 0 && (
          <input
            type="text"
            placeholder="Search..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{
              width: '100%',
              padding: '8px 12px',
              background: palette.inputBg,
              border: `1px solid ${palette.inputBorder}`,
              borderRadius: '4px',
              color: palette.text,
              fontSize: '14px',
              outline: 'none',
              boxSizing: 'border-box',
              marginBottom: '16px',
            }}
          />
        )}

        {!loading && section('Parts', parts)}
        {!loading && section('Sketches', sketches)}

        {!loading && docs.length === 0 && (
          <p style={{ fontSize: '13px', color: palette.textSecondary }}>
            No documents yet. Create a part or a sketch to get started.
          </p>
        )}
      </div>
    </div>
  );
}
