import { describe, it, expect } from 'vitest';
import { mergeParameters } from './ParameterProposalCard';
import { parseValue, toParameters } from './ProjectParameters';
import { aliasFor } from './ProjectSketchDialog';

describe('project parameters', () => {
  it('reads numbers as numbers and keeps text', () => {
    expect(parseValue(' 30 ')).toBe(30);
    expect(parseValue('-2.5')).toBe(-2.5);
    expect(parseValue('M3')).toBe('M3');
  });

  it('drops unnamed rows and blank descriptions', () => {
    expect(toParameters([
      { name: ' arm_od ', value: '30', unit: 'mm', description: ' ' },
      { name: '', value: '1', unit: 'mm', description: '' },
    ])).toEqual([{ name: 'arm_od', value: 30, unit: 'mm' }]);
  });

  it('adds a proposed parameter, or changes the value of one of the same name', () => {
    const now = [{ name: 'pitch', value: 44, unit: 'mm' as const, description: 'brace hole pitch' }];
    const merged = mergeParameters(now, [
      { name: 'pitch', value: 45, unit: 'mm', description: '' },
      { name: 'plate_t', value: 2, unit: 'mm', description: 'carbon plate' },
    ]);
    expect(merged).toEqual([
      { name: 'pitch', value: 45, unit: 'mm', description: 'brace hole pitch' },
      { name: 'plate_t', value: 2, unit: 'mm', description: 'carbon plate' },
    ]);
  });
});

describe('aliasFor', () => {
  it('makes a script name from a sketch name', () => {
    expect(aliasFor('Frame holes')).toBe('frame_holes');
    expect(aliasFor('  4-arm (X) ')).toBe('s_4_arm_x');
  });
});
