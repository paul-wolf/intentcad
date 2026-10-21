import { describe, expect, it } from 'vitest';
import type { PatternReport, RunEdge, RunFace, Step } from '@/api/client';
import {
  boxSegments, chipPoints, defaultPattern, dirOfEdge, dirOfFace, dirWords, instanceCount, instanceSteps, patternBodyLine,
  patternHandles, patternSkip, patternSpec, patternSummary, patternValues, patternWords, placeInstances, remapSkip, reportsOn,
  rotate, toggleSkip, wayWords, type PatternValues,
} from './pattern';
import { copiesOf, groupSteps } from './mirror';
import { stepIcon } from './steps';

const op = (line: number, o: Partial<Step> = {}): Step => ({
  kind: 'op', line, end_line: line, op: 'extrude', summary: 'Cut', reopenable: true, off: false,
  count: 0, faces: [], edges: [], ...o,
});
const lin = (o: Partial<PatternValues> = {}): PatternValues => ({ ...defaultPattern('linear'), ...o });
const circ = (o: Partial<PatternValues> = {}): PatternValues => ({ ...defaultPattern('circular', { base: 'Z' }), ...o });
type V3 = [number, number, number];
const box = (c: V3, h = 1): V3[] => {
  const out: V3[] = [];
  for (const x of [-h, h]) for (const y of [-h, h]) for (const z of [-h, h]) out.push([c[0] + x, c[1] + y, c[2] + z]);
  return out;
};

describe('pattern values', () => {
  it('round-trips through the API form, spacing or extent, and keeps P expressions', () => {
    const v = lin({ count: 'vent_count', spacing: 'vent_pitch', two: true, dir2: { base: 'Y' }, count2: 3, spacing2: 6,
                    flip: true, skip: [5, 0, 3, 3] });
    const spec = patternSpec(v);
    expect(spec).toMatchObject({ type: 'linear', dir: { base: 'X' }, count: 'vent_count', mode: 'spacing', spacing: 'vent_pitch',
                                 flip: true, dir2: { base: 'Y' }, count2: 3, spacing2: 6, skip: [3, 5] });
    expect('extent' in spec).toBe(false);
    const back = patternValues(spec, { count: 'vent_count' });
    expect(back).toMatchObject({ count: 'vent_count', spacing: 'vent_pitch', two: true, count2: 3, flip: true, skip: [3, 5] });
    const ext = patternSpec(lin({ mode: 'extent', extent: 40 }));
    expect(ext).toMatchObject({ mode: 'extent', extent: 40 });
    expect('spacing' in ext).toBe(false);
    expect(patternValues(ext).mode).toBe('extent');
    const c = patternSpec(circ({ count: 6, angle: 90, symmetric: true, flip: true, skip: [2] }));
    expect(c).toEqual({ type: 'circular', axis: { base: 'Z' }, count: 6, angle: 90, symmetric: true, flip: true, skip: [2] });
    expect(patternValues(c)).toMatchObject({ type: 'circular', count: 6, angle: 90, symmetric: true, flip: true, skip: [2] });
  });

  it('counts instances: symmetric, grids, circles (no duplicate at 360)', () => {
    const p = { n: 4 };
    expect(instanceCount(lin({ count: 3 }), p)).toBe(3);
    expect(instanceCount(lin({ count: 3, symmetric: true }), p)).toBe(5);
    expect(instanceCount(lin({ count: 8, two: true, count2: 3 }), p)).toBe(24);
    expect(instanceCount(lin({ count: 'n' }), p)).toBe(4);
    expect(instanceCount(lin({ count: 2.5 }), p)).toBeNull();
    expect(instanceCount(lin({ count: 0 }), p)).toBeNull();
    expect(instanceCount(circ({ count: 6 }), p)).toBe(6);
    expect(instanceCount(circ({ count: 6, symmetric: true }), p)).toBe(6);   // round the full circle there is no other way
    expect(instanceCount(circ({ count: 3, angle: 60, symmetric: true }), p)).toBe(5);
  });

  it('orders instances as the backend does: first direction fastest, symmetric ones after', () => {
    expect(instanceSteps(lin({ count: 3, symmetric: true }), {})).toEqual([[0, 0], [1, 0], [2, 0], [-1, 0], [-2, 0]]);
    expect(instanceSteps(lin({ count: 2, two: true, count2: 2 }), {})).toEqual([[0, 0], [1, 0], [0, 1], [1, 1]]);
  });

  it('keeps the same copies left out when a count changes', () => {
    const a = lin({ count: 3, two: true, count2: 2, skip: [2, 4] });   // [2,0] and [1,1]
    const b = lin({ count: 4, two: true, count2: 2 });
    expect(remapSkip(a.skip, a, b, {})).toEqual([2, 5]);
    expect(remapSkip([2], lin({ count: 3 }), lin({ count: 2 }), {})).toEqual([]);
    expect(remapSkip([4], circ({ count: 6 }), circ({ count: 8 }), {})).toEqual([4]);
    expect(remapSkip([5], circ({ count: 6 }), circ({ count: 4 }), {})).toEqual([]);
    expect(toggleSkip([3], 1)).toEqual([1, 3]);
    expect(toggleSkip([1, 3], 1)).toEqual([3]);
    expect(toggleSkip([3], 0)).toEqual([3]);
  });

  it('puts the pattern in words', () => {
    expect(patternWords(lin({ count: 8, two: true, count2: 3, skip: [1, 2] }), {})).toBe('8 × 3, 2 skipped');
    expect(patternWords(lin({ count: 4 }), {})).toBe('4 along X');
    const hole = { face: { center: [0, 0, 5] as V3, normal: [0, 0, 1] as V3, area: 30, hint: 'Ø10 cylinder face' } };
    expect(patternWords(circ({ axis: hole }), {})).toBe('6 round the Ø10 cylinder face');
    expect(patternWords(circ({ count: 3, angle: 90 }), {})).toBe('3 round Z over 90°');
    expect(patternSummary(lin({ count: 3 }), {}, { kind: 'body', join: true }))
      .toBe('Makes 2 copies of the whole part along X, 10 mm apart, fused with it into one solid.');
    expect(patternSummary(lin({ count: 3, skip: [2] }), {}, { kind: 'steps', n: 1, after: 12 }))
      .toMatch(/^Adds one line after line 12: one copy of the step along X/);
    expect(patternSummary(lin({ count: 'x' }), {}, { kind: 'body', join: true })).toMatch(/whole number/);
    expect(wayWords([0, 0, -1])).toBe('−Z');
    expect(dirWords({ base: 'Y' })).toBe('Y');
  });

  it('takes directions from picked faces and edges', () => {
    const face = (kind: string): RunFace => ({ index: 1, kind, area: 10, center: [0, 0, 0], normal: [0, 0, 1], radius: 5,
                                                ref: { center: [0, 0, 0], normal: [0, 0, 1], area: 10 } } as unknown as RunFace);
    expect(dirOfFace(face('plane'))).toEqual({ face: expect.objectContaining({ hint: expect.any(String) }) });
    expect(dirOfFace(face('cylinder'))).toEqual({ face: expect.objectContaining({ hint: 'Ø10 cylinder face' }) });
    expect(dirOfFace(face('bspline'))).toBeNull();
    const edge = (kind: string) => ({ index: 1, ref: { kind, midpoint: [0, 0, 0], length: 4 } } as unknown as RunEdge);
    expect(dirOfEdge(edge('line'))).toEqual({ edge: expect.objectContaining({ kind: 'line' }) });
    expect(dirOfEdge(edge('circle'))).toEqual({ edge: expect.objectContaining({ kind: 'circle' }) });
    expect(dirOfEdge(edge('bspline'))).toBeNull();
  });
});

