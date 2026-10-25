import { useCallback, useEffect, useState } from 'react';
import { api as rawApi, errorText, type DocumentListItem } from '@/api/client';
import { projectApi } from '@/api/projectClient';
import type { ThemePalette } from '@/theme';
import type { ChatMessage } from '@/types/document';
import { diffStats, lineDiff } from '@/utils/lineDiff';
import { matchMentions } from '@/utils/mentions';

/** The part editor's view of its project: the other parts and sketches (for
 *  @-mentions) and this part's own list entry (its description). Reloaded when
 *  the part or project changes. */
export function useProjectDocs(projectId: string | null, docId: string | null) {
  const [docs, setDocs] = useState<DocumentListItem[]>([]);
  const reload = useCallback(() => {
    if (!projectId) { setDocs([]); return; }
    rawApi.listDocuments(projectId).then(setDocs).catch(() => setDocs([]));
  }, [projectId]);
  useEffect(() => { reload(); }, [reload, docId]);
  const self = docs.find((d) => d.id === docId) ?? null;
  const others = docs.filter((d) => d.id !== docId);
  const setDescription = async (text: string) => {
    if (!docId) return;
    const saved = await rawApi.setDescription(docId, text);
    setDocs((prev) => prev.map((d) => (d.id === docId ? { ...d, description: saved.description } : d)));
  };
  return { others, self, setDescription };
}

