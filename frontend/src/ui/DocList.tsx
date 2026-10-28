import { useState, type CSSProperties } from 'react';
import { DOC_SORTS, columnSort, isDocSort, type DocSort } from '@/utils/docSearch';
import type { DocumentListItem } from '@/api/client';
import { AppLink, openInNewTab } from './links';
import { useTokens, SANS, MONO } from './tokens';

export type DocView = 'grid' | 'list';

/** The grid or list choice and the sort order of a document list, kept per
 *  browser ('home' and 'project' are remembered apart). */
export function useDocListPrefs(scope: string, defaultSort: DocSort = 'recent') {
  const key = `intentcad.docs.${scope}`;
  const [prefs, setPrefs] = useState<{ view: DocView; sort: DocSort }>(() => {
    try {
      const p = JSON.parse(localStorage.getItem(key) ?? '{}') as { view?: unknown; sort?: unknown };
      return { view: p.view === 'list' ? 'list' : 'grid', sort: isDocSort(p.sort) ? p.sort : defaultSort };
    } catch { return { view: 'grid', sort: defaultSort }; }
  });
  const save = (next: { view: DocView; sort: DocSort }) => {
    setPrefs(next);
    try { localStorage.setItem(key, JSON.stringify(next)); } catch { /* ignore */ }
  };
  return {
    view: prefs.view, sort: prefs.sort,
    setView: (view: DocView) => save({ ...prefs, view }),
    setSort: (sort: DocSort) => save({ ...prefs, sort }),
  };
}

/** The sort menu and the Grid / List switch over a document list. */
export function DocListControls({ view, sort, onView, onSort, acrossProjects }: {
  view: DocView; sort: DocSort; onView: (v: DocView) => void; onSort: (s: DocSort) => void; acrossProjects?: boolean;
}) {
  const t = useTokens();
  const seg = (active: boolean): CSSProperties => ({
    display: 'flex', alignItems: 'center', gap: 5, padding: '6px 10px', fontFamily: SANS, fontSize: '12.5px', fontWeight: 600,
    cursor: 'pointer', border: 'none', background: active ? t.accentSoft : 'transparent', color: active ? t.accent : t.textDim,
  });
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontFamily: MONO, fontSize: '11px', color: t.textMute }}>
        SORT
        <select value={sort} onChange={(e) => onSort(e.target.value as DocSort)} aria-label="Sort documents"
          style={{ padding: '6px 8px', background: t.surface, color: t.text, border: `1px solid ${t.border}`, borderRadius: 8,
                   fontFamily: SANS, fontSize: '12.5px', cursor: 'pointer', outline: 'none' }}>
          {DOC_SORTS.filter((o) => acrossProjects || !o.acrossProjects || o.key === sort).map((o) => (
            <option key={o.key} value={o.key}>{o.label}</option>
          ))}
        </select>
      </label>
      <div role="group" aria-label="View" style={{ display: 'flex', border: `1px solid ${t.border}`, borderRadius: 8, overflow: 'hidden', background: t.surface }}>
        <button onClick={() => onView('grid')} style={seg(view === 'grid')} title="Cards with previews">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="4" y="4" width="7" height="7" rx="1" /><rect x="13" y="4" width="7" height="7" rx="1" /><rect x="4" y="13" width="7" height="7" rx="1" /><rect x="13" y="13" width="7" height="7" rx="1" /></svg>
          Grid
        </button>
        <button onClick={() => onView('list')} style={{ ...seg(view === 'list'), borderLeft: `1px solid ${t.border}` }} title="One row each; click a column heading to sort by it">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01" /></svg>
          List
        </button>
      </div>
    </div>
  );
}

function when(iso: string): string {
  const d = new Date(iso);
  const days = (Date.now() - d.getTime()) / 86_400_000;
  if (days < 1) return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: days > 300 ? 'numeric' : undefined });
}

/** Documents as rows: preview, name and description, kind, project (across
 *  projects), last edited and created. Clicking a column heading sorts by it. */
