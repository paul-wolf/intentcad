/**
 * The project's parameters on the project page: named values every part's
 * script reads as PP["name"] (a tube diameter, a plate thickness, a bolt
 * pitch), so the parts that share a size keep to it, and the project's
 * sketches use by name in their dimensions. Edited in place: a row saves when
 * you leave it; Add parameter adds a row. After a save the sketches that use
 * a changed value are solved again (here: only the browser can), so their
 * parts can rebuild. Renaming one rewrites the scripts and sketches that use
 * it, once you've seen which. Used by lists them.
 *
 * A number's value has the shared ParamControl (field + slider): moving it
 * only tries a value; the bar above the table says what that would affect,
 * and Apply saves (Reset drops it). ⋯ sets the slider's range, saved at once.
 */
import { useEffect, useState, type CSSProperties } from 'react';
import { projectApi } from '@/api/projectClient';
import { errorText } from '@/api/client';
import { saveProjectParameters, solvedWords } from '@/build/projectSketchSolve';
import type { ParameterUses, ProjectDetail, ProjectParameter } from '@/types/project';
import { useTokens, SANS, MONO } from '@/ui/tokens';
import type { SavedRange } from '@/utils/paramRange';
import { ParamControl, fmt } from './ParamControl';

/** `was`: the name it has in the project, so a changed name is a rename */
type Row = { name: string; value: string; unit: ProjectParameter['unit']; description: string; was?: string } & SavedRange;

const toRow = (p: ProjectParameter): Row => ({ name: p.name, value: String(p.value), unit: p.unit, description: p.description ?? '', was: p.name,
                                              min: p.min ?? null, max: p.max ?? null, step: p.step ?? null });

/** {old: new} for the rows whose name changed to one not otherwise kept */
export const renamesOf = (rows: Row[]): Record<string, string> => {
  const names = new Set(rows.map((r) => r.name.trim()));
  return Object.fromEntries(rows.filter((r) => r.was && r.name.trim() && r.was !== r.name.trim() && !names.has(r.was))
    .map((r) => [r.was!, r.name.trim()]));
};

/** "sketches Frame holes; parts Top plate, Arm" or '' */
export const usesWords = (u: ParameterUses[string] | undefined): string => [
  u?.sketches.length ? `sketches ${[...new Set(u.sketches.map((s) => s.name))].join(', ')}` : '',
  u?.parts.length ? `parts ${u.parts.map((p) => p.name).join(', ')}` : '',
].filter(Boolean).join('; ');

/** A typed value: a number when it reads as one, else the text. */
export const parseValue = (v: string): number | string => (/^\s*-?\d+(\.\d+)?\s*$/.test(v) ? Number(v) : v.trim());

export const toParameters = (rows: Row[]): ProjectParameter[] => rows
  .filter((r) => r.name.trim())
  .map((r) => ({ name: r.name.trim(), value: parseValue(r.value), unit: r.unit,
                 ...(r.description.trim() ? { description: r.description.trim() } : {}),
                 ...(typeof parseValue(r.value) === 'number'
                   ? Object.fromEntries((['min', 'max', 'step'] as const).filter((k) => r[k] != null).map((k) => [k, r[k]]))
                   : {}) }));

/** "It affects 3 parts (Top plate, Bottom plate, Arm brace)" for the parameters being tried. */
export function affectsWords(names: string[], uses: ParameterUses): string {
  const parts = [...new Set(names.flatMap((n) => uses[n]?.parts.map((p) => p.name) ?? []))];
  if (!parts.length) return 'No part uses it yet.';
  return `It affects ${parts.length} part${parts.length === 1 ? '' : 's'} (${parts.join(', ')}).`;
}

