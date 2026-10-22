import { useState, type ReactNode } from 'react';
import { useCamStore } from '@/stores/camStore';
import { allTools, toolTag, type Field, type ResolvedOp } from '@/cam/resolve';
import type { OpOverrides, OverrideKey, PlanKind } from '@/cam/setup';
import type { CutSide } from '@/types/cam';
import { Btn, Chip, GroupLabel, NumInput, Pill, Segmented, Select, SourceDot, SourceKey, fmt, panelStyle, useTokens, MONO } from './ui';
import { Composer } from './AiThread';
import { PassDiagram } from './PassDiagram';
import { opTitle } from './opText';

/** One operation, opened: everything it does, and where each value comes from. */
export function CamOperationEditor({ opId }: { opId: string }) {
  const t = useTokens();
  const resolved = useCamStore((s) => s.resolved);
  const machine = useCamStore((s) => s.machine);
  const setup = useCamStore((s) => s.job.setup);
  const thickness = setup.stock.thickness;
  const issues = useCamStore((s) => s.issues);
  const openOperation = useCamStore((s) => s.openOperation);
  const updateOperation = useCamStore((s) => s.updateOperation);
  const acceptOperation = useCamStore((s) => s.acceptOperation);
  const rejectOperation = useCamStore((s) => s.rejectOperation);
  const moveOperation = useCamStore((s) => s.moveOperation);
  const setOverride = useCamStore((s) => s.setOverride);
  const resetOverride = useCamStore((s) => s.resetOverride);
  const [asking, setAsking] = useState(false);

  const index = resolved.ops.findIndex((r) => r.op.id === opId);
  const r = resolved.ops[index] as ResolvedOp;
  const op = r.op;
  const f = r.fields;
  const tools = allTools(machine, setup);
  const set = <K extends OverrideKey>(k: K) => (v: NonNullable<OpOverrides[K]>) => setOverride(op.id, k, v);
  const reset = (k: OverrideKey) => () => resetOverride(op.id, k);
  const isProfile = op.kind === 'profile';
  const isDrill = op.kind === 'drill';
  const drilling = isDrill && f.holeMethod.value === 'drill';
  const opIssues = [...(r.problem ? [r.problem] : []), ...issues.filter((i) => i.opId === op.id && i.severity !== 'info').map((i) => i.message.replace(/^Operation \d+: /, '')).filter((m) => m !== r.problem)];

  const num = (k: OverrideKey, field: Field<number>, unit: string, step: number, min: number, max: number) => (
    <FieldRow label={LABELS[k]} field={field} onReset={reset(k)} unit={unit}>
      <NumInput value={field.value} step={step} min={min} max={max} onChange={set(k) as (v: number) => void} />
    </FieldRow>
  );

  return (
    <div style={panelStyle(t)}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', borderBottom: `1px solid ${t.border}`, background: t.surface }}>
        <Btn kind="ghost" small onClick={() => openOperation(null)}>← Plan</Btn>
        <span style={{ fontSize: 13.5, fontWeight: 600, flex: 1 }}>{index + 1}. {opTitle(r)}</span>
        {op.status === 'proposed' ? <Pill tone="proposed">Proposed</Pill> : <Pill tone="accepted">Accepted</Pill>}
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '4px 14px 14px' }}>
        <div style={{ marginTop: 10 }}><SourceKey /></div>
        {op.reason && <div style={{ fontSize: 11.5, color: t.textMute, marginTop: 8, fontStyle: 'italic' }}>{op.reason}</div>}
        {opIssues.map((m, i) => (
          <div key={i} style={{ fontSize: 12, marginTop: 8, padding: '6px 9px', borderRadius: 7, background: r.problem === m ? `${t.danger}14` : t.partSoft, color: r.problem === m ? t.danger : t.part }}>{m}</div>
        ))}

        <GroupLabel>WHAT</GroupLabel>
        <PlainRow label="Operation">
          <Select<PlanKind> value={op.kind} options={[{ value: 'profile', label: 'Profile' }, { value: 'pocket', label: 'Pocket' }, { value: 'drill', label: 'Holes' }, { value: 'facing', label: 'Facing' }]} onChange={(v) => updateOperation(op.id, { kind: v })} />
        </PlainRow>
        {isProfile && (
          <PlainRow label="Cut on">
            <Segmented<CutSide> value={op.cutSide} options={[{ value: 'outside', label: 'Outside' }, { value: 'inside', label: 'Inside' }, { value: 'on', label: 'On the line' }]} onChange={(v) => updateOperation(op.id, { cutSide: v })} />
          </PlainRow>
        )}
        {op.kind !== 'facing' && (
          <PlainRow label="Shapes">
            <span style={{ fontSize: 12.5 }}>{op.entityIds.length} chosen</span>
            <span style={{ fontSize: 11.5, color: t.textMute }}>click shapes on the sketch to add or remove</span>
          </PlainRow>
        )}

        <GroupLabel>TOOL</GroupLabel>
        <FieldRow label="Tool" field={f.toolId} onReset={reset('toolId')} show={(id) => { const tl = tools.find((x) => x.id === id); return tl ? `${toolTag(tl)} ${tl.name}` : 'none'; }}>
          <Select
            value={f.toolId.value} width={240}
            options={[...(f.toolId.value ? [] : [{ value: '', label: 'No tool fits' }]), ...tools.map((tl) => ({ value: tl.id, label: `${toolTag(tl)} · ${tl.name}` }))]}
            onChange={(v) => v && setOverride(op.id, 'toolId', v)}
          />
        </FieldRow>

        <GroupLabel>DEPTH</GroupLabel>
        {num('depth', f.depth, 'mm', 0.1, 0.01, 200)}
        {!drilling && num('depthPerPass', f.depthPerPass, 'mm', 0.1, 0.01, 50)}
        {drilling && num('peckDepth', f.peckDepth, 'mm', 0.5, 0, 50)}
        <PassDiagram r={r} thickness={thickness} allowance={machine.spoilboardAllowance} />

        <GroupLabel>{r.dial ? 'SPEEDS AND FEEDS · DIAL' : 'SPEEDS AND FEEDS'}</GroupLabel>
        {num('rpm', f.rpm, 'rpm', 500, 1000, 60000)}
        {r.dial && (
          <PlainRow label="Dial">
            <span style={{ fontSize: 12.5 }}>set the dial to <b style={{ fontFamily: MONO }}>{r.dial.setting}</b> ({r.dial.rpm} rpm)</span>
          </PlainRow>
        )}
        {num('chipLoad', f.chipLoad, 'mm/tooth', 0.005, 0.001, 0.5)}
        {num('plungePercent', f.plungePercent, '% of feed', 5, 5, 100)}
        <PlainRow label="Feed">
          <span style={{ fontFamily: MONO, fontSize: 12.5 }}>{Math.round(r.feed)} mm/min</span>
          <span style={{ fontSize: 11.5, color: r.feedCapped ? t.part : t.textMute }}>
            {r.feedCapped ? `capped at the machine's ${machine.rapidRate}` : `${fmt(f.chipLoad.value)} × ${r.tool?.flutes ?? 2} flutes × ${r.rpm} rpm`}
          </span>
        </PlainRow>
        <PlainRow label="Plunge">
          <span style={{ fontFamily: MONO, fontSize: 12.5 }}>{Math.round(r.plunge)} mm/min</span>
        </PlainRow>

        <GroupLabel>HOW IT CUTS</GroupLabel>
        {isDrill && (
          <FieldRow label="Holes by" field={f.holeMethod} onReset={reset('holeMethod')} show={(v) => (v === 'drill' ? 'drilling' : 'helix')}>
            <Segmented value={f.holeMethod.value} options={[{ value: 'drill', label: 'Drilling' }, { value: 'helix', label: 'Helix' }]} onChange={set('holeMethod')} />
          </FieldRow>
        )}
        {isProfile && (
          <FieldRow label="Entry" field={f.entry} onReset={reset('entry')}>
            <Segmented value={f.entry.value} options={[{ value: 'plunge', label: 'Plunge' }, { value: 'ramp', label: 'Ramp' }]} onChange={set('entry')} />
          </FieldRow>
        )}
        {((isProfile && f.entry.value === 'ramp') || (isDrill && !drilling)) && num('rampAngle', f.rampAngle, '°', 0.5, 0.5, 20)}
        {(isProfile || op.kind === 'pocket' || op.kind === 'facing') && (
          <FieldRow label="Direction" field={f.cutDirection} onReset={reset('cutDirection')}>
            <Segmented value={f.cutDirection.value} options={[{ value: 'climb', label: 'Climb' }, { value: 'conventional', label: 'Conventional' }]} onChange={set('cutDirection')} />
          </FieldRow>
        )}
        {(op.kind === 'pocket' || op.kind === 'facing') && (
          <FieldRow label="Stepover" field={f.stepover} onReset={reset('stepover')} unit={r.tool ? `× Ø = ${fmt(f.stepover.value * r.tool.diameter)} mm` : '× Ø'}>
            <NumInput value={f.stepover.value} step={0.05} min={0.05} max={0.95} onChange={set('stepover')} />
          </FieldRow>
        )}
        {isProfile && (
          <>
            <FieldRow label="Tabs" field={f.tabs} onReset={reset('tabs')} show={(v) => (v ? 'on' : 'off')}>
              <Segmented value={f.tabs.value ? 'on' : 'off'} options={[{ value: 'on', label: 'On' }, { value: 'off', label: 'Off' }]} onChange={(v) => setOverride(op.id, 'tabs', v === 'on')} />
            </FieldRow>
            {f.tabs.value && (
              <>
                {num('tabCount', f.tabCount, '', 1, 1, 20)}
                {num('tabWidth', f.tabWidth, 'mm', 0.5, 0.5, 50)}
                {num('tabHeight', f.tabHeight, 'mm', 0.1, 0.1, 50)}
              </>
            )}
          </>
        )}
        {drilling && num('dwell', f.dwell, 's', 0.1, 0, 10)}

        <details style={{ marginTop: 8 }}>
          <summary style={{ fontSize: 10.5, fontWeight: 600, letterSpacing: '0.7px', color: t.textMute, cursor: 'pointer', padding: '8px 0' }}>MORE</summary>
          {!drilling && num('lastPassDepth', f.lastPassDepth, 'mm finishing pass', 0.05, 0, 5)}
          <PlainRow label="Lead-in">
            <span style={{ fontSize: 11.5, color: t.textMute }}>Not available yet: profiles start with a plunge or a ramp on the path.</span>
          </PlainRow>
          <PlainRow label="Order">
            <span style={{ fontSize: 12.5 }}>{index + 1} of {resolved.ops.length}</span>
            <Btn kind="ghost" small disabled={index === 0} onClick={() => moveOperation(op.id, -1)}>Earlier</Btn>
            <Btn kind="ghost" small disabled={index === resolved.ops.length - 1} onClick={() => moveOperation(op.id, 1)}>Later</Btn>
          </PlainRow>
        </details>
      </div>

      <div style={{ borderTop: `1px solid ${t.border}`, padding: 12, display: 'flex', flexDirection: 'column', gap: 8, background: t.surface }}>
        {asking && <Composer placeholder={`Ask about operation ${index + 1}, or ask for a change…`} focusOpId={op.id} autoFocus />}
        <div style={{ display: 'flex', gap: 8 }}>
          {!asking && <Btn kind="ai" onClick={() => setAsking(true)}>Ask AI about this operation</Btn>}
          <div style={{ flex: 1 }} />
          {op.aiPrev && <Btn onClick={() => rejectOperation(op.id)} title="Put it back as it was before the AI's change">Reject</Btn>}
          {op.status === 'proposed' && <Btn onClick={() => acceptOperation(op.id)}>Accept</Btn>}
          <Btn kind="primary" onClick={() => openOperation(null)}>Done</Btn>
        </div>
      </div>
    </div>
  );
}

