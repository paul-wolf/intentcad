import { describe, it, expect } from 'vitest';
import type { Entity, Sketch } from '@/types/document';
import { XY_PLANE, missingUses, sharedProfile, sketchGroups, sketchNames, skAliases, usesShared, pinnedChanges } from './sharedSketch';

const circle = (id: string, x: number, y: number, r: number, extra: Partial<Entity> = {}): Entity =>
  ({ id, type: 'circle', center: { x, y }, radius: r, ...extra }) as Entity;

// a frame: an outline, four arm holes in a group, a named centre hole, a
// construction circle and a point
const frame = (extra: Partial<Sketch> = {}): Sketch => ({
  id: 's1', name: 'Frame', visible: true, constraints: [],
  entities: [
    { id: 'out', type: 'rectangle', center: { x: 0, y: 0 }, width: 60, height: 60, name: 'outline' },
    circle('h1', 22, 22, 1.6), circle('h2', -22, 22, 1.6), circle('h3', -22, -22, 1.6), circle('h4', 22, -22, 1.6),
    circle('mid', 0, 0, 5, { name: 'centre' }),
    circle('guide', 0, 0, 31, { construction: true }),
    { id: 'p', type: 'point', position: { x: 10, y: 0 } },
    { id: 'l', type: 'line', points: [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 5 }], bulge: [0, 0.5] },
  ],
  groups: [{ name: 'arm holes', ids: ['h1', 'h2', 'h3', 'h4'] }],
  ...extra,
});

describe('sharedProfile', () => {
  it('puts a sketch with no plane on XY of the project frame', () => {
    expect(sharedProfile(frame()).plane).toEqual(XY_PLANE);
    const plane = { origin: [0, 0, 5] as [number, number, number], normal: [0, 0, 1] as [number, number, number], xAxis: [1, 0, 0] as [number, number, number] };
    expect(sharedProfile(frame({ plane })).plane).toEqual(plane);
  });

  it('lists its real elements one by one, with their ids', () => {
    const { items } = sharedProfile(frame());
    expect(items.circles.map((c) => c.id)).toEqual(['h1', 'h2', 'h3', 'h4', 'mid']);   // not the construction circle
    expect(items.circles[0]).toEqual({ id: 'h1', c: [22, 22], r: 1.6 });
    expect(items.points).toEqual([{ id: 'p', p: [10, 0] }]);
    // the line's straight segment only (the second is an arc)
    expect(items.lines).toEqual([{ id: 'l', p: [[0, 0], [5, 0]] }]);
  });

  it('keeps names and groups, and the closed shapes of each', () => {
    const p = sharedProfile(frame());
    expect(p.names).toEqual({ outline: 'out', centre: 'mid' });
    expect(p.groups).toEqual({ 'arm holes': ['h1', 'h2', 'h3', 'h4'] });
    expect(p.loops).toHaveLength(6);   // outline, four holes, centre
    expect(p.sub['g:arm holes']).toHaveLength(4);
    expect(p.sub['g:arm holes']![0]).toEqual([{ t: 'circle', c: [22, 22], r: 1.6 }]);
    expect(p.sub['n:outline']![0]).toHaveLength(4);
    expect(p.sub['n:centre']).toEqual([[{ t: 'circle', c: [0, 0], r: 5 }]]);
  });

  it('drops deleted elements from groups, and blank or repeated names', () => {
    const s = frame({ groups: [{ name: 'arm holes', ids: ['h1', 'gone'] }, { name: ' ', ids: ['h2'] }] });
    s.entities.push(circle('dup', 1, 1, 1, { name: 'centre' }));
    expect(sketchGroups(s)).toEqual({ 'arm holes': ['h1'] });
    expect(sketchNames(s).centre).toBe('mid');
  });

  it('changes when a group is renamed (so parts that use it go out of date)', () => {
    const a = sharedProfile(frame());
    const b = sharedProfile(frame({ groups: [{ name: 'holes', ids: ['h1', 'h2', 'h3', 'h4'] }] }));
    expect(JSON.stringify(a)).not.toEqual(JSON.stringify(b));
  });
});

describe('missingUses', () => {
  it('names the groups and elements a part asks for that are gone', () => {
    const s = frame({ groups: [] });
    expect(missingUses(s, { groups: ['arm holes'], names: ['outline', 'lid'] }))
      .toEqual(['group "arm holes"', 'element "lid"']);
    expect(missingUses(frame(), { groups: ['arm holes'], names: ['centre'] })).toEqual([]);
  });
});

describe('usesShared', () => {
  it('finds SK aliases and PP names in a script', () => {
    const code = 'plate = extrude(SK["frame"].group("arm holes"), 2)\nd = PP["arm_pitch"]\ne = PP.get(\'x\', 1)';
    expect(skAliases(code)).toEqual(['frame']);
    expect(usesShared(code)).toBe(true);
    expect(usesShared('d = P["arm_pitch"]')).toBe(false);
    expect(usesShared("w = PP.get('width', 3)")).toBe(true);
  });
});

describe('pinnedChanges', () => {
  it('names the pinned sketches and parameters older than the latest', () => {
    const ref = { document: 'd', sketch: 's' };
    const pinned = { sk: { frame: { ...ref, version: 'a' }, lid: { ...ref, version: 'b' } }, pp: { pitch: 44, od: 30 } };
    const latest = { sk: { frame: { ...ref, version: 'c' }, lid: { ...ref, version: 'b' } }, pp: { pitch: 45, od: 30 } };
    expect(pinnedChanges(pinned, latest)).toEqual(['"frame"', 'PP "pitch"']);
    expect(pinnedChanges(pinned, pinned)).toEqual([]);
  });
});
