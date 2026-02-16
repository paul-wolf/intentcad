import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '@/stores/authStore';
import { useThemeStore } from '@/theme';
import { projectApi } from '@/api/projectClient';
import { api, type DocumentListItem } from '@/api/client';
import { useDocumentStore } from '@/stores/documentStore';
import { migrateDocument } from '@/utils/document';
import { setBackendId, setProjectContext } from '@/api/autoSave';
import type { Document } from '@/types/document';
import type { Project } from '@/types/project';

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

export function ProjectListPage() {
  const navigate = useNavigate();
  const palette = useThemeStore((s) => s.palette);
  const { user, logout } = useAuthStore();
  const setDocument = useDocumentStore((s) => s.setDocument);
  const [projects, setProjects] = useState<Project[]>([]);
  const [recentDocs, setRecentDocs] = useState<DocumentListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const clickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchData = useCallback(async () => {
    try {
      setLoading(true);
      const [projectList, docList] = await Promise.all([
        projectApi.listProjects(),
        api.listDocuments(),
      ]);

      let finalProjects = projectList;
      if (projectList.length === 0) {
        await projectApi.createProject('Default Project');
        finalProjects = await projectApi.listProjects();
      }

      setProjects(finalProjects);
      setRecentDocs(docList.slice(0, 8));
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  const handleNew = async () => {
    const existing = new Set(projects.map((p) => p.name));
    let name = 'New Project';
    let i = 2;
    while (existing.has(name)) { name = `New Project ${i++}`; }
    try {
      const project = await projectApi.createProject(name);
      navigate(`/project/${project.id}`);
    } catch (err) {
      console.error('Failed to create project:', err);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await projectApi.deleteProject(id);
      setProjects((prev) => prev.filter((p) => p.id !== id));
    } catch (err) {
      console.error('Failed to delete project:', err);
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
    const duplicate = projects.some((p) => p.id !== editingId && p.name === trimmed);
    if (duplicate) {
      setEditingId(null);
      return;
    }
    try {
      await projectApi.updateProject(editingId, { name: trimmed });
      setProjects((prev) => prev.map((p) => (p.id === editingId ? { ...p, name: trimmed } : p)));
    } catch (err) {
      console.error('Failed to rename project:', err);
    }
    setEditingId(null);
  };

  const handleOpenDoc = async (id: string) => {
    try {
      const full = await api.getDocument(id);
      setDocument(migrateDocument(full.data as unknown as Document));
      setBackendId(full.id);
      // Resolve project context for the document
      if (full.project_id) {
        const proj = projects.find((p) => p.id === full.project_id);
        setProjectContext(full.project_id, proj?.name ?? null);
      } else {
        setProjectContext(null, null);
      }
      navigate(`/edit/${id}`);
    } catch (err) {
      console.error('Failed to load document:', err);
    }
  };

  const handleLogout = async () => {
    await logout();
    navigate('/login');
  };

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
        {/* Top bar */}
        <div style={{
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          marginBottom: '8px',
        }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px' }}>
            <span style={{ fontSize: '20px', fontWeight: 700, color: palette.text }}>IntentCAD</span>
            <span style={{ fontSize: '13px', color: palette.textSecondary }}>v0.1</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', fontSize: '14px' }}>
            <span
              style={{ color: palette.textSecondary, cursor: 'pointer' }}
              onClick={() => navigate('/profile')}
            >
              {user?.username}
              {user?.organisation && <> &middot; {user.organisation.name}</>}
            </span>
            <button
              onClick={handleLogout}
              style={{ background: 'none', border: 'none', color: palette.danger, cursor: 'pointer', fontSize: '14px' }}
            >
              Logout
            </button>
          </div>
        </div>
        <div style={{ borderBottom: `1px solid ${palette.textSecondary}`, marginBottom: '24px', opacity: 0.3 }} />

        {/* Admin section */}
        {!loading && (user?.is_staff || user?.is_superuser) && (
          <div style={{ marginBottom: '24px', display: 'flex', gap: '12px' }}>
            <button style={btnStyle} onClick={() => navigate('/manage/users')}>Users</button>
            {user?.is_superuser && (
              <button style={btnStyle} onClick={() => navigate('/manage/organisations')}>Organisations</button>
            )}
          </div>
        )}

        {/* Two-column body */}
        {!loading && (
          <div style={{ display: 'flex', gap: '24px', alignItems: 'flex-start' }}>
            {/* Projects column */}
            <div style={{ flex: '55 1 0%', minWidth: 0 }}>
              <div style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                marginBottom: '8px',
              }}>
                <span style={{ fontSize: '13px', color: palette.textSecondary, fontWeight: 600, textTransform: 'uppercase' as const, letterSpacing: '0.5px' }}>
                  Projects
                </span>
                <button style={btnStyle} onClick={handleNew}>+ New</button>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column' as const, gap: '4px' }}>
                {projects.map((p) => (
                  <div
                    key={p.id}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '8px',
                      padding: '10px 12px',
                      background: palette.panelBg,
                      borderRadius: '4px',
                      cursor: 'pointer',
                    }}
                    onClick={() => {
                      if (editingId === p.id) return;
                      if (clickTimer.current) clearTimeout(clickTimer.current);
                      clickTimer.current = setTimeout(() => {
                        clickTimer.current = null;
                        navigate(`/project/${p.id}`);
                      }, 250);
                    }}
                    onDoubleClick={() => {
                      if (clickTimer.current) { clearTimeout(clickTimer.current); clickTimer.current = null; }
                      startRename(p.id, p.name);
                    }}
                  >
                    {editingId === p.id ? (
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
                      <span style={{ flex: 1, color: palette.text, fontSize: '14px', fontWeight: 500 }}>
                        {p.name}
                      </span>
                    )}
                    <span style={{ fontSize: '13px', color: palette.textSecondary, whiteSpace: 'nowrap' }}>
                      {p.document_count}
                    </span>
                    <span style={{ fontSize: '18px', color: palette.textSecondary, lineHeight: 1 }}>&#9656;</span>
                    {p.document_count === 0 && (
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
                          handleDelete(p.id);
                        }}
                      >
                        &times;
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>

            {/* Recent Sketches column */}
            <div style={{ flex: '45 1 0%', minWidth: 0 }}>
              <div style={{ marginBottom: '8px' }}>
                <span style={{ fontSize: '13px', color: palette.textSecondary, fontWeight: 600, textTransform: 'uppercase' as const, letterSpacing: '0.5px' }}>
                  Recent Sketches
                </span>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column' as const, gap: '4px' }}>
                {recentDocs.length === 0 && (
                  <span style={{ fontSize: '13px', color: palette.textSecondary, padding: '10px 0' }}>
                    No sketches yet.
                  </span>
                )}
                {recentDocs.map((d) => (
                  <div
                    key={d.id}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '8px',
                      padding: '10px 12px',
                      background: palette.panelBg,
                      borderRadius: '4px',
                      cursor: 'pointer',
                    }}
                    onClick={() => handleOpenDoc(d.id)}
                  >
                    <span style={{ fontSize: '14px', color: palette.text }}>&#9656;</span>
                    <span style={{ flex: 1, color: palette.text, fontSize: '14px' }}>
                      {d.name}
                    </span>
                    <span style={{ fontSize: '12px', color: palette.textSecondary, whiteSpace: 'nowrap' }}>
                      {relativeTime(d.updated_at)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

      </div>
    </div>
  );
}
