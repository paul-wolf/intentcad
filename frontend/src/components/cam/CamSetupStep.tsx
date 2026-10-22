import { useState } from 'react';
import { useCamStore } from '@/stores/camStore';
import { useDocumentStore } from '@/stores/documentStore';
import { MATERIALS, materialName, type JobOrigin, type MaterialId, type SetupField, type StockPoint } from '@/cam/setup';
import { allTools, toolTag } from '@/cam/resolve';
import { Btn, Card, Chip, NumInput, Pill, Row, Segmented, Select, SourceDot, fmt, panelStyle, useTokens, MONO } from './ui';
import { MachineDialog } from './MachineDialog';
import { ToolsDialog } from './ToolsDialog';

const POINT_LABEL: Record<StockPoint, string> = {
  'back-left': 'back left', 'back-centre': 'back centre', 'back-right': 'back right', centre: 'centre',
  'front-left': 'front left', 'front-centre': 'front centre', 'front-right': 'front right',
};

/** Where X0 Y0 is, in words: "the front left corner of the stock". */
export function originWords(o: JobOrigin): string {
  if (o.kind === 'picked') return `a picked point (${fmt(o.x)}, ${fmt(o.y)})`;
  if (o.point === 'centre') return 'the centre of the stock';
  const label = POINT_LABEL[o.point];
  return `the ${label}${/left|right/.test(label) ? ' corner' : ' edge'} of the stock`;
}

