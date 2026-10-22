import type { Entity, Point } from '@/types/document';
import type {
  CamIssue,
  CamJobConfig,
  CamOperation,
  CamTool,
  DialSetting,
  JobMachineOptions,
  OperationCuttingParams,
} from '@/types/cam';
import { normalizeCamJobConfig } from '@/types/cam';
import { entityToSegments } from './entityToSegments';
import { groupContours, nestingDepths, orientCounterClockwise } from './contours';
import { toolpathPocket } from './toolpathPocket';
import { toolpathProfile } from './toolpathProfile';
import { nearestDial } from './gcodeEmitter';
import { arcMidpoint } from '@/utils/arcGeometry';
import {
  type CamJobSetup,
  type CamJobV2,
  type CamMachine,
  type Entry,
  type HoleMethod,
  type LibraryTool,
  type MaterialId,
  type MaterialPreset,
  type OpOverrides,
  type OverrideKey,
  type PlanOperation,
  type SetupPrev,
  type StockPoint,
  OVERRIDE_KEYS,
  createDefaultJob,
  createDefaultSetup,
  isMaterial,
  materialName,
  newId,
  presetFor,
} from './setup';

/**
 * The one place settings are worked out. An operation's value for each field
 * is, in order: what was set on the operation (by the user or the AI), else
 * what the job and the machine give (the material preset for its tool, the
 * stock, the machine), else a default derived from the shapes. Every value
 * says where it came from, for the source dots in the UI. The toolpaths are
 * built only from these resolved values.
 */

// ── Sources ──

export type SourceKind = 'inherited' | 'set' | 'ai';

export interface Field<T> {
  value: T;
  kind: SourceKind;
  /** Where the value came from: "Birch ply × T1", "machine", "stock 6 + 0.3 allowance", "set here", "AI". */
  source: string;
  /** The value it would have without the override, and where that comes from. */
  base: T;
  baseSource: string;
}

export interface ResolvedFields {
  toolId: Field<string>;
  depth: Field<number>;
  depthPerPass: Field<number>;
  lastPassDepth: Field<number>;
  rpm: Field<number>;
  chipLoad: Field<number>;
  plungePercent: Field<number>;
  stepover: Field<number>;
  entry: Field<Entry>;
  rampAngle: Field<number>;
  cutDirection: Field<'climb' | 'conventional'>;
  tabs: Field<boolean>;
  tabCount: Field<number>;
  tabWidth: Field<number>;
  tabHeight: Field<number>;
  holeMethod: Field<HoleMethod>;
  peckDepth: Field<number>;
  dwell: Field<number>;
}

export interface ResolvedOp {
  op: PlanOperation;
  tool: LibraryTool | null;
  fields: ResolvedFields;
  /** Cutting feed, mm/min: chip load × flutes × rpm, capped at the machine's rapid rate. */
  feed: number;
  feedCapped: boolean;
  plunge: number;
  /** The rpm actually asked for (the dial setting's on a dial spindle). */
  rpm: number;
  dial: DialSetting | null;
  /** An outside profile cut right through: it frees the part, so it goes last. */
  partFreeing: boolean;
  /** Why it can't be cut (no tool fits, no shapes…), or null. */
  problem: string | null;
  /** Not fatal, but worth saying (a set tool that's gone…). */
  notes: string[];
  /** What the toolpath code gets, or null when there's a problem. */
  cam: CamOperation | null;
}

export interface ResolveContext {
  job: CamJobV2;
  machine: CamMachine;
  /** All tools: the machine's library and the job's own. */
  tools: LibraryTool[];
  presets: MaterialPreset[];
  /** The shapes of the job's sketches. */
  entities: Entity[];
}

// ── Small helpers ──

const ALLOWED: Record<string, (v: unknown) => boolean> = {};
/** The range each number may take, lowest first; `true` when the lowest itself isn't allowed. */
const RANGES: Record<string, [number, number, boolean?]> = {
  depth: [0, 200, true], depthPerPass: [0, 50, true], lastPassDepth: [0, 5], rpm: [1000, 60000],
  chipLoad: [0, 0.5, true], plungePercent: [1, 100], stepover: [0.05, 0.95], rampAngle: [0.5, 20],
  tabWidth: [0, 50, true], tabHeight: [0, 50, true], peckDepth: [0, 50], dwell: [0, 10],
};
for (const [k, [lo, hi, loOpen]] of Object.entries(RANGES)) {
  ALLOWED[k] = (v) => typeof v === 'number' && Number.isFinite(v) && (loOpen ? v > lo : v >= lo) && v <= hi;
}
ALLOWED.toolId = (v) => typeof v === 'string' && v.length > 0 && v.length < 100;
ALLOWED.entry = (v) => v === 'plunge' || v === 'ramp';
ALLOWED.cutDirection = (v) => v === 'climb' || v === 'conventional';
ALLOWED.tabs = (v) => typeof v === 'boolean';
ALLOWED.tabCount = (v) => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 20;
ALLOWED.holeMethod = (v) => v === 'drill' || v === 'helix';

/** Keep only overrides with known keys and sensible values. */
export function normalizeOverrides(raw: unknown, dropped?: string[]): OpOverrides {
  const out: Record<string, unknown> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (v === undefined || v === null) continue;
    if ((OVERRIDE_KEYS as string[]).includes(k) && ALLOWED[k]!(v)) out[k] = v;
    else dropped?.push(k);
  }
  return out as OpOverrides;
}

export function allTools(machine: CamMachine, setup: CamJobSetup): LibraryTool[] {
  return [...machine.tools, ...setup.tools.filter((t) => !machine.tools.some((m) => m.id === t.id))];
}