const LABELS: Record<OverrideKey, string> = {
  toolId: 'Tool', depth: 'Total depth', depthPerPass: 'Depth per pass', lastPassDepth: 'Finishing pass', rpm: 'Spindle speed',
  chipLoad: 'Chip load', plungePercent: 'Plunge feed', stepover: 'Stepover', entry: 'Entry', rampAngle: 'Ramp angle',
  cutDirection: 'Direction', tabs: 'Tabs', tabCount: 'Number of tabs', tabWidth: 'Tab width', tabHeight: 'Tab height',
  holeMethod: 'Holes by', peckDepth: 'Peck depth', dwell: 'Dwell',
};

function PlainRow({ label, children }: { label: string; children: ReactNode }) {
  const t = useTokens();
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 30 }}>
      <span style={{ width: 7 }} />
      <span style={{ fontSize: 12.5, color: t.textDim, width: 112, flexShrink: 0 }}>{label}</span>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', minWidth: 0 }}>{children}</div>
    </div>
  );
}

/** A value with its source dot; set here or by the AI, it says what it replaced and offers Reset. */
function FieldRow<V>({ label, field, onReset, unit, show, children }: {
  label: string; field: Field<V>; onReset: () => void; unit?: string; show?: (v: V) => string; children: ReactNode;
}) {
  const t = useTokens();
  const overridden = field.kind !== 'inherited';
  const base = show ? show(field.base) : typeof field.base === 'number' ? fmt(field.base) : String(field.base);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 30, padding: '1px 0' }}>
      <SourceDot kind={field.kind} title={overridden ? `${field.kind === 'ai' ? 'Set by the AI' : 'Set here'}; the default is ${base} (${field.baseSource})` : `From ${field.source}`} />
      <span style={{ fontSize: 12.5, color: t.textDim, width: 112, flexShrink: 0 }}>{label}</span>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', minWidth: 0, flex: 1 }}>
        {children}
        {unit && <span style={{ fontSize: 11.5, color: t.textMute }}>{unit}</span>}
        <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: t.textMute, textAlign: 'right' }}>
          {overridden ? (
            <>
              <span title={field.baseSource}>was {base}</span>
              <Btn kind="ghost" small onClick={onReset} style={{ color: field.kind === 'ai' ? t.violet : t.part }}>Reset</Btn>
            </>
          ) : (
            <Chip style={{ fontSize: 10.5 }}>{field.source}</Chip>
          )}
        </span>
      </div>
    </div>
  );
}