export function ProjectParameters({ project, onSaved }: { project: ProjectDetail; onSaved: (p: ProjectDetail) => void }) {
  const t = useTokens();
  const saved = project.parameters ?? [];
  const [rows, setRows] = useState<Row[]>(() => saved.map(toRow));
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState('');
  const [uses, setUses] = useState<ParameterUses>({});
  // renames waiting for a yes, with what they rewrite
  const [confirm, setConfirm] = useState<{ rows: Row[]; renames: Record<string, string>; words: string[] } | null>(null);
  const savedKey = JSON.stringify(saved);
  // values being tried (by saved name): not saved until Apply
  const [trial, setTrial] = useState<Record<string, number>>({});

  // the project changed elsewhere (an accepted AI proposal): show it
  useEffect(() => { setRows(saved.map(toRow)); setTrial({}); }, [savedKey]);   // eslint-disable-line react-hooks/exhaustive-deps
  const loadUses = () => projectApi.parameterUses(project.id).then(setUses).catch(() => {});
  useEffect(() => { void loadUses(); }, [project.id, savedKey]);   // eslint-disable-line react-hooks/exhaustive-deps

  const save = async (next: Row[], confirmed = false) => {
    const params = toParameters(next);
    if (JSON.stringify(params) === JSON.stringify(saved.map((p) => toParameters([toRow(p)])[0]))) return;
    const renames = renamesOf(next);
    if (Object.keys(renames).length && !confirmed) {
      const fresh = await projectApi.parameterUses(project.id).catch(() => uses);
      const words = Object.entries(renames).map(([o, n]) => {
        const w = usesWords(fresh[o]);
        return `${o} → ${n}: ${w ? `rewrites ${w}` : 'nothing uses it yet'}`;
      });
      setNote('');
      setConfirm({ rows: next, renames, words });
      return;
    }
    setSaving(true); setError(''); setNote('');
    try {
      const r = await saveProjectParameters(project.id, params, renames);
      onSaved(r.project);
      const words = solvedWords(r);
      setNote(words ? `Saved, but ${words}` : r.saved.length ? `Saved; solved ${r.saved.join(', ')} again` : '');
      void loadUses();
    } catch (err) { setError(errorText(err)); }
    finally { setSaving(false); }
  };
  const change = (i: number, patch: Partial<Row>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const remove = (i: number) => { const next = rows.filter((_, j) => j !== i); setRows(next); void save(next); };
  const savedNumber = (r: Row): number | null => {
    const p = r.was ? saved.find((q) => q.name === r.was) : undefined;
    return p && typeof p.value === 'number' ? p.value : null;
  };
  const tried = Object.entries(trial).filter(([n, v]) => saved.some((p) => p.name === n && p.value !== v));
  const applyTrial = () => {
    const next = rows.map((r) => (r.was && r.was in trial ? { ...r, value: String(trial[r.was]) } : r));
    setRows(next); setTrial({});
    void save(next);
  };
  const setRange = (i: number, range: SavedRange | null) => {
    const next = rows.map((r, j) => (j === i ? { ...r, min: range?.min ?? null, max: range?.max ?? null, step: range?.step ?? null } : r));
    setRows(next); void save(next);
  };

  const cell: CSSProperties = {
    width: '100%', background: 'transparent', border: '1px solid transparent', borderRadius: 5, color: t.text,
    fontFamily: SANS, fontSize: '13px', padding: '4px 6px', outline: 'none',
  };
  const focus = (e: React.FocusEvent<HTMLInputElement | HTMLSelectElement>) => {
    e.currentTarget.style.borderColor = t.accent; e.currentTarget.dataset.lit = '1';
  };
  const th: CSSProperties = { textAlign: 'left', fontFamily: MONO, fontSize: '10.5px', letterSpacing: '1px', color: t.textMute, fontWeight: 500, padding: '8px 8px 6px' };

  return (
    <div style={{ border: `1px solid ${t.border}`, borderRadius: 12, background: t.surface, marginBottom: 32 }}>
      {tried.length > 0 && (
        <div role="status" aria-label="Values being tried"
             style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', borderBottom: `1px solid ${t.border}`,
                      background: t.accentSoft, fontSize: '12.5px', color: t.text, borderRadius: '12px 12px 0 0' }}>
          <span style={{ flex: 1 }}>
            <span style={{ fontFamily: MONO }}>
              {tried.map(([n, v]) => `${n} ${fmt(saved.find((p) => p.name === n)?.value)} → ${fmt(v)}`).join(', ')}
            </span>
            , not saved. {affectsWords(tried.map(([n]) => n), uses)}
          </span>
          <button onClick={() => setTrial({})}
            style={{ padding: '4px 10px', borderRadius: 6, fontSize: '12px', cursor: 'pointer', background: t.surface,
                     color: t.textDim, border: `1px solid ${t.border2}` }}>Reset</button>
          <button onClick={applyTrial}
            style={{ padding: '4px 10px', borderRadius: 6, fontSize: '12px', fontWeight: 600, cursor: 'pointer',
                     background: t.accent, color: '#fff', border: 'none' }}>Apply</button>
        </div>
      )}
      {rows.length > 0 && (
        <table style={{ width: '100%', borderCollapse: 'collapse' }}
               onBlur={(e) => {
                 // left a row (not just moved between its cells): save
                 const tr = (e.target as HTMLElement).closest('tr');
                 if (!tr || !tr.contains(e.relatedTarget as Node | null)) void save(rows);
                 const el = e.target as HTMLElement;
                 if (el.dataset.lit) { el.style.borderColor = 'transparent'; delete el.dataset.lit; }
               }}>
          <thead>
            <tr style={{ borderBottom: `1px solid ${t.border}`, background: t.surface2 }}>
              <th style={{ ...th, width: '24%' }}>NAME</th>
              <th style={{ ...th, width: '20%' }}>VALUE</th>
              <th style={{ ...th, width: '10%' }}>UNIT</th>
              <th style={th}>DESCRIPTION</th>
              <th style={{ ...th, width: '20%' }}>USED BY</th>
              <th style={{ width: 32 }} />
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} style={{ borderBottom: `1px solid ${t.border}` }}>
                <td style={{ padding: '2px 4px' }}>
                  <input aria-label="Name" style={{ ...cell, fontFamily: MONO }} value={r.name} placeholder="arm_od" onFocus={focus}
                         onChange={(e) => change(i, { name: e.target.value })} title={`Scripts read it as PP["${r.name || 'name'}"]`} />
                </td>
                <td style={{ padding: '4px 6px' }}>
                  {(() => {
                    const sv = savedNumber(r);
                    // a saved number gets the slider; a new row or a text value is typed
                    if (sv == null || typeof parseValue(r.value) !== 'number') {
                      return <input aria-label="Value" style={{ ...cell, fontFamily: MONO }} value={r.value} placeholder="30" onFocus={focus}
                                    onChange={(e) => change(i, { value: e.target.value })} />;
                    }
                    return (
                      <ParamControl value={trial[r.was!] ?? sv} saved={sv} unit={r.unit} range={r}
                        onChange={(v) => setTrial((tr) => {
                          const { [r.was!]: _drop, ...rest } = tr;
                          return v === sv ? rest : { ...tr, [r.was!]: v };
                        })}
                        onRange={(range) => setRange(i, range)} />
                    );
                  })()}
                </td>
                <td style={{ padding: '2px 4px' }}>
                  <select aria-label="Unit" style={cell} value={r.unit} onFocus={focus}
                          onChange={(e) => change(i, { unit: e.target.value as Row['unit'] })}>
                    <option value="mm">mm</option>
                    <option value="deg">deg</option>
                    <option value="">—</option>
                  </select>
                </td>
                <td style={{ padding: '2px 4px' }}>
                  <input aria-label="Description" style={cell} value={r.description} placeholder="what it is for" onFocus={focus}
                         onChange={(e) => change(i, { description: e.target.value })} />
                </td>
                <td style={{ padding: '2px 8px', fontSize: '12px', color: t.textDim }}>
                  <UsedBy u={uses[r.was ?? r.name.trim()]} />
                </td>
                <td style={{ padding: '2px 4px', textAlign: 'center' }}>
                  <button title="Delete the parameter (parts that read it then fail to build)" onClick={() => remove(i)}
                    style={{ background: 'none', border: 'none', color: t.textMute, cursor: 'pointer', fontSize: '15px' }}>×</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {confirm && (
        <div role="dialog" aria-label="Rename parameters"
             style={{ padding: '10px 12px', borderBottom: `1px solid ${t.border}`, fontSize: '12.5px', color: t.text }}>
          Rename everywhere in the project? Scripts' PP["…"] and sketch dimensions are rewritten (each script's old
          text goes into its history).
          <ul style={{ margin: '6px 0', paddingLeft: 18 }}>{confirm.words.map((w) => <li key={w}>{w}</li>)}</ul>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={() => { const c = confirm; setConfirm(null); void save(c.rows, true); }}
              style={{ padding: '5px 12px', borderRadius: 8, fontSize: '12.5px', fontWeight: 600, cursor: 'pointer',
                       background: t.accent, color: '#fff', border: 'none' }}>
              Rename
            </button>
            <button onClick={() => { setConfirm(null); setRows(saved.map(toRow)); }}
              style={{ padding: '5px 12px', borderRadius: 8, fontSize: '12.5px', cursor: 'pointer',
                       background: t.surface, color: t.textDim, border: `1px solid ${t.border2}` }}>
              Cancel
            </button>
          </div>
        </div>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '9px 12px' }}>
        <button onClick={() => setRows((rs) => [...rs, { name: '', value: '', unit: 'mm', description: '' }])}
          style={{ padding: '6px 12px', borderRadius: 8, fontFamily: SANS, fontSize: '12.5px', fontWeight: 600, cursor: 'pointer',
                   background: t.surface, color: t.textDim, border: `1px solid ${t.border2}` }}>
          Add parameter
        </button>
        <span style={{ fontSize: '12.5px', color: error ? t.danger : t.textMute }}>
          {error || (saving ? 'Saving…' : note || (rows.length
            ? 'Parts read these as PP["name"] and sketches use them by name in dimensions; a change marks the parts that use it out of date.'
            : 'Sizes the parts share (a tube diameter, a plate thickness): scripts read them as PP["name"].'))}
        </span>
      </div>
    </div>
  );
}

