import { describe, it, expect } from 'vitest';
import type { Entity, Sketch } from '@/types/document';
import {
  angleFromHandle, axisChoices, axisLabel, defaultAxis, lineProblem, profileSide, revolvable, revolveHandle, revolveReport,
  revolveSummary, segmentPoints, type RevolveReport, type RevolveValues,
} from './revolve';
import { referencedSketchNames, sketchLoops, sketchProfile } from './faceSketch';

const sketch = (entities: Entity[], plane = true): Sketch => ({
  id: 'sk', name: 'Knob', visible: true, constraints: [], entities,
  ...(plane ? { plane: { origin: [0, 0, 0], normal: [0, -1, 0], xAxis: [1, 0, 0] } } : {}),
});
const rect = (cx: number, cy: number, w: number, h: number, id = 'r'): Entity =>
  ({ id, type: 'rectangle', center: { x: cx, y: cy }, width: w, height: h }) as Entity;
const line = (id: string, pts: [number, number][], extra: Partial<Entity> = {}): Entity =>
  ({ id, type: 'line', points: pts.map(([x, y]) => ({ x, y })), ...extra }) as Entity;

describe('axisChoices', () => {
  it('offers the V and H axes, then the construction and reference lines, numbered', () => {
    const sk = sketch([
      rect(10, -5, 4, 10),
      line('c1', [[20, -20], [20, 20]], { construction: true }),
      line('r1', [[0, 30], [10, 30]], { reference: true }),
      line('plain', [[0, 0], [1, 1]]),
    ]);
    const cs = axisChoices(sk);
    expect(cs.map((c) => c.label)).toEqual(['V axis', 'H axis', 'Construction line 1', 'Reference line 1']);
    expect(cs.map((c) => c.id)).toEqual(['axis-v', 'axis-h', 'c1', 'r1']);
    expect(axisLabel({ line: 'c1' }, cs)).toBe('Construction line 1');
    expect(axisLabel({ base: 'Z' })).toBe('Z axis');
    expect(axisLabel(null)).toBe('no axis yet');
  });
});

describe('profileSide and lineProblem', () => {
  it('a rectangle beside the V axis is on one side', () => {
    const sk = sketch([rect(10, -5, 4, 10)]);
    const r = profileSide(sketchLoops(sk).loops, [0, -100], [0, 100]);
    expect(r.side).not.toBe(0);
    expect(r.crossings).toEqual([]);
    expect(r.reach).toBeCloseTo(12, 6);
    expect(lineProblem(sk, 'axis-v')).toBeNull();
  });

  it('touching the axis is fine', () => {
    const sk = sketch([rect(5, -5, 10, 10)]);      // x from 0 to 10
    expect(lineProblem(sk, 'axis-v')).toBeNull();
  });

  it('a shape across the axis is marked where it crosses', () => {
    const sk = sketch([rect(0, -5, 10, 10)]);      // x from -5 to 5
    const p = lineProblem(sk, 'axis-v');
    expect(p?.message).toMatch(/cross the V axis/);
    const ys = p!.crossings.map((c) => { expect(c[0]).toBeCloseTo(0, 6); return Math.round(c[1]); }).sort((a, b) => a - b);
    expect(ys).toEqual([-10, 0]);
  });

  it('a shape crossing on a vertex (a diamond) still counts', () => {
    const sk = sketch([line('d', [[0, -10], [5, 0], [0, 10], [-5, 0]], { closed: true })]);
    expect(lineProblem(sk, 'axis-v')?.crossings.length).toBeGreaterThan(0);
  });

  it('says what is wrong without a line or a shape', () => {
    expect(lineProblem(sketch([rect(10, -5, 4, 10)]), 'gone')?.message).toMatch(/gone/);
    expect(lineProblem(sketch([line('o', [[1, 1], [2, 2]])]), 'axis-v')?.message).toMatch(/no closed shape/);
  });
});

