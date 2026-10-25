/**
 * The project's parameters on the project page: named values every part's
 * script reads as PP["name"] (a tube diameter, a plate thickness, a bolt
 * pitch), so the parts that share a size keep to it. Edited in place: a row
 * saves when you leave it; Add parameter adds a row.
 */
import { useEffect, useState, type CSSProperties } from 'react';
import { projectApi } from '@/api/projectClient';
import { errorText } from '@/api/client';
import type { ProjectDetail, ProjectParameter } from '@/types/project';
import { useTokens, SANS, MONO } from '@/ui/tokens';

type Row = { name: string; value: string; unit: ProjectParameter['unit']; description: string };

const toRow = (p: ProjectParameter): Row => ({ name: p.name, value: String(p.value), unit: p.unit, description: p.description ?? '' });

/** A typed value: a number when it reads as one, else the text. */
export const parseValue = (v: string): number | string => (/^\s*-?\d+(\.\d+)?\s*$/.test(v) ? Number(v) : v.trim());

export const toParameters = (rows: Row[]): ProjectParameter[] => rows
  .filter((r) => r.name.trim())
  .map((r) => ({ name: r.name.trim(), value: parseValue(r.value), unit: r.unit,
                 ...(r.description.trim() ? { description: r.description.trim() } : {}) }));

export function ProjectParameters({ project, onSaved }: { project: ProjectDetail; onSaved: (p: ProjectDetail) => void }) {
  const t = useTokens();
  const saved = project.parameters ?? [];
  const [rows, setRows] = useState<Row[]>(() => saved.map(toRow));
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const savedKey = JSON.stringify(saved);

  // the project changed elsewhere (an accepted AI proposal): show it
  useEffect(() => { setRows(saved.map(toRow)); }, [savedKey]);   // eslint-disable-line react-hooks/exhaustive-deps

  const save = async (next: Row[]) => {
    const params = toParameters(next);
    if (JSON.stringify(params) === JSON.stringify(saved.map((p) => toParameters([toRow(p)])[0]))) return;
    setSaving(true); setError('');
    try { onSaved(await projectApi.setParameters(project.id, params)); }
    catch (err) { setError(errorText(err)); }
    finally { setSaving(false); }
  };
  const change = (i: number, patch: Partial<Row>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const remove = (i: number) => { const next = rows.filter((_, j) => j !== i); setRows(next); void save(next); };

  const cell: CSSProperties = {
    width: '100%', background: 'transparent', border: '1px solid transparent', borderRadius: 5, color: t.text,
    fontFamily: SANS, fontSize: '13px', padding: '4px 6px', outline: 'none',
  };
  const focus = (e: React.FocusEvent<HTMLInputElement | HTMLSelectElement>) => { e.currentTarget.style.borderColor = t.accent; };
  const th: CSSProperties = { textAlign: 'left', fontFamily: MONO, fontSize: '10.5px', letterSpacing: '1px', color: t.textMute, fontWeight: 500, padding: '8px 8px 6px' };

  return (
    <div style={{ border: `1px solid ${t.border}`, borderRadius: 12, background: t.surface, marginBottom: 32, overflow: 'hidden' }}>
      {rows.length > 0 && (
        <table style={{ width: '100%', borderCollapse: 'collapse' }}
               onBlur={(e) => {
                 // left a row (not just moved between its cells): save
                 const tr = (e.target as HTMLElement).closest('tr');
                 if (!tr || !tr.contains(e.relatedTarget as Node | null)) void save(rows);
                 (e.target as HTMLElement).style.borderColor = 'transparent';
               }}>
          <thead>
            <tr style={{ borderBottom: `1px solid ${t.border}`, background: t.surface2 }}>
              <th style={{ ...th, width: '24%' }}>NAME</th>
              <th style={{ ...th, width: '14%' }}>VALUE</th>
              <th style={{ ...th, width: '10%' }}>UNIT</th>
              <th style={th}>DESCRIPTION</th>
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
                <td style={{ padding: '2px 4px' }}>
                  <input aria-label="Value" style={{ ...cell, fontFamily: MONO }} value={r.value} placeholder="30" onFocus={focus}
                         onChange={(e) => change(i, { value: e.target.value })} />
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
                <td style={{ padding: '2px 4px', textAlign: 'center' }}>
                  <button title="Delete the parameter (parts that read it then fail to build)" onClick={() => remove(i)}
                    style={{ background: 'none', border: 'none', color: t.textMute, cursor: 'pointer', fontSize: '15px' }}>×</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '9px 12px' }}>
        <button onClick={() => setRows((rs) => [...rs, { name: '', value: '', unit: 'mm', description: '' }])}
          style={{ padding: '6px 12px', borderRadius: 8, fontFamily: SANS, fontSize: '12.5px', fontWeight: 600, cursor: 'pointer',
                   background: t.surface, color: t.textDim, border: `1px solid ${t.border2}` }}>
          Add parameter
        </button>
        <span style={{ fontSize: '12.5px', color: error ? t.danger : t.textMute }}>
          {error || (saving ? 'Saving…' : rows.length
            ? 'Every part reads these as PP["name"]; a change marks the parts that use it out of date.'
            : 'Sizes the parts share (a tube diameter, a plate thickness): scripts read them as PP["name"].')}
        </span>
      </div>
    </div>
  );
}
