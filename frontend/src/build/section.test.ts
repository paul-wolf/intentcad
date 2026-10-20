import { describe, expect, it } from 'vitest';
import {
  atPosition, axisSection, buildOutline, cutDepth, cutNormal, cutSideText, faceBodies, flipSection, fromPlane, insideOutline,
  isCut, moveSection, nearestAxis, nearestSegment, sectionAxis, sectionForView, sectionOnFace, sectionSegments,
  sectionPosition, shaderPlane, signedVolume6, toPlane, vertexDots, wallThickness, type Section,
} from './section';
import type { Vec3 } from './dragHandle';

/** A box as a triangle soup with flat normals, counter-clockwise seen from
 *  outside (or, `inward`, from inside: a cavity's walls). */
function box(lo: Vec3, hi: Vec3, inward = false): { positions: number[]; normals: number[] } {
  const c = (i: number): Vec3 => [i & 1 ? hi[0] : lo[0], i & 2 ? hi[1] : lo[1], i & 4 ? hi[2] : lo[2]];
  // each face's corners, counter-clockwise from outside
  const quads = [[0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4], [2, 6, 7, 3], [0, 4, 6, 2], [1, 3, 7, 5]];
  const positions: number[] = [], normals: number[] = [];
  for (const q of quads) {
    for (const t of [[q[0], q[1], q[2]], [q[0], q[2], q[3]]]) {
      const [a, b, d] = (inward ? [t[0], t[2], t[1]] : t).map((i) => c(i!));
      const u: Vec3 = [b![0] - a![0], b![1] - a![1], b![2] - a![2]];
      const w: Vec3 = [d![0] - a![0], d![1] - a![1], d![2] - a![2]];
      const n: Vec3 = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
      const l = Math.hypot(...n);
      for (const p of [a!, b!, d!]) { positions.push(...p); normals.push(n[0] / l, n[1] / l, n[2] / l); }
    }
  }
  return { positions, normals };
}

const Z: Vec3 = [0, 0, 1];

describe('triangle–plane segments', () => {
  it('cuts a crossing triangle in one segment', () => {
    const pos = [0, 0, -1, 2, 0, 1, 0, 2, 1];
    const { pts, tri } = sectionSegments(pos, vertexDots(pos, Z), 0);
    expect(tri).toEqual([0]);
    expect(pts.map((x) => +x.toFixed(6))).toEqual([1, 0, 0, 0, 1, 0]);
  });

  it('gives nothing for a triangle off the plane, or lying in it', () => {
    const above = [0, 0, 1, 1, 0, 2, 0, 1, 3];
    const inPlane = [0, 0, 0, 1, 0, 0, 0, 1, 0];
    expect(sectionSegments(above, vertexDots(above, Z), 0).tri).toEqual([]);
    expect(sectionSegments(inPlane, vertexDots(inPlane, Z), 0).tri).toEqual([]);
  });

  it('a vertex on the plane: the segment runs from it; a corner touching gives nothing', () => {
    const through = [0, 0, 0, 2, 0, -1, 2, 0, 1];   // a on the plane, b below, c above
    const r = sectionSegments(through, vertexDots(through, Z), 0);
    expect(r.tri).toEqual([0]);
    expect(r.pts.map((x) => +x.toFixed(6))).toEqual([2, 0, 0, 0, 0, 0]);
    const touchBelow = [0, 0, 0, 1, 0, -1, 0, 1, -1];
    const touchAbove = [0, 0, 0, 1, 0, 1, 0, 1, 1];
    expect(sectionSegments(touchBelow, vertexDots(touchBelow, Z), 0).tri).toEqual([]);
    expect(sectionSegments(touchAbove, vertexDots(touchAbove, Z), 0).tri).toEqual([]);
  });

  it('an edge in the plane comes out once, from the triangle on the kept side', () => {
    const below = [0, 0, 0, 1, 0, 0, 0, 0, -1];
    const above = [0, 0, 0, 1, 0, 0, 0, 0, 1];
    const both = [...below, ...above];
    const r = sectionSegments(both, vertexDots(both, Z), 0);
    expect(r.tri).toEqual([0]);
    expect(r.pts.map((x) => +x.toFixed(6)).sort()).toEqual([0, 0, 0, 0, 0, 1].sort());
  });

  it('cuts a closed box in a closed loop at any height', () => {
    const b = box([0, 0, 0], [10, 6, 4]);
    const dots = vertexDots(b.positions, Z);
    for (const [z, around] of [[1.5, 32], [4, 32], [0, 0]]) {
      const r = sectionSegments(b.positions, dots, z!);
      // the four sides, two triangles each, both cut. At z=4 the top face is
      // in the plane: its edges come from the sides below it, which stay. At
      // z=0 the whole box is on the side that is cut away: no outline
      const len = r.pts.reduce((s, _, i) => (i % 6 ? s
        : s + Math.hypot(r.pts[i + 3]! - r.pts[i]!, r.pts[i + 4]! - r.pts[i + 1]!, r.pts[i + 5]! - r.pts[i + 2]!)), 0);
      expect(len).toBeCloseTo(around!, 6);
    }
  });
});

