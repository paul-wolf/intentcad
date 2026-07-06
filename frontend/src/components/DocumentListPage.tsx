import { useState, useEffect, useCallback, type CSSProperties } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useAuthStore } from '@/stores/authStore';
import { useDocumentStore } from '@/stores/documentStore';
import { createEmptyDocument, createEmptyPart, migrateDocument } from '@/utils/document';
import { api, type DocumentListItem } from '@/api/cachedClient';
import { setBackendId, setProjectContext } from '@/api/autoSave';
import type { Document } from '@/types/document';
import { projectApi } from '@/api/projectClient';
import { TopNav } from '@/ui/TopNav';
import { DocCard } from '@/ui/DocCard';
import { useTokens, SANS, MONO } from '@/ui/tokens';

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

type Filter = 'all' | 'parts' | 'sketches';

export function DocumentListPage() {
  const navigate = useNavigate();
  const { projectId } = useParams<{ projectId: string }>();
  const t = useTokens();
  const { user } = useAuthStore();
  const setDocument = useDocumentStore((s) => s.setDocument);
  const [docs, setDocs] = useState<DocumentListItem[]>([]);
  const [projectName, setProjectName] = useState('');
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');

  const ownerName = [user?.first_name, user?.last_name].filter(Boolean).join(' ') || user?.username || '';
  const ownerInitials = ((user?.first_name?.[0] ?? '') + (user?.last_name?.[0] ?? '') || user?.username?.slice(0, 2) || '?').toUpperCase();

  const fetchDocs = useCallback(async () => {
    try {
      setLoading(true);
      const [docList] = await Promise.all([
        api.listDocuments(projectId),
        projectId ? projectApi.getProject(projectId).then((p) => setProjectName(p.name)).catch(() => {}) : Promise.resolve(),
      ]);
      setDocs(docList);
    } catch { /* ignore */ } finally { setLoading(false); }
  }, [projectId]);

  useEffect(() => { fetchDocs(); }, [fetchDocs]);

  const createAndOpen = async (doc: Document, route: (id: string) => string) => {
    setDocument(doc);
    try {
      const saved = await api.createDocument(doc.name, doc as unknown as Record<string, unknown>, projectId);
      setBackendId(saved.id);
      setProjectContext(projectId ?? null, projectName);
      navigate(route(saved.id));
    } catch { setBackendId(null); navigate(route(doc.id)); }
  };
  const dateName = () => new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const handleNew = () => createAndOpen(createEmptyDocument(dateName()), (id) => `/edit/${id}`);
  const handleNewPart = () => createAndOpen(createEmptyPart(dateName()), (id) => `/part/${id}`);

  const handleOpen = async (d: DocumentListItem) => {
    try {
      const full = await api.getDocument(d.id);
      setDocument(migrateDocument(full.data as unknown as Document));
      setBackendId(full.id);
      setProjectContext(projectId ?? null, projectName);
      navigate(d.kind === 'part' ? `/part/${d.id}` : `/edit/${d.id}`);
    } catch (err) { console.error('Failed to load document:', err); }
  };

  const handleDelete = async (id: string) => {
    try { await api.deleteDocument(id); setDocs((prev) => prev.filter((d) => d.id !== id)); }
    catch (err) { console.error('Failed to delete document:', err); }
  };

  const commitRename = async () => {
    if (!editingId || !editName.trim()) { setEditingId(null); return; }
    const trimmed = editName.trim();
    try {
      await api.updateDocument(editingId, { name: trimmed });
      setDocs((prev) => prev.map((d) => (d.id === editingId ? { ...d, name: trimmed } : d)));
    } catch (err) { console.error('Failed to rename:', err); }
    setEditingId(null);
  };

  const lower = search.toLowerCase();
  const visible = lower ? docs.filter((d) => d.name.toLowerCase().includes(lower)) : docs;
  const parts = visible.filter((d) => d.kind === 'part');
  const sketches = visible.filter((d) => d.kind !== 'part');
  const latest = docs.length ? docs.reduce((a, b) => (a.updated_at > b.updated_at ? a : b)).updated_at : null;

  const seg = (active: boolean): CSSProperties => ({
    padding: '7px 14px', borderRadius: 8, fontFamily: SANS, fontSize: '13px', fontWeight: 600, cursor: 'pointer',
    background: active ? t.accentSoft : t.surface, color: active ? t.accent : t.textDim,
    border: `1px solid ${active ? t.accent : t.border}`,
  });
  const cardOf = (d: DocumentListItem) => (
    <DocCard key={d.id}
      d={{ id: d.id, name: d.name, kind: d.kind, updated: relativeTime(d.updated_at) }}
      onOpen={() => handleOpen(d)}
      onDoubleClick={() => { setEditingId(d.id); setEditName(d.name); }}
      onDelete={() => handleDelete(d.id)}
      editing={editingId === d.id ? { value: editName, onChange: setEditName, onCommit: commitRename, onCancel: () => setEditingId(null) } : undefined}
    />
  );

  const sectionHeader = (color: string, label: string, count: number) => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 14 }}>
      <span style={{ width: 8, height: 8, borderRadius: 2, background: color }} />
      <span style={{ fontFamily: MONO, fontSize: '11px', letterSpacing: '1.5px', color: t.textDim }}>{label}</span>
      <span style={{ fontFamily: MONO, fontSize: '11px', color: t.textMute }}>({count})</span>
      <span style={{ flex: 1, height: 1, background: t.border }} />
    </div>
  );

  const grid: CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(224px,1fr))', gap: 16, marginBottom: 40 };
  const showParts = (filter === 'all' || filter === 'parts') && parts.length > 0;
  const showSketches = (filter === 'all' || filter === 'sketches') && sketches.length > 0;

  return (
    <div style={{ height: '100%', overflow: 'auto', background: t.appBg, color: t.text, fontFamily: SANS }}>
      <TopNav />

      {!loading && (
        <div style={{ maxWidth: 1200, margin: '0 auto', padding: '28px 28px 72px' }}>
          {/* Breadcrumb */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontFamily: MONO, fontSize: '12px', marginBottom: 20 }}>
            <button onClick={() => navigate('/')}
              style={{ background: 'none', border: 'none', padding: 0, color: t.textMute, cursor: 'pointer', fontFamily: MONO, fontSize: '12px' }}>Projects</button>
            <span style={{ color: t.textMute }}>/</span>
            <span style={{ color: t.textDim }}>{projectName}</span>
          </div>

          {/* Header */}
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 20, marginBottom: 26 }}>
            <div>
              <h1 style={{ margin: 0, fontSize: '26px', fontWeight: 700, letterSpacing: '-0.5px', color: t.text }}>{projectName}</h1>
              <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginTop: 10, fontFamily: MONO, fontSize: '12px', color: t.textDim }}>
                <span>{docs.length} documents</span>
                <span style={{ color: t.border2 }}>|</span>
                <span style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                  <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 20, height: 20, borderRadius: '50%', background: t.surface3, color: t.textDim, fontSize: '9px', fontWeight: 600 }}>{ownerInitials}</span>
                  {ownerName}
                </span>
                {latest && <><span style={{ color: t.border2 }}>|</span><span>updated {relativeTime(latest)}</span></>}
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
              <button onClick={handleNew}
                style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '9px 14px', background: t.surface, color: t.text,
                         border: `1px solid ${t.border2}`, borderRadius: 9, fontSize: '13px', fontWeight: 600, cursor: 'pointer' }}>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
                New sketch
              </button>
              <button onClick={handleNewPart}
                style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '9px 14px', background: t.accent, color: '#fff',
                         border: 'none', borderRadius: 9, fontSize: '13px', fontWeight: 600, cursor: 'pointer', boxShadow: `0 6px 16px -8px ${t.accent}` }}>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
                New part
              </button>
            </div>
          </div>

          {/* Toolbar */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, marginBottom: 28 }}>
            <div style={{ position: 'relative', flex: 1, maxWidth: 340 }}>
              <span style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: t.textMute, display: 'flex' }}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="7" /><path d="M21 21l-4-4" /></svg>
              </span>
              <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search documents..."
                style={{ width: '100%', padding: '9px 12px 9px 36px', background: t.surface, border: `1px solid ${t.border}`,
                         borderRadius: 9, color: t.text, fontFamily: SANS, fontSize: '13px', outline: 'none' }}
                onFocus={(e) => (e.currentTarget.style.borderColor = t.accent)}
                onBlur={(e) => (e.currentTarget.style.borderColor = t.border)} />
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              <button onClick={() => setFilter('all')} style={seg(filter === 'all')}>All</button>
              <button onClick={() => setFilter('parts')} style={seg(filter === 'parts')}>Parts &middot; {docs.filter((d) => d.kind === 'part').length}</button>
              <button onClick={() => setFilter('sketches')} style={seg(filter === 'sketches')}>Sketches &middot; {docs.filter((d) => d.kind !== 'part').length}</button>
            </div>
          </div>

          {showParts && (<>{sectionHeader(t.part, 'PARTS', parts.length)}<div style={grid}>{parts.map(cardOf)}</div></>)}
          {showSketches && (<>{sectionHeader(t.sketch, 'SKETCHES', sketches.length)}<div style={grid}>{sketches.map(cardOf)}</div></>)}

          {!showParts && !showSketches && (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 6,
                          padding: '64px 20px', border: `1px dashed ${t.border2}`, borderRadius: 14, background: t.surface }}>
              <div style={{ fontFamily: MONO, fontSize: '13px', color: t.textDim }}>
                {docs.length === 0 ? 'No documents yet' : 'Nothing matches'}
              </div>
              <div style={{ fontSize: '13px', color: t.textMute }}>
                {docs.length === 0 ? 'Create a part or a sketch to get started.' : 'Try a different search or filter.'}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
