import { describe, expect, it } from 'vitest';
import { argOpPayload, type ArgOpValues } from './OpDialogs';

const ROUND: ArgOpValues = {
  op: 'auto_round',
  values: { convex: 1, concave: 2, keep_bed: true, protect_holes: true },
  keep: [{ src: 'face_ref({"hint": "top face"})', ref: undefined, item: 0 }, { src: '">Z"', item: 1 }],
  params: { convex: 'round_r' }, exprs: { concave: 'P["round_r"] * 2' }, make: [],
};

describe('argOpPayload', () => {
  it('sends only what changed, kept items as read', () => {
    const v = { ...ROUND, values: { ...ROUND.values, convex: 1.5, keep_bed: false }, keep: [ROUND.keep![1]!] };
    expect(argOpPayload(v, ROUND)).toEqual({ values: { convex: 1.5, keep_bed: false }, keep: [{ src: '">Z"' }], make_param: [] });
  });

  it('adds a picked face as a ref, and leaves expressions alone', () => {
    const ref = { hint: 'side face', kind: 'plane', center: [1, 2, 3], normal: [1, 0, 0], area: 4 } as never;
    const v = { ...ROUND, values: { ...ROUND.values, concave: 9 }, keep: [...ROUND.keep!, { ref }] };
    const p = argOpPayload(v, ROUND);
    expect(p.values).toEqual({});
    expect(p.keep).toHaveLength(3);
    expect(p.keep![2]).toEqual({ ref });
  });

  it('moves a literal into P, even unchanged; never one already there', () => {
    const truss: ArgOpValues = { op: 'truss_windows', values: { rim: 4, rib: 3, corner_r: 2, keep_clear: 3, pattern: 'fan' },
                                 keep: null, params: { rib: 'truss_rib' }, exprs: {}, make: ['rim', 'rib'] };
    expect(argOpPayload(truss, { ...truss, make: [] })).toEqual({ values: { rim: 4, rib: 3 }, keep: null, make_param: ['rim'] });
  });
});
