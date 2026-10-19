import { describe, it, expect } from 'vitest';
import type { DimInfo } from '@/api/client';
import {
  dragShift,
  handleOptions, dragAmount, snapToStep, snapToPlane, faceMotion, len, sub,
  type HandleFace, type Vec3,
} from './dragHandle';

const dim = (d: Partial<DimInfo>): DimInfo =>
  ({ faces: [], value: 0, shifts: {}, radial: {}, anchor: null, dir: null, kind: 'length', ...d });

const plane = (index: number, center: Vec3, normal: Vec3): HandleFace =>
  ({ index, start: 0, count: 0, kind: 'plane', center, normal });

/** Triangle soup for a cylinder wall about a Z axis through (ax, ay). */
function cylinderMesh(ax: number, ay: number, r: number, z0: number, z1: number, segs = 24): number[] {
  const p: number[] = [];
  for (let i = 0; i < segs; i++) {
    const a0 = (i / segs) * 2 * Math.PI, a1 = ((i + 1) / segs) * 2 * Math.PI;
    const v = (a: number, z: number) => [ax + r * Math.cos(a), ay + r * Math.sin(a), z];
    p.push(...v(a0, z0), ...v(a1, z0), ...v(a1, z1));
    p.push(...v(a0, z0), ...v(a1, z1), ...v(a0, z1));
  }
  return p;
}

describe('handleOptions', () => {
  it('ranks the param moving the face along its normal first', () => {
    const top = plane(2, [0, 0, 6], [0, 0, 1]);
    const opts = handleOptions(top, {
      slide: dim({ value: 3, faces: [2], shifts: { 2: [1, 0, 0] } }),        // slides it in-plane
      thick: dim({ value: 6, faces: [2, 5], shifts: { 2: [0, 0, 1] } }),     // pushes it out
      other: dim({ value: 1, faces: [7], shifts: { 7: [0, 0, 1] } }),        // doesn't move it
    });
    expect(opts.map((o) => o.name)).toEqual(['thick', 'slide']);
    expect(opts[0]).toMatchObject({ value: 6, shift: [0, 0, 1], dr: 0, moves: [2, 5] });
  });

  it('tolerates a sensitivity map without shifts', () => {
    const legacy = { w: { faces: [1], value: 2, anchor: null, dir: null, kind: 'callout' } as unknown as DimInfo };
    expect(handleOptions(plane(1, [0, 0, 0], [1, 0, 0]), legacy)).toEqual([]);
  });
});

describe('dragAmount', () => {
  it('projects the mouse onto the shift and divides by its screen length', () => {
    // 1 unit of the param = 20 px to the right; drag 50 px right, 30 px down
    expect(dragAmount([50, 30], [20, 0])).toBeCloseTo(2.5);
    // dragging against the arrow shrinks the param
    expect(dragAmount([-10, 0], [20, 0])).toBeCloseTo(-0.5);
  });

  it('refuses a shift that points at the camera', () => {
    expect(dragAmount([50, 0], [0, 0])).toBeNull();
  });
});

describe('dragShift', () => {
  it("drags a fillet's face at the radius's rate, not its own small shift", () => {
    // a 45° fillet's face moves ~0.41 per mm of radius, along -n
    const s = dragShift([0.29, 0, -0.29], 1);
    expect(Math.hypot(...s)).toBeCloseTo(1, 6);
    expect(s[0] / s[2]).toBeCloseTo(-1, 6);     // same direction
  });
  it('leaves faces that move at least as much as they grow, and plain faces, alone', () => {
    expect(dragShift([0, 0, 0.5], 0.5)).toEqual([0, 0, 0.5]);   // a hole wall per mm of diameter
    expect(dragShift([0, 0, 1], 0)).toEqual([0, 0, 1]);
  });
});

describe('snapToStep', () => {
  it('rounds to the grid without float noise', () => {
    expect(snapToStep(7.26, 0.5)).toBe(7.5);
    expect(snapToStep(7.24, 0.5)).toBe(7);
    expect(snapToStep(0.1 * 3, 0.1)).toBe(0.3);
    expect(snapToStep(-1.26, 0.5)).toBe(-1.5);
  });
});