/** Step 1: the machine, its tools, the stock, the origin and the clamps. */
export function CamSetupStep() {
  const t = useTokens();
  const job = useCamStore((s) => s.job);
  const machine = useCamStore((s) => s.machine);
  const resolved = useCamStore((s) => s.resolved);
  const profiles = useCamStore((s) => s.profiles);
  const selectMachine = useCamStore((s) => s.selectMachine);
  const updateSetup = useCamStore((s) => s.updateSetup);
  const setStep = useCamStore((s) => s.setStep);
  const pickingOrigin = useCamStore((s) => s.pickingOrigin);
  const setPickingOrigin = useCamStore((s) => s.setPickingOrigin);
  const drawingClamp = useCamStore((s) => s.drawingClamp);
  const setDrawingClamp = useCamStore((s) => s.setDrawingClamp);
  const updateClamp = useCamStore((s) => s.updateClamp);
  const removeClamp = useCamStore((s) => s.removeClamp);
  const sendChat = useCamStore((s) => s.sendChat);
  const aiBusy = useCamStore((s) => s.aiBusy);
  const sketches = useDocumentStore((s) => s.document.sketches);
  const [dialog, setDialog] = useState<'machine' | 'tools' | null>(null);

  const setup = job.setup;
  const ai = (f: SetupField) => setup.aiFields.includes(f);
  const dotFor = (f: SetupField, isSet: boolean) => <SourceDot kind={ai(f) ? 'ai' : isSet ? 'set' : 'inherited'} />;
  const tools = allTools(machine, setup);
  const used = new Set(resolved.ops.map((r) => r.tool?.id).filter(Boolean));
  const allowance = machine.spoilboardAllowance;

  return (
    <div style={panelStyle(t)}>
      <div style={{ flex: 1, overflowY: 'auto', padding: 14, display: 'flex', flexDirection: 'column', gap: 12 }}>
        {job.migrationNotes.length > 0 && (
          <div style={{ background: t.partSoft, border: `1px solid ${t.part}55`, borderRadius: 10, padding: '10px 12px', fontSize: 12.5 }}>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>This job was saved by an older version</div>
            <ul style={{ margin: '0 0 6px', paddingLeft: 18, color: t.textDim }}>
              {job.migrationNotes.slice(0, 8).map((n, i) => <li key={i}>{n}</li>)}
            </ul>
            <Btn small onClick={() => useCamStore.setState({ job: { ...job, migrationNotes: [] } })}>Got it</Btn>
          </div>
        )}

        <Card title="Machine" right={<Btn small onClick={() => setDialog('machine')}>Edit machine</Btn>}>
          <Select
            value={setup.machineId ?? ''} width="100%"
            options={[{ value: '', label: 'Built-in: Generic GRBL router' }, ...profiles.map((p) => ({ value: p.id, label: p.name }))]}
            onChange={(v) => selectMachine(v || null)}
          />
          <div style={{ fontSize: 12, color: t.textDim, marginTop: 8, lineHeight: 1.6 }}>
            {machine.post.dialect.toUpperCase()} · travel {machine.travel.x} × {machine.travel.y} × {machine.travel.z} mm · up to {machine.maxRpm} rpm
            {machine.spindle.kind === 'dial' ? ' (set by a dial)' : ''} · tool change {machine.toolChange === 'M0' ? 'by hand (M0)' : machine.toolChange}
            {' '}· safe {machine.safeZ} mm, clearance {machine.clearanceZ} mm
            {machine.park ? ` · parks at ${machine.park.x}, ${machine.park.y}` : ''}
          </div>
        </Card>

        <Card title="Tool library" right={<Btn small onClick={() => setDialog('tools')}>Manage tools</Btn>}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {tools.map((tl) => (
              <div key={tl.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5 }}>
                <span style={{ fontFamily: MONO, fontSize: 11.5, color: t.textDim, width: 28 }}>{toolTag(tl)}</span>
                <span style={{ flex: 1 }}>{tl.name}</span>
                <span style={{ fontFamily: MONO, fontSize: 11.5, color: t.textMute }}>Ø{tl.diameter} · {tl.flutes}F</span>
                {used.has(tl.id) && <Pill tone="accepted">used in this job</Pill>}
                {setup.tools.some((x) => x.id === tl.id) && <Pill tone="info">this job only</Pill>}
              </div>
            ))}
            {tools.length === 0 && <span style={{ fontSize: 12.5, color: t.danger }}>No tools: add one with Manage tools.</span>}
          </div>
        </Card>

        <Card title="Stock">
          <Row label="Sketch" dot={<SourceDot kind="set" />}>
            <Select
              value={setup.selectedSketchIds[0] ?? ''} width={220}
              options={[...(setup.selectedSketchIds.length ? [] : [{ value: '', label: 'Pick a sketch' }]), ...sketches.filter((s) => !s.suppressed).map((s) => ({ value: s.id, label: s.name }))]}
              onChange={(v) => v && updateSetup({ selectedSketchIds: [v] })}
            />
          </Row>
          <Row label="Material" dot={dotFor('material', true)}>
            <Select<MaterialId> value={setup.material} options={MATERIALS.map((m) => ({ value: m.id, label: m.name }))} onChange={(v) => updateSetup({ material: v }, ['material'])} />
          </Row>
          {(['width', 'height'] as const).map((k) => {
            const own = setup.stock[k];
            const shown = k === 'width' ? resolved.stock.width : resolved.stock.height;
            return (
              <Row
                key={k} label={k === 'width' ? 'Width (X)' : 'Height (Y)'} dot={dotFor(k, own !== null)}
                hint={own === null ? 'shapes + 10 a side' : <Btn kind="ghost" small onClick={() => updateSetup({ stock: { ...setup.stock, [k]: null } }, [k])}>Reset</Btn>}
              >
                <NumInput value={shown} step={1} min={1} max={5000} onChange={(v) => updateSetup({ stock: { ...setup.stock, [k]: v } }, [k])} />
                <span style={{ fontSize: 11.5, color: t.textMute }}>mm</span>
              </Row>
            );
          })}
          <Row label="Thickness (Z)" dot={dotFor('thickness', true)}>
            <NumInput value={setup.stock.thickness} step={0.5} min={0.5} max={200} onChange={(v) => updateSetup({ stock: { ...setup.stock, thickness: v } }, ['thickness'])} />
            <span style={{ fontSize: 11.5, color: t.textMute }}>mm</span>
          </Row>
          <Row label="Cut-through allowance" dot={<SourceDot kind="inherited" />} hint="from machine">
            <span style={{ fontFamily: MONO, fontSize: 12 }}>{fmt(allowance)} mm</span>
            <span style={{ fontSize: 11.5, color: t.textMute }}>so through cuts go {fmt(setup.stock.thickness + allowance)} mm deep</span>
          </Row>
        </Card>

        <Card title="Origin">
          <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start' }}>
            <OriginPicker />
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 8, fontSize: 12.5 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                {dotFor('origin', true)}
                <span>
                  X0 Y0 at <b>{originWords(setup.origin)}</b>
                </span>
              </div>
              <Btn small kind={pickingOrigin ? 'primary' : 'default'} onClick={() => setPickingOrigin(!pickingOrigin)} style={{ alignSelf: 'flex-start' }}>
                {pickingOrigin ? 'Click a point on the sketch…' : 'Pick a point on the sketch'}
              </Btn>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                {dotFor('zZero', setup.zZero !== 'stock-top')}
                <span style={{ color: t.textDim }}>Z0 at</span>
                <Segmented value={setup.zZero} options={[{ value: 'stock-top', label: 'Stock top' }, { value: 'spoilboard', label: 'Spoilboard' }]} onChange={(v) => updateSetup({ zZero: v }, ['zZero'])} />
              </div>
            </div>
          </div>
        </Card>

        <Card title="Clamps" right={<Btn small kind={drawingClamp ? 'primary' : 'default'} onClick={() => setDrawingClamp(!drawingClamp)}>{drawingClamp ? 'Drag a box on the sketch…' : 'Draw on the sketch'}</Btn>}>
          {setup.clamps.length === 0 ? (
            <div style={{ fontSize: 12.5, color: t.textMute }}>No clamps. Draw where they are: the tool goes over them at clearance height and never cuts into them.</div>
          ) : (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {setup.clamps.map((c, i) => (
                <div key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '3px 4px 3px 9px', borderRadius: 8, background: t.surface2, border: `1px solid ${t.border2}`, fontSize: 12 }}>
                  <span>Clamp {i + 1}</span>
                  <Chip mono>{fmt(c.width)}×{fmt(c.height)}</Chip>
                  <span style={{ color: t.textMute }}>h</span>
                  <NumInput value={c.zHeight} step={1} min={0.5} max={200} width={56} onChange={(v) => updateClamp(c.id, { zHeight: v })} title="How tall the clamp stands above the stock top, mm" />
                  <Btn kind="ghost" small onClick={() => removeClamp(c.id)} aria-label={`Remove clamp ${i + 1}`}>✕</Btn>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      <div style={{ borderTop: `1px solid ${t.border}`, padding: 12, display: 'flex', flexDirection: 'column', gap: 8, background: t.surface }}>
        <AiSetupChanges />
        {setup.aiFields.length > 0 && !setup.aiPending && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', borderRadius: 8, background: t.violetSoft, color: t.violet, fontSize: 12 }}>
            <SourceDot kind="ai" />
            <span style={{ flex: 1 }}>The AI filled in {setup.aiFields.map((f) => (f === 'zZero' ? 'Z zero' : f)).join(', ')}. Check them: they stay violet until you change them.</span>
          </div>
        )}
        {resolved.setupMissing.length > 0 && <div style={{ fontSize: 12, color: t.danger }}>Still needed: {resolved.setupMissing.join(', ')}.</div>}
        <div style={{ display: 'flex', gap: 8 }}>
          <Btn kind="ai" disabled={aiBusy} onClick={() => sendChat('Fill in the setup for this job from the sketch: material, stock size and thickness, origin and Z zero.')}>
            {aiBusy ? 'Asking the AI…' : 'Fill in with AI'}
          </Btn>
          <div style={{ flex: 1 }} />
          <Btn kind="primary" onClick={() => setStep('plan')} disabled={resolved.setupMissing.length > 0}>Continue to Plan →</Btn>
        </div>
      </div>

      {dialog === 'machine' && <MachineDialog onClose={() => setDialog(null)} />}
      {dialog === 'tools' && <ToolsDialog onClose={() => setDialog(null)} />}
    </div>
  );
}

/** The stock seen from above, with the seven points X0 Y0 can be on. */
function OriginPicker() {
  const t = useTokens();
  const origin = useCamStore((s) => s.job.setup.origin);
  const updateSetup = useCamStore((s) => s.updateSetup);
  const W = 150, H = 100, P = 12;
  const at: Record<StockPoint, [number, number]> = {
    'back-left': [P, P], 'back-centre': [P + W / 2, P], 'back-right': [P + W, P], centre: [P + W / 2, P + H / 2],
    'front-left': [P, P + H], 'front-centre': [P + W / 2, P + H], 'front-right': [P + W, P + H],
  };
  return (
    <svg width={W + 2 * P} height={H + 2 * P + 14} style={{ flexShrink: 0 }}>
      <rect x={P} y={P} width={W} height={H} rx={3} fill={t.partSoft} stroke={t.part} strokeWidth={1.2} />
      <text x={P + W / 2} y={H + 2 * P + 10} textAnchor="middle" fontSize={10} fill={t.textMute}>front (you)</text>
      {(Object.keys(at) as StockPoint[]).map((p) => {
        const [x, y] = at[p];
        const on = origin.kind === 'stock' && origin.point === p;
        return (
          <g key={p} onClick={() => updateSetup({ origin: { kind: 'stock', point: p } }, ['origin'])} style={{ cursor: 'pointer' }}>
            <title>{POINT_LABEL[p]}</title>
            <circle cx={x} cy={y} r={10} fill="transparent" />
            <circle cx={x} cy={y} r={on ? 6 : 4.5} fill={on ? t.accent : t.surface} stroke={on ? t.accent : t.border2} strokeWidth={1.5} />
          </g>
        );
      })}
    </svg>
  );
}

/** One line summing up the setup, at the top of Plan and Run. */
export function SetupSummaryStrip() {
  const t = useTokens();
  const setup = useCamStore((s) => s.job.setup);
  const machine = useCamStore((s) => s.machine);
  const resolved = useCamStore((s) => s.resolved);
  const setStep = useCamStore((s) => s.setStep);
  const o = setup.origin;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 14px', borderBottom: `1px solid ${t.border}`, background: t.surface, fontSize: 12, color: t.textDim, flexWrap: 'wrap' }}>
      <span style={{ fontWeight: 600, color: t.text }}>{machine.name}</span>
      <span>·</span>
      <span>{materialName(setup.material)}</span>
      <span style={{ fontFamily: MONO }}>{fmt(resolved.stock.width)}×{fmt(resolved.stock.height)}×{fmt(setup.stock.thickness)}</span>
      <span>·</span>
      <span>origin {o.kind === 'stock' ? POINT_LABEL[o.point] : 'picked'}, Z0 {setup.zZero === 'stock-top' ? 'top' : 'spoilboard'}</span>
      {setup.clamps.length > 0 && <><span>·</span><span>{setup.clamps.length} clamp{setup.clamps.length > 1 ? 's' : ''}</span></>}
      <div style={{ flex: 1 }} />
      <Btn kind="ghost" small onClick={() => setStep('setup')}>Edit setup</Btn>
      {setup.aiPending && <div style={{ flexBasis: '100%' }}><AiSetupChanges /></div>}
    </div>
  );
}

