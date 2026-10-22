import { useState } from 'react';
import { useCamStore } from '@/stores/camStore';
import { toolTag, type ResolvedOp } from '@/cam/resolve';
import type { MaterialId } from '@/cam/setup';
import { formatDuration } from '@/cam/estimate';
import { GcodePreview } from '../GcodePreview';
import { Btn, Card, panelStyle, useTokens, MONO, fmt } from './ui';
import { SetupSummaryStrip, originWords } from './CamSetupStep';

/** Step 3: check the toolpath, run the simulator, read the steps at the machine, and download. */
export function CamRunStep() {
  const t = useTokens();
  const resolved = useCamStore((s) => s.resolved);
  const job = useCamStore((s) => s.job);
  const machine = useCamStore((s) => s.machine);
  const issues = useCamStore((s) => s.issues);
  const gcode = useCamStore((s) => s.generatedGcode);
  const toolpath = useCamStore((s) => s.toolpath);
  const estimated = useCamStore((s) => s.estimatedSeconds);
  const downloadGcode = useCamStore((s) => s.downloadGcode);
  const sendChat = useCamStore((s) => s.sendChat);
  const aiBusy = useCamStore((s) => s.aiBusy);
  const setStep = useCamStore((s) => s.setStep);
  const showPreview = useCamStore((s) => s.showToolpathPreview);
  const togglePreview = useCamStore((s) => s.toggleToolpathPreview);
  const [showCode, setShowCode] = useState(false);

  const proposed = job.operations.filter((o) => o.status === 'proposed').length;
  const errors = issues.filter((i) => i.severity === 'error');
  const warnings = issues.filter((i) => i.severity === 'warning');
  const pendingSetup = !!job.setup.aiPending;
  const blocked = proposed > 0 || pendingSetup || errors.length > 0 || !gcode;
  const steps = operatorSteps(resolved.ops.filter((r) => r.cam), machine.toolChange, originWords(job.setup.origin), job.setup.zZero, job.setup.stock.thickness, (id) => job.operations.findIndex((o) => o.id === id) + 1, job.setup.material);

  return (
    <div style={panelStyle(t)}>
      <SetupSummaryStrip />
      <div style={{ flex: 1, overflowY: 'auto', padding: 14, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <Card title="Check" right={<Btn kind="ghost" small onClick={togglePreview}>{showPreview ? 'Hide toolpath' : 'Show toolpath'}</Btn>}>
          <div style={{ display: 'flex', gap: 18, fontSize: 12.5, marginBottom: 10 }}>
            <div><div style={{ color: t.textMute, fontSize: 11 }}>Estimated time</div><div style={{ fontSize: 16, fontWeight: 600 }}>{estimated > 0 ? `~${formatDuration(estimated)}` : '—'}</div></div>
            <div><div style={{ color: t.textMute, fontSize: 11 }}>Operations</div><div style={{ fontSize: 16, fontWeight: 600 }}>{resolved.ops.length}</div></div>
            <div><div style={{ color: t.textMute, fontSize: 11 }}>Tool changes</div><div style={{ fontSize: 16, fontWeight: 600 }}>{resolved.toolChanges}</div></div>
          </div>
          <div style={{ fontSize: 11, color: t.textMute, marginBottom: 6 }}>The time leaves out acceleration, so real runs take longer.</div>
          {proposed > 0 && (
            <IssueRow tone="error" text={`${proposed} operation${proposed === 1 ? ' is' : 's are'} still proposed: accept or remove ${proposed === 1 ? 'it' : 'them'} in Plan`} action={<Btn small onClick={() => setStep('plan')}>Go to Plan</Btn>} />
          )}
          {pendingSetup && (
            <IssueRow tone="error" text="The AI changed the setup: confirm or undo its changes" action={<Btn small onClick={() => setStep('setup')}>Go to Setup</Btn>} />
          )}
          {[...errors, ...warnings].map((i, k) => (
            <IssueRow
              key={k} tone={i.severity === 'error' ? 'error' : 'warn'} text={i.message}
              action={<Btn kind="ai" small disabled={aiBusy} onClick={() => { setStep('plan'); sendChat(`Fix this problem: ${i.message}`, i.opId ?? null); }}>Fix with AI</Btn>}
            />
          ))}
          {!blocked && warnings.length === 0 && <div style={{ fontSize: 12.5, color: t.ok }}>No problems found.</div>}
        </Card>

        {toolpath && toolpath.length > 0 && <SimControls />}

        {steps.length > 0 && (
          <Card title="At the machine">
            <ol style={{ margin: 0, paddingLeft: 18, fontSize: 12.5, lineHeight: 1.6 }}>
              {steps.map((s, i) => <li key={i} style={{ marginBottom: 3 }}>{s}</li>)}
            </ol>
          </Card>
        )}

        {gcode && !blocked && (
          <Card title="G-code" right={<Btn kind="ghost" small onClick={() => setShowCode(!showCode)}>{showCode ? 'Hide' : 'Show'}</Btn>}>
            {showCode ? <GcodePreview gcode={gcode} onClose={() => setShowCode(false)} /> : <div style={{ fontSize: 12, color: t.textDim }}>{gcode.split('\n').length} lines. The line running is highlighted while the simulator plays.</div>}
          </Card>
        )}
      </div>

      <div style={{ borderTop: `1px solid ${t.border}`, padding: 12, display: 'flex', alignItems: 'center', gap: 8, background: t.surface }}>
        <Btn kind="ghost" onClick={() => setStep('plan')}>← Plan</Btn>
        <span style={{ flex: 1, fontSize: 11.5, color: blocked ? t.danger : t.textMute, textAlign: 'right' }}>
          {proposed > 0 ? 'Accept the proposed operations first' : pendingSetup ? "Confirm the AI's setup changes first" : errors.length ? 'Fix the errors first' : !gcode ? 'Nothing to cut yet' : ''}
        </span>
        <Btn kind="primary" disabled={blocked} onClick={downloadGcode}>Download .nc</Btn>
      </div>
    </div>
  );
}

function IssueRow({ tone, text, action }: { tone: 'error' | 'warn'; text: string; action?: React.ReactNode }) {
  const t = useTokens();
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6, padding: '6px 9px', borderRadius: 7, background: tone === 'error' ? `${t.danger}14` : t.partSoft, color: tone === 'error' ? t.danger : t.part, fontSize: 12 }}>
      <span style={{ flex: 1 }}>{text}</span>
      {action}
    </div>
  );
}