describe('defaultAxis', () => {
  it('takes V when the shapes are on one side of it, else H, else none', () => {
    expect(defaultAxis(sketch([rect(10, -5, 4, 10)]))).toEqual({ line: 'axis-v' });
    expect(defaultAxis(sketch([rect(0, -10, 4, 6)]))).toEqual({ line: 'axis-h' });
    expect(defaultAxis(sketch([rect(0, 0, 4, 6)]))).toBeNull();
  });

  it('revolvable: a sketch on a plane with a closed shape', () => {
    expect(revolvable([sketch([rect(10, -5, 4, 10)]), sketch([rect(1, 1, 1, 1)], false), sketch([])])).toHaveLength(1);
  });
});

describe('segmentPoints', () => {
  it('runs an arc from end to end through its middle', () => {
    const pts = segmentPoints({ t: 'arc', p: [[1, 0], [0, 1], [-1, 0]] }, 8);
    expect(pts[0]).toEqual([1, 0]);
    expect(pts[8]![0]).toBeCloseTo(-1, 9);
    expect(pts[4]![1]).toBeCloseTo(1, 9);        // through (0, 1), not (0, -1)
    pts.forEach((p) => expect(Math.hypot(p[0], p[1])).toBeCloseTo(1, 9));
  });
});

describe('the report, the handle and the words', () => {
  const rep: RevolveReport = {
    line: 4, label: 'V axis', origin: [0, 0, 0], axis: [0, 0, 1], normal: [0, -1, 0], angle: 90, both: false, flip: false,
    arm: [1, 0, 0], radius: 12, center: [10, 0, 5],
  };

  it('finds the report on its line (moved by lines written above it), or the last for a new one', () => {
    const r = { revolves: [{ ...rep, line: 2 }, rep] };
    expect(revolveReport(r, 3, 1)).toBe(rep);
    expect(revolveReport(r, 2)).toEqual({ ...rep, line: 2 });
    expect(revolveReport(r, null)).toBe(rep);
    expect(revolveReport(undefined, null)).toBeNull();
  });

  it('puts the handle on the axis level with the shapes, past their reach', () => {
    const h = revolveHandle(rep, 90)!;
    expect(h.at).toEqual([0, 0, 5]);
    expect(h.w).toEqual([1, 0, 0]);
    expect(h.n.map((x) => x + 0)).toEqual([0, 1, 0]);     // Z × X: the way the shapes turn
    expect(h.arm).toBeCloseTo(16, 6);
    expect(h.value).toBe(90);
    expect(revolveHandle({ ...rep, both: true }, 90)!.value).toBe(45);
    expect(revolveHandle({ ...rep, error: 'crosses' }, 90)).toBeNull();
  });

  it('reads the dragged handle back as an angle', () => {
    expect(angleFromHandle(90, false)).toBe(90);
    expect(angleFromHandle(-90, false)).toBe(270);        // past half way the handle reads negative
    expect(angleFromHandle(180, false)).toBe(180);
    expect(angleFromHandle(60, true)).toBe(120);
    expect(angleFromHandle(0, true)).toBe(1);
  });

  it('says what it makes', () => {
    const v: RevolveValues = { sketch: 'Knob', op: 'new', axis: { line: 'axis-v' }, angle: 360, both: false, flip: false };
    expect(revolveSummary(v, 360, 'V axis')).toBe('Makes the part from “Knob” turned a full 360° about the V axis: a round shape.');
    expect(revolveSummary({ ...v, op: 'cut', both: true }, 90, 'V axis')).toMatch(/^Cuts .* 45° each way .* \(90° in all\)/);
    expect(revolveSummary({ ...v, op: 'join' }, 180, 'V axis', [0, -1, 0])).toMatch(/^Adds .* 180° .* out of the side the sketch faces \(toward −Y\)/);
  });
});

describe('sketch lines in the profile and the script', () => {
  it('sends the straight construction and reference lines (the axes too) with the profile', () => {
    const sk = sketch([rect(10, -5, 4, 10), line('c1', [[20, -20], [20, 20]], { construction: true })]);
    const p = sketchProfile(sk)!;
    expect(p.lines?.c1).toEqual([[20, -20], [20, 20]]);
  });

  it('finds sketch_line() names as sketches the script uses', () => {
    const src = 'part = revolve(sketch("Knob"), axis=sketch_line("Axis sketch", "axis-v"))';
    expect(referencedSketchNames(src)).toEqual(['Knob', 'Axis sketch']);
  });
});
