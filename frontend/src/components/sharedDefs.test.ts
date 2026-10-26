import { describe, it, expect } from 'vitest';
import { mergeParameters } from './ParameterProposalCard';
import { affectsWords, parseValue, toParameters } from './ProjectParameters';
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

  it('keeps a slider range on numbers only', () => {
    expect(toParameters([
      { name: 'r', value: '42', unit: 'mm', description: '', min: 30, max: null, step: 0.5 },
      { name: 'size', value: 'M3', unit: '', description: '', min: 1 },
    ])).toEqual([{ name: 'r', value: 42, unit: 'mm', min: 30, step: 0.5 }, { name: 'size', value: 'M3', unit: '' }]);
  });

  it('says which parts a tried value affects', () => {
    const part = (id: string, name: string) => ({ id, name, via: ['script'] });
    const uses = { a: { sketches: [], parts: [part('1', 'Top plate'), part('2', 'Arm')] }, b: { sketches: [], parts: [part('1', 'Top plate')] } };
    expect(affectsWords(['a', 'b'], uses as never)).toBe('It affects 2 parts (Top plate, Arm).');
    expect(affectsWords(['c'], uses as never)).toBe('No part uses it yet.');
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

  it('keeps a slider range for a new number, and drops it when the value becomes text', () => {
    const now = [{ name: 'bolt', value: 3, unit: '' as const, min: 2, max: 8 }, { name: 'd', value: 30, unit: 'mm' as const, min: 20, max: 40 }];
    expect(mergeParameters(now, [{ name: 'bolt', value: 'M3', unit: '' }, { name: 'd', value: 32, unit: 'mm' }])).toEqual([
      { name: 'bolt', value: 'M3', unit: '' },
      { name: 'd', value: 32, unit: 'mm', min: 20, max: 40 },
    ]);
  });
});

describe('aliasFor', () => {
  it('makes a script name from a sketch name', () => {
    expect(aliasFor('Frame holes')).toBe('frame_holes');
    expect(aliasFor('  4-arm (X) ')).toBe('s_4_arm_x');
  });
});