export function DocList({ docs, sort, onSort, onOpen, projectName }: {
  docs: DocumentListItem[]; sort: DocSort; onSort: (s: DocSort) => void;
  onOpen: (d: DocumentListItem) => void;
  /** set across projects: adds the Project column, its cell links to the project */
  projectName?: (id: string | null) => string;
}) {
  const t = useTokens();
  const [hovered, setHovered] = useState<string | null>(null);
  const cols = projectName ? '48px minmax(0,1fr) 96px 170px 104px 104px' : '48px minmax(0,1fr) 96px 104px 104px';
  const head = (label: string, column: Parameters<typeof columnSort>[0], active: boolean, arrow: string) => (
    <button onClick={() => onSort(columnSort(column, sort))} title={`Sort by ${label.toLowerCase()}`}
      style={{ display: 'flex', alignItems: 'center', gap: 4, padding: 0, background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left',
               fontFamily: MONO, fontSize: '10.5px', letterSpacing: '1px', color: active ? t.accent : t.textMute }}>
      {label}{active && <span>{arrow}</span>}
    </button>
  );
  const cell: CSSProperties = { fontFamily: MONO, fontSize: '12px', color: t.textMute, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' };
  return (
    <div style={{ background: t.surface, border: `1px solid ${t.border}`, borderRadius: 14, overflow: 'hidden' }}>
      <div style={{ display: 'grid', gridTemplateColumns: cols, gap: 14, alignItems: 'center', padding: '11px 18px', borderBottom: `1px solid ${t.border}` }}>
        <div />
        {head('NAME', 'name', sort === 'az' || sort === 'za', sort === 'za' ? '↑' : '↓')}
        {head('KIND', 'kind', sort === 'kind', '↓')}
        {projectName && head('PROJECT', 'project', sort === 'project', '↓')}
        {head('EDITED', 'edited', sort === 'recent' || sort === 'oldest', sort === 'oldest' ? '↑' : '↓')}
        {head('CREATED', 'created', sort === 'created' || sort === 'created-oldest', sort === 'created-oldest' ? '↑' : '↓')}
      </div>
      {docs.map((d) => {
        const isPart = d.kind === 'part';
        const href = isPart ? `/part/${d.id}` : `/edit/${d.id}`;
        const color = isPart ? t.part : t.sketch;
        const problem = d.failing_checks ? `${d.failing_checks} check${d.failing_checks === 1 ? '' : 's'} fail${d.failing_checks === 1 ? 's' : ''}`
          : d.stale?.length ? 'out of date' : d.pinned ? 'pinned' : '';
        return (
          <div key={d.id} role="link" tabIndex={0}
            onClick={(e) => { if (!openInNewTab(e, href)) onOpen(d); }}
            onAuxClick={(e) => { openInNewTab(e, href); }}
            onKeyDown={(e) => { if (e.key === 'Enter') onOpen(d); }}
            onMouseEnter={() => setHovered(d.id)} onMouseLeave={() => setHovered(null)}
            style={{ display: 'grid', gridTemplateColumns: cols, gap: 14, alignItems: 'center', padding: '8px 18px',
                     borderBottom: `1px solid ${t.border}`, cursor: 'pointer', outline: 'none',
                     background: hovered === d.id ? t.surface2 : 'transparent' }}>
            <div style={{ width: 48, height: 36, borderRadius: 6, background: t.thumbBg, border: `1px solid ${t.border}`,
                          display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
              {d.thumbnail
                ? <img src={d.thumbnail} alt="" style={{ maxWidth: '90%', maxHeight: '90%', objectFit: 'contain' }} />
                : <span style={{ width: 10, height: 10, borderRadius: 2, background: color, opacity: 0.7 }} />}
            </div>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: '14px', fontWeight: 600, color: t.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {d.name}
                {problem && <span style={{ marginLeft: 8, fontFamily: MONO, fontSize: '10.5px', fontWeight: 600, color: d.pinned && !d.stale?.length && !d.failing_checks ? t.violet : t.danger }}>{problem.toUpperCase()}</span>}
              </div>
              {(d.description || d.outputs?.length) ? (
                <div title={d.description || d.outputs?.join(', ')}
                  style={{ fontSize: '12px', color: t.textDim, marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {d.description || `outputs: ${d.outputs!.join(', ')}`}
                </div>
              ) : null}
            </div>
            <div style={{ ...cell, fontSize: '10.5px', fontWeight: 600, letterSpacing: '0.8px', color }}>
              {isPart ? 'PART' : d.source === 'generated' ? 'GENERATED' : 'SKETCH'}
            </div>
            {projectName && (
              <div style={cell} onClick={(e) => e.stopPropagation()}>
                {d.project_id
                  ? <AppLink to={`/project/${d.project_id}`} title="Open the project" style={{ color: t.textDim, maxWidth: '100%' }}>
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{projectName(d.project_id) || '—'}</span>
                    </AppLink>
                  : '—'}
              </div>
            )}
            <div style={cell} title={new Date(d.updated_at).toLocaleString()}>{when(d.updated_at)}</div>
            <div style={cell} title={new Date(d.created_at).toLocaleString()}>{when(d.created_at)}</div>
          </div>
        );
      })}
    </div>
  );
}
