import { describe, it, expect } from 'vitest';
import { cornerAt, filletLine, filletSketch, setArcRadius } from './fillet';
import { arcFromBulge, arcMidpoint } from './arcGeometry';
import { measureDimension, dimensionEntities, resolveSketch } from './resolveSketch';
import type { Constraint, DimensionEntity, Entity, LineEntity, Point, RectangleEntity, Sketch } from '@/types/document';

const line = (points: [number, number][], closed = false, id = 'L'): LineEntity =>
  ({ id, type: 'line', points: points.map(([x, y]) => ({ x, y })), ...(closed ? { closed } : {}) });
const byId = <T extends Entity>(es: Entity[], id: string) => es.find((e) => e.id === id) as T;
let n = 0;
const expectPoints = (got: Point[], want: [number, number][]) => {
  expect(got).toHaveLength(want.length);
  got.forEach((p, i) => {
    expect(p.x).toBeCloseTo(want[i]![0], 9);
    expect(p.y).toBeCloseTo(want[i]![1], 9);
  });
};
const newId = () => `d${++n}`;

/** Distance from p to the infinite line through a, b. */
function lineDist(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  return Math.abs(dx * (p.y - a.y) - dy * (p.x - a.x)) / Math.hypot(dx, dy);
}

/** The arc on segment `seg` is tangent to its straight neighbours: its centre
 *  lies `r` from both their lines, and its ends are the feet of the
 *  perpendiculars from the centre. */
function expectTangent(e: LineEntity, seg: number, r: number) {
  const k = e.points.length;
  const p0 = e.points[(seg - 1 + k) % k]!, p1 = e.points[seg]!, p2 = e.points[(seg + 1) % k]!, p3 = e.points[(seg + 2) % k]!;
  const arc = arcFromBulge(p1, p2, e.bulge![seg]!);
  expect(arc.radius).toBeCloseTo(r, 9);
  expect(lineDist(arc.center, p0, p1)).toBeCloseTo(r, 9);
  expect(lineDist(arc.center, p2, p3)).toBeCloseTo(r, 9);
  // radius ⟂ neighbour at each end
  const dot = (c: Point, p: Point, q: Point) => ((p.x - c.x) * (q.x - p.x) + (p.y - c.y) * (q.y - p.y)) / (Math.hypot(p.x - c.x, p.y - c.y) * Math.hypot(q.x - p.x, q.y - p.y));
  expect(dot(arc.center, p1, p0)).toBeCloseTo(0, 9);
  expect(dot(arc.center, p2, p3)).toBeCloseTo(0, 9);
}

