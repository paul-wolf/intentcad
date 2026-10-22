/**
 * The CAM assistant's replies: everything is checked before it touches the
 * job, and nothing it says can reach the machine or skip the checks.
 */
import { describe, it, expect } from 'vitest';
import type { Entity } from '@/types/document';
import { applyCamChat, buildChatContext, rejectAiEdit, undoAiSetup } from './chat';
import { allTools, loadJob, newPlanOperation, resolveJob } from './resolve';
import { normalizeMachine, machineProblems } from './machine';
import { createDefaultJob, createDefaultMachine, type CamJobV2 } from './setup';
import { operatorSteps } from '@/components/cam/CamRunStep';

const rect = (id: string, w = 40, h = 20): Entity =>
  ({ id, type: 'rectangle', center: { x: 0, y: 0 }, width: w, height: h, cornerRadius: 0 }) as Entity;
const circle = (id: string, x: number, y: number, r: number): Entity =>
  ({ id, type: 'circle', center: { x, y }, radius: r }) as Entity;

const entities = [rect('r'), circle('h1', -10, 0, 1.5), circle('h2', 10, 0, 1.5)];
const sketchOf = new Map(entities.map((e) => [e.id, 's']));

function job(): CamJobV2 {
  const j = createDefaultJob();
  j.setup.selectedSketchIds = ['s'];
  return j;
}
const ctx = (j = job()) => ({ entities, sketchOf, tools: allTools(createDefaultMachine(), j.setup) });