/** The AI's setup changes, each with what it was, waiting to be confirmed or undone. */
export function AiSetupChanges() {
  const t = useTokens();
  const setup = useCamStore((s) => s.job.setup);
  const confirm = useCamStore((s) => s.confirmSetupChanges);
  const undo = useCamStore((s) => s.undoSetupChanges);
  const prev = setup.aiPending;
  if (!prev) return null;
  const size = (v: number | null | undefined) => (v === null || v === undefined ? 'fit the shapes' : `${fmt(v)} mm`);
  const zWord = (z: string) => (z === 'stock-top' ? 'the stock top' : 'the spoilboard');
  const changes: string[] = [];
  if (prev.material !== undefined) changes.push(`material ${materialName(prev.material)} → ${materialName(setup.material)}`);
  if (prev.thickness !== undefined) changes.push(`thickness ${fmt(prev.thickness)} → ${fmt(setup.stock.thickness)} mm`);
  if (prev.width !== undefined) changes.push(`width ${size(prev.width)} → ${size(setup.stock.width)}`);
  if (prev.height !== undefined) changes.push(`height ${size(prev.height)} → ${size(setup.stock.height)}`);
  if (prev.origin !== undefined) changes.push(`origin ${originWords(prev.origin)} → ${originWords(setup.origin)}`);
  if (prev.zZero !== undefined) changes.push(`Z0 ${zWord(prev.zZero)} → ${zWord(setup.zZero)}`);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', borderRadius: 8, background: t.violetSoft, color: t.violet, fontSize: 12, marginTop: 2 }}>
      <SourceDot kind="ai" />
      <span style={{ flex: 1 }}>The AI changed the setup: {changes.join('; ')}. Confirm before running.</span>
      <Btn small kind="primary" onClick={confirm}>Confirm</Btn>
      <Btn small kind="ghost" onClick={undo}>Undo</Btn>
    </div>
  );
}
