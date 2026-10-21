import { beforeEach, describe, expect, it } from 'vitest';
import type { PlaneReport } from '@/api/client';
import {
  amountOut, amountText, amountValue, edgePayload, edgePlaneShape, edgeSummary, faceBesideEdge, labelCorner, loadHiddenPlanes,
  newPlaneName, offsetBasePoint, offsetPayload, offsetPlaneShape, offsetSummary, outlineSegments, planeAxes,
  planeCorners, planeNameProblem, renameHidden, reopenedFromFace, saveHiddenPlanes, shownPlanes, type EdgePlaneValues,
  type OffsetPlaneValues, clickAngle, cylinderOfFace, insideCylinder, tangentPayload, tangentPlaneShape, tangentRefLabel, tangentSummary,
  tangentZero, type Cylinder, type TangentPlaneValues,
} from './constructionPlanes';
import { dot, type Vec3 } from './dragHandle';
import { planeForFace } from './sketchPlane';

const close = (a: readonly number[], b: readonly number[]) => a.forEach((x, i) => expect(x).toBeCloseTo(b[i]!, 6));
const TOP = { center: [0, 0, 10] as Vec3, normal: [0, 0, 1] as Vec3 };
const RIGHT = { center: [30, 0, 5] as Vec3, normal: [1, 0, 0] as Vec3 };

describe('offset planes', () => {
  it('sit along the face’s outward normal: positive out, negative into the part', () => {
    close(offsetPlaneShape(TOP, 5).origin, [0, 0, 15]);
    close(offsetPlaneShape(TOP, -4).origin, [0, 0, 6]);
    close(offsetPlaneShape(RIGHT, -30).origin, [0, 0, 0]);   // a midplane of a 60 wide box
    close(offsetPlaneShape(TOP, 5).normal, [0, 0, 1]);
  });

  it('take a face sketch’s x axis on that face, so sketches on both line up', () => {
    for (const f of [TOP, RIGHT, { center: [0, -20, 5] as Vec3, normal: [0, -1, 0] as Vec3 }]) {
      close(offsetPlaneShape(f, 7).xAxis, planeForFace(f.center, f.normal).xAxis);
    }
  });

  it('go from the base planes through the origin', () => {
    close(offsetPlaneShape('XY', 30).origin, [0, 0, 30]);
    close(offsetPlaneShape('YZ', -2).origin, [-2, 0, 0]);
    close(offsetPlaneShape('XZ', 3).normal, [0, -1, 0]);
    close(offsetPlaneShape('XZ', 3).origin, [0, -3, 0]);
  });

  it('measure the distance handle from the face, under the part’s middle', () => {
    close(offsetBasePoint(TOP, [5, 6, 2]), [5, 6, 10]);
    close(offsetBasePoint('XY', [5, 6, 2]), [5, 6, 0]);
  });
});

