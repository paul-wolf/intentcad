/**
 * The settings levels: machine → tool library and material presets → job
 * setup → operation overrides, and the defaults derived from the shapes.
 */
import { describe, it, expect } from 'vitest';
import type { Entity } from '@/types/document';
import type { CamOperation, OperationCuttingParams } from '@/types/cam';
import { createDefaultCutting, createDefaultJobConfig } from '@/types/cam';
import { generateGcode } from './generate';
import { TYPICAL_DIAL, createDefaultJob, createDefaultMachine, type CamJobV2, type CamMachine, type PlanOperation } from './setup';
import {
  allTools,
  cuttingOrder,
  loadJob,
  newPlanOperation,
  normalizeOverrides,
  resolve,
  resolveJob,
  stockPoint,
  stockRect,
} from './resolve';

const rect = (id: string, w = 40, h = 20, cx = 0, cy = 0): Entity =>
  ({ id, type: 'rectangle', center: { x: cx, y: cy }, width: w, height: h, cornerRadius: 0 }) as Entity;
const circle = (id: string, x: number, y: number, r: number): Entity =>
  ({ id, type: 'circle', center: { x, y }, radius: r }) as Entity;

function setupJob(thickness = 6, material: CamJobV2['setup']['material'] = 'birch-ply'): CamJobV2 {
  const job = createDefaultJob();
  job.setup.stock.thickness = thickness;
  job.setup.material = material;
  job.setup.selectedSketchIds = ['s'];
  return job;
}

function one(op: PlanOperation, entities: Entity[], job = setupJob(), machine = createDefaultMachine()) {
  job.operations = [op];
  return resolve(op, job, machine, allTools(machine, job.setup), machine.presets, entities);
}

const outside = () => newPlanOperation('profile', 's', ['r'], 'outside');

describe('inheritance', () => {
  it('takes every value from the levels above, and says where from', () => {
    const r = one(outside(), [rect('r')]);
    expect(r.tool?.number).toBe(1);
    expect(r.fields.depth).toMatchObject({ value: 6.3, kind: 'inherited', source: 'stock 6 + 0.3 allowance' });
    expect(r.fields.chipLoad).toMatchObject({ value: 0.06, kind: 'inherited', source: 'Birch ply × T1' });
    expect(r.fields.rpm).toMatchObject({ value: 18000, source: 'Birch ply × T1' });
    expect(r.fields.depthPerPass.value).toBe(1.5);
    expect(r.fields.tabs).toMatchObject({ value: true, kind: 'inherited' });
    expect(r.fields.entry.value).toBe('plunge');
    expect(r.partFreeing).toBe(true);
  });

  it('works the feed out from the chip load, flutes and speed', () => {
    const r = one(outside(), [rect('r')]);
    expect(r.feed).toBeCloseTo(0.06 * 2 * 18000, 6);
    expect(r.plunge).toBeCloseTo(r.feed * 0.3, 6);
    expect(r.cam?.cutting.feedRate).toBeCloseTo(r.feed, 6);
    expect(r.cam?.cutting.depth.totalDepth).toBe(6.3);
  });

  it('follows changes above: the machine allowance, the material, an edited preset', () => {
    const machine = createDefaultMachine();
    machine.spoilboardAllowance = 0.5;
    expect(one(outside(), [rect('r')], setupJob(), machine).fields.depth).toMatchObject({ value: 6.5, source: 'stock 6 + 0.5 allowance' });

    const alu = one(outside(), [rect('r')], setupJob(6, 'aluminium-6061'));
    expect(alu.fields.chipLoad).toMatchObject({ value: 0.024, source: 'Aluminium 6061 × T1' });
    expect(alu.fields.entry.value).toBe('ramp');
    expect(alu.cam).toMatchObject({ rampAngle: 2 });

    machine.presets = [{ toolId: 't-3-flat', material: 'birch-ply', rpm: 16000, chipLoad: 0.05, depthPerPass: 2, stepover: 0.4, plungePercent: 50, rampAngle: 4 }];
    const edited = one(outside(), [rect('r')], setupJob(), machine);
    expect(edited.fields.chipLoad).toMatchObject({ value: 0.05, source: 'Birch ply × T1 (edited)' });
    expect(edited.feed).toBeCloseTo(0.05 * 2 * 16000, 6);
  });

  it('cuts 2 mm carbon fibre plate in shallow passes, ramping in', () => {
    const r = one(outside(), [rect('r')], setupJob(2, 'carbon-fibre'));
    expect(r.fields.chipLoad).toMatchObject({ value: 0.024, source: 'Carbon fibre (CFRP) × T1' });
    expect(r.feed).toBeCloseTo(0.024 * 2 * 18000, 6);
    expect(r.fields.depth.value).toBe(2.3);
    expect(r.fields.depthPerPass.value).toBe(0.8);
    expect(r.fields.entry.value).toBe('ramp');
    expect(r.cam).toMatchObject({ rampAngle: 3 });
    expect(r.problem).toBeFalsy();
  });

  it('caps the speed at the machine maximum, and the feed at its rapid rate', () => {
    const machine = createDefaultMachine();
    machine.maxRpm = 15000;
    machine.rapidRate = 1500;
    const r = one(outside(), [rect('r')], setupJob(), machine);
    expect(r.rpm).toBe(15000);
    expect(r.fields.rpm.source).toMatch(/machine max/);
    expect(r.feed).toBe(1500);
    expect(r.feedCapped).toBe(true);
  });

  it('uses the dial setting nearest the preset speed on a router with a dial', () => {
    const machine = createDefaultMachine();
    machine.maxRpm = 30000;
    machine.spindle = { kind: 'dial', dial: TYPICAL_DIAL };
    const r = one(outside(), [rect('r')], setupJob(), machine);
    expect(r.dial?.setting).toBe('3');
    expect(r.rpm).toBe(17000);
    expect(r.feed).toBeCloseTo(0.06 * 2 * 17000, 6);
  });
});

