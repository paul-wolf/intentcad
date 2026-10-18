import { describe, expect, it } from 'vitest';
import { gridCopies } from './gridCopy';
import type { Entity } from '@/types/document';

const circle = { id: 'c', type: 'circle', center: { x: 1, y: 2 }, radius: 3 } as unknown as Entity;
const dim = { id: 'd', type: 'dimension' } as unknown as Entity;

describe('gridCopies', () => {
  it('copies to every grid position but the original', () => {
    let n = 0;
    const out = gridCopies([circle], ['c'], 3, 2, 10, -5, () => `n${n++}`);
    expect(out).toHaveLength(5);
    expect(out.map((e) => (e as unknown as { center: { x: number; y: number } }).center)).toEqual([
      { x: 11, y: 2 }, { x: 21, y: 2 }, { x: 1, y: -3 }, { x: 11, y: -3 }, { x: 21, y: -3 },
    ]);
    expect(out.map((e) => e.id)).toEqual(['n0', 'n1', 'n2', 'n3', 'n4']);
  });

  it('skips dimensions and missing ids', () => {
    expect(gridCopies([circle, dim], ['d', 'gone'], 2, 2, 5, 5)).toEqual([]);
    expect(gridCopies([circle], ['c'], 1, 1, 5, 5)).toEqual([]);
  });
});