describe('planes on an edge', () => {
  // the top face's right edge of a box 60 × 40 × 10 (top at z = 10)
  const a: Vec3 = [-30, 20, 10], b: Vec3 = [30, 20, 10];

  it('lie in the from-face at 0°, with the x axis along the edge', () => {
    const s = edgePlaneShape(a, b, TOP, 0);
    close(s.normal, [0, 0, 1]);
    expect(Math.abs(dot(s.xAxis, [1, 0, 0]))).toBeCloseTo(1, 6);
    expect(dot(s.origin, s.normal)).toBeCloseTo(10, 6);
    close(s.w, [0, -1, 0]);   // across the face, from the edge
  });

  it('turn away from the material for a positive angle', () => {
    const s = edgePlaneShape(a, b, TOP, 30);
    const r = Math.PI / 6;
    close(s.normal, [0, Math.sin(r), Math.cos(r)]);
    // the half over the face rises above the top: out of the part
    const over: Vec3 = [s.mid[0] + 10 * (s.w[0] * Math.cos(r) + s.n[0] * Math.sin(r)),
                        s.mid[1] + 10 * (s.w[1] * Math.cos(r) + s.n[1] * Math.sin(r)),
                        s.mid[2] + 10 * (s.w[2] * Math.cos(r) + s.n[2] * Math.sin(r))];
    expect(over[2]).toBeGreaterThan(10);
    expect(Math.abs(dot([over[0] - a[0], over[1] - a[1], over[2] - a[2]], s.normal))).toBeLessThan(1e-9);
    // negative goes into it
    expect(edgePlaneShape(a, b, TOP, -30).normal[1]).toBeLessThan(0);
  });

  it('reopen on the from-face even after a later cut moved its centre', () => {
    const top = { center: [0, 0, 10] as Vec3, normal: [0, 0, 1] as Vec3, area: 2400 };
    const front = { center: [0, -20, 5] as Vec3, normal: [0, -1, 0] as Vec3, area: 600 };
    // as the part is now: the top was cut, so its centre and area differ from the line's
    const faces = [{ ref: front, center: front.center, normal: front.normal, hint: 'front face', index: 1 },
                   { ref: { ...top, center: [4, 3, 10] as Vec3, area: 1900 }, center: [4, 3, 10] as Vec3,
                     normal: top.normal, hint: 'top face', index: 2 }];
    const r = reopenedFromFace(faces, top);
    expect(r.from).toBe(1);
    expect(r.faces[1]!.ref).toBe(top);          // the line's own reference is kept
    expect(r.faces[0]!.ref).toBe(front);
    expect(reopenedFromFace(faces, null).from).toBe(0);
  });

  it('find the face’s side from its triangles at the edge, not its centre (round a pocket)', () => {
    // the top face (z = 10) of a box with a pocket 20 × 40 in its middle: the
    // pocket's back edge y = 20 has the face beyond it (y > 20), while the
    // face's centre is in the middle of the pocket, on the other side
    const tris = [[-10, 20, 10], [10, 20, 10], [10, 30, 10],  [-10, 20, 10], [10, 30, 10], [-10, 30, 10],
                  [-30, -30, 10], [30, -30, 10], [30, -20, 10]].flat();   // elsewhere on the face
    const pa: Vec3 = [-10, 20, 10], pb: Vec3 = [10, 20, 10];
    const face = { start: 0, count: 9, normal: [0, 0, 1] as Vec3 };
    const at = faceBesideEdge(tris, face, pa, pb)!;
    close(at.w, [0, 1, 0]);
    close(at.n, [0, 0, 1]);
    // the normals per vertex orient a triangle wound the other way
    const flipped = [[10, 20, 10], [-10, 20, 10], [10, 30, 10]].flat();
    close(faceBesideEdge(flipped, { ...face, count: 3 }, pa, pb, Array(9).fill(0).map((_, i) => (i % 3 === 2 ? 1 : 0)))!.n, [0, 0, 1]);
    // +30°: the half over the face (y > 20) lifts out of it, as the backend's edge_plane
    const r = Math.PI / 6;
    const s = edgePlaneShape(pa, pb, { center: [0, 0, 10], normal: [0, 0, 1], at }, 30);
    close(s.normal, [0, -Math.sin(r), Math.cos(r)]);
    // the centre alone gets it backwards here
    expect(edgePlaneShape(pa, pb, { center: [0, 0, 10], normal: [0, 0, 1] }, 30).normal[1]).toBeGreaterThan(0);
    expect(faceBesideEdge(tris, face, [50, 50, 0], [60, 50, 0])).toBeNull();
  });

  it('give the same plane whichever way the edge runs', () => {
    close(edgePlaneShape(b, a, TOP, 30).normal, edgePlaneShape(a, b, TOP, 30).normal);
  });
});

