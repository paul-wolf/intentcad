import { describe, it, expect } from 'vitest';
import {
  EDGE_PX, NOTHING, choosePick, clickSelect, edgeHandle, edgeLoop, edgeOfRef, edgesNear, faceEdges, measureEdges,
  nextFilter, selectEdges, tangentChain, type EdgeInfo, type EdgeRefLike, type ScreenEdge, type Vec3,
} from './edgePick';
import { FILTER_KEY } from './edgePick';
import { OPERATIONS, RESERVED_KEYS } from './operations';

// a horizontal edge across the screen at y = 100, and a vertical one at x = 300
const SCREEN: ScreenEdge[] = [
  { index: 0, pts: [[0, 100], [200, 100]] },
  { index: 1, pts: [[300, 0], [300, 200]] },
];
const all = () => true;

describe('picking', () => {
  it('an edge within the threshold beats the face under the cursor', () => {
    const near = edgesNear(SCREEN, 50, 104);
    expect(near.map((c) => c.index)).toEqual([0]);
    expect(near[0]!.dist).toBeCloseTo(4);
    expect(near[0]!.t).toBeCloseTo(0.25);
    expect(choosePick(near, 7, 'both', all)).toEqual({ edge: 0 });
  });

  it('outside the threshold the face wins', () => {
    const near = edgesNear(SCREEN, 50, 100 + EDGE_PX + 1);
    expect(near).toEqual([]);
    expect(choosePick(near, 7, 'both', all)).toEqual({ face: 7 });
    expect(choosePick(near, null, 'both', all)).toBeNull();
  });

  it('the nearer of two edges wins', () => {
    const near = edgesNear([...SCREEN, { index: 2, pts: [[0, 103], [200, 103]] }], 50, 104);
    expect(near.map((c) => c.index)).toEqual([2, 0]);
    expect(choosePick(near, 7, 'both', all)).toEqual({ edge: 2 });
  });

  it("hidden edges aren't pickable, except selected ones (they show through the part)", () => {
    const near = edgesNear(SCREEN, 50, 103);
    const hidden = () => false;
    expect(choosePick(near, 7, 'both', hidden)).toEqual({ face: 7 });
    expect(choosePick(near, 7, 'both', hidden, new Set([0]))).toEqual({ edge: 0 });
    // a hidden edge in front of a visible one: the visible one
    const two = edgesNear([...SCREEN, { index: 2, pts: [[0, 102], [200, 102]] }], 50, 103);
    expect(choosePick(two, 7, 'both', (c) => c.index === 0)).toEqual({ edge: 0 });
  });

  it('the filter: faces only, edges only', () => {
    const near = edgesNear(SCREEN, 50, 104);
    expect(choosePick(near, 7, 'faces', all)).toEqual({ face: 7 });
    expect(choosePick([], 7, 'edges', all)).toBeNull();
    expect(choosePick(near, 7, 'edges', all)).toEqual({ edge: 0 });
    expect(nextFilter('both')).toBe('faces');
    expect(nextFilter('faces')).toBe('edges');
    expect(nextFilter('edges')).toBe('both');
  });

  it("the filter's key is free in the part editor", () => {
    expect(Object.keys(RESERVED_KEYS)).toContain(FILTER_KEY);
    expect(OPERATIONS.some((o) => o.shortcut?.split(' ')[0] === FILTER_KEY)).toBe(false);
  });
});

describe('the selection', () => {
  it('click replaces, Shift-click adds or removes, empty space clears', () => {
    let s = clickSelect(NOTHING, { face: 3 }, false);
    expect(s).toEqual({ faces: [3], edges: [] });
    s = clickSelect(s, { edge: 5 }, true);
    expect(s).toEqual({ faces: [3], edges: [5] });
    s = clickSelect(s, { face: 4 }, true);
    expect(s).toEqual({ faces: [3, 4], edges: [5] });
    s = clickSelect(s, { face: 3 }, true);
    expect(s).toEqual({ faces: [4], edges: [5] });
    expect(clickSelect(s, null, true)).toBe(s);
    expect(clickSelect(s, { edge: 9 }, false)).toEqual({ faces: [], edges: [9] });
    expect(clickSelect(s, null, false)).toEqual(NOTHING);
    expect(selectEdges(s, [5, 6, 7], true)).toEqual({ faces: [4], edges: [5, 6, 7] });
    expect(selectEdges(s, [6, 7], false)).toEqual({ faces: [], edges: [6, 7] });
  });
});

// A 60 × 40 plate, top face 0 (z = 5), sides 1–4, a Ø6 hole (face 5) through it.
const ring = (c: Vec3, r: number, n = 33): Vec3[] =>
  Array.from({ length: n }, (_, k) => [c[0] + r * Math.cos((2 * Math.PI * k) / (n - 1)),
                                       c[1] + r * Math.sin((2 * Math.PI * k) / (n - 1)), c[2]] as Vec3);
const line = (index: number, a: Vec3, b: Vec3, faces: number[]): EdgeInfo => ({ index, kind: 'line', faceIndices: faces, polyline: [a, b] });
const PLATE: EdgeInfo[] = [
  line(0, [-30, -20, 5], [30, -20, 5], [0, 1]),
  line(1, [30, -20, 5], [30, 20, 5], [0, 2]),
  line(2, [30, 20, 5], [-30, 20, 5], [0, 3]),
  line(3, [-30, 20, 5], [-30, -20, 5], [0, 4]),
  { index: 4, kind: 'circle', faceIndices: [0, 5], polyline: ring([10, 0, 5], 3),
    ref: { radius: 3, center: [10, 0, 5], length: 6 * Math.PI } },
  line(5, [30, -20, 0], [30, -20, 5], [1, 2]),
  { index: 6, kind: 'line', faceIndices: [5, 5], polyline: [[13, 0, 0], [13, 0, 5]] },   // the hole's seam
];

