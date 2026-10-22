import { useState } from 'react';
import { jobEntities, useCamStore, type CamIssueWithOp } from '@/stores/camStore';
import type { ResolvedOp } from '@/cam/resolve';
import { toolTag } from '@/cam/resolve';
import type { PlanKind } from '@/cam/setup';
import { formatDuration } from '@/cam/estimate';
import { Btn, Chip, Pill, panelStyle, useTokens, MONO } from './ui';
import { SetupSummaryStrip } from './CamSetupStep';
import { AiThread, Composer } from './AiThread';
import { CamOperationEditor } from './CamOperationEditor';
import { opSummary, opTitle, shapesText } from './opText';

const KINDS: { kind: PlanKind; label: string; hint: string }[] = [
  { kind: 'profile', label: 'Profile', hint: 'cut along or round shapes' },
  { kind: 'pocket', label: 'Pocket', hint: 'clear the inside of a closed shape' },
  { kind: 'drill', label: 'Holes', hint: 'drill or helix circles' },
  { kind: 'facing', label: 'Facing', hint: 'flatten the stock top' },
];

/** Step 2: the operations, proposed and accepted, with the AI alongside. */
export function CamPlanStep() {
  const t = useTokens();
  const openedOpId = useCamStore((s) => s.openedOpId);
  const resolved = useCamStore((s) => s.resolved);
  const issues = useCamStore((s) => s.issues);
  const estimated = useCamStore((s) => s.estimatedSeconds);
  const focusedOpId = useCamStore((s) => s.focusedOpId);
  const acceptAll = useCamStore((s) => s.acceptAll);
  const autoOrder = useCamStore((s) => s.autoOrder);
  const addOperation = useCamStore((s) => s.addOperation);
  const sendChat = useCamStore((s) => s.sendChat);
  const aiBusy = useCamStore((s) => s.aiBusy);
  const setStep = useCamStore((s) => s.setStep);
  const [adding, setAdding] = useState(false);

  if (openedOpId && resolved.ops.some((r) => r.op.id === openedOpId)) return <CamOperationEditor opId={openedOpId} />;

  const ops = resolved.ops;
  const proposed = ops.filter((r) => r.op.status === 'proposed').length;
  const blocking = issues.some((i) => i.severity === 'error');

  return (
    <div style={panelStyle(t)}>
      <SetupSummaryStrip />
      <div style={{ flex: 1, overflowY: 'auto', padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <AiThread />

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
          <div style={{ flex: 1, fontSize: 13, fontWeight: 600 }}>
            Plan
            <span style={{ fontWeight: 400, color: t.textDim }}>
              {' '}· {ops.length} operation{ops.length === 1 ? '' : 's'} · {resolved.toolChanges} tool change{resolved.toolChanges === 1 ? '' : 's'}
              {estimated > 0 ? ` · ~${formatDuration(estimated)}` : ''}
            </span>
          </div>
          {ops.length > 1 && <Btn kind="ghost" small onClick={autoOrder} title="Inside cuts first, then by tool, and the cut that frees the part last">Order</Btn>}
          {proposed > 0 && <Btn kind="primary" small onClick={acceptAll}>Accept all ({proposed})</Btn>}
        </div>

        {ops.length === 0 && (
          <div style={{ border: `1px dashed ${t.border2}`, borderRadius: 10, padding: 16, fontSize: 12.5, color: t.textDim, textAlign: 'center', lineHeight: 1.6 }}>
            No operations yet. Let the AI plan the job, or add one and click its shapes on the sketch.
            <div style={{ marginTop: 10 }}>
              <Btn kind="ai" disabled={aiBusy} onClick={() => sendChat('Plan this job: propose the operations to cut the part, in order.')}>{aiBusy ? 'Planning…' : 'Plan with AI'}</Btn>
            </div>
          </div>
        )}

        {ops.map((r, i) => {
          const prev = ops.slice(0, i).reverse().find((p) => p.cam);
          const change = r.cam && prev && prev.tool && r.tool && prev.tool.id !== r.tool.id;
          return (
            <div key={r.op.id} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {change && <ToolChangeRow from={prev!} to={r} />}
              <OpCard r={r} n={i + 1} focused={r.op.id === focusedOpId} issues={issues.filter((x) => x.opId === r.op.id)} />
            </div>
          );
        })}

        {issues.filter((i) => !i.opId && i.severity !== 'info').map((i, k) => (
          <div key={k} style={{ fontSize: 12, color: i.severity === 'error' ? t.danger : t.part }}>{i.message}</div>
        ))}

        <div style={{ position: 'relative' }}>
          <Btn kind="ghost" onClick={() => setAdding(!adding)} style={{ width: '100%', border: `1px dashed ${t.border2}` }}>+ Add an operation</Btn>
          {adding && (
            <div style={{ marginTop: 6, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
              {KINDS.map((k) => (
                <button
                  key={k.kind} onClick={() => { addOperation(k.kind); setAdding(false); }}
                  style={{ textAlign: 'left', padding: '8px 10px', borderRadius: 8, border: `1px solid ${t.border2}`, background: t.surface, color: t.text, cursor: 'pointer', fontFamily: 'inherit' }}
                >
                  <div style={{ fontSize: 12.5, fontWeight: 600 }}>{k.label}</div>
                  <div style={{ fontSize: 11, color: t.textMute }}>{k.hint}</div>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      <div style={{ borderTop: `1px solid ${t.border}`, padding: 12, display: 'flex', flexDirection: 'column', gap: 8, background: t.surface }}>
        <Composer placeholder={ops.length ? 'Ask the AI to change the plan, or ask a question…' : 'Tell the AI about the job (e.g. "a box side in 6 mm birch ply")…'} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ flex: 1, fontSize: 11.5, color: t.textMute }}>
            {proposed > 0 ? `Accept the ${proposed} proposed operation${proposed === 1 ? '' : 's'} before running` : blocking ? 'Fix the errors before running' : ''}
          </span>
          <Btn kind="primary" onClick={() => setStep('run')} disabled={ops.length === 0}>Continue to Run →</Btn>
        </div>
      </div>
    </div>
  );
}

function ToolChangeRow({ from, to }: { from: ResolvedOp; to: ResolvedOp }) {
  const t = useTokens();
  const machine = useCamStore((s) => s.machine);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11.5, color: t.textDim, padding: '0 6px' }}>
      <span style={{ flex: 1, height: 1, background: t.border2 }} />
      <span>⇄ Tool change: <span style={{ fontFamily: MONO }}>{toolTag(from.tool!)}</span> → <span style={{ fontFamily: MONO }}>{toolTag(to.tool!)}</span> {to.tool!.name}{machine.toolChange === 'M0' ? ' (by hand)' : ''}</span>
      <span style={{ flex: 1, height: 1, background: t.border2 }} />
    </div>
  );
}

function OpCard({ r, n, focused, issues }: { r: ResolvedOp; n: number; focused: boolean; issues: CamIssueWithOp[] }) {
  const t = useTokens();
  const focusOperation = useCamStore((s) => s.focusOperation);
  const openOperation = useCamStore((s) => s.openOperation);
  const acceptOperation = useCamStore((s) => s.acceptOperation);
  const removeOperation = useCamStore((s) => s.removeOperation);
  const rejectOperation = useCamStore((s) => s.rejectOperation);
  const moveOperation = useCamStore((s) => s.moveOperation);
  const job = useCamStore((s) => s.job);
  const sendChat = useCamStore((s) => s.sendChat);
  const aiBusy = useCamStore((s) => s.aiBusy);
  const count = useCamStore((s) => s.job.operations.length);
  const op = r.op;
  const shown = [...(r.problem ? [{ severity: 'error' as const, message: r.problem }] : []), ...issues.filter((i) => i.severity !== 'info' && !(r.problem && i.message.endsWith(r.problem)))];

  return (
    <div
      onClick={() => focusOperation(focused ? null : op.id)}
      style={{
        background: t.surface, borderRadius: 10, padding: '10px 12px', cursor: 'pointer',
        border: `1px solid ${focused ? t.accent : t.border}`, boxShadow: focused ? `0 0 0 3px ${t.accentSoft}` : 'none',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
        <span style={{ width: 20, height: 20, borderRadius: 6, background: focused ? t.accent : t.surface3, color: focused ? '#fff' : t.textDim, fontSize: 11, fontWeight: 700, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>{n}</span>
        <span style={{ fontSize: 13, fontWeight: 600, flex: 1 }}>{opTitle(r)}</span>
        {r.tool && <Chip mono title={r.tool.name}>{toolTag(r.tool)} Ø{r.tool.diameter}</Chip>}
        {op.status === 'proposed' ? <Pill tone="proposed">Proposed</Pill> : <Pill tone="accepted">Accepted</Pill>}
      </div>
      <div style={{ fontSize: 12, color: t.textDim, marginTop: 5, paddingLeft: 27 }}>
        {[shapesText(op, jobEntities(job)), opSummary(r)].filter(Boolean).join(' · ')}
      </div>
      {op.aiPrev && <div style={{ fontSize: 11.5, color: t.violet, marginTop: 4, paddingLeft: 27 }}>The AI changed this accepted operation: accept the change, or reject it to put it back.</div>}
      {op.reason && <div style={{ fontSize: 11.5, color: t.textMute, marginTop: 4, paddingLeft: 27, fontStyle: 'italic' }}>{op.reason}</div>}
      {shown.map((i, k) => (
        <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6, marginLeft: 27, padding: '5px 8px', borderRadius: 7, background: i.severity === 'error' ? `${t.danger}14` : t.partSoft, color: i.severity === 'error' ? t.danger : t.part, fontSize: 11.5 }}>
          <span style={{ flex: 1 }}>{i.message.replace(/^Operation \d+: /, '')}</span>
          <Btn kind="ai" small disabled={aiBusy} onClick={(e) => { e.stopPropagation(); sendChat(`Fix this problem with operation ${n}: ${i.message}`, op.id); }}>Fix with AI</Btn>
        </div>
      ))}
      {focused && (
        <div style={{ fontSize: 11.5, color: t.accent, marginTop: 6, paddingLeft: 27 }}>
          {op.kind === 'facing' ? 'Facing covers the stock.' : 'Click shapes on the sketch to add or remove them. Double-click picks a whole outline.'}
        </div>
      )}
      <div style={{ display: 'flex', gap: 6, marginTop: 8, paddingLeft: 27 }} onClick={(e) => e.stopPropagation()}>
        {op.status === 'proposed' && <Btn kind="primary" small onClick={() => acceptOperation(op.id)}>Accept</Btn>}
        {op.aiPrev && <Btn small onClick={() => rejectOperation(op.id)} title="Put it back as it was before the AI's change">Reject</Btn>}
        <Btn small onClick={() => openOperation(op.id)}>Open</Btn>
        <div style={{ flex: 1 }} />
        <Btn kind="ghost" small disabled={n === 1} onClick={() => moveOperation(op.id, -1)} title="Earlier">↑</Btn>
        <Btn kind="ghost" small disabled={n === count} onClick={() => moveOperation(op.id, 1)} title="Later">↓</Btn>
        <Btn kind="ghost" small onClick={() => removeOperation(op.id)} title="Remove this operation">Remove</Btn>
      </div>
    </div>
  );
}