describe('snapToPlane', () => {
  const top = plane(0, [0, 0, 6], [0, 0, 1]);
  const ledge = plane(1, [30, 0, 10], [0, 0, 1]);     // parallel, 4 units up
  const under = plane(2, [30, 0, 2], [0, 0, -1]);     // opposed, 4 units down
  const wall = plane(3, [20, 0, 3], [1, 0, 0]);       // perpendicular
  const faces = [top, ledge, under, wall];

  it('lands the face on a parallel plane within the pixel tolerance', () => {
    // 10 px per unit: t = 3.7 is 3 px from the ledge's t = 4
    expect(snapToPlane(top, [0, 0, 1], 3.7, 10, faces, [])).toEqual({ t: 4, face: 1 });
    // opposed normals count as parallel
    expect(snapToPlane(top, [0, 0, 1], -3.8, 10, faces, [])).toEqual({ t: -4, face: 2 });
  });

  it('does nothing outside the tolerance', () => {
    expect(snapToPlane(top, [0, 0, 1], 3, 10, faces, [])).toBeNull();
  });

  it('skips faces the param moves too, and non-planar drags', () => {
    expect(snapToPlane(top, [0, 0, 1], 3.9, 10, faces, [1])).toBeNull();
    expect(snapToPlane({ ...top, kind: 'cylinder' }, [0, 0, 1], 3.9, 10, faces, [])).toBeNull();
  });

  it('accounts for a shift that is not one-to-one', () => {
    // the face moves half a unit per unit of the param: the ledge is at t = 8
    expect(snapToPlane(top, [0, 0, 0.5], 7.6, 10, faces, [])).toEqual({ t: 8, face: 1 });
  });
});

describe('faceMotion', () => {
  it('translates a plane by the shift', () => {
    const pos = [0, 0, 6, 1, 0, 6, 0, 1, 6];
    const m = faceMotion({ ...plane(0, [0.3, 0.3, 6], [0, 0, 1]), count: 3 }, pos, [0, 0, 1]);
    expect(Array.from(m)).toEqual([0, 0, 1, 0, 0, 1, 0, 0, 1]);
  });

  // a hole of r=4 about x=-20: its wall's anchor is (-24, 0, 3), normal +x
  // (into the hole); growing the diameter moves the anchor -x by dr
  const hole = cylinderMesh(-20, 0, 4, 0, 6);
  const holeFace: HandleFace = { index: 6, start: 0, count: hole.length / 3, kind: 'cylinder',
                                 center: [-24, 0, 3], normal: [1, 0, 0], radius: 4 };

  it('dilates a hole wall about its axis', () => {
    const m = faceMotion(holeFace, hole, [-0.5, 0, 0], 0.5);
    for (let i = 0; i < holeFace.count; i++) {
      const v: Vec3 = [hole[i * 3]!, hole[i * 3 + 1]!, hole[i * 3 + 2]!];
      const out = sub(v, [-20, 0, v[2]]);                  // away from the axis
      const mv: Vec3 = [m[i * 3]!, m[i * 3 + 1]!, m[i * 3 + 2]!];
      expect(len(mv)).toBeCloseTo(0.5, 5);
      expect(mv[0] * out[0] + mv[1] * out[1]).toBeCloseTo(0.5 * len(out), 5);
      expect(mv[2]).toBeCloseTo(0, 6);
    }
  });

  it('translates a sliding hole instead of dilating it', () => {
    // same anchor shift along the normal, but no radius change: it slides
    const m = faceMotion(holeFace, hole, [1, 0, 0], 0);
    for (let i = 0; i < holeFace.count; i++) expect([m[i * 3], m[i * 3 + 1], m[i * 3 + 2]]).toEqual([1, 0, 0]);
  });

  it('dilates a boss outward (normal pointing away from its axis)', () => {
    const boss = cylinderMesh(20, 0, 4, 0, 6);
    const face: HandleFace = { index: 1, start: 0, count: boss.length / 3, kind: 'cylinder',
                               center: [24, 0, 3], normal: [1, 0, 0], radius: 4 };
    const m = faceMotion(face, boss, [0.5, 0, 0], 0.5);
    for (let i = 0; i < face.count; i++) {
      const out = sub([boss[i * 3]!, boss[i * 3 + 1]!, 0], [20, 0, 0]);
      expect(m[i * 3]! * out[0] + m[i * 3 + 1]! * out[1]).toBeCloseTo(0.5 * len(out), 5);
    }
  });
});
