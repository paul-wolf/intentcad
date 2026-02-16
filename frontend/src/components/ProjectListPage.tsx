import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '@/stores/authStore';
import { useThemeStore } from '@/theme';
import { projectApi } from '@/api/projectClient';
import type { Project } from '@/types/project';

export function ProjectListPage() {
  const navigate = useNavigate();
  const palette = useThemeStore((s) => s.palette);
  const { user, logout } = useAuthStore();
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');

  const fetchProjects = useCallback(async () => {
    try {
      setLoading(true);
      const list = await projectApi.listProjects();
      setProjects(list);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchProjects(); }, [fetchProjects]);

  const handleNew = async () => {
    try {
      const project = await projectApi.createProject('New Project');
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
    try {
      await projectApi.updateProject(editingId, { name: trimmed });
      setProjects((prev) => prev.map((p) => (p.id === editingId ? { ...p, name: trimmed } : p)));
    } catch (err) {
      console.error('Failed to rename project:', err);
    }
    setEditingId(null);
  };

  const handleLogout = async () => {
    await logout();
    navigate('/login');
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
          right: '16px',
          display: 'flex',
          alignItems: 'center',
          gap: '10px',
          fontSize: '12px',
        }}
      >
        <span style={{ color: palette.textSecondary }}>{user?.username}</span>
        {(user?.is_staff || user?.is_superuser) && (
          <button
            onClick={() => navigate('/admin/users')}
            style={{ background: 'none', border: 'none', color: palette.primaryBtn, cursor: 'pointer', fontSize: '12px' }}
          >
            Users
          </button>
        )}
        {user?.is_superuser && (
          <button
            onClick={() => navigate('/admin/organisations')}
            style={{ background: 'none', border: 'none', color: palette.primaryBtn, cursor: 'pointer', fontSize: '12px' }}
          >
            Orgs
          </button>
        )}
        <button
          onClick={handleLogout}
          style={{ background: 'none', border: 'none', color: palette.danger, cursor: 'pointer', fontSize: '12px' }}
        >
          Logout
        </button>
      </div>

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
        + New Project
      </button>

      {!loading && projects.length > 0 && (
        <div
          style={{
            marginTop: '20px',
            width: '360px',
            display: 'flex',
            flexDirection: 'column' as const,
            gap: '4px',
          }}
        >
          <div style={{ fontSize: '12px', color: palette.textSecondary, marginBottom: '4px' }}>
            Projects
          </div>
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
                <span
                  style={{ flex: 1, cursor: 'pointer', color: palette.text, fontSize: '14px', fontWeight: 500 }}
                  onClick={() => navigate(`/project/${p.id}`)}
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    startRename(p.id, p.name);
                  }}
                >
                  {p.name}
                </span>
              )}
              <span style={{ fontSize: '11px', color: palette.textSecondary, whiteSpace: 'nowrap' }}>
                {p.document_count}s {p.part_count}p
              </span>
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
                onClick={() => handleDelete(p.id)}
              >
                x
              </button>
            </div>
          ))}
        </div>
      )}

      {!loading && projects.length === 0 && (
        <p style={{ fontSize: '13px', color: palette.textSecondary, marginTop: '16px' }}>
          No projects yet. Create one to get started.
        </p>
      )}
    </div>
  );
}
