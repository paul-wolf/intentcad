import { useState, type FormEvent, type CSSProperties } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '@/stores/authStore';
import { useTokens, SANS, MONO } from '@/ui/tokens';
import { Logo, ThemeToggle } from '@/ui/chrome';

export function LoginPage() {
  const navigate = useNavigate();
  const t = useTokens();
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

  const label: CSSProperties = {
    fontFamily: MONO, fontSize: '10.5px', letterSpacing: '1px', color: t.textMute,
  };
  const input: CSSProperties = {
    width: '100%', padding: '11px 13px', background: t.appBg, border: `1px solid ${t.border2}`,
    borderRadius: 9, color: t.text, fontFamily: SANS, fontSize: '14px', outline: 'none',
  };

  return (
    <div style={{ position: 'relative', minHeight: '100vh', height: '100%', overflow: 'auto',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24,
                  fontFamily: SANS, color: t.text, backgroundColor: t.appBg,
                  backgroundImage: `linear-gradient(${t.grid} 1px,transparent 1px),linear-gradient(90deg,${t.grid} 1px,transparent 1px)`,
                  backgroundSize: '32px 32px' }}>
      <div style={{ position: 'absolute', top: 22, right: 24 }}><ThemeToggle size={36} /></div>

      <div style={{ width: '100%', maxWidth: 396 }}>
        {/* Brand */}
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14, marginBottom: 26 }}>
          <Logo size={46} />
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontWeight: 700, fontSize: '22px', letterSpacing: '-0.5px', color: t.text }}>
              Intent<span style={{ color: t.accent }}>CAD</span>
            </div>
            <div style={{ fontFamily: MONO, fontSize: '11px', letterSpacing: '1px', color: t.textMute, marginTop: 5 }}>
              PARAMETRIC MODELING WORKSPACE
            </div>
          </div>
        </div>

        {/* Card */}
        <form onSubmit={handleSubmit}
          style={{ background: t.surface, border: `1px solid ${t.border}`, borderRadius: 16,
                   padding: '28px 26px', boxShadow: t.shadow }}>
          <h1 style={{ margin: '0 0 4px', fontSize: '18px', fontWeight: 700, letterSpacing: '-0.3px', color: t.text }}>Sign in</h1>
          <p style={{ margin: '0 0 22px', fontSize: '13px', color: t.textDim }}>Access your projects and documents.</p>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
              <label style={label}>USERNAME OR EMAIL</label>
              <input type="text" value={username} onChange={(e) => setUsername(e.target.value)}
                placeholder="you@company.com" required autoFocus style={input}
                onFocus={(e) => (e.currentTarget.style.borderColor = t.accent)}
                onBlur={(e) => (e.currentTarget.style.borderColor = t.border2)} />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <label style={label}>PASSWORD</label>
                <button type="button" onClick={() => navigate('/reset-password')}
                  style={{ background: 'none', border: 'none', padding: 0, fontSize: '11.5px', color: t.accent, cursor: 'pointer' }}>
                  Forgot?
                </button>
              </div>
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••" required style={input}
                onFocus={(e) => (e.currentTarget.style.borderColor = t.accent)}
                onBlur={(e) => (e.currentTarget.style.borderColor = t.border2)} />
            </div>

            {error && <p style={{ margin: 0, fontSize: '13px', color: t.danger }}>{error}</p>}

            <button type="submit" disabled={submitting}
              style={{ marginTop: 4, width: '100%', padding: 12, background: t.accent, color: '#fff',
                       border: 'none', borderRadius: 9, fontFamily: SANS, fontSize: '14px', fontWeight: 600,
                       cursor: submitting ? 'default' : 'pointer', opacity: submitting ? 0.7 : 1,
                       boxShadow: `0 8px 18px -8px ${t.accent}` }}>
              {submitting ? 'Signing in…' : 'Sign in'}
            </button>
          </div>
        </form>

        <div style={{ textAlign: 'center', marginTop: 20, fontFamily: MONO, fontSize: '11px', color: t.textMute }}>
          v0.1 &middot; Yew Robotics
        </div>
      </div>
    </div>
  );
}
