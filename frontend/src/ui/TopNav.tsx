import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '@/stores/authStore';
import { useTokens, SANS, MONO } from './tokens';
import { Logo, ThemeToggle } from './chrome';

/** The sticky top navigation bar (brand, theme toggle, user, sign out). */
export function TopNav() {
  const navigate = useNavigate();
  const t = useTokens();
  const { user, logout } = useAuthStore();

  const name = [user?.first_name, user?.last_name].filter(Boolean).join(' ') || user?.username || '';
  const initials = (
    (user?.first_name?.[0] ?? '') + (user?.last_name?.[0] ?? '')
    || user?.username?.slice(0, 2)
    || '?'
  ).toUpperCase();

  const signOut = async () => { await logout(); navigate('/login'); };

  return (
    <div style={{ position: 'sticky', top: 0, zIndex: 30, display: 'flex', alignItems: 'center', gap: 16,
                  height: 54, padding: '0 24px', background: t.surface, borderBottom: `1px solid ${t.border}`,
                  fontFamily: SANS, flexShrink: 0 }}>
      <button onClick={() => navigate('/')}
        style={{ display: 'flex', alignItems: 'center', gap: 9, background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
        <Logo size={24} />
        <span style={{ fontWeight: 700, fontSize: '16px', letterSpacing: '-0.4px', color: t.text }}>
          Intent<span style={{ color: t.accent }}>CAD</span>
        </span>
      </button>
      <span style={{ fontFamily: MONO, fontSize: '10.5px', color: t.textMute, border: `1px solid ${t.border}`,
                     borderRadius: 5, padding: '2px 6px', letterSpacing: '0.3px' }}>v0.1</span>

      <div style={{ flex: 1 }} />

      {(user?.is_staff || user?.is_superuser) && (
        <>
          <button onClick={() => navigate('/manage/users')}
            style={{ background: 'none', border: 'none', cursor: 'pointer', fontFamily: MONO, fontSize: '11.5px', color: t.textDim }}>Users</button>
          {user?.is_superuser && (
            <>
              <button onClick={() => navigate('/manage/organisations')}
                style={{ background: 'none', border: 'none', cursor: 'pointer', fontFamily: MONO, fontSize: '11.5px', color: t.textDim }}>Orgs</button>
              <button onClick={() => navigate('/manage/events')}
                style={{ background: 'none', border: 'none', cursor: 'pointer', fontFamily: MONO, fontSize: '11.5px', color: t.textDim }}>Events</button>
            </>
          )}
        </>
      )}

      <ThemeToggle />

      <div style={{ width: 1, height: 22, background: t.border }} />

      <button onClick={() => navigate('/profile')} title="Profile"
        style={{ display: 'flex', alignItems: 'center', gap: 10, background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 32, height: 32, borderRadius: '50%',
                      background: t.accentSoft, color: t.accent, fontFamily: MONO, fontSize: '12px', fontWeight: 600,
                      border: `1px solid ${t.accent}` }}>{initials}</div>
        <div style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.25, textAlign: 'left' }}>
          <span style={{ fontSize: '13px', fontWeight: 600, color: t.text }}>{name}</span>
          {user?.organisation && (
            <span style={{ fontFamily: MONO, fontSize: '10.5px', color: t.textMute }}>{user.organisation.name}</span>
          )}
        </div>
      </button>

      <button onClick={signOut} title="Sign out"
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 34, height: 34,
                 background: 'none', border: '1px solid transparent', borderRadius: 8, color: t.textMute, cursor: 'pointer' }}
        onMouseEnter={(e) => { e.currentTarget.style.color = t.danger; e.currentTarget.style.borderColor = t.border; }}
        onMouseLeave={(e) => { e.currentTarget.style.color = t.textMute; e.currentTarget.style.borderColor = 'transparent'; }}>
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
          <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
          <path d="M16 17l5-5-5-5M21 12H9" />
        </svg>
      </button>
    </div>
  );
}