describe('overrides', () => {
  it('a value set on the operation wins, and remembers what it replaced', () => {
    const op = outside();
    op.overrides.depth = 4;
    const r = one(op, [rect('r')]);
    expect(r.fields.depth).toMatchObject({ value: 4, kind: 'set', source: 'set here', base: 6.3, baseSource: 'stock 6 + 0.3 allowance' });
    // Not through any more: no tabs, doesn't free the part.
    expect(r.fields.tabs.value).toBe(false);
    expect(r.partFreeing).toBe(false);
  });

  it('marks what the AI set', () => {
    const op = outside();
    op.overrides.chipLoad = 0.04;
    op.ai = ['chipLoad'];
    expect(one(op, [rect('r')]).fields.chipLoad).toMatchObject({ value: 0.04, kind: 'ai', source: 'AI', base: 0.06 });
  });

  it('reset: removing the override brings back the inherited value', () => {
    const op = outside();
    op.overrides.depth = 4;
    delete op.overrides.depth;
    expect(one(op, [rect('r')]).fields.depth).toMatchObject({ value: 6.3, kind: 'inherited' });
  });

  it('a set tool that is no longer in the library falls back to the default, with a note', () => {
    const op = outside();
    op.overrides.toolId = 'gone';
    const r = one(op, [rect('r')]);
    expect(r.tool?.number).toBe(1);
    expect(r.notes.join()).toMatch(/no longer in the library/);
  });
});

