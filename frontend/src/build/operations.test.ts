import { describe, it, expect, vi } from 'vitest';
import {
  LAYOUTS, OPERATIONS, OP_GROUPS, OPS_KEY, RECENT_MAX, RESERVED_KEYS, SKETCH_KEYS, opById, opForKey, pushRecent,
  stepLayout, toggleOps, type Layout, type OpContext, type OpModel, type OpSelection,
} from './operations';
import { VIEW_KEYS } from './viewOrient';

// a built part, nothing going on
const MODEL: OpModel = {
  status: 'done', hasCode: true, dialogOpen: false, sketching: false, canSketch: true, asking: false,
  holeSketches: 0, holeAt: 'at the centre of the top face', autoRound: false, exporting: false, importing: false,
  hasParams: true, showParams: true, ortho: false, measure: '60.0 × 40.0 mm',
};
const faces = (...kinds: string[]): OpSelection => ({ faces: kinds.map((kind) => ({ kind })), edges: [] });
const NONE = faces();
const FLOOR = faces('plane');
const CURVED = faces('cylinder');
const TWO = faces('plane', 'plane');
const SEVERAL = faces('plane', 'plane', 'cylinder', 'plane');

const ok = (id: string, sel: OpSelection, m: OpModel = MODEL) => opById(id)!.needs(sel, m);
const reason = (id: string, sel: OpSelection, m: OpModel = MODEL) => {
  const n = ok(id, sel, m);
  return n.ok ? null : n.reason;
};

