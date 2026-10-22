import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { authApi } from '@/api/authClient';
import type { UserEvent, UserEventKind, UserEventList } from '@/types/auth';
import { TopNav } from '@/ui/TopNav';
import { useTokens, SANS, MONO } from '@/ui/tokens';
import {
  KIND_LABELS, PERIODS, aiCallSummary, browserName, formatCost, periodRange, type EventPeriod,
} from '@/utils/userEvents';

const PAGE = 100;
const PERIOD_IDS: EventPeriod[] = ['today', '7d', '30d', 'all', 'custom'];

/** Superusers' log of what users did (sign-ins, parts and sketches made, AI
 *  calls) with the AI spend per user. The filters live in the URL. */
export function EventsPage() {
  const t = useTokens();
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const kind = params.get('kind') ?? '';
  const user = params.get('user') ?? '';
  const from = params.get('from') ?? '';
  const to = params.get('to') ?? '';
  const rawPeriod = params.get('period') as EventPeriod | null;
  const period: EventPeriod = rawPeriod && PERIOD_IDS.includes(rawPeriod) ? rawPeriod : '30d';

  const [search, setSearch] = useState(q);
  const [data, setData] = useState<UserEventList | null>(null);
  const [events, setEvents] = useState<UserEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [more, setMore] = useState(false);
  const [error, setError] = useState('');
  const request = useRef(0);

  const set = (changes: Record<string, string>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(changes)) {
      if (v) next.set(k, v); else next.delete(k);
    }
    setParams(next, { replace: true });
  };

  // the search box writes to the URL once typing pauses
  useEffect(() => { setSearch(q); }, [q]);
  useEffect(() => {
    if (search === q) return;
    const id = setTimeout(() => set({ q: search }), 300);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  const query = { q, kind, user, ...periodRange(period, new Date(), from, to) };
  const queryKey = JSON.stringify([q, kind, user, period, from, to]);

  useEffect(() => {
    const id = ++request.current;
    setLoading(true);
    setError('');
    authApi.listEvents({ ...query, limit: PAGE })
      .then((r) => { if (id === request.current) { setData(r); setEvents(r.events); } })
      .catch((e) => { if (id === request.current) setError(e instanceof Error ? e.message : 'Could not load the events'); })
      .finally(() => { if (id === request.current) setLoading(false); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryKey]);

  const loadMore = async () => {
    const id = request.current;
    setMore(true);
    try {
      const r = await authApi.listEvents({ ...query, offset: events.length, limit: PAGE });
      if (id === request.current) setEvents((es) => [...es, ...r.events]);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load more events');
    } finally {
      setMore(false);
    }
  };

  // ── styles ──
  const control: CSSProperties = {
    padding: '8px 11px', background: t.surface, border: `1px solid ${t.border}`, borderRadius: 9, color: t.text,
    fontFamily: SANS, fontSize: '13px', outline: 'none',
  };
  const card: CSSProperties = { background: t.surface, border: `1px solid ${t.border}`, borderRadius: 14, overflow: 'hidden' };
  const th: CSSProperties = {
    textAlign: 'left', padding: '10px 14px', fontFamily: MONO, fontSize: '10.5px', letterSpacing: '1px', fontWeight: 500,
    color: t.textMute, borderBottom: `1px solid ${t.border}`, whiteSpace: 'nowrap',
  };
  const td: CSSProperties = { padding: '10px 14px', borderBottom: `1px solid ${t.border}`, verticalAlign: 'top', fontSize: '13px' };
  const num: CSSProperties = { ...td, fontFamily: MONO, fontSize: '12.5px', textAlign: 'right', whiteSpace: 'nowrap' };
  const sectionTitle: CSSProperties = { fontSize: '14px', fontWeight: 600, color: t.text, margin: '0 0 10px' };
  const pillColors: Record<UserEventKind, [string, string]> = {
    login: [t.ok, t.okSoft],
    login_failed: [t.danger, 'transparent'],
    logout: [t.textMute, t.surface3],
    document_created: [t.part, t.partSoft],
    ai_call: [t.violet, t.violetSoft],
  };
  const pill = (k: UserEventKind): CSSProperties => ({
    fontFamily: MONO, fontSize: '10px', fontWeight: 600, letterSpacing: '0.5px', color: pillColors[k][0],
    background: pillColors[k][1], border: `1px solid ${pillColors[k][0]}`, borderRadius: 5, padding: '2px 7px',
    whiteSpace: 'nowrap', textTransform: 'uppercase',
  });
  const segment = (on: boolean): CSSProperties => ({
    padding: '8px 12px', background: on ? t.accentSoft : 'transparent', color: on ? t.accent : t.textDim, border: 'none',
    borderRight: `1px solid ${t.border}`, fontFamily: SANS, fontSize: '12.5px', fontWeight: on ? 600 : 400, cursor: 'pointer',
  });
  const when = (iso: string) => new Date(iso).toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });

  const details = (e: UserEvent): ReactNode => {
    const docLink = e.document_id && e.document_name ? (
      <Link to={`${e.document_kind === 'part' ? '/part' : '/edit'}/${e.document_id}`}
        style={{ color: t.accent, textDecoration: 'none', fontWeight: 500 }}>{e.document_name}</Link>
    ) : e.document_id ? <span style={{ color: t.textMute }}>a deleted {e.document_kind || 'document'}</span> : null;
    const sub = (s: string) => s && <div style={{ fontFamily: MONO, fontSize: '11px', color: t.textMute, marginTop: 4 }}>{s}</div>;
    switch (e.kind) {
      case 'ai_call':
        return (
          <>
            <div>{docLink}{docLink && e.text && ': '}<span style={{ color: t.textDim }}>{e.text ? `“${e.text}”` : ''}</span></div>
            {sub(aiCallSummary(e))}
          </>
        );
      case 'document_created':
        return <div>{docLink}{e.document_kind && <span style={{ color: t.textMute, fontSize: '12px' }}> · {e.document_kind}</span>}</div>;
      case 'login_failed':
        return (
          <>
            <div style={{ color: t.textDim }}>{e.user_id ? e.text : `No such user: “${e.text}”`}</div>
            {sub([e.ip_address, browserName(e.user_agent)].filter(Boolean).join(' · '))}
          </>
        );
      default:
        return sub([e.ip_address, browserName(e.user_agent)].filter(Boolean).join(' · '));
    }
  };

  const total = data?.total ?? 0;
  const selectedUser = data?.users.find((u) => u.id === user);

  return (
    <div style={{ height: '100%', overflow: 'auto', background: t.appBg, color: t.text, fontFamily: SANS }}>
      <TopNav />
      <div style={{ maxWidth: 1180, margin: '0 auto', padding: '36px 28px 72px' }}>
        {/* Header */}
        <div style={{ marginBottom: 22 }}>
          <div style={{ fontFamily: MONO, fontSize: '11px', letterSpacing: '2px', color: t.accent, marginBottom: 8 }}>ADMINISTRATION</div>
          <h1 style={{ margin: 0, fontSize: '26px', fontWeight: 700, letterSpacing: '-0.5px', color: t.text }}>Events</h1>
          <div style={{ fontFamily: MONO, fontSize: '12.5px', color: t.textDim, marginTop: 7 }}>
            {data ? <>{total.toLocaleString()} events &middot; {formatCost(data.spend.cost_usd)} on AI in {data.spend.ai_calls.toLocaleString()} calls</> : '…'}
          </div>
        </div>

        {/* Toolbar */}
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10, marginBottom: 22 }}>
          <div style={{ position: 'relative', flex: '1 1 200px', maxWidth: 270 }}>
            <span style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: t.textMute, display: 'flex' }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="7" /><path d="M21 21l-4-4" /></svg>
            </span>
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search events..." title="Search by user, part or sketch name, or the words of an AI request"
              style={{ ...control, width: '100%', boxSizing: 'border-box', paddingLeft: 36 }} />
          </div>
          <select value={kind} onChange={(e) => set({ kind: e.target.value })} style={control} aria-label="Event kind">
            <option value="">All events</option>
            {(Object.keys(KIND_LABELS) as UserEventKind[]).map((k) => <option key={k} value={k}>{KIND_LABELS[k]}</option>)}
          </select>
          <select value={user} onChange={(e) => set({ user: e.target.value })} style={{ ...control, maxWidth: 190 }} aria-label="User">
            <option value="">All users</option>
            {data?.users.map((u) => <option key={u.id} value={u.id}>{u.name === u.email ? u.email : `${u.name} (${u.email})`}</option>)}
          </select>
          <div style={{ display: 'flex', border: `1px solid ${t.border}`, borderRadius: 9, overflow: 'hidden', background: t.surface }}>
            {PERIODS.map((p) => (
              <button key={p.id} onClick={() => set({ period: p.id === '30d' ? '' : p.id, from: '', to: '' })}
                style={segment(period === p.id)}>{p.label}</button>
            ))}
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '12.5px', color: t.textDim }}>
            From
            <input type="date" value={from} onChange={(e) => set({ period: 'custom', from: e.target.value })} style={{ ...control, padding: '6px 8px' }} />
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '12.5px', color: t.textDim }}>
            To
            <input type="date" value={to} onChange={(e) => set({ period: 'custom', to: e.target.value })} style={{ ...control, padding: '6px 8px' }} />
          </label>
        </div>

        {error && <div style={{ color: t.danger, fontSize: '13px', marginBottom: 16 }}>{error}</div>}

        {/* Spend per user */}
        {data && data.by_user.length > 0 && (
          <div style={{ marginBottom: 26 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
              <h2 style={sectionTitle}>AI spend by user</h2>
              <span style={{ fontSize: '12px', color: t.textMute }}>
                {selectedUser ? <>showing {selectedUser.email} · <button onClick={() => set({ user: '' })}
                  style={{ background: 'none', border: 'none', padding: 0, color: t.accent, cursor: 'pointer', fontSize: '12px' }}>show everyone</button></>
                  : 'click a user to see only their events'}
              </span>
            </div>
            <div style={card}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    <th style={th}>USER</th><th style={th}>ORGANISATION</th>
                    <th style={{ ...th, textAlign: 'right' }}>AI CALLS</th><th style={{ ...th, textAlign: 'right' }}>AI SPEND</th>
                    <th style={{ ...th, textAlign: 'right' }}>SIGN-INS</th><th style={{ ...th, textAlign: 'right' }}>CREATED</th>
                    <th style={{ ...th, textAlign: 'right' }}>LAST SEEN</th>
                  </tr>
                </thead>
                <tbody>
                  {data.by_user.map((u) => (
                    <tr key={u.user_id} onClick={() => set({ user: u.user_id === user ? '' : u.user_id })}
                      style={{ cursor: 'pointer', background: u.user_id === user ? t.accentSoft : undefined }}
                      onMouseEnter={(e) => { if (u.user_id !== user) e.currentTarget.style.background = t.surface2; }}
                      onMouseLeave={(e) => { e.currentTarget.style.background = u.user_id === user ? t.accentSoft : ''; }}>
                      <td style={td}>
                        <div style={{ fontWeight: 500 }}>{u.name}</div>
                        <div style={{ fontFamily: MONO, fontSize: '11px', color: t.textMute, marginTop: 2 }}>{u.email}</div>
                      </td>
                      <td style={{ ...td, color: t.textDim }}>{u.organisation || '—'}</td>
                      <td style={num}>{u.ai_calls.toLocaleString()}</td>
                      <td style={{ ...num, fontWeight: 600, color: u.cost_usd ? t.text : t.textMute }}>{formatCost(u.cost_usd)}</td>
                      <td style={num}>{u.logins.toLocaleString()}</td>
                      <td style={num}>{u.documents_created.toLocaleString()}</td>
                      <td style={{ ...num, color: t.textDim }}>{u.last_at ? when(u.last_at) : ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* The events */}
        <h2 style={sectionTitle}>{kind ? KIND_LABELS[kind as UserEventKind] ?? 'Events' : 'All events'}</h2>
        {loading && !data ? (
          <div style={{ padding: 44, textAlign: 'center', fontFamily: MONO, fontSize: '13px', color: t.textMute }}>Loading…</div>
        ) : events.length === 0 ? (
          <div style={{ ...card, padding: 44, textAlign: 'center', fontFamily: MONO, fontSize: '13px', color: t.textMute }}>
            No events match these filters.
          </div>
        ) : (
          <div style={{ ...card, opacity: loading ? 0.6 : 1 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={th}>WHEN</th><th style={th}>USER</th><th style={th}>EVENT</th><th style={th}>DETAILS</th>
                  <th style={{ ...th, textAlign: 'right' }}>COST</th>
                </tr>
              </thead>
              <tbody>
                {events.map((e) => (
                  <tr key={e.id}>
                    <td style={{ ...td, fontFamily: MONO, fontSize: '12px', color: t.textDim, whiteSpace: 'nowrap' }}>{when(e.at)}</td>
                    <td style={{ ...td, maxWidth: 220 }}>
                      {e.user_id ? (
                        <button onClick={() => set({ user: e.user_id ?? '' })} title="Show only this user's events"
                          style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: t.text, fontFamily: SANS, fontSize: '13px', textAlign: 'left' }}>
                          {e.user_name || e.user_email}
                        </button>
                      ) : <span style={{ color: t.textMute }}>{e.user_email || 'unknown'}</span>}
                    </td>
                    <td style={td}><span style={pill(e.kind)}>{KIND_LABELS[e.kind] ?? e.kind}</span></td>
                    <td style={{ ...td, maxWidth: 520, overflowWrap: 'anywhere' }}>{details(e)}</td>
                    <td style={{ ...num, color: e.cost_usd ? t.text : t.textMute }}>{e.kind === 'ai_call' ? formatCost(e.cost_usd) : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {events.length > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 14, marginTop: 16, fontFamily: MONO, fontSize: '12px', color: t.textMute }}>
            showing {events.length.toLocaleString()} of {total.toLocaleString()}
            {events.length < total && (
              <button onClick={loadMore} disabled={more}
                style={{ padding: '8px 16px', background: t.surface, color: t.textDim, border: `1px solid ${t.border2}`, borderRadius: 8, fontSize: '12.5px', cursor: 'pointer' }}>
                {more ? 'Loading…' : 'Load more'}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