export const toolTag = (t: LibraryTool) => `T${t.number}`;
const near = (a: number, b: number) => Math.abs(a - b) <= Math.max(0.05, 0.02 * b);
const fmtMm = (v: number) => `${Number(v.toFixed(2))}`;

/** The shapes' extent, or null when there are none. */
export function shapeBounds(entities: Entity[]): { x0: number; y0: number; x1: number; y1: number } | null {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const add = (p: Point) => { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); };
  // Arcs are split in eighths: close enough for placing the stock.
  const addArc = (a: Point, b: Point, bulge: number, depth: number) => {
    add(a); add(b);
    if (Math.abs(bulge) < 1e-9 || depth === 0) return;
    const m = arcMidpoint(a, b, bulge);
    const half = Math.tan(Math.atan(bulge) / 2);
    addArc(a, m, half, depth - 1);
    addArc(m, b, half, depth - 1);
  };
  const ids = entities.filter((e) => !('construction' in e && e.construction)).map((e) => e.id);
  for (const s of entityToSegments(entities, ids)) addArc(s.from, s.to, s.bulge, 3);
  return x0 === Infinity ? null : { x0, y0, x1, y1 };
}

/** Room left round the shapes when the stock size isn't given, each side. */
export const STOCK_MARGIN = 10;

/** The stock on the sketch: a rectangle centred on the shapes. */
export function stockRect(setup: CamJobSetup, entities: Entity[]) {
  const b = shapeBounds(entities) ?? { x0: 0, y0: 0, x1: 100, y1: 100 };
  const w = setup.stock.width ?? b.x1 - b.x0 + 2 * STOCK_MARGIN;
  const h = setup.stock.height ?? b.y1 - b.y0 + 2 * STOCK_MARGIN;
  const cx = (b.x0 + b.x1) / 2;
  const cy = (b.y0 + b.y1) / 2;
  return { x: cx - w / 2, y: cy - h / 2, width: w, height: h };
}

/** Where a stock point is on the sketch. Front is the bottom of the screen (sketch y max). */
export function stockPoint(rect: { x: number; y: number; width: number; height: number }, point: StockPoint): Point {
  if (point === 'centre') return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  const [fb, lr] = point.split('-') as ['front' | 'back', 'left' | 'centre' | 'right'];
  const x = lr === 'left' ? rect.x : lr === 'right' ? rect.x + rect.width : rect.x + rect.width / 2;
  const y = fb === 'front' ? rect.y + rect.height : rect.y;
  return { x, y };
}

export function originPoint(setup: CamJobSetup, entities: Entity[]): Point {
  return setup.origin.kind === 'picked' ? { x: setup.origin.x, y: setup.origin.y } : stockPoint(stockRect(setup, entities), setup.origin.point);
}

// ── Derived defaults ──

interface Derived<T> { value: T; source: string }

const flats = (tools: LibraryTool[]) => tools.filter((t) => t.type === 'flat').sort((a, b) => a.number - b.number);
const circlesOf = (op: PlanOperation, entities: Entity[]) =>
  entities.filter((e): e is Extract<Entity, { type: 'circle' }> => e.type === 'circle' && op.entityIds.includes(e.id));

const fitCache = new Map<string, boolean>();

/** Whether the tool clears the pocket (or cuts the inside profile) with nothing left uncut. */
function fits(op: PlanOperation, entities: Entity[], tool: LibraryTool): boolean {
  const key = `${op.kind}|${op.cutSide}|${tool.diameter}|${op.entityIds.join(',')}|${entities.filter((e) => op.entityIds.includes(e.id)).map((e) => JSON.stringify(e)).join()}`;
  const hit = fitCache.get(key);
  if (hit !== undefined) return hit;
  const segs = entityToSegments(entities, op.entityIds);
  let ok = segs.length > 0;
  if (ok && op.kind === 'pocket') {
    const r = toolpathPocket(segs, tool.diameter, 0.4, 'climb', 1000);
    ok = !r.problem && !r.warning;
  } else if (ok) {
    const contours = groupContours(segs).map(orientCounterClockwise);
    const depths = nestingDepths(contours);
    ok = contours.every((c, i) => {
      const side = depths[i]! % 2 === 0 ? 'inside' : 'outside';
      return !toolpathProfile(c, tool.diameter, side, 'climb', 1000).problem;
    });
  }
  if (fitCache.size > 500) fitCache.clear();
  fitCache.set(key, ok);
  return ok;
}

