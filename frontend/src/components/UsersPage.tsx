import { useState, useEffect, type FormEvent, type CSSProperties } from 'react';
import { authApi } from '@/api/authClient';
import { useAuthStore } from '@/stores/authStore';
import type { UserDetail, OrganisationDetail } from '@/types/auth';
import { TopNav } from '@/ui/TopNav';
import { useTokens, SANS, MONO } from '@/ui/tokens';

type RoleFilter = 'all' | 'admin' | 'staff' | 'user';

export function UsersPage() {
  const t = useTokens();
  const currentUser = useAuthStore((s) => s.user);
  const [users, setUsers] = useState<UserDetail[]>([]);
  const [orgs, setOrgs] = useState<OrganisationDetail[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [copiedLink, setCopiedLink] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState<RoleFilter>('all');

  // Edit state
  const [editingUser, setEditingUser] = useState<UserDetail | null>(null);
  const [editEmail, setEditEmail] = useState('');
  const [editFirstName, setEditFirstName] = useState('');
  const [editLastName, setEditLastName] = useState('');
  const [editOrgId, setEditOrgId] = useState('');
  const [editIsStaff, setEditIsStaff] = useState(false);
  const [editIsSuperuser, setEditIsSuperuser] = useState(false);
  const [editIsActive, setEditIsActive] = useState(true);

  // Create form state
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [orgId, setOrgId] = useState('');
  const [isStaff, setIsStaff] = useState(false);
  const [isSuperuser, setIsSuperuser] = useState(false);

  const isSuperuserUser = currentUser?.is_superuser ?? false;

  useEffect(() => { loadData(); }, []);

  const loadData = async () => {
    try {
      const [userList, orgList] = await Promise.all([
        authApi.listUsers(),
        isSuperuserUser ? authApi.listOrganisations() : Promise.resolve([]),
      ]);
      setUsers(userList);
      setOrgs(orgList);
    } catch (err) {
      console.error('Failed to load users:', err);
    } finally {
      setLoading(false);
    }
  };

  const resetForm = () => {
    setUsername(''); setEmail(''); setFirstName(''); setLastName('');
    setOrgId(''); setIsStaff(false); setIsSuperuser(false); setShowForm(false);
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await authApi.createUser({
        username, email, first_name: firstName, last_name: lastName,
        organisation_id: orgId || undefined, is_staff: isStaff, is_superuser: isSuperuser,
      });
      resetForm();
      loadData();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to create user');
    }
  };

  const startEdit = (user: UserDetail) => {
    setShowForm(false);
    setEditingUser(user);
    setEditEmail(user.email);
    setEditFirstName(user.first_name);
    setEditLastName(user.last_name);
    setEditOrgId(user.organisation?.id ?? '');
    setEditIsStaff(user.is_staff);
    setEditIsSuperuser(user.is_superuser);
    setEditIsActive(user.is_active);
  };

  const handleEditSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!editingUser) return;
    try {
      const data: Record<string, unknown> = {
        email: editEmail, first_name: editFirstName, last_name: editLastName,
        is_active: editIsActive, is_staff: editIsStaff,
      };
      if (isSuperuserUser) { data.is_superuser = editIsSuperuser; data.organisation_id = editOrgId || ''; }
      await authApi.updateUser(editingUser.id, data);
      setEditingUser(null);
      loadData();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to update user');
    }
  };

  const handleUnlock = async (userId: string) => {
    try { await authApi.unlockUser(userId); loadData(); } catch (err) { console.error(err); }
  };

  const handleDelete = async (userId: string) => {
    if (!confirm('Are you sure you want to delete this user?')) return;
    try { await authApi.deleteUser(userId); loadData(); } catch (err) { console.error(err); }
  };

  const handleResetLink = async (userId: string) => {
    try {
      const result = await authApi.generateResetLink(userId);
      await navigator.clipboard.writeText(result.reset_url);
      setCopiedLink(userId);
      setTimeout(() => setCopiedLink(null), 3000);
    } catch { alert('Failed to generate reset link'); }
  };

  const roleOf = (u: UserDetail): RoleFilter => (u.is_superuser ? 'admin' : u.is_staff ? 'staff' : 'user');
  const initialsOf = (u: UserDetail) =>
    ((u.first_name?.[0] ?? '') + (u.last_name?.[0] ?? '') || u.username.slice(0, 2)).toUpperCase();
  const nameOf = (u: UserDetail) => [u.first_name, u.last_name].filter(Boolean).join(' ') || u.username;
  const lastLoginOf = (u: UserDetail) => (u.last_login ? new Date(u.last_login).toLocaleDateString() : 'never');

  const lower = search.toLowerCase();
  const visible = users.filter((u) =>
    (roleFilter === 'all' || roleOf(u) === roleFilter) &&
    (!lower || u.username.toLowerCase().includes(lower) || u.email.toLowerCase().includes(lower) || nameOf(u).toLowerCase().includes(lower)));

  // ── styles ──
  const COLS = 'minmax(230px,2.3fr) minmax(150px,1.4fr) 100px 112px 104px 116px';
  const formInput: CSSProperties = {
    padding: '10px 12px', background: t.appBg, border: `1px solid ${t.border2}`, borderRadius: 8,
    color: t.text, fontFamily: SANS, fontSize: '13.5px', outline: 'none', width: '100%', boxSizing: 'border-box',
  };
  const primaryBtn: CSSProperties = { padding: '9px 18px', background: t.accent, color: '#fff', border: 'none', borderRadius: 8, fontSize: '13px', fontWeight: 600, cursor: 'pointer' };
  const ghostBtn: CSSProperties = { padding: '9px 18px', background: 'transparent', color: t.textDim, border: `1px solid ${t.border2}`, borderRadius: 8, fontSize: '13px', cursor: 'pointer' };
  const seg = (active: boolean): CSSProperties => ({
    padding: '7px 14px', borderRadius: 8, fontSize: '13px', fontWeight: 600, cursor: 'pointer',
    background: active ? t.accentSoft : t.surface, color: active ? t.accent : t.textDim, border: `1px solid ${active ? t.accent : t.border}`,
  });
  const pill = (color: string, bg: string): CSSProperties => ({
    fontFamily: MONO, fontSize: '10px', fontWeight: 600, letterSpacing: '0.5px', color, background: bg,
    border: `1px solid ${color}`, borderRadius: 5, padding: '2px 7px',
  });
  const roleBadge = (u: UserDetail) => u.is_superuser
    ? pill(t.accent, t.accentSoft) : u.is_staff ? pill(t.violet, t.violetSoft) : pill(t.textDim, t.surface3);
  const iconBtn: CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'center', width: 28, height: 28, background: 'none', border: 'none', borderRadius: 6, color: t.textMute, cursor: 'pointer' };
  const check: CSSProperties = { display: 'flex', alignItems: 'center', gap: 7, fontSize: '13px', color: t.textDim, cursor: 'pointer' };

  return (
    <div style={{ height: '100%', overflow: 'auto', background: t.appBg, color: t.text, fontFamily: SANS }}>
      <TopNav />
      <div style={{ maxWidth: 1180, margin: '0 auto', padding: '36px 28px 72px' }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 20, marginBottom: 26 }}>
          <div>
            <div style={{ fontFamily: MONO, fontSize: '11px', letterSpacing: '2px', color: t.accent, marginBottom: 8 }}>ADMINISTRATION</div>
            <h1 style={{ margin: 0, fontSize: '26px', fontWeight: 700, letterSpacing: '-0.5px', color: t.text }}>User management</h1>
            <div style={{ fontFamily: MONO, fontSize: '12.5px', color: t.textDim, marginTop: 7 }}>
              {users.length} users{isSuperuserUser ? ` · ${orgs.length} organisations` : ''}
            </div>
          </div>
          <button onClick={() => { setEditingUser(null); setShowForm((v) => !v); }}
            style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '10px 16px', background: t.accent, color: '#fff',
                     border: 'none', borderRadius: 9, fontSize: '13.5px', fontWeight: 600, cursor: 'pointer', boxShadow: `0 6px 16px -8px ${t.accent}` }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
            New user
          </button>
        </div>

        {/* Create form */}
        {showForm && (
          <form onSubmit={handleSubmit} style={{ background: t.surface, border: `1px solid ${t.border}`, borderRadius: 14, padding: '20px 20px 22px', marginBottom: 22 }}>
            <div style={{ fontSize: '14px', fontWeight: 600, color: t.text, marginBottom: 4 }}>Create user</div>
            <div style={{ fontSize: '12.5px', color: t.textMute, marginBottom: 16 }}>After creating, use the key action to generate a password setup link.</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12, marginBottom: 14 }}>
              <input placeholder="Username *" value={username} onChange={(e) => setUsername(e.target.value)} required style={formInput} />
              <input placeholder="Email *" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required style={formInput} />
              {isSuperuserUser && (
                <select value={orgId} onChange={(e) => setOrgId(e.target.value)} style={formInput}>
                  <option value="">No organisation</option>
                  {orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                </select>
              )}
              <input placeholder="First name" value={firstName} onChange={(e) => setFirstName(e.target.value)} style={formInput} />
              <input placeholder="Last name" value={lastName} onChange={(e) => setLastName(e.target.value)} style={formInput} />
              <div style={{ display: 'flex', alignItems: 'center', gap: 18, paddingLeft: 2 }}>
                <label style={check}><input type="checkbox" checked={isStaff} onChange={(e) => setIsStaff(e.target.checked)} style={{ accentColor: t.accent }} /> Staff</label>
                {isSuperuserUser && <label style={check}><input type="checkbox" checked={isSuperuser} onChange={(e) => setIsSuperuser(e.target.checked)} style={{ accentColor: t.accent }} /> Admin</label>}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 9 }}>
              <button type="submit" style={primaryBtn}>Create</button>
              <button type="button" onClick={resetForm} style={ghostBtn}>Cancel</button>
            </div>
          </form>
        )}

        {/* Edit form */}
        {editingUser && (
          <form onSubmit={handleEditSubmit} style={{ background: t.surface, border: `1px solid ${t.border}`, borderRadius: 14, padding: '20px 20px 22px', marginBottom: 22 }}>
            <div style={{ fontSize: '14px', fontWeight: 600, color: t.text, marginBottom: 16 }}>Edit {editingUser.username}</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12, marginBottom: 14 }}>
              <input placeholder="Email" type="email" value={editEmail} onChange={(e) => setEditEmail(e.target.value)} required style={formInput} />
              <input placeholder="First name" value={editFirstName} onChange={(e) => setEditFirstName(e.target.value)} style={formInput} />
              <input placeholder="Last name" value={editLastName} onChange={(e) => setEditLastName(e.target.value)} style={formInput} />
              {isSuperuserUser && (
                <select value={editOrgId} onChange={(e) => setEditOrgId(e.target.value)} style={formInput}>
                  <option value="">No organisation</option>
                  {orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                </select>
              )}
              <div style={{ display: 'flex', alignItems: 'center', gap: 18, paddingLeft: 2 }}>
                <label style={check}><input type="checkbox" checked={editIsActive} onChange={(e) => setEditIsActive(e.target.checked)} style={{ accentColor: t.accent }} /> Active</label>
                <label style={check}><input type="checkbox" checked={editIsStaff} onChange={(e) => setEditIsStaff(e.target.checked)} style={{ accentColor: t.accent }} /> Staff</label>
                {isSuperuserUser && <label style={check}><input type="checkbox" checked={editIsSuperuser} onChange={(e) => setEditIsSuperuser(e.target.checked)} style={{ accentColor: t.accent }} /> Admin</label>}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 9 }}>
              <button type="submit" style={primaryBtn}>Save</button>
              <button type="button" onClick={() => setEditingUser(null)} style={ghostBtn}>Cancel</button>
            </div>
          </form>
        )}

        {/* Toolbar */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, marginBottom: 18 }}>
          <div style={{ position: 'relative', flex: 1, maxWidth: 340 }}>
            <span style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: t.textMute, display: 'flex' }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="7" /><path d="M21 21l-4-4" /></svg>
            </span>
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search users..."
              style={{ width: '100%', padding: '9px 12px 9px 36px', background: t.surface, border: `1px solid ${t.border}`, borderRadius: 9, color: t.text, fontFamily: SANS, fontSize: '13px', outline: 'none' }} />
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            {(['all', 'admin', 'staff', 'user'] as const).map((r) => (
              <button key={r} onClick={() => setRoleFilter(r)} style={seg(roleFilter === r)}>
                {r === 'all' ? 'All' : r === 'admin' ? 'Admins' : r === 'staff' ? 'Staff' : 'Users'}
              </button>
            ))}
          </div>
        </div>

        {/* Table */}
        <div style={{ background: t.surface, border: `1px solid ${t.border}`, borderRadius: 14, overflow: 'hidden' }}>
          <div style={{ display: 'grid', gridTemplateColumns: COLS, gap: 14, padding: '12px 20px', borderBottom: `1px solid ${t.border}`, fontFamily: MONO, fontSize: '10.5px', letterSpacing: '1px', color: t.textMute }}>
            <div>USER</div><div>ORGANISATION</div><div>ROLE</div><div>STATUS</div><div>LAST LOGIN</div><div style={{ textAlign: 'right' }}>ACTIONS</div>
          </div>
          {loading ? (
            <div style={{ padding: 44, textAlign: 'center', fontFamily: MONO, fontSize: '13px', color: t.textMute }}>Loading…</div>
          ) : visible.length === 0 ? (
            <div style={{ padding: 44, textAlign: 'center', fontFamily: MONO, fontSize: '13px', color: t.textMute }}>No users match “{search}”</div>
          ) : visible.map((u) => {
            const locked = !!u.locked_until;
            const self = currentUser?.id === u.id;
            return (
              <div key={u.id} style={{ display: 'grid', gridTemplateColumns: COLS, gap: 14, alignItems: 'center', padding: '13px 20px', borderBottom: `1px solid ${t.border}` }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 34, height: 34, flexShrink: 0, borderRadius: '50%', background: t.surface3, color: t.textDim, fontFamily: MONO, fontSize: '11px', fontWeight: 600 }}>{initialsOf(u)}</div>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: '14px', fontWeight: 600, color: t.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {nameOf(u)} <span style={{ fontWeight: 400, color: t.textMute, fontFamily: MONO, fontSize: '11.5px' }}>@{u.username}</span>
                    </div>
                    <div style={{ fontFamily: MONO, fontSize: '11px', color: t.textMute, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{u.email}</div>
                  </div>
                </div>
                <div style={{ fontSize: '13px', color: t.textDim, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{u.organisation?.name ?? '—'}</div>
                <div><span style={roleBadge(u)}>{u.is_superuser ? 'ADMIN' : u.is_staff ? 'STAFF' : 'USER'}</span></div>
                <div>
                  {locked ? <span style={pill(t.danger, t.partSoft)}>LOCKED</span>
                    : u.is_active ? <span style={pill(t.ok, t.okSoft)}>ACTIVE</span>
                      : <span style={pill(t.textMute, t.surface3)}>INACTIVE</span>}
                </div>
                <div style={{ fontFamily: MONO, fontSize: '11.5px', color: t.textMute }}>{lastLoginOf(u)}</div>
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 2 }}>
                  <button title="Edit" style={iconBtn} onClick={() => startEdit(u)}
                    onMouseEnter={(e) => { e.currentTarget.style.color = t.accent; e.currentTarget.style.background = t.accentSoft; }}
                    onMouseLeave={(e) => { e.currentTarget.style.color = t.textMute; e.currentTarget.style.background = 'none'; }}>
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" /></svg>
                  </button>
                  {locked && (
                    <button title="Unlock" style={iconBtn} onClick={() => handleUnlock(u.id)}
                      onMouseEnter={(e) => { e.currentTarget.style.color = t.ok; e.currentTarget.style.background = t.okSoft; }}
                      onMouseLeave={(e) => { e.currentTarget.style.color = t.textMute; e.currentTarget.style.background = 'none'; }}>
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="11" width="16" height="9" rx="2" /><path d="M8 11V7a4 4 0 0 1 7.5-1.9" /></svg>
                    </button>
                  )}
                  <button title={copiedLink === u.id ? 'Copied!' : 'Password reset link'} style={iconBtn} onClick={() => handleResetLink(u.id)}
                    onMouseEnter={(e) => { e.currentTarget.style.color = t.violet; e.currentTarget.style.background = t.violetSoft; }}
                    onMouseLeave={(e) => { e.currentTarget.style.color = t.textMute; e.currentTarget.style.background = 'none'; }}>
                    {copiedLink === u.id
                      ? <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke={t.ok} strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5" /></svg>
                      : <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="7.5" cy="15.5" r="3.5" /><path d="M10 13 20 3m-3 0 3 3m-6 0 3 3" /></svg>}
                  </button>
                  {!self && (
                    <button title="Delete" style={iconBtn} onClick={() => handleDelete(u.id)}
                      onMouseEnter={(e) => { e.currentTarget.style.color = t.danger; e.currentTarget.style.background = t.partSoft; }}
                      onMouseLeave={(e) => { e.currentTarget.style.color = t.textMute; e.currentTarget.style.background = 'none'; }}>
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18" /><path d="M8 6V4h8v2" /><path d="M6 6l1 14h10l1-14" /></svg>
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
