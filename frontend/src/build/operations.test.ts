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
  hasParams: true, showParams: true, ortho: false, measure: '60.0 × 40.0 mm', section: false, mirrorSteps: 0,
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
       'process', 'addContextFile', 'toggleParams', 'setView', 'lookAtSelection', 'toggleOrtho', 'copyMeasure',
       'section', 'overhangs', 'offsetPlane', 'edgePlane', 'tangentPlane', 'mirrorBody', 'mirrorSteps', 'patternBody', 'patternSteps', 'revolve'].map((k) => [k, vi.fn()]),
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
    expect(ctx.section).toHaveBeenCalledTimes(1);
    expect(ctx.overhangs).toHaveBeenCalledTimes(1);
    expect(ctx.offsetPlane).toHaveBeenCalledTimes(1);
    expect(ctx.edgePlane).toHaveBeenCalledTimes(1);
    expect(ctx.tangentPlane).toHaveBeenCalledTimes(1);
    expect(ctx.mirrorBody).toHaveBeenCalledTimes(1);
    expect(ctx.mirrorSteps).toHaveBeenCalledTimes(1);
    expect(ctx.patternBody).toHaveBeenCalledTimes(1);
    expect(ctx.patternSteps).toHaveBeenCalledTimes(1);
    expect(ctx.revolve).toHaveBeenCalledTimes(1);
  });

  it('revolves a sketch with a closed shape, built or not', () => {
    expect(opById('revolve')!.group).toBe('Create');
    expect(reason('revolve', NONE)).toBe('Draw a sketch with a closed shape first (K), with the axis line in it');
    expect(ok('revolve', NONE, { ...MODEL, revolveSketches: 1 }).ok).toBe(true);
    expect(ok('revolve', NONE, { ...MODEL, revolveSketches: 1, status: 'idle', hasCode: false }).ok).toBe(true);
    expect(reason('revolve', NONE, { ...MODEL, revolveSketches: 1, sketching: true })).toBe('Finish the sketch first');
  });

  it('patterns the body (along a picked edge or face) or the chosen steps', () => {
    expect(opById('pattern-body')!.group).toBe('Pattern');
    expect(opById('pattern-steps')!.group).toBe('Pattern');
    expect(ok('pattern-body', NONE).ok).toBe(true);
    expect(reason('pattern-body', NONE, { ...MODEL, status: 'idle' })).toBe('Build the part first');
    expect(opById('pattern-body')!.detail!({ faces: [], edges: [{ kind: 'line' }] }, MODEL)).toBe('along the selected edge');
    expect(opById('pattern-body')!.detail!(FLOOR, MODEL)).toBe('from the selected face');
    expect(reason('pattern-steps', NONE)).toBe('Choose steps in the steps list (Ctrl-click for more)');
    const three = { ...MODEL, patternSteps: 3 };
    expect(ok('pattern-steps', NONE, three).ok).toBe(true);
    expect(opById('pattern-steps')!.detail!(NONE, three)).toBe('3 steps chosen');
    expect(reason('pattern-steps', NONE, { ...three, dialogOpen: true })).toBe('Close the open dialog first');
  });

  it('mirrors the body or the chosen steps across one flat face, one plane, or one picked in the dialog', () => {
    const plane = (name: string): OpSelection => ({ faces: [], edges: [], planes: [{ name }] });
    expect(opById('mirror-body')!.group).toBe('Pattern');
    expect(ok('mirror-body', NONE).ok).toBe(true);
    expect(ok('mirror-body', FLOOR).ok).toBe(true);
    expect(ok('mirror-body', plane('Mid')).ok).toBe(true);
    expect(reason('mirror-body', CURVED)).toBe('Select a flat face, not a curved one');
    expect(reason('mirror-body', TWO)).toBe('Select one flat face or plane, or nothing');
    expect(reason('mirror-body', { faces: [], edges: [{ kind: 'line' }] })).toBe('Select one flat face or plane, or nothing');
    expect(reason('mirror-body', NONE, { ...MODEL, status: 'idle' })).toBe('Build the part first');
    expect(opById('mirror-body')!.detail!(plane('Mid'), MODEL)).toBe('across Mid');
    expect(reason('mirror-steps', NONE)).toBe('Choose steps in the steps list (Ctrl-click for more)');
    const two = { ...MODEL, mirrorSteps: 2 };
    expect(ok('mirror-steps', plane('Mid'), two).ok).toBe(true);
    expect(opById('mirror-steps')!.detail!(plane('Mid'), two)).toBe('2 steps chosen');
    expect(reason('mirror-steps', NONE, { ...two, dialogOpen: true })).toBe('Close the open dialog first');
  });

  it('gives Section a key nothing else uses, here or in the sketcher', () => {
    const op = opById('section')!;
    expect(op.shortcut).toBe('Z');
    expect(op.group).toBe('Inspect');
    expect(opForKey('z')?.id).toBe('section');
    expect(OPERATIONS.filter((o) => o.shortcut?.split(' ')[0] === 'Z')).toHaveLength(1);
    expect(Object.keys(RESERVED_KEYS)).not.toContain('Z');
    expect(SKETCH_KEYS).not.toContain('Z');
    expect([OPS_KEY, ...Object.keys(VIEW_KEYS)]).not.toContain('Z');
    // on and off from the same key; N looks at the cut while it is on
    expect(op.label!({ ...MODEL, section: true })).toBe('Section off');
    expect(op.needs(NONE, { ...MODEL, sketching: true })).toEqual({ ok: false, reason: 'Finish the sketch first' });
    expect(ok('normal', NONE, { ...MODEL, section: true }).ok).toBe(true);
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
  it('step through Code, Chat, Context, 3D and Operations, and back', () => {
    const fwd: Layout[] = [];
    let l: Layout = 'code';
    for (let i = 0; i < 5; i++) fwd.push(l = stepLayout(l, 1));
    expect(fwd).toEqual(['chat', 'context', 'model', 'ops', 'code']);
    const back: Layout[] = [];
    for (let i = 0; i < 5; i++) back.push(l = stepLayout(l, -1));
    expect(back).toEqual(['ops', 'model', 'context', 'chat', 'code']);
    expect(LAYOUTS.map(([k]) => k)).toEqual(['code', 'chat', 'context', 'model', 'ops']);
  });

  it('Add context file is a File operation that opens the Context layout', () => {
    const op = OPERATIONS.find((o) => o.id === 'context-add')!;
    expect([op.name, op.group]).toEqual(['Add context file', 'File']);
    const ctx = { addContextFile: vi.fn() } as unknown as OpContext;
    op.run(ctx);
    expect(ctx.addContextFile).toHaveBeenCalledTimes(1);
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

describe('construction planes', () => {
  const edges = (...kinds: string[]): OpSelection => ({ faces: [], edges: kinds.map((kind) => ({ kind })) });
  const plane = (name: string): OpSelection => ({ faces: [], edges: [], planes: [{ name }] });

  it('are in their own Construct group', () => {
    expect(OP_GROUPS).toContain('Construct');
    expect(opById('offset-plane')!.group).toBe('Construct');
    expect(opById('plane-edge')!.group).toBe('Construct');
  });

  it('offset from one flat face, or from a base plane with nothing selected', () => {
    expect(ok('offset-plane', FLOOR).ok).toBe(true);
    expect(ok('offset-plane', NONE).ok).toBe(true);
    expect(opById('offset-plane')!.detail!(NONE, MODEL)).toBe('from a base plane');
    expect(reason('offset-plane', CURVED)).not.toBeNull();
    expect(reason('offset-plane', TWO)).not.toBeNull();
    expect(reason('offset-plane', edges('line'))).toBe('Select one flat face, or nothing');
    expect(reason('offset-plane', NONE, { ...MODEL, status: 'idle' })).not.toBeNull();
  });

  it('go on one straight edge', () => {
    expect(ok('plane-edge', edges('line')).ok).toBe(true);
    expect(reason('plane-edge', edges('circle'))).toBe('Select a straight edge, not a curved one');
    expect(reason('plane-edge', edges('line', 'line'))).toBe('Select one straight edge');
    expect(reason('plane-edge', NONE)).toBe('Select one straight edge');
  });

  it('touch one cylindrical face', () => {
    expect(opById('plane-tangent')!.group).toBe('Construct');
    expect(ok('plane-tangent', CURVED).ok).toBe(true);
    expect(reason('plane-tangent', FLOOR)).toBe('Select a cylindrical face');
    expect(reason('plane-tangent', faces('cylinder', 'cylinder'))).toBe('Select a cylindrical face');
    expect(reason('plane-tangent', NONE)).toBe('Select a cylindrical face');
    expect(reason('plane-tangent', edges('circle'))).toBe('Select a cylindrical face');
  });

  it('can be sketched on, and looked at, when one is selected', () => {
    expect(ok('sketch-face', plane('Lid')).ok).toBe(true);
    expect(opById('sketch-face')!.detail!(plane('Lid'), MODEL)).toBe("on plane 'Lid'");
    expect(ok('normal', plane('Lid')).ok).toBe(true);
  });
});