describe('the plane', () => {
  const s: Section = { dir: [0, 1, 0], offset: 30, flip: false };

  it('cuts away the side dir points to, or the other when flipped', () => {
    expect(isCut(s, [0, 31, 0])).toBe(true);
    expect(isCut(s, [0, 29, 0])).toBe(false);
    const f = flipSection(s);
    expect(isCut(f, [0, 31, 0])).toBe(false);
    expect(isCut(f, [0, 29, 0])).toBe(true);
    expect(cutNormal(f)).toEqual([-0, -1, -0]);
    expect(flipSection(f)).toEqual(s);
  });

  it('flip keeps the offset; the shader plane cuts the same side as isCut', () => {
    const f = flipSection(s);
    expect(f.offset).toBe(30);
    for (const t of [s, f]) {
      const [nx, ny, nz, w] = shaderPlane(t);
      for (const y of [25, 35]) {
        const p: Vec3 = [3, y, -2];
        expect(nx * p[0] + ny * p[1] + nz * p[2] > w).toBe(isCut(t, p));
      }
    }
    expect(cutDepth(f, [0, 25, 0])).toBe(5);
  });

  it('moves along dir whichever side is cut', () => {
    expect(moveSection(s, 2.5).offset).toBe(32.5);
    expect(moveSection(flipSection(s), -0.5)).toEqual({ dir: [0, 1, 0], offset: 29.5, flip: true });
  });

  it('starts just inside a selected face, cutting its side away', () => {
    const top = sectionOnFace({ center: [5, 5, 20], normal: [0, 0, 2] });
    expect(top).toEqual({ dir: [0, 0, 1], offset: 19.9, flip: false });
    expect(isCut(top, [5, 5, 20])).toBe(true);    // the face itself is cut away
    expect(isCut(top, [5, 5, 19.8])).toBe(false); // the material under it stays
    const side = sectionOnFace({ center: [0, 10, 5], normal: [-1, 0, 0] });
    expect(side.dir).toEqual([-1, 0, 0]);
    expect(side.offset).toBeCloseTo(-0.1, 9);      // x = 0.1, just inside
    expect(isCut(side, [-0.05, 10, 5])).toBe(true);
    expect(isCut(side, [0.2, 10, 5])).toBe(false);
  });

  it('with nothing selected: square to the axis nearest the view, the near side cut away', () => {
    const c: Vec3 = [10, 20, 5];
    expect(sectionForView([0.2, -0.9, 0.3], c)).toEqual({ dir: [0, 1, 0], offset: 20, flip: true });
    expect(sectionForView([0.1, 0.2, 0.95], c)).toEqual({ dir: [0, 0, 1], offset: 5, flip: false });
    expect(nearestAxis([-0.7, 0.5, 0.5])).toBe(0);
    const x = axisSection(0, c, [-1, 0, 0]);
    expect(isCut(x, [9, 0, 0])).toBe(true);        // the camera's side (−X) is cut away
    expect(sectionAxis(x)).toBe('X');
    expect(cutSideText(x)).toBe('the −X side');
    expect(cutSideText({ dir: [0, 0, 1], offset: 0, flip: false })).toBe('the +Z side');
    expect(sectionAxis({ dir: [0.6, 0.8, 0], offset: 0, flip: false })).toBe(null);
  });

  it('types and shows the position along the axis, whichever way the plane faces', () => {
    const side = sectionOnFace({ center: [0, 10, 5], normal: [-1, 0, 0] });   // x = 0.1
    expect(sectionPosition(side)).toBeCloseTo(0.1, 9);
    const moved = atPosition(side, 3);
    expect(isCut(moved, [2.9, 0, 0])).toBe(true);
    expect(isCut(moved, [3.1, 0, 0])).toBe(false);
    expect(sectionPosition(atPosition(s, 12.5))).toBe(12.5);
    const tilted: Section = { dir: [0.6, 0.8, 0], offset: 4, flip: true };
    expect(sectionPosition(tilted)).toBe(4);
    expect(atPosition(tilted, 7).offset).toBe(7);
  });
});

