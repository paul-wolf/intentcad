import { describe, it, expect } from 'vitest';
import type { Entity, RectangleEntity, Sketch } from '@/types/document';
import type { RunEdge } from '@/api/client';
import { faceSketchMenu, newFaceSketch, referencedProfiles, refreshOutline, type SketchBindings } from './faceSketch';
import { resolvePartSketches, sketchParamWarning, sketchVars } from './sketchParams';
import { measureDimension, resolveSketch } from '@/utils/resolveSketch';
import { completeName, expressionNames } from '@/utils/expression';
import type { Vec3 } from './dragHandle';

// A USB cutout on a case's right wall (plane u = y, v = z; sketch y = −v):
// a 12 x 6 rectangle whose bottom edge is `floor + 2` above the origin (z = 0),
// and a 2 mm hole kept on the rectangle's centre.
function usbSketch(): Sketch {
  const origin: Entity = { id: 'o', type: 'point', position: { x: 0, y: 0 }, construction: true, reference: true };
  const rect: RectangleEntity = { id: 'r', type: 'rectangle', center: { x: 0, y: -8 }, width: 12, height: 6 };
  return {
    id: 'sk1', name: 'USB cutout', visible: true,
    plane: { origin: [40, 0, 0], normal: [1, 0, 0], xAxis: [0, 1, 0] },
    face: { center: [40, 0, 11.5], normal: [1, 0, 0], area: 1150 },
    entities: [
      origin, rect,
      { id: 'h', type: 'circle', center: { x: 0, y: -8 }, radius: 1 },
      // the bottom edge (sketch y = center.y + height/2: lowest on the wall) from the origin
      { id: 'd1', type: 'dimension', targetEntityId: 'o', pointIndex: 0, targetEntityId2: 'r', segmentIndex: 0,
        segmentIndex2: 0, offset: 4, expression: 'floor + 2' },
      { id: 'd2', type: 'dimension', targetEntityId: 'r', segmentIndex: 0, offset: 3 },   // width, plain
    ],
    constraints: [
      { id: 'c1', type: 'fixed', entityId: 'o' },
      { id: 'c2', type: 'coincident', entityId: 'h', pointIndex: 0, targetEntityId: 'r', targetPointIndex: 0 },
    ],
  };
}
const rectOf = (s: Sketch) => s.entities.find((e) => e.id === 'r') as RectangleEntity;
const holeOf = (s: Sketch) => s.entities.find((e) => e.id === 'h') as Extract<Entity, { type: 'circle' }>;
// the bottom edge's height on the wall (v = −y)
const bottom = (s: Sketch) => -(rectOf(s).center.y + rectOf(s).height / 2);

describe('resolveSketch', () => {
  it('sets the bottom edge from floor + 2, and the rest holds', () => {
    const s = usbSketch();
    const before = structuredClone(s);
    const at3 = resolveSketch(s, { floor: 3 });
    expect(at3.changed).toBe(false);          // drawn at floor = 3 already
    expect(at3.sketch).toBe(s);

    const at15 = resolveSketch(s, { floor: 15 });
    expect(at15.changed).toBe(true);
    expect(at15.warnings).toEqual([]);
    expect(bottom(at15.sketch)).toBeCloseTo(17, 6);
    expect(rectOf(at15.sketch).width).toBeCloseTo(12, 6);
    expect(rectOf(at15.sketch).height).toBeCloseTo(6, 6);
    expect(rectOf(at15.sketch).center.x).toBeCloseTo(0, 6);
    // the hole is still on the rectangle's centre, the origin hasn't moved
    expect(holeOf(at15.sketch).center.x).toBeCloseTo(rectOf(at15.sketch).center.x, 6);
    expect(holeOf(at15.sketch).center.y).toBeCloseTo(rectOf(at15.sketch).center.y, 6);
    expect(at15.sketch.entities.find((e) => e.id === 'o')).toEqual(s.entities[0]);
    expect(measureDimension(at15.sketch.entities.find((e) => e.id === 'd1')!, at15.sketch.entities)).toBeCloseTo(17, 6);

    // and back
    expect(bottom(resolveSketch(at15.sketch, { floor: 3 }).sketch)).toBeCloseTo(5, 6);
    // the input is never touched
    expect(s).toEqual(before);
  });

  it('keeps the last value and says which name is missing', () => {
    const s = usbSketch();
    const r = resolveSketch(s, { flor: 15 });
    expect(r.changed).toBe(false);
    expect(r.sketch).toBe(s);
    expect(r.warnings).toEqual([{ sketch: 'USB cutout', dimensionId: 'd1', expression: 'floor + 2', missing: ['floor'] }]);
    expect(s.entities.find((e) => e.id === 'd1')).toMatchObject({ expression: 'floor + 2' });   // never cleared
    expect(sketchParamWarning(r.warnings[0]!))
      .toBe("Sketch 'USB cutout': floor + 2 uses 'floor', which isn't a parameter; kept its last size");
  });
});