/** The tool an operation gets when none is set, or a reason there is none. */
function deriveTool(op: PlanOperation, ctx: ResolveContext, inUse: LibraryTool[]): Derived<LibraryTool | null> & { problem?: string; method?: HoleMethod } {
  const { tools, entities } = ctx;
  // Bits whose flutes reach the depth come first.
  const depthNeeded = op.overrides.depth ?? deriveDepth(op, ctx).value;
  const reaches = (t: LibraryTool) => t.fluteLength >= depthNeeded - 1e-9;
  const byReach = (list: LibraryTool[]) => [...list.filter(reaches), ...list.filter((t) => !reaches(t))];
  const flatTools = byReach(flats(tools));
  const usedFlats = byReach(inUse.filter((t) => t.type === 'flat'));

  if (op.kind === 'drill') {
    const holes = circlesOf(op, entities).map((c) => c.radius * 2);
    if (holes.length === 0) return { value: flatTools[0] ?? null, source: 'no holes chosen yet' };
    const lo = Math.min(...holes);
    const hi = Math.max(...holes);
    const drillBit = lo === hi || near(lo, hi)
      ? tools.filter((t) => t.type === 'drill' && near(t.diameter, lo)).sort((a, b) => Math.abs(a.diameter - lo) - Math.abs(b.diameter - lo))[0]
      : undefined;
    if (drillBit) return { value: drillBit, source: `${toolTag(drillBit)} matches the ${fmtMm(lo)}mm holes`, method: 'drill' };
    // A helix needs a tool smaller than the smallest hole, at least half the largest.
    const helixOk = (t: LibraryTool) => t.diameter < lo - 0.02 && 2 * t.diameter >= hi - 1e-9;
    const helix = usedFlats.find(helixOk) ?? [...flatTools].sort((a, b) => b.diameter - a.diameter).find(helixOk);
    if (helix) {
      return {
        value: helix,
        source: `${toolTag(helix)}${usedFlats.includes(helix) ? ' (in use)' : ''}: no drill bit is ${fmtMm(lo)}mm, so it bores the holes`,
        method: 'helix',
      };
    }
    const sameSize = flatTools.find((t) => near(t.diameter, lo) && (lo === hi || near(lo, hi)));
    if (sameSize) return { value: sameSize, source: `${toolTag(sameSize)} is the holes' size: it plunges`, method: 'drill' };
    return {
      value: null,
      source: 'no tool',
      problem: `No tool can make ${lo === hi ? `${fmtMm(lo)}mm holes` : `holes from ${fmtMm(lo)} to ${fmtMm(hi)}mm`}: add a ${fmtMm(lo)}mm drill to the tool library, or an end mill between ${fmtMm(hi / 2)} and ${fmtMm(lo)}mm`,
    };
  }

  if (op.kind === 'pocket' || (op.kind === 'profile' && op.cutSide === 'inside')) {
    if (op.entityIds.length === 0) return { value: usedFlats[0] ?? flatTools[0] ?? null, source: 'no shapes chosen yet' };
    const fitting = [...flatTools].sort((a, b) => b.diameter - a.diameter).filter((t) => fits(op, entities, t));
    const largest = fitting.find(reaches) ?? fitting[0];
    if (!largest) {
      return { value: null, source: 'no tool', problem: `No end mill in the library is small enough for ${op.kind === 'pocket' ? 'this pocket' : 'these shapes'}: add a smaller one` };
    }
    // A bit already in use saves a tool change, if it isn't much smaller (and reaches, if the largest does).
    const used = usedFlats.filter((t) => t.diameter >= largest.diameter / 2 && (reaches(t) || !reaches(largest)) && fits(op, entities, t)).sort((a, b) => b.diameter - a.diameter)[0];
    if (used) return { value: used, source: `${toolTag(used)} (in use, fits)` };
    return { value: largest, source: `${toolTag(largest)} (largest that fits)` };
  }

  // Outside and on-the-line cuts, and facing: a bit in use, else the first end mill.
  if (op.kind === 'facing') {
    const big = [...flatTools].sort((a, b) => Number(reaches(b)) - Number(reaches(a)) || b.diameter - a.diameter)[0];
    if (big) return { value: big, source: `${toolTag(big)} (largest end mill)` };
  }
  if (usedFlats[0]) return { value: usedFlats[0], source: `${toolTag(usedFlats[0])} (in use)` };
  const first = flatTools[0] ?? [...tools].sort((a, b) => a.number - b.number)[0];
  if (!first) return { value: null, source: 'no tool', problem: 'The tool library is empty: add a tool in Setup → Manage tools' };
  return { value: first, source: `${toolTag(first)} (first end mill)` };
}

function deriveDepth(op: PlanOperation, ctx: ResolveContext, tool?: LibraryTool | null): Derived<number> {
  const t = ctx.job.setup.stock.thickness;
  const allowance = ctx.machine.spoilboardAllowance;
  const through = { value: Number((t + allowance).toFixed(4)), source: `stock ${fmtMm(t)} + ${fmtMm(allowance)} allowance` };
  switch (op.kind) {
    case 'profile':
      return op.cutSide === 'on' ? { value: Math.min(0.5, t), source: 'default for cuts on the line' } : through;
    case 'drill': {
      // A drill's point is about 0.3 × its diameter long: go that much further so the hole is full size at the bottom.
      if (tool?.type !== 'drill') return through;
      const point = 0.3 * tool.diameter;
      return { value: Number((t + allowance + point).toFixed(4)), source: `${through.source} + ${fmtMm(point)} drill point` };
    }
    case 'pocket':
      return { value: Number((t / 2).toFixed(4)), source: `half the stock (${fmtMm(t)})` };
    case 'facing':
      return { value: Math.min(0.5, t), source: 'default skim' };
  }
}

/** Ramp in by default where plunging is hard on the bit. */
const rampsByDefault = (m: MaterialId) => m === 'acrylic' || m === 'aluminium-6061';

// ── Resolving one operation ──

