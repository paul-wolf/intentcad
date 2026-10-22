import { useState } from 'react';
import type { CamMachine, CoolantOutput, DialSetting, ToolChangeMethod } from '@/cam/setup';
import { TYPICAL_DIAL } from '@/cam/setup';
import { machineProblems } from '@/cam/machine';
import { useCamStore } from '@/stores/camStore';
import { Btn, Dialog, GroupLabel, NumInput, Row, Segmented, Select, inputStyle, useTokens, SANS } from './ui';

/** Edit the machine: travel, spindle, tool changes, heights, park, coolant, allowance and the post. */
export function MachineDialog({ onClose }: { onClose: () => void }) {
  const t = useTokens();
  const current = useCamStore((s) => s.machine);
  const machineId = useCamStore((s) => s.job.setup.machineId);
  const saveMachine = useCamStore((s) => s.saveMachine);
  const [m, setM] = useState<CamMachine>(() => structuredClone(current));
  const [saving, setSaving] = useState(false);
  const problems = machineProblems(m);
  const patch = (p: Partial<CamMachine>) => setM((x) => ({ ...x, ...p }));

  const save = async (asNew: boolean) => {
    setSaving(true);
    const ok = await saveMachine(m, asNew);
    setSaving(false);
    if (ok) onClose();
  };

  const dial = m.spindle.kind === 'dial' ? m.spindle.dial : null;
  const setDial = (d: DialSetting[]) => patch({ spindle: { kind: 'dial', dial: d } });

  return (
    <Dialog
      title="Machine" onClose={onClose} width={640}
      footer={
        <>
          {problems.length > 0 && <span style={{ fontSize: 12, color: t.danger, marginRight: 'auto' }}>{problems[0]}</span>}
          <Btn kind="ghost" onClick={onClose}>Cancel</Btn>
          {machineId && <Btn onClick={() => save(true)} disabled={saving || problems.length > 0}>Save as a new machine</Btn>}
          <Btn kind="primary" onClick={() => save(!machineId)} disabled={saving || problems.length > 0}>
            {machineId ? 'Save' : 'Save as a new machine'}
          </Btn>
        </>
      }
    >
      {!machineId && (
        <p style={{ fontSize: 12, color: t.textDim, marginTop: 0 }}>
          This job uses the built-in machine. Saving makes it a machine of your own that other jobs can use too.
        </p>
      )}
      <Row label="Name">
        <input value={m.name} onChange={(e) => patch({ name: e.target.value })} style={{ ...inputStyle(t, 260), fontFamily: SANS }} />
      </Row>

      <GroupLabel>CONTROLLER</GroupLabel>
      <Row label="Dialect" hint="the G-code flavour written">
        <Select value={m.post.dialect} options={[{ value: 'grbl', label: 'GRBL' }]} onChange={() => {}} />
      </Row>
      <Row label="Decimal places">
        <NumInput value={m.post.decimalPlaces} step={1} min={0} max={6} width={60} onChange={(v) => patch({ post: { ...m.post, decimalPlaces: Math.round(v) } })} />
      </Row>
      <Row label="Program start" hint="extra lines after the setup">
        <textarea value={m.post.header} onChange={(e) => patch({ post: { ...m.post, header: e.target.value } })} rows={2} style={{ ...inputStyle(t, 300), resize: 'vertical' }} />
      </Row>
      <Row label="Program end">
        <textarea value={m.post.footer} onChange={(e) => patch({ post: { ...m.post, footer: e.target.value } })} rows={2} style={{ ...inputStyle(t, 300), resize: 'vertical' }} />
      </Row>

      <GroupLabel>TRAVEL AND SPEED</GroupLabel>
      <Row label="Travel X / Y / Z" hint="mm">
        {(['x', 'y', 'z'] as const).map((k) => (
          <NumInput key={k} value={m.travel[k]} step={10} min={1} max={10000} width={70} onChange={(v) => patch({ travel: { ...m.travel, [k]: v } })} />
        ))}
      </Row>
      <Row label="Rapid rate" hint="mm/min; feeds are capped at it">
        <NumInput value={m.rapidRate} step={100} min={100} max={100000} width={90} onChange={(v) => patch({ rapidRate: v })} />
      </Row>
      <Row label="Max spindle" hint="rpm">
        <NumInput value={m.maxRpm} step={1000} min={1000} max={100000} width={90} onChange={(v) => patch({ maxRpm: v })} />
      </Row>

      <GroupLabel>SPINDLE</GroupLabel>
      <Row label="Speed is set by">
        <Segmented
          value={m.spindle.kind}
          options={[{ value: 'gcode', label: 'G-code (S…)' }, { value: 'dial', label: 'A dial by hand' }]}
          onChange={(v) => patch({ spindle: v === 'gcode' ? { kind: 'gcode' } : { kind: 'dial', dial: dial ?? TYPICAL_DIAL.map((d) => ({ ...d })) } })}
        />
      </Row>
      {dial && (
        <div style={{ marginLeft: 128, marginBottom: 6 }}>
          <div style={{ fontSize: 11.5, color: t.textMute, marginBottom: 4 }}>
            Dial settings and their speed. Each operation uses the nearest setting, and the program pauses to ask for it.
          </div>
          {dial.map((d, i) => (
            <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 3 }}>
              <input value={d.setting} onChange={(e) => setDial(dial.map((x, j) => (j === i ? { ...x, setting: e.target.value } : x)))} style={{ ...inputStyle(t, 50) }} />
              <NumInput value={d.rpm} step={1000} min={1000} max={100000} width={90} onChange={(v) => setDial(dial.map((x, j) => (j === i ? { ...x, rpm: v } : x)))} />
              <span style={{ fontSize: 11.5, color: t.textMute }}>rpm</span>
              <Btn kind="ghost" small onClick={() => setDial(dial.filter((_, j) => j !== i))}>Remove</Btn>
            </div>
          ))}
          <Btn small onClick={() => setDial([...dial, { setting: String(dial.length + 1), rpm: (dial[dial.length - 1]?.rpm ?? 10000) + 2000 }])}>+ Add a setting</Btn>
        </div>
      )}

      <GroupLabel>TOOL CHANGES AND HEIGHTS</GroupLabel>
      <Row label="Tool change" hint={m.toolChange === 'M0' ? 'pause, change by hand, resume' : m.toolChange === 'M6' ? 'T… M6 for the sender' : 'automatic changer'}>
        <Segmented<ToolChangeMethod> value={m.toolChange} options={[{ value: 'M0', label: 'Pause (M0)' }, { value: 'M6', label: 'M6' }, { value: 'ATC', label: 'ATC' }]} onChange={(v) => patch({ toolChange: v })} />
      </Row>
      <Row label="Safe height" hint="above the stock, between cuts">
        <NumInput value={m.safeZ} step={0.5} min={0.5} max={100} width={70} onChange={(v) => patch({ safeZ: v })} />
      </Row>
      <Row label="Clearance height" hint="over clamps, for tool changes and the end">
        <NumInput value={m.clearanceZ} step={1} min={0.5} max={200} width={70} onChange={(v) => patch({ clearanceZ: v })} />
      </Row>
      <Row label="Park position" hint="machine coordinates (G53)">
        <label style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 4 }}>
          <input type="checkbox" checked={!!m.park} onChange={(e) => patch({ park: e.target.checked ? { x: 0, y: 0 } : null })} />
          Park
        </label>
        {m.park && (
          <>
            <NumInput value={m.park.x} step={10} min={-10000} max={10000} width={70} onChange={(v) => patch({ park: { ...m.park!, x: v } })} />
            <NumInput value={m.park.y} step={10} min={-10000} max={10000} width={70} onChange={(v) => patch({ park: { ...m.park!, y: v } })} />
          </>
        )}
        {!m.park && <span style={{ fontSize: 11.5, color: t.textMute }}>goes to X0 Y0</span>}
      </Row>

      <GroupLabel>OTHER</GroupLabel>
      <Row label="Coolant / extraction">
        <Segmented<CoolantOutput> value={m.coolant} options={[{ value: 'none', label: 'None' }, { value: 'M7', label: 'M7 (mist)' }, { value: 'M8', label: 'M8 (flood)' }]} onChange={(v) => patch({ coolant: v })} />
      </Row>
      <Row label="Spoilboard allowance" hint="how far through cuts go below the stock">
        <NumInput value={m.spoilboardAllowance} step={0.1} min={0} max={5} width={70} onChange={(v) => patch({ spoilboardAllowance: v })} />
      </Row>
    </Dialog>
  );
}