describe('derived defaults', () => {
  const drill = (ids: string[]) => newPlanOperation('drill', 's', ids);
  const pocket = (ids: string[]) => newPlanOperation('pocket', 's', ids);

  it('drills holes with a matching drill bit', () => {
    const r = one(drill(['a', 'b']), [circle('a', 0, 0, 1.5), circle('b', 10, 0, 1.5)]);
    expect(r.tool?.type).toBe('drill');
    expect(r.fields.holeMethod.value).toBe('drill');
    // Through by the allowance, and by the drill's point (0.3 × 3mm) so the hole is full size at the bottom.
    expect(r.fields.depth).toMatchObject({ value: 7.2, source: 'stock 6 + 0.3 allowance + 0.9 drill point' });
    expect(r.problem).toBeNull();
    const gen = generateGcode(resolveJob({ ...setupJob(), operations: [r.op] }, createDefaultMachine(), [circle('a', 0, 0, 1.5), circle('b', 10, 0, 1.5)]).config, [circle('a', 0, 0, 1.5), circle('b', 10, 0, 1.5)]);
    expect(gen.issues.filter((i) => i.severity === 'error')).toEqual([]);
  });

  it('picks a bit long enough for the depth, and refuses a cut deeper than the bit reaches', () => {
    // 12mm stock: 12.3mm deep, past T1's 12mm flutes, so T2 (22mm flutes) cuts it out.
    const thick = one(outside(), [rect('r')], setupJob(12));
    expect(thick.tool?.number).toBe(2);
    expect(thick.notes).toEqual([]);
    // Set the short bit anyway: a warning past its flutes, an error past its stickout.
    const flutes = one({ ...outside(), overrides: { toolId: 't-3-flat', depth: 15 } }, [rect('r')], setupJob(16));
    expect(flutes.notes.join()).toMatch(/past T1's 12mm flutes/);
    expect(flutes.problem).toBeNull();
    const collet = one({ ...outside(), overrides: { toolId: 't-3-flat', depth: 25 } }, [rect('r')], setupJob(30));
    expect(collet.problem).toMatch(/sticks out only 20mm/);
    expect(collet.cam).toBeNull();
  });

  it('refuses a cut deeper than the spoilboard allowance below the stock', () => {
    const job = setupJob();
    const machine = createDefaultMachine();
    job.operations = [{ ...outside(), overrides: { depth: 7 } }];
    const deep = generateGcode(resolveJob(job, machine, [rect('r')]).config, [rect('r')]);
    expect(deep.issues.some((i) => i.severity === 'error' && /0\.30?mm spoilboard allowance/.test(i.message))).toBe(true);
    job.operations = [outside()];
    const through = generateGcode(resolveJob(job, machine, [rect('r')]).config, [rect('r')]);
    expect(through.issues.filter((i) => i.severity !== 'info')).toEqual([]);
  });

  it('faces the whole stock when facing has no shapes', () => {
    const job = setupJob();
    job.setup.stock.width = 200;
    job.setup.stock.height = 100;
    const machine = createDefaultMachine();
    const face = newPlanOperation('facing', 's', []);
    job.operations = [face];
    const r = resolveJob(job, machine, [rect('r', 40, 20, 300, 300)]);
    expect(r.config.stock.area).toEqual(stockRect(job.setup, [rect('r', 40, 20, 300, 300)]));
    const { toolpath } = generateGcode(r.config, [rect('r', 40, 20, 300, 300)]);
    const cuts = toolpath.filter((m) => m.kind === 'linear' && m.z < 0);
    const xs = cuts.map((m) => m.to.x), ys = cuts.map((m) => m.to.y);
    // The stock is 200 × 100 (not a 100 × 100 square somewhere else).
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(195);
    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(95);
  });

  it('bores holes with an end mill when no drill bit matches', () => {
    const five = one(drill(['a']), [circle('a', 0, 0, 2.5)]);
    expect([five.tool?.diameter, five.fields.holeMethod.value]).toEqual([3, 'helix']);
    const eight = one(drill(['a']), [circle('a', 0, 0, 4)]);
    expect([eight.tool?.diameter, eight.fields.holeMethod.value]).toEqual([6, 'helix']);
    expect(eight.cam).toMatchObject({ kind: 'drill', method: 'helix' });
  });

  it('refuses holes no tool can make, and says what to add', () => {
    const r = one(drill(['a']), [circle('a', 0, 0, 10)]);
    expect(r.tool).toBeNull();
    expect(r.cam).toBeNull();
    expect(r.problem).toMatch(/No tool can make 20mm holes/);
  });

  it('pockets with the largest end mill that fits', () => {
    expect(one(pocket(['r']), [rect('r', 40, 20)]).tool?.diameter).toBe(6);
    expect(one(pocket(['r']), [rect('r', 40, 4)]).tool?.diameter).toBe(3);
    expect(one(pocket(['r']), [rect('r', 40, 1)]).problem).toMatch(/small enough/);
    expect(one(pocket(['r']), [rect('r')]).fields.depth).toMatchObject({ value: 3, source: 'half the stock (6)' });
  });

  it('prefers a bit already in use, to save a tool change', () => {
    const job = setupJob();
    const machine = createDefaultMachine();
    const first = outside();
    const p = pocket(['p']);
    job.operations = [first, p];
    const r = resolveJob(job, machine, [rect('r', 80, 60), rect('p', 40, 20)]);
    expect(r.ops[0]!.tool?.diameter).toBe(3);
    expect(r.ops[1]!.tool?.diameter).toBe(3);
    expect(r.ops[1]!.fields.toolId.source).toMatch(/in use/);
    expect(r.toolChanges).toBe(0);
  });

  it('cuts on the line only half a millimetre deep by default', () => {
    expect(one(newPlanOperation('profile', 's', ['r'], 'on'), [rect('r')]).fields.depth.value).toBe(0.5);
  });

  it('orders the plan: inside work first, by tool, the cut-out last', () => {
    const job = setupJob();
    const machine = createDefaultMachine();
    const out = outside();
    const holes = drill(['h']);
    const pk = pocket(['p']);
    job.operations = [out, holes, pk];
    const entities = [rect('r', 80, 60), circle('h', 30, 20, 1.5), rect('p', 30, 20)];
    expect(cuttingOrder(job, machine, entities).map((o) => o.id)).toEqual([pk.id, holes.id, out.id]);
    const issues = resolveJob(job, machine, entities).issues;
    expect(issues.some((i) => /cuts the part free before/.test(i.message))).toBe(true);
    job.operations = cuttingOrder(job, machine, entities);
    expect(resolveJob(job, machine, entities).issues.some((i) => /cuts the part free/.test(i.message))).toBe(false);
  });
});

describe('stock and origin', () => {
  it('centres the stock on the shapes, with a margin when its size is not given', () => {
    const job = setupJob();
    expect(stockRect(job.setup, [rect('r', 40, 20, 100, 50)])).toEqual({ x: 70, y: 30, width: 60, height: 40 });
    job.setup.stock.width = 100;
    expect(stockRect(job.setup, [rect('r', 40, 20, 100, 50)]).x).toBe(50);
  });

  it('puts the front at the bottom of the sketch', () => {
    const s = { x: 0, y: 0, width: 100, height: 50 };
    expect(stockPoint(s, 'front-left')).toEqual({ x: 0, y: 50 });
    expect(stockPoint(s, 'back-right')).toEqual({ x: 100, y: 0 });
    expect(stockPoint(s, 'centre')).toEqual({ x: 50, y: 25 });
  });

  it('passes the setup to the toolpaths: origin, Z zero, clamps and the machine', () => {
    const job = setupJob();
    job.setup.zZero = 'spoilboard';
    job.setup.clamps = [{ id: 'c', x: -100, y: -100, width: 10, height: 10, zHeight: 5 }];
    job.operations = [outside()];
    const r = resolveJob(job, createDefaultMachine(), [rect('r')]);
    expect(r.config.stock).toEqual({ thickness: 6, zTop: 6, area: { x: -30, y: -20, width: 60, height: 40 } });
    expect(r.config.origin).toEqual({ x: -30, y: 20 });
    expect(r.config.clamps).toHaveLength(1);
    expect(r.config.machine).toMatchObject({ clearanceZ: 15, toolChange: 'M0' });
    expect(r.configOpIds).toEqual([job.operations[0]!.id]);
  });
});

// ── Older saved jobs ──

const cutting = (over: Partial<OperationCuttingParams> = {}): OperationCuttingParams => ({ ...createDefaultCutting(), ...over });
function v1Job(operations: CamOperation[], thickness = 3) {
  const c = createDefaultJobConfig();
  c.selectedSketchIds = ['s'];
  c.stock = { thickness, zTop: 0 };
  c.operations = operations;
  return c;
}
const v1Profile = (c: OperationCuttingParams, over: Record<string, unknown> = {}): CamOperation =>
  ({ kind: 'profile', sketchId: 's', entityIds: ['r'], cutSide: 'outside', cutDirection: 'climb', tabs: false, tabCount: 4, tabWidth: 5, tabHeight: 1, cutting: c, ...over }) as CamOperation;

describe('migration', () => {
  it('cuts exactly what the old job cut', () => {
    const entities = [rect('r'), circle('h', 30, 0, 1.5)];
    const old = v1Job([
      v1Profile(cutting()),
      { kind: 'drill', sketchId: 's', entityIds: ['h'], peckDepth: 1, dwell: 0.5, cutting: cutting({ spindleSpeed: 9000, feedRate: 500, plungeRate: 120 }) },
    ]);
    const machine = createDefaultMachine();
    const job = loadJob(JSON.parse(JSON.stringify(old)), machine, entities);
    expect(job.version).toBe(2);
    const r = resolveJob(job, machine, entities);
    expect(r.issues.filter((i) => i.severity === 'error')).toEqual([]);
    const before = generateGcode(old, entities);
    const after = generateGcode(r.config, entities);
    expect(after.toolpath).toEqual(before.toolpath);
  });

  it('keeps each operation on its old tool when the job used several', () => {
    const entities = [rect('a', 40, 20, -40, 0), rect('b', 40, 20, 40, 0)];
    const six = { id: 'six', name: '6mm', diameter: 6, type: 'flat' as const, fluteCount: 2, fluteLength: 22 };
    const old = v1Job([v1Profile(cutting(), { entityIds: ['a'] }), v1Profile(cutting({ tool: six }), { entityIds: ['b'] })]);
    const machine = createDefaultMachine();
    const job = loadJob(JSON.parse(JSON.stringify(old)), machine, entities);
    const r = resolveJob(job, machine, entities);
    expect(r.ops.map((o) => o.tool?.diameter)).toEqual([3, 6]);
    expect(generateGcode(r.config, entities).toolpath).toEqual(generateGcode(old, entities).toolpath);
  });

  it('brings values now out of range back in, and they survive a reload', () => {
    const machine = createDefaultMachine();
    const job = loadJob(v1Job([v1Profile(cutting({ feedRate: 2000, plungeRate: 10 }))]), machine, [rect('r')]);
    expect(job.operations[0]!.overrides.plungePercent).toBe(1);
    expect(job.migrationNotes.join('\n')).toMatch(/plungePercent was 0.5/);
    const again = loadJob(JSON.parse(JSON.stringify(job)), machine, [rect('r')]);
    expect(again.operations[0]!.overrides).toEqual(job.operations[0]!.overrides);
  });

  it('keeps an old value as an override only where it differs from the default', () => {
    const machine = createDefaultMachine();
    // What a 3mm end mill gets in birch ply, 3mm stock: 18000 rpm, 0.06 chip, 30% plunge, 3.3 deep in 1.5mm passes, tabs.
    const same = cutting({ spindleSpeed: 18000, feedRate: 2160, plungeRate: 648, depth: { totalDepth: 3.3, depthPerPass: 1.5, finalPassAllowance: 0 } });
    const job = loadJob(v1Job([v1Profile(same, { tabs: true, tabHeight: 1.3 })]), machine, [rect('r')]);
    expect(job.operations[0]!.overrides).toEqual({});

    const differ = loadJob(v1Job([v1Profile(cutting())]), machine, [rect('r')]).operations[0]!.overrides;
    expect(differ).toMatchObject({ depth: 3, depthPerPass: 1, rpm: 12000, tabs: false, plungePercent: 25 });
    expect(differ.chipLoad).toBeCloseTo(800 / (2 * 12000), 9);
    expect(differ.toolId).toBeUndefined();
  });

  it('keeps a tool that is not in the library as a tool of the job', () => {
    const odd = { id: 'x', name: '5mm 3-flute', diameter: 5, type: 'flat' as const, fluteCount: 3, fluteLength: 15 };
    const machine = createDefaultMachine();
    const job = loadJob(v1Job([v1Profile(cutting({ tool: odd }))]), machine, [rect('r')]);
    expect(job.setup.tools).toHaveLength(1);
    expect(job.setup.tools[0]).toMatchObject({ number: 5, diameter: 5, flutes: 3 });
    expect(job.operations[0]!.overrides.toolId).toBe(job.setup.tools[0]!.id);
    expect(job.migrationNotes.join('\n')).toMatch(/isn't in the machine's tool library/);
  });

  it("keeps the job's own G-code header, and says what changed", () => {
    const old = v1Job([v1Profile(cutting({ safeZ: 8 }))]);
    old.postProcessor = { ...old.postProcessor, header: 'G54' };
    old.stock.zTop = 3;
    const job = loadJob(old, createDefaultMachine(), [rect('r')]);
    expect(job.setup.legacyPost?.header).toBe('G54');
    expect(job.setup.zZero).toBe('spoilboard');
    expect(job.setup.origin).toEqual({ kind: 'picked', x: 0, y: 0 });
    const notes = job.migrationNotes.join('\n');
    expect(notes).toMatch(/Safe height now comes from the machine/);
    expect(notes).toMatch(/material/);
  });

  it('starts empty jobs as version 2 with no notes', () => {
    expect(loadJob({}, createDefaultMachine())).toMatchObject({ version: 2, operations: [], migrationNotes: [] });
    expect(loadJob(null, createDefaultMachine()).version).toBe(2);
  });
});

describe('normalising saved and AI values', () => {
  it('drops unknown keys and values out of range', () => {
    const dropped: string[] = [];
    const o = normalizeOverrides({
      depth: -1, rpm: 999999, chipLoad: 0.05, entry: 'sideways', feedRate: 3000, tabs: 'yes', tabCount: 3.5,
      stepover: 0.4, rampAngle: 45, toolId: 't-6-flat', holeMethod: 'helix',
    }, dropped);
    expect(o).toEqual({ chipLoad: 0.05, stepover: 0.4, toolId: 't-6-flat', holeMethod: 'helix' });
    expect(dropped.sort()).toEqual(['depth', 'entry', 'feedRate', 'rampAngle', 'rpm', 'tabCount', 'tabs']);
  });

  it('survives garbage', () => {
    for (const g of [null, undefined, 3, 'x', [1, 2], { constructor: 1 }]) expect(normalizeOverrides(g)).toEqual({});
    const m: CamMachine = createDefaultMachine();
    const job = loadJob({
      version: 2,
      setup: { material: 'cheese', stock: { thickness: -4, width: 'wide' }, origin: { kind: 'stock', point: 'nowhere' }, clamps: [{ x: 1 }, 'c'] },
      operations: [
        { kind: 'laser' },
        'op',
        { kind: 'pocket', entityIds: ['r', 7], overrides: { depth: 2, rpm: 'fast' }, ai: ['depth', 'rpm', 'bogus'], status: 'weird' },
      ],
      thread: [{ role: 'system', text: 'x' }, { role: 'ai', text: 'hello' }],
    }, m);
    expect(job.setup.material).toBe('birch-ply');
    expect(job.setup.stock).toEqual({ width: null, height: null, thickness: 6 });
    expect(job.setup.origin).toEqual({ kind: 'stock', point: 'front-left' });
    expect(job.setup.clamps).toEqual([]);
    expect(job.operations).toHaveLength(1);
    expect(job.operations[0]).toMatchObject({ kind: 'pocket', entityIds: ['r'], overrides: { depth: 2 }, ai: ['depth'], status: 'accepted' });
    expect(job.thread).toEqual([{ role: 'ai', text: 'hello' }]);
  });
});

describe('depth against the stock', () => {
  it('warns when an outside cut is too shallow to free the part, and says so for blind holes', () => {
    const machine = createDefaultMachine();
    const job = setupJob(12);
    const profile = newPlanOperation('profile', 's', ['r'], 'outside');
    const holes = newPlanOperation('drill', 's', ['h'], 'on');
    profile.overrides = { depth: 6 };
    holes.overrides = { depth: 6 };
    job.operations = [holes, profile];
    const issues = resolveJob(job, machine, [rect('r'), circle('h', 5, 5, 2)]).issues;
    const allowance = Number((12 + machine.spoilboardAllowance).toFixed(2));
    expect(issues).toContainEqual({
      severity: 'warning', opId: profile.id,
      message: `Operation 2: 6 mm deep in 12 mm stock, so this outside cut won't free the part. Reset the depth to cut through (${allowance} mm)`,
    });
    expect(issues).toContainEqual({
      severity: 'info', opId: holes.id,
      message: "Operation 1: the holes are 6 mm deep in 12 mm stock, so they won't go through. Reset the depth if they should",
    });
    // Through by default: nothing to say.
    profile.overrides = {};
    holes.overrides = {};
    expect(resolveJob(job, machine, [rect('r'), circle('h', 5, 5, 2)]).issues.filter((i) => /deep in/.test(i.message))).toEqual([]);
  });
});
