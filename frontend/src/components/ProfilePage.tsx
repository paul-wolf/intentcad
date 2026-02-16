import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '@/stores/authStore';
import { useThemeStore } from '@/theme';
import { authApi } from '@/api/authClient';

export function ProfilePage() {
  const navigate = useNavigate();
  const palette = useThemeStore((s) => s.palette);
  const { user, checkAuth } = useAuthStore();

  const [email, setEmail] = useState(user?.email ?? '');
  const [firstName, setFirstName] = useState(user?.first_name ?? '');
  const [lastName, setLastName] = useState(user?.last_name ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await authApi.updateMe({
        email: email.trim(),
        first_name: firstName.trim(),
        last_name: lastName.trim(),
      });
      await checkAuth();
      navigate('/');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  const inputStyle: React.CSSProperties = {
    width: '100%',
    padding: '8px 10px',
    background: palette.inputBg,
    border: `1px solid ${palette.inputBorder}`,
    borderRadius: '4px',
    color: palette.text,
    fontSize: '14px',
    outline: 'none',
    boxSizing: 'border-box',
  };

  const labelStyle: React.CSSProperties = {
    fontSize: '13px',
    color: palette.textSecondary,
    marginBottom: '4px',
    display: 'block',
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
      <div style={{ maxWidth: '420px', margin: '0 auto', padding: '32px 24px' }}>
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
            marginBottom: '24px',
          }}
        >
          &larr; Home
        </button>

        <h2 style={{ fontSize: '18px', fontWeight: 700, color: palette.text, marginBottom: '4px' }}>
          Profile
        </h2>
        <p style={{ fontSize: '13px', color: palette.textSecondary, marginBottom: '20px' }}>
          {user?.username}
          {user?.organisation && <> &middot; {user.organisation.name}</>}
        </p>

        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column' as const, gap: '14px' }}>
          <div>
            <label style={labelStyle}>Email</label>
            <input style={inputStyle} type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </div>
          <div>
            <label style={labelStyle}>First name</label>
            <input style={inputStyle} value={firstName} onChange={(e) => setFirstName(e.target.value)} />
          </div>
          <div>
            <label style={labelStyle}>Last name</label>
            <input style={inputStyle} value={lastName} onChange={(e) => setLastName(e.target.value)} />
          </div>

          {error && (
            <p style={{ fontSize: '13px', color: palette.danger }}>{error}</p>
          )}

          <div style={{ display: 'flex', gap: '12px', marginTop: '4px' }}>
            <button type="submit" style={{ ...btnStyle, opacity: saving ? 0.6 : 1 }} disabled={saving}>
              {saving ? 'Saving...' : 'Save'}
            </button>
            <button
              type="button"
              onClick={() => navigate('/')}
              style={{ ...btnStyle, background: palette.panelBg, color: palette.text }}
            >
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
