import { useState, useEffect, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { authApi } from '@/api/authClient';
import { useAuthStore } from '@/stores/authStore';
import { useThemeStore } from '@/theme';
import type { UserDetail, OrganisationDetail } from '@/types/auth';

export function UsersPage() {
  const navigate = useNavigate();
  const palette = useThemeStore((s) => s.palette);
  const currentUser = useAuthStore((s) => s.user);
  const [users, setUsers] = useState<UserDetail[]>([]);
  const [orgs, setOrgs] = useState<OrganisationDetail[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [copiedLink, setCopiedLink] = useState<string | null>(null);

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

  useEffect(() => {
    loadData();
  }, []);

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
    setUsername('');
    setEmail('');
    setFirstName('');
    setLastName('');
    setOrgId('');
    setIsStaff(false);
    setIsSuperuser(false);
    setShowForm(false);
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await authApi.createUser({
        username,
        email,
        first_name: firstName,
        last_name: lastName,
        organisation_id: orgId || undefined,
        is_staff: isStaff,
        is_superuser: isSuperuser,
      });
      resetForm();
      loadData();
    } catch (err) {
      console.error('Failed to create user:', err);
      alert(err instanceof Error ? err.message : 'Failed to create user');
    }
  };

  const startEdit = (user: UserDetail) => {
    setEditingUser(user);
    setEditEmail(user.email);
    setEditFirstName(user.first_name);
    setEditLastName(user.last_name);
    setEditOrgId(user.organisation?.id ?? '');
    setEditIsStaff(user.is_staff);
    setEditIsSuperuser(user.is_superuser);
    setEditIsActive(user.is_active);
  };

  const cancelEdit = () => {
    setEditingUser(null);
  };

  const handleEditSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!editingUser) return;
    try {
      const data: Record<string, unknown> = {
        email: editEmail,
        first_name: editFirstName,
        last_name: editLastName,
        is_active: editIsActive,
        is_staff: editIsStaff,
      };
      if (isSuperuserUser) {
        data.is_superuser = editIsSuperuser;
        data.organisation_id = editOrgId || '';
      }
      await authApi.updateUser(editingUser.id, data);
      setEditingUser(null);
      loadData();
    } catch (err) {
      console.error('Failed to update user:', err);
      alert(err instanceof Error ? err.message : 'Failed to update user');
    }
  };

  const handleToggleActive = async (user: UserDetail) => {
    try {
      await authApi.updateUser(user.id, { is_active: !user.is_active });
      loadData();
    } catch (err) {
      console.error('Failed to update user:', err);
    }
  };

  const handleUnlock = async (userId: string) => {
    try {
      await authApi.unlockUser(userId);
      loadData();
    } catch (err) {
      console.error('Failed to unlock user:', err);
    }
  };

  const handleDelete = async (userId: string) => {
    if (!confirm('Are you sure you want to delete this user?')) return;
    try {
      await authApi.deleteUser(userId);
      loadData();
    } catch (err) {
      console.error('Failed to delete user:', err);
    }
  };

  const handleResetLink = async (userId: string) => {
    try {
      const result = await authApi.generateResetLink(userId);
      await navigator.clipboard.writeText(result.reset_url);
      setCopiedLink(userId);
      setTimeout(() => setCopiedLink(null), 3000);
    } catch (err) {
      console.error('Failed to generate reset link:', err);
      alert('Failed to generate reset link');
    }
  };

  const inputStyle = {
    padding: '8px 10px',
    background: palette.panelBg,
    border: `1px solid ${palette.textSecondary}`,
    borderRadius: '4px',
    color: palette.text,
    fontSize: '13px',
    outline: 'none',
    width: '100%',
    boxSizing: 'border-box' as const,
  };

  const btnStyle = {
    background: 'none',
    border: 'none',
    fontSize: '12px',
    cursor: 'pointer',
    padding: '2px 6px',
  };

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        padding: '24px',
        maxWidth: '1000px',
        margin: '0 auto',
        gap: '16px',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1 style={{ fontSize: '22px', fontWeight: 700, color: palette.text, margin: 0 }}>
          User Management
        </h1>
        <div style={{ display: 'flex', gap: '8px' }}>
          <button
            onClick={() => setShowForm(true)}
            style={{
              padding: '8px 16px',
              background: palette.primaryBtn,
              color: '#fff',
              border: 'none',
              borderRadius: '4px',
              fontSize: '13px',
              cursor: 'pointer',
            }}
          >
            + New User
          </button>
          <button
            onClick={() => navigate('/')}
            style={{
              padding: '8px 16px',
              background: palette.panelBg,
              color: palette.text,
              border: `1px solid ${palette.textSecondary}`,
              borderRadius: '4px',
              fontSize: '13px',
              cursor: 'pointer',
            }}
          >
            Back
          </button>
        </div>
      </div>

      {showForm && (
        <div
          style={{
            background: palette.panelBg,
            borderRadius: '6px',
            padding: '16px',
          }}
        >
          <p style={{ fontSize: '13px', color: palette.textSecondary, margin: '0 0 12px' }}>
            After creating, use "Reset Link" to generate a password setup link.
          </p>
          <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
              <input type="text" placeholder="Username *" value={username} onChange={(e) => setUsername(e.target.value)} required style={inputStyle} />
              <input type="email" placeholder="Email *" value={email} onChange={(e) => setEmail(e.target.value)} required style={inputStyle} />
              <input type="text" placeholder="First Name" value={firstName} onChange={(e) => setFirstName(e.target.value)} style={inputStyle} />
              <input type="text" placeholder="Last Name" value={lastName} onChange={(e) => setLastName(e.target.value)} style={inputStyle} />
              {isSuperuserUser && (
                <select value={orgId} onChange={(e) => setOrgId(e.target.value)} style={inputStyle}>
                  <option value="">No organisation</option>
                  {orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                </select>
              )}
              <div style={{ display: 'flex', gap: '16px', alignItems: 'center' }}>
                <label style={{ display: 'flex', gap: '4px', alignItems: 'center', fontSize: '13px', color: palette.text }}>
                  <input type="checkbox" checked={isStaff} onChange={(e) => setIsStaff(e.target.checked)} /> Staff
                </label>
                {isSuperuserUser && (
                  <label style={{ display: 'flex', gap: '4px', alignItems: 'center', fontSize: '13px', color: palette.text }}>
                    <input type="checkbox" checked={isSuperuser} onChange={(e) => setIsSuperuser(e.target.checked)} /> Admin
                  </label>
                )}
              </div>
            </div>
            <div style={{ display: 'flex', gap: '8px' }}>
              <button type="submit" style={{ padding: '8px 16px', background: palette.primaryBtn, color: '#fff', border: 'none', borderRadius: '4px', fontSize: '13px', cursor: 'pointer' }}>
                Create
              </button>
              <button type="button" onClick={resetForm} style={{ padding: '8px 16px', background: 'transparent', color: palette.textSecondary, border: `1px solid ${palette.textSecondary}`, borderRadius: '4px', fontSize: '13px', cursor: 'pointer' }}>
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}

      {editingUser && (
        <div
          style={{
            background: palette.panelBg,
            borderRadius: '6px',
            padding: '16px',
          }}
        >
          <p style={{ fontSize: '14px', fontWeight: 600, color: palette.text, margin: '0 0 12px' }}>
            Edit: {editingUser.username}
          </p>
          <form onSubmit={handleEditSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
              <input type="email" placeholder="Email" value={editEmail} onChange={(e) => setEditEmail(e.target.value)} required style={inputStyle} />
              <input type="text" placeholder="First Name" value={editFirstName} onChange={(e) => setEditFirstName(e.target.value)} style={inputStyle} />
              <input type="text" placeholder="Last Name" value={editLastName} onChange={(e) => setEditLastName(e.target.value)} style={inputStyle} />
              {isSuperuserUser && (
                <select value={editOrgId} onChange={(e) => setEditOrgId(e.target.value)} style={inputStyle}>
                  <option value="">No organisation</option>
                  {orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                </select>
              )}
              <div style={{ display: 'flex', gap: '16px', alignItems: 'center' }}>
                <label style={{ display: 'flex', gap: '4px', alignItems: 'center', fontSize: '13px', color: palette.text }}>
                  <input type="checkbox" checked={editIsActive} onChange={(e) => setEditIsActive(e.target.checked)} /> Active
                </label>
                <label style={{ display: 'flex', gap: '4px', alignItems: 'center', fontSize: '13px', color: palette.text }}>
                  <input type="checkbox" checked={editIsStaff} onChange={(e) => setEditIsStaff(e.target.checked)} /> Staff
                </label>
                {isSuperuserUser && (
                  <label style={{ display: 'flex', gap: '4px', alignItems: 'center', fontSize: '13px', color: palette.text }}>
                    <input type="checkbox" checked={editIsSuperuser} onChange={(e) => setEditIsSuperuser(e.target.checked)} /> Admin
                  </label>
                )}
              </div>
            </div>
            <div style={{ display: 'flex', gap: '8px' }}>
              <button type="submit" style={{ padding: '8px 16px', background: palette.primaryBtn, color: '#fff', border: 'none', borderRadius: '4px', fontSize: '13px', cursor: 'pointer' }}>
                Save
              </button>
              <button type="button" onClick={cancelEdit} style={{ padding: '8px 16px', background: 'transparent', color: palette.textSecondary, border: `1px solid ${palette.textSecondary}`, borderRadius: '4px', fontSize: '13px', cursor: 'pointer' }}>
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}

      <div style={{ background: palette.panelBg, borderRadius: '6px', overflow: 'auto' }}>
        {loading ? (
          <div style={{ padding: '24px', textAlign: 'center', color: palette.textSecondary, fontSize: '14px' }}>
            Loading...
          </div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
            <thead>
              <tr style={{ borderBottom: `1px solid ${palette.textSecondary}` }}>
                {['Username', 'Email', 'Name', 'Org', 'Status', 'Role', 'Last Login', 'Actions'].map((h) => (
                  <th key={h} style={{ padding: '10px 12px', textAlign: 'left', color: palette.textSecondary, fontWeight: 500 }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {users.map((user) => (
                <tr key={user.id} style={{ borderBottom: `1px solid ${palette.panelBg}`, opacity: user.is_active ? 1 : 0.5 }}>
                  <td style={{ padding: '8px 12px', color: palette.text, fontWeight: 500 }}>{user.username}</td>
                  <td style={{ padding: '8px 12px', color: palette.text }}>{user.email}</td>
                  <td style={{ padding: '8px 12px', color: palette.text }}>{user.first_name} {user.last_name}</td>
                  <td style={{ padding: '8px 12px', color: palette.textSecondary }}>{user.organisation?.name ?? '—'}</td>
                  <td style={{ padding: '8px 12px' }}>
                    {user.locked_until
                      ? <span style={{ color: palette.danger, fontSize: '11px' }}>Locked</span>
                      : user.is_active
                        ? <span style={{ color: '#4caf50', fontSize: '11px' }}>Active</span>
                        : <span style={{ color: palette.textSecondary, fontSize: '11px' }}>Inactive</span>}
                  </td>
                  <td style={{ padding: '8px 12px', color: palette.text }}>
                    {user.is_superuser ? 'Admin' : user.is_staff ? 'Staff' : 'User'}
                  </td>
                  <td style={{ padding: '8px 12px', color: palette.textSecondary }}>
                    {user.last_login ? new Date(user.last_login).toLocaleDateString() : 'Never'}
                  </td>
                  <td style={{ padding: '8px 12px' }}>
                    {currentUser && user.id !== currentUser.id && (
                      <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
                        <button onClick={() => startEdit(user)} style={{ ...btnStyle, color: palette.primaryBtn }}>
                          Edit
                        </button>
                        <button onClick={() => handleToggleActive(user)} style={{ ...btnStyle, color: '#2196f3' }}>
                          {user.is_active ? 'Disable' : 'Enable'}
                        </button>
                        {user.locked_until && (
                          <button onClick={() => handleUnlock(user.id)} style={{ ...btnStyle, color: '#4caf50' }}>
                            Unlock
                          </button>
                        )}
                        <button onClick={() => handleResetLink(user.id)} style={{ ...btnStyle, color: '#9c27b0' }}>
                          {copiedLink === user.id ? 'Copied!' : 'Reset Link'}
                        </button>
                        <button onClick={() => handleDelete(user.id)} style={{ ...btnStyle, color: palette.danger }}>
                          Delete
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
