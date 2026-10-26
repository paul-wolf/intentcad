/**
 * Use project sketch… (part editor): the sketch documents of the part's
 * project whose sketches the script reads as SK["alias"]. Lists the aliases
 * the part has, and adds one: pick a sketch document and one of its sketches,
 * and name it. The script then reads it as SK["alias"] (its closed shapes, its
 * .group("…") and .named("…") elements, .circles, .points), and the part goes
 * out of date whenever that sketch changes. A generated sketch shows a
 * picture of itself, its outputs (what each is, and how the script asks for
 * it) and whether its checks pass.
 */
import { useEffect, useState } from 'react';
import { api, errorText, type DocumentListItem } from '@/api/client';
import { useThemeStore } from '@/theme';
import type { Sketch, SketchRef } from '@/types/document';
import { skAliases } from '@/build/sharedSketch';
import { checksWords } from '@/build/generatedSketch';
import type { GenRecord } from '@/types/generated';
import { SketchDrawing } from './generated/SketchDrawing';

interface SketchChoice {
  id: string; name: string; usable: boolean; groups: string[];
  /** a generated sketch: its last run, and its drawing for the picture */
  gen?: GenRecord; entities?: Sketch['entities'];
}

import { aliasFor } from '@/build/sketchToPart';

export { aliasFor };
const ALIAS = /^[A-Za-z_][A-Za-z0-9_ -]{0,40}$/;