describe('the operation registry', () => {
  it('gives every entry what the grid, the help card and the top bar need', () => {
    for (const op of OPERATIONS) {
      for (const k of ['id', 'name', 'group', 'icon', 'help', 'longHelp', 'example'] as const) {
        expect(typeof op[k], `${op.id}.${k}`).toBe('string');
        expect(op[k].length, `${op.id}.${k}`).toBeGreaterThan(0);
      }
      expect(OP_GROUPS).toContain(op.group);
      expect(typeof op.needs).toBe('function');
      expect(typeof op.run).toBe('function');
      // the one-liner is one line; the longer help two to four sentences
      expect(op.help).not.toMatch(/\n/);
      const sentences = op.longHelp.split(/[.!?](?:\s|$)/).filter((x) => x.trim()).length;
      expect(sentences, op.id).toBeGreaterThanOrEqual(2);
      expect(sentences, op.id).toBeLessThanOrEqual(4);
    }
  });

  it('has unique ids and unique shortcuts', () => {
    const ids = OPERATIONS.map((o) => o.id);
    expect(new Set(ids).size).toBe(ids.length);
    const keys = OPERATIONS.flatMap((o) => (o.shortcut ? [o.shortcut] : []));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("keeps the operations' keys off the editor's other keys", () => {
    for (const op of OPERATIONS) {
      if (!op.shortcut) continue;
      const [first] = op.shortcut.split(' ');
      expect(Object.keys(RESERVED_KEYS), op.id).not.toContain(first);
    }
    // the views are the keys 1–6 and 0 they always were
    for (const [key, view] of Object.entries(VIEW_KEYS)) expect(opForKey(key)?.id).toBe(`view-${view}`);
    expect(opForKey('k')?.id).toBe('sketch-face');
    expect(opForKey('L')).toBeUndefined();
  });

  it('picks a direct key for Operations that nothing else uses, here or in the sketcher', () => {
    expect(OPS_KEY).toBe('U');
    expect(OPERATIONS.some((o) => o.shortcut?.split(' ')[0] === OPS_KEY)).toBe(false);
    expect(SKETCH_KEYS).not.toContain(OPS_KEY);
    expect(Object.entries(RESERVED_KEYS).filter(([k]) => k === OPS_KEY).map(([, v]) => v))
      .toEqual(['Operations layout, and back']);
  });

  it('pins the top bar’s operations', () => {
    expect(OPERATIONS.filter((o) => o.pinned).map((o) => o.id)).toEqual(['sketch-face', 'hole', 'shell', 'fillet', 'round', 'build']);
  });

  it('runs through the editor’s own actions', () => {
    const ctx = Object.fromEntries(
      ['sketchOnSelection', 'sketchOnPlane', 'shell', 'hole', 'fillet', 'chamfer', 'ask', 'build', 'importStep', 'exportAs', 'versions',
       'process', 'toggleParams', 'setView', 'lookAtSelection', 'toggleOrtho', 'copyMeasure'].map((k) => [k, vi.fn()]),
    ) as unknown as Record<keyof OpContext, ReturnType<typeof vi.fn>>;
    for (const op of OPERATIONS) op.run(ctx as unknown as OpContext);
    expect(ctx.shell).toHaveBeenCalledTimes(1);
    expect(ctx.hole).toHaveBeenCalledTimes(1);
    expect(ctx.fillet).toHaveBeenCalledTimes(1);
    expect(ctx.chamfer).toHaveBeenCalledTimes(1);
    expect(ctx.sketchOnPlane.mock.calls.map((c) => c[0])).toEqual(['top', 'front', 'right']);
    expect(ctx.exportAs.mock.calls.map((c) => c[0])).toEqual(['stl', 'step', 'stl-parts', 'dxf', 'dxf-views']);
    expect(ctx.setView).toHaveBeenCalledTimes(7);
    expect(ctx.ask).toHaveBeenCalledTimes(4);   // round, lighten, keep sharp, fix
  });
});

describe('what each operation needs', () => {
  it('with nothing selected', () => {
    expect(reason('sketch-face', NONE)).toBe('Select a flat face');
    expect(reason('extrude', NONE)).toBe('Select a flat face');
    expect(reason('hole', NONE)).toBe('Select a flat face');
    expect(reason('shell', NONE)).toBe('Select the faces to remove');
    expect(reason('measure', NONE)).toBe('Select faces or edges');
    expect(reason('fillet', NONE)).toBe('Select edges (double-click for a whole loop)');
    expect(reason('chamfer', FLOOR)).toBe('Select edges (double-click for a whole loop)');
    expect(reason('normal', NONE)).toBe('Select a face');
    expect(reason('protect', NONE, { ...MODEL, autoRound: true })).toBe('Select the faces to keep sharp');
    // what doesn't depend on the selection
    for (const id of ['sketch-top', 'round', 'lighten', 'build', 'export-stl', 'view-iso', 'ortho', 'params', 'versions'])
      expect(ok(id, NONE).ok, id).toBe(true);
    // a sketch with points to put holes at: Hole needs no face
    expect(ok('hole', NONE, { ...MODEL, holeSketches: 1 }).ok).toBe(true);
    expect(opById('hole')!.detail!(NONE, { ...MODEL, holeSketches: 1 })).toBe("at a sketch's points");
  });

  it('with one flat face (the floor)', () => {
    for (const id of ['sketch-face', 'extrude', 'hole', 'shell', 'measure', 'normal']) expect(ok(id, FLOOR).ok, id).toBe(true);
    expect(opById('hole')!.detail!(FLOOR, MODEL)).toBe('at the centre of the top face');
    expect(opById('shell')!.detail!(FLOOR, MODEL)).toBe('1 face left open');
    expect(opById('measure')!.detail!(FLOOR, MODEL)).toBe('60.0 × 40.0 mm');
    expect(reason('protect', FLOOR)).toBe('Round the part first');
    expect(ok('protect', FLOOR, { ...MODEL, autoRound: true }).ok).toBe(true);
  });

  it('with one curved face', () => {
    expect(reason('sketch-face', CURVED)).toBe('Select a flat face, not a curved one');
    expect(reason('hole', CURVED)).toBe('Select a flat face, not a curved one');
    for (const id of ['shell', 'measure', 'normal']) expect(ok(id, CURVED).ok, id).toBe(true);
  });

  it('with two faces', () => {
    expect(reason('sketch-face', TWO)).toBe('Select just one flat face');
    expect(reason('hole', TWO)).toBe('Select just one flat face');
    expect(ok('shell', TWO).ok).toBe(true);
    expect(opById('shell')!.detail!(TWO, MODEL)).toBe('2 faces left open');
    expect(ok('measure', TWO, { ...MODEL, measure: '52.00 mm' }).ok).toBe(true);
  });

  it('with several faces', () => {
    expect(reason('sketch-face', SEVERAL)).toBe('Select just one flat face');
    expect(reason('measure', SEVERAL)).toBe('Select one or two faces');
    expect(ok('shell', SEVERAL).ok).toBe(true);
    expect(opById('shell')!.detail!(SEVERAL, MODEL)).toBe('4 faces left open');
    expect(ok('normal', SEVERAL).ok).toBe(true);
  });

  it('with edges', () => {
    const loop: OpSelection = { faces: [], edges: [{ kind: 'line' }, { kind: 'line' }, { kind: 'circle' }] };
    for (const id of ['fillet', 'chamfer']) expect(ok(id, loop).ok, id).toBe(true);
    expect(opById('fillet')!.detail!(loop, MODEL)).toBe('3 edges rounded');
    expect(opById('chamfer')!.detail!({ faces: [], edges: [{ kind: 'line' }] }, MODEL)).toBe('1 edge bevelled');
    expect(ok('measure', loop, { ...MODEL, measure: '200.00 mm (3 edges, total length)' }).ok).toBe(true);
    expect(reason('fillet', loop, { ...MODEL, dialogOpen: true })).toBe('Close the open dialog first');
    expect(reason('chamfer', loop, { ...MODEL, status: 'building' })).toBe('Wait for the build');
  });

  it('says what the state of the model is in the way', () => {
    expect(reason('shell', FLOOR, { ...MODEL, status: 'building' })).toBe('Wait for the build');
    expect(reason('shell', FLOOR, { ...MODEL, status: 'error' })).toBe('Fix the build first');
    expect(reason('export-stl', NONE, { ...MODEL, status: 'idle' })).toBe('Build the part first');
    expect(reason('hole', FLOOR, { ...MODEL, dialogOpen: true })).toBe('Close the open dialog first');
    expect(reason('sketch-face', FLOOR, { ...MODEL, sketching: true })).toBe('Finish the sketch first');
    expect(reason('round', NONE, { ...MODEL, asking: true })).toBe('The AI is working on a change');
    expect(reason('fix', NONE)).toBe('Only when a build fails');
    expect(ok('fix', NONE, { ...MODEL, status: 'error' }).ok).toBe(true);
    expect(reason('params', NONE, { ...MODEL, hasParams: false })).toBe('This part has no parameters');
    expect(opById('build')!.label!({ ...MODEL, status: 'building' })).toBe('Cancel build');
  });
});

describe('the layouts', () => {
  it('step through Code, Chat, 3D and Operations, and back', () => {
    const fwd: Layout[] = [];
    let l: Layout = 'code';
    for (let i = 0; i < 4; i++) fwd.push(l = stepLayout(l, 1));
    expect(fwd).toEqual(['chat', 'model', 'ops', 'code']);
    const back: Layout[] = [];
    for (let i = 0; i < 4; i++) back.push(l = stepLayout(l, -1));
    expect(back).toEqual(['ops', 'model', 'chat', 'code']);
    expect(LAYOUTS.map(([k]) => k)).toEqual(['code', 'chat', 'model', 'ops']);
  });

  it('U goes to Operations and back to the layout before', () => {
    expect(toggleOps('chat', 'code')).toBe('ops');
    expect(toggleOps('ops', 'chat')).toBe('chat');
    expect(toggleOps('ops', 'model')).toBe('model');
    expect(toggleOps('ops', 'ops')).toBe('code');
  });
});

describe('the recent row', () => {
  it('keeps the last four used, latest first, without repeats or views', () => {
    let r: string[] = [];
    for (const id of ['shell', 'hole', 'view-top', 'round', 'shell', 'export-stl', 'lighten']) r = pushRecent(r, id);
    expect(r).toEqual(['lighten', 'export-stl', 'shell', 'round']);
    expect(r).toHaveLength(RECENT_MAX);
    expect(pushRecent(r, 'nope')).toBe(r);
  });
});
