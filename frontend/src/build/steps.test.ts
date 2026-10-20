import { describe, expect, it } from 'vitest';
import type { RunResponse, Step } from '@/api/client';
import { messageLine, reopenableAt, stepAt, stepIcon, stepInputs, stepLabel, stepProblems, suppressedNote } from './steps';

const op = (line: number, end: number, o: Partial<Step> = {}): Step => ({
  kind: 'op', line, end_line: end, op: 'shell', summary: 'Shell 2 mm, top open', reopenable: true, off: false,
  count: 0, faces: [], edges: [], ...o,
});
const STEPS: Step[] = [
  { kind: 'script', line: 3, end_line: 4, reopenable: false, off: false, count: 2, faces: [], edges: [] },
  op(5, 5, { off: true, reopenable: false }),
  op(6, 6, { op: 'extrude', variant: 'cut', summary: "Cut 'USB cutout' 5 mm", sketch: 'USB cutout' }),
  op(7, 8, { op: 'fillet', summary: 'Fillet 1 mm · 4 edges' }),
  op(9, 9, { op: 'auto_round', summary: 'Round 1 mm, blends 2 mm', reopenable: false }),
];

describe('steps', () => {
  it('shows the registry icon and a label; a script run collapses', () => {
    expect(STEPS.map(stepIcon)).toEqual([null, 'shell', 'extrude', 'fillet', 'round']);
    expect(stepLabel(STEPS[0]!)).toBe('… script (2 lines)');
    expect(stepLabel(STEPS[2]!)).toBe("Cut 'USB cutout' 5 mm");
    expect(stepIcon(op(1, 1, { op: 'holes' }))).toBe('hole');
    expect(stepIcon(op(1, 1, { op: 'truss_windows' }))).toBe('lighten');
  });

  it('finds the step of a line, and whether it reopens', () => {
    expect(stepAt(STEPS, 8)?.line).toBe(7);
    expect(stepAt(STEPS, 2)).toBeNull();
    expect(reopenableAt(STEPS, 8)?.op).toBe('fillet');
    expect(reopenableAt(STEPS, 5)).toBeNull();   // switched off
    expect(reopenableAt(STEPS, 9)).toBeNull();   // written in code
    expect(reopenableAt(STEPS, 3)).toBeNull();   // script
  });

  it('reads the line out of a build message', () => {
    expect(messageLine('line 7: part = fillet(…)\nValueError: no')).toBe(7);
    expect(messageLine('ValueError: no')).toBeNull();
  });

  it('says when a failure follows a switched-off step', () => {
    expect(suppressedNote(STEPS, 7)).toContain('“Shell 2 mm, top open” (line 5) is switched off: line 7 may need');
    expect(suppressedNote(STEPS, 4)).toBeNull();
    expect(suppressedNote(STEPS, null)).toBeNull();
    const two = [...STEPS, op(10, 10, { off: true, summary: 'Fillet 1 mm · 1 edge' })];
    expect(suppressedNote(two, 11)).toMatch(/^Steps .* are switched off/);
  });

  it('puts each problem on the step that caused it', () => {
    const res = {
      face_refs: [{ hint: 'top face', status: 'found', moved_by: 0, line: 5 },
                  { hint: 'side face', status: 'not_found', moved_by: 0, line: 6 }],
      edge_refs: [{ hint: 'top edge', status: 'ambiguous', moved_by: 0.1, line: 8 }],
      organic: { members: 0, failed_members: [], windows: 0, dropped: [], removed_pct: null,
                 warnings: [{ kind: 'thin', message: 'rib 1.2 mm thin', at: [], line: 9 }] },
    } as unknown as RunResponse;
    const p = stepProblems(STEPS, res, 'line 8: radius=P["fillet_r"])\nValueError: fillet failed');
    expect([...p.keys()].sort()).toEqual([6, 7, 9]);
    expect(p.get(7)).toEqual([
      'Failed: ValueError: fillet failed',
      expect.stringContaining('“Shell 2 mm, top open” (line 5) is switched off'),
      'The top edge: not certain, the nearest edge was used',
    ]);
    expect(p.get(6)).toEqual(["The side face wasn't found: reopen the step and pick the face again"]);
    expect(p.get(9)).toEqual(['rib 1.2 mm thin']);
    expect(stepProblems(STEPS, null, '').size).toBe(0);
  });

  it('collects the sketches the backend needs to know', () => {
    expect(stepInputs([{ name: 'Sketch on Top plane', basePlane: true, points: 0 },
                       { name: 'PCB', basePlane: false, points: 4 }]))
      .toEqual({ datum: ['Sketch on Top plane'], points: { PCB: 4 } });
  });
});