/** The list under the chat box while an @-mention is being typed. */
export function MentionMenu({ docs, query, active, onPick, onHover, palette }: {
  docs: DocumentListItem[]; query: string; active: number; palette: ThemePalette;
  onPick: (d: DocumentListItem) => void; onHover: (i: number) => void;
}) {
  const hits = matchMentions(docs, query);
  if (!hits.length) return null;
  return (
    <div role="listbox" aria-label="Parts and sketches in this project"
      style={{ position: 'absolute', left: 54, bottom: '100%', zIndex: 5, minWidth: 260, maxWidth: 420, marginBottom: 2,
               background: palette.panelBg, border: `1px solid ${palette.border}`, borderRadius: 6,
               boxShadow: '0 8px 24px -10px rgba(0,0,0,0.35)', overflow: 'hidden' }}>
      <div style={{ padding: '5px 10px', fontSize: '11px', color: palette.textMuted, borderBottom: `1px solid ${palette.border}` }}>
        Mention a part or sketch: its summary goes with your message
      </div>
      {hits.map((d, i) => (
        <div key={d.id} role="option" aria-selected={i === active}
          onMouseDown={(e) => { e.preventDefault(); onPick(d); }} onMouseEnter={() => onHover(i)}
          style={{ display: 'flex', alignItems: 'baseline', gap: 8, padding: '6px 10px', cursor: 'pointer',
                   background: i === active ? palette.activeItemBg : 'none' }}>
          <span style={{ fontSize: '10px', fontWeight: 700, letterSpacing: '0.5px', color: palette.textMuted, width: 44, flexShrink: 0 }}>
            {d.kind === 'part' ? 'PART' : 'SKETCH'}
          </span>
          <span style={{ fontSize: '13px', color: palette.text, whiteSpace: 'nowrap' }}>{d.name}</span>
          {d.description && (
            <span style={{ fontSize: '11.5px', color: palette.textSecondary, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {d.description}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

/** The AI's proposed change to the project brief, as a diff against the brief it
 *  read, with Accept (saved as a new brief version) and Reject. */
export function BriefProposalCard({ brief, projectId, palette, onStatus }: {
  brief: NonNullable<ChatMessage['brief']>; projectId: string | null; palette: ThemePalette;
  onStatus: (status: 'accepted' | 'rejected') => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [open, setOpen] = useState(brief.status === 'pending');
  const lines = lineDiff(brief.base, brief.text);
  const { added, removed } = diffStats(lines);
  const accept = async () => {
    if (!projectId) return;
    setBusy(true); setError('');
    try {
      const now = (await projectApi.getProject(projectId)).brief ?? '';
      if (now !== brief.base && !window.confirm('The brief has changed since the AI read it. Replace it with this proposal anyway?')) return;
      await projectApi.saveBrief(projectId, brief.text, `AI proposal: ${brief.reason}`.slice(0, 200));
      onStatus('accepted');
      setOpen(false);
    } catch (err) { setError(errorText(err)); }
    finally { setBusy(false); }
  };
  const green = '#1f9d55', red = palette.danger;
  return (
    <div style={{ marginTop: 6, border: `1px solid ${palette.border}`, borderRadius: 8, background: palette.background, overflow: 'hidden', fontSize: '12.5px' }}>
      <div onClick={() => setOpen((o) => !o)}
        style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', cursor: 'pointer', borderBottom: open ? `1px solid ${palette.border}` : 'none' }}>
        <span style={{ fontWeight: 600, color: palette.text }}>Proposed brief change</span>
        <span style={{ color: green }}>+{added}</span>
        <span style={{ color: red }}>−{removed}</span>
        <span style={{ flex: 1, color: palette.textSecondary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{brief.reason}</span>
        {brief.status !== 'pending' && (
          <span style={{ color: brief.status === 'accepted' ? green : palette.textMuted, fontWeight: 600 }}>
            {brief.status === 'accepted' ? '✓ accepted' : 'rejected'}
          </span>
        )}
        <span style={{ color: palette.textMuted }}>{open ? '▾' : '▸'}</span>
      </div>
      {open && (
        <>
          <div style={{ maxHeight: 260, overflowY: 'auto', fontFamily: 'ui-monospace, Menlo, monospace', fontSize: '12px', lineHeight: 1.5, padding: '4px 0' }}>
            {lines.map((l, i) => (
              <div key={i} style={{ padding: '0 10px', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                                    color: l.op === 'same' ? palette.textSecondary : palette.text,
                                    background: l.op === 'add' ? 'rgba(31,157,85,0.14)' : l.op === 'del' ? 'rgba(214,58,63,0.12)' : 'none',
                                    textDecoration: l.op === 'del' ? 'line-through' : 'none' }}>
                <span style={{ display: 'inline-block', width: 14, color: l.op === 'add' ? green : l.op === 'del' ? red : palette.textMuted }}>
                  {l.op === 'add' ? '+' : l.op === 'del' ? '−' : ' '}
                </span>
                {l.text || ' '}
              </div>
            ))}
          </div>
          {brief.status === 'pending' && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', borderTop: `1px solid ${palette.border}` }}>
              <span style={{ flex: 1, color: error ? palette.danger : palette.textMuted }}>
                {error || 'The AI only proposes: nothing changes unless you accept.'}
              </span>
              <button onClick={() => onStatus('rejected')} disabled={busy}
                style={{ padding: '4px 12px', background: 'none', color: palette.textSecondary, border: `1px solid ${palette.border}`, borderRadius: 4, cursor: 'pointer', fontSize: '12px' }}>
                Reject
              </button>
              <button onClick={() => void accept()} disabled={busy || !projectId}
                style={{ padding: '4px 12px', background: palette.primaryBtn, color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: '12px', opacity: busy ? 0.6 : 1 }}>
                {busy ? 'Saving…' : 'Accept'}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** This part's description on the line under the top bar: click to edit. */
export function DescriptionLine({ value, onSave, palette }: {
  value: string; onSave: (text: string) => Promise<void>; palette: ThemePalette;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [error, setError] = useState('');
  const commit = async () => {
    setEditing(false);
    const text = draft.replace(/\s+/g, ' ').trim();
    if (text === value) return;
    try { await onSave(text); setError(''); } catch (err) { setError(errorText(err)); }
  };
  if (editing) {
    return (
      <input value={draft} autoFocus maxLength={300} onChange={(e) => setDraft(e.target.value)} onBlur={() => void commit()}
        onKeyDown={(e) => { if (e.key === 'Enter') void commit(); if (e.key === 'Escape') setEditing(false); }}
        placeholder="What this part is for, e.g. carries the flight controller"
        style={{ flex: 1, minWidth: 120, height: 18, padding: '0 6px', fontSize: '11.5px', color: palette.text,
                 background: palette.inputBg, border: `1px solid ${palette.accent}`, borderRadius: 3, outline: 'none' }} />
    );
  }
  return (
    <span onClick={() => { setDraft(value); setEditing(true); }}
      title={error || (value ? `${value}\n\nClick to edit. The AI sees this line in the project's parts list.` : 'Add a line on what this part is for: the AI in the other parts sees it')}
      style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', cursor: 'text',
               color: error ? palette.danger : value ? palette.text : palette.textMuted, fontStyle: value ? 'normal' : 'italic' }}>
      {error ? `Couldn't save: ${error}` : value || 'Add a description'}
    </span>
  );
}
