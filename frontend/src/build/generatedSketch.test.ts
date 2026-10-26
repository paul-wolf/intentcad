import { describe, expect, it } from 'vitest';
import type { Entity as SketchEntity } from '@/types/document';
import type { UsedByPart } from '@/api/client';
import { arcMidpoint } from '@/utils/arcGeometry';
import { boundsOf, checksWords, fitView, hoverWords, linePath, outputNote, outputOf, trialErrorWords, usedWords } from './generatedSketch';

const view = { cx: 0, cy: 0, scale: 1, width: 0, height: 0 };
const user = (name: string, groups: string[], names: string[] = []): UsedByPart =>
  ({ id: name, name, uses: [{ alias: 'layout', sketch: 's', in_script: true, groups, names }], stale: [], pinned: false });

describe('generated sketch drawing', () => {
  it('knows the output an element belongs to', () => {
    expect(outputOf('g:brace_holes:12')).toBe('brace_holes');
    expect(outputOf('e123')).toBeNull();
  });

  it('draws a bulged segment on the side the editor draws it', () => {
    const e = { id: 'g:a:0', type: 'line', points: [{ x: 0, y: 0 }, { x: 10, y: 0 }], bulge: [0.5] } as SketchEntity;
    const d = linePath(e, view);
    // radius d(1+b²)/(4|b|) = 6.25, minor arc, sweep 1 (clockwise on screen)
    expect(d).toBe('M0 0A6.25 6.25 0 0 1 10 0');
    // a clockwise sweep from (0,0) to (10,0) on a y-down screen passes above: y < 0, as arcMidpoint
    expect(arcMidpoint({ x: 0, y: 0 }, { x: 10, y: 0 }, 0.5).y).toBeLessThan(0);
  });

  it('closes a closed outline', () => {
    const e = { id: 'g:p:0', type: 'line', closed: true,
                points: [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 2 }] } as SketchEntity;
    expect(linePath(e, view)).toBe('M0 0L4 0L4 2L0 0Z');
  });

  it('fits what it holds, notes included', () => {
    const b = boundsOf([{ id: 'g:h:0', type: 'circle', center: { x: 10, y: 0 }, radius: 2 } as SketchEntity],
                       { labels: [{ text: 'x', at: [-10, 5] }], dims: [] });
    expect(b).toEqual({ minX: -10, minY: -2, maxX: 12, maxY: 5 });
    const v = fitView(b, 300, 200, 0);
    expect(v.cx).toBe(1);
    expect(v.scale).toBeCloseTo(300 / 22);
    expect(fitView(null, 300, 200).scale).toBe(2);
  });
});

describe('generated sketch words', () => {
  const users = [user('Top plate', ['brace_holes', 'plate_outline']), user('Arm brace', [], ['brace_holes'])];

  it('says which parts use an output', () => {
    expect(usedWords(users, 'brace_holes')).toBe('used by Top plate and Arm brace');
    expect(usedWords(users, 'stack_space')).toBe('not used by any part yet');
    expect(hoverWords({ name: 'brace_holes', description: '', kind: 'holes', count: 36, size: '36 holes Ø3.2' }, users))
      .toBe('brace_holes: 36 holes Ø3.2 (Top plate, Arm brace)');
  });

  it('counts the checks that pass', () => {
    const c = (ok: boolean) => ({ name: 'x', ok, message: '' });
    expect(checksWords([c(true), c(false), c(true)])).toBe('2 of 3 pass');
    expect(checksWords([c(true), c(true)])).toBe('All 2 pass');
  });

  it('says what a value it cannot generate with leaves', () => {
    expect(trialErrorWords({ brace_r_in: 20 }, { brace_r_in: 42 }, 'the braces collide'))
      .toBe("Can't generate with brace_r_in = 20: the braces collide. Parts keep the drawing for brace_r_in = 42.");
  });

  it('says which output a part takes, and the checks that fail', () => {
    const gen = { outputs: [{ name: 'brace_holes', description: '', kind: 'holes' as const, count: 36, size: '36 holes Ø3.4' }],
                  checks: [{ name: 'bed fit', ok: true, message: '' }, { name: 'hole edge', ok: false, message: '1.5 mm' }],
                  annotations: { labels: [], dims: [] }, reads: {}, error: null, ran_at: 0 };
    expect(outputNote(gen, 'brace_holes')).toEqual({ words: 'Output brace_holes: 36 holes Ø3.4', failing: '⚠ 1 check fails: hole edge' });
    expect(outputNote(gen, null).words).toBe('The whole sketch (1 output)');
    expect(outputNote({ ...gen, checks: [] }, 'gone')).toEqual({ words: 'Output gone: the sketch no longer makes it', failing: '' });
  });
});
