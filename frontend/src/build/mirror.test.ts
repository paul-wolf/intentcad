import { describe, expect, it } from 'vitest';
import type { Step } from '@/api/client';
import {
  copiesOf, groupSteps, mirrorBodySummary, mirrorPlaneShape, mirrorPlaneWords, mirrorSkip, mirrorStepsSummary,
  nextStepSelection, sameMirrorPlane,
} from './mirror';
import { stepIcon } from './steps';

const op = (line: number, o: Partial<Step> = {}): Step => ({
  kind: 'op', line, end_line: line, op: 'extrude', summary: 'Cut', reopenable: true, off: false,
  count: 0, faces: [], edges: [], ...o,
});
const FACE = { center: [100, 20, 10] as [number, number, number], normal: [1, 0, 0] as [number, number, number],
               area: 800, hint: 'right face' };

describe('mirror', () => {
  it('says which steps can be mirrored, as the backend does', () => {
    expect(mirrorSkip(op(5))).toBeNull();
    expect(mirrorSkip(op(5, { op: 'holes' }))).toBeNull();
    expect(mirrorSkip(op(5, { op: 'fillet' }))).toBeNull();
    expect(mirrorSkip(op(5, { op: 'shell' }))).toBe("Shell can't be mirrored");
    expect(mirrorSkip(op(5, { op: 'auto_round' }))).toBe("Round can't be mirrored");
    expect(mirrorSkip(op(5, { off: true }))).toBe('it is switched off');
    expect(mirrorSkip(op(5, { mirror_of: 3 }))).toBe('it is a mirrored copy already: mirror its original');
    expect(mirrorSkip({ ...op(5), kind: 'script', op: null })).toBe("it isn't a step the editor can mirror");
  });

  it('puts the plane in words, and draws it', () => {
    expect(mirrorPlaneWords({ base: 'YZ' })).toBe('the YZ plane');
    expect(mirrorPlaneWords({ plane: 'Mid' })).toBe('plane Mid');
    expect(mirrorPlaneWords({ face: FACE })).toBe('the right face');
    expect(mirrorPlaneShape({ base: 'YZ' }, {})?.normal).toEqual([1, 0, 0]);
    const mid = { kind: 'offset' as const, status: 'same' as const, origin: [50, 0, 0] as [number, number, number],
                  normal: [1, 0, 0] as [number, number, number], xAxis: [0, 1, 0] as [number, number, number] };
    expect(mirrorPlaneShape({ plane: 'Mid' }, { Mid: mid })).toEqual({ name: 'Mid', origin: [50, 0, 0], normal: [1, 0, 0], xAxis: [0, 1, 0] });
    expect(mirrorPlaneShape({ plane: 'Gone' }, { Mid: mid })).toBeNull();
    const f = mirrorPlaneShape({ face: FACE }, {});
    expect(f?.normal).toEqual([1, 0, 0]);
    expect(f?.origin[0]).toBeCloseTo(100);
    expect(sameMirrorPlane({ plane: 'Mid' }, { plane: 'Mid' })).toBe(true);
    expect(sameMirrorPlane({ base: 'XY' }, { plane: 'XY' })).toBe(false);
    expect(sameMirrorPlane({ face: FACE }, { face: { ...FACE, hint: 'x' } })).toBe(true);
  });

  it('sums up what the dialogs will do', () => {
    expect(mirrorBodySummary({ plane: 'Mid' }, true)).toMatch(/across plane Mid and fuses .* one solid/);
    expect(mirrorBodySummary({ base: 'YZ' }, false)).toMatch(/separate body .* left and right versions/);
    expect(mirrorStepsSummary({ plane: 'Mid' }, 2, 9)).toMatch(/^Adds 2 lines after line 9: each step again on the other side of plane Mid/);
    expect(mirrorStepsSummary({ plane: 'Mid' }, 0, null)).toBe('None of the chosen steps can be mirrored.');
  });

  it('lists each linked copy under its original, with the mirror icon', () => {
    const steps = [op(5), op(6, { op: 'holes' }), op(7, { op: 'fillet' }), op(8, { mirror_of: 5, mirror_plane: 'Mid' }),
                   op(9, { op: 'holes', mirror_of: 6 }), op(10, { mirror_of: 42 })];
    expect(groupSteps(steps).map((r) => [r.step.line, r.depth])).toEqual([[5, 0], [8, 1], [6, 0], [9, 1], [7, 0], [10, 0]]);
    expect(stepIcon(steps[3]!)).toBe('mirror');
    expect(stepIcon(op(3, { op: 'mirror_body' }))).toBe('mirror');
    expect(copiesOf(steps, 5).map((s) => s.line)).toEqual([8]);
    expect(copiesOf(steps, 7)).toEqual([]);
  });

  it('chooses several steps with Ctrl and Shift', () => {
    const order = [5, 8, 6, 9, 7];
    expect(nextStepSelection([5], order, 6, 5, 'only')).toEqual([6]);
    expect(nextStepSelection([5], order, 6, 5, 'toggle')).toEqual([5, 6]);
    expect(nextStepSelection([5, 6], order, 6, 5, 'toggle')).toEqual([5]);
    expect(nextStepSelection([5], order, 6, 5, 'range')).toEqual([5, 8, 6]);
    expect(nextStepSelection([], order, 6, null, 'range')).toEqual([6]);
  });
});
