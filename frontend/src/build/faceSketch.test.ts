import { describe, it, expect } from 'vitest';
import type { Entity, Sketch } from '@/types/document';
import {
  boundPlane, extrudeDirectionText, extrudeGhost, extrudeSign, extrudeSpan, newConstructionSketch, newPlaneSketch, partSide, typedDepth, depthEdit,
  onTangentPlane, planeSketches, renamePlaneRefs, sketchBasePlane, sketchLoops, sketchProfile, type ExtrudeShape,
} from './faceSketch';

const sketch = (entities: Entity[], plane = true): Sketch => ({
  id: 'sk', name: 'S', visible: true, constraints: [], entities,
  ...(plane ? { plane: { origin: [0, 0, 6], normal: [0, 0, 1], xAxis: [1, 0, 0] } } : {}),
});
const line = (id: string, pts: [number, number][], extra: Partial<Entity> = {}): Entity =>
  ({ id, type: 'line', points: pts.map(([x, y]) => ({ x, y })), ...extra }) as Entity;

describe('sketchLoops', () => {
  it('takes circles, rectangles and closed polylines as they are', () => {
    const { loops, open } = sketchLoops(sketch([
      { id: 'c', type: 'circle', center: { x: 1, y: 2 }, radius: 3 },
      { id: 'r', type: 'rectangle', center: { x: 0, y: 0 }, width: 20, height: 10 },
      line('p', [[0, 0], [5, 0], [5, 5]], { closed: true }),
    ]));
    expect(open).toBe(0);
    expect(loops.map((l) => l.length)).toEqual([1, 4, 3]);
    expect(loops[0]![0]).toEqual({ t: 'circle', c: [1, 2], r: 3 });
  });

  it('skips construction geometry (the face outline)', () => {
    const { loops } = sketchLoops(sketch([
      { id: 'c', type: 'circle', center: { x: 0, y: 0 }, radius: 3, construction: true },
    ]));
    expect(loops).toEqual([]);
  });

  it('turns a filleted rectangle and bulged segments into arcs', () => {
    const { loops } = sketchLoops(sketch([
      { id: 'r', type: 'rectangle', center: { x: 0, y: 0 }, width: 20, height: 10, cornerRadius: 2 },
    ]));
    expect(loops[0]!.map((s) => s.t)).toEqual(['line', 'arc', 'line', 'arc', 'line', 'arc', 'line', 'arc']);
    const arc = loops[0]![1]!;
    if (arc.t !== 'arc') throw new Error('expected an arc');
    // the TR corner arc runs (8,5)→(10,3) about (8,3): its midpoint is r from the centre
    expect(Math.hypot(arc.p[1][0] - 8, arc.p[1][1] - 3)).toBeCloseTo(2, 5);
  });

  it('chains loose lines end to end, reversing pieces drawn backwards', () => {
    const { loops, open } = sketchLoops(sketch([
      line('a', [[0, 0], [10, 0]]),
      line('b', [[10, 10], [10, 0]]),          // drawn the other way
      line('c', [[10, 10], [0, 10], [0, 0]]),
    ]));
    expect(open).toBe(0);
    expect(loops).toHaveLength(1);
    const pts = loops[0]!.map((s) => (s.t === 'line' ? s.p : null));
    expect(pts).toEqual([[[0, 0], [10, 0]], [[10, 0], [10, 10]], [[10, 10], [0, 10]], [[0, 10], [0, 0]]]);
  });

  it('closes a line with a bezier', () => {
    const { loops } = sketchLoops(sketch([
      line('a', [[0, 0], [10, 0]]),
      { id: 'b', type: 'bezier', controlPoints: [{ x: 0, y: 0 }, { x: 2, y: 8 }, { x: 8, y: 8 }, { x: 10, y: 0 }] },
    ]));
    expect(loops).toHaveLength(1);
    expect(loops[0]!.map((s) => s.t)).toEqual(['line', 'bezier']);
    const b = loops[0]![1]!;
    expect(b.t === 'bezier' && b.p[0]).toEqual([10, 0]);   // reversed to continue from the line's end
  });

  it('counts chains that do not close', () => {
    const { loops, open } = sketchLoops(sketch([line('a', [[0, 0], [10, 0], [10, 10]]), line('b', [[50, 50], [60, 50]])]));
    expect(loops).toEqual([]);
    expect(open).toBe(2);
  });
});

describe('sketchProfile', () => {
  it('carries the plane, and is null off a face', () => {
    const s = sketch([{ id: 'c', type: 'circle', center: { x: 0, y: 0 }, radius: 1 }]);
    expect(sketchProfile(s)!.plane.origin).toEqual([0, 0, 6]);
    expect(sketchProfile(sketch([], false))).toBeNull();
  });
});

