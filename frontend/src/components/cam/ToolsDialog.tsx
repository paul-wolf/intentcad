import { useState } from 'react';
import type { CamMachine, LibraryTool, MaterialId, MaterialPreset } from '@/cam/setup';
import { MATERIALS, newId, presetFor, shippedPreset } from '@/cam/setup';
import { machineProblems } from '@/cam/machine';
import { useCamStore } from '@/stores/camStore';
import { Btn, Dialog, NumInput, Segmented, Select, inputStyle, useTokens, SANS, MONO } from './ui';

const TYPES: { value: LibraryTool['type']; label: string }[] = [
  { value: 'flat', label: 'Flat end mill' },
  { value: 'ball', label: 'Ball nose' },
  { value: 'vbit', label: 'V-bit' },
  { value: 'drill', label: 'Drill' },
];

/** The machine's tool library, and the cutting data for each tool in each material. */
export function ToolsDialog({ onClose }: { onClose: () => void }) {
  const t = useTokens();
  const current = useCamStore((s) => s.machine);
  const jobMaterial = useCamStore((s) => s.job.setup.material);
  const machineId = useCamStore((s) => s.job.setup.machineId);
  const saveMachine = useCamStore((s) => s.saveMachine);
  const [m, setM] = useState<CamMachine>(() => structuredClone(current));
  const [tab, setTab] = useState<'tools' | 'presets'>('tools');
  const [material, setMaterial] = useState<MaterialId>(jobMaterial);
  const [saving, setSaving] = useState(false);
  const problems = machineProblems(m);

  const setTool = (id: string, p: Partial<LibraryTool>) => setM((x) => ({ ...x, tools: x.tools.map((tl) => (tl.id === id ? { ...tl, ...p } : tl)) }));
  const addTool = () => setM((x) => {
    const number = Math.max(0, ...x.tools.map((tl) => tl.number)) + 1;
    return { ...x, tools: [...x.tools, { id: newId('t'), number, name: '3 mm flat end mill', type: 'flat', diameter: 3, flutes: 2, fluteLength: 12, stickout: 20 }] };
  });
  const removeTool = (id: string) => setM((x) => ({ ...x, tools: x.tools.filter((tl) => tl.id !== id), presets: x.presets.filter((p) => p.toolId !== id) }));

  const setPreset = (tool: LibraryTool, p: Partial<MaterialPreset>) => setM((x) => {
    const base = presetFor(tool, material, x.presets);
    const rest = x.presets.filter((q) => !(q.toolId === tool.id && q.material === material));
    return { ...x, presets: [...rest, { ...base, ...p }] };
  });
  const resetPreset = (tool: LibraryTool) => setM((x) => ({ ...x, presets: x.presets.filter((q) => !(q.toolId === tool.id && q.material === material)) }));

  const save = async () => {
    setSaving(true);
    const ok = await saveMachine(m, !machineId);
    setSaving(false);
    if (ok) onClose();
  };

  const th = { fontSize: 10.5, fontWeight: 600, color: t.textMute, textAlign: 'left' as const, padding: '4px 4px', letterSpacing: '0.4px' };
  const td = { padding: '3px 4px' };

  return (
    <Dialog
      title={`Tools · ${m.name}`} onClose={onClose} width={860}
      footer={
        <>
          {problems.length > 0 && <span style={{ fontSize: 12, color: t.danger, marginRight: 'auto' }}>{problems[0]}</span>}
          <Btn kind="ghost" onClick={onClose}>Cancel</Btn>
          <Btn kind="primary" onClick={save} disabled={saving || problems.length > 0}>{machineId ? 'Save' : 'Save as a new machine'}</Btn>
        </>
      }
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
        <Segmented value={tab} options={[{ value: 'tools', label: 'Tools' }, { value: 'presets', label: 'Cutting data' }]} onChange={setTab} />
        {tab === 'presets' && (
          <>
            <span style={{ fontSize: 12, color: t.textDim }}>in</span>
            <Select value={material} options={MATERIALS.map((x) => ({ value: x.id, label: x.name }))} onChange={setMaterial} />
          </>
        )}
      </div>

      {tab === 'tools' ? (
        <>
          <table style={{ borderCollapse: 'collapse', width: '100%', fontFamily: SANS }}>
            <thead>
              <tr>
                <th style={th}>T</th><th style={th}>NAME</th><th style={th}>TYPE</th><th style={th}>Ø MM</th>
                <th style={th}>FLUTES</th><th style={th}>FLUTE LENGTH</th><th style={th}>STICKOUT</th><th />
              </tr>
            </thead>
            <tbody>
              {m.tools.map((tl) => (
                <tr key={tl.id} style={{ borderTop: `1px solid ${t.border}` }}>
                  <td style={td}><NumInput value={tl.number} step={1} min={1} max={999} width={50} onChange={(v) => setTool(tl.id, { number: Math.round(v) })} /></td>
                  <td style={td}><input value={tl.name} onChange={(e) => setTool(tl.id, { name: e.target.value })} style={{ ...inputStyle(t, 190), fontFamily: SANS }} /></td>
                  <td style={td}><Select value={tl.type} options={TYPES} onChange={(v) => setTool(tl.id, { type: v })} /></td>
                  <td style={td}><NumInput value={tl.diameter} step={0.1} min={0.1} max={50} width={64} onChange={(v) => setTool(tl.id, { diameter: v })} /></td>
                  <td style={td}><NumInput value={tl.flutes} step={1} min={1} max={8} width={50} onChange={(v) => setTool(tl.id, { flutes: Math.round(v) })} /></td>
                  <td style={td}><NumInput value={tl.fluteLength} step={1} min={0.5} max={200} width={64} onChange={(v) => setTool(tl.id, { fluteLength: v })} /></td>
                  <td style={td}><NumInput value={tl.stickout} step={1} min={1} max={300} width={64} onChange={(v) => setTool(tl.id, { stickout: v })} /></td>
                  <td style={td}><Btn kind="ghost" small onClick={() => removeTool(tl.id)}>Remove</Btn></td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ marginTop: 10 }}><Btn small onClick={addTool}>+ Add a tool</Btn></div>
        </>
      ) : (
        <>
          <p style={{ fontSize: 12, color: t.textDim, marginTop: 0 }}>
            The feed is never typed: it is chip load × flutes × rpm. Changed rows are amber; Reset goes back to the shipped figures.
          </p>
          <table style={{ borderCollapse: 'collapse', width: '100%', fontFamily: SANS }}>
            <thead>
              <tr>
                <th style={th}>TOOL</th><th style={th}>RPM</th><th style={th}>CHIP LOAD</th><th style={th}>DEPTH / PASS</th>
                <th style={th}>STEPOVER</th><th style={th}>PLUNGE %</th><th style={th}>RAMP °</th><th style={th}>FEED</th><th />
              </tr>
            </thead>
            <tbody>
              {m.tools.map((tl) => {
                const p = presetFor(tl, material, m.presets);
                const edited = m.presets.some((q) => q.toolId === tl.id && q.material === material);
                const feed = Math.round(p.chipLoad * tl.flutes * p.rpm);
                const shipped = shippedPreset(tl, material);
                return (
                  <tr key={tl.id} style={{ borderTop: `1px solid ${t.border}` }}>
                    <td style={{ ...td, fontSize: 12 }}>
                      <span style={{ display: 'inline-block', width: 7, height: 7, borderRadius: '50%', background: edited ? t.part : t.textMute, marginRight: 6 }} />
                      <span style={{ fontFamily: MONO }}>T{tl.number}</span> {tl.name}
                    </td>
                    <td style={td}><NumInput value={p.rpm} step={500} min={1000} max={60000} width={74} onChange={(v) => setPreset(tl, { rpm: v })} /></td>
                    <td style={td}><NumInput value={p.chipLoad} step={0.005} min={0.001} max={0.5} width={70} onChange={(v) => setPreset(tl, { chipLoad: v })} /></td>
                    <td style={td}><NumInput value={p.depthPerPass} step={0.1} min={0.05} max={50} width={64} onChange={(v) => setPreset(tl, { depthPerPass: v })} /></td>
                    <td style={td}><NumInput value={p.stepover} step={0.05} min={0.05} max={0.95} width={60} onChange={(v) => setPreset(tl, { stepover: v })} /></td>
                    <td style={td}><NumInput value={p.plungePercent} step={5} min={5} max={100} width={56} onChange={(v) => setPreset(tl, { plungePercent: v })} /></td>
                    <td style={td}><NumInput value={p.rampAngle} step={0.5} min={0.5} max={20} width={56} onChange={(v) => setPreset(tl, { rampAngle: v })} /></td>
                    <td style={{ ...td, fontFamily: MONO, fontSize: 12, color: t.textDim }} title={`${p.chipLoad} × ${tl.flutes} × ${p.rpm}`}>{feed}</td>
                    <td style={td}>
                      {edited && <Btn kind="ghost" small onClick={() => resetPreset(tl)} title={`Shipped: ${shipped.rpm} rpm, ${shipped.chipLoad} mm/tooth, ${shipped.depthPerPass} mm/pass`}>Reset</Btn>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </>
      )}
    </Dialog>
  );
}
