import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '@/stores/authStore';
import { useThemeStore } from '@/theme';
import { projectApi } from '@/api/projectClient';
import { api, type DocumentListItem } from '@/api/cachedClient';
import { useDocumentStore } from '@/stores/documentStore';
import { migrateDocument } from '@/utils/document';
import { setBackendId, setProjectContext } from '@/api/autoSave';
import type { Document } from '@/types/document';
import { ShareProjectModal } from './ShareProjectModal';
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
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const clickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [sharingProject, setSharingProject] = useState<Project | null>(null);

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
      setRecentDocs(
        [...docList].sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, 8)
      );
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
    if (!editingId || !editName.trim()) { setEditingId(null); return; }
    const trimmed = editName.trim();
    if (!projects.some((p) => p.id !== editingId && p.name === trimmed)) {
      try {
        await projectApi.updateProject(editingId, { name: trimmed });
        setProjects((prev) => prev.map((p) => (p.id === editingId ? { ...p, name: trimmed } : p)));
      } catch (err) {
        console.error('Failed to rename project:', err);
      }
    }
    setEditingId(null);
  };

  const handleOpenDoc = async (id: string) => {
    try {
      const full = await api.getDocument(id);
      setDocument(migrateDocument(full.data as unknown as Document));
      setBackendId(full.id);
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

  const navLink: React.CSSProperties = {
    background: 'none',
    border: 'none',
    color: palette.textSecondary,
    cursor: 'pointer',
    fontSize: '13px',
    padding: '0',
    textDecoration: 'none',
  };

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

      {/* ── Top navbar ── */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        padding: '0 24px',
        height: '48px',
        flexShrink: 0,
        background: palette.panelBg,
        borderBottom: `1px solid ${palette.border}`,
        gap: '20px',
      }}>
        {/* Brand */}
        <div style={{ display: 'flex', alignItems: 'baseline', gap: '6px', marginRight: '8px' }}>
          <span style={{ fontSize: '16px', fontWeight: 700, color: palette.text, letterSpacing: '-0.3px' }}>
            IntentCAD
          </span>
          <span style={{ fontSize: '11px', color: palette.textMuted }}>v0.1</span>
        </div>

        <div style={{ flex: 1 }} />

        {/* Admin links */}
        {(user?.is_staff || user?.is_superuser) && (
          <>
            <button style={navLink} onClick={() => navigate('/manage/users')}>Users</button>
            {user?.is_superuser && (
              <button style={navLink} onClick={() => navigate('/manage/organisations')}>Organisations</button>
            )}
            <span style={{ color: palette.border }}>|</span>
          </>
        )}

        {/* User */}
        <button
          style={{ ...navLink, color: palette.text }}
          onClick={() => navigate('/profile')}
          title="Profile"
        >
          {user?.username}
          {user?.organisation && (
            <span style={{ color: palette.textMuted }}> · {user.organisation.name}</span>
          )}
        </button>

        {/* Logout */}
        <button
          onClick={handleLogout}
          style={{ ...navLink, color: palette.danger }}
        >
          Logout
        </button>
      </div>

      {/* ── Main content ── */}
      <div style={{ flex: 1, overflow: 'auto' }}>
        <div style={{ maxWidth: '900px', margin: '0 auto', padding: '32px 24px' }}>
          {!loading && (
            <div style={{ display: 'flex', gap: '32px', alignItems: 'flex-start' }}>

              {/* ── Projects column ── */}
              <div style={{ flex: '55 1 0%', minWidth: 0 }}>
                <div style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  marginBottom: '12px',
                }}>
                  <span style={{
                    fontSize: '12px', fontWeight: 600, color: palette.textMuted,
                    textTransform: 'uppercase', letterSpacing: '0.6px',
                  }}>
                    Projects
                  </span>
                  <button
                    onClick={handleNew}
                    style={{
                      padding: '5px 14px',
                      background: palette.primaryBtn,
                      color: '#fff',
                      border: 'none',
                      borderRadius: '5px',
                      fontSize: '13px',
                      cursor: 'pointer',
                    }}
                  >
                    + New
                  </button>
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
                  {projects.map((p) => (
                    <div
                      key={p.id}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '8px',
                        padding: '9px 12px',
                        background: hoveredId === p.id ? palette.activeItemBg : palette.panelBg,
                        borderRadius: '5px',
                        cursor: 'pointer',
                        transition: 'background 0.1s',
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
                      onMouseEnter={() => setHoveredId(p.id)}
                      onMouseLeave={() => setHoveredId(null)}
                    >
                      {editingId === p.id ? (
                        <input
                          style={{
                            flex: 1, background: palette.inputBg,
                            border: `1px solid ${palette.inputBorder}`,
                            borderRadius: '3px', color: palette.text,
                            fontSize: '14px', padding: '2px 6px', outline: 'none',
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
                        <>
                          <span style={{ flex: 1, color: palette.text, fontSize: '14px', fontWeight: 500 }}>
                            {p.name}
                          </span>
                          {hoveredId === p.id && editingId !== p.id && (
                            <span style={{ fontSize: '11px', color: palette.textMuted }}>dbl-click to rename</span>
                          )}
                        </>
                      )}
                      <span style={{
                        fontSize: '12px', color: palette.textMuted,
                        background: palette.background, borderRadius: '10px',
                        padding: '1px 7px', flexShrink: 0,
                      }}>
                        {p.document_count}
                      </span>
                      <button
                        style={{ background: 'none', border: 'none', color: palette.textMuted, cursor: 'pointer', fontSize: '14px', padding: '0 2px', lineHeight: 1 }}
                        title="Share project"
                        onClick={(e) => { e.stopPropagation(); setSharingProject(p); }}
                      >
                        &#x1F517;
                      </button>
                      <span style={{ color: palette.textMuted, fontSize: '14px', lineHeight: 1 }}>›</span>
                      {p.document_count === 0 && (
                        <button
                          style={{ background: 'none', border: 'none', color: palette.danger, cursor: 'pointer', fontSize: '16px', padding: '0 2px', lineHeight: 1 }}
                          onClick={(e) => { e.stopPropagation(); handleDelete(p.id); }}
                        >
                          &times;
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              </div>

              {/* ── Recent Sketches column ── */}
              <div style={{ flex: '45 1 0%', minWidth: 0 }}>
                <div style={{ marginBottom: '12px' }}>
                  <span style={{
                    fontSize: '12px', fontWeight: 600, color: palette.textMuted,
                    textTransform: 'uppercase', letterSpacing: '0.6px',
                  }}>
                    Recent Sketches
                  </span>
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
                  {recentDocs.length === 0 && (
                    <span style={{ fontSize: '13px', color: palette.textMuted, padding: '10px 0' }}>
                      No sketches yet.
                    </span>
                  )}
                  {recentDocs.map((d) => {
                    const proj = projects.find((p) => p.id === d.project_id);
                    return (
                      <div
                        key={d.id}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: '8px',
                          padding: '9px 12px',
                          background: palette.panelBg,
                          borderRadius: '5px',
                          cursor: 'pointer',
                        }}
                        onClick={() => handleOpenDoc(d.id)}
                      >
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{
                            color: palette.text, fontSize: '14px',
                            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                          }}>
                            {d.name}
                          </div>
                          {proj && (
                            <div style={{
                              fontSize: '11px', color: palette.textMuted,
                              marginTop: '1px',
                            }}>
                              {proj.name}
                            </div>
                          )}
                        </div>
                        <span style={{ fontSize: '12px', color: palette.textMuted, whiteSpace: 'nowrap', flexShrink: 0 }}>
                          {relativeTime(d.updated_at)}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>

            </div>
          )}
        </div>
      </div>

      {sharingProject && (
        <ShareProjectModal
          projectId={sharingProject.id}
          projectName={sharingProject.name}
          onClose={() => setSharingProject(null)}
        />
      )}
    </div>
  );
}