describe('wall thickness', () => {
  // a shelled box: 40 × 30 × 20 outside, 2 mm walls all round (the cavity
  // closed, so the solid is watertight)
  const outer = box([0, 0, 0], [40, 30, 20]);
  const inner = box([2, 2, 2], [38, 28, 18], true);
  const positions = [...outer.positions, ...inner.positions];
  const normals = [...outer.normals, ...inner.normals];
  const s: Section = { dir: Z, offset: 10, flip: false };
  const o = buildOutline(positions, normals, vertexDots(positions, Z), Z, 10);

  it('outlines the outer and the inner wall', () => {
    expect(o.count).toBe(16);
    // in the wall, not in the cavity or outside
    expect(insideOutline(o, toPlane(o, [1, 15, 10]))).toBe(true);
    expect(insideOutline(o, toPlane(o, [20, 15, 10]))).toBe(false);
    expect(insideOutline(o, toPlane(o, [-1, 15, 10]))).toBe(false);
  });

  it('is 2.00 across each wall, from either face', () => {
    for (const p of [[0, 15, 10], [40, 10, 10], [20, 0, 10], [12, 30, 10], [2, 15, 10], [25, 28, 10]] as Vec3[]) {
      const q = toPlane(o, p);
      const near = nearestSegment(o, q, 0.01)!;
      expect(near).not.toBeNull();
      const w = wallThickness(o, near.seg, near.p)!;
      expect(w.mm.toFixed(2)).toBe('2.00');
      // the far side is in the plane, on the other face of the wall
      const far = fromPlane(o, s, w.to);
      expect(far[2]).toBeCloseTo(10, 6);
    }
  });

  it('near a corner it measures across the wall it is on', () => {
    const near = nearestSegment(o, toPlane(o, [0, 2.5, 10]), 0.01)!;
    expect(wallThickness(o, near.seg, near.p)!.mm).toBeCloseTo(2, 6);
  });

  it('finds the separate bodies and their winding', () => {
    // two boxes: faces 0–5 and 6–11, joined only within each
    const edges = [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [6, 7], [7, 8], [8, 9], [9, 10], [10, 11]]
      .map((faceIndices) => ({ faceIndices }));
    expect([...faceBodies(12, edges)]).toEqual([0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1]);
    expect(signedVolume6(outer.positions, 0, 36)).toBeCloseTo(6 * 40 * 30 * 20, 3);
    expect(signedVolume6(inner.positions, 0, 36)).toBeCloseTo(-6 * 36 * 26 * 16, 3);
  });
});