export function resolve(
  op: PlanOperation,
  job: CamJobV2,
  machine: CamMachine,
  tools: LibraryTool[],
  presets: MaterialPreset[],
  entities: Entity[] = [],
  inUse: LibraryTool[] = [],
): ResolvedOp {
  const ctx: ResolveContext = { job, machine, tools, presets, entities };
  const o = op.overrides;
  const notes: string[] = [];
  const material = job.setup.material;
  const t = job.setup.stock.thickness;

  function field<T>(key: OverrideKey, base: Derived<T>): Field<T> {
    const set = o[key] as T | undefined;
    if (set === undefined) return { value: base.value, kind: 'inherited', source: base.source, base: base.value, baseSource: base.source };
    const ai = op.ai.includes(key);
    return { value: set, kind: ai ? 'ai' : 'set', source: ai ? 'AI' : 'set here', base: base.value, baseSource: base.source };
  }

  // Tool
  const derived = deriveTool(op, ctx, inUse);
  let tool = derived.value;
  let toolField: Field<string>;
  const setTool = o.toolId !== undefined ? tools.find((x) => x.id === o.toolId) : undefined;
  if (o.toolId !== undefined && !setTool) notes.push('The tool set here is no longer in the library; using the default');
  if (setTool) {
    tool = setTool;
    const ai = op.ai.includes('toolId');
    toolField = { value: setTool.id, kind: ai ? 'ai' : 'set', source: ai ? 'AI' : 'set here', base: derived.value?.id ?? '', baseSource: derived.source };
  } else {
    toolField = { value: tool?.id ?? '', kind: 'inherited', source: derived.source, base: tool?.id ?? '', baseSource: derived.source };
  }
  let problem: string | null = setTool ? null : derived.problem ?? null;

  const preset = tool ? presetFor(tool, material, presets) : null;
  const edited = tool ? presets.some((p) => p.toolId === tool!.id && p.material === material) : false;
  const presetSource = tool ? `${materialName(material)} × ${toolTag(tool)}${edited ? ' (edited)' : ''}` : 'no tool';
  const fromPreset = <K extends 'depthPerPass' | 'chipLoad' | 'plungePercent' | 'stepover' | 'rampAngle'>(k: K): Derived<number> =>
    ({ value: preset ? preset[k] : 1, source: presetSource });

  const depth = field('depth', deriveDepth(op, ctx, tool));
  const depthPerPass = field('depthPerPass', fromPreset('depthPerPass'));
  const lastPassDepth = field('lastPassDepth', { value: 0, source: 'none' });

  // Speed: the preset's, no faster than the machine goes.
  let rpmBase: Derived<number> = { value: preset?.rpm ?? 12000, source: presetSource };
  if (rpmBase.value > machine.maxRpm) rpmBase = { value: machine.maxRpm, source: `machine max (${presetSource} asks ${rpmBase.value})` };
  const rpmField = field('rpm', rpmBase);
  const dialTable = machine.spindle.kind === 'dial' ? machine.spindle.dial : null;
  const dial = dialTable ? nearestDial(dialTable, rpmField.value) : null;
  const rpm = Math.min(dial ? dial.rpm : rpmField.value, dial ? Infinity : machine.maxRpm);

  const chipLoad = field('chipLoad', fromPreset('chipLoad'));
  const plungePercent = field('plungePercent', fromPreset('plungePercent'));
  const stepover = field('stepover', fromPreset('stepover'));
  const entry = field<Entry>('entry', op.kind === 'profile'
    ? (rampsByDefault(material) ? { value: 'ramp', source: `${materialName(material)} default` } : { value: 'plunge', source: 'default' })
    : { value: 'plunge', source: 'only profiles ramp in' });
  const rampAngle = field('rampAngle', fromPreset('rampAngle'));
  const cutDirection = field<'climb' | 'conventional'>('cutDirection', { value: 'climb', source: 'default' });
  const outsideThrough = op.kind === 'profile' && op.cutSide === 'outside' && depth.value >= t - 1e-9;
  const tabs = field('tabs', outsideThrough
    ? { value: true, source: 'outside cut goes through' }
    : { value: false, source: op.kind === 'profile' ? 'not a through cut round the outside' : 'profiles only' });
  const tabCount = field('tabCount', { value: 4, source: 'default' });
  const tabWidth = field('tabWidth', { value: 5, source: 'default' });
  const tabHeightBase = Number((machine.spoilboardAllowance + Math.min(Math.max(0.25 * t, 1), 3)).toFixed(2));
  const tabHeight = field('tabHeight', { value: Math.min(tabHeightBase, Math.max(depth.value - 0.5, 0.1)), source: `stock ${fmtMm(t)}` });
  const holeMethod = field<HoleMethod>('holeMethod', {
    value: derived.method ?? (tool?.type === 'drill' ? 'drill' : 'helix'),
    source: derived.method ? 'from the tool' : tool?.type === 'drill' ? 'drill bit' : 'end mill',
  });
  const peckDepth = field('peckDepth', { value: tool?.type === 'drill' ? Math.min(tool.diameter, t) : 0, source: tool?.type === 'drill' ? 'one diameter' : 'none' });
  const dwell = field('dwell', { value: 0, source: 'none' });

  const fields: ResolvedFields = {
    toolId: toolField, depth, depthPerPass, lastPassDepth, rpm: rpmField, chipLoad, plungePercent, stepover,
    entry, rampAngle, cutDirection, tabs, tabCount, tabWidth, tabHeight, holeMethod, peckDepth, dwell,
  };

  // Feed comes from the chip load, never typed.
  const flutes = tool?.flutes ?? 2;
  const rawFeed = chipLoad.value * flutes * rpm;
  const feed = Math.min(rawFeed, machine.rapidRate);
  const feedCapped = rawFeed > machine.rapidRate + 1e-9;
  const plunge = feed * (plungePercent.value / 100);

  const partFreeing = outsideThrough;

  if (!problem && op.kind !== 'facing' && op.entityIds.length === 0) problem = 'No shapes chosen: click shapes on the sketch';
  if (!problem && !tool) problem = 'No tool';
  if (!problem && op.kind === 'drill' && holeMethod.value === 'drill' && tool && tool.type !== 'drill' && tool.type !== 'flat') {
    problem = `A ${tool.type} bit can't drill`;
  }
  // Reach: past the flutes the shank rubs; past the stickout the collet hits the stock.
  if (!problem && tool && op.kind !== 'facing') {
    if (depth.value > tool.stickout + 1e-9) {
      problem = `${fmtMm(depth.value)}mm deep, but ${toolTag(tool)} sticks out only ${fmtMm(tool.stickout)}mm from the collet: use a longer bit, or cut less deep`;
    } else if (depth.value > tool.fluteLength + 1e-9) {
      notes.push(`${fmtMm(depth.value)}mm deep, past ${toolTag(tool)}'s ${fmtMm(tool.fluteLength)}mm flutes: the shank rubs in the cut`);
    }
  }

  let cam: CamOperation | null = null;
  if (!problem && tool) {
    const camTool: CamTool = {
      id: tool.id, name: tool.name, diameter: tool.diameter, type: tool.type,
      fluteCount: tool.flutes, fluteLength: tool.fluteLength, number: tool.number,
    };
    const cutting: OperationCuttingParams = {
      tool: camTool,
      spindleSpeed: rpm,
      feedRate: feed,
      plungeRate: plunge,
      safeZ: machine.safeZ,
      depth: { totalDepth: depth.value, depthPerPass: depthPerPass.value, finalPassAllowance: lastPassDepth.value },
    };
    const common = { entityIds: op.entityIds, sketchId: op.sketchId, cutting };
    switch (op.kind) {
      case 'profile':
        cam = {
          ...common, kind: 'profile', cutSide: op.cutSide, cutDirection: cutDirection.value,
          tabs: tabs.value, tabCount: tabCount.value, tabWidth: tabWidth.value, tabHeight: tabHeight.value,
          ...(entry.value === 'ramp' ? { rampAngle: rampAngle.value } : {}),
        };
        break;
      case 'pocket':
        cam = { ...common, kind: 'pocket', stepover: stepover.value, cutDirection: cutDirection.value };
        break;
      case 'facing':
        cam = { ...common, kind: 'facing', stepover: stepover.value, cutDirection: cutDirection.value };
        break;
      case 'drill':
        cam = { ...common, kind: 'drill', peckDepth: peckDepth.value, dwell: dwell.value, method: holeMethod.value, rampAngle: rampAngle.value };
        break;
    }
  }

  return { op, tool, fields, feed, feedCapped, plunge, rpm, dial, partFreeing, problem, notes, cam };
}