describe('tangent planes', () => {
  // a Z-axis boss, radius 10, from z=0 to z=20
  const BOSS: Cylinder = { start: [0, 0, 0], axis: [0, 0, 1], radius: 10, length: 20, inward: false };

  it('measure 0° from X by default on a Z-axis boss, right-handed about the axis', () => {
    const zero = tangentZero(BOSS, 'auto')!;
    close(zero, [1, 0, 0]);
    const p0 = tangentPlaneShape(BOSS, zero, 0);
    close(p0.origin, [10, 0, 0]); close(p0.normal, [1, 0, 0]); close(p0.xAxis, [0, 0, 1]);
    const p90 = tangentPlaneShape(BOSS, zero, 90);
    close(p90.origin, [0, 10, 0]); close(p90.normal, [0, 1, 0]);
    close(p90.mid, [0, 0, 10]);
    // the axis the other way round turns the other way
    const down = { ...BOSS, start: [0, 0, 20] as Vec3, axis: [0, 0, -1] as Vec3 };
    close(tangentPlaneShape(down, tangentZero(down, 'X')!, 90).normal, [0, -1, 0]);
  });

  it('face the axis on a bore', () => {
    const bore = { ...BOSS, inward: true };
    close(tangentPlaneShape(bore, [1, 0, 0], 0).normal, [-1, 0, 0]);
  });

  it('take the reference from X / Y / Z or a flat face, never one along the axis', () => {
    const xAxisCyl = { start: [0, 0, 0] as Vec3, axis: [1, 0, 0] as Vec3 };
    close(tangentZero(xAxisCyl, 'auto')!, [0, 1, 0]);
    close(tangentZero(BOSS, 'Y')!, [0, 1, 0]);
    expect(tangentZero(BOSS, 'Z')).toBeNull();
    // a D-shaft flat at y=-2 whose normal faces the axis: 0° is still toward the flat
    close(tangentZero(BOSS, 'face', { center: [0, -2, 10], normal: [0, 1, 0] })!, [0, -1, 0]);
    expect(tangentZero(BOSS, 'face', { center: [0, 0, 20], normal: [0, 0, 1] })).toBeNull();
    expect(tangentZero(BOSS, 'face', null)).toBeNull();
  });

  it('take the angle from a click, to 0.5°, in (-180, 180]', () => {
    const zero: Vec3 = [1, 0, 0];
    expect(clickAngle([0, 10, 7], BOSS, zero)).toBe(90);
    expect(clickAngle([10, -0.01, 3], BOSS, zero)).toBe(0);
    expect(Object.is(clickAngle([10, -0.01, 3], BOSS, zero), -0)).toBe(false);
    expect(clickAngle([-10, -0.0001, 3], BOSS, zero)).toBe(180);
    const r = (d: number) => [10 * Math.cos((d * Math.PI) / 180), 10 * Math.sin((d * Math.PI) / 180), 5] as Vec3;
    expect(clickAngle(r(-44.8), BOSS, zero)).toBe(-45);
    expect(clickAngle(r(30.3), BOSS, zero)).toBe(30.5);
    expect(clickAngle(r(30), BOSS, [0, 1, 0])).toBe(-60);
  });

  it('tell a flat inside the cylinder (a shaft flat) from a face outside it', () => {
    expect(insideCylinder([2.5, 0, 30], BOSS)).toBe(true);
    expect(insideCylinder([0, -12, 5], BOSS)).toBe(false);
    expect(insideCylinder([10, 0, 5], BOSS)).toBe(false);
  });

  it('find the cylinder from its triangles', () => {
    // four points of a radius-10 boss (normals out), z 2..14, axis reported downward
    const pts = [[10, 0, 2], [0, 10, 2], [-10, 0, 14], [0, -10, 14]];
    const positions = pts.flat(), normals = pts.flatMap(([x, y]) => [x! / 10, y! / 10, 0]);
    const face = { start: 0, count: 4, axis: [0, 0, -1] as Vec3, axis_point: [0, 0, 8] as Vec3, radius: 10 };
    const c = cylinderOfFace(positions, normals, face, [0, 0, 1]);
    close(c.start, [0, 0, 2]); close(c.axis, [0, 0, 1]);
    expect(c.length).toBeCloseTo(12); expect(c.inward).toBe(false);
    const bore = cylinderOfFace(positions, normals.map((n) => -n), face);
    expect(bore.inward).toBe(true); close(bore.axis, [0, 0, -1]); close(bore.start, [0, 0, 14]);
  });

  it('write their payload and summary', () => {
    const v: TangentPlaneValues = { name: ' Set screw ', face: { kind: 'cylinder' } as never, cyl: BOSS,
                                    ref: 'auto', refFace: null, angle: 'screw_angle' };
    expect(tangentPayload(v)).toEqual({ op: 'tangent_plane', name: 'Set screw', face: v.face, angle: 'screw_angle', ref: null });
    expect((tangentPayload({ ...v, ref: 'Y', angle: 30 }) as { ref: unknown }).ref).toBe('Y');
    const flat = { ref: { kind: 'plane' } as never, center: [0, -2, 10] as Vec3, normal: [0, 1, 0] as Vec3, hint: 'flat face' };
    expect((tangentPayload({ ...v, ref: 'face', refFace: flat }) as { ref: unknown }).ref).toEqual({ face: flat.ref });
    expect(tangentRefLabel(v)).toBe('X (auto)');
    expect(tangentRefLabel({ ...v, ref: 'face', refFace: flat })).toBe('the flat face');
    expect(tangentSummary('hub', 'X', 30, false)).toBe('touching the hub 30° round from X, facing out (cuts go in toward the axis)');
  });
});

describe('drawing a plane', () => {
  it('covers the part’s box seen square-on, a margin larger', () => {
    const p = { name: 'Lid', ...offsetPlaneShape(TOP, 5) };
    const c = planeCorners(p, [-30, -20, 0], [30, 20, 10], 5);
    const { u, v } = planeAxes(p);
    const us = c.map((x) => dot(x, u)), vs = c.map((x) => dot(x, v));
    expect(Math.max(...us) - Math.min(...us)).toBeCloseTo(70, 6);
    expect(Math.max(...vs) - Math.min(...vs)).toBeCloseTo(50, 6);
    for (const x of c) expect(x[2]).toBeCloseTo(15, 6);
    expect(outlineSegments(c)).toHaveLength(24);
    expect(labelCorner(c)).toBe(c[3]);
  });
});