/** The sketches and parts that use a parameter; a sketch that can't be
 *  solved with its value (or hasn't been yet) is marked, with why. */
function UsedBy({ u }: { u: ParameterUses[string] | undefined }) {
  const t = useTokens();
  if (!u || (!u.sketches.length && !u.parts.length)) return <span style={{ color: t.textMute }}>—</span>;
  const bad = u.sketches.filter((s) => s.state === 'failed');
  return (
    <div>
      {u.sketches.map((s) => (
        <span key={`${s.id}:${s.sketch}`} title={s.message || `Sketch ${s.name} uses it in a dimension`}
              style={{ marginRight: 8, color: s.state === 'failed' ? t.danger : t.textDim, whiteSpace: 'nowrap' }}>
          {s.state === 'failed' ? '⚠ ' : ''}✎ {s.name}{s.state === 'pending' ? ' (not solved yet)' : ''}
        </span>
      ))}
      {u.parts.map((p) => (
        <span key={p.id} title={`Part ${p.name}: through ${p.via.map((v) => (v === 'script' ? 'its script' : `sketch ${v}`)).join(', ')}`}
              style={{ marginRight: 8, whiteSpace: 'nowrap' }}>
          ◼ {p.name}
        </span>
      ))}
      {bad.map((s) => (
        <div key={`e:${s.id}:${s.sketch}`} style={{ color: t.danger, fontSize: '11.5px' }}>{s.message}</div>
      ))}
    </div>
  );
}