// ── Resolving the job ──

export interface ResolvedJob {
  ops: ResolvedOp[];
  /** For the toolpath code. Its operations are the plan's that can be cut, in plan order. */
  config: CamJobConfig;
  /** configOpIds[i]: the plan operation config.operations[i] came from. */
  configOpIds: string[];
  stock: { x: number; y: number; width: number; height: number };
  origin: Point;
  /** Problems with the plan as a whole (order, unknown tools). Not from the toolpaths. */
  issues: (CamIssue & { opId?: string })[];
  toolChanges: number;
  setupMissing: string[];
}

export function resolveJob(job: CamJobV2, machine: CamMachine, entities: Entity[]): ResolvedJob {
  const tools = allTools(machine, job.setup);
  const ops: ResolvedOp[] = [];
  const inUse: LibraryTool[] = [];
  // Tools set anywhere count as in use from the start.
  for (const op of job.operations) {
    const t = tools.find((x) => x.id === op.overrides.toolId);
    if (t && !inUse.includes(t)) inUse.push(t);
  }
  for (const op of job.operations) {
    const r = resolve(op, job, machine, tools, machine.presets, entities, inUse);
    if (r.tool && !inUse.includes(r.tool)) inUse.push(r.tool);
    ops.push(r);
  }

  const stock = stockRect(job.setup, entities);
  const origin = originPoint(job.setup, entities);
  const cuttable = ops.filter((r) => r.cam);
  const options: JobMachineOptions = {
    clearanceZ: machine.clearanceZ,
    park: machine.park,
    toolChange: machine.toolChange,
    coolant: machine.coolant,
    dial: machine.spindle.kind === 'dial' ? machine.spindle.dial : null,
    spoilboardAllowance: machine.spoilboardAllowance,
  };
  const config: CamJobConfig = {
    profileId: job.setup.machineId,
    stock: { thickness: job.setup.stock.thickness, zTop: job.setup.zZero === 'spoilboard' ? job.setup.stock.thickness : 0, area: stock },
    postProcessor: job.setup.legacyPost ?? machine.post,
    useFloodCoolant: machine.coolant === 'M8',
    selectedSketchIds: job.setup.selectedSketchIds,
    operations: cuttable.map((r) => r.cam!),
    origin,
    machine: options,
    clamps: job.setup.clamps,
  };

  const issues: ResolvedJob['issues'] = [];
  ops.forEach((r, i) => {
    if (r.problem) issues.push({ severity: 'error', message: `Operation ${i + 1}: ${r.problem}`, opId: r.op.id });
    for (const n of r.notes) issues.push({ severity: 'warning', message: `Operation ${i + 1}: ${n}`, opId: r.op.id });
    if (r.feedCapped) {
      issues.push({ severity: 'info', message: `Operation ${i + 1}: the feed is capped at the machine's ${machine.rapidRate} mm/min`, opId: r.op.id });
    }
  });
  const firstFreeing = ops.findIndex((r) => r.partFreeing);
  if (firstFreeing >= 0) {
    const later = ops.findIndex((r, i) => i > firstFreeing && !r.partFreeing && r.cam);
    if (later >= 0) {
      issues.push({
        severity: 'warning',
        message: `Operation ${firstFreeing + 1} cuts the part free before operation ${later + 1} runs: the part may move. Put the cut-out last`,
        opId: ops[firstFreeing]!.op.id,
      });
    }
  }

  let toolChanges = 0;
  for (let i = 1; i < cuttable.length; i++) if (cuttable[i]!.tool?.id !== cuttable[i - 1]!.tool?.id) toolChanges++;

  const setupMissing: string[] = [];
  if (!(job.setup.stock.thickness > 0)) setupMissing.push('stock thickness');
  if (job.setup.selectedSketchIds.length === 0) setupMissing.push('a sketch to cut');
  if (tools.length === 0) setupMissing.push('a tool');

  return { ops, config, configOpIds: cuttable.map((r) => r.op.id), stock, origin, issues, toolChanges, setupMissing };
}

