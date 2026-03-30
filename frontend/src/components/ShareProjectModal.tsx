import { useState, useEffect } from 'react';
import { useThemeStore } from '@/theme';
import { projectApi } from '@/api/projectClient';
import type { ProjectShare } from '@/types/project';

interface Props {
  projectId: string;
  projectName: string;
  onClose: () => void;
}

export function ShareProjectModal({ projectId, projectName, onClose }: Props) {
  const palette = useThemeStore((s) => s.palette);
  const [shares, setShares] = useState<ProjectShare[]>([]);
  const [email, setEmail] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    projectApi.listShares(projectId).then(setShares).catch(() => {});
  }, [projectId]);

  const handleAdd = async () => {
    const trimmed = email.trim();
    if (!trimmed) return;
    setError('');
    setLoading(true);
    try {
      const share = await projectApi.addShare(projectId, trimmed);
      setShares((prev) => [...prev, share]);
      setEmail('');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to share';
      if (msg.includes('404')) setError('No user found with that email');
      else if (msg.includes('409')) setError('Already shared with this user');
      else setError(msg);
    } finally {
      setLoading(false);
    }
  };

  const handleRemove = async (shareId: string) => {
    try {
      await projectApi.removeShare(projectId, shareId);
      setShares((prev) => prev.filter((s) => s.id !== shareId));
    } catch {
      // ignore
    }
  };

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.5)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
      }}
      onClick={onClose}
    >
      <div
        style={{
          background: palette.panelBg,
          border: `1px solid ${palette.border}`,
          borderRadius: '8px',
          padding: '20px',
          width: '380px',
          maxHeight: '80vh',
          overflowY: 'auto',
          boxShadow: '0 4px 24px rgba(0,0,0,0.3)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
          <span style={{ fontSize: '16px', fontWeight: 600, color: palette.text }}>
            Share "{projectName}"
          </span>
          <button
            onClick={onClose}
            style={{ background: 'none', border: 'none', color: palette.textSecondary, fontSize: '20px', cursor: 'pointer' }}
          >
            &times;
          </button>
        </div>

        <div style={{ display: 'flex', gap: '8px', marginBottom: '12px' }}>
          <input
            type="email"
            placeholder="Email address"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleAdd(); }}
            style={{
              flex: 1,
              padding: '6px 10px',
              background: palette.panelBg,
              border: `1px solid ${palette.border}`,
              borderRadius: '4px',
              color: palette.text,
              fontSize: '14px',
              outline: 'none',
            }}
          />
          <button
            onClick={handleAdd}
            disabled={loading}
            style={{
              padding: '6px 14px',
              background: palette.primaryBtn,
              color: '#fff',
              border: 'none',
              borderRadius: '4px',
              fontSize: '13px',
              cursor: loading ? 'wait' : 'pointer',
            }}
          >
            Share
          </button>
        </div>

        {error && (
          <div style={{ color: palette.danger, fontSize: '13px', marginBottom: '8px' }}>
            {error}
          </div>
        )}

        {shares.length > 0 && (
          <div style={{ fontSize: '12px', color: palette.textSecondary, marginBottom: '6px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
            Shared with
          </div>
        )}

        {shares.map((s) => (
          <div
            key={s.id}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '6px 0',
              borderBottom: `1px solid ${palette.border}`,
            }}
          >
            <div>
              <div style={{ color: palette.text, fontSize: '14px' }}>{s.username}</div>
              <div style={{ color: palette.textSecondary, fontSize: '12px' }}>{s.email}</div>
            </div>
            <button
              onClick={() => handleRemove(s.id)}
              style={{
                background: 'none',
                border: 'none',
                color: palette.danger,
                fontSize: '13px',
                cursor: 'pointer',
              }}
            >
              Remove
            </button>
          </div>
        ))}

        {shares.length === 0 && (
          <div style={{ color: palette.textSecondary, fontSize: '13px', padding: '8px 0' }}>
            Not shared with anyone yet.
          </div>
        )}
      </div>
    </div>
  );
}
