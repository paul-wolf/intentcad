/**
 * Under an AI reply in the part chat: the project parameters it proposed with
 * set_project_parameter (new ones, or new values for existing ones), each
 * read by scripts as PP["name"]. Accept writes them to the project's
 * Parameters table (and solves the project sketches that use them again,
 * saying which can't be); Reject leaves the project as it was.
 */
import { useEffect, useState } from 'react';
import { errorText } from '@/api/client';
import { projectApi } from '@/api/projectClient';
import { saveProjectParameters, solvedWords } from '@/build/projectSketchSolve';
import type { ThemePalette } from '@/theme';
import type { ChatMessage } from '@/types/document';
import type { ProjectParameter } from '@/types/project';

export type ParamProposal = NonNullable<ChatMessage['params']>;

/** The project's parameters with the proposed ones added or changed (by name). */
export function mergeParameters(now: ProjectParameter[], proposed: ProjectParameter[]): ProjectParameter[] {
  const out = [...now];
  for (const p of proposed) {
    const clean: ProjectParameter = { name: p.name, value: p.value, unit: p.unit, ...(p.description ? { description: p.description } : {}) };
    const i = out.findIndex((x) => x.name === p.name);
    if (i >= 0) out[i] = { ...out[i], ...clean, description: p.description || out[i]!.description };
    else out.push(clean);
  }
  return out;
}

export function ParameterProposalCard({ params, projectId, palette, onStatus, onAccepted }: {
  params: ParamProposal; projectId: string | null; palette: ThemePalette;
  onStatus: (status: 'accepted' | 'rejected') => void;
  /** after the project has them: rebuild with them */
  onAccepted: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // the values now, to show what a proposal changes
  const [current, setCurrent] = useState<Record<string, ProjectParameter> | null>(null);
  const pending = params.status === 'pending';
  useEffect(() => {
    if (!projectId || !pending) return;
    let live = true;
    projectApi.getProject(projectId)
      .then((p) => { if (live) setCurrent(Object.fromEntries((p.parameters ?? []).map((x) => [x.name, x]))); })
      .catch(() => {});
    return () => { live = false; };
  }, [projectId, pending]);
  const accept = async () => {
    if (!projectId) return;
    setBusy(true); setError('');
    try {
      const now = (await projectApi.getProject(projectId)).parameters ?? [];
      const r = await saveProjectParameters(projectId, mergeParameters(now, params.items));
      const words = solvedWords(r);
      if (words) setError(`Saved, but ${words}`);
      onStatus('accepted');
      onAccepted();
    } catch (err) { setError(errorText(err)); }
    finally { setBusy(false); }
  };
  const green = '#1f9d55';
  const mono = 'ui-monospace, Menlo, monospace';
  const btn: React.CSSProperties = {
    padding: '4px 12px', borderRadius: 4, cursor: 'pointer', fontSize: '12px',
  };
  return (
    <div style={{ marginTop: 6, border: `1px solid ${palette.border}`, borderRadius: 8, background: palette.background, fontSize: '12.5px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', borderBottom: `1px solid ${palette.border}` }}>
        <span style={{ fontWeight: 600, color: palette.text }}>
          Proposed project parameter{params.items.length === 1 ? '' : 's'}
        </span>
        <span style={{ flex: 1 }} />
        {params.status !== 'pending' && (
          <span style={{ color: params.status === 'accepted' ? green : palette.textMuted, fontWeight: 600 }}>
            {params.status === 'accepted' ? '✓ accepted' : 'rejected'}
          </span>
        )}
      </div>
      {params.items.map((p) => {
        const was = current?.[p.name];
        return (
          <div key={p.name} style={{ padding: '5px 10px', color: palette.text }}>
            <code style={{ fontFamily: mono }}>PP["{p.name}"]</code>{' = '}
            {was && params.status === 'pending' && (
              <span style={{ textDecoration: 'line-through', color: palette.textMuted, marginRight: 4 }}>{String(was.value)}{was.unit && ` ${was.unit}`}</span>
            )}
            <b>{String(p.value)}{p.unit && ` ${p.unit}`}</b>
            {p.description && <span style={{ color: palette.textSecondary }}> · {p.description}</span>}
            {p.reason && <div style={{ color: palette.textMuted, fontSize: '12px' }}>{p.reason}</div>}
          </div>
        );
      })}
      {params.status !== 'pending' && error && (
        <div role="alert" style={{ padding: '6px 10px', borderTop: `1px solid ${palette.border}`, color: palette.danger }}>{error}</div>
      )}
      {params.status === 'pending' && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', borderTop: `1px solid ${palette.border}` }}>
          <span style={{ flex: 1, color: error ? palette.danger : palette.textMuted }}>
            {error || 'Every part that reads it uses the project value. Nothing changes unless you accept.'}
          </span>
          <button onClick={() => onStatus('rejected')} disabled={busy}
            style={{ ...btn, background: 'none', color: palette.textSecondary, border: `1px solid ${palette.border}` }}>
            Reject
          </button>
          <button onClick={() => void accept()} disabled={busy || !projectId}
            style={{ ...btn, background: palette.accent, color: '#fff', border: 'none', fontWeight: 600 }}>
            {busy ? 'Saving…' : 'Accept'}
          </button>
        </div>
      )}
    </div>
  );
}
