import type { DialSetting, PostProcessorSettings } from '@/types/cam';
import { DEFAULT_POST } from '@/types/cam';
import {
  type CamMachine,
  type CoolantOutput,
  type MaterialPreset,
  type ToolChangeMethod,
  createDefaultMachine,
  isMaterial,
} from './setup';
import { normalizeTools } from './resolve';

/**
 * Machines are saved as CAM profiles ({ version: 2, machine }). Profiles from
 * before machines ({ cutting, postProcessor }) become the default machine with
 * their G-code header and footer and their tool. Only the user edits a
 * machine: nothing from the AI reaches here.
 */

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const num = (v: unknown, lo: number, hi: number, fallback: number) =>
  typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : fallback;

function normalizePost(raw: unknown): PostProcessorSettings {
  if (!isObj(raw)) return { ...DEFAULT_POST };
  return {
    dialect: 'grbl',
    decimalPlaces: Number.isInteger(raw.decimalPlaces) ? num(raw.decimalPlaces, 0, 6, DEFAULT_POST.decimalPlaces) : DEFAULT_POST.decimalPlaces,
    header: typeof raw.header === 'string' ? raw.header : DEFAULT_POST.header,
    footer: typeof raw.footer === 'string' ? raw.footer : DEFAULT_POST.footer,
  };
}

function normalizeDial(raw: unknown): DialSetting[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(isObj)
    .filter((d) => typeof d.setting === 'string' && d.setting.trim() !== '' && typeof d.rpm === 'number' && d.rpm > 0)
    .map((d) => ({ setting: (d.setting as string).trim(), rpm: d.rpm as number }))
    .sort((a, b) => a.rpm - b.rpm);
}

function normalizePresets(raw: unknown, toolIds: Set<string>): MaterialPreset[] {
  if (!Array.isArray(raw)) return [];
  const out: MaterialPreset[] = [];
  for (const p of raw) {
    if (!isObj(p) || typeof p.toolId !== 'string' || !toolIds.has(p.toolId) || !isMaterial(p.material)) continue;
    out.push({
      toolId: p.toolId,
      material: p.material,
      rpm: num(p.rpm, 1000, 60000, 18000),
      chipLoad: num(p.chipLoad, 0.001, 0.5, 0.03),
      depthPerPass: num(p.depthPerPass, 0.05, 50, 1),
      stepover: num(p.stepover, 0.05, 0.95, 0.4),
      plungePercent: num(p.plungePercent, 5, 100, 30),
      rampAngle: num(p.rampAngle, 0.5, 20, 5),
    });
  }
  return out;
}

export function normalizeMachine(raw: unknown, name?: string): CamMachine {
  const base = createDefaultMachine();
  if (name) base.name = name;
  if (!isObj(raw)) return base;

  if (raw.version !== 2 || !isObj(raw.machine)) {
    // A profile from before machines: keep its header/footer and its tool.
    base.post = normalizePost(raw.postProcessor);
    const cutting = isObj(raw.cutting) ? raw.cutting : null;
    const tool = cutting && isObj(cutting.tool) ? cutting.tool : null;
    if (tool && typeof tool.diameter === 'number') {
      const [t] = normalizeTools([{ ...tool, id: 'profile-tool', flutes: tool.fluteCount, number: 1 }]);
      if (t && !base.tools.some((x) => x.type === t.type && Math.abs(x.diameter - t.diameter) < 0.01 && x.flutes === t.flutes)) {
        t.number = Math.max(...base.tools.map((x) => x.number)) + 1;
        base.tools.push(t);
      }
    }
    return base;
  }

  const m = raw.machine;
  const travel = isObj(m.travel) ? m.travel : {};
  const spindle = isObj(m.spindle) ? m.spindle : {};
  const dial = normalizeDial(spindle.dial);
  const park = isObj(m.park) && typeof m.park.x === 'number' && typeof m.park.y === 'number' ? { x: m.park.x, y: m.park.y } : null;
  const tools = Array.isArray(m.tools) ? normalizeTools(m.tools) : base.tools;
  const safeZ = num(m.safeZ, 0.5, 100, base.safeZ);
  return {
    name: typeof m.name === 'string' && m.name.trim() ? m.name.trim() : (name ?? base.name),
    post: normalizePost(m.post),
    travel: {
      x: num(travel.x, 10, 10000, base.travel.x),
      y: num(travel.y, 10, 10000, base.travel.y),
      z: num(travel.z, 5, 1000, base.travel.z),
    },
    maxRpm: num(m.maxRpm, 1000, 60000, base.maxRpm),
    spindle: spindle.kind === 'dial' && dial.length > 0 ? { kind: 'dial', dial } : { kind: 'gcode' },
    rapidRate: num(m.rapidRate, 100, 50000, base.rapidRate),
    toolChange: (['M0', 'M6', 'ATC'] as ToolChangeMethod[]).includes(m.toolChange as ToolChangeMethod) ? (m.toolChange as ToolChangeMethod) : base.toolChange,
    safeZ,
    clearanceZ: Math.max(num(m.clearanceZ, 0.5, 200, base.clearanceZ), safeZ),
    park,
    coolant: (['none', 'M7', 'M8'] as CoolantOutput[]).includes(m.coolant as CoolantOutput) ? (m.coolant as CoolantOutput) : 'none',
    spoilboardAllowance: num(m.spoilboardAllowance, 0, 5, base.spoilboardAllowance),
    tools,
    presets: normalizePresets(m.presets, new Set(tools.map((t) => t.id))),
  };
}

/** What a machine is saved as in its CAM profile. */
export function machineProfileConfig(machine: CamMachine): Record<string, unknown> {
  return { version: 2, machine: machine as unknown as Record<string, unknown> };
}

/** Problems with a machine as typed in Edit machine, or [] when it can be saved. */
export function machineProblems(m: CamMachine): string[] {
  const out: string[] = [];
  if (!m.name.trim()) out.push('Give the machine a name');
  if (m.clearanceZ < m.safeZ) out.push('The clearance height must be at least the safe height');
  if (m.spindle.kind === 'dial' && m.spindle.dial.length === 0) out.push('A dial spindle needs at least one dial setting');
  const numbers = m.tools.map((t) => t.number);
  if (new Set(numbers).size !== numbers.length) out.push('Two tools have the same number');
  return out;
}
