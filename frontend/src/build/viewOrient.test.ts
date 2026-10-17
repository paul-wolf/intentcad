import { describe, it, expect } from 'vitest';
import type { Vec3 } from './dragHandle';
import {
  lookFrom, quatToRows, quatFromRows, quatFromAxisAngle, quatMul, slerp, orbit, axisView,
  viewOut, quatToMat4, VIEW_DIRS, VIEW_KEYS, type Quat,
} from './viewOrient';

const close = (a: number[], b: number[], eps = 1e-6) =>
  a.forEach((v, i) => expect(v).toBeCloseTo(b[i]!, -Math.log10(eps)));

/** Where world vector v lands in view space (x right, y up, z toward viewer). */
const toView = (q: Quat, v: Vec3): Vec3 => {
  const r = quatToRows(q);
  return r.map((row) => row[0] * v[0] + row[1] * v[1] + row[2] * v[2]) as Vec3;
};

describe('lookFrom / standard views', () => {
  it('front: X right, Z up, -Y toward the viewer', () => {
    const q = lookFrom(VIEW_DIRS.front);
    close(toView(q, [1, 0, 0]), [1, 0, 0]);
    close(toView(q, [0, 0, 1]), [0, 1, 0]);
    close(toView(q, [0, -1, 0]), [0, 0, 1]);
  });

  it('right: Y right, Z up', () => {
    const q = lookFrom(VIEW_DIRS.right);
    close(toView(q, [0, 1, 0]), [1, 0, 0]);
    close(toView(q, [0, 0, 1]), [0, 1, 0]);
  });

  it('top is the identity (X right, Y up); bottom keeps X right, -Y up', () => {
    close(lookFrom(VIEW_DIRS.top), [0, 0, 0, 1]);
    const b = lookFrom(VIEW_DIRS.bottom);
    close(toView(b, [1, 0, 0]), [1, 0, 0]);
    close(toView(b, [0, -1, 0]), [0, 1, 0]);
  });

  it('iso keeps Z vertical on screen and looks from front-right-top', () => {
    const q = lookFrom(VIEW_DIRS.iso);
    const z = toView(q, [0, 0, 1]);
    expect(z[0]).toBeCloseTo(0);
    expect(z[1]).toBeGreaterThan(0.8);
    const out = viewOut(q);
    expect(out[0]).toBeGreaterThan(0); expect(out[1]).toBeLessThan(0); expect(out[2]).toBeGreaterThan(0);
  });

  it('maps keys 1-6 and 0', () => {
    expect(Object.entries(VIEW_KEYS)).toEqual([
      ['0', 'iso'], ['1', 'front'], ['2', 'back'], ['3', 'left'], ['4', 'right'], ['5', 'top'], ['6', 'bottom'],
    ]);
  });

  it('normal to an arbitrary direction looks straight along it', () => {
    const n: Vec3 = [0.3, 0.5, -0.2];
    const q = lookFrom(n);
    const l = Math.hypot(...n);
    close(viewOut(q), n.map((v) => v / l));
  });
});

describe('quaternion helpers', () => {
  it('round-trips rows ↔ quaternion', () => {
    const q = quatMul(quatFromAxisAngle([0, 0, 1], 0.7), quatFromAxisAngle([1, 0, 0], -1.1));
    const back = quatFromRows(quatToRows(q));
    const sign = Math.sign(back[3]) === Math.sign(q[3]) ? 1 : -1;
    close(back.map((v) => v * sign), q);
  });

  it('writes a column-major matrix', () => {
    const m = quatToMat4(lookFrom(VIEW_DIRS.right));
    // world Y → view x: column 1 is (1, 0, 0)
    close([m[4]!, m[5]!, m[6]!], [1, 0, 0]);
  });

  it('slerps along the shorter arc and hits both ends', () => {
    const a = lookFrom(VIEW_DIRS.front), b = lookFrom(VIEW_DIRS.right);
    close(slerp(a, b, 0), a);
    const end = slerp(a, b, 1);
    close(viewOut(end), viewOut(b));
    const mid = viewOut(slerp(a, [-b[0], -b[1], -b[2], -b[3]], 0.5));   // same rotation, flipped sign
    close(mid, [Math.SQRT1_2, -Math.SQRT1_2, 0]);
  });
});

describe('axisView', () => {
  it('snaps to the + side, then flips to the − side', () => {
    const iso = lookFrom(VIEW_DIRS.iso);
    const x = axisView('X', iso);
    close(viewOut(x), [1, 0, 0]);
    close(viewOut(axisView('X', x)), [-1, 0, 0]);
    close(viewOut(axisView('Z', iso)), [0, 0, 1]);
    close(viewOut(axisView('Y', iso)), [0, 1, 0]);
  });
});

describe('orbit', () => {
  it('dragging right spins the model about Z so its front moves right', () => {
    const q = orbit(lookFrom(VIEW_DIRS.front), 10, 0);
    const p = toView(q, [0, -1, 0]);
    expect(p[0]).toBeGreaterThan(0);
    close(toView(q, [0, 0, 1]), [0, 1, 0]);   // Z stays up
  });

  it('dragging down tilts the front down (view from above)', () => {
    const q = orbit(lookFrom(VIEW_DIRS.front), 0, 10);
    expect(toView(q, [0, -1, 0])[1]).toBeLessThan(0);
    expect(viewOut(q)[2]).toBeGreaterThan(0);
  });

  it('upside down, dragging right still moves the near side right', () => {
    // past the top pole: viewer behind, Z pointing down the screen
    let q = lookFrom(VIEW_DIRS.front);
    q = orbit(q, 0, 250);   // 2.5 rad: over the top
    expect(toView(q, [0, 0, 1])[1]).toBeLessThan(0);
    const near: Vec3 = viewOut(q);
    const r = orbit(q, 10, 0);
    expect(toView(r, near)[0]).toBeGreaterThan(0);
  });
});
