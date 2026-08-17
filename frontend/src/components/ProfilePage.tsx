import { useState, type FormEvent, type CSSProperties } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '@/stores/authStore';
import { useThemeStore } from '@/theme';
import { authApi } from '@/api/authClient';
import { TopNav } from '@/ui/TopNav';
import { useTokens, SANS, MONO } from '@/ui/tokens';

type Tab = 'profile' | 'security' | 'appearance';

export function ProfilePage() {
  const navigate = useNavigate();
  const t = useTokens();
  const theme = useThemeStore((s) => s.theme);
  const setTheme = useThemeStore((s) => s.setTheme);
  const { user, checkAuth } = useAuthStore();
  const [tab, setTab] = useState<Tab>('profile');

  // profile form
  const [email, setEmail] = useState(user?.email ?? '');
  const [firstName, setFirstName] = useState(user?.first_name ?? '');
  const [lastName, setLastName] = useState(user?.last_name ?? '');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ text: string; ok?: boolean } | null>(null);

  // password form
  const [curPw, setCurPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [confirmPw, setConfirmPw] = useState('');
  const [pwSaving, setPwSaving] = useState(false);
  const [pwMsg, setPwMsg] = useState<{ text: string; ok?: boolean } | null>(null);

  const name = [user?.first_name, user?.last_name].filter(Boolean).join(' ') || user?.username || '';
  const initials = ((user?.first_name?.[0] ?? '') + (user?.last_name?.[0] ?? '') || user?.username?.slice(0, 2) || '?').toUpperCase();
  const role = user?.is_superuser ? 'ADMIN' : user?.is_staff ? 'STAFF' : 'USER';
  const fmtDate = (iso?: string | null) => (iso ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric' }) : '—');

  const saveProfile = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true); setMsg(null);
    try {
      await authApi.updateMe({ email: email.trim(), first_name: firstName.trim(), last_name: lastName.trim() });
      await checkAuth();
      setMsg({ text: 'Profile saved', ok: true });
    } catch (err) {
      setMsg({ text: err instanceof Error ? err.message : 'Failed to save' });
    } finally { setSaving(false); }
  };

  const savePassword = async (e: FormEvent) => {
    e.preventDefault();
    setPwMsg(null);
    if (newPw !== confirmPw) { setPwMsg({ text: 'New passwords do not match' }); return; }
    if (newPw.length < 8) { setPwMsg({ text: 'New password must be at least 8 characters' }); return; }
    setPwSaving(true);
    try {
      await authApi.changePassword({ current_password: curPw, new_password: newPw });
      setCurPw(''); setNewPw(''); setConfirmPw('');
      setPwMsg({ text: 'Password updated', ok: true });
    } catch (err) {
      setPwMsg({ text: err instanceof Error ? err.message : 'Failed to update password' });
    } finally { setPwSaving(false); }
  };

  // ── styles ──
  const label: CSSProperties = { display: 'block', fontFamily: MONO, fontSize: '10.5px', letterSpacing: '1px', color: t.textMute, marginBottom: 7 };
  const input: CSSProperties = { width: '100%', boxSizing: 'border-box', padding: '10px 12px', background: t.appBg, border: `1px solid ${t.border2}`, borderRadius: 8, color: t.text, fontFamily: SANS, fontSize: '14px', outline: 'none' };
  const readonly: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', background: t.surface2, border: `1px solid ${t.border}`, borderRadius: 8, fontSize: '13.5px', color: t.textDim };
  const card: CSSProperties = { background: t.surface, border: `1px solid ${t.border}`, borderRadius: 14, padding: 24 };
  const cardTitle: CSSProperties = { fontSize: '16px', fontWeight: 700, color: t.text };
  const cardSub: CSSProperties = { fontSize: '13px', color: t.textMute, marginTop: 4, marginBottom: 22 };
  const primary: CSSProperties = { padding: '10px 20px', background: t.accent, color: '#fff', border: 'none', borderRadius: 8, fontSize: '13.5px', fontWeight: 600, cursor: 'pointer', boxShadow: `0 6px 16px -8px ${t.accent}` };
  const ghost: CSSProperties = { padding: '10px 20px', background: 'transparent', color: t.textDim, border: `1px solid ${t.border2}`, borderRadius: 8, fontSize: '13.5px', cursor: 'pointer' };
  const railBtn = (active: boolean): CSSProperties => ({
    display: 'flex', alignItems: 'center', gap: 10, padding: '9px 12px', borderRadius: 9, fontSize: '13.5px', fontWeight: 500,
    textAlign: 'left', cursor: 'pointer', background: active ? t.accentSoft : 'none', color: active ? t.accent : t.textDim,
    border: `1px solid ${active ? t.accent : 'transparent'}`,
  });
  const notice = (n: { text: string; ok?: boolean }) => (
    <span style={{ fontSize: '13px', color: n.ok ? t.ok : t.danger, display: 'flex', alignItems: 'center', gap: 6 }}>
      <span style={{ fontWeight: 700 }}>{n.ok ? '✓' : '!'}</span>{n.text}
    </span>
  );

  const themeCard = (which: 'dark' | 'light') => {
    const active = theme === which;
    const bg = which === 'dark' ? '#0e1420' : '#eef1f6';
    const chip = which === 'dark' ? '#4c8dff' : '#2f6fe0';
    const bar = which === 'dark' ? '#243044' : '#dde4ee';
    const block = which === 'dark' ? '#161d2b' : '#ffffff';
    return (
      <button onClick={() => setTheme(which)}
        style={{ textAlign: 'left', padding: 12, background: t.surface2, borderRadius: 12, cursor: 'pointer',
                 border: `1.5px solid ${active ? t.accent : t.border}` }}>
        <div style={{ borderRadius: 9, overflow: 'hidden', border: '1px solid rgba(128,128,128,0.15)' }}>
          <div style={{ height: 64, background: bg, padding: 9, display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <span style={{ width: 12, height: 12, borderRadius: 3, background: chip }} />
              <span style={{ height: 7, width: 52, borderRadius: 3, background: bar }} />
            </div>
            <div style={{ height: 9, width: '80%', borderRadius: 3, background: block }} />
            <div style={{ height: 9, width: '60%', borderRadius: 3, background: block }} />
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 11 }}>
          <span style={{ fontSize: '13.5px', fontWeight: 600, color: t.text }}>{which === 'dark' ? 'Dark' : 'Light'}</span>
          {active && (
            <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 18, height: 18, borderRadius: '50%', background: t.accent, color: '#fff' }}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12l5 5 9-11" /></svg>
            </span>
          )}
        </div>
      </button>
    );
  };

  return (
    <div style={{ height: '100%', overflow: 'auto', background: t.appBg, color: t.text, fontFamily: SANS }}>
      <TopNav />
      <div style={{ maxWidth: 960, margin: '0 auto', padding: '36px 28px 72px' }}>
        {/* Identity header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 18, marginBottom: 32 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 64, height: 64, flexShrink: 0, borderRadius: '50%',
                        background: t.accentSoft, color: t.accent, fontFamily: MONO, fontSize: '22px', fontWeight: 600, border: `1px solid ${t.accent}` }}>{initials}</div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
              <h1 style={{ margin: 0, fontSize: '24px', fontWeight: 700, letterSpacing: '-0.5px', color: t.text }}>{name}</h1>
              <span style={{ fontFamily: MONO, fontSize: '10.5px', fontWeight: 600, letterSpacing: '0.4px', color: t.accent, background: t.accentSoft, border: `1px solid ${t.accent}`, borderRadius: 6, padding: '3px 8px' }}>{role}</span>
            </div>
            <div style={{ fontFamily: MONO, fontSize: '12.5px', color: t.textMute, marginTop: 6 }}>
              @{user?.username}{user?.organisation && ` · ${user.organisation.name}`}
            </div>
          </div>
        </div>

        {/* Rail + content */}
        <div style={{ display: 'grid', gridTemplateColumns: '200px 1fr', gap: 28, alignItems: 'start' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 3, position: 'sticky', top: 74 }}>
            <button onClick={() => setTab('profile')} style={railBtn(tab === 'profile')}>
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="8" r="4" /><path d="M4 21c0-4 4-6 8-6s8 2 8 6" /></svg>
              Profile
            </button>
            <button onClick={() => setTab('security')} style={railBtn(tab === 'security')}>
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z" /></svg>
              Security
            </button>
            <button onClick={() => setTab('appearance')} style={railBtn(tab === 'appearance')}>
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor" stroke="none" /></svg>
              Appearance
            </button>
          </div>

          <div style={{ minWidth: 0 }}>
            {tab === 'profile' && (
              <form onSubmit={saveProfile} style={card}>
                <div style={cardTitle}>Personal information</div>
                <div style={cardSub}>Update your name and contact email.</div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>
                  <div><label style={label}>FIRST NAME</label><input value={firstName} onChange={(e) => setFirstName(e.target.value)} style={input} /></div>
                  <div><label style={label}>LAST NAME</label><input value={lastName} onChange={(e) => setLastName(e.target.value)} style={input} /></div>
                </div>
                <div style={{ marginBottom: 16 }}><label style={label}>EMAIL</label><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required style={input} /></div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 24 }}>
                  <div><label style={label}>USERNAME</label><div style={readonly}>{user?.username}<span style={{ marginLeft: 'auto', fontFamily: MONO, fontSize: '10px', color: t.textMute }}>read only</span></div></div>
                  <div><label style={label}>ORGANISATION</label><div style={readonly}>{user?.organisation?.name ?? '—'}<span style={{ marginLeft: 'auto', fontFamily: MONO, fontSize: '10px', color: t.textMute }}>read only</span></div></div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, paddingTop: 20, borderTop: `1px solid ${t.border}` }}>
                  <button type="submit" disabled={saving} style={{ ...primary, opacity: saving ? 0.7 : 1 }}>{saving ? 'Saving…' : 'Save changes'}</button>
                  <button type="button" onClick={() => navigate('/')} style={ghost}>Cancel</button>
                  {msg && notice(msg)}
                </div>
              </form>
            )}

            {tab === 'security' && (
              <>
                <form onSubmit={savePassword} style={{ ...card, marginBottom: 16 }}>
                  <div style={cardTitle}>Change password</div>
                  <div style={cardSub}>Choose a strong password you don’t use elsewhere.</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 420 }}>
                    <div><label style={label}>CURRENT PASSWORD</label><input type="password" value={curPw} onChange={(e) => setCurPw(e.target.value)} required style={input} /></div>
                    <div><label style={label}>NEW PASSWORD</label><input type="password" value={newPw} onChange={(e) => setNewPw(e.target.value)} required style={input} /></div>
                    <div><label style={label}>CONFIRM NEW PASSWORD</label><input type="password" value={confirmPw} onChange={(e) => setConfirmPw(e.target.value)} required style={input} /></div>
                    <div style={{ fontFamily: MONO, fontSize: '11px', color: t.textMute }}>At least 8 characters.</div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 24, paddingTop: 20, borderTop: `1px solid ${t.border}` }}>
                    <button type="submit" disabled={pwSaving} style={{ ...primary, opacity: pwSaving ? 0.7 : 1 }}>{pwSaving ? 'Updating…' : 'Update password'}</button>
                    {pwMsg && notice(pwMsg)}
                  </div>
                </form>
                <div style={card}>
                  <div style={{ ...cardTitle, marginBottom: 16 }}>Account activity</div>
                  <div style={{ display: 'flex', flexDirection: 'column' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '11px 0', borderBottom: `1px solid ${t.border}` }}>
                      <span style={{ fontSize: '13px', color: t.textDim }}>Last sign-in</span>
                      <span style={{ fontFamily: MONO, fontSize: '12.5px', color: t.text }}>{user?.last_login ? new Date(user.last_login).toLocaleString() : '—'}</span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '11px 0' }}>
                      <span style={{ fontSize: '13px', color: t.textDim }}>Account created</span>
                      <span style={{ fontFamily: MONO, fontSize: '12.5px', color: t.text }}>{fmtDate(user?.date_joined)}</span>
                    </div>
                  </div>
                </div>
              </>
            )}

            {tab === 'appearance' && (
              <div style={card}>
                <div style={cardTitle}>Theme</div>
                <div style={cardSub}>Choose how IntentCAD looks. This applies across the whole workspace.</div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, maxWidth: 520 }}>
                  {themeCard('dark')}
                  {themeCard('light')}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