describe('corner fillet geometry', () => {
  it('rounds a right-angle corner with an arc tangent to both neighbours', () => {
    const f = filletLine(line([[0, 0], [40, 0], [40, 30]]), [1], 5)!;
    expectPoints(f.entity.points, [[0, 0], [35, 0], [40, 5], [40, 30]]);
    expect(f.entity.bulge!.map((b) => Math.abs(b))).toEqual([0, Math.tan(Math.PI / 8), 0]);
    expectTangent(f.entity, 1, 5);
    // the arc bows toward the corner it replaces, not away from it
    const mid = arcMidpoint(f.entity.points[1]!, f.entity.points[2]!, f.entity.bulge![1]!);
    expect(Math.hypot(mid.x - 40, mid.y)).toBeLessThan(Math.hypot(35 - 40, 5));
    expect(f.arcs).toEqual([{ vertex: 1, segment: 1, radius: 5, clamped: false }]);
  });

  it('is tangent at a sharp and a blunt corner, turning either way', () => {
    // 60° and 135° corners, clockwise and anticlockwise
    for (const pts of [
      [[0, 0], [30, 0], [15, 26]],
      [[15, 26], [30, 0], [0, 0]],
      [[0, 0], [30, 0], [50, 20]],
      [[50, 20], [30, 0], [0, 0]],
    ] as [number, number][][]) {
      const f = filletLine(line(pts), [1], 3)!;
      expect(f.arcs[0]!.clamped).toBe(false);
      expectTangent(f.entity, 1, 3);
      const mid = arcMidpoint(f.entity.points[1]!, f.entity.points[2]!, f.entity.bulge![1]!);
      const { center } = arcFromBulge(f.entity.points[1]!, f.entity.points[2]!, f.entity.bulge![1]!);
      expect(Math.hypot(mid.x - 30, mid.y)).toBeLessThan(Math.hypot(center.x - 30, center.y));
    }
  });

  it('clamps a radius too large for the neighbours to the largest that fits', () => {
    // 90° corner, shorter neighbour 10: the tangent point can go no further than its far end
    const f = filletLine(line([[0, 0], [40, 0], [40, 10]]), [1], 50)!;
    expect(f.arcs[0]!.clamped).toBe(true);
    expect(f.arcs[0]!.radius).toBeCloseTo(10, 9);
    // the arc runs into the short neighbour's far end, which stays where it was
    expectPoints(f.entity.points, [[0, 0], [30, 0], [40, 10]]);
    expect(f.pointMap(2)).toBe(2);
    expect(f.segmentMap(1)).toBeNull();
    const arc = arcFromBulge(f.entity.points[1]!, f.entity.points[2]!, f.entity.bulge![1]!);
    expect(arc.radius).toBeCloseTo(10, 9);
    expect(arc.center.x).toBeCloseTo(30, 9);
    expect(arc.center.y).toBeCloseTo(10, 9);
  });

  it('shares a segment half and half between two rounded corners', () => {
    // 10 × 16: the short sides limit the radius to 5, which uses them up
    const rect = line([[0, 0], [10, 0], [10, 16], [0, 16]], true);
    const f = filletLine(rect, [0, 1, 2, 3], 8)!;
    expect(f.arcs.every((a) => a.clamped && Math.abs(a.radius - 5) < 1e-9)).toBe(true);
    // a slot: four arcs and the two long sides, nothing of no length
    expect(f.entity.points).toHaveLength(6);
    expect(f.entity.bulge!.filter((b) => b === 0)).toHaveLength(2);
    expect([0, 1, 2, 3].map(f.segmentMap).filter((s) => s == null)).toHaveLength(2);
    for (let k = 0; k < 6; k++) {
      const p = f.entity.points[k]!, q = f.entity.points[(k + 1) % 6]!;
      expect(Math.hypot(q.x - p.x, q.y - p.y)).toBeGreaterThan(1);
    }
    for (const a of f.arcs) {
      const k = a.segment;
      const arc = arcFromBulge(f.entity.points[k]!, f.entity.points[(k + 1) % 6]!, f.entity.bulge![k]!);
      expect(arc.radius).toBeCloseTo(5, 9);
    }
  });

  it("rounds a closed outline's first vertex; the closing segment runs to the arc", () => {
    const sq = line([[0, 0], [20, 0], [20, 20], [0, 20]], true);
    const f = filletLine(sq, [0], 4)!;
    expectPoints(f.entity.points.slice(0, 2), [[0, 4], [4, 0]]);
    expect(f.entity.bulge).toHaveLength(5);
    expect(f.arcs[0]!.segment).toBe(0);
    expectTangent(f.entity, 0, 4);
    // old segments 0..3 → 1..4; the closing one (3) now ends at the arc
    expect([0, 1, 2, 3].map(f.segmentMap)).toEqual([1, 2, 3, 4]);
    expect([0, 1, 2, 3].map(f.pointMap)).toEqual([null, 2, 3, 4]);
  });

  it("clamped at a closed outline's first vertex, the arc closes the outline into the last vertex", () => {
    const quad = line([[0, 0], [40, 0], [40, 30], [0, 10]], true);
    const f = filletLine(quad, [0], 25)!;
    expect(f.arcs[0]).toMatchObject({ clamped: true, segment: 3 });
    expectPoints(f.entity.points, [[10, 0], [40, 0], [40, 30], [0, 10]]);
    expect(f.entity.bulge!.slice(0, 3)).toEqual([0, 0, 0]);
    expect([0, 1, 2, 3].map(f.pointMap)).toEqual([null, 1, 2, 3]);
    expect([0, 1, 2, 3].map(f.segmentMap)).toEqual([0, 1, 2, null]);
    const arc = arcFromBulge(f.entity.points[3]!, f.entity.points[0]!, f.entity.bulge![3]!);
    expect(arc.radius).toBeCloseTo(10, 9);
    expect(arc.center.x).toBeCloseTo(10, 9);
    expect(arc.center.y).toBeCloseTo(10, 9);
  });

  it('leaves alone what is not a corner: an open end, a straight run, next to an arc', () => {
    expect(cornerAt(line([[0, 0], [10, 0], [20, 0]]), 1)).toBeNull();
    expect(cornerAt(line([[0, 0], [10, 0], [10, 10]]), 0)).toBeNull();
    const withArc = { ...line([[0, 0], [10, 0], [10, 10]]), bulge: [0.3, 0] };
    expect(cornerAt(withArc, 1)).toBeNull();
    expect(filletLine(withArc, [1], 2)).toBeNull();
  });
});

