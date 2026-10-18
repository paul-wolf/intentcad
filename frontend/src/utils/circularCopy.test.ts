import { describe, expect, it } from 'vitest';
import { circularCopies } from './circularCopy';
import type { Entity } from '@/types/document';

const circle = { id: 'c', type: 'circle', center: { x: 10, y: 0 }, radius: 2 } as unknown as Entity;
const dim = { id: 'd', type: 'dimension' } as unknown as Entity;

describe('circularCopies', () => {
  it('copies to every position round the centre but the original', () => {
    let n = 0;
    const out = circularCopies([circle], ['c'], { x: 0, y: 0 }, 4, () => `n${n++}`);
    expect(out.map((e) => e.id)).toEqual(['n0', 'n1', 'n2']);
    const centers = out.map((e) => (e as unknown as { center: { x: number; y: number } }).center);
    const expected = [{ x: 0, y: 10 }, { x: -10, y: 0 }, { x: 0, y: -10 }];
    centers.forEach((c, i) => {
      expect(c.x).toBeCloseTo(expected[i]!.x);
      expect(c.y).toBeCloseTo(expected[i]!.y);
    });
  });

  it('skips dimensions and missing ids, and a count of 1 adds nothing', () => {
    expect(circularCopies([circle, dim], ['d', 'gone'], { x: 0, y: 0 }, 6)).toEqual([]);
    expect(circularCopies([circle], ['c'], { x: 0, y: 0 }, 1)).toEqual([]);
  });
});
