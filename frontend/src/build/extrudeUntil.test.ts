import { describe, expect, it } from 'vitest';
import { untilPieceScript } from './extrudeUntil';
import { extrudeSummary, type ExtrudeValues } from '../components/OpDialogs';

const CODE = 'P = dict(d=4)\npart = Box(10, 10, 10)\npart -= extrude(sketch("S"), until="next", dir=-1)\npart += Box(1, 1, 1)\n';

describe('untilPieceScript', () => {
  it('keeps the lines before, the line, and what it removed', () => {
    expect(untilPieceScript(CODE, 3, 'cut')).toBe(
      'P = dict(d=4)\npart = Box(10, 10, 10)\n_before = part\npart -= extrude(sketch("S"), until="next", dir=-1)\n'
      + 'part = _before - part\n');
  });
  it('finds a just-appended line and joins the other way round', () => {
    const code = 'part = Box(10, 10, 10)\npart += extrude(sketch("S"), until="next")\n\n';
    expect(untilPieceScript(code, null, 'join')).toBe(
      'part = Box(10, 10, 10)\n_before = part\npart += extrude(sketch("S"), until="next")\npart = part - _before\n');
  });
  it('is null for a line that is not an until extrude', () => {
    expect(untilPieceScript(CODE, 4, 'join')).toBeNull();
    expect(untilPieceScript('part -= extrude(sketch("S"), amount=-3)\n', 1, 'cut')).toBeNull();
  });
});

describe('extrudeSummary', () => {
  const v = (o: Partial<ExtrudeValues>): ExtrudeValues => ({
    sketch: 'S', op: 'join', depth: 5, through: false, flip: false, both: false, datum: false,
    extent: 'distance', face: null, offset: 0, ...o,
  } as ExtrudeValues);
  it('says where an until extrude stops', () => {
    expect(extrudeSummary(v({ extent: 'next', op: 'cut' }), 0)).toMatch(/until it breaks/);
    expect(extrudeSummary(v({ extent: 'next' }), 0)).toMatch(/meets/);
    const face = { kind: 'plane', hint: 'slanted wall' } as unknown as ExtrudeValues['face'];
    expect(extrudeSummary(v({ extent: 'face', face }), 0.2)).toBe('Grows “S” up to the slanted wall, 0.2 mm past it.');
    expect(extrudeSummary(v({ extent: 'face', face }), -1)).toMatch(/1 mm short of it/);
  });
});