describe('fillet in a sketch', () => {
  const sq = () => line([[0, 0], [20, 0], [20, 20], [0, 20]], true, 'sq');
  const lenDim = (id: string, seg: number): DimensionEntity => ({ id, type: 'dimension', targetEntityId: 'sq', segmentIndex: seg, offset: 5 });

  it('renumbers constraints and dimensions, drops those on the corner or on a length now shorter', () => {
    const entities: Entity[] = [
      sq(),
      { id: 'pt', type: 'point', position: { x: 20, y: 0 } },
      { id: 'pt2', type: 'point', position: { x: 0, y: 20 } },
      lenDim('len0', 0),                            // segment 0 gets shorter: dropped
      lenDim('len2', 2),                            // untouched: kept
      { id: 'pp', type: 'dimension', targetEntityId: 'sq', segmentIndex: 0, offset: 5, pointIndex: 0, pointIndex2: 2 },
    ];
    const constraints: Constraint[] = [
      { id: 'h2', type: 'horizontal', entityId: 'sq', segmentIndex: 2 },
      { id: 'on1', type: 'coincident', entityId: 'pt', pointIndex: 0, targetEntityId: 'sq', targetPointIndex: 1 }, // the corner: dropped
      { id: 'on3', type: 'coincident', entityId: 'pt2', pointIndex: 0, targetEntityId: 'sq', targetPointIndex: 3 },
      { id: 'perp', type: 'perpendicular', entityId: 'sq', segmentIndex: 0, targetEntityId: 'sq', targetSegmentIndex: 1 },
    ];
    const out = filletSketch(entities, constraints, [{ entityId: 'sq', index: 1 }], 4, newId)!;
    expect(out.rounded).toBe(1);
    expect(out.dropped).toBe(2);
    expect(out.clampedTo).toBeNull();
    const c = (id: string) => out.constraints.find((x) => x.id === id) as Record<string, unknown> | undefined;
    expect(c('h2')).toMatchObject({ segmentIndex: 3 });
    expect(c('on1')).toBeUndefined();
    expect(c('on3')).toMatchObject({ targetPointIndex: 4 });
    expect(c('perp')).toMatchObject({ segmentIndex: 0, targetSegmentIndex: 2 });
    expect(byId(out.entities, 'len0')).toBeUndefined();
    expect(byId<DimensionEntity>(out.entities, 'len2').segmentIndex).toBe(3);
    expect(byId<DimensionEntity>(out.entities, 'pp')).toMatchObject({ pointIndex: 0, pointIndex2: 3 });
    // the radius is a dimension on the new arc
    const rd = out.entities.find((e) => e.type === 'dimension' && e.radius) as DimensionEntity;
    expect(rd).toMatchObject({ targetEntityId: 'sq', segmentIndex: 1 });
    expect(measureDimension(rd, out.entities)).toBeCloseTo(4, 9);
  });

  it('refits the fillet when its radius dimension changes, and takes an expression (P)', () => {
    const out = filletSketch([sq()], [], [{ entityId: 'sq', index: 1 }], 4, newId)!;
    const rd = out.entities.find((e) => e.type === 'dimension' && e.radius) as DimensionEntity;
    const sketch: Sketch = { id: 's', name: 'S', visible: true, entities: out.entities, constraints: out.constraints };
    const set = dimensionEntities(sketch, rd.id, 7) as Entity[];
    const e = byId<LineEntity>(set, 'sq');
    expect(e.points[1]).toMatchObject({ x: expect.closeTo(13, 9), y: expect.closeTo(0, 9) });
    expect(e.points[2]).toMatchObject({ x: expect.closeTo(20, 9), y: expect.closeTo(7, 9) });
    expectTangent(e, 1, 7);

    const withExpr: Sketch = { ...sketch, entities: sketch.entities.map((x) => (x.id === rd.id ? { ...rd, expression: 'wall / 2' } : x)) };
    const r = resolveSketch(withExpr, { wall: 3 });
    expect(r.changed).toBe(true);
    expectTangent(byId<LineEntity>(r.sketch.entities, 'sq'), 1, 1.5);
    expect(measureDimension(rd, r.sketch.entities)).toBeCloseTo(1.5, 9);
  });

  it('keeps the ends of an arc that is not a fillet, changing only its bulge', () => {
    const arc: LineEntity = { ...line([[0, 0], [10, 0]]), bulge: [0.5] };
    const e = setArcRadius(arc, 0, 8)!;
    expect(e.points).toEqual(arc.points);
    expect(arcFromBulge(e.points[0]!, e.points[1]!, e.bulge![0]!).radius).toBeCloseTo(8, 9);
    // no less than a half circle across its ends
    const half = setArcRadius(arc, 0, 1)!;
    expect(arcFromBulge(half.points[0]!, half.points[1]!, half.bulge![0]!).radius).toBeCloseTo(5, 9);
  });

  it('rounds a rectangle with its corner radius, clamped to half its shorter side, one dimension for all four', () => {
    const rect: RectangleEntity = { id: 'r', type: 'rectangle', center: { x: 0, y: 0 }, width: 30, height: 12 };
    const out = filletSketch([rect], [], [{ entityId: 'r', index: 1 }, { entityId: 'r', index: 2 }], 10, newId)!;
    expect(byId<RectangleEntity>(out.entities, 'r').cornerRadius).toBe(6);
    expect(out.clampedTo).toBe(6);
    const dims = out.entities.filter((e) => e.type === 'dimension') as DimensionEntity[];
    expect(dims).toHaveLength(1);
    const sketch: Sketch = { id: 's', name: 'S', visible: true, entities: out.entities, constraints: [] };
    const set = dimensionEntities(sketch, dims[0]!.id, 2) as Entity[];
    expect(byId<RectangleEntity>(set, 'r').cornerRadius).toBe(2);
    expect(measureDimension(dims[0]!, set)).toBeCloseTo(2, 9);
  });

  it('skips copies and reference geometry', () => {
    const copy = { ...sq(), id: 'c', sourceId: 'sq', sourceTransform: { type: 'mirror' } } as unknown as LineEntity;
    expect(filletSketch([copy], [], [{ entityId: 'c', index: 1 }], 2, newId)).toBeNull();
  });
});