describe('loops', () => {
  it("double-click on an edge of a face with a hole: the outer loop only", () => {
    expect(edgeLoop(PLATE, 0, 0)).toEqual([0, 1, 2, 3]);
    expect(edgeLoop(PLATE, 2, 0)).toEqual([0, 1, 2, 3]);
    // the hole's rim is a loop of its own
    expect(edgeLoop(PLATE, 4, 0)).toEqual([4]);
    // the same edge, with the cursor over the front face: that face's loop
    expect(edgeLoop(PLATE, 0, 1)).toEqual([0, 5]);
  });

  it('"Edges of this face": every loop, but no seam', () => {
    expect(faceEdges(PLATE, 0)).toEqual([0, 1, 2, 3, 4]);
    expect(faceEdges(PLATE, 5)).toEqual([4]);
  });

  it('the tangent chain runs through fillet arcs but stops at corners', () => {
    // an L of two lines joined by a quarter arc (a filleted corner), then a sharp turn
    const arc = Array.from({ length: 9 }, (_, k): Vec3 => {
      const a = -Math.PI / 2 + (k / 8) * (Math.PI / 2);
      return [20 + 2 * Math.cos(a), 2 + 2 * Math.sin(a), 0];
    });
    const chain: EdgeInfo[] = [
      line(0, [0, 0, 0], [20, 0, 0], [0, 1]),
      { index: 1, kind: 'circle', faceIndices: [0, 2], polyline: arc },
      line(2, [22, 2, 0], [22, 30, 0], [0, 3]),
      line(3, [22, 30, 0], [0, 30, 0], [0, 4]),      // a sharp corner: not in the chain
      line(4, [0, 0, 0], [0, 0, -5], [1, 4]),       // across, at the start: not either
    ];
    expect(tangentChain(chain, 0)).toEqual([0, 1, 2]);
    expect(tangentChain(chain, 2)).toEqual([0, 1, 2]);
    expect(tangentChain(chain, 3)).toEqual([3]);
  });
});

describe('the edge readout', () => {
  it('one edge: its length, or a circle’s diameter', () => {
    expect(measureEdges([PLATE[0]!])).toEqual({ main: '60.00 mm', sub: 'length' });
    expect(measureEdges([PLATE[4]!])!.main).toBe('⌀ 6.00 mm');
    const arc: EdgeInfo = { ...PLATE[4]!, polyline: PLATE[4]!.polyline.slice(0, 9), ref: { radius: 3, length: 4.71 } };
    expect(measureEdges([arc])!.main).toBe('R 3.00 mm');
  });

  it('two edges: how far apart (parallel) or the angle between them', () => {
    expect(measureEdges([PLATE[0]!, PLATE[2]!])).toEqual({ main: '40.00 mm', sub: 'parallel, apart' });
    expect(measureEdges([PLATE[0]!, PLATE[1]!])).toEqual({ main: '90.0°', sub: 'angle between them' });
    const other = { ...PLATE[4]!, index: 9, ref: { radius: 3, center: [-10, 0, 5] as Vec3 } };
    expect(measureEdges([PLATE[4]!, other])!.main).toBe('20.00 mm');
    expect(measureEdges([PLATE[4]!, other])!.sub).toMatch(/^centre to centre/);
  });

  it('more: the total length', () => {
    expect(measureEdges(PLATE.slice(0, 4))).toEqual({ main: '200.00 mm', sub: '4 edges, total length' });
  });
});

describe('the edges a fillet / chamfer line names', () => {
  const top = { normal: [0, 0, 1] as Vec3 }, front = { normal: [0, -1, 0] as Vec3 };
  const topFront: EdgeRefLike = { kind: 'line', midpoint: [0, -20, 5], length: 60, faces: [top, front], hint: 'top-front edge' };
  const edges = [
    { index: 0, ref: { ...topFront } },
    { index: 1, ref: { ...topFront, midpoint: [0, 20, 5] as Vec3, hint: 'top-back edge' } },
    { index: 2, ref: null },
  ];

  it('finds the edge of the shown part, or says it isn’t there', () => {
    expect(edgeOfRef(edges, topFront)).toBe(0);
    expect(edgeOfRef(edges, { ...topFront, midpoint: [0, 20, 5] })).toBe(1);
    // filleted already: the part shows the fillet's faces, not this edge
    expect(edgeOfRef(edges, { ...topFront, midpoint: [0, -19, 4] })).toBeNull();
    expect(edgeOfRef(edges, { ...topFront, kind: 'circle' })).toBeNull();
  });

  it('the handle sits on the midpoint and drags into the part, between the two faces', () => {
    const h = edgeHandle(topFront);
    expect(h.at).toEqual([0, -20, 5]);
    expect(h.dir[0]).toBeCloseTo(0);
    expect(h.dir[1]).toBeCloseTo(Math.SQRT1_2);
    expect(h.dir[2]).toBeCloseTo(-Math.SQRT1_2);
    // a hole's rim: away from the flat face (the cylinder's "normal" is its axis)
    const rim = edgeHandle({ kind: 'circle', midpoint: [13, 0, 5], length: 18.85,
                             faces: [top, { normal: [0, 0, 1], kind: 'cylinder' }] });
    expect(rim.dir).toEqual([0, 0, -1]);
  });
});
