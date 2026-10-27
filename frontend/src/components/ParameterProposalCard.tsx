/**
 * Under an AI reply in any chat (part, drawn or generated sketch): the project
 * parameters it proposed with set_project_parameter, all on one card, each
 * marked new, changed (the old value struck through) or unchanged, and read by
 * scripts as PP["name"]. Accept writes them to the project's
 * Parameters table (and solves the project sketches that use them again,
 * saying which can't be); Reject leaves the project as it was.
 */
import { useEffect, useState } from 'react';
import { projectApi } from '@/api/projectClient';
import { saveProjectParameters, solvedWords } from '@/build/projectSketchSolve';
import { previewParameters, previewWords, type PreviewStatus } from '@/utils/pasteParameters';
import type { ThemePalette } from '@/theme';
import { clearCardAction, useCardAction } from './cardAction';
import type { ChatMessage } from '@/types/document';
import type { ProjectParameter } from '@/types/project';

export type ParamProposal = NonNullable<ChatMessage['params']>;

/** The project's parameters with the proposed ones added or changed (by name);
 *  a value that becomes text loses its slider range. */
export function mergeParameters(now: ProjectParameter[], proposed: ProjectParameter[]): ProjectParameter[] {
  const out = [...now];
  for (const p of proposed) {
    const clean: ProjectParameter = { name: p.name, value: p.value, unit: p.unit, ...(p.description ? { description: p.description } : {}) };
    const i = out.findIndex((x) => x.name === p.name);
    if (i >= 0) {
      const { min, max, step, ...kept } = out[i]!;
      out[i] = { ...(typeof p.value === 'number' ? out[i] : kept), ...clean, description: p.description || out[i]!.description };
      if (!out[i]!.description) delete out[i]!.description;
    } else out.push(clean);
  }
  return out;
}

/** Accept: add the proposed parameters to the project's as they are now (read
 *  first, so a retry after a refused save merges into the newer ones), solve
 *  its sketches, then `done`. What solving said, if anything went wrong there. */
export async function acceptParameters(projectId: string | null, items: ProjectParameter[], done: () => void,
                                       save = saveProjectParameters, read = projectApi.getProject): Promise<string> {
  if (!projectId) throw new Error("This isn't in a project yet, so there's no Parameters table to add them to.");
  const now = (await read(projectId)).parameters ?? [];
  const r = await save(projectId, mergeParameters(now, items));
  done();
  const words = solvedWords(r);
  return words ? `Saved, but ${words}` : '';
}

export function ParameterProposalCard({ params, projectId, palette, actionKey, onStatus, onAccepted }: {
  params: ParamProposal; projectId: string | null; palette: ThemePalette;
  /** where its save is kept while it runs (see cardAction) */
  actionKey: string;
  onStatus: (status: 'accepted' | 'rejected') => void;
  /** after the project has them: rebuild with them */
  onAccepted: () => void;
}) {
  const { busy, error, note, run } = useCardAction(actionKey);
  // the values now, to show what a proposal changes (read again after a failed try)
  const [current, setCurrent] = useState<Record<string, ProjectParameter> | null>(null);
  const pending = params.status === 'pending';
  useEffect(() => {
    if (!projectId || !pending) return;
    let live = true;
    projectApi.getProject(projectId)
      .then((p) => { if (live) setCurrent(Object.fromEntries((p.parameters ?? []).map((x) => [x.name, x]))); })
      .catch(() => {});
    return () => { live = false; };
  }, [projectId, pending, error]);
  const accept = () => void run(() => acceptParameters(projectId, params.items, () => { onStatus('accepted'); onAccepted(); }));
  const reject = () => { clearCardAction(actionKey); onStatus('rejected'); };
  const preview = current && pending ? previewParameters(Object.values(current), params.items) : null;
  const tagColor: Record<PreviewStatus, string> = { new: '#1f9d55', changed: palette.accent, unchanged: palette.textMuted };
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
      {params.items.map((p, i) => {
        const was = current?.[p.name];
        const status = preview?.[i]?.status;
        return (
          <div key={p.name} style={{ padding: '5px 10px', color: palette.text }}>
            {status && (
              <span style={{ float: 'right', marginLeft: 6, fontSize: '11px', fontWeight: 600, color: tagColor[status] }}>{status}</span>
            )}
            <code style={{ fontFamily: mono }}>PP["{p.name}"]</code>{' = '}
            {was && status === 'changed' && (
              <span style={{ textDecoration: 'line-through', color: palette.textMuted, marginRight: 4 }}>{String(was.value)}{was.unit && ` ${was.unit}`}</span>
            )}
            <b>{String(p.value)}{p.unit && ` ${p.unit}`}</b>
            {p.description && <span style={{ color: palette.textSecondary }}> · {p.description}</span>}
            {p.reason && <div style={{ color: palette.textMuted, fontSize: '12px' }}>{p.reason}</div>}
          </div>
        );
      })}
      {params.status !== 'pending' && note && (
        <div role="alert" style={{ padding: '6px 10px', borderTop: `1px solid ${palette.border}`, color: palette.danger }}>{note}</div>
      )}
      {params.status === 'pending' && (
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, padding: '6px 10px', borderTop: `1px solid ${palette.border}` }}>
          <span role={error ? 'alert' : undefined} style={{ flex: '1 1 200px', color: error ? palette.danger : palette.textMuted }}>
            {error || `${preview && params.items.length > 1 ? `${previewWords(preview)}. ` : ''}Every part that reads it uses the project value. Nothing changes unless you accept.`}
          </span>
          <button onClick={reject} disabled={busy}
            style={{ ...btn, background: 'none', color: palette.textSecondary, border: `1px solid ${palette.border}` }}>
            Reject
          </button>
          <button onClick={accept} disabled={busy}
            style={{ ...btn, background: palette.accent, color: '#fff', border: 'none', fontWeight: 600, opacity: busy ? 0.6 : 1 }}>
            {busy ? 'Saving…' : error ? 'Try again' : 'Accept'}
          </button>
        </div>
      )}
    </div>
  );
}