describe('before a build', () => {
  const code = (floor: number) =>
    `P = dict(floor=${floor}, wall_h=20)\npart = Box(80, 50, P["floor"])\npart -= extrude(sketch("USB cutout"), amount=-5)\n`;

  it('the variables are the document parameters and P, P winning a clash', () => {
    expect(sketchVars(code(3), { floor: 99, other: 1 }, null)).toEqual({ floor: 3, wall_h: 20, other: 1 });
  });

  it('a changed P changes the profile sent with the build; an unchanged one does not', () => {
    const sketches = [usbSketch()];
    const same = resolvePartSketches(code(3), sketches, {}, null);
    expect(same.changed).toEqual([]);
    expect(same.sketches).toBe(sketches);
    expect(referencedProfiles(code(3), same.sketches)).toEqual(referencedProfiles(code(3), sketches));

    const up = resolvePartSketches(code(15), sketches, {}, null);
    expect(up.changed).toEqual(['USB cutout']);
    const before = referencedProfiles(code(3), sketches)['USB cutout']!;
    const after = referencedProfiles(code(15), up.sketches)['USB cutout']!;
    expect(after).not.toEqual(before);
    // the loop's corners went up 12 (sketch y = −v)
    const ys = (p: typeof before) => p.loops.flat().flatMap((seg) => ('p' in seg ? seg.p.map((q) => q[1]) : []));
    expect(Math.max(...ys(after))).toBeCloseTo(Math.max(...ys(before)) - 12, 6);
    expect(sketches[0]).toEqual(usbSketch());
  });

  it('only sketches the script uses, and a renamed P key warns but keeps the sketch', () => {
    const sketches = [usbSketch()];
    expect(resolvePartSketches('P = dict(floor=15)\npart = Box(1, 1, 1)\n', sketches, {}, null).changed).toEqual([]);
    const renamed = code(15).replace('floor=15', 'base=15').replace('P["floor"]', 'P["base"]');
    // the last build's params had floor; they don't stand in for a numeric key that was renamed
    const r = resolvePartSketches(renamed, sketches, {}, { floor: 3, wall_h: 20 });
    expect(r.changed).toEqual([]);
    expect(r.sketches).toBe(sketches);
    expect(r.warnings.map((w) => w.missing)).toEqual([['floor']]);
  });
});

// the right wall of an 80 x 50 case, walls `h` tall on a 3 mm floor: its outline in world space
function wall(h: number): { face: { index: number; center: Vec3; normal: Vec3; area: number }; edges: RunEdge[] } {
  const c: Vec3[] = [[40, -25, 0], [40, 25, 0], [40, 25, 3 + h], [40, -25, 3 + h]];
  return {
    face: { index: 7, center: [40, 0, (3 + h) / 2], normal: [1, 0, 0], area: 50 * (3 + h) },
    edges: c.map((p, i) => ({ index: i, kind: 'line', faceIndices: [7, 20 + i], polyline: [p, c[(i + 1) % 4]!] })),
  };
}