/**
 * Cutting order: everything else before outside profiles, then by tool (fewer
 * changes), and the cuts that free the part last. Stable otherwise.
 */
export function cuttingOrder(job: CamJobV2, machine: CamMachine, entities: Entity[]): PlanOperation[] {
  const resolved = resolveJob(job, machine, entities).ops;
  const keyed = resolved.map((r, i) => ({
    op: r.op,
    key: [r.partFreeing ? 1 : 0, r.op.kind === 'profile' && r.op.cutSide === 'outside' ? 1 : 0, r.tool?.number ?? 999, i],
  }));
  keyed.sort((a, b) => {
    for (let k = 0; k < a.key.length; k++) if (a.key[k] !== b.key[k]) return a.key[k]! - b.key[k]!;
    return 0;
  });
  return keyed.map((k) => k.op);
}

/** A new operation for these shapes, with nothing set: everything comes from the levels above. */
export function newPlanOperation(kind: PlanOperation['kind'], sketchId: string, entityIds: string[] = [], cutSide: PlanOperation['cutSide'] = 'outside'): PlanOperation {
  return { id: newId('op'), kind, sketchId, entityIds, cutSide, status: 'accepted', overrides: {}, ai: [] };
}

// ── Saved jobs ──

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const pos = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback);
const STOCK_POINT_SET = new Set<string>(['front-left', 'front-centre', 'front-right', 'centre', 'back-left', 'back-centre', 'back-right']);

/** Tools from outside: only complete, sensible ones. */
export function normalizeTools(raw: unknown): LibraryTool[] {
  if (!Array.isArray(raw)) return [];
  const out: LibraryTool[] = [];
  for (const t of raw) {
    if (!isObj(t) || typeof t.id !== 'string') continue;
    const type = ['flat', 'ball', 'vbit', 'drill'].includes(t.type as string) ? (t.type as LibraryTool['type']) : 'flat';
    const diameter = pos(t.diameter, 0);
    if (!(diameter > 0 && diameter <= 50)) continue;
    out.push({
      id: t.id,
      number: Number.isInteger(t.number) && (t.number as number) > 0 ? (t.number as number) : out.length + 1,
      name: typeof t.name === 'string' ? t.name : `${diameter} mm ${type}`,
      type,
      diameter,
      flutes: Number.isInteger(t.flutes) && (t.flutes as number) >= 1 && (t.flutes as number) <= 8 ? (t.flutes as number) : 2,
      fluteLength: pos(t.fluteLength, diameter * 3),
      stickout: pos(t.stickout, diameter * 5),
    });
  }
  return out;
}

function normalizeSetup(raw: unknown): CamJobSetup {
  const base = createDefaultSetup();
  if (!isObj(raw)) return base;
  const stock = isObj(raw.stock) ? raw.stock : {};
  const origin = isObj(raw.origin) ? raw.origin : {};
  return {
    machineId: typeof raw.machineId === 'string' ? raw.machineId : null,
    material: isMaterial(raw.material) ? raw.material : base.material,
    stock: {
      width: typeof stock.width === 'number' && stock.width > 0 ? stock.width : null,
      height: typeof stock.height === 'number' && stock.height > 0 ? stock.height : null,
      thickness: pos(stock.thickness, base.stock.thickness),
    },
    origin: origin.kind === 'picked' && typeof origin.x === 'number' && typeof origin.y === 'number'
      ? { kind: 'picked', x: origin.x, y: origin.y }
      : { kind: 'stock', point: STOCK_POINT_SET.has(origin.point as string) ? (origin.point as StockPoint) : 'front-left' },
    zZero: raw.zZero === 'spoilboard' ? 'spoilboard' : 'stock-top',
    clamps: Array.isArray(raw.clamps)
      ? raw.clamps.filter(isObj).filter((c) => ['x', 'y', 'width', 'height', 'zHeight'].every((k) => typeof c[k] === 'number' && Number.isFinite(c[k])))
        .map((c) => ({ id: typeof c.id === 'string' ? c.id : newId('clamp'), x: c.x as number, y: c.y as number, width: c.width as number, height: c.height as number, zHeight: c.zHeight as number }))
      : [],
    selectedSketchIds: Array.isArray(raw.selectedSketchIds) ? raw.selectedSketchIds.filter((s): s is string => typeof s === 'string') : [],
    tools: normalizeTools(raw.tools),
    aiFields: Array.isArray(raw.aiFields) ? raw.aiFields.filter((f): f is CamJobSetup['aiFields'][number] => typeof f === 'string') : [],
    ...(isObj(raw.legacyPost) ? { legacyPost: raw.legacyPost as unknown as NonNullable<CamJobSetup['legacyPost']> } : {}),
    ...(isObj(raw.aiPending) ? { aiPending: normalizePending(raw.aiPending) } : {}),
  };
}

function normalizePending(raw: Record<string, unknown>): SetupPrev {
  const out: SetupPrev = {};
  const dim = (v: unknown) => v === null || (typeof v === 'number' && v > 0);
  if (isMaterial(raw.material)) out.material = raw.material;
  if (typeof raw.thickness === 'number' && raw.thickness > 0) out.thickness = raw.thickness;
  if ('width' in raw && dim(raw.width)) out.width = raw.width as number | null;
  if ('height' in raw && dim(raw.height)) out.height = raw.height as number | null;
  if (isObj(raw.origin)) {
    const o = raw.origin;
    if (o.kind === 'picked' && typeof o.x === 'number' && typeof o.y === 'number') out.origin = { kind: 'picked', x: o.x, y: o.y };
    else if (o.kind === 'stock' && STOCK_POINT_SET.has(o.point as string)) out.origin = { kind: 'stock', point: o.point as StockPoint };
  }
  if (raw.zZero === 'stock-top' || raw.zZero === 'spoilboard') out.zZero = raw.zZero;
  return out;
}

