import { describe, expect, it } from 'vitest';
import type { ProjectParameter } from '@/types/project';
import { parsePastedParameters, previewParameters, previewWords } from './pasteParameters';

describe('parsePastedParameters', () => {
  it('reads "name value [unit]" lines in the usual spellings', () => {
    const { items, errors } = parsePastedParameters([
      'prop_d 406.4 mm',
      'tube_od = 30mm',
      'tilt: 12 deg',
      'yaw\t45°',
      'arm_count 6',
      'bolt M3',
      'plate_t 2 mm carbon fibre, critical',
      'gap -.5 mm',
    ].join('\n'));
    expect(errors).toEqual([]);
    expect(items).toEqual([
      { name: 'prop_d', value: 406.4, unit: 'mm' },
      { name: 'tube_od', value: 30, unit: 'mm' },
      { name: 'tilt', value: 12, unit: 'deg' },
      { name: 'yaw', value: 45, unit: 'deg' },
      { name: 'arm_count', value: 6, unit: null },
      { name: 'bolt', value: 'M3', unit: '' },
      { name: 'plate_t', value: 2, unit: 'mm', description: 'carbon fibre, critical' },
      { name: 'gap', value: -0.5, unit: 'mm' },
    ]);
  });

  it('skips blank and comment lines, and splits on ";"', () => {
    const { items, errors } = parsePastedParameters('# frame\n\n  a 1 mm; b 2 mm\n// done\n');
    expect(errors).toEqual([]);
    expect(items.map((p) => p.name)).toEqual(['a', 'b']);
  });

  it('says which lines it cannot read, and why', () => {
    const { items, errors } = parsePastedParameters('ok 1 mm\n2nd 3 mm\nlonely\nw 30 cm\nok 2 mm');
    expect(items).toEqual([{ name: 'ok', value: 1, unit: 'mm' }]);
    expect(errors.map((e) => [e.line, e.why])).toEqual([
      [2, '"2nd" isn\'t a usable name: use letters, digits and _, not starting with a digit'],
      [3, 'it has a name but no value'],
      [4, '"cm" isn\'t a unit here: use mm or deg (or none for a count)'],
      [5, '"ok" is also on line 1'],
    ]);
  });
});

describe('previewParameters', () => {
  const now: ProjectParameter[] = [
    { name: 'prop_d', value: 406.4, unit: 'mm' },
    { name: 'thick', value: 2, unit: 'mm', description: 'plate' },
    { name: 'arm_count', value: 6, unit: '' },
  ];

  it('tells new, changed and unchanged apart', () => {
    const { items } = parsePastedParameters('prop_d 406.4 mm\nthick 3 mm\narm_count 8\nhole_d 3.4 mm');
    const p = previewParameters(now, items);
    expect(p.map((x) => [x.item.name, x.status])).toEqual([
      ['prop_d', 'unchanged'], ['thick', 'changed'], ['arm_count', 'changed'], ['hole_d', 'new']]);
    expect(p[1]!.was).toEqual(now[1]);
    expect(previewWords(p)).toBe('1 new, 2 changed, 1 unchanged');
  });

  it('keeps the unit of the parameter it replaces when the line has none', () => {
    const { items } = parsePastedParameters('prop_d 406.4\nnew_count 4');
    const p = previewParameters(now, items);
    expect(p[0]).toMatchObject({ status: 'unchanged', item: { unit: 'mm' } });
    expect(p[1]).toMatchObject({ status: 'new', item: { unit: '' } });
  });

  it('counts a new unit or description as a change, but not a missing description', () => {
    const { items } = parsePastedParameters('thick 2 deg\nprop_d 406.4 mm the big ones');
    expect(previewParameters(now, items).map((x) => x.status)).toEqual(['changed', 'changed']);
    expect(previewParameters(now, [{ name: 'thick', value: 2, unit: 'mm' }])[0]!.status).toBe('unchanged');
  });
});