describe('pattern preview', () => {
  const linReport: PatternReport = {
    line: 9, what: 'solid', kind: 'linear', skip: [], dir: [1, 0, 0], spacing: 10, count: 3, n1: 3,
    instances: [0, 1, 2].map((i) => ({ index: i, skip: false, center: [i * 10, 0, 0] as V3, corners: box([i * 10, 0, 0]) })),
  };

  it('moves the instances with a count or spacing typed before the build catches up', () => {
    const v = lin({ count: 4, spacing: 5, skip: [3] });
    const placed = placeInstances(linReport, v, {}, true);
    expect(placed.map((i) => i.center[0])).toEqual([0, 5, 10, 15]);
    expect(placed[3]!.skip).toBe(true);
    expect(placed[2]!.corners[0]).toEqual([9, -1, -1]);
    // a direction changed: shown as built until the build catches up
    expect(placeInstances(linReport, v, {}, false).map((i) => i.center[0])).toEqual([0, 10, 20]);
    // extent: the count fitted within it
    expect(placeInstances(linReport, lin({ count: 5, mode: 'extent', extent: 40 }), {}, true).map((i) => i.center[0]))
      .toEqual([0, 10, 20, 30, 40]);
  });

  it('turns circular instances round the axis', () => {
    const r: PatternReport = { what: 'solid', kind: 'circular', skip: [], origin: [0, 0, 0], axis: [0, 0, 1], step: 90, full: true,
                               instances: [{ index: 0, skip: false, center: [10, 0, 0], corners: box([10, 0, 0]) }] };
    const placed = placeInstances(r, circ({ count: 4 }), {}, true);
    expect(placed).toHaveLength(4);
    expect(placed[1]!.center[0]).toBeCloseTo(0);
    expect(placed[1]!.center[1]).toBeCloseTo(10);
    for (const i of placed) expect(Math.hypot(i.center[0], i.center[1])).toBeCloseTo(10);
    const half = placeInstances(r, circ({ count: 3, angle: 90 }), {}, true);
    expect(half[2]!.center[1]).toBeCloseTo(10);   // 45° apart: the last at 90°
    expect(rotate([1, 0, 0], [0, 0, 0], [0, 0, 1], Math.PI)[0]).toBeCloseTo(-1);
  });

  it('draws boxes, crossed when left out, and numbers each instance once', () => {
    expect(boxSegments(box([0, 0, 0]))).toHaveLength(12 * 6);
    expect(boxSegments(box([0, 0, 0]), true)).toHaveLength(14 * 6);
    expect(boxSegments([])).toEqual([]);
    const a = placeInstances(linReport, lin({ count: 3 }), {}, true);
    const b = a.map((i) => ({ ...i, center: [i.center[0], 10, 0] as V3 }));
    const chips = chipPoints([a, b]);
    expect(chips.map((c) => c.index)).toEqual([0, 1, 2]);
    expect(chips[1]!.point).toEqual([10, 5, 0]);
  });

  it('offers the spacing on the last copy and the count past it; the angle when not a full circle', () => {
    const hs = patternHandles(linReport, lin({ count: 3, spacing: 10 }), {});
    expect(hs.map((h) => h.name)).toEqual(['spacing', 'count']);
    const [sp, ct] = hs as unknown as [{ at: V3; shift: V3; value: number }, { at: V3; shift: V3; value: number; step?: number }];
    // knob at at + shift·value: the last copy, then one spacing past it
    expect(sp.at[0] + sp.shift[0] * sp.value).toBe(20);
    expect(ct.at[0] + ct.shift[0] * ct.value).toBe(30);
    expect(ct.step).toBe(1);
    const ex = patternHandles(linReport, lin({ count: 3, mode: 'extent', extent: 20 }), {});
    expect(ex[0]).toMatchObject({ name: 'extent', value: 20, shift: [1, 0, 0] });
    expect(patternHandles(linReport, lin({ count: 1 }), {}).map((h) => h.name)).toEqual(['count']);
    const r: PatternReport = { what: 'solid', kind: 'circular', skip: [], origin: [0, 0, 0], axis: [0, 0, 1],
                               instances: [{ index: 0, skip: false, center: [10, 0, 5], corners: box([10, 0, 5]) }] };
    expect(patternHandles(r, circ({ count: 6 }), {})).toEqual([]);
    const ang = patternHandles(r, circ({ count: 3, angle: 90 }), {});
    expect(ang).toEqual([expect.objectContaining({ name: 'angle', value: 90, at: [0, 0, 5] })]);
  });

  it('finds the lines a pattern was written on', () => {
    expect(reportsOn([linReport, { ...linReport, line: 4 }], [9]).map((r) => r.line)).toEqual([9]);
    const before = 'P = {}\npart = box(1, 1, 1)';
    const after = 'P = {\n  "n": 3,\n}\npart = box(1, 1, 1)\npart = pattern_body(part, linear("X", P["n"], 5))';
    expect(patternBodyLine(after, null, before)).toBe(5);
    expect(patternBodyLine(after, 3, before)).toBe(6);
  });
});

