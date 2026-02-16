import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '@/stores/authStore';
import { useThemeStore } from '@/theme';

export function LoginPage() {
  const navigate = useNavigate();
  const palette = useThemeStore((s) => s.palette);
  const { login, error } = useAuthStore();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    const ok = await login(username, password);
    setSubmitting(false);
    if (ok) navigate('/');
  };

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100%',
        gap: '16px',
      }}
    >
      <h1 style={{ fontSize: '28px', fontWeight: 700, color: palette.text }}>
        IntentCAD
      </h1>
      <p style={{ fontSize: '14px', color: palette.textSecondary }}>
        Sign in to continue
      </p>

      <form
        onSubmit={handleSubmit}
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: '12px',
          width: '280px',
        }}
      >
        <input
          type="text"
          placeholder="Username or email"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          required
          autoFocus
          style={{
            padding: '10px 12px',
            background: palette.panelBg,
            border: `1px solid ${palette.textSecondary}`,
            borderRadius: '4px',
            color: palette.text,
            fontSize: '14px',
            outline: 'none',
          }}
        />
        <input
          type="password"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          style={{
            padding: '10px 12px',
            background: palette.panelBg,
            border: `1px solid ${palette.textSecondary}`,
            borderRadius: '4px',
            color: palette.text,
            fontSize: '14px',
            outline: 'none',
          }}
        />

        {error && (
          <p style={{ fontSize: '13px', color: palette.danger, margin: 0 }}>
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={submitting}
          style={{
            padding: '10px 24px',
            background: submitting ? palette.textSecondary : palette.primaryBtn,
            color: '#fff',
            border: 'none',
            borderRadius: '6px',
            fontSize: '15px',
            cursor: submitting ? 'default' : 'pointer',
          }}
        >
          {submitting ? 'Signing in...' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
