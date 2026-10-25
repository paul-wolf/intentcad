/**
 * Context files: the reference PDFs and photos the AI reads with each message
 * (a board's datasheet, a photo of the board). The part editor's Context
 * layout shows a part's files and its project's; the project page shows the
 * project's. Cards toggle a file in or out of context; a card opens a viewer
 * with page navigation, zoom and pan, and the pages to send.
 */
import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { contextApi, errorText, type ContextFile, type ContextFiles, type ContextOwner } from '@/api/client';
import {
  CONTEXT_ACCEPT, acceptable, detailLabel, fileTokens, includedPages, togglePage, tokensLabel,
} from '@/build/contextFiles';

/** The few colours the pane needs; the editor and the project page map their
 *  own themes onto these. */
export interface CtxColors {
  text: string; dim: string; mute: string; border: string;
  surface: string; card: string; accent: string; primary: string; danger: string; warning: string;
}

type Scope = 'part' | 'project';
type Patch = Parameters<typeof contextApi.update>[1];

const ownerKey = (o: ContextOwner | null) => (o ? ('document' in o ? `d:${o.document}` : `p:${o.project}`) : '');

/** A part's (or a project's) context files, loaded and kept in step with the
 *  server. `owner` null: not saved yet, nothing to load. */
export function useContextFiles(owner: ContextOwner | null) {
  const [files, setFiles] = useState<ContextFiles | null>(null);
  const [error, setError] = useState('');
  const key = ownerKey(owner);
  const ownerRef = useRef(owner);
  ownerRef.current = owner;
  const reload = useCallback(() => {
    const o = ownerRef.current;
    if (!o) { setFiles(null); return Promise.resolve(); }
    const k = ownerKey(o);
    // a reply for a part or project left meanwhile is dropped
    return contextApi.list(o).then((c) => { if (ownerKey(ownerRef.current) === k) { setFiles(c); setError(''); } })
      .catch((e) => { if (ownerKey(ownerRef.current) === k) setError(errorText(e)); });
  }, []);
  // a new owner: clear the last one's files rather than show them while loading
  useEffect(() => { setFiles(null); setError(''); void reload(); }, [key, reload]);

  const put = (f: ContextFile) => setFiles((c) => {
    if (!c) return c;
    const list = c[f.scope];
    const at = list.findIndex((x) => x.id === f.id);
    return { ...c, [f.scope]: at < 0 ? [...list, f] : list.map((x) => (x.id === f.id ? f : x)) };
  });
  const upload = async (scope: Scope, file: File): Promise<ContextFile | null> => {
    const o = ownerRef.current;
    if (!o) { setError('Save the part first, then add files.'); return null; }
    const target: ContextOwner | null = scope === 'part'
      ? ('document' in o ? o : null)
      : ('project' in o ? o : files?.project_id ? { project: files.project_id } : null);
    if (!target) { setError('This part isn’t in a project.'); return null; }
    try {
      const f = await contextApi.upload(target, file);
      put(f);
      setError('');
      return f;
    } catch (e) {
      setError(errorText(e));
      return null;
    }
  };
  const update = async (id: string, patch: Patch) => {
    try { put(await contextApi.update(id, patch)); setError(''); }
    catch (e) { setError(errorText(e)); }
  };
  const remove = async (id: string) => {
    try {
      await contextApi.remove(id);
      setFiles((c) => c && { ...c, part: c.part.filter((f) => f.id !== id), project: c.project.filter((f) => f.id !== id) });
    } catch (e) { setError(errorText(e)); }
  };
  return { files, error, setError, reload, upload, update, remove };
}

export type ContextStore = ReturnType<typeof useContextFiles>;

const smallBtn = (c: CtxColors, active = false): CSSProperties => ({
  padding: '3px 9px', fontSize: '12px', borderRadius: 4, cursor: 'pointer', whiteSpace: 'nowrap',
  background: active ? c.card : 'none', color: active ? c.accent : c.dim,
  border: `1px solid ${active ? c.accent : c.border}`,
});