describe('names and amounts', () => {
  it('numbers new planes and checks names', () => {
    expect(newPlaneName([])).toBe('Plane 1');
    expect(newPlaneName(['Plane 1', 'Plane 2', 'Lid'])).toBe('Plane 3');
    expect(planeNameProblem('  ', [])).toMatch(/name/);
    expect(planeNameProblem('Lid', ['Lid'])).toMatch(/already/);
    expect(planeNameProblem('Lid', ['Lid'], 'Lid')).toBeNull();   // its own name, reopened
    expect(planeNameProblem('a"b', [])).toMatch(/quotes/);
  });

  it('takes a number or an expression of parameter names', () => {
    const P = { width: 60, gap: 2 };
    expect(amountValue(5, P)).toBe(5);
    expect(amountValue('-width / 2', P)).toBe(-30);
    expect(amountValue('gap + 1', P)).toBe(3);
    expect(amountValue('nope +', P)).toBeNull();
    expect(amountValue('', P)).toBeNull();
    expect(amountOut('12.5')).toBe(12.5);
    expect(amountOut(' -width / 2 ')).toBe('-width / 2');
    expect(amountText(0.30000000000000004)).toBe('0.3');
  });

  it('writes the payloads the backend takes', () => {
    const off: OffsetPlaneValues = { name: ' Mid ', base: 'face', distance: '-width / 2',
      face: { ref: { center: [30, 0, 5], normal: [1, 0, 0], area: 400 }, center: [30, 0, 5], normal: [1, 0, 0], hint: 'right face' } };
    expect(offsetPayload(off)).toEqual({ op: 'offset_plane', name: 'Mid', base: { face: off.face!.ref }, distance: '-width / 2' });
    expect(offsetPayload({ ...off, base: 'XZ', distance: 30 })).toMatchObject({ base: 'XZ', distance: 30 });
    const ref = { center: [0, 0, 10] as [number, number, number], normal: [0, 0, 1] as [number, number, number], area: 2400 };
    const edge: EdgePlaneValues = { name: 'Cam tilt', from: 1, angle: 30, a: [0, 0, 0], b: [1, 0, 0],
      edge: { faces: [], kind: 'line', midpoint: [0, 20, 10], length: 60 },
      faces: [{ ref: { ...ref, area: 1 }, center: [0, 0, 0], normal: [0, 1, 0], hint: 'back face', index: 1 },
              { ref, center: [0, 0, 10], normal: [0, 0, 1], hint: 'top face', index: 2 }] };
    expect(edgePayload(edge)).toEqual({ op: 'edge_plane', name: 'Cam tilt', edge: edge.edge, angle: 30, from_face: ref });
  });

  it('says where the plane is in words', () => {
    expect(offsetSummary('top face', 5)).toBe('5 mm out from the top face');
    expect(offsetSummary('right face', -30)).toBe('30 mm into the part from the right face');
    expect(offsetSummary('XY plane', 30)).toBe("30 mm along the XY plane's normal");
    expect(offsetSummary('top face', 0)).toBe('on the top face');
    expect(edgeSummary('top face', 30)).toBe('30° out of the part from the top face');
    expect(edgeSummary('top face', -15)).toBe('15° into the part from the top face');
    expect(edgeSummary('top face', 0)).toBe('in the top face');
  });
});

describe('showing and hiding planes', () => {
  const store = new Map<string, string>();
  beforeEach(() => {
    store.clear();
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v),
      removeItem: (k: string) => store.delete(k),
    };
  });

  it('keeps the hidden ones per part; a new plane is shown', () => {
    expect(loadHiddenPlanes('a')).toEqual([]);
    saveHiddenPlanes('a', ['Lid']);
    expect(loadHiddenPlanes('a')).toEqual(['Lid']);
    expect(loadHiddenPlanes('b')).toEqual([]);
    saveHiddenPlanes('a', []);
    expect(store.size).toBe(0);
    expect(renameHidden(['Lid', 'Mid'], 'Lid', 'Cover')).toEqual(['Cover', 'Mid']);
  });

  it('draws the built planes less the hidden, and a dialog’s preview in place of its own', () => {
    const rep = (z: number): PlaneReport => ({ kind: 'offset', status: 'same', origin: [0, 0, z], normal: [0, 0, 1], xAxis: [1, 0, 0] });
    const planes = { Lid: rep(15), Mid: rep(5), Top: rep(30) };
    expect(shownPlanes(planes, ['Mid']).map((p) => p.name)).toEqual(['Lid', 'Top']);
    const preview = { name: 'Lid', origin: [0, 0, 20] as Vec3, normal: [0, 0, 1] as Vec3, xAxis: [1, 0, 0] as Vec3 };
    const shown = shownPlanes(planes, [], preview);
    expect(shown.map((p) => [p.name, !!p.preview])).toEqual([['Mid', false], ['Top', false], ['Lid', true]]);
  });
});
