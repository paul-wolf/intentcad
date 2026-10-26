import { useState, useEffect, useCallback, useMemo, useRef, type CSSProperties } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useAuthStore } from '@/stores/authStore';
import { useDocumentStore } from '@/stores/documentStore';
import { createEmptyDocument, createEmptyPart, generateNumberedName, migrateDocument } from '@/utils/document';
import { api, type DocumentListItem } from '@/api/cachedClient';
import { api as rawApi, errorText, sketchApi } from '@/api/client';
import { importScript, importLabel, partNameFor, STEP_ACCEPT } from '@/build/importStep';
import { setBackendId, setProjectContext } from '@/api/autoSave';
import type { Document } from '@/types/document';
import { projectApi } from '@/api/projectClient';
import type { Project, ProjectDetail } from '@/types/project';
import { TopNav } from '@/ui/TopNav';
import { DocCard } from '@/ui/DocCard';
import { useTokens, SANS, MONO } from '@/ui/tokens';
import { ContextPane, useContextFiles, type CtxColors } from './ContextPane';
import { AppLink } from '@/ui/links';
import { ProjectBrief } from './ProjectBrief';
import { ProjectParameters } from './ProjectParameters';

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

type Filter = 'all' | 'parts' | 'sketches';

export function DocumentListPage() {
  const navigate = useNavigate();
  const { projectId } = useParams<{ projectId: string }>();
  const t = useTokens();
  // the project's context files: reference PDFs and photos every part's AI can read
  const ctxOwner = useMemo(() => (projectId ? { project: projectId } : null), [projectId]);
  const ctxStore = useContextFiles(ctxOwner);
  const ctxColors: CtxColors = {
    text: t.text, dim: t.textDim, mute: t.textMute, border: t.border, surface: t.surface2, card: t.surface,
    accent: t.accent, primary: t.accent, danger: t.danger, warning: t.part,
  };
  const { user } = useAuthStore();
  const setDocument = useDocumentStore((s) => s.setDocument);
  const [docs, setDocs] = useState<DocumentListItem[]>([]);
  const [projectName, setProjectName] = useState('');
  const [project, setProject] = useState<ProjectDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [describingId, setDescribingId] = useState<string | null>(null);
  const [describeText, setDescribeText] = useState('');
  const [allProjects, setAllProjects] = useState<Project[]>([]);
  const [movingDoc, setMovingDoc] = useState<DocumentListItem | null>(null);
  const [notice, setNotice] = useState<{ text: string; ok?: boolean } | null>(null);

  const fail = (what: string, err: unknown) => {
    const m = err instanceof Error ? err.message : String(err);
    const short = m.length > 160 ? m.slice(0, 160) + '…' : m;
    console.error(what, err);
    setNotice({ text: `${what}: ${short}` });
    setTimeout(() => setNotice(null), 7000);
  };
  const note = (text: string) => { setNotice({ text, ok: true }); setTimeout(() => setNotice(null), 4000); };

  const ownerName = [user?.first_name, user?.last_name].filter(Boolean).join(' ') || user?.username || '';
  const ownerInitials = ((user?.first_name?.[0] ?? '') + (user?.last_name?.[0] ?? '') || user?.username?.slice(0, 2) || '?').toUpperCase();

  const fetchDocs = useCallback(async () => {
    try {
      setLoading(true);
      const [docList] = await Promise.all([
        api.listDocuments(projectId),
        projectId ? projectApi.getProject(projectId).then((p) => { setProject(p); setProjectName(p.name); }).catch(() => {}) : Promise.resolve(),
        projectApi.listProjects().then(setAllProjects).catch(() => {}),
      ]);
      setDocs(docList);
    } catch { /* ignore */ } finally { setLoading(false); }
  }, [projectId]);

  useEffect(() => { fetchDocs(); }, [fetchDocs]);

  const createAndOpen = async (doc: Document, route: (id: string) => string) => {
    setDocument(doc);
    try {
      const saved = await api.createDocument(doc.name, doc as unknown as Record<string, unknown>, projectId);
      setBackendId(saved.id);
      setProjectContext(projectId ?? null, projectName);
      navigate(route(saved.id));
    } catch { setBackendId(null); navigate(route(doc.id)); }
  };
  const uniqueName = (base: string) => generateNumberedName(base, docs.map((d) => d.name));
  const handleNew = () => createAndOpen(createEmptyDocument(uniqueName('Sketch')), (id) => `/edit/${id}`);
  const handleNewPart = () => createAndOpen(createEmptyPart(uniqueName('Part')), (id) => `/part/${id}`);
  // A sketch drawn by code: the server makes it with the starter code and runs it.
  const [sketchMenu, setSketchMenu] = useState(false);
  const handleNewGenerated = async () => {
    setSketchMenu(false);
    try {
      const d = await sketchApi.create({ project_id: projectId ?? null, name: uniqueName('Layout') });
      setProjectContext(projectId ?? null, projectName);
      navigate(`/edit/${d.id}`);
    } catch (err) { fail("Couldn't create the sketch", err); }
  };

  // New part from STEP: create the part, upload the file (trial-built server-side),
  // save the import script as its first version, then open it. A failed upload
  // removes the part it just created.
  const stepInput = useRef<HTMLInputElement | null>(null);
  const [importing, setImporting] = useState(false);
  const handleNewPartFromStep = async (file: File) => {
    const base = partNameFor(file.name);
    const doc = createEmptyPart(docs.some((d) => d.name === base) ? uniqueName(base) : base);
    setImporting(true);
    let createdId: string | null = null;
    try {
      const saved = await api.createDocument(doc.name, doc as unknown as Record<string, unknown>, projectId);
      createdId = saved.id;
      const asset = await rawApi.uploadAsset(saved.id, file);
      const label = importLabel(asset.filename);
      const withCode: Document = { ...doc, modelCode: importScript(asset), modelCodeLabel: label };
      await api.updateDocument(saved.id, { data: withCode as unknown as Record<string, unknown>, version_label: label });
      setDocument(withCode);
      setBackendId(saved.id);
      setProjectContext(projectId ?? null, projectName);
      navigate(`/part/${saved.id}`);
    } catch (err) {
      if (createdId) api.deleteDocument(createdId).catch(() => {});
      fail(`Couldn't import ${file.name}`, new Error(errorText(err)));
    } finally {
      setImporting(false);
    }
  };

  const handleOpen = async (d: DocumentListItem) => {
    try {
      const full = await api.getDocument(d.id);
      setDocument(migrateDocument(full.data as unknown as Document));
      setBackendId(full.id);
      setProjectContext(projectId ?? null, projectName);
      navigate(d.kind === 'part' ? `/part/${d.id}` : `/edit/${d.id}`);
    } catch (err) { fail("Couldn't open document", err); }
  };

  const handleDelete = async (id: string) => {
    try { await api.deleteDocument(id); setDocs((prev) => prev.filter((d) => d.id !== id)); }
    catch (err) { fail("Couldn't delete document", err); }
  };

  // a copy in this project, then its name ready to edit (Enter or click away keeps "Copy of ...")
  const handleDuplicate = async (d: DocumentListItem) => {
    try {
      const copy = await rawApi.duplicateDocument(d.id);
      setDocs(await api.listDocuments(projectId));   // with its kind and thumbnail
      setEditingId(copy.id); setEditName(copy.name);
      note(`Duplicated "${d.name}" as "${copy.name}"`);
    } catch (err) { fail("Couldn't duplicate document", new Error(errorText(err))); }
  };

  const moveDoc = async (target: Project) => {
    const doc = movingDoc;
    if (!doc) return;
    setMovingDoc(null);
    try {
      await api.updateDocument(doc.id, { project_id: target.id });
      setDocs((prev) => prev.filter((x) => x.id !== doc.id));   // it left this project; stay here
      note(`Moved "${doc.name}" to ${target.name}`);
    } catch (err) { fail("Couldn't move document", err); }
  };

  const deleteProject = async () => {
    if (!projectId) return;
    const n = docs.length;
    if (!window.confirm(`Delete project "${projectName}"${n ? ` and its ${n} document${n === 1 ? '' : 's'}` : ''}? This cannot be undone.`)) return;
    try { await projectApi.deleteProject(projectId); navigate('/'); }
    catch (err) { fail("Couldn't delete project", err); }
  };

  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  const commitTitle = async () => {
    const trimmed = titleDraft.trim();
    setEditingTitle(false);
    if (!projectId || !trimmed || trimmed === projectName) return;
    try {
      await projectApi.updateProject(projectId, { name: trimmed });
      setProjectName(trimmed);
      setProjectContext(projectId, trimmed);   // keep breadcrumb / autosave context in sync
    } catch (err) { fail("Couldn't rename project", err); }
  };

  const commitRename = async () => {
    if (!editingId || !editName.trim()) { setEditingId(null); return; }
    const trimmed = editName.trim();
    try {
      await api.updateDocument(editingId, { name: trimmed });
      setDocs((prev) => prev.map((d) => (d.id === editingId ? { ...d, name: trimmed } : d)));
    } catch (err) { fail("Couldn't rename", err); }
    setEditingId(null);
  };

  // the line on what a part is for: the AI sees it in the project's parts list
  const commitDescription = async () => {
    const id = describingId;
    setDescribingId(null);
    const d = docs.find((x) => x.id === id);
    const text = describeText.replace(/\s+/g, ' ').trim();
    if (!d || text === (d.description ?? '')) return;
    try {
      const saved = await rawApi.setDescription(d.id, text);
      setDocs((prev) => prev.map((x) => (x.id === d.id ? { ...x, description: saved.description } : x)));
    } catch (err) { fail("Couldn't save the description", new Error(errorText(err))); }
  };

  const lower = search.toLowerCase();
  const visible = lower ? docs.filter((d) => d.name.toLowerCase().includes(lower) || (d.description ?? '').toLowerCase().includes(lower)) : docs;
  const parts = visible.filter((d) => d.kind === 'part');
  const sketches = visible.filter((d) => d.kind !== 'part');
  const latest = docs.length ? docs.reduce((a, b) => (a.updated_at > b.updated_at ? a : b)).updated_at : null;

  const seg = (active: boolean): CSSProperties => ({
    padding: '7px 14px', borderRadius: 8, fontFamily: SANS, fontSize: '13px', fontWeight: 600, cursor: 'pointer',
    background: active ? t.accentSoft : t.surface, color: active ? t.accent : t.textDim,
    border: `1px solid ${active ? t.accent : t.border}`,
  });
  const cardOf = (d: DocumentListItem) => (
    <DocCard key={d.id}
      d={{ id: d.id, name: d.name, kind: d.kind, updated: relativeTime(d.updated_at), thumbnail: d.thumbnail, description: d.description,
           stale: d.stale, pinned: d.pinned, generated: d.source === 'generated', outputs: d.outputs,
           failingChecks: d.failing_checks }}
      onOpen={() => handleOpen(d)}
      onDoubleClick={() => { setEditingId(d.id); setEditName(d.name); }}
      onRename={() => { setEditingId(d.id); setEditName(d.name); }}
      onDuplicate={() => handleDuplicate(d)}
      onDescribe={projectId ? () => { setDescribingId(d.id); setDescribeText(d.description ?? ''); } : undefined}
      onDelete={() => handleDelete(d.id)}
      onMove={allProjects.length > 1 ? () => setMovingDoc(d) : undefined}
      editing={editingId === d.id ? { value: editName, onChange: setEditName, onCommit: commitRename, onCancel: () => setEditingId(null) } : undefined}
      describing={describingId === d.id ? { value: describeText, onChange: setDescribeText, onCommit: commitDescription, onCancel: () => setDescribingId(null) } : undefined}
    />
  );

  const sectionHeader = (color: string, label: string, count: number | null) => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 14 }}>
      <span style={{ width: 8, height: 8, borderRadius: 2, background: color }} />
      <span style={{ fontFamily: MONO, fontSize: '11px', letterSpacing: '1.5px', color: t.textDim }}>{label}</span>
      {count !== null && <span style={{ fontFamily: MONO, fontSize: '11px', color: t.textMute }}>({count})</span>}
      <span style={{ flex: 1, height: 1, background: t.border }} />
    </div>
  );

  const grid: CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(224px,1fr))', gap: 16, marginBottom: 40 };
  const showParts = (filter === 'all' || filter === 'parts') && parts.length > 0;
  const showSketches = (filter === 'all' || filter === 'sketches') && sketches.length > 0;

  return (
    <div style={{ height: '100%', overflow: 'auto', background: t.appBg, color: t.text, fontFamily: SANS }}>
      <TopNav />

      {notice && (
        <div onClick={() => setNotice(null)} title="Dismiss"
          style={{ position: 'fixed', top: 66, left: '50%', transform: 'translateX(-50%)', zIndex: 50,
                   maxWidth: 620, padding: '11px 16px', background: t.surface, color: t.text,
                   border: `1px solid ${notice.ok ? t.accent : t.danger}`, borderRadius: 10, boxShadow: t.shadow,
                   fontFamily: SANS, fontSize: '13px', cursor: 'pointer', display: 'flex', gap: 10, alignItems: 'center' }}>
          <span style={{ color: notice.ok ? t.accent : t.danger, fontWeight: 700, fontSize: '15px' }}>{notice.ok ? '✓' : '!'}</span>
          <span>{notice.text}</span>
        </div>
      )}

      {movingDoc && (
        <div onClick={() => setMovingDoc(null)}
          style={{ position: 'fixed', inset: 0, zIndex: 60, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
          <div onClick={(e) => e.stopPropagation()}
            style={{ width: '100%', maxWidth: 420, maxHeight: '70vh', display: 'flex', flexDirection: 'column',
                     background: t.surface, border: `1px solid ${t.border}`, borderRadius: 14, boxShadow: t.shadow, overflow: 'hidden' }}>
            <div style={{ padding: '16px 18px', borderBottom: `1px solid ${t.border}` }}>
              <div style={{ fontSize: '15px', fontWeight: 700, color: t.text }}>Move to project</div>
              <div style={{ fontFamily: MONO, fontSize: '12px', color: t.textMute, marginTop: 4, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{movingDoc.name}</div>
            </div>
            <div style={{ overflowY: 'auto' }}>
              {allProjects.filter((p) => p.id !== projectId).map((p) => (
                <button key={p.id} onClick={() => moveDoc(p)}
                  style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', textAlign: 'left',
                           padding: '12px 18px', background: 'none', border: 'none', borderBottom: `1px solid ${t.border}`, cursor: 'pointer', color: t.text }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = t.surface2)}
                  onMouseLeave={(e) => (e.currentTarget.style.background = 'none')}>
                  <span style={{ fontSize: '14px', fontWeight: 500 }}>{p.name}</span>
                  <span style={{ fontFamily: MONO, fontSize: '12px', color: t.textMute }}>{p.document_count} files</span>
                </button>
              ))}
              {allProjects.filter((p) => p.id !== projectId).length === 0 && (
                <div style={{ padding: '20px 18px', fontSize: '13px', color: t.textMute }}>No other projects to move to.</div>
              )}
            </div>
          </div>
        </div>
      )}

      {!loading && (
        <div style={{ maxWidth: 1200, margin: '0 auto', padding: '28px 28px 72px' }}>
          {/* Breadcrumb */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontFamily: MONO, fontSize: '12px', marginBottom: 20 }}>
            <AppLink to="/"
              style={{ padding: 0, color: t.textMute, cursor: 'pointer', fontFamily: MONO, fontSize: '12px' }}>Projects</AppLink>
            <span style={{ color: t.textMute }}>/</span>
            <span style={{ color: t.textDim }}>{projectName}</span>
          </div>

          {/* Header */}
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 20, marginBottom: 26 }}>
            <div>
              {editingTitle ? (
                <input value={titleDraft} autoFocus
                  onChange={(e) => setTitleDraft(e.target.value)}
                  onBlur={commitTitle}
                  onKeyDown={(e) => { if (e.key === 'Enter') commitTitle(); if (e.key === 'Escape') setEditingTitle(false); }}
                  style={{ fontSize: '26px', fontWeight: 700, letterSpacing: '-0.5px', color: t.text, fontFamily: SANS,
                           background: t.appBg, border: `1px solid ${t.accent}`, borderRadius: 8, padding: '2px 10px', outline: 'none' }} />
              ) : (
                <h1 onDoubleClick={() => { setTitleDraft(projectName); setEditingTitle(true); }}
                  title="Double-click to rename"
                  style={{ margin: 0, fontSize: '26px', fontWeight: 700, letterSpacing: '-0.5px', color: t.text, cursor: 'text' }}>{projectName}</h1>
              )}
              <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginTop: 10, fontFamily: MONO, fontSize: '12px', color: t.textDim }}>
                <span>{docs.length} documents</span>
                <span style={{ color: t.border2 }}>|</span>
                <span style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                  <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 20, height: 20, borderRadius: '50%', background: t.surface3, color: t.textDim, fontSize: '9px', fontWeight: 600 }}>{ownerInitials}</span>
                  {ownerName}
                </span>
                {latest && <><span style={{ color: t.border2 }}>|</span><span>updated {relativeTime(latest)}</span></>}
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
              <button onClick={deleteProject} title="Delete this project"
                style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '9px 12px', background: 'none', color: t.textMute,
                         border: `1px solid ${t.border}`, borderRadius: 9, fontSize: '13px', fontWeight: 500, cursor: 'pointer' }}
                onMouseEnter={(e) => { e.currentTarget.style.color = t.danger; e.currentTarget.style.borderColor = t.danger; }}
                onMouseLeave={(e) => { e.currentTarget.style.color = t.textMute; e.currentTarget.style.borderColor = t.border; }}>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /></svg>
                Delete
              </button>
              <div style={{ position: 'relative', display: 'flex' }}>
                <button onClick={handleNew} title="Draw a sketch"
                  style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '9px 12px 9px 14px', background: t.surface, color: t.text,
                           border: `1px solid ${t.border2}`, borderRadius: '9px 0 0 9px', fontSize: '13px', fontWeight: 600, cursor: 'pointer' }}>
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
                  New sketch
                </button>
                <button onClick={() => setSketchMenu((o) => !o)} aria-label="More ways to make a sketch" title="More ways to make a sketch"
                  style={{ padding: '9px 9px', background: t.surface, color: t.textDim, border: `1px solid ${t.border2}`, borderLeft: 'none',
                           borderRadius: '0 9px 9px 0', fontSize: '11px', cursor: 'pointer' }}>▾</button>
                {sketchMenu && (
                  <div role="menu" style={{ position: 'absolute', top: '100%', right: 0, marginTop: 4, zIndex: 20, background: t.surface,
                                            border: `1px solid ${t.border2}`, borderRadius: 9, boxShadow: t.shadow, minWidth: 250, padding: 4 }}>
                    <button role="menuitem" onClick={() => void handleNewGenerated()}
                      style={{ display: 'block', width: '100%', textAlign: 'left', background: 'none', border: 'none', borderRadius: 6,
                               padding: '8px 10px', cursor: 'pointer', color: t.text, fontFamily: SANS }}>
                      <div style={{ fontSize: '13px', fontWeight: 600 }}>Generated from code</div>
                      <div style={{ fontSize: '11.5px', color: t.textDim, marginTop: 2 }}>
                        A layout drawn by code from the project parameters. Parts use its outputs.
                      </div>
                    </button>
                  </div>
                )}
              </div>
              <input ref={stepInput} type="file" accept={STEP_ACCEPT} style={{ display: 'none' }}
                onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void handleNewPartFromStep(f); }} />
              <button onClick={() => stepInput.current?.click()} disabled={importing}
                title="Create a part from a STEP file (.step/.stp)"
                style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '9px 14px', background: t.surface, color: t.text,
                         border: `1px solid ${t.border2}`, borderRadius: 9, fontSize: '13px', fontWeight: 600,
                         cursor: importing ? 'default' : 'pointer', opacity: importing ? 0.6 : 1 }}>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round"><path d="M12 15V4M7 9l5-5 5 5M5 20h14" /></svg>
                {importing ? 'Importing…' : 'New part from STEP'}
              </button>
              <button onClick={handleNewPart}
                style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '9px 14px', background: t.accent, color: '#fff',
                         border: 'none', borderRadius: 9, fontSize: '13px', fontWeight: 600, cursor: 'pointer', boxShadow: `0 6px 16px -8px ${t.accent}` }}>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
                New part
              </button>
            </div>
          </div>

          {project && (
            <>
              {sectionHeader(t.ok, 'BRIEF', null)}
              <ProjectBrief project={project} onSaved={setProject} />
              {sectionHeader(t.violet, 'PARAMETERS', project.parameters?.length ?? 0)}
              <ProjectParameters project={project}
                onSaved={(p) => { setProject(p); api.listDocuments(projectId).then(setDocs).catch(() => {}); }} />
            </>
          )}

          {/* Toolbar */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, marginBottom: 28 }}>
            <div style={{ position: 'relative', flex: 1, maxWidth: 340 }}>
              <span style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: t.textMute, display: 'flex' }}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="7" /><path d="M21 21l-4-4" /></svg>
              </span>
              <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search documents..."
                style={{ width: '100%', padding: '9px 12px 9px 36px', background: t.surface, border: `1px solid ${t.border}`,
                         borderRadius: 9, color: t.text, fontFamily: SANS, fontSize: '13px', outline: 'none' }}
                onFocus={(e) => (e.currentTarget.style.borderColor = t.accent)}
                onBlur={(e) => (e.currentTarget.style.borderColor = t.border)} />
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              <button onClick={() => setFilter('all')} style={seg(filter === 'all')}>All</button>
              <button onClick={() => setFilter('parts')} style={seg(filter === 'parts')}>Parts &middot; {docs.filter((d) => d.kind === 'part').length}</button>
              <button onClick={() => setFilter('sketches')} style={seg(filter === 'sketches')}>Sketches &middot; {docs.filter((d) => d.kind !== 'part').length}</button>
            </div>
          </div>

          {showParts && (<>{sectionHeader(t.part, 'PARTS', parts.length)}<div style={grid}>{parts.map(cardOf)}</div></>)}
          {showSketches && (<>{sectionHeader(t.sketch, 'SKETCHES', sketches.length)}<div style={grid}>{sketches.map(cardOf)}</div></>)}

          {!showParts && !showSketches && (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 6,
                          padding: '64px 20px', border: `1px dashed ${t.border2}`, borderRadius: 14, background: t.surface, marginBottom: 40 }}>
              <div style={{ fontFamily: MONO, fontSize: '13px', color: t.textDim }}>
                {docs.length === 0 ? 'No documents yet' : 'Nothing matches'}
              </div>
              <div style={{ fontSize: '13px', color: t.textMute }}>
                {docs.length === 0 ? 'Create a part or a sketch to get started.' : 'Try a different search or filter.'}
              </div>
            </div>
          )}

          {projectId && (
            <>
              {sectionHeader(t.violet, 'CONTEXT FILES', ctxStore.files?.project.length ?? 0)}
              <div style={{ display: 'flex', flexDirection: 'column', marginBottom: 40, border: `1px solid ${t.border}`,
                            borderRadius: 12, background: t.surface2, overflow: 'hidden' }}>
                <ContextPane store={ctxStore} c={ctxColors} partOwned={false} viewerHeight="75vh"
                  intro="Datasheets, drawings and photos every part in this project can give the AI. Drop files here; a part's own files are in its Context layout." />
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