function SimControls() {
  const t = useTokens();
  const simState = useCamStore((s) => s.simState);
  const simSpeed = useCamStore((s) => s.simSpeed);
  const simMoveIndex = useCamStore((s) => s.simMoveIndex);
  const toolpath = useCamStore((s) => s.toolpath);
  const { simPlay, simPause, simStep, simStop, simSetSpeed } = useCamStore.getState();
  const total = toolpath?.length ?? 0;
  return (
    <Card title="Simulator" right={<span style={{ fontSize: 11, color: t.textMute }}>Space plays, → steps, Esc stops</span>}>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <Btn kind="primary" small onClick={simState === 'playing' ? simPause : simPlay} style={{ width: 70 }}>{simState === 'playing' ? 'Pause' : 'Play'}</Btn>
        <Btn small onClick={simStep}>Step</Btn>
        <Btn small onClick={simStop} disabled={simState === 'idle'}>Stop</Btn>
        <div style={{ flex: 1 }} />
        {[0.5, 1, 2, 4, 8].map((s) => (
          <Btn key={s} kind={simSpeed === s ? 'default' : 'ghost'} small onClick={() => simSetSpeed(s)} style={{ fontFamily: MONO, color: simSpeed === s ? t.accent : t.textDim }}>{s}×</Btn>
        ))}
      </div>
      <div style={{ height: 4, borderRadius: 2, background: t.surface3, marginTop: 10, overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${simState === 'idle' || total === 0 ? 0 : ((simMoveIndex + 1) / total) * 100}%`, background: t.accent }} />
      </div>
    </Card>
  );
}

/** What the operator does, in order: fit the first tool, zero, and each tool change and dial setting. */
export function operatorSteps(
  ops: ResolvedOp[], toolChange: 'M0' | 'M6' | 'ATC', origin: string, zZero: 'stock-top' | 'spoilboard', thickness: number, number: (opId: string) => number, material?: MaterialId,
): string[] {
  const first = ops[0];
  if (!first?.tool) return [];
  const steps: string[] = [];
  if (material === 'carbon-fibre') steps.push('Carbon fibre: switch on the dust extraction (or cut wet) and put on an FFP3 or P100 mask. The dust is harmful to breathe and conducts electricity.');
  const zWord = zZero === 'stock-top' ? 'the top of the stock' : 'the spoilboard';
  if (toolChange !== 'ATC') steps.push(`Fit ${toolTag(first.tool)}, the ${first.tool.name}.`);
  steps.push(`Set X0 Y0 at ${origin}, and Z0 on ${zWord}${zZero === 'spoilboard' ? ` (the stock top is then Z${fmt(thickness)})` : ''}.`);
  if (first.dial) steps.push(`When the program pauses, set the speed dial to ${first.dial.setting} (about ${first.rpm} rpm) and resume.`);
  for (let i = 1; i < ops.length; i++) {
    const prev = ops[i - 1]!, r = ops[i]!;
    if (!r.tool || !prev.tool) continue;
    const n = number(r.op.id);
    if (r.tool.id !== prev.tool.id) {
      if (toolChange === 'ATC') steps.push(`Before operation ${n} the changer loads ${toolTag(r.tool)}, the ${r.tool.name}.`);
      else steps.push(`Before operation ${n} the program stops: fit ${toolTag(r.tool)}, the ${r.tool.name}, ${zZero === 'stock-top' ? 'set Z0 on the top of the stock again' : 'set Z0 on the spoilboard again'}, and resume.`);
      if (r.dial) steps.push(`Then set the speed dial to ${r.dial.setting} (about ${r.rpm} rpm) when asked.`);
    } else if (r.dial && prev.dial && r.dial.setting !== prev.dial.setting) {
      steps.push(`Before operation ${n}, set the speed dial to ${r.dial.setting} (about ${r.rpm} rpm) when asked.`);
    }
  }
  steps.push(`Cuts run ${fmt(ops.reduce((m, r) => Math.max(m, r.fields.depth.value), 0))} mm deep at most. Keep clear of the machine while it runs.`);
  return steps;
}