export function normalizePlanOperation(raw: unknown, fallbackSketch: string): PlanOperation | null {
  if (!isObj(raw) || !['profile', 'pocket', 'drill', 'facing'].includes(raw.kind as string)) return null;
  const overrides = normalizeOverrides(raw.overrides);
  return {
    id: typeof raw.id === 'string' ? raw.id : newId('op'),
    kind: raw.kind as PlanOperation['kind'],
    sketchId: typeof raw.sketchId === 'string' && raw.sketchId ? raw.sketchId : fallbackSketch,
    entityIds: Array.isArray(raw.entityIds) ? raw.entityIds.filter((s): s is string => typeof s === 'string') : [],
    cutSide: raw.cutSide === 'inside' || raw.cutSide === 'on' ? raw.cutSide : 'outside',
    status: raw.status === 'proposed' ? 'proposed' : 'accepted',
    ...(typeof raw.reason === 'string' ? { reason: raw.reason.slice(0, 500) } : {}),
    overrides,
    ai: Array.isArray(raw.ai) ? raw.ai.filter((k): k is OverrideKey => (OVERRIDE_KEYS as unknown[]).includes(k) && k in overrides) : [],
    ...(raw.status === 'proposed' && isObj(raw.aiPrev) ? { aiPrev: normalizeAiPrev(raw.aiPrev) } : {}),
  };
}

function normalizeAiPrev(raw: Record<string, unknown>): NonNullable<PlanOperation['aiPrev']> {
  const overrides = normalizeOverrides(raw.overrides);
  return {
    overrides,
    ai: Array.isArray(raw.ai) ? raw.ai.filter((k): k is OverrideKey => (OVERRIDE_KEYS as unknown[]).includes(k) && k in overrides) : [],
    ...(typeof raw.reason === 'string' ? { reason: raw.reason.slice(0, 500) } : {}),
  };
}

/**
 * A saved job config of any version, as a version 2 job. Older jobs are
 * brought over so they cut the same: each of their settings becomes an
 * override only where it differs from what the levels above would give.
 */
export function loadJob(raw: unknown, machine: CamMachine, entities: Entity[] = []): CamJobV2 {
  if (isObj(raw) && raw.version === 2) {
    const setup = normalizeSetup(raw.setup);
    const fallback = setup.selectedSketchIds[0] ?? '';
    return {
      version: 2,
      setup,
      operations: (Array.isArray(raw.operations) ? raw.operations : [])
        .map((o) => normalizePlanOperation(o, fallback))
        .filter((o): o is PlanOperation => o !== null),
      thread: Array.isArray(raw.thread)
        ? raw.thread.filter(isObj).filter((t) => (t.role === 'user' || t.role === 'ai') && typeof t.text === 'string').slice(-40) as unknown as CamJobV2['thread']
        : [],
      migrationNotes: Array.isArray(raw.migrationNotes) ? raw.migrationNotes.filter((n): n is string => typeof n === 'string') : [],
    };
  }
  if (!isObj(raw) || Object.keys(raw).length === 0) return createDefaultJob();
  return migrateV1(raw, machine, entities);
}

const differs = (a: number, b: number) => Math.abs(a - b) > 1e-6 * Math.max(1, Math.abs(b));

