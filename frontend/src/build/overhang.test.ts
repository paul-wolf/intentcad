import { beforeEach, describe, expect, it } from 'vitest';
import {
  bedLevel, bedWords, clampThreshold, dirWords, loadOverhangs, onBed, overhangAngle, overhangHoverText, overhangInstruction,
  overhangIntensity, overhangKind, overhangSummary, saveOverhangs,
} from './overhang';
import type { Vec3 } from './dragHandle';
import type { RunFace } from '@/api/client';

const S = Math.SQRT1_2;

/** A soup of quads, each turned so its winding faces `out`. */
function soup(quads: { c: Vec3[]; out: Vec3 }[]) {
  const positions: number[] = [];
  const faces: Pick<RunFace, 'index' | 'start' | 'count'>[] = [];
  quads.forEach(({ c, out }, index) => {
    faces.push({ index, start: positions.length / 3, count: 6 });
    for (const t of [[c[0]!, c[1]!, c[2]!], [c[0]!, c[2]!, c[3]!]]) {
      const [a, b, d] = t as [Vec3, Vec3, Vec3];
      const n = [
        (b[1] - a[1]) * (d[2] - a[2]) - (b[2] - a[2]) * (d[1] - a[1]),
        (b[2] - a[2]) * (d[0] - a[0]) - (b[0] - a[0]) * (d[2] - a[2]),
        (b[0] - a[0]) * (d[1] - a[1]) - (b[1] - a[1]) * (d[0] - a[0]),
      ];
      const tri = n[0]! * out[0] + n[1]! * out[1] + n[2]! * out[2] >= 0 ? [a, b, d] : [a, d, b];
      for (const p of tri) positions.push(...p);
    }
  });
  return { positions, faces };
}

/** An axis-aligned rectangle at `at` on axis `ax`, spanning the other two axes. */
function rect(ax: 0 | 1 | 2, at: number, lo: [number, number], hi: [number, number], sign: 1 | -1) {
  const [u, v] = [[1, 2], [0, 2], [0, 1]][ax]! as [number, number];
  const c = [[lo[0], lo[1]], [hi[0], lo[1]], [hi[0], hi[1]], [lo[0], hi[1]]].map(([a, b]) => {
    const p: Vec3 = [0, 0, 0]; p[ax] = at; p[u] = a!; p[v] = b!; return p;
  });
  const out: Vec3 = [0, 0, 0]; out[ax] = sign;
  return { c, out };
}

/** A T: a 10×10×20 stem (x 15–25) under a 40×10×5 cap (z 20–25); the cap's
 *  underside either side of the stem is a ledge, 2 × 150 mm². */
function tShape() {
  return soup([
    rect(2, 0, [15, 0], [25, 10], -1),                                // stem bottom: on the bed
    rect(0, 15, [0, 0], [10, 20], -1), rect(0, 25, [0, 0], [10, 20], 1),
    rect(1, 0, [15, 0], [25, 20], -1), rect(1, 10, [15, 0], [25, 20], 1),
    rect(2, 20, [0, 0], [15, 10], -1), rect(2, 20, [25, 0], [40, 10], -1), // the ledges
    rect(2, 25, [0, 0], [40, 10], 1),                                 // cap top
    rect(0, 0, [0, 20], [10, 25], -1), rect(0, 40, [0, 20], [10, 25], 1),
    rect(1, 0, [0, 20], [40, 25], -1), rect(1, 10, [0, 20], [40, 25], 1),
  ]);
}

describe('the overhang angle', () => {
  it('is 0 for a vertical wall, 45 under a chamfer, 90 for a ceiling, none facing up', () => {
    expect(overhangAngle([1, 0, 0])).toBeCloseTo(0, 9);
    expect(overhangAngle([S, 0, -S])).toBeCloseTo(45, 9);
    expect(overhangAngle([0, 0, -1])).toBeCloseTo(90, 9);
    expect(overhangAngle([0, 0, 1])).toBeNull();
    expect(overhangAngle([0, S, S])).toBeNull();
    expect(overhangAngle([0, 0, -7])).toBeCloseTo(90, 9);          // any length
  });

  it('follows the down direction', () => {
    expect(overhangAngle([1, 0, 0], [1, 0, 0])).toBeCloseTo(90, 9);
    expect(overhangAngle([0, 0, -1], [1, 0, 0])).toBeCloseTo(0, 9);
  });
});

describe('the categories', () => {
  it('flags past the threshold: steep, then a ceiling from 80°', () => {
    expect(overhangKind(45, 45)).toBeNull();
    expect(overhangKind(46, 45)).toBe('steep');
    expect(overhangKind(79.9, 45)).toBe('steep');
    expect(overhangKind(80, 45)).toBe('ceiling');
    expect(overhangKind(90, 45)).toBe('ceiling');
    expect(overhangKind(null, 45)).toBeNull();
  });

  it('a higher threshold lets more through', () => {
    expect(overhangKind(50, 45)).toBe('steep');
    expect(overhangKind(50, 55)).toBeNull();
    expect(overhangKind(35, 30)).toBe('steep');
  });

  it('shades harder as it gets flatter', () => {
    expect(overhangIntensity(46)).toBeLessThan(overhangIntensity(75));
    expect(overhangIntensity(45)).toBe(0);
    expect(overhangIntensity(90)).toBe(1);
  });

  it('keeps the threshold to 30–70 in 5° steps', () => {
    expect(clampThreshold(47)).toBe(45);
    expect(clampThreshold(10)).toBe(30);
    expect(clampThreshold(90)).toBe(70);
    expect(clampThreshold(NaN)).toBe(45);
  });
});

