import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '@/stores/authStore';
import { projectApi } from '@/api/projectClient';
import { api, type DocumentListItem } from '@/api/cachedClient';
import { useDocumentStore } from '@/stores/documentStore';
import { migrateDocument } from '@/utils/document';
import { setBackendId, setProjectContext } from '@/api/autoSave';
import type { Document } from '@/types/document';
import type { Project } from '@/types/project';
import { ShareProjectModal } from './ShareProjectModal';
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
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

const COLS = 'minmax(0,1fr) 130px 150px 190px 46px';

export function ProjectListPage() {
  const navigate = useNavigate();
  const t = useTokens();
  const { user } = useAuthStore();
  const setDocument = useDocumentStore((s) => s.setDocument);
  const [projects, setProjects] = useState<Project[]>([]);
  const [recentDocs, setRecentDocs] = useState<DocumentListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const clickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [sharingProject, setSharingProject] = useState<Project | null>(null);

  const ownerName = [user?.first_name, user?.last_name].filter(Boolean).join(' ') || user?.username || '';
  const ownerInitials = ((user?.first_name?.[0] ?? '') + (user?.last_name?.[0] ?? '') || user?.username?.slice(0, 2) || '?').toUpperCase();

  const fetchData = useCallback(async () => {
    try {
      setLoading(true);
      const [projectList, docList] = await Promise.all([projectApi.listProjects(), api.listDocuments()]);
      let finalProjects = projectList;
      if (projectList.length === 0) {
        await projectApi.createProject('Default Project');
        finalProjects = await projectApi.listProjects();
      }
      setProjects(finalProjects);
      setRecentDocs([...docList].sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, 8));
    } catch { /* ignore */ } finally { setLoading(false); }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  const handleNew = async () => {
    const existing = new Set(projects.map((p) => p.name));
    let name = 'New Project';
    let i = 2;
    while (existing.has(name)) name = `New Project ${i++}`;
    try { const project = await projectApi.createProject(name); navigate(`/project/${project.id}`); }
    catch (err) { console.error('Failed to create project:', err); }
  };

  const handleDelete = async (id: string) => {
    try { await projectApi.deleteProject(id); setProjects((prev) => prev.filter((p) => p.id !== id)); }
    catch (err) { console.error('Failed to delete project:', err); }
  };

  const commitRename = async () => {
    if (!editingId || !editName.trim()) { setEditingId(null); return; }
    const trimmed = editName.trim();
    if (!projects.some((p) => p.id !== editingId && p.name === trimmed)) {
      try {
        await projectApi.updateProject(editingId, { name: trimmed });
        setProjects((prev) => prev.map((p) => (p.id === editingId ? { ...p, name: trimmed } : p)));
      } catch (err) { console.error('Failed to rename project:', err); }
    }
    setEditingId(null);
  };

  const handleOpenDoc = async (d: DocumentListItem) => {
    try {
      const full = await api.getDocument(d.id);
      setDocument(migrateDocument(full.data as unknown as Document));
      setBackendId(full.id);
      const proj = projects.find((p) => p.id === full.project_id);
      setProjectContext(full.project_id ?? null, proj?.name ?? null);
      navigate(d.kind === 'part' ? `/part/${d.id}` : `/edit/${d.id}`);
    } catch (err) { console.error('Failed to load document:', err); }
  };

  const totalDocs = projects.reduce((n, p) => n + p.document_count, 0);
  const iconBtn = { background: 'none', border: 'none', cursor: 'pointer', padding: '0 2px', lineHeight: 1, display: 'flex' };

  return (
    <div style={{ height: '100%', overflow: 'auto', background: t.appBg, color: t.text, fontFamily: SANS }}>
      <TopNav />

      {!loading && (
        <div style={{ maxWidth: 1200, margin: '0 auto', padding: '40px 28px 72px' }}>
          {/* Header */}
          <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 20, marginBottom: 34 }}>
            <div>
              <div style={{ fontFamily: MONO, fontSize: '11px', letterSpacing: '2px', color: t.accent, marginBottom: 8 }}>WORKSPACE</div>
              <h1 style={{ margin: 0, fontSize: '28px', fontWeight: 700, letterSpacing: '-0.6px', color: t.text }}>Projects</h1>
              <div style={{ fontFamily: MONO, fontSize: '12.5px', color: t.textDim, marginTop: 7 }}>
                {projects.length} projects &middot; {totalDocs} documents
              </div>
            </div>
            <button onClick={handleNew}
              style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '10px 16px', background: t.accent, color: '#fff',
                       border: 'none', borderRadius: 9, fontFamily: SANS, fontSize: '13.5px', fontWeight: 600, cursor: 'pointer',
                       boxShadow: `0 6px 16px -8px ${t.accent}` }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
              New project
            </button>
          </div>

          {/* Projects table (capped height, scrolls, so the doc grid stays visible) */}
          <div style={{ background: t.surface, border: `1px solid ${t.border}`, borderRadius: 14, overflow: 'auto',
                        maxHeight: '46vh', marginBottom: 44 }}>
            <div style={{ position: 'sticky', top: 0, zIndex: 1, background: t.surface,
                          display: 'grid', gridTemplateColumns: COLS, gap: 14, padding: '12px 20px', borderBottom: `1px solid ${t.border}`,
                          fontFamily: MONO, fontSize: '10.5px', letterSpacing: '1px', color: t.textMute }}>
              <div>PROJECT</div><div>DOCUMENTS</div><div>LAST EDITED</div><div>OWNER</div><div />
            </div>
            {projects.map((p) => (
              <div key={p.id}
                onClick={() => {
                  if (editingId === p.id) return;
                  if (clickTimer.current) clearTimeout(clickTimer.current);
                  clickTimer.current = setTimeout(() => { clickTimer.current = null; navigate(`/project/${p.id}`); }, 250);
                }}
                onDoubleClick={() => { if (clickTimer.current) { clearTimeout(clickTimer.current); clickTimer.current = null; } setEditingId(p.id); setEditName(p.name); }}
                onMouseEnter={() => setHoveredId(p.id)} onMouseLeave={() => setHoveredId(null)}
                style={{ display: 'grid', gridTemplateColumns: COLS, gap: 14, alignItems: 'center', padding: '15px 20px',
                         borderBottom: `1px solid ${t.border}`, cursor: 'pointer',
                         background: hoveredId === p.id ? t.surface2 : 'transparent' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 13, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 38, height: 38, flexShrink: 0,
                                borderRadius: 9, background: t.surface3, color: t.textDim }}>
                    <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round"><path d="M3 7.5V19a1.5 1.5 0 0 0 1.5 1.5h15A1.5 1.5 0 0 0 21 19V9a1.5 1.5 0 0 0-1.5-1.5h-7L10 4.8A1.5 1.5 0 0 0 8.8 4H4.5A1.5 1.5 0 0 0 3 5.5z" /></svg>
                  </div>
                  {editingId === p.id ? (
                    <input value={editName} autoFocus onClick={(e) => e.stopPropagation()}
                      onChange={(e) => setEditName(e.target.value)} onBlur={commitRename}
                      onKeyDown={(e) => { if (e.key === 'Enter') commitRename(); if (e.key === 'Escape') setEditingId(null); }}
                      style={{ flex: 1, background: t.appBg, border: `1px solid ${t.accent}`, borderRadius: 6, color: t.text, fontSize: '15px', padding: '4px 8px', outline: 'none' }} />
                  ) : (
                    <span style={{ fontSize: '15px', fontWeight: 600, color: t.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.name}</span>
                  )}
                </div>
                <div style={{ fontFamily: MONO, fontSize: '13px', color: t.textDim }}>{p.document_count} files</div>
                <div style={{ fontFamily: MONO, fontSize: '12.5px', color: t.textMute }}>{relativeTime(p.updated_at)}</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 9, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 26, height: 26, flexShrink: 0,
                                borderRadius: '50%', background: t.surface3, color: t.textDim, fontFamily: MONO, fontSize: '10.5px', fontWeight: 600 }}>{ownerInitials}</div>
                  <span style={{ fontSize: '12.5px', color: t.textDim, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{ownerName}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 4, color: t.textMute }}>
                  {hoveredId === p.id ? (
                    <>
                      <button style={iconBtn} title="Share" onClick={(e) => { e.stopPropagation(); setSharingProject(p); }}>
                        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke={t.textDim} strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><circle cx="18" cy="5" r="3" /><circle cx="6" cy="12" r="3" /><circle cx="18" cy="19" r="3" /><path d="M8.6 13.5l6.8 4M15.4 6.5l-6.8 4" /></svg>
                      </button>
                      {p.document_count === 0 && (
                        <button style={iconBtn} title="Delete" onClick={(e) => { e.stopPropagation(); handleDelete(p.id); }}>
                          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke={t.danger} strokeWidth="1.9" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
                        </button>
                      )}
                    </>
                  ) : (
                    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 6l6 6-6 6" /></svg>
                  )}
                </div>
              </div>
            ))}
          </div>

          {/* Recently edited */}
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 11, marginBottom: 16 }}>
            <h2 style={{ margin: 0, fontSize: '17px', fontWeight: 700, letterSpacing: '-0.3px', color: t.text }}>Recently edited</h2>
            <span style={{ fontFamily: MONO, fontSize: '11.5px', color: t.textMute }}>across all projects</span>
          </div>
          {recentDocs.length === 0 ? (
            <div style={{ fontSize: '13px', color: t.textMute }}>No documents yet.</div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(224px,1fr))', gap: 16 }}>
              {recentDocs.map((d) => (
                <DocCard key={d.id}
                  d={{ id: d.id, name: d.name, kind: d.kind, updated: relativeTime(d.updated_at), thumbnail: d.thumbnail,
                       subtitle: projects.find((p) => p.id === d.project_id)?.name }}
                  onOpen={() => handleOpenDoc(d)} />
              ))}
            </div>
          )}
        </div>
      )}

      {sharingProject && (
        <ShareProjectModal projectId={sharingProject.id} projectName={sharingProject.name} onClose={() => setSharingProject(null)} />
      )}
    </div>
  );
}