export function migrateV1(raw: unknown, machine: CamMachine, entities: Entity[] = []): CamJobV2 {
  const v1 = normalizeCamJobConfig(raw);
  const notes: string[] = [];
  const job = createDefaultJob();
  const setup = job.setup;
  setup.selectedSketchIds = v1.selectedSketchIds;
  setup.stock.thickness = v1.stock.thickness > 0 ? v1.stock.thickness : setup.stock.thickness;
  if (Math.abs(v1.stock.zTop) < 1e-9) setup.zZero = 'stock-top';
  else if (Math.abs(v1.stock.zTop - v1.stock.thickness) < 1e-9) setup.zZero = 'spoilboard';
  else notes.push(`Z zero was ${v1.stock.zTop}mm above the stock top; it is now at the stock top`);
  setup.origin = { kind: 'picked', x: v1.origin.x, y: v1.origin.y };
  notes.push(`The material is set to ${materialName(setup.material)} (older jobs had none): check it in Stock`);

  const post = v1.postProcessor;
  if (post.header !== machine.post.header || post.footer !== machine.post.footer || post.decimalPlaces !== machine.post.decimalPlaces) {
    setup.legacyPost = { ...post };
    notes.push("This job keeps its own G-code header and footer; the machine's are not used for it");
  }
  const safeZs = [...new Set(v1.operations.map((op) => op.cutting.safeZ))];
  if (safeZs.some((z) => differs(z, machine.safeZ))) {
    notes.push(`Safe height now comes from the machine (${machine.safeZ}mm); this job used ${safeZs.join(', ')}mm`);
  }
  if (v1.useFloodCoolant && machine.coolant === 'none') notes.push("Coolant now comes from the machine, which has none; this job had flood coolant on");

  // Tools: the library's where they match, else the job's own.
  const library = [...machine.tools];
  const toolFor = (t: CamTool): LibraryTool => {
    const hit = [...library, ...setup.tools].find((l) => l.type === t.type && Math.abs(l.diameter - t.diameter) < 0.01 && l.flutes === t.fluteCount);
    if (hit) return hit;
    const used = new Set([...library, ...setup.tools].map((l) => l.number));
    let number = 1;
    while (used.has(number)) number++;
    const own: LibraryTool = {
      id: `job-${t.id || newId('tool')}-${number}`, number, name: t.name, type: t.type, diameter: t.diameter,
      flutes: t.fluteCount, fluteLength: t.fluteLength, stickout: Math.max(t.fluteLength + 5, t.diameter * 5),
    };
    setup.tools.push(own);
    notes.push(`${t.name} (${t.diameter}mm) isn't in the machine's tool library: kept as a tool of this job, T${number}`);
    return own;
  };

  const oldTools: LibraryTool[] = [];
  for (const old of v1.operations) {
    const tool = toolFor(old.cutting.tool);
    oldTools.push(tool);
    const op: PlanOperation = newPlanOperation(old.kind, old.sketchId, old.entityIds, old.kind === 'profile' ? old.cutSide : 'outside');
    job.operations.push(op);
    // What the levels above would give, with the tool fixed to the old one.
    const tools = allTools(machine, setup);
    const inUse = job.operations.slice(0, -1).map((o) => tools.find((x) => x.id === o.overrides.toolId)).filter((x): x is LibraryTool => !!x);
    const plain = resolve(op, job, machine, tools, machine.presets, entities, inUse);
    if (plain.tool?.id !== tool.id) op.overrides.toolId = tool.id;
    const base = resolve(op, job, machine, tools, machine.presets, entities, inUse).fields;
    const c = old.cutting;
    const want: OpOverrides = {
      depth: c.depth.totalDepth,
      depthPerPass: c.depth.depthPerPass,
      lastPassDepth: c.depth.finalPassAllowance,
      rpm: c.spindleSpeed,
    };
    for (const [k, v] of Object.entries(want) as [OverrideKey, number][]) {
      if (differs(v, base[k].value as number)) (op.overrides as Record<string, unknown>)[k] = v;
    }
    if (c.spindleSpeed > machine.maxRpm) notes.push(`Operation ${job.operations.length} ran at ${c.spindleSpeed} rpm, above the machine's ${machine.maxRpm}: it is capped`);
    // Tabs and the rest depend on the depth: look again with it set.
    const after = resolve(op, job, machine, tools, machine.presets, entities, inUse);
    Object.assign(base, after.fields);
    const rpm = after.rpm;
    const chip = c.feedRate / (tool.flutes * rpm);
    if (differs(chip, base.chipLoad.value)) op.overrides.chipLoad = chip;
    const plunge = c.feedRate > 0 ? (c.plungeRate / c.feedRate) * 100 : base.plungePercent.value;
    if (differs(plunge, base.plungePercent.value)) op.overrides.plungePercent = plunge;
    if (c.feedRate > machine.rapidRate) notes.push(`Operation ${job.operations.length}'s feed (${c.feedRate}) is now capped at the machine's ${machine.rapidRate} mm/min`);

    if (old.kind === 'profile') {
      if (old.cutDirection !== base.cutDirection.value) op.overrides.cutDirection = old.cutDirection;
      if (old.tabs !== base.tabs.value) op.overrides.tabs = old.tabs;
      if (old.tabs || op.overrides.tabs !== undefined) {
        if (old.tabCount !== base.tabCount.value) op.overrides.tabCount = old.tabCount;
        if (differs(old.tabWidth, base.tabWidth.value)) op.overrides.tabWidth = old.tabWidth;
        if (differs(old.tabHeight, base.tabHeight.value)) op.overrides.tabHeight = old.tabHeight;
      }
      // Older jobs always plunged.
      if (base.entry.value !== 'plunge') op.overrides.entry = 'plunge';
    } else if (old.kind === 'pocket' || old.kind === 'facing') {
      if (differs(old.stepover, base.stepover.value)) op.overrides.stepover = old.stepover;
      if (old.cutDirection !== base.cutDirection.value) op.overrides.cutDirection = old.cutDirection;
    } else if (old.kind === 'drill') {
      if (base.holeMethod.value !== 'drill') op.overrides.holeMethod = 'drill';
      if (differs(old.peckDepth, base.peckDepth.value)) op.overrides.peckDepth = old.peckDepth;
      if (differs(old.dwell, base.dwell.value)) op.overrides.dwell = old.dwell;
    }
  }
  // The default tool depends on the tools in use across the whole job: pin
  // the old tool wherever the job as a whole would now pick another.
  for (let pass = 0; pass <= job.operations.length; pass++) {
    const now = resolveJob(job, machine, entities).ops;
    const moved = job.operations.filter((op, i) => op.overrides.toolId === undefined && now[i]!.tool?.id !== oldTools[i]!.id);
    if (moved.length === 0) break;
    for (const op of moved) op.overrides.toolId = oldTools[job.operations.indexOf(op)]!.id;
  }
  // Values the old job allowed that are now out of range are brought in, and said so.
  job.operations.forEach((op, i) => {
    for (const [k, v] of Object.entries(op.overrides) as [OverrideKey, unknown][]) {
      if (ALLOWED[k]!(v)) continue;
      const range = RANGES[k];
      if (range && typeof v === 'number' && Number.isFinite(v)) {
        const [lo, hi] = range;
        const to = Math.min(Math.max(v, lo === 0 ? 0.001 : lo), hi);
        (op.overrides as Record<string, unknown>)[k] = to;
        notes.push(`Operation ${i + 1}: ${k} was ${Number(v.toFixed(4))}, outside what is allowed now; it is ${Number(to.toFixed(4))}`);
      } else {
        delete (op.overrides as Record<string, unknown>)[k];
        notes.push(`Operation ${i + 1}: its ${k} couldn't be brought over; it uses the default`);
      }
    }
  });
  job.migrationNotes = notes;
  return job;
}