describe('base plane sketches', () => {
  it('sit on the plane through the origin, with the origin as a fixed reference point', () => {
    const top = newPlaneSketch('Sketch on Top plane', 'top');
    expect(top.plane).toEqual({ origin: [0, 0, 0], normal: [0, 0, 1], xAxis: [1, 0, 0] });
    expect(top.face).toBeUndefined();
    expect(top.entities).toMatchObject([{ type: 'point', position: { x: 0, y: 0 }, construction: true }]);
    expect(top.constraints).toMatchObject([{ type: 'fixed', entityId: top.entities[0]!.id }]);
    expect(sketchLoops(top).loops).toEqual([]);   // the origin point is not a shape
    expect(newPlaneSketch('F', 'front').plane!.xAxis.map((v) => v + 0)).toEqual([1, 0, 0]);
    expect(newPlaneSketch('R', 'right').plane!.xAxis.map((v) => v + 0)).toEqual([0, 1, 0]);
  });

  it('are told apart from face sketches', () => {
    expect(sketchBasePlane(newPlaneSketch('F', 'front'))).toBe('front');
    expect(sketchBasePlane(sketch([]))).toBeNull();   // a plane off the origin
    expect(sketchBasePlane({ ...newPlaneSketch('T', 'top'), face: { center: [0, 0, 0], normal: [0, 0, 1], area: 1 } })).toBeNull();
  });
});

describe('sketches on construction planes', () => {
  const lid = { origin: [0, 0, 15] as [number, number, number], normal: [0, 0, 1] as [number, number, number],
                xAxis: [1, 0, 0] as [number, number, number] };

  it('keep the plane’s name, and are neither face nor base plane sketches', () => {
    const sk = newConstructionSketch('Sketch on Lid', 'Lid', lid);
    expect(sk.planeRef).toBe('Lid');
    expect(sk.face).toBeUndefined();
    expect(sk.plane).toEqual(lid);
    expect(sketchBasePlane(sk)).toBeNull();
    expect(sketchProfile(sk)?.planeRef).toBe('Lid');
    expect(sketchProfile(newPlaneSketch('T', 'top'))).not.toHaveProperty('planeRef');
    expect(sk.entities).toMatchObject([{ type: 'point', position: { x: 0, y: 0 }, construction: true }]);
  });

  it('follow the plane where the build put it', () => {
    const sk = newConstructionSketch('Sketch on Lid', 'Lid', lid);
    const moved = { origin: [0, 0, 25] as [number, number, number], normal: [0, 0, 1] as [number, number, number],
                    xAxis: [1, 0, 0] as [number, number, number] };
    expect(boundPlane(sk, null, { Lid: moved })).toEqual(moved);
    expect(boundPlane(sk, null, {})).toEqual(lid);   // not built yet: as drawn
  });

  it('are found and renamed with their plane', () => {
    const a = newConstructionSketch('A', 'Lid', lid), b = newConstructionSketch('B', 'Mid', lid);
    const c = newPlaneSketch('C', 'top');
    expect(planeSketches([a, b, c], 'Lid').map((s) => s.name)).toEqual(['A']);
    const r = renamePlaneRefs([a, b, c], 'Lid', 'Cover');
    expect(r.map((s) => s.planeRef)).toEqual(['Cover', 'Mid', undefined]);
    expect(r[1]).toBe(b);   // untouched sketches stay as they were
  });

  it('extrude like base plane sketches: along the normal, either way, or both', () => {
    const datum: ExtrudeShape = { op: 'cut', depth: 5, through: false, flip: false, both: false, datum: true };
    expect(extrudeSign(datum)).toBe(1);
    expect(extrudeSpan({ ...datum, both: true }, null)).toEqual([-5, 5]);
  });

  it('on a tangent plane extrude like face sketches: a cut goes into the material', () => {
    const sk = newConstructionSketch('Screw', 'Set screw', lid);
    expect(onTangentPlane(sk, { 'Set screw': { kind: 'tangent' } })).toBe(true);
    expect(onTangentPlane(sk, { 'Set screw': { kind: 'offset' } })).toBe(false);
    expect(onTangentPlane(sk, undefined)).toBe(false);
    expect(onTangentPlane(newPlaneSketch('T', 'top'), { 'Set screw': { kind: 'tangent' } })).toBe(false);
    expect(extrudeSign({ op: 'cut', depth: 5, through: false, flip: false, both: false, datum: false })).toBe(-1);
  });
});

