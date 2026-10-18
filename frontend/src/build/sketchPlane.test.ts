import { describe, it, expect } from 'vitest';
import { cross, dot, type Vec3 } from './dragHandle';
import { quatToRows } from './viewOrient';
import {
  planeBasis, planeForFace, sketchToWorld, worldToSketch, planeDistance, planeQuat,
  sketchCamera, fitViewport,
} from './sketchPlane';

const close = (a: number[], b: number[], digits = 6) =>
  a.forEach((v, i) => expect(v).toBeCloseTo(b[i]!, digits));

const C30 = Math.cos(Math.PI / 6), S30 = Math.sin(Math.PI / 6);
const FACES: [string, Vec3, Vec3][] = [
  ['+X', [10, 3, 4], [1, 0, 0]],
  ['-X', [-10, 3, 4], [-1, 0, 0]],
  ['+Y', [2, 8, 4], [0, 1, 0]],
  ['-Y', [2, -8, 4], [0, -1, 0]],
  ['+Z', [5, -2, 6], [0, 0, 1]],
  ['-Z', [5, -2, 0], [0, 0, -1]],
  ['30° from +Z toward -Y', [0, -4, 7], [0, -S30, C30]],
];

describe.each(FACES)('face with normal %s', (_, center, normal) => {
  const b = planeBasis(planeForFace(center, normal));

  it('has an orthonormal right-handed basis: x × y = normal', () => {
    close([dot(b.xDir, b.xDir), dot(b.yDir, b.yDir), dot(b.xDir, b.yDir)], [1, 1, 0]);
    close(cross(b.xDir, b.yDir), normal);
    close(b.normal, normal);
  });

  it('puts the face centre on the plane', () => {
    expect(planeDistance(b, center)).toBeCloseTo(0, 9);
  });

  it('round-trips sketch ↔ world', () => {
    for (const p of [{ x: 0, y: 0 }, { x: 12.5, y: -3 }, { x: -7, y: 40 }]) {
      const w = sketchToWorld(b, p);
      expect(planeDistance(b, w)).toBeCloseTo(0, 9);
      close(Object.values(worldToSketch(b, w)), [p.x, p.y]);
    }
    const s = worldToSketch(b, center);
    close(sketchToWorld(b, s), center);
  });

  it('flips Y: sketch +X is screen-right, sketch +Y is screen-down', () => {
    // in the camera looking at the plane, view x = right, view y = up
    const [right, up, out] = quatToRows(planeQuat(b));
    close(out, normal);
    const o = sketchToWorld(b, { x: 0, y: 0 });
    const ex = sketchToWorld(b, { x: 1, y: 0 });
    const ey = sketchToWorld(b, { x: 0, y: 1 });
    const d = (p: Vec3) => [dot([p[0] - o[0], p[1] - o[1], p[2] - o[2]], right),
                            dot([p[0] - o[0], p[1] - o[1], p[2] - o[2]], up)];
    close(d(ex), [1, 0]);    // +x → right
    close(d(ey), [0, -1]);   // +y → down, as on the sketch canvas
  });

  it('keeps the drawing\'s handedness (a CCW-on-screen triangle stays CCW seen from outside)', () => {
    // screen y down: (0,0) → (1,0) → (0,−1) runs counter-clockwise on screen
    const pts = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: -1 }].map((p) => sketchToWorld(b, p));
    const [a, c, e] = pts as [Vec3, Vec3, Vec3];
    const n = cross([c[0] - a[0], c[1] - a[1], c[2] - a[2]], [e[0] - a[0], e[1] - a[1], e[2] - a[2]]);
    expect(dot(n, normal)).toBeGreaterThan(0);
  });
});

describe('planeForFace orientation', () => {
  it('top face: sketch X = world X, screen-up = world Y (the top view)', () => {
    const b = planeBasis(planeForFace([0, 0, 6], [0, 0, 1]));
    close(b.xDir, [1, 0, 0]); close(b.yDir, [0, 1, 0]);
    close(b.origin, [0, 0, 6]);
  });
  it('front wall: sketch X = world X, screen-up = world Z', () => {
    const b = planeBasis(planeForFace([0, -8, 4], [0, -1, 0]));
    close(b.xDir, [1, 0, 0]); close(b.yDir, [0, 0, 1]);
  });
  it('right wall: sketch X = world Y, screen-up = world Z', () => {
    const b = planeBasis(planeForFace([10, 0, 4], [1, 0, 0]));
    close(b.xDir, [0, 1, 0]); close(b.yDir, [0, 0, 1]);
  });
  it('top face: a sketch point maps to world (x, −y) on the face', () => {
    const b = planeBasis(planeForFace([0, 0, 6], [0, 0, 1]));
    close(sketchToWorld(b, { x: 3, y: 4 }), [3, -4, 6]);
  });
});

describe('sketchCamera', () => {
  const b = planeBasis(planeForFace([0, 0, 6], [0, 0, 1]));

  it('GL canvas under the sketch canvas: centre = the sketch point at the canvas centre', () => {
    const r = { left: 200, top: 80, width: 1000, height: 600 };
    const vp = { offset: { x: 500, y: 300 }, scale: 4 };   // origin at the canvas centre
    const cam = sketchCamera(b, vp, r, r);
    close(cam.center, [0, 0, 6]);
    expect(cam.halfH).toBeCloseTo(600 / (2 * 4));          // 75 mm half-height at 4 px/mm
  });

  it('follows a pan: content moves right → camera centre moves left in sketch X', () => {
    const r = { left: 0, top: 0, width: 800, height: 600 };
    const cam = sketchCamera(b, { offset: { x: 400 + 40, y: 300 - 20 }, scale: 2 }, r, r);
    // centre px (400,300) → sketch ((400−440)/2, (300−280)/2) = (−20, 10) → world (−20, −10)
    close(cam.center, [-20, -10, 6]);
  });

  it('handles a GL canvas offset from the sketch canvas', () => {
    const sk = { left: 100, top: 50, width: 800, height: 600 };
    const gl = { left: 0, top: 0, width: 1000, height: 700 };
    const vp = { offset: { x: 400, y: 300 }, scale: 5 };
    const cam = sketchCamera(b, vp, sk, gl);
    // GL centre (500,350) page → sketch canvas (400,300) → sketch (0,0)
    close(cam.center, [0, 0, 6]);
    expect(cam.halfH).toBeCloseTo(70);
  });
});

describe('fitViewport', () => {
  it('centres the bounds with a margin', () => {
    const vp = fitViewport({ x: -10, y: -5 }, { x: 10, y: 5 }, 800, 600, 0.1);
    expect(vp.scale).toBeCloseTo(32);   // min(800/20, 600/10) · 0.8
    close([vp.offset.x, vp.offset.y], [400, 300]);
  });
});
