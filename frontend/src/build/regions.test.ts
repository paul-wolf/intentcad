import { describe, expect, it } from 'vitest';
import { chosenRegions, lostPicks, pickedOutline, regionAt, regionsWords, togglePick, type SketchRegion } from './regions';
import type { XY } from './faceSketch';

// a region made of one rectangle (two triangles)
function rect(x0: number, y0: number, x1: number, y1: number, dflt: boolean): SketchRegion {
  const a: XY = [x0, y0], b: XY = [x1, y0], c: XY = [x1, y1], d: XY = [x0, y1];
  return { point: [(x0 + x1) / 2, (y0 + y1) / 2], default: dflt, area: (x1 - x0) * (y1 - y0),
           tris: [[a, b, c], [a, c, d]], edges: [[a, b, c, d, a]] };
}

// the square less a crossing rectangle (the notch), the overlap, and the tab outside
const NOTCH: SketchRegion[] = [rect(-15, -5, 15, 15, true), rect(-5, -15, 5, -5, true), rect(-5, -25, 5, -15, true)];
// a square with a hole in it: the ring is taken, the hole is not
const RING: SketchRegion[] = [rect(-15, -15, 15, 15, true), rect(-5, -5, 5, 5, false)];

describe('regions', () => {
  it('finds the region a point is in, edges included', () => {
    expect(regionAt(NOTCH, [0, 0])).toBe(0);
    expect(regionAt(NOTCH, [0, -20])).toBe(2);
    expect(regionAt(NOTCH, [15, 15])).toBe(0);
    expect(regionAt(NOTCH, [100, 0])).toBe(-1);
  });

  it('takes the default regions when nothing is picked', () => {
    expect(chosenRegions(NOTCH, null)).toEqual([true, true, true]);
    expect(chosenRegions(RING, undefined)).toEqual([true, false]);
    expect(chosenRegions(NOTCH, [[1, 2]])).toEqual([true, false, false]);
  });

  it('leaves out regions to make a notch, and back to the default is null', () => {
    const one = togglePick(NOTCH, null, 1);
    expect(one).toEqual([NOTCH[0]!.point, NOTCH[2]!.point]);
    const notch = togglePick(NOTCH, one, 2);
    expect(notch).toEqual([NOTCH[0]!.point]);
    expect(regionsWords(NOTCH, notch)).toBe('1 of 3 regions');
    expect(togglePick(NOTCH, togglePick(NOTCH, notch, 1), 2)).toBeNull();
    expect(regionsWords(NOTCH, null)).toBe('all 3 regions');
  });

  it('fills a hole when it is clicked', () => {
    expect(togglePick(RING, null, 1)).toEqual([RING[0]!.point, RING[1]!.point]);
  });

  it('outlines the regions taken, without the edges they share', () => {
    // the notch: just its own edges
    expect(pickedOutline(NOTCH, [[0, 0]])).toEqual(NOTCH[0]!.edges);
    // the two lower regions share the edge at y = -15 (one drawn each way round)
    const shared: SketchRegion[] = [
      { ...NOTCH[1]!, edges: [[[-5, -15], [5, -15]], [[5, -15], [5, -5]]] },
      { ...NOTCH[2]!, edges: [[[5, -15], [-5, -15]], [[-5, -25], [5, -25]]] },
    ];
    expect(pickedOutline(shared, null)).toEqual([[[5, -15], [5, -5]], [[-5, -25], [5, -25]]]);
  });

  it('keeps the last region', () => {
    const notch: XY[] = [[0, 0]];
    expect(togglePick(NOTCH, notch, 0)).toBe(notch);
  });

  it('says which picks are gone, and drops them on the next click', () => {
    const picked: XY[] = [[0, 0], [100, 0]];
    expect(lostPicks(NOTCH, picked)).toEqual([[100, 0]]);
    expect(lostPicks(NOTCH, null)).toEqual([]);
    expect(togglePick(NOTCH, picked, 2)).toEqual([NOTCH[0]!.point, NOTCH[2]!.point]);
  });
});
