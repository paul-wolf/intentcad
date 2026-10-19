import { describe, it, expect } from 'vitest';
import type { HolePresets } from '@/api/client';
import type { Sketch } from '@/types/document';
import { sketchHolePoints, sketchProfile } from '@/build/faceSketch';
import { holesPayload, holeValuesOf, newHoleValues, placeKey } from './OpDialogs';

// a slice of hole_presets.table()
const P: HolePresets = {
  sizes: ['M2.5', 'M3'],
  kinds: ['clearance', 'tapped', 'insert', 'counterbore', 'countersink'],
  presets: {
    clearance: { M3: { d: 3.4, depth: null, standoff_d: 7.4 } },
    clearance_close: { M3: { d: 3.2, depth: null, standoff_d: 7.2 } },
    insert: {
      M3: { d: 4.0, depth: 5.7, standoff_d: 8.0, insert_d: 4.0, insert_l: 5.7 },
      'M2.5': { d: 3.6, depth: 5.0, standoff_d: 7.6 },
    },
    counterbore: { M3: { d: 3.4, depth: null, standoff_d: 9.5, cbore_d: 6.5, cbore_depth: 3.3 } },
  },
  standoff: { fillet: 1, height: 6 },
};
const AT = { sketch: 'Standoffs' };

describe('holesPayload', () => {
  it('sends a through clearance hole with no overrides', () => {
    expect(holesPayload(newHoleValues(AT, P), P)).toEqual({
      at: AT, kind: 'clearance', size: 'M3', fit: 'normal', depth: null, sizes: {}, standoff: null,
    });
  });

  it('takes a blind kind\'s depth and the standoff diameter from the preset', () => {
    const v = { ...newHoleValues(AT, P, true), kind: 'insert' as const, through: false };
    expect(holesPayload(v, P)).toMatchObject({ depth: 5.7, standoff: { h: 6, d: 8.0, fillet: 1 } });
  });

  it('drops a size the kind does not use', () => {
    const v = { ...newHoleValues(AT, P), kind: 'clearance' as const, sizes: { d: 3.5, cbore_d: 7 } };
    expect(holesPayload(v, P).sizes).toEqual({ d: 3.5 });
  });
});

describe('holeValuesOf', () => {
  it('reads a value equal to its preset as the preset, so a size change moves it', () => {
    const v = holeValuesOf({ at: AT, kind: 'insert', size: 'M3', depth: 5.7, sizes: {},
                             standoff: { h: 6, d: 8.0, fillet: 1 } }, P);
    expect(v).toMatchObject({ kind: 'insert', through: false, depth: null, standoff: true, standoffD: null });
    expect(holesPayload({ ...v, size: 'M2.5' }, P)).toMatchObject({ depth: 5.0, standoff: { d: 7.6 } });
  });

  it('keeps a changed value', () => {
    const v = holeValuesOf({ at: AT, kind: 'counterbore', size: 'M3', depth: null, sizes: { cbore_d: 7 } }, P);
    expect(v).toMatchObject({ through: true, sizes: { cbore_d: 7 }, standoff: false });
  });
});

describe('hole places', () => {
  const sk: Sketch = {
    id: 'sk', name: 'Standoffs', visible: true, constraints: [],
    plane: { origin: [0, 0, 2], normal: [0, 0, 1], xAxis: [1, 0, 0] },
    entities: [
      { id: 'p1', type: 'point', position: { x: 10, y: 5 } },
      { id: 'p2', type: 'point', position: { x: 70, y: 5 } },
      { id: 'c1', type: 'circle', center: { x: 10, y: 5 }, radius: 2 },        // same place as p1
      { id: 'c2', type: 'circle', center: { x: 40, y: 30 }, radius: 3 },
      { id: 'c3', type: 'circle', center: { x: 0, y: 0 }, radius: 50, construction: true },
    ],
  };

  it('are the points and circle centres, each once, without construction', () => {
    expect(sketchHolePoints(sk)).toEqual([{ x: 10, y: 5 }, { x: 70, y: 5 }, { x: 40, y: 30 }]);
  });

  it('travel with the profile', () => {
    expect(sketchProfile(sk)?.points).toEqual([[10, 5], [70, 5]]);
  });

  it('have distinct keys', () => {
    const face = { center: [0, 0, 2], normal: [0, 0, 1], area: 1 } as never;
    expect(placeKey(AT)).not.toEqual(placeKey({ face }));
  });
});
