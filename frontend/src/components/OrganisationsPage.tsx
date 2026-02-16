import { useState, useEffect, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { authApi } from '@/api/authClient';
import { useThemeStore } from '@/theme';
import type { OrganisationDetail } from '@/types/auth';

export function OrganisationsPage() {
  const navigate = useNavigate();
  const palette = useThemeStore((s) => s.palette);
  const [orgs, setOrgs] = useState<OrganisationDetail[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);

  // Create form state
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [description, setDescription] = useState('');
  const [orgEmail, setOrgEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [website, setWebsite] = useState('');

  // Edit state
  const [editingOrg, setEditingOrg] = useState<OrganisationDetail | null>(null);
  const [editName, setEditName] = useState('');
  const [editSlug, setEditSlug] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [editOrgEmail, setEditOrgEmail] = useState('');
  const [editPhone, setEditPhone] = useState('');
  const [editWebsite, setEditWebsite] = useState('');

  useEffect(() => {
    loadOrgs();
  }, []);

  const loadOrgs = async () => {
    try {
      const list = await authApi.listOrganisations();
      setOrgs(list);
    } catch (err) {
      console.error('Failed to load organisations:', err);
    } finally {
      setLoading(false);
    }
  };

  const resetForm = () => {
    setName('');
    setSlug('');
    setDescription('');
    setOrgEmail('');
    setPhone('');
    setWebsite('');
    setShowForm(false);
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await authApi.createOrganisation({
        name,
        slug,
        description,
        email: orgEmail,
        phone,
        website,
      });
      resetForm();
      loadOrgs();
    } catch (err) {
      console.error('Failed to create organisation:', err);
      alert(err instanceof Error ? err.message : 'Failed to create organisation');
    }
  };

  const handleDelete = async (orgId: string) => {
    if (!confirm('Are you sure you want to delete this organisation?')) return;
    try {
      await authApi.deleteOrganisation(orgId);
      loadOrgs();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to delete organisation');
    }
  };

  const handleToggleActive = async (org: OrganisationDetail) => {
    try {
      await authApi.updateOrganisation(org.id, { is_active: !org.is_active });
      loadOrgs();
    } catch (err) {
      console.error('Failed to update organisation:', err);
    }
  };

  const startEditOrg = (org: OrganisationDetail) => {
    setEditingOrg(org);
    setEditName(org.name);
    setEditSlug(org.slug);
    setEditDescription(org.description);
    setEditOrgEmail(org.email);
    setEditPhone(org.phone);
    setEditWebsite(org.website);
  };

  const cancelEditOrg = () => {
    setEditingOrg(null);
  };

  const handleEditOrgSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!editingOrg) return;
    try {
      await authApi.updateOrganisation(editingOrg.id, {
        name: editName,
        slug: editSlug,
        description: editDescription,
        email: editOrgEmail,
        phone: editPhone,
        website: editWebsite,
      });
      setEditingOrg(null);
      loadOrgs();
    } catch (err) {
      console.error('Failed to update organisation:', err);
      alert(err instanceof Error ? err.message : 'Failed to update organisation');
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

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        padding: '24px',
        maxWidth: '800px',
        margin: '0 auto',
        gap: '16px',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1 style={{ fontSize: '22px', fontWeight: 700, color: palette.text, margin: 0 }}>
          Organisations
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
            + New Organisation
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
        <div style={{ background: palette.panelBg, borderRadius: '6px', padding: '16px' }}>
          <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
              <input type="text" placeholder="Name *" value={name} onChange={(e) => setName(e.target.value)} required style={inputStyle} />
              <input type="text" placeholder="Slug *" value={slug} onChange={(e) => setSlug(e.target.value)} required style={inputStyle} />
              <input type="email" placeholder="Email" value={orgEmail} onChange={(e) => setOrgEmail(e.target.value)} style={inputStyle} />
              <input type="tel" placeholder="Phone" value={phone} onChange={(e) => setPhone(e.target.value)} style={inputStyle} />
              <input type="url" placeholder="Website" value={website} onChange={(e) => setWebsite(e.target.value)} style={inputStyle} />
            </div>
            <textarea
              placeholder="Description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              style={{ ...inputStyle, resize: 'vertical' }}
            />
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

      {editingOrg && (
        <div style={{ background: palette.panelBg, borderRadius: '6px', padding: '16px' }}>
          <p style={{ fontSize: '14px', fontWeight: 600, color: palette.text, margin: '0 0 12px' }}>
            Edit: {editingOrg.name}
          </p>
          <form onSubmit={handleEditOrgSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
              <input type="text" placeholder="Name *" value={editName} onChange={(e) => setEditName(e.target.value)} required style={inputStyle} />
              <input type="text" placeholder="Slug *" value={editSlug} onChange={(e) => setEditSlug(e.target.value)} required style={inputStyle} />
              <input type="email" placeholder="Email" value={editOrgEmail} onChange={(e) => setEditOrgEmail(e.target.value)} style={inputStyle} />
              <input type="tel" placeholder="Phone" value={editPhone} onChange={(e) => setEditPhone(e.target.value)} style={inputStyle} />
              <input type="url" placeholder="Website" value={editWebsite} onChange={(e) => setEditWebsite(e.target.value)} style={inputStyle} />
            </div>
            <textarea
              placeholder="Description"
              value={editDescription}
              onChange={(e) => setEditDescription(e.target.value)}
              rows={2}
              style={{ ...inputStyle, resize: 'vertical' }}
            />
            <div style={{ display: 'flex', gap: '8px' }}>
              <button type="submit" style={{ padding: '8px 16px', background: palette.primaryBtn, color: '#fff', border: 'none', borderRadius: '4px', fontSize: '13px', cursor: 'pointer' }}>
                Save
              </button>
              <button type="button" onClick={cancelEditOrg} style={{ padding: '8px 16px', background: 'transparent', color: palette.textSecondary, border: `1px solid ${palette.textSecondary}`, borderRadius: '4px', fontSize: '13px', cursor: 'pointer' }}>
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
        ) : orgs.length === 0 ? (
          <div style={{ padding: '24px', textAlign: 'center', color: palette.textSecondary, fontSize: '14px' }}>
            No organisations yet.
          </div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
            <thead>
              <tr style={{ borderBottom: `1px solid ${palette.textSecondary}` }}>
                {['Name', 'Slug', 'Users', 'Status', 'Actions'].map((h) => (
                  <th key={h} style={{ padding: '10px 12px', textAlign: 'left', color: palette.textSecondary, fontWeight: 500 }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {orgs.map((org) => (
                <tr key={org.id} style={{ borderBottom: `1px solid ${palette.panelBg}`, opacity: org.is_active ? 1 : 0.5 }}>
                  <td style={{ padding: '8px 12px', color: palette.text, fontWeight: 500 }}>{org.name}</td>
                  <td style={{ padding: '8px 12px', color: palette.textSecondary }}>{org.slug}</td>
                  <td style={{ padding: '8px 12px', color: palette.text }}>{org.user_count}</td>
                  <td style={{ padding: '8px 12px' }}>
                    {org.is_active
                      ? <span style={{ color: '#4caf50', fontSize: '11px' }}>Active</span>
                      : <span style={{ color: palette.textSecondary, fontSize: '11px' }}>Inactive</span>}
                  </td>
                  <td style={{ padding: '8px 12px' }}>
                    <div style={{ display: 'flex', gap: '4px' }}>
                      <button onClick={() => startEditOrg(org)} style={{ background: 'none', border: 'none', fontSize: '12px', cursor: 'pointer', color: palette.primaryBtn, padding: '2px 6px' }}>
                        Edit
                      </button>
                      <button onClick={() => handleToggleActive(org)} style={{ background: 'none', border: 'none', fontSize: '12px', cursor: 'pointer', color: '#2196f3', padding: '2px 6px' }}>
                        {org.is_active ? 'Disable' : 'Enable'}
                      </button>
                      <button onClick={() => handleDelete(org.id)} style={{ background: 'none', border: 'none', fontSize: '12px', cursor: 'pointer', color: palette.danger, padding: '2px 6px' }}>
                        Delete
                      </button>
                    </div>
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
