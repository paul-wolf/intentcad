import { useState, type FormEvent } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { authApi } from '@/api/authClient';
import { useThemeStore } from '@/theme';

export function PasswordResetPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const palette = useThemeStore((s) => s.palette);
  const token = params.get('token') ?? '';
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (password !== confirm) {
      setError('Passwords do not match');
      return;
    }
    if (password.length < 8) {
      setError('Password must be at least 8 characters');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await authApi.resetPassword(token, password);
      setSuccess(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Reset failed');
    } finally {
      setSubmitting(false);
    }
  };

  if (!token) {
    return (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100%',
          color: palette.danger,
          fontSize: '14px',
        }}
      >
        Invalid reset link — no token provided.
      </div>
    );
  }

  if (success) {
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
        <p style={{ fontSize: '16px', color: palette.text }}>
          Password has been reset successfully.
        </p>
        <button
          onClick={() => navigate('/login')}
          style={{
            padding: '10px 24px',
            background: palette.primaryBtn,
            color: '#fff',
            border: 'none',
            borderRadius: '6px',
            fontSize: '15px',
            cursor: 'pointer',
          }}
        >
          Go to Login
        </button>
      </div>
    );
  }

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
      <h1 style={{ fontSize: '24px', fontWeight: 700, color: palette.text }}>
        Set New Password
      </h1>

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
          type="password"
          placeholder="New password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
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
          placeholder="Confirm password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
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
          {submitting ? 'Resetting...' : 'Reset Password'}
        </button>
      </form>
    </div>
  );
}
