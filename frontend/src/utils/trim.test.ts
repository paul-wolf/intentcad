import { describe, it, expect } from 'vitest';
import type { CircleEntity, Constraint, DimensionEntity, Entity, LineEntity, Point, RectangleEntity } from '@/types/document';
import { trimSketch, hitTrim, trimPreview } from './trim';
import { arcFromBulge, arcMidpoint } from './arcGeometry';

let n = 0;
const newId = () => `new${++n}`;

function expectPoints(actual: Point[], expected: [number, number][]) {
  expect(actual).toHaveLength(expected.length);
  actual.forEach((p, i) => {
    expect(p.x).toBeCloseTo(expected[i]![0], 6);
    expect(p.y).toBeCloseTo(expected[i]![1], 6);
  });
}

const line = (id: string, pts: [number, number][], extra: Partial<LineEntity> = {}): LineEntity =>
  ({ id, type: 'line', points: pts.map(([x, y]) => ({ x, y })), ...extra });
const byId = <T extends Entity>(es: Entity[], id: string) => es.find((e) => e.id === id) as T;
const cById = (cs: Constraint[], id: string) => cs.find((c) => c.id === id) as Record<string, unknown> | undefined;

describe('trim', () => {
  it('cuts the piece of an open polyline between two crossings, leaving two', () => {
    const entities: Entity[] = [
      line('a', [[0, 0], [10, 0]]),
      line('v1', [[4, -5], [4, 5]]),
      line('v2', [[7, -5], [7, 5]]),
      line('other', [[10, 0], [10, 8]]),
      { id: 'len', type: 'dimension', targetEntityId: 'a', segmentIndex: 0, offset: 5 },
    ];
    const constraints: Constraint[] = [
      { id: 'h', type: 'horizontal', entityId: 'a', segmentIndex: 0 },
      { id: 'j', type: 'coincident', entityId: 'other', pointIndex: 0, targetEntityId: 'a', targetPointIndex: 1 },
    ];
    const out = trimSketch(entities, constraints, 'a', 0.55, newId)!;
    expect(out.pieces).toHaveLength(2);
    const [p0, p1] = out.pieces.map((id) => byId<LineEntity>(out.entities, id));
    expect(p0!.id).toBe('a');
    expectPoints(p0!.points, [[0, 0], [4, 0]]);
    expectPoints(p1!.points, [[7, 0], [10, 0]]);
    // the length no longer applies; both halves stay horizontal; the end point follows its piece
    expect(byId(out.entities, 'len')).toBeUndefined();
    expect(out.dropped).toBe(1);
    expect(out.constraints.filter((c) => c.type === 'horizontal').map((c) => (c as { entityId: string }).entityId).sort()).toEqual(['a', p1!.id].sort());
    expect(cById(out.constraints, 'j')).toMatchObject({ targetEntityId: p1!.id, targetPointIndex: 1 });
  });

  it('opens a closed polyline where a piece is cut out, renumbering what survives', () => {
    const entities: Entity[] = [
      line('sq', [[0, 0], [10, 0], [10, 10], [0, 10]], { closed: true }),
      line('cut', [[5, -5], [5, 15]]),
      { id: 'pt', type: 'point', position: { x: 10, y: 0 } },
      { id: 'pt2', type: 'point', position: { x: 0, y: 10 } },
    ];
    const constraints: Constraint[] = [
      { id: 'vl', type: 'vertical', entityId: 'sq', segmentIndex: 3 },
      { id: 'hb', type: 'horizontal', entityId: 'sq', segmentIndex: 0 },
      { id: 'on1', type: 'coincident', entityId: 'pt', pointIndex: 0, targetEntityId: 'sq', targetPointIndex: 1 },
      { id: 'on3', type: 'coincident', entityId: 'pt2', pointIndex: 0, targetEntityId: 'sq', targetPointIndex: 3 },
      { id: 'eq', type: 'equal', entityId: 'sq', segmentIndex: 0, targetEntityId: 'sq', targetSegmentIndex: 3 },
    ];
    // on the right side, between the crossings at (5,0) and (5,10)
    const out = trimSketch(entities, constraints, 'sq', 1.5, newId)!;
    const sq = byId<LineEntity>(out.entities, 'sq');
    expect(sq.closed).toBeFalsy();
    expectPoints(sq.points, [[5, 10], [0, 10], [0, 0], [5, 0]]);
    expect(cById(out.constraints, 'vl')).toMatchObject({ segmentIndex: 1 });
    expect(cById(out.constraints, 'hb')).toMatchObject({ segmentIndex: 2 }); // shorter, still horizontal
    expect(cById(out.constraints, 'on1')).toBeUndefined(); // its corner is gone
    expect(cById(out.constraints, 'on3')).toMatchObject({ targetPointIndex: 1 });
    expect(cById(out.constraints, 'eq')).toBeUndefined(); // bottom side got shorter
    expect(out.dropped).toBe(2);
  });

  it('turns a circle into the arc that is left', () => {
    const entities: Entity[] = [
      { id: 'c', type: 'circle', center: { x: 0, y: 0 }, radius: 5 } as CircleEntity,
      line('l', [[-10, 0], [10, 0]]),
      { id: 'p', type: 'point', position: { x: 3, y: -4 } },
      { id: 'dia', type: 'dimension', targetEntityId: 'c', segmentIndex: 0, offset: 3, expression: 'd' },
    ];
    const constraints: Constraint[] = [
      { id: 'onc', type: 'pointOnCurve', entityId: 'p', pointIndex: 0, targetEntityId: 'c', segmentIndex: -1 },
      { id: 'ctr', type: 'coincident', entityId: 'p', pointIndex: 0, targetEntityId: 'c', targetPointIndex: 0 },
    ];
    // click the top half: the bottom half stays
    const out = trimSketch(entities, constraints, 'c', 0.25, newId)!;
    const arc = byId<LineEntity>(out.entities, 'c');
    expect(arc.type).toBe('line');
    expectPoints(arc.points, [[-5, 0], [5, 0]]);
    const geo = arcFromBulge(arc.points[0]!, arc.points[1]!, arc.bulge![0]!);
    expect(geo.radius).toBeCloseTo(5, 9);
    expectPoints([arcMidpoint(arc.points[0]!, arc.points[1]!, arc.bulge![0]!)], [[0, -5]]);
    expect(byId<DimensionEntity>(out.entities, 'dia')).toMatchObject({ radius: true, segmentIndex: 0, expression: '(d) / 2' });
    expect(cById(out.constraints, 'onc')).toMatchObject({ segmentIndex: 0 });
    expect(cById(out.constraints, 'ctr')).toBeUndefined();
    expect(out.dropped).toBe(1);
  });

  it('cuts through an arc segment, keeping both ends as arcs on the same circle', () => {
    // bottom, a half-circle bulging right (centre (10,5), r 5), top
    const u = line('u', [[0, 0], [10, 0], [10, 10], [0, 10]], { bulge: [0, 1, 0] });
    const entities: Entity[] = [
      u,
      line('cut', [[12, -20], [12, 20]]),
      { id: 'rad', type: 'dimension', targetEntityId: 'u', segmentIndex: 1, offset: 2, radius: true },
      { id: 'top', type: 'dimension', targetEntityId: 'u', segmentIndex: 2, offset: 2 },
    ];
    const out = trimSketch(entities, [], 'u', 1.5, newId)!;
    const [a, b] = out.pieces.map((id) => byId<LineEntity>(out.entities, id));
    const h = Math.sqrt(21);
    expectPoints(a!.points, [[0, 0], [10, 0], [12, 5 - h]]);
    expectPoints(b!.points, [[12, 5 + h], [10, 10], [0, 10]]);
    for (const [p, q, bulge] of [[a!.points[1]!, a!.points[2]!, a!.bulge![1]!], [b!.points[0]!, b!.points[1]!, b!.bulge![0]!]] as const) {
      const g = arcFromBulge(p, q, bulge);
      expect(g.center.x).toBeCloseTo(10, 9);
      expect(g.center.y).toBeCloseTo(5, 9);
      expect(g.radius).toBeCloseTo(5, 9);
      // the kept arc is the part left of x = 12 (through the bottom / top)
      expect(arcMidpoint(p, q, bulge).x).toBeLessThan(12);
    }
    expect(a!.bulge![0]).toBe(0);
    expect(b!.bulge![1]).toBe(0);
    // a shorter arc keeps its radius; the untouched top side keeps its length
    expect(byId<DimensionEntity>(out.entities, 'rad')).toMatchObject({ targetEntityId: 'u', segmentIndex: 1 });
    expect(byId<DimensionEntity>(out.entities, 'top')).toMatchObject({ targetEntityId: b!.id, segmentIndex: 1 });
  });

  it('trims where two rectangles overlap', () => {
    const A: RectangleEntity = { id: 'A', type: 'rectangle', center: { x: 0, y: 0 }, width: 10, height: 10 };
    const B: RectangleEntity = { id: 'B', type: 'rectangle', center: { x: 5, y: 5 }, width: 10, height: 10 };
    const entities: Entity[] = [A, B, { id: 'w', type: 'dimension', targetEntityId: 'A', segmentIndex: 0, offset: 3 }];
    const constraints: Constraint[] = [{ id: 'k', type: 'fixed', entityId: 'A' }];
    const hit = hitTrim(entities, { x: 5, y: 4 }, 0.5)!;
    expect(hit.entityId).toBe('A');
    const preview = trimPreview(entities, hit)!.entity as LineEntity;
    expectPoints(preview.points, [[0, 5], [5, 5], [5, 0]]);
    const out = trimSketch(entities, constraints, hit.entityId, hit.s, newId)!;
    const a = byId<LineEntity>(out.entities, 'A');
    expect(a.type).toBe('line');
    expectPoints(a.points, [[5, 0], [5, -5], [-5, -5], [-5, 5], [0, 5]]);
    expect(byId(out.entities, 'w')).toBeUndefined(); // the top side got shorter
    expect(cById(out.constraints, 'k')).toBeDefined();
  });

  it('removes a whole curve nothing crosses, and what was on it', () => {
    const entities: Entity[] = [line('a', [[0, 0], [10, 0]]), line('b', [[0, 5], [10, 5]]), { id: 'd', type: 'dimension', targetEntityId: 'a', segmentIndex: 0, offset: 2 }];
    const constraints: Constraint[] = [{ id: 'p', type: 'parallel', entityId: 'a', segmentIndex: 0, targetEntityId: 'b', targetSegmentIndex: 0 }];
    const out = trimSketch(entities, constraints, 'a', 0.5, newId)!;
    expect(out.removedWhole).toBe(true);
    expect(out.entities.map((e) => e.id)).toEqual(['b']);
    expect(out.constraints).toEqual([]);
    expect(out.dropped).toBe(2);
  });

  it('cuts a polyline where it crosses itself, not at its own corners', () => {
    // a loop-de-loop: the last segment crosses the first at (5,0)
    const entities: Entity[] = [line('z', [[0, 0], [10, 0], [10, 5], [5, 5], [5, -5]])];
    const out = trimSketch(entities, [], 'z', 0.25, newId)!;
    expectPoints(byId<LineEntity>(out.entities, 'z').points, [[5, 0], [10, 0], [10, 5], [5, 5], [5, -5]]);
  });

  it("won't trim copies or reference geometry", () => {
    const entities: Entity[] = [line('c', [[0, 0], [1, 0]], { sourceId: 'x' }), line('r', [[0, 1], [1, 1]], { reference: true })];
    expect(trimSketch(entities, [], 'c', 0.5, newId)).toBeNull();
    expect(trimSketch(entities, [], 'r', 0.5, newId)).toBeNull();
    expect(hitTrim(entities, { x: 0.5, y: 0 }, 1)).toBeNull();
  });
});