describe('extrude preview', () => {
  const ex = (o: Partial<ExtrudeShape>): ExtrudeShape => ({ op: 'cut', depth: 5, through: false, flip: false, ...o });

  it('goes the way the script line will: face cuts in, joins out, base planes along the normal', () => {
    expect(extrudeSign(ex({}))).toBe(-1);
    expect(extrudeSign(ex({ flip: true }))).toBe(1);
    expect(extrudeSign(ex({ op: 'join' }))).toBe(1);
    expect(extrudeSign(ex({ op: 'join', flip: true }))).toBe(-1);
    expect(extrudeSign(ex({ datum: true }))).toBe(1);
    expect(extrudeSign(ex({ op: 'new', datum: true, flip: true }))).toBe(-1);
  });

  it('spans the depth, both ways, or across the part', () => {
    expect(extrudeSpan(ex({}), null)).toEqual([-5, 0]);
    expect(extrudeSpan(ex({ op: 'join', both: true, datum: true }), null)).toEqual([-5, 5]);
    // a face cut through the part reaches its far side; flipped there's nothing, so a token length
    expect(extrudeSpan(ex({ through: true }), [-12, 0])).toEqual([-12, 0]);
    expect(extrudeSpan(ex({ through: true, flip: true }), [-12, 0])).toEqual([0, 12]);
    expect(extrudeSpan(ex({ through: true, datum: true }), [-3, 20])).toEqual([-3, 20]);
  });

  it('turns a depth below zero into Flip, keeping it positive', () => {
    expect(typedDepth(-3, false)).toEqual({ depth: 3, flip: true });
    expect(typedDepth(-3, true)).toEqual({ depth: 3, flip: false });
    expect(typedDepth(4, true)).toEqual({ depth: 4, flip: true });
    expect(typedDepth(-2, false, true)).toEqual({ depth: 2, flip: false });   // both ways: no other way
    // a lone "-" or an empty field is still being typed: the depth is left alone
    expect(depthEdit('-', false)).toEqual({ draft: '-' });
    expect(depthEdit('', true)).toEqual({ draft: '' });
    expect(depthEdit('-2', false)).toEqual({ depth: 2, flip: true });
    expect(depthEdit("0.5", true)).toEqual({ depth: 0.5, flip: true });
  });

  it('says what it does and where it goes in plain words', () => {
    // the arch on a left face: a join grows out to the left; flipped it crosses the part
    const left: [number, number, number] = [-1, 0, 0];
    expect(extrudeDirectionText(ex({ op: 'join' }), left)).toBe('Add 5 mm out of the face, to the left (−X)');
    expect(extrudeDirectionText(ex({ op: 'join', flip: true }), left)).toBe('Add 5 mm into the part, to the right (+X)');
    // a cut on a top face goes down into the part; flipped it reaches nothing
    expect(extrudeDirectionText(ex({}), [0, 0, 1])).toBe('Cut 5 mm into the part, down (−Z)');
    expect(extrudeDirectionText(ex({ through: true }), [0, 0, 1])).toBe('Cut through the part, down (−Z)');
    expect(extrudeDirectionText(ex({ flip: true }), [0, 0, 1])).toBe('Cut 5 mm out of the face, up (+Z) — cuts nothing there');
    // a base plane has no inside: the direction is the axis
    expect(extrudeDirectionText(ex({ op: 'new', datum: true, depth: 2.5 }), [0, 0, 1])).toBe('2.5 mm up (+Z)');
    expect(extrudeDirectionText(ex({ op: 'join', datum: true }), [0, -1, 0])).toBe('Add 5 mm toward the front (−Y)');
    expect(extrudeDirectionText(ex({ op: 'join', datum: true, both: true, depth: 4 }), [0, -1, 0])).toBe('Add 4 mm each way (±Y)');
    expect(extrudeDirectionText(ex({ through: true, datum: true }), [0, 0, 1])).toBe('Cut through the part, both ways from the plane');
    // a tilted plane has no axis to name: toward or away from the part instead
    const tilt: [number, number, number] = [0, -0.5, Math.sqrt(3) / 2];
    expect(extrudeDirectionText(ex({ datum: true, depth: 20 }), tilt, -12)).toBe('Cut 20 mm away from the part');
    expect(extrudeDirectionText(ex({ datum: true, depth: 20, flip: true }), tilt, -12)).toBe('Cut 20 mm toward the part');
    expect(extrudeDirectionText(ex({ datum: true }), tilt)).toBe('Cut 5 mm from the plane');
    expect(extrudeDirectionText(ex({ op: 'join', datum: true, both: true }), tilt)).toBe('Add 5 mm each way from the plane');
    expect(partSide([0, 0, 15], [0, 0, 1], [-30, -30, -15], [30, 30, 15])).toBeCloseTo(-15, 9);
  });

  it('draws the shape at both ends with side edges, and an arrow the way it goes', () => {
    const s = sketch([{ id: 'r', type: 'rectangle', center: { x: 0, y: 0 }, width: 20, height: 10 }]);
    const { edges, arrows } = extrudeGhost(s, [-4, 0]);
    const zs = new Set<number>();
    for (let i = 2; i < edges.length; i += 3) zs.add(Math.round(edges[i]! * 1e6) / 1e6);
    expect([...zs].sort((a, b) => a - b)).toEqual([2, 6]);    // plane at z=6, 4 mm down
    expect(edges.length / 6).toBe(4 + 4 + 4);                 // two outlines + four side edges
    expect(arrows.slice(0, 6)).toEqual([0, 0, 6, 0, 0, 2]);   // shaft: middle of the shape, downward
  });
});
