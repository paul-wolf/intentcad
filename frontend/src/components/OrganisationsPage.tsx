import { useState, useEffect, type FormEvent, type CSSProperties } from 'react';
import { authApi } from '@/api/authClient';
import type { OrganisationDetail } from '@/types/auth';
import { TopNav } from '@/ui/TopNav';
import { useTokens, SANS, MONO } from '@/ui/tokens';

export function OrganisationsPage() {
  const t = useTokens();
  const [orgs, setOrgs] = useState<OrganisationDetail[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [search, setSearch] = useState('');

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

  useEffect(() => { loadOrgs(); }, []);

  const loadOrgs = async () => {
    try { setOrgs(await authApi.listOrganisations()); }
    catch (err) { console.error('Failed to load organisations:', err); }
    finally { setLoading(false); }
  };

  const resetForm = () => {
    setName(''); setSlug(''); setDescription(''); setOrgEmail(''); setPhone(''); setWebsite(''); setShowForm(false);
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await authApi.createOrganisation({ name, slug, description, email: orgEmail, phone, website });
      resetForm();
      loadOrgs();
    } catch (err) { alert(err instanceof Error ? err.message : 'Failed to create organisation'); }
  };

  const handleDelete = async (orgId: string) => {
    if (!confirm('Are you sure you want to delete this organisation?')) return;
    try { await authApi.deleteOrganisation(orgId); loadOrgs(); }
    catch (err) { alert(err instanceof Error ? err.message : 'Failed to delete organisation'); }
  };

  const handleToggleActive = async (org: OrganisationDetail) => {
    try { await authApi.updateOrganisation(org.id, { is_active: !org.is_active }); loadOrgs(); }
    catch (err) { console.error(err); }
  };

  const startEditOrg = (org: OrganisationDetail) => {
    setShowForm(false);
    setEditingOrg(org);
    setEditName(org.name); setEditSlug(org.slug); setEditDescription(org.description);
    setEditOrgEmail(org.email); setEditPhone(org.phone); setEditWebsite(org.website);
  };

  const handleEditOrgSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!editingOrg) return;
    try {
      await authApi.updateOrganisation(editingOrg.id, {
        name: editName, slug: editSlug, description: editDescription,
        email: editOrgEmail, phone: editPhone, website: editWebsite,
      });
      setEditingOrg(null);
      loadOrgs();
    } catch (err) { alert(err instanceof Error ? err.message : 'Failed to update organisation'); }
  };

  const initialsOf = (n: string) => n.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || n.slice(0, 2).toUpperCase();
  const totalUsers = orgs.reduce((n, o) => n + (o.user_count ?? 0), 0);
  const lower = search.toLowerCase();
  const visible = lower ? orgs.filter((o) => o.name.toLowerCase().includes(lower) || o.slug.toLowerCase().includes(lower)) : orgs;

  // ── styles ──
  const formInput: CSSProperties = {
    padding: '10px 12px', background: t.appBg, border: `1px solid ${t.border2}`, borderRadius: 8,
    color: t.text, fontFamily: SANS, fontSize: '13.5px', outline: 'none', width: '100%', boxSizing: 'border-box',
  };
  const primaryBtn: CSSProperties = { padding: '9px 18px', background: t.accent, color: '#fff', border: 'none', borderRadius: 8, fontSize: '13px', fontWeight: 600, cursor: 'pointer' };
  const ghostBtn: CSSProperties = { padding: '9px 18px', background: 'transparent', color: t.textDim, border: `1px solid ${t.border2}`, borderRadius: 8, fontSize: '13px', cursor: 'pointer' };
  const cardBtn: CSSProperties = { flex: 1, padding: 8, background: t.surface2, color: t.textDim, border: `1px solid ${t.border}`, borderRadius: 8, fontSize: '12.5px', fontWeight: 500, cursor: 'pointer' };
  const pill = (color: string, bg: string): CSSProperties => ({
    fontFamily: MONO, fontSize: '10px', fontWeight: 600, letterSpacing: '0.5px', color, background: bg,
    border: `1px solid ${color}`, borderRadius: 5, padding: '2px 7px',
  });

  const orgForm = (heading: string, vals: { name: string; slug: string; email: string; phone: string; website: string; description: string },
                   set: { name: (v: string) => void; slug: (v: string) => void; email: (v: string) => void; phone: (v: string) => void; website: (v: string) => void; description: (v: string) => void },
                   onSubmit: (e: FormEvent) => void, onCancel: () => void, submitLabel: string) => (
    <form onSubmit={onSubmit} style={{ background: t.surface, border: `1px solid ${t.border}`, borderRadius: 14, padding: '20px 20px 22px', marginBottom: 22 }}>
      <div style={{ fontSize: '14px', fontWeight: 600, color: t.text, marginBottom: 16 }}>{heading}</div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12, marginBottom: 12 }}>
        <input placeholder="Name *" value={vals.name} onChange={(e) => set.name(e.target.value)} required style={formInput} />
        <input placeholder="Slug *" value={vals.slug} onChange={(e) => set.slug(e.target.value)} required style={formInput} />
        <input placeholder="Email" type="email" value={vals.email} onChange={(e) => set.email(e.target.value)} style={formInput} />
        <input placeholder="Phone" type="tel" value={vals.phone} onChange={(e) => set.phone(e.target.value)} style={formInput} />
        <input placeholder="Website" type="url" value={vals.website} onChange={(e) => set.website(e.target.value)} style={formInput} />
      </div>
      <textarea placeholder="Description" rows={2} value={vals.description} onChange={(e) => set.description(e.target.value)}
        style={{ ...formInput, resize: 'vertical', fontFamily: SANS, marginBottom: 14 }} />
      <div style={{ display: 'flex', gap: 9 }}>
        <button type="submit" style={primaryBtn}>{submitLabel}</button>
        <button type="button" onClick={onCancel} style={ghostBtn}>Cancel</button>
      </div>
    </form>
  );

  return (
    <div style={{ height: '100%', overflow: 'auto', background: t.appBg, color: t.text, fontFamily: SANS }}>
      <TopNav />
      <div style={{ maxWidth: 1180, margin: '0 auto', padding: '36px 28px 72px' }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 20, marginBottom: 26 }}>
          <div>
            <div style={{ fontFamily: MONO, fontSize: '11px', letterSpacing: '2px', color: t.accent, marginBottom: 8 }}>ADMINISTRATION</div>
            <h1 style={{ margin: 0, fontSize: '26px', fontWeight: 700, letterSpacing: '-0.5px', color: t.text }}>Organisations</h1>
            <div style={{ fontFamily: MONO, fontSize: '12.5px', color: t.textDim, marginTop: 7 }}>
              {orgs.length} organisations &middot; {totalUsers} users total
            </div>
          </div>
          <button onClick={() => { setEditingOrg(null); setShowForm((v) => !v); }}
            style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '10px 16px', background: t.accent, color: '#fff',
                     border: 'none', borderRadius: 9, fontSize: '13.5px', fontWeight: 600, cursor: 'pointer', boxShadow: `0 6px 16px -8px ${t.accent}` }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
            New organisation
          </button>
        </div>

        {showForm && orgForm('Create organisation',
          { name, slug, email: orgEmail, phone, website, description },
          { name: setName, slug: setSlug, email: setOrgEmail, phone: setPhone, website: setWebsite, description: setDescription },
          handleSubmit, resetForm, 'Create')}

        {editingOrg && orgForm(`Edit ${editingOrg.name}`,
          { name: editName, slug: editSlug, email: editOrgEmail, phone: editPhone, website: editWebsite, description: editDescription },
          { name: setEditName, slug: setEditSlug, email: setEditOrgEmail, phone: setEditPhone, website: setEditWebsite, description: setEditDescription },
          handleEditOrgSubmit, () => setEditingOrg(null), 'Save')}

        {/* Toolbar */}
        <div style={{ marginBottom: 18 }}>
          <div style={{ position: 'relative', maxWidth: 340 }}>
            <span style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: t.textMute, display: 'flex' }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="7" /><path d="M21 21l-4-4" /></svg>
            </span>
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search organisations..."
              style={{ width: '100%', padding: '9px 12px 9px 36px', background: t.surface, border: `1px solid ${t.border}`, borderRadius: 9, color: t.text, fontFamily: SANS, fontSize: '13px', outline: 'none' }} />
          </div>
        </div>

        {/* Card grid */}
        {loading ? (
          <div style={{ padding: 44, textAlign: 'center', fontFamily: MONO, fontSize: '13px', color: t.textMute }}>Loading…</div>
        ) : visible.length === 0 ? (
          <div style={{ padding: 44, textAlign: 'center', fontFamily: MONO, fontSize: '13px', color: t.textMute }}>
            {orgs.length === 0 ? 'No organisations yet.' : `No organisations match “${search}”`}
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(304px,1fr))', gap: 16 }}>
            {visible.map((o) => (
              <div key={o.id} style={{ background: t.surface, border: `1px solid ${t.border}`, borderRadius: 14, padding: 18 }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 13, marginBottom: 16 }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 42, height: 42, flexShrink: 0, borderRadius: 11,
                                background: t.accentSoft, color: t.accent, fontFamily: MONO, fontSize: '14px', fontWeight: 600, border: `1px solid ${t.accent}` }}>{initialsOf(o.name)}</div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: '15px', fontWeight: 600, color: t.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{o.name}</div>
                    <div style={{ fontFamily: MONO, fontSize: '11.5px', color: t.textMute, marginTop: 3 }}>{o.slug}</div>
                  </div>
                  <span style={o.is_active ? pill(t.ok, t.okSoft) : pill(t.textMute, t.surface3)}>{o.is_active ? 'ACTIVE' : 'DISABLED'}</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 18, padding: '13px 0', borderTop: `1px solid ${t.border}`, borderBottom: `1px solid ${t.border}`, marginBottom: 14 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontFamily: MONO, fontSize: '12px', color: t.textDim }}>
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke={t.textMute} strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><circle cx="9" cy="8" r="3.2" /><path d="M3 20c0-3.3 2.7-5 6-5s6 1.7 6 5" /><path d="M16 5.2a3 3 0 0 1 0 5.6M18 20c0-2.6-1-4.2-3-5" /></svg>
                    {o.user_count} users
                  </div>
                  {o.website && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontFamily: MONO, fontSize: '12px', color: t.textDim, minWidth: 0 }}>
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke={t.textMute} strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c3 3.5 3 14 0 18M12 3c-3 3.5-3 14 0 18" /></svg>
                      <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{o.website}</span>
                    </div>
                  )}
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button style={cardBtn} onClick={() => startEditOrg(o)}
                    onMouseEnter={(e) => { e.currentTarget.style.color = t.text; e.currentTarget.style.borderColor = t.border2; }}
                    onMouseLeave={(e) => { e.currentTarget.style.color = t.textDim; e.currentTarget.style.borderColor = t.border; }}>Edit</button>
                  <button style={cardBtn} onClick={() => handleToggleActive(o)}
                    onMouseEnter={(e) => { e.currentTarget.style.color = t.text; e.currentTarget.style.borderColor = t.border2; }}
                    onMouseLeave={(e) => { e.currentTarget.style.color = t.textDim; e.currentTarget.style.borderColor = t.border; }}>{o.is_active ? 'Disable' : 'Enable'}</button>
                  <button title="Delete" onClick={() => handleDelete(o.id)}
                    style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 36, padding: 8, background: t.surface2, color: t.textMute, border: `1px solid ${t.border}`, borderRadius: 8, cursor: 'pointer' }}
                    onMouseEnter={(e) => { e.currentTarget.style.color = t.danger; e.currentTarget.style.borderColor = t.danger; }}
                    onMouseLeave={(e) => { e.currentTarget.style.color = t.textMute; e.currentTarget.style.borderColor = t.border; }}>
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18" /><path d="M8 6V4h8v2" /><path d="M6 6l1 14h10l1-14" /></svg>
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
