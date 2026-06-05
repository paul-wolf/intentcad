import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useDocumentStore } from '@/stores/documentStore';
import { useThemeStore } from '@/theme';
import { createEmptyDocument, migrateDocument, generateDateName } from '@/utils/document';
import { api, partApi, type DocumentListItem, type PartListItem } from '@/api/cachedClient';
import { setBackendId, setProjectContext } from '@/api/autoSave';
import type { Document } from '@/types/document';
import { DocumentThumbnail } from './DocumentThumbnail';
import { PartListThumbnail } from './PartListThumbnail';
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
  const [parts, setParts] = useState<PartListItem[]>([]);
  const [projectName, setProjectName] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingType, setEditingType] = useState<'doc' | 'part'>('doc');
  const [editName, setEditName] = useState('');
  const [editingProjectName, setEditingProjectName] = useState(false);
  const [editProjectName, setEditProjectName] = useState('');
  const clickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchDocs = useCallback(async () => {
    try {
      setLoading(true);
      const [docList, partList] = await Promise.all([
        api.listDocuments(projectId),
        partApi.listParts(projectId),
        projectId ? projectApi.getProject(projectId).then((p) => setProjectName(p.name)).catch(() => {}) : Promise.resolve(),
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
      setProjectContext(projectId ?? null, projectName);
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
      setProjectContext(projectId ?? null, projectName);
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
  const filteredParts = lowerSearch ? parts.filter((p) => p.name.toLowerCase().includes(lowerSearch)) : parts;

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
          <button style={btnStyle} onClick={handleNew}>+ New Sketch</button>
        </div>

        {error === 'offline' && (
          <p style={{ fontSize: '12px', color: palette.warning, marginBottom: '12px' }}>
            Backend offline — local mode
          </p>
        )}

        {/* Search */}
        {!loading && (docs.length > 0 || parts.length > 0) && (
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

        {/* Sketches */}
        {!loading && filteredDocs.length > 0 && (
          <div style={{ marginBottom: '24px' }}>
            <div style={{ fontSize: '13px', color: palette.textSecondary, fontWeight: 600, textTransform: 'uppercase' as const, letterSpacing: '0.5px', marginBottom: '8px' }}>
              Sketches
            </div>
            <div style={{ display: 'flex', flexDirection: 'column' as const, gap: '4px' }}>
              {filteredDocs.map((d) => (
                <div
                  key={d.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '10px',
                    padding: '8px 12px',
                    background: palette.panelBg,
                    borderRadius: '4px',
                    cursor: 'pointer',
                  }}
                  onClick={() => {
                    if (editingId === d.id) return;
                    if (clickTimer.current) clearTimeout(clickTimer.current);
                    clickTimer.current = setTimeout(() => {
                      clickTimer.current = null;
                      handleOpen(d.id);
                    }, 250);
                  }}
                  onDoubleClick={() => {
                    if (clickTimer.current) { clearTimeout(clickTimer.current); clickTimer.current = null; }
                    startRename(d.id, d.name, 'doc');
                  }}
                >
                  <DocumentThumbnail
                    documentId={d.id}
                    width={56}
                    height={42}
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
                    <span style={{ flex: 1, color: palette.text, fontSize: '14px' }}>
                      {d.name}
                    </span>
                  )}
                  <span style={{ fontSize: '12px', color: palette.textSecondary, whiteSpace: 'nowrap' }}>
                    {relativeTime(d.updated_at)}
                  </span>
                  <button
                    style={{
                      background: 'none',
                      border: 'none',
                      color: palette.danger,
                      cursor: 'pointer',
                      fontSize: '18px',
                      padding: '0 4px',
                      lineHeight: 1,
                    }}
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDelete(d.id);
                    }}
                  >
                    &times;
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Parts */}
        {!loading && filteredParts.length > 0 && (
          <div>
            <div style={{ fontSize: '13px', color: palette.textSecondary, fontWeight: 600, textTransform: 'uppercase' as const, letterSpacing: '0.5px', marginBottom: '8px' }}>
              Parts
            </div>
            <div style={{ display: 'flex', flexDirection: 'column' as const, gap: '4px' }}>
              {filteredParts.map((p) => (
                <div
                  key={p.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '10px',
                    padding: '8px 12px',
                    background: palette.panelBg,
                    borderRadius: '4px',
                    cursor: 'pointer',
                  }}
                  onClick={() => {
                    if (editingId === p.id) return;
                    if (clickTimer.current) clearTimeout(clickTimer.current);
                    clickTimer.current = setTimeout(() => {
                      clickTimer.current = null;
                      navigate(`/part/${p.id}`);
                    }, 250);
                  }}
                  onDoubleClick={() => {
                    if (clickTimer.current) { clearTimeout(clickTimer.current); clickTimer.current = null; }
                    startRename(p.id, p.name, 'part');
                  }}
                >
                  <PartListThumbnail
                    partId={p.id}
                    width={56}
                    height={42}
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
                    <span style={{ flex: 1, color: palette.text, fontSize: '14px' }}>
                      {p.name}
                    </span>
                  )}
                  <span style={{ fontSize: '12px', color: palette.textSecondary, whiteSpace: 'nowrap' }}>
                    {relativeTime(p.updated_at)}
                  </span>
                  <button
                    style={{
                      background: 'none',
                      border: 'none',
                      color: palette.danger,
                      cursor: 'pointer',
                      fontSize: '18px',
                      padding: '0 4px',
                      lineHeight: 1,
                    }}
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDeletePart(p.id);
                    }}
                  >
                    &times;
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {!loading && docs.length === 0 && parts.length === 0 && (
          <p style={{ fontSize: '13px', color: palette.textSecondary }}>
            No documents yet. Create a sketch to get started.
          </p>
        )}
      </div>
    </div>
  );
}
