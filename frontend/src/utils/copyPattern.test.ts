import { describe, expect, it } from 'vitest';
import { describePattern, patternCopies, patternToEdit, patternsOf, prunePatterns } from './copyPattern';
import type { CopyPattern, Entity } from '@/types/document';

const circle = { id: 'c', type: 'circle', center: { x: 10, y: 0 }, radius: 2 } as unknown as Entity;
const grid: CopyPattern = { id: 'g', kind: 'grid', sourceIds: ['c'], copyIds: ['c1', 'c2'], countX: 3, countY: 1, spacingX: 5, spacingY: 0 };
const ring: CopyPattern = { id: 'r', kind: 'circular', sourceIds: ['d'], copyIds: ['d1'], center: { x: 0, y: 0 }, count: 2 };

describe('copy patterns', () => {
  it('makes grid or circular copies from the params', () => {
    expect(patternCopies([circle], ['c'], grid).length).toBe(2);
    expect(patternCopies([circle], ['c'], { kind: 'circular', center: { x: 0, y: 0 }, count: 6 }).length).toBe(5);
  });

  it('drops a pattern with its last source or last copy, and trims the rest', () => {
    expect(prunePatterns([grid, ring], new Set(['c1']))).toEqual([{ ...grid, copyIds: ['c2'] }, ring]);
    expect(prunePatterns([grid, ring], new Set(['c']))).toEqual([ring]);
    expect(prunePatterns([grid, ring], new Set(['d1']))).toEqual([grid]);
    expect(prunePatterns(undefined, new Set(['c']))).toBeUndefined();
  });

  it('finds the patterns a selection belongs to', () => {
    expect(patternsOf([grid, ring], ['c2']).map((p) => p.id)).toEqual(['g']);
    expect(patternsOf([grid, ring], ['d', 'c']).map((p) => p.id)).toEqual(['g', 'r']);
    expect(patternsOf([grid, ring], ['x'])).toEqual([]);
  });

  it('describes a pattern in words', () => {
    expect(describePattern(grid)).toBe('3 × 1 grid, 5 × 0 apart');
    expect(describePattern({ kind: 'circular', center: { x: 1.5, y: -2 }, count: 8 })).toBe('8 round (1.5, -2)');
  });

  it('reopens the copy a selection already is, rather than adding another', () => {
    const ring2: CopyPattern = { ...ring, id: 'r2', copyIds: ['d2'] };
    const ents = ['c', 'c1', 'c2', 'd', 'd1', 'd2', 'x'].map((id) => ({ ...circle, id }))
      .concat({ id: 'dim', type: 'dimension' } as unknown as Entity);
    expect(patternToEdit([grid, ring], ents, ['c'], 'grid')?.id).toBe('g');
    expect(patternToEdit([grid, ring], ents, ['c', 'c2', 'dim'], 'grid')?.id).toBe('g');   // a dimension rides along
    expect(patternToEdit([grid, ring], ents, ['c'], 'circular')).toBeUndefined();           // other kind: a new one
    expect(patternToEdit([grid, ring], ents, ['c', 'x'], 'grid')).toBeUndefined();          // more than the copy
    expect(patternToEdit([ring, ring2], ents, ['d'], 'circular')?.id).toBe('r2');          // the latest
  });
});