describe('the reference outline, drawn again on entering', () => {
  const plane = { origin: [40, 0, 0] as Vec3, normal: [1, 0, 0] as Vec3, xAxis: [0, 1, 0] as Vec3 };
  function drawnAt(h: number): Sketch {
    const w = wall(h);
    const s = newFaceSketch('USB cutout', w.face, w.edges);
    s.plane = plane;   // keep the test's plane (u = y, v = z)
    const fresh = refreshOutline(s, w.face, w.edges, plane) ?? s;
    // a slot 4 below the top edge, dimensioned from it
    const top = fresh.entities.find((e) => e.type === 'line' && e.points.every((p) => Math.abs(p.y + 3 + h) < 1e-6))!;
    fresh.entities.push(
      { id: 'r', type: 'rectangle', center: { x: 0, y: -(3 + h) + 4 + 1 }, width: 10, height: 2 },
      { id: 'd', type: 'dimension', targetEntityId: top.id, segmentIndex: 0, targetEntityId2: 'r', segmentIndex2: 2, offset: 2 },
    );
    return fresh;
  }

  it('leaves an outline that still fits alone', () => {
    const s = drawnAt(20);
    const w = wall(20);
    expect(refreshOutline(s, w.face, w.edges, plane)).toBeNull();
  });

  it('follows a taller wall, keeps the edge ids and what is dimensioned to them', () => {
    const s = drawnAt(20);
    const w = wall(30);
    const r = refreshOutline(s, w.face, w.edges, plane)!;
    expect(r).not.toBeNull();
    const refs = (k: Sketch) => k.entities.filter((e) => 'reference' in e && e.reference).map((e) => e.id).sort();
    expect(refs(r)).toEqual(refs(s));
    // the top edge is at v = 33 now, and the slot is still 4 below it
    const ys = r.entities.flatMap((e) => (e.type === 'line' ? e.points.map((p) => -p.y) : []));
    expect(Math.max(...ys)).toBeCloseTo(33, 6);
    expect(measureDimension(r.entities.find((e) => e.id === 'd')!, r.entities)).toBeCloseTo(4, 6);
    expect(rectOf(r).center.y).toBeCloseTo(-33 + 5, 6);
    // every reference edge is still fixed
    for (const id of refs(r)) expect(r.constraints.some((c) => c.type === 'fixed' && c.entityId === id)).toBe(true);
  });

  it('does nothing without the face’s edges, or on a sketch not drawn on a face', () => {
    const s = drawnAt(20);
    expect(refreshOutline(s, wall(30).face, [], plane)).toBeNull();
    expect(refreshOutline({ ...s, face: undefined }, wall(30).face, wall(30).edges, plane)).toBeNull();
  });
});

describe('the sketch menu on a face', () => {
  const top = { index: 3, center: [0, 0, 6] as Vec3, normal: [0, 0, 1] as Vec3, area: 2400 };
  const plate: RunEdge[] = ([[-30, -20, 6], [30, -20, 6], [30, 20, 6], [-30, 20, 6]] as Vec3[]).map((p, i, c) => ({
    index: i, kind: 'line', faceIndices: [3, 10 + i], polyline: [p, c[(i + 1) % 4]!],
  }));
  const withHole = (name: string, n: number): Sketch => {
    const s = newFaceSketch(name, top, plate);
    for (let i = 0; i < n; i++) s.entities.push({ id: `${name}${i}`, type: 'circle', center: { x: i * 5, y: 0 }, radius: 1 });
    return s;
  };

  it('none: no menu, a new sketch straight away', () => {
    expect(faceSketchMenu([], top)).toBeNull();
    const side = newFaceSketch('Side', { index: 4, center: [30, 0, 3], normal: [1, 0, 0], area: 240 }, []);
    expect(faceSketchMenu([side], top)).toBeNull();
  });

  it('one: still a menu, with it and a new one', () => {
    const a = withHole('Holes', 2);
    expect(faceSketchMenu([a], top)).toEqual({ face: top, items: [{ id: a.id, name: 'Holes', count: 2 }] });
  });

  it('several: each with its count (outline and dimensions not counted), wherever the last build put them', () => {
    const a = withHole('Holes', 2), b = withHole('Logo', 5);
    b.entities.push({ id: 'dim', type: 'dimension', targetEntityId: 'Logo0', segmentIndex: 0, offset: 1 });
    expect(faceSketchMenu([a, b], top)!.items.map((i) => [i.name, i.count])).toEqual([['Holes', 2], ['Logo', 5]]);
    // the plate made 10 thick: the sketches are where the build found the top
    const up = { ...top, center: [0, 0, 10] as Vec3 };
    const bound: SketchBindings = Object.fromEntries([a, b].map((s) => [s.name,
      { status: 'moved' as const, moved_by: 4, plane: { ...s.plane!, origin: [0, 0, 10] as Vec3 } }]));
    expect(faceSketchMenu([a, b], up)).toBeNull();
    expect(faceSketchMenu([a, b], up, bound)!.items).toHaveLength(2);
  });
});

describe('expression names', () => {
  it('lists the names used and completes the one being typed', () => {
    expect(expressionNames('floor + 2 * floor - wall_h')).toEqual(['floor', 'wall_h']);
    expect(completeName('fl', 2, ['floor', 'flange', 'width'])).toEqual({ start: 0, prefix: 'fl', matches: ['flange', 'floor'] });
    expect(completeName('width / 2 + fl', 14, ['floor'])).toMatchObject({ start: 12, matches: ['floor'] });
    expect(completeName('2', 1, ['floor']).matches).toEqual([]);
  });
});