describe('pattern steps', () => {
  it('says which steps can be patterned', () => {
    expect(patternSkip(op(5))).toBeNull();
    expect(patternSkip(op(5, { op: 'holes' }))).toBeNull();
    expect(patternSkip(op(5, { op: 'shell' }))).toBe("Shell can't be patterned");
    expect(patternSkip(op(5, { pattern_of: 3 }))).toBe('it is a pattern copy already: pattern its original');
    expect(patternSkip(op(5, { mirror_of: 3 }))).toBe('it is a mirrored copy already: pattern its original');
    expect(patternSkip(op(5, { off: true }))).toBe('it is switched off');
  });

  it('shows pattern copies under their original, with the pattern icon', () => {
    const steps = [op(3), op(4, { op: 'fillet' }), op(6, { pattern_of: 3, pattern: '8 × 3' }),
                   op(7, { pattern_of: 4, pattern: '6 round Z' })];
    expect(groupSteps(steps).map((r) => [r.step.line, r.depth])).toEqual([[3, 0], [6, 1], [4, 0], [7, 1]]);
    expect(copiesOf(steps, 3).map((s) => s.line)).toEqual([6]);
    expect(stepIcon(steps[2]!)).toBe('pattern');
    expect(stepIcon(steps[3]!)).toBe('pattern-circular');
    expect(stepIcon(op(9, { op: 'pattern_body' }))).toBe('pattern');
  });
});
