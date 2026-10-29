import { describe, expect, it } from 'vitest';
import type { Step } from '@/api/client';
import type { ExtrudeValues } from '@/components/OpDialogs';
import { extrudeStepOf, sketcherOptions, withSketcherOptions } from './sketchExtrude';

const step = (line: number, over: Partial<Step> = {}): Step => ({
  kind: 'op', line, end_line: line, op: 'extrude', reopenable: true, off: false, count: 1,
  sketch: 'Sketch on top face', faces: [], edges: [], ...over,
});
const values = (over: Partial<ExtrudeValues> = {}): ExtrudeValues => ({
  sketch: 'Sketch on top face', op: 'cut', extent: 'distance', depth: 3, through: false, flip: false, both: false,
  datum: false, face: null, offset: 0, ...over,
});

describe('extrudeStepOf', () => {
  it('finds the last step extruding the sketch', () => {
    const steps = [step(2, { sketch: 'Base' }), step(4), step(6)];
    expect(extrudeStepOf(steps, 'Sketch on top face')?.line).toBe(6);
    expect(extrudeStepOf(steps, 'Base')?.line).toBe(2);
    expect(extrudeStepOf(steps, 'Other')).toBeNull();
  });

  it('skips switched-off steps, linked copies and other operations', () => {
    const steps = [step(3), step(5, { off: true }), step(7, { mirror_of: 3 }), step(8, { pattern_of: 3 }), step(9, { op: 'revolve' })];
    expect(extrudeStepOf(steps, 'Sketch on top face')?.line).toBe(3);
  });
});

describe('withSketcherOptions', () => {
  it('takes what the panel set, keeping the sketch and the face', () => {
    const v = withSketcherOptions(values({ face: { center: [0, 0, 5], normal: [0, 0, 1] } as never }), false,
      { op: 'join', depth: 8, through: false, flip: true });
    expect(v).toMatchObject({ sketch: 'Sketch on top face', op: 'join', depth: 8, flip: true, extent: 'distance' });
    expect(v.face).not.toBeNull();
  });

  it('a through cut, and an empty depth keeps the line\'s', () => {
    expect(withSketcherOptions(values(), false, { op: 'cut', depth: 0, through: true, flip: false }))
      .toMatchObject({ op: 'cut', depth: 3, through: true, extent: 'through' });
  });

  it('keeps the step that makes the part a New body at a distance', () => {
    expect(withSketcherOptions(values({ op: 'new', depth: 5 }), true, { op: 'cut', depth: 12, through: true, flip: false }))
      .toMatchObject({ op: 'new', depth: 12, through: false, extent: 'distance' });
  });

  it('round-trips through the panel', () => {
    const v = values({ op: 'join', depth: 4, flip: true, extent: 'distance', regions: null });
    expect(withSketcherOptions(v, false, sketcherOptions(v))).toEqual(v);
  });

  it('keeps the regions picked for the step, or takes the panel\'s', () => {
    const v = values({ regions: [[0, 0]] });
    expect(sketcherOptions(v).regions).toEqual([[0, 0]]);
    expect(withSketcherOptions(v, false, { op: 'cut', depth: 3, through: false, flip: false }).regions).toEqual([[0, 0]]);
    expect(withSketcherOptions(v, false, { op: 'cut', depth: 3, through: false, flip: false, regions: null }).regions)
      .toBeNull();
    expect(withSketcherOptions(v, false, { op: 'cut', depth: 3, through: false, flip: false, regions: [[1, 2]] }).regions)
      .toEqual([[1, 2]]);
  });
});
