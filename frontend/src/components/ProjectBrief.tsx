import { useEffect, useState, type CSSProperties } from 'react';
import { projectApi } from '@/api/projectClient';
import type { BriefVersion, ProjectDetail } from '@/types/project';
import { Markdown } from '@/ui/Markdown';
import { useTokens, SANS, MONO } from '@/ui/tokens';
import { wordCount } from '@/utils/lineDiff';

/** Past this many words the brief still goes to the AI, but it says so: a long
 *  brief costs every message in every part (mirrors project_context.BRIEF_SOFT_WORDS). */
export const BRIEF_SOFT_WORDS = 2000;

function when(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** The project brief on the project page: Markdown every part's AI reads first.
 *  Shown rendered; Edit opens Write / Preview tabs; each save is kept as a version. */
export function ProjectBrief({ project, onSaved }: { project: ProjectDetail; onSaved: (p: ProjectDetail) => void }) {
  const t = useTokens();
  const brief = project.brief ?? '';
  const [editing, setEditing] = useState(false);
  const [tab, setTab] = useState<'write' | 'preview'>('write');
  const [draft, setDraft] = useState(brief);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState(false);
  const [versions, setVersions] = useState<BriefVersion[] | null>(null);

  useEffect(() => { if (!editing) setDraft(brief); }, [brief, editing]);

  const words = wordCount(editing ? draft : brief);
  const over = words > BRIEF_SOFT_WORDS;
  const save = async () => {
    setSaving(true); setError('');
    try {
      onSaved(await projectApi.saveBrief(project.id, draft));
      setEditing(false);
      if (versions) setVersions(await projectApi.briefVersions(project.id));
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setSaving(false); }
  };
  const toggleVersions = async () => {
    if (versions) { setVersions(null); return; }
    try { setVersions(await projectApi.briefVersions(project.id)); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
  };

  const button = (primary = false): CSSProperties => ({
    padding: '6px 12px', borderRadius: 8, fontFamily: SANS, fontSize: '12.5px', fontWeight: 600, cursor: 'pointer',
    background: primary ? t.accent : t.surface, color: primary ? '#fff' : t.textDim,
    border: primary ? 'none' : `1px solid ${t.border2}`,
  });
  const tabStyle = (on: boolean): CSSProperties => ({
    padding: '6px 12px', fontFamily: SANS, fontSize: '12.5px', fontWeight: 600, cursor: 'pointer', background: 'none',
    border: 'none', borderBottom: `2px solid ${on ? t.accent : 'transparent'}`, color: on ? t.accent : t.textDim,
  });
  const md = (text: string, style?: CSSProperties) => (
    <Markdown text={text} color={t.text} dim={t.textDim} border={t.border2} codeBg={t.surface3}
      style={{ fontSize: '14px', ...style }} />
  );

  const status = (
    <span style={{ fontFamily: MONO, fontSize: '11.5px', color: over ? t.danger : t.textMute }}>
      {!editing && project.brief_updated_at ? `Saved ${when(project.brief_updated_at)} · ` : ''}
      {words.toLocaleString()} words{over ? ` · over ${BRIEF_SOFT_WORDS.toLocaleString()}: every message in every part carries it, so keep it to what matters` : ''}
    </span>
  );

  return (
    <div style={{ border: `1px solid ${t.border}`, borderRadius: 12, background: t.surface, marginBottom: 32, overflow: 'hidden' }}>
      {editing ? (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '0 10px', borderBottom: `1px solid ${t.border}`, background: t.surface2 }}>
            <button onClick={() => setTab('write')} style={tabStyle(tab === 'write')}>Write</button>
            <button onClick={() => setTab('preview')} style={tabStyle(tab === 'preview')}>Preview</button>
            <span style={{ flex: 1 }} />
            <span style={{ fontSize: '12px', color: t.textMute }}>Markdown: # heading, - list, **bold**</span>
          </div>
          {tab === 'write' ? (
            <textarea value={draft} autoFocus onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 's' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void save(); }
                                  if (e.key === 'Escape') { setEditing(false); setDraft(brief); } }}
              placeholder={'# What this is\nA 5-inch FPV frame for a Raspberry Pi carrier.\n\n# Materials and hardware\n- 2 mm carbon fibre plates\n- M3 bolts, 30.5 mm stack pattern\n\n# Constraints\n- Fits a 120 × 80 mm bed'}
              style={{ display: 'block', width: '100%', minHeight: 260, resize: 'vertical', padding: '14px 16px', border: 'none',
                       outline: 'none', background: t.surface, color: t.text, fontFamily: MONO, fontSize: '13px', lineHeight: 1.6 }} />
          ) : (
            <div style={{ minHeight: 260, padding: '14px 18px' }}>
              {draft.trim() ? md(draft) : <span style={{ color: t.textMute, fontSize: '13px' }}>Nothing to preview yet.</span>}
            </div>
          )}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', borderTop: `1px solid ${t.border}`, background: t.surface2 }}>
            {status}
            <span style={{ flex: 1 }} />
            {error && <span style={{ fontSize: '12px', color: t.danger }}>{error}</span>}
            <button onClick={() => { setEditing(false); setDraft(brief); setError(''); }} style={button()}>Cancel</button>
            <button onClick={() => void save()} disabled={saving || draft === brief} title="Save (⌘S)"
              style={{ ...button(true), opacity: saving || draft === brief ? 0.55 : 1 }}>{saving ? 'Saving…' : 'Save'}</button>
          </div>
        </>
      ) : brief.trim() ? (
        <>
          <div style={{ position: 'relative', padding: '16px 20px 6px', maxHeight: expanded ? 'none' : 220, overflow: 'hidden' }}>
            {md(brief)}
            {!expanded && (
              <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 48,
                            background: `linear-gradient(transparent, ${t.surface})`, pointerEvents: 'none' }} />
            )}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 14px 10px', borderTop: `1px solid ${t.border}` }}>
            {status}
            <span style={{ flex: 1 }} />
            <button onClick={() => setExpanded((x) => !x)} style={button()}>{expanded ? 'Show less' : 'Show all'}</button>
            <button onClick={() => void toggleVersions()} style={button()}>{versions ? 'Hide versions' : 'Versions'}</button>
            <button onClick={() => { setEditing(true); setTab('write'); }} style={button(true)}>Edit</button>
          </div>
        </>
      ) : (
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, padding: '16px 20px' }}>
          <div style={{ flex: 1, fontSize: '13px', color: t.textDim, lineHeight: 1.5 }}>
            No brief yet. Write what this project is, its materials, hardware and constraints: the AI reads it first in every part's chat.
          </div>
          <button onClick={() => { setEditing(true); setTab('write'); }} style={button(true)}>Write a brief</button>
        </div>
      )}
      {versions && !editing && (
        <div style={{ borderTop: `1px solid ${t.border}`, maxHeight: 260, overflowY: 'auto', background: t.surface2 }}>
          {versions.length === 0 && <div style={{ padding: '10px 14px', fontSize: '12.5px', color: t.textMute }}>No saved versions.</div>}
          {versions.map((v, i) => (
            <div key={v.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 14px', borderBottom: `1px solid ${t.border}`, fontSize: '12.5px' }}>
              <span style={{ fontFamily: MONO, color: t.textDim, whiteSpace: 'nowrap' }}>{when(v.created_at)}</span>
              <span style={{ color: t.textMute, whiteSpace: 'nowrap' }}>{v.created_by}</span>
              <span style={{ flex: 1, color: t.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {v.label || `${wordCount(v.text)} words`}{i === 0 ? ' (current)' : ''}
              </span>
              {i > 0 && (
                <button onClick={() => { setDraft(v.text); setEditing(true); setTab('preview'); }}
                  title="Open this version in the editor; Save makes it the brief again" style={button()}>Restore…</button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