describe('the bed', () => {
  it('a face facing down at the lowest level rests on it; one higher up does not', () => {
    const { positions } = tShape();
    expect(bedLevel(positions)).toBeCloseTo(0, 9);                  // max of -z: z = 0
    expect(onBed([0, 0, -1], [[15, 0, 0], [25, 0, 0], [25, 10, 0]], [0, 0, -1], 0)).toBe(true);
    expect(onBed([0, 0, -1], [[0, 0, 20], [15, 0, 20], [15, 10, 20]], [0, 0, -1], 0)).toBe(false);
    expect(onBed([S, 0, -S], [[15, 0, 0], [25, 0, 0], [25, 10, 0]], [0, 0, -1], 0)).toBe(false);
  });

  it('a box: its bottom is on the bed, so nothing overhangs', () => {
    const box = soup([
      rect(2, 0, [0, 0], [10, 10], -1), rect(2, 10, [0, 0], [10, 10], 1),
      rect(0, 0, [0, 0], [10, 10], -1), rect(0, 10, [0, 0], [10, 10], 1),
      rect(1, 0, [0, 0], [10, 10], -1), rect(1, 10, [0, 0], [10, 10], 1),
    ]);
    const s = overhangSummary(box, box.faces);
    expect(s.regions).toEqual([]);
    expect(s.steepArea + s.ceilingArea).toBe(0);
  });
});

describe('the summary', () => {
  it('a T printed upright: two ledge undersides, 300 mm² of ceiling', () => {
    const t = tShape();
    const s = overhangSummary(t, t.faces);
    expect(s.regions).toHaveLength(2);
    expect(s.ceilingArea).toBeCloseTo(300, 6);
    expect(s.steepArea).toBe(0);
    expect(s.regions.map((r) => Math.round(r.area))).toEqual([150, 150]);
    expect(s.faces).toEqual([5, 6]);
    const left = s.regions.find((r) => r.center[0] < 20)!;
    expect(left.center.map((x) => Math.round(x * 10) / 10)).toEqual([7.5, 5, 20]);
    expect(left.maxAngle).toBeCloseTo(90, 6);
  });

  it('the bed set to a side face: the T on its cap end, the stem wall facing it is a ceiling', () => {
    const t = tShape();
    const s = overhangSummary(t, t.faces, { down: [1, 0, 0] });
    // the cap's right end (x = 40) rests on the bed; the stem's right wall (x = 25) hangs over it
    expect(s.faces).toEqual([2]);
    expect(s.ceilingArea).toBeCloseTo(200, 6);
    expect(s.regions).toHaveLength(1);
  });

  it('an inside-out body counts its faces the other way round', () => {
    const t = tShape();
    const s = overhangSummary(t, t.faces, { inverted: [[0, t.positions.length / 3]] });
    // everything flipped: the cap top now faces down, high above the stem bottom (now facing up)
    expect(s.faces).toEqual([7]);
    expect(s.ceilingArea).toBeCloseTo(400, 6);
  });

  it('the threshold decides whether a 60° slope is flagged', () => {
    const a = Math.sin(Math.PI / 3), b = Math.cos(Math.PI / 3);
    const slope = soup([{ c: [[0, 0, 15], [10, 0, 15], [10, 10 * a, 15 + 10 * b], [0, 10 * a, 15 + 10 * b]], out: [0, b, -a] }]);
    expect(overhangSummary(slope, slope.faces, { threshold: 45 }).steepArea).toBeGreaterThan(0);
    expect(overhangSummary(slope, slope.faces, { threshold: 65 }).regions).toEqual([]);
  });
});

describe('the words', () => {
  it('hover, bed and the Ask AI instruction', () => {
    expect(overhangHoverText(62.4, 'steep')).toBe('62° overhang');
    expect(overhangHoverText(90, 'ceiling')).toBe('90° ceiling');
    expect(bedWords(null)).toMatch(/^Z/);
    expect(dirWords([0, 0, -1])).toBe('−Z');
    expect(dirWords([0, 2, 0])).toBe('+Y');
    expect(dirWords([S, 0, -S])).toBe('(0.71, 0, −0.71)');
    expect(bedWords({ center: [0, 5, 10], normal: [0, -1, 0], area: 1, hint: 'face' })).toBe('the front face at (0, 5, 10)');
    const t = tShape();
    const faces = t.faces.map((f) => ({ ...f, kind: 'plane', area: 150, center: [7.5, 5, 20], normal: [0, 0, -1] } as RunFace));
    const text = overhangInstruction(overhangSummary(t, t.faces), faces, null);
    expect(text).toMatch(/2 regions, 0 mm² steep, 300 mm² ceiling/);
    expect(text).toMatch(/1\. ceiling \/ bridge around \(.*\), 90°, 150 mm² \(flat face at \(7\.5, 5, 20\)\)/);
    expect(text).toMatch(/chamfers instead of fillets/);
  });
});

describe('the remembered state', () => {
  const store = new Map<string, string>();
  beforeEach(() => {
    store.clear();
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v),
    };
  });
  it('is per user, off by default', () => {
    expect(loadOverhangs('u1')).toEqual({ on: false, threshold: 45 });
    saveOverhangs({ on: true, threshold: 55 }, 'u1');
    expect(loadOverhangs('u1')).toEqual({ on: true, threshold: 55 });
    expect(loadOverhangs('u2')).toEqual({ on: false, threshold: 45 });
  });
});