/** On/off switch for "in context". */
function Toggle({ on, onChange, c, title }: { on: boolean; onChange: (v: boolean) => void; c: CtxColors; title: string }) {
  return (
    <button role="switch" aria-checked={on} title={title} onClick={(e) => { e.stopPropagation(); onChange(!on); }}
      style={{ position: 'relative', width: 30, height: 17, borderRadius: 9, border: 'none', padding: 0, flexShrink: 0,
               cursor: 'pointer', background: on ? c.accent : c.border, transition: 'background 0.15s' }}>
      <span style={{ position: 'absolute', top: 2, left: on ? 15 : 2, width: 13, height: 13, borderRadius: '50%',
                     background: '#fff', transition: 'left 0.15s' }} />
    </button>
  );
}

/** One file: thumbnail, title, pages/size, in context, estimated tokens. */
export function ContextFileCard({ f, c, onOpen, onUpdate, onRemove, pricePerM }: {
  f: ContextFile; c: CtxColors; onOpen: () => void; onUpdate: (p: Patch) => void; onRemove: () => void;
  /** $ per million input tokens of the chosen model, for the cost hint */
  pricePerM?: number;
}) {
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState(f.title);
  const [noteDraft, setNoteDraft] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const tokens = fileTokens(f);
  const first = includedPages(f)[0] ?? 1;
  const cost = pricePerM ? (tokens * pricePerM) / 1e6 : null;
  const commitTitle = () => {
    setRenaming(false);
    const t = title.trim();
    if (t && t !== f.title) onUpdate({ title: t }); else setTitle(f.title);
  };
  const commitNote = () => {
    if (noteDraft != null && noteDraft.trim() !== f.note) onUpdate({ note: noteDraft });
    setNoteDraft(null);
  };
  const input: CSSProperties = {
    width: '100%', boxSizing: 'border-box', padding: '3px 6px', fontSize: '12px', color: c.text,
    background: c.surface, border: `1px solid ${c.accent}`, borderRadius: 4, outline: 'none',
  };
  return (
    <div data-context-file={f.id}
      style={{ display: 'flex', gap: 10, padding: 9, borderRadius: 7, background: c.card,
               border: `1px solid ${c.border}`, opacity: f.in_context ? 1 : 0.62 }}>
      <button onClick={onOpen} title="Open the viewer: pages, zoom, which pages the AI gets"
        style={{ width: 64, height: 80, flexShrink: 0, padding: 0, border: `1px solid ${c.border}`, borderRadius: 4,
                 background: '#fff', cursor: 'pointer', overflow: 'hidden', display: 'flex',
                 alignItems: 'center', justifyContent: 'center' }}>
        <img src={contextApi.thumbnailUrl(f.id, first, 160)} alt="" loading="lazy"
          style={{ maxWidth: '100%', maxHeight: '100%', display: 'block' }} />
      </button>
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {renaming ? (
            <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} onBlur={commitTitle}
              onKeyDown={(e) => { if (e.key === 'Enter') commitTitle(); if (e.key === 'Escape') { setTitle(f.title); setRenaming(false); } }}
              style={input} />
          ) : (
            <span onClick={onOpen} onDoubleClick={() => setRenaming(true)} title={`${f.filename} · double-click to rename`}
              style={{ flex: 1, minWidth: 0, fontSize: '13px', fontWeight: 600, color: c.text, cursor: 'pointer',
                       overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {f.title}
            </span>
          )}
          <Toggle on={f.in_context} c={c} onChange={(v) => onUpdate({ in_context: v })}
            title={f.in_context ? 'In context: the AI reads this file with each message. Click to leave it out.'
              : 'Not in context: the AI doesn’t see it. Click to include it.'} />
        </div>
        <div style={{ fontSize: '11.5px', color: c.dim }}>{detailLabel(f)}</div>
        {noteDraft != null ? (
          <input autoFocus value={noteDraft} placeholder="Note for the AI, e.g. board rev B"
            onChange={(e) => setNoteDraft(e.target.value)} onBlur={commitNote}
            onKeyDown={(e) => { if (e.key === 'Enter') commitNote(); if (e.key === 'Escape') setNoteDraft(null); }}
            style={input} />
        ) : (
          <span onClick={() => setNoteDraft(f.note)} title="Click to edit the note (the AI sees it)"
            style={{ fontSize: '11.5px', color: f.note ? c.text : c.mute, cursor: 'text', fontStyle: f.note ? 'normal' : 'italic',
                     overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {f.note || 'add a note…'}
          </span>
        )}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 'auto', fontSize: '11.5px', color: c.dim }}>
          <span title={`About ${tokens.toLocaleString()} input tokens per message for the pages sent; repeated `
                       + 'messages read them from the prompt cache at a tenth of the price or less'}
            style={{ whiteSpace: 'nowrap' }}>
            ~{tokensLabel(tokens)} tokens{cost != null ? ` · ≈$${cost < 0.01 ? cost.toFixed(3) : cost.toFixed(2)}` : ''}
          </span>
          <span style={{ flex: 1 }} />
          <button onClick={() => setRenaming(true)} style={{ ...smallBtn(c), padding: '1px 7px', fontSize: '11px' }}>Rename</button>
          {confirmDelete ? (
            <>
              <button onClick={onRemove} style={{ ...smallBtn(c), padding: '1px 7px', fontSize: '11px', color: c.danger, borderColor: c.danger }}>
                Delete
              </button>
              <button onClick={() => setConfirmDelete(false)} style={{ ...smallBtn(c), padding: '1px 7px', fontSize: '11px' }}>Keep</button>
            </>
          ) : (
            <button onClick={() => setConfirmDelete(true)} title="Remove this file (builds don't use it)"
              style={{ ...smallBtn(c), padding: '1px 7px', fontSize: '11px' }}>Remove</button>
          )}
        </div>
      </div>
    </div>
  );
}

/** A file's pages: a strip of page thumbnails (each with "send to the AI"),
 *  the page itself with zoom (wheel, buttons) and pan (drag), and arrows. */
export function ContextViewer({ f, c, onClose, onUpdate }: {
  f: ContextFile; c: CtxColors; onClose: () => void; onUpdate: (p: Patch) => void;
}) {
  const n = f.page_count ?? 1;
  const isPdf = f.page_count != null;
  const [page, setPage] = useState(() => includedPages(f)[0] ?? 1);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number; px: number; py: number } | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  // focused when it opens, so the arrow keys page through it at once
  useEffect(() => { rootRef.current?.focus({ preventScroll: true }); }, []);
  const included = new Set(includedPages(f));
  const go = (p: number) => { setPage(Math.min(n, Math.max(1, p))); setZoom(1); setPan({ x: 0, y: 0 }); };
  const zoomAt = (factor: number, cx = 0, cy = 0) => {
    // keep the point under (cx, cy), measured from the box centre, in place
    setZoom((z) => {
      const nz = Math.min(8, Math.max(1, z * factor));
      setPan((p) => (nz === 1 ? { x: 0, y: 0 } : { x: cx - ((cx - p.x) * nz) / z, y: cy - ((cy - p.y) * nz) / z }));
      return nz;
    });
  };
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX - r.left - r.width / 2, e.clientY - r.top - r.height / 2);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);
  const setPages = (pages: number[] | null) => onUpdate(pages == null ? { all_pages: true } : { pages });
  const pageOn = included.has(page);
  return (
    <div ref={rootRef} tabIndex={0} data-context-viewer
      onKeyDown={(e) => {
        if (e.key === 'ArrowRight' || e.key === 'PageDown') go(page + 1);
        else if (e.key === 'ArrowLeft' || e.key === 'PageUp') go(page - 1);
        else if (e.key === 'Escape') onClose();
        else if (e.key === '+' || e.key === '=') zoomAt(1.25);
        else if (e.key === '-') zoomAt(0.8);
        else return;
        e.preventDefault();
        e.stopPropagation();
      }}
      style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', outline: 'none' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', borderBottom: `1px solid ${c.border}`, flexWrap: 'wrap' }}>
        <button onClick={onClose} title="Back to the files (Esc)" style={smallBtn(c)}>← Files</button>
        <span style={{ fontSize: '13px', fontWeight: 600, color: c.text, minWidth: 0, overflow: 'hidden',
                       textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }} title={f.filename}>{f.title}</span>
        {isPdf && (
          <>
            <button onClick={() => go(page - 1)} disabled={page <= 1} title="Previous page (←)" style={smallBtn(c)}>‹</button>
            <span style={{ fontSize: '12px', color: c.dim, whiteSpace: 'nowrap' }}>page {page} of {n}</span>
            <button onClick={() => go(page + 1)} disabled={page >= n} title="Next page (→)" style={smallBtn(c)}>›</button>
          </>
        )}
        <button onClick={() => zoomAt(0.8)} title="Zoom out (−, or the wheel)" style={smallBtn(c)}>−</button>
        <button onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }); }} title="Fit the page" style={smallBtn(c, zoom === 1)}>
          {Math.round(zoom * 100)}%
        </button>
        <button onClick={() => zoomAt(1.25)} title="Zoom in (+, or the wheel)" style={smallBtn(c)}>+</button>
      </div>
      <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
        {isPdf && n > 1 && (
          <div style={{ width: 92, flexShrink: 0, overflowY: 'auto', borderRight: `1px solid ${c.border}`,
                        padding: '8px 6px', display: 'flex', flexDirection: 'column', gap: 8 }}>
            {Array.from({ length: n }, (_, i) => i + 1).map((p) => (
              <div key={p} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
                <button onClick={() => go(p)} title={`Page ${p}`}
                  ref={p === page ? (el) => el?.scrollIntoView({ block: 'nearest' }) : undefined}
                  style={{ padding: 0, width: 72, background: '#fff', cursor: 'pointer', borderRadius: 3,
                           border: `2px solid ${p === page ? c.accent : 'transparent'}`, opacity: included.has(p) ? 1 : 0.45 }}>
                  <img src={contextApi.thumbnailUrl(f.id, p, 160)} alt={`page ${p}`} loading="lazy"
                    style={{ width: '100%', display: 'block' }} />
                </button>
                <label title="Send this page to the AI" style={{ display: 'flex', alignItems: 'center', gap: 3,
                                 fontSize: '11px', color: included.has(p) ? c.text : c.mute, cursor: 'pointer' }}>
                  <input type="checkbox" checked={included.has(p)} onChange={() => setPages(togglePage(f, p))}
                    style={{ margin: 0 }} />
                  {p}
                </label>
              </div>
            ))}
          </div>
        )}
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          <div ref={boxRef}
            onPointerDown={(e) => {
              if (zoom === 1) return;
              drag.current = { x: e.clientX, y: e.clientY, px: pan.x, py: pan.y };
              e.currentTarget.setPointerCapture(e.pointerId);
            }}
            onPointerMove={(e) => {
              const d = drag.current;
              if (d) setPan({ x: d.px + e.clientX - d.x, y: d.py + e.clientY - d.y });
            }}
            onPointerUp={() => { drag.current = null; }}
            onDoubleClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              if (zoom > 1) { setZoom(1); setPan({ x: 0, y: 0 }); }
              else zoomAt(2.5, e.clientX - r.left - r.width / 2, e.clientY - r.top - r.height / 2);
            }}
            style={{ flex: 1, minHeight: 0, overflow: 'hidden', position: 'relative', background: c.surface,
                     cursor: zoom > 1 ? (drag.current ? 'grabbing' : 'grab') : 'zoom-in', touchAction: 'none' }}>
            <img src={contextApi.thumbnailUrl(f.id, page, 1600)} alt={`${f.title} page ${page}`} draggable={false}
              style={{ position: 'absolute', inset: 0, margin: 'auto', maxWidth: 'calc(100% - 16px)',
                       maxHeight: 'calc(100% - 16px)', background: '#fff', boxShadow: '0 2px 10px rgba(0,0,0,0.25)',
                       transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`, transformOrigin: 'center',
                       userSelect: 'none' }} />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 12px', borderTop: `1px solid ${c.border}`,
                        fontSize: '12px', color: c.dim, flexWrap: 'wrap' }}>
            {isPdf ? (
              <>
                <label style={{ display: 'flex', alignItems: 'center', gap: 5, color: pageOn ? c.text : c.dim, cursor: 'pointer' }}>
                  <input type="checkbox" checked={pageOn} onChange={() => setPages(togglePage(f, page))} />
                  Send page {page} to the AI
                </label>
                <span>{detailLabel(f).split(' · ')[0]} · ~{tokensLabel(fileTokens(f))} tokens</span>
                <span style={{ flex: 1 }} />
                <button onClick={() => setPages(null)} disabled={f.pages == null} style={smallBtn(c)}>All pages</button>
                <button onClick={() => setPages([page])} title="Send only the page shown" style={smallBtn(c)}>Only this page</button>
              </>
            ) : (
              <span>{detailLabel(f)} · ~{tokensLabel(fileTokens(f))} tokens · the AI gets it downscaled to 1600 px</span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** "This part" / "Whole project", for files added while the part has a project. */
function ScopeChooser({ files, c, onPick }: { files: File[]; c: CtxColors; onPick: (s: Scope | null) => void }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '9px 12px', borderRadius: 7, flexWrap: 'wrap',
                  border: `1px solid ${c.accent}`, background: c.card, fontSize: '12.5px', color: c.text }}>
      <span style={{ flex: 1, minWidth: 140 }}>
        Add {files.length === 1 ? files[0]!.name : `${files.length} files`} to
      </span>
      <button onClick={() => onPick('part')} title="Only this part's AI reads it" style={smallBtn(c, true)}>This part</button>
      <button onClick={() => onPick('project')} title="Every part in the project can use it" style={smallBtn(c, true)}>
        Whole project
      </button>
      <button onClick={() => onPick(null)} style={smallBtn(c)}>Cancel</button>
    </div>
  );
}

/** The Context pane: the part's and the project's files (or, with no part,
 *  the project's), drag-and-drop and a button to add more, and the viewer. */
export function ContextPane({ store, c, partOwned, pricePerM, pickRef, intro, viewerHeight }: {
  store: ContextStore; c: CtxColors;
  /** true in the part editor: shows "This part" and asks where a file goes */
  partOwned: boolean;
  pricePerM?: number;
  /** set to a function that opens the file picker (the "Add context file" operation) */
  pickRef?: { current: (() => void) | null };
  intro?: ReactNode;
  /** the viewer's height where the pane isn't in a full-height column (the project page) */
  viewerHeight?: string;
}) {
  const { files, error, setError } = store;
  const [openId, setOpenId] = useState<string | null>(null);
  const [pending, setPending] = useState<File[] | null>(null);
  const [uploading, setUploading] = useState<string[]>([]);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const hasProject = !!files?.project_id;
  if (pickRef) pickRef.current = () => inputRef.current?.click();

  const send = async (scope: Scope, list: File[]) => {
    setUploading(list.map((f) => f.name));
    try {
      for (const f of list) await store.upload(scope, f);
    } finally {
      setUploading([]);
    }
  };
  const add = (list: File[]) => {
    const ok = list.filter(acceptable);
    const bad = list.filter((f) => !acceptable(f));
    if (bad.length) setError(`${bad.map((f) => f.name).join(', ')}: only PDF, PNG, JPEG, WebP or HEIC files.`);
    if (!ok.length) return;
    if (!partOwned) void send('project', ok);
    else if (hasProject) setPending(ok);
    else void send('part', ok);
  };
  const open = files && [...files.part, ...files.project].find((f) => f.id === openId);
  if (open) {
    const viewer = <ContextViewer key={open.id} f={open} c={c} onClose={() => setOpenId(null)}
      onUpdate={(p) => void store.update(open.id, p)} />;
    return viewerHeight ? <div style={{ height: viewerHeight, display: 'flex', flexDirection: 'column' }}>{viewer}</div> : viewer;
  }
  const section = (label: string, list: ContextFile[], hint: string) => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <span style={{ fontSize: '11px', letterSpacing: '1.2px', textTransform: 'uppercase', color: c.dim, fontWeight: 600 }}>{label}</span>
        <span style={{ fontSize: '11px', color: c.mute }}>{hint}</span>
      </div>
      {list.length === 0 ? (
        <div style={{ fontSize: '12px', color: c.mute, padding: '4px 0 6px' }}>No files.</div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 8 }}>
          {list.map((f) => (
            <ContextFileCard key={f.id} f={f} c={c} pricePerM={pricePerM} onOpen={() => setOpenId(f.id)}
              onUpdate={(p) => void store.update(f.id, p)} onRemove={() => void store.remove(f.id)} />
          ))}
        </div>
      )}
    </div>
  );
  return (
    <div
      onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDragging(true); } }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false); }}
      onDrop={(e) => { e.preventDefault(); setDragging(false); add([...e.dataTransfer.files]); }}
      style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '12px 14px', display: 'flex', flexDirection: 'column',
               gap: 16, outline: dragging ? `2px dashed ${c.accent}` : 'none', outlineOffset: -6 }}>
      <input ref={inputRef} type="file" multiple accept={CONTEXT_ACCEPT} style={{ display: 'none' }}
        onChange={(e) => { const l = [...(e.target.files ?? [])]; e.target.value = ''; add(l); }} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ flex: 1, fontSize: '12.5px', color: c.dim, lineHeight: 1.45 }}>
          {intro ?? 'Datasheets, drawings and photos the AI reads with each message. Drop files here, or paste a photo into the chat.'}
        </span>
        <button onClick={() => inputRef.current?.click()} disabled={!files}
          style={{ ...smallBtn(c, true), padding: '5px 12px', fontSize: '12.5px' }}>+ Add file</button>
      </div>
      {pending && (
        <ScopeChooser files={pending} c={c} onPick={(s) => { const l = pending; setPending(null); if (s) void send(s, l); }} />
      )}
      {uploading.length > 0 && (
        <div style={{ fontSize: '12px', color: c.dim }}>Uploading {uploading.join(', ')}…</div>
      )}
      {error && (
        <div onClick={() => setError('')} title="Dismiss"
          style={{ fontSize: '12px', color: c.danger, border: `1px solid ${c.danger}`, borderRadius: 6, padding: '6px 10px', cursor: 'pointer' }}>
          {error}
        </div>
      )}
      {!files ? (
        <div style={{ fontSize: '12.5px', color: c.mute }}>{partOwned ? 'Loading… (a new part is saved first)' : 'Loading…'}</div>
      ) : (
        <>
          {partOwned && section('This part', files.part, 'only this part’s AI reads these')}
          {(hasProject || !partOwned) && section('Project', files.project,
            partOwned ? 'shared by every part in the project; on/off and pages apply project-wide' : 'every part in this project can use these')}
        </>
      )}
    </div>
  );
}

/** The chips above the chat box: the files the next message sends. A chip's
 *  × leaves that file out of this one message; ↺ puts it back. */
export function ContextChips({ files, skipped, c, onSkip, onOpen }: {
  files: ContextFile[]; skipped: ReadonlySet<string>; c: CtxColors;
  onSkip: (id: string, skip: boolean) => void; onOpen: () => void;
}) {
  if (!files.length) return null;
  const total = files.filter((f) => !skipped.has(f.id)).reduce((s, f) => s + fileTokens(f), 0);
  return (
    <div data-context-chips style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', padding: '6px 16px 0' }}>
      <span onClick={onOpen} title="Open the Context layout" style={{ fontSize: '11.5px', color: c.dim, cursor: 'pointer' }}>
        With this message (~{tokensLabel(total)} tokens):
      </span>
      {files.map((f) => {
        const off = skipped.has(f.id);
        return (
          <span key={f.id} title={`${f.title} — ${detailLabel(f)}${f.note ? ` — ${f.note}` : ''}`}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 5, maxWidth: 220, padding: '2px 4px 2px 3px',
                     borderRadius: 12, fontSize: '12px', border: `1px solid ${off ? c.border : c.accent}`,
                     color: off ? c.mute : c.text, background: off ? 'none' : c.card,
                     textDecoration: off ? 'line-through' : 'none' }}>
            <img src={contextApi.thumbnailUrl(f.id, includedPages(f)[0] ?? 1, 160)} alt=""
              style={{ width: 16, height: 16, objectFit: 'cover', borderRadius: 8, background: '#fff' }} />
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.title}</span>
            <button onClick={() => onSkip(f.id, !off)} aria-label={off ? `Send ${f.title}` : `Don't send ${f.title}`}
              title={off ? 'Send it with this message after all' : 'Leave it out of this message (it stays in context)'}
              style={{ border: 'none', background: 'none', color: c.dim, cursor: 'pointer', padding: '0 3px', fontSize: '12px', lineHeight: 1 }}>
              {off ? '↺' : '×'}
            </button>
          </span>
        );
      })}
    </div>
  );
}
