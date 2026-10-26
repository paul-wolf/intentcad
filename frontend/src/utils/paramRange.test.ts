import { describe, expect, it } from 'vitest';
import { autoRange, sliderRange, snap } from './paramRange';

describe('autoRange', () => {
  it('rounds about 0.5× to 2× to round numbers', () => {
    expect(autoRange(42, 'mm')).toEqual({ min: 20, max: 85, step: 0.5 });
    expect(autoRange(3.4, 'mm')).toEqual({ min: 1.5, max: 7, step: 0.05 });
    expect(autoRange(406.4, 'mm')).toEqual({ min: 200, max: 850, step: 5 });
  });

  it('steps a count by 1, never below 1', () => {
    expect(autoRange(6, '')).toEqual({ min: 3, max: 12, step: 1 });
    expect(autoRange(1, '')).toEqual({ min: 1, max: 5, step: 1 });
  });

  it('gives zero and negative values a range', () => {
    expect(autoRange(0, 'mm')).toEqual({ min: 0, max: 10, step: 0.1 });
    const r = autoRange(-42, 'mm');
    expect([r.min, r.max]).toEqual([-85, -20]);
  });
});

describe('sliderRange', () => {
  it('uses the saved range, with automatic values for blanks', () => {
    expect(sliderRange(42, 'mm', { min: 30, max: null })).toEqual({ min: 30, max: 85, step: 0.5 });
    expect(sliderRange(42, 'mm', { min: 50, max: 40 })).toEqual(autoRange(42, 'mm'));
  });
});

describe('snap', () => {
  it('snaps to the step without float noise', () => {
    expect(snap(35.26, { min: 20, max: 85, step: 0.5 })).toBe(35.5);
    expect(snap(3.4499, { min: 1.5, max: 7, step: 0.05 })).toBe(3.45);
  });
});