describe('applying a reply', () => {
  it('fills in the setup and marks what the AI set', () => {
    const j = job();
    const out = applyCamChat(j, { summary: 'Set up', setup: { material: 'mdf', thickness: 12, origin: 'centre', zZero: 'spoilboard' } }, ctx(j));
    expect(out.job.setup.material).toBe('mdf');
    expect(out.job.setup.stock.thickness).toBe(12);
    expect(out.job.setup.origin).toEqual({ kind: 'stock', point: 'centre' });
    expect(out.job.setup.zZero).toBe('spoilboard');
    expect(out.job.setup.aiFields.sort()).toEqual(['material', 'origin', 'thickness', 'zZero']);
    expect(out.notes).toEqual([]);
    expect(j.setup.material).toBe('birch-ply');   // the job passed in is left alone
    // Waiting for the user, with what was there before.
    expect(out.job.setup.aiPending).toEqual({ material: 'birch-ply', thickness: 6, origin: { kind: 'stock', point: 'front-left' }, zZero: 'stock-top' });
  });

  it('keeps setup changes pending until confirmed; Undo puts back what was there before the first change', () => {
    const j = job();
    const one = applyCamChat(j, { setup: { thickness: 12, zZero: 'stock-top', width: 300 } }, ctx(j)).job;
    expect(one.setup.aiPending).toEqual({ thickness: 6, width: null });   // Z zero didn't change
    const two = applyCamChat(one, { setup: { thickness: 18, width: null } }, ctx(one)).job;
    expect(two.setup.stock).toMatchObject({ thickness: 18, width: null });
    expect(two.setup.aiPending).toEqual({ thickness: 6, width: null });
    // It survives a reload, and Undo goes back to the start.
    const reloaded = loadJob(JSON.parse(JSON.stringify(two)), createDefaultMachine());
    expect(reloaded.setup.aiPending).toEqual({ thickness: 6, width: null });
    const undone = undoAiSetup(reloaded.setup);
    expect(undone.stock).toMatchObject({ thickness: 6, width: null });
    expect(undone.aiPending).toBeUndefined();
    expect(undone.aiFields).not.toContain('thickness');
  });

  it('keeps how an accepted operation was, so Reject puts it back', () => {
    const j = job();
    const op = newPlanOperation('profile', 's', ['r'], 'outside');
    op.overrides = { tabCount: 6 };
    op.reason = 'Mine';
    j.operations = [op];
    const once = applyCamChat(j, { edits: [{ opId: op.id, overrides: { tabCount: 2 }, reason: 'Fewer tabs' }] }, ctx(j)).job;
    const twice = applyCamChat(once, { edits: [{ opId: op.id, overrides: { depthPerPass: 1 } }] }, ctx(once)).job;
    const e = twice.operations[0]!;
    expect(e.status).toBe('proposed');
    expect(e.aiPrev).toEqual({ overrides: { tabCount: 6 }, ai: [], reason: 'Mine' });   // as it was before the first edit
    const back = rejectAiEdit(loadJob(JSON.parse(JSON.stringify(twice)), createDefaultMachine()).operations[0]!);
    expect(back).toMatchObject({ status: 'accepted', overrides: { tabCount: 6 }, ai: [], reason: 'Mine' });
    expect(back.aiPrev).toBeUndefined();
  });

  it('proposes operations, as overrides with reasons, marked AI', () => {
    const j = job();
    const out = applyCamChat(j, {
      operations: [
        { kind: 'drill', entityIds: ['h1', 'h2'], reason: 'The two holes', overrides: { toolId: 't-3-drill' } },
        { kind: 'profile', entityIds: ['r'], cutSide: 'outside', overrides: { tabCount: 4 } },
      ],
    }, ctx(j));
    expect(out.job.operations).toHaveLength(2);
    const [drill, profile] = out.job.operations;
    expect(drill!.status).toBe('proposed');
    expect(drill!.reason).toBe('The two holes');
    expect(drill!.overrides).toEqual({ toolId: 't-3-drill' });
    expect(drill!.ai).toEqual(['toolId']);
    expect(profile!.overrides).toEqual({ tabCount: 4 });
    expect(out.touched).toEqual([drill!.id, profile!.id]);
    // Its values show as the AI's in the resolved plan.
    const r = resolveJob(out.job, createDefaultMachine(), entities);
    expect(r.ops[1]!.fields.tabCount.kind).toBe('ai');
  });

  it('drops shapes and tools it made up, with a note', () => {
    const j = job();
    const out = applyCamChat(j, {
      operations: [
        { kind: 'drill', entityIds: ['h1', 'ghost'], overrides: { toolId: 't-99-laser' } },
        { kind: 'pocket', entityIds: ['nope'] },
      ],
    }, ctx(j));
    expect(out.job.operations).toHaveLength(1);
    expect(out.job.operations[0]!.entityIds).toEqual(['h1']);
    expect(out.job.operations[0]!.overrides).toEqual({});
    expect(out.notes.join('\n')).toMatch(/aren't in the job's sketches/);
    expect(out.notes.join('\n')).toMatch(/t-99-laser.*isn't in the library/);
    expect(out.notes.join('\n')).toMatch(/no known shapes/);
  });

  it('drops values out of range, so the checks still see only sane values', () => {
    const j = job();
    const out = applyCamChat(j, {
      setup: { thickness: -3, width: 1e9, material: 'unobtainium', origin: 'under the table', zZero: 'the moon' },
      operations: [{ kind: 'profile', entityIds: ['r'], overrides: { depth: 500, rpm: 1e6, chipLoad: 0.04, feedRate: 99999, safeZ: -5 } }],
    }, ctx(j));
    expect(out.job.setup).toEqual(j.setup);
    expect(out.job.operations[0]!.overrides).toEqual({ chipLoad: 0.04 });
    expect(out.notes.length).toBeGreaterThanOrEqual(6);
  });

  it('never reaches the machine: post-processor and safety settings in a reply are ignored', () => {
    const j = job();
    const before = JSON.stringify(j);
    const out = applyCamChat(j, {
      machine: { safeZ: -10, post: { header: 'M3 S99999' }, clearanceZ: 0 },
      post: { footer: 'G0 Z-50' },
      safeZ: -10,
      validate: false,
    }, ctx(j));
    expect(JSON.stringify(out.job)).toBe(before);
    // The job has nowhere to put them, and what the assistant is sent about the machine is facts only.
    const machine = createDefaultMachine();
    const sent = buildChatContext(out.job, machine, allTools(machine, out.job.setup), resolveJob(out.job, machine, entities), [], null);
    expect(Object.keys(sent.machine)).not.toContain('post');
  });

  it('edits operations: overrides, resets, and the edited operation goes back to proposed', () => {
    const j = job();
    const op = newPlanOperation('profile', 's', ['r'], 'outside');
    op.overrides = { tabCount: 6, chipLoad: 0.02 };
    op.ai = ['tabCount'];
    j.operations = [op];
    const out = applyCamChat(j, { edits: [{ opId: op.id, overrides: { depthPerPass: 1.5 }, reset: ['tabCount', 'bogus'], reason: 'Lighter passes' }] }, ctx(j));
    const e = out.job.operations[0]!;
    expect(e.overrides).toEqual({ chipLoad: 0.02, depthPerPass: 1.5 });
    expect(e.ai).toEqual(['depthPerPass']);
    expect(e.status).toBe('proposed');
    expect(e.reason).toBe('Lighter passes');
    expect(op.status).toBe('accepted');   // unchanged in the job passed in
  });

  it('removes only its own proposals, never accepted work', () => {
    const j = job();
    const accepted = newPlanOperation('profile', 's', ['r'], 'outside');
    const proposed = { ...newPlanOperation('drill', 's', ['h1'], 'outside'), status: 'proposed' as const };
    j.operations = [accepted, proposed];
    const out = applyCamChat(j, { remove: [accepted.id, proposed.id, 'nope'] }, ctx(j));
    expect(out.job.operations.map((o) => o.id)).toEqual([accepted.id]);
    expect(out.notes.join('\n')).toMatch(/remove it yourself/);
  });

  it("can't remove accepted work by editing it first, in the same reply or an earlier one", () => {
    const j = job();
    const accepted = newPlanOperation('profile', 's', ['r'], 'outside');
    j.operations = [accepted];
    const same = applyCamChat(j, { edits: [{ opId: accepted.id, overrides: { tabCount: 2 } }], remove: [accepted.id] }, ctx(j));
    expect(same.job.operations.map((o) => o.id)).toEqual([accepted.id]);
    const later = applyCamChat(same.job, { remove: [accepted.id] }, ctx(same.job));
    expect(later.job.operations.map((o) => o.id)).toEqual([accepted.id]);
    expect(later.notes.join('\n')).toMatch(/remove it yourself/);
  });

  it('survives garbage', () => {
    const j = job();
    for (const g of [null, undefined, 42, 'hello', [1, 2], { operations: 'all', edits: [null, 3, { opId: 7 }], remove: 'x', setup: [], choices: [1, '', 'ok'] }]) {
      const out = applyCamChat(j, g, ctx(j));
      expect(out.job.operations).toEqual([]);
      expect(out.job.setup).toEqual(j.setup);
      expect(typeof out.turn.text).toBe('string');
    }
    expect(applyCamChat(j, { choices: [1, '', 'ok'] }, ctx(j)).turn.choices).toEqual(['ok']);
  });
});

describe('machines', () => {
  it('reads a saved machine, and puts unknown or out-of-range values back to the defaults', () => {
    const m = normalizeMachine({
      version: 2,
      machine: {
        name: '  Shapeoko ', maxRpm: 1e9, toolChange: 'robot', safeZ: 8, clearanceZ: 3, coolant: 'M9', spoilboardAllowance: 0.5,
        spindle: { kind: 'dial', dial: [{ setting: '3', rpm: 16000 }, { setting: '1', rpm: 10000 }, { setting: '', rpm: 5 }] },
        presets: [{ toolId: 't-3-flat', material: 'mdf', rpm: 20000 }, { toolId: 'gone', material: 'mdf' }],
      },
    });
    expect(m.name).toBe('Shapeoko');
    expect(m.maxRpm).toBe(24000);
    expect(m.toolChange).toBe('M0');
    expect(m.clearanceZ).toBe(8);   // never below the safe height
    expect(m.coolant).toBe('none');
    expect(m.spoilboardAllowance).toBe(0.5);
    expect(m.spindle).toEqual({ kind: 'dial', dial: [{ setting: '1', rpm: 10000 }, { setting: '3', rpm: 16000 }] });
    expect(m.presets.map((p) => p.toolId)).toEqual(['t-3-flat']);
  });

  it('turns an old profile into the default machine with its header and its tool', () => {
    const m = normalizeMachine({ postProcessor: { header: 'G21 ; mine', footer: 'M5', decimalPlaces: 2 }, cutting: { tool: { type: 'flat', diameter: 4, fluteCount: 3 } } });
    expect(m.post.header).toBe('G21 ; mine');
    expect(m.post.decimalPlaces).toBe(2);
    expect(m.tools.some((t) => t.diameter === 4 && t.flutes === 3)).toBe(true);
    expect(normalizeMachine('garbage')).toEqual(createDefaultMachine());
  });

  it('says what stops a machine being saved', () => {
    const m = createDefaultMachine();
    m.clearanceZ = 2;
    m.spindle = { kind: 'dial', dial: [] };
    m.tools[1]!.number = m.tools[0]!.number;
    expect(machineProblems(m)).toHaveLength(3);
    expect(machineProblems(createDefaultMachine())).toEqual([]);
  });
});

describe('the steps at the machine', () => {
  it('fits the first tool, zeroes, and stops for each tool change and dial setting', () => {
    const j = job();
    j.operations = [newPlanOperation('drill', 's', ['h1', 'h2'], 'outside'), newPlanOperation('profile', 's', ['r'], 'outside')];
    const machine = createDefaultMachine();
    machine.spindle = { kind: 'dial', dial: [{ setting: '1', rpm: 10000 }, { setting: '6', rpm: 30000 }] };
    const r = resolveJob(j, machine, entities);
    const steps = operatorSteps(r.ops, 'M0', 'the front left corner of the stock', 'stock-top', 6, (id) => j.operations.findIndex((o) => o.id === id) + 1);
    expect(steps[0]).toMatch(/^Fit T4/);
    expect(steps[1]).toMatch(/X0 Y0 at the front left corner.*Z0 on the top of the stock/);
    expect(steps.some((s) => /Before operation 2 the program stops: fit T\d/.test(s))).toBe(true);
    expect(steps.filter((s) => /speed dial/.test(s)).length).toBeGreaterThanOrEqual(2);
  });

  it('zeroes on the spoilboard throughout when Z0 is the spoilboard', () => {
    const j = job();
    j.operations = [newPlanOperation('drill', 's', ['h1', 'h2'], 'outside'), newPlanOperation('profile', 's', ['r'], 'outside')];
    const r = resolveJob(j, createDefaultMachine(), entities);
    const steps = operatorSteps(r.ops, 'M0', 'the centre of the stock', 'spoilboard', 12, (id) => j.operations.findIndex((o) => o.id === id) + 1);
    expect(steps[1]).toMatch(/Z0 on the spoilboard \(the stock top is then Z12\)/);
    expect(steps.find((s) => /Before operation 2/.test(s))).toMatch(/set Z0 on the spoilboard again/);
    expect(steps.join('\n')).not.toMatch(/on the top of the stock/);
  });
});