export function ProjectSketchDialog({ projectId, refs, code, onSave, onClose }: {
  projectId: string | null;
  refs: Record<string, SketchRef>;
  code: string;
  onSave: (refs: Record<string, SketchRef>) => void;
  onClose: () => void;
}) {
  const palette = useThemeStore((s) => s.palette);
  const [docs, setDocs] = useState<DocumentListItem[] | null>(null);
  const [error, setError] = useState('');
  const [docId, setDocId] = useState('');
  const [sketches, setSketches] = useState<SketchChoice[]>([]);
  const [sketchId, setSketchId] = useState('');
  const [alias, setAlias] = useState('');
  const [names, setNames] = useState<Record<string, string>>({});   // "doc/sketch" → what to call it
  const inScript = new Set(skAliases(code));

  useEffect(() => {
    if (!projectId) { setDocs([]); return; }
    api.listDocuments(projectId)
      .then((all) => setDocs(all.filter((d) => d.kind === 'sketch')))
      .catch((e) => setError(errorText(e)));
  }, [projectId]);

  // the names of the sketches the part already uses, for its list
  useEffect(() => {
    const ids = [...new Set(Object.values(refs).map((r) => r.document))];
    let live = true;
    Promise.all(ids.map((id) => api.getDocument(id).then((d) => [id, d] as const).catch(() => [id, null] as const)))
      .then((got) => {
        if (!live) return;
        const out: Record<string, string> = {};
        for (const [id, d] of got) {
          const list = (d?.data.sketches as { id: string; name: string }[] | undefined) ?? [];
          for (const [, r] of Object.entries(refs)) {
            if (r.document !== id) continue;
            const s = list.find((k) => k.id === r.sketch);
            out[`${r.document}/${r.sketch}`] = d ? (s ? `${d.name} · ${s.name}` : `${d.name} · (sketch deleted)`) : '(document deleted)';
          }
        }
        setNames(out);
      });
    return () => { live = false; };
  }, [refs]);

  const pickDoc = (id: string) => {
    setDocId(id);
    setSketches([]);
    setSketchId('');
    if (!id) return;
    api.getDocument(id).then((d) => {
      const list = ((d.data.sketches as (Sketch & { generated?: GenRecord })[]) ?? [])
        .map((s) => ({ id: s.id, name: s.name, usable: !!(s.profile && 'items' in s.profile),
                       groups: (s.groups ?? []).map((g) => g.name),
                       ...(s.generated ? { gen: s.generated, entities: s.entities } : {}) }));
      setSketches(list);
      const first = list[0];
      if (first) { setSketchId(first.id); setAlias(aliasFor(list.length === 1 ? d.name : first.name)); }
    }).catch((e) => setError(errorText(e)));
  };
  const pickSketch = (id: string) => {
    setSketchId(id);
    const s = sketches.find((k) => k.id === id);
    if (s) setAlias(aliasFor(s.name));
  };

  const chosen = sketches.find((s) => s.id === sketchId);
  const aliasOk = ALIAS.test(alias.trim());
  const add = () => {
    if (!docId || !chosen || !aliasOk) return;
    onSave({ ...refs, [alias.trim()]: { document: docId, sketch: chosen.id } });
    setDocId(''); setSketches([]); setSketchId(''); setAlias('');
  };
  const remove = (a: string) => {
    const next = { ...refs };
    delete next[a];
    onSave(next);
  };

  const field: React.CSSProperties = {
    background: palette.inputBg, border: `1px solid ${palette.inputBorder}`, borderRadius: 4,
    color: palette.text, fontSize: '13px', padding: '5px 7px',
  };
  const mono = 'ui-monospace, SFMono-Regular, Menlo, monospace';
  const entries = Object.entries(refs);

  return (
    <div onClick={onClose}
      style={{ position: 'fixed', inset: 0, zIndex: 200, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Use project sketch"
        style={{ width: 'min(560px, 94vw)', maxHeight: '86vh', overflowY: 'auto', background: palette.panelBg,
                 border: `1px solid ${palette.border}`, borderRadius: 8, boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
                 padding: '16px 18px', color: palette.text, fontSize: '13px' }}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 10 }}>
          <span style={{ fontSize: '15px', fontWeight: 600 }}>Project sketches</span>
          <div style={{ flex: 1 }} />
          <button onClick={onClose} style={{ ...field, cursor: 'pointer', background: 'none' }}>Close</button>
        </div>
        <div style={{ color: palette.textSecondary, marginBottom: 12, lineHeight: 1.45 }}>
          A sketch from a sketch document in this project, for the script to build from as{' '}
          <code style={{ fontFamily: mono }}>SK["name"]</code>. When the sketch changes, this part is marked out of date.
        </div>

        {entries.length > 0 && (
          <div style={{ marginBottom: 14 }}>
            {entries.map(([a, r]) => (
              <div key={a} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 0', borderBottom: `1px solid ${palette.border}` }}>
                <code style={{ fontFamily: mono }}>SK["{a}"]</code>
                <span style={{ flex: 1, color: palette.textSecondary }}>{names[`${r.document}/${r.sketch}`] ?? '…'}</span>
                {!inScript.has(a) && <span style={{ fontSize: '11px', color: palette.textMuted }} title="The script doesn't read it yet">not in the script</span>}
                <button onClick={() => remove(a)} title="Stop using it (the script then can't read it)"
                  style={{ background: 'none', border: 'none', color: palette.textSecondary, cursor: 'pointer', fontSize: '15px' }}>×</button>
              </div>
            ))}
          </div>
        )}

        {error && <div style={{ color: palette.danger, marginBottom: 8 }}>{error}</div>}
        {!projectId ? (
          <div style={{ color: palette.textSecondary }}>This part isn't in a project: move it into one to use the project's sketches.</div>
        ) : docs === null ? (
          <div style={{ color: palette.textSecondary }}>Loading…</div>
        ) : docs.length === 0 ? (
          <div style={{ color: palette.textSecondary }}>The project has no sketch documents yet: add one with New sketch on the project page.</div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '8px 10px', alignItems: 'center' }}>
            <label htmlFor="psd-doc">Sketch document</label>
            <select id="psd-doc" style={field} value={docId} onChange={(e) => pickDoc(e.target.value)}>
              <option value="">Choose…</option>
              {docs.map((d) => <option key={d.id} value={d.id}>{d.name}{d.source === 'generated' ? ' (generated)' : ''}</option>)}
            </select>
            {sketches.length > 1 && <>
              <label htmlFor="psd-sketch">Sketch</label>
              <select id="psd-sketch" style={field} value={sketchId} onChange={(e) => pickSketch(e.target.value)}>
                {sketches.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </>}
            {chosen && <>
              <label htmlFor="psd-alias">Name in the script</label>
              <input id="psd-alias" style={{ ...field, fontFamily: mono }} value={alias}
                     onChange={(e) => setAlias(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') add(); }} />
              <span />
              <span style={{ fontSize: '12px', color: chosen.usable && aliasOk ? palette.textSecondary : palette.warning }}>
                {!chosen.usable ? 'Open this sketch document once in the sketch editor, so it saves its shapes for parts.'
                  : !aliasOk ? 'A short name of letters, digits and _, starting with a letter.'
                  : <>The script reads it as <code style={{ fontFamily: mono }}>SK["{alias.trim()}"]</code>
                    {chosen.groups.length ? <>; its {chosen.gen ? 'outputs' : 'groups'} as <code style={{ fontFamily: mono }}>.group("{chosen.groups[0]}")</code></> : null}
                    {refs[alias.trim()] ? ' (replaces the one of that name)' : ''}.</>}
              </span>
            </>}
            {chosen?.gen && <>
              <span />
              <GeneratedSummary gen={chosen.gen} entities={chosen.entities ?? []} alias={alias.trim() || 'name'} mono={mono} />
            </>}
            <span />
            <div>
              <button onClick={add} disabled={!chosen || !aliasOk}
                style={{ padding: '6px 14px', fontWeight: 600, borderRadius: 6, border: 'none', background: palette.accent,
                         color: '#fff', cursor: chosen && aliasOk ? 'pointer' : 'default', opacity: chosen && aliasOk ? 1 : 0.5 }}>
                Use it
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** A generated sketch in the picker: its picture, its outputs and how the
 *  script asks for each, and its checks. */
function GeneratedSummary({ gen, entities, alias, mono }: {
  gen: GenRecord; entities: Sketch['entities']; alias: string; mono: string;
}) {
  const palette = useThemeStore((s) => s.palette);
  const failing = gen.checks.filter((c) => !c.ok);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', gap: 10 }}>
        <div style={{ width: 120, height: 96, flexShrink: 0, display: 'flex', border: `1px solid ${palette.border}`,
                      borderRadius: 6, overflow: 'hidden', background: palette.background }}>
          <SketchDrawing entities={entities} notes={null} outputs={gen.outputs} users={[]} lit={new Set()} interactive={false} />
        </div>
        <div style={{ flex: 1, minWidth: 0, fontSize: '12px', lineHeight: 1.45 }}>
          <div style={{ color: palette.textSecondary, marginBottom: 2 }}>A generated sketch: it is drawn from the project parameters.</div>
          {gen.checks.length > 0 && (
            <div style={{ color: failing.length ? palette.warning : palette.textSecondary }}>
              {failing.length ? `⚠ ${failing.length} check${failing.length === 1 ? ' fails' : 's fail'}: ${failing.map((c) => c.name).join(', ')}`
                : `Checks: ${checksWords(gen.checks)}`}
            </div>
          )}
          {gen.error && <div style={{ color: palette.danger }}>Its code stopped: parts get its last good drawing.</div>}
        </div>
      </div>
      <table style={{ borderCollapse: 'collapse', fontSize: '12px' }}>
        <tbody>
          {gen.outputs.map((o) => (
            <tr key={o.name} style={{ borderTop: `1px solid ${palette.border}` }}>
              <td style={{ padding: '3px 8px 3px 0', fontFamily: mono }}>{o.name}</td>
              <td style={{ padding: '3px 8px 3px 0', color: palette.textSecondary }}>{o.description || o.size}{o.description ? ` (${o.size})` : ''}</td>
              <td style={{ padding: '3px 0', fontFamily: mono, fontSize: '11px', color: palette.textMuted, whiteSpace: 'nowrap' }}>
                SK["{alias}"].group("{o.name}")
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
