import { describe, it, expect } from 'vitest';
import type { CircleEntity, DimensionEntity, Entity, LineEntity, Point, RectangleEntity } from '@/types/document';
import { addOffset, canOffset, chainPath, connectedChain, offsetEntity, offsetPath, unlinkOffset } from './offset';
import { propagateDerived } from './propagate';
import { dimensionEntities, measureDimension, resolveSketch } from './resolveSketch';
import { rectanglePath } from './rectPath';
import { arcFromBulge } from './arcGeometry';

let n = 0;
const newId = () => `o${++n}`;

function expectPoints(actual: Point[], expected: [number, number][]) {
  expect(actual).toHaveLength(expected.length);
  actual.forEach((p, i) => {
    expect(p.x).toBeCloseTo(expected[i]![0], 6);
    expect(p.y).toBeCloseTo(expected[i]![1], 6);
  });
}

const line = (id: string, pts: [number, number][], extra: Partial<LineEntity> = {}): LineEntity =>
  ({ id, type: 'line', points: pts.map(([x, y]) => ({ x, y })), ...extra });
const lookupIn = (es: Entity[]) => (id: string) => es.find((e) => e.id === id);
const t = (distance: number, side: 1 | -1, join: 'arc' | 'miter' = 'arc') => ({ type: 'offset' as const, distance, side, join });

describe('offset', () => {
  it('grows and shrinks a rectangle with rounded corners', () => {
    const rect: RectangleEntity = { id: 'r', type: 'rectangle', center: { x: 0, y: 0 }, width: 20, height: 10, cornerRadius: 2 };
    const out = offsetEntity(['r'], t(1, 1), 'o', lookupIn([rect])) as RectangleEntity;
    expect(out).toMatchObject({ type: 'rectangle', width: 22, height: 12, cornerRadius: 3, sourceId: 'r' });
    expect(out.sourceTransform).toEqual(t(1, 1));
    expect(offsetEntity(['r'], t(1, -1), 'o', lookupIn([rect]))).toMatchObject({ width: 18, height: 8, cornerRadius: 1 });
    // inside by more than the corner radius: sharp corners
    const sharp = offsetEntity(['r'], t(3, -1), 'o', lookupIn([rect])) as RectangleEntity;
    expect(sharp).toMatchObject({ width: 14, height: 4 });
    expect(sharp.cornerRadius).toBeUndefined();
    expect(offsetEntity(['r'], t(5, -1), 'o', lookupIn([rect]))).toBeNull();
    // a square-cornered rectangle grows rounded corners, or keeps them sharp as miters
    const sq: RectangleEntity = { id: 's', type: 'rectangle', center: { x: 0, y: 0 }, width: 10, height: 10 };
    expect(offsetEntity(['s'], t(2, 1), 'o', lookupIn([sq]))).toMatchObject({ width: 14, cornerRadius: 2 });
    expect((offsetEntity(['s'], t(2, 1, 'miter'), 'o', lookupIn([sq])) as RectangleEntity).cornerRadius).toBeUndefined();
  });

  it('offsets a rounded outline drawn as a polyline: arcs stay tangent, on the same centres', () => {
    const rect: RectangleEntity = { id: 'r', type: 'rectangle', center: { x: 0, y: 0 }, width: 20, height: 10, cornerRadius: 2 };
    const { points, bulge } = rectanglePath(rect);
    const outline = line('l', points.map((p) => [p.x, p.y]), { closed: true, bulge });
    const grown = offsetEntity(['l'], t(1, 1), 'o', lookupIn([outline])) as LineEntity;
    const want = rectanglePath({ ...rect, width: 22, height: 12, cornerRadius: 3 });
    expectPoints(grown.points, want.points.map((p) => [p.x, p.y]));
    grown.bulge!.forEach((b, i) => expect(b).toBeCloseTo(want.bulge[i]!, 9));
    expect(grown.closed).toBe(true);
    // inside by more than the radius: the arcs vanish and the sides meet at sharp corners
    const shrunk = offsetEntity(['l'], t(3, -1), 'o', lookupIn([outline])) as LineEntity;
    expect(shrunk.bulge).toBeUndefined();
    const xs = shrunk.points.map((p) => p.x), ys = shrunk.points.map((p) => p.y);
    expect(shrunk.points).toHaveLength(4);
    expect(Math.min(...xs)).toBeCloseTo(-7, 9);
    expect(Math.max(...xs)).toBeCloseTo(7, 9);
    expect(Math.min(...ys)).toBeCloseTo(-2, 9);
    expect(Math.max(...ys)).toBeCloseTo(2, 9);
  });

  it('offsets a circle out and in, and refuses one that would vanish', () => {
    const c: CircleEntity = { id: 'c', type: 'circle', center: { x: 3, y: 4 }, radius: 5 };
    expect(offsetEntity(['c'], t(2, 1), 'o', lookupIn([c]))).toMatchObject({ type: 'circle', center: { x: 3, y: 4 }, radius: 7 });
    expect(offsetEntity(['c'], t(2, -1), 'o', lookupIn([c]))).toMatchObject({ radius: 3 });
    expect(offsetEntity(['c'], t(5, -1), 'o', lookupIn([c]))).toBeNull();
  });

  it('offsets an open chain of separate lines: cut back inside the turn, rounded or mitred outside', () => {
    // the second line drawn the other way round: the chain still follows the first
    const es: Entity[] = [line('a', [[0, 0], [10, 0]]), line('b', [[10, 10], [10, 0]])];
    const inside = offsetEntity(['a', 'b'], t(1, 1), 'o', lookupIn(es)) as LineEntity;
    expectPoints(inside.points, [[0, 1], [9, 1], [9, 10]]);
    expect(inside.closed).toBeUndefined();
    expect(inside.sourceTransform).toMatchObject({ chain: ['a', 'b'] });
    const round = offsetEntity(['a', 'b'], t(1, -1), 'o', lookupIn(es)) as LineEntity;
    expectPoints(round.points, [[0, -1], [10, -1], [11, 0], [11, 10]]);
    expect(round.bulge).toEqual([0, expect.any(Number), 0]);
    const arc = arcFromBulge(round.points[1]!, round.points[2]!, round.bulge![1]!);
    expect(arc.center.x).toBeCloseTo(10, 9);
    expect(arc.center.y).toBeCloseTo(0, 9);
    expect(arc.radius).toBeCloseTo(1, 9);
    const miter = offsetEntity(['a', 'b'], t(1, -1, 'miter'), 'o', lookupIn(es)) as LineEntity;
    expectPoints(miter.points, [[0, -1], [11, -1], [11, 10]]);
    // lines that don't connect aren't a chain
    expect(chainPath([line('a', [[0, 0], [1, 0]]), line('b', [[5, 5], [6, 5]])])).toBeNull();
  });

  it('closes a chain that comes back to its start, and drops an edge the inside offset swallows', () => {
    // a 10×10 square with its top-right corner chamfered 0.5, as three lines
    const es: Entity[] = [
      line('a', [[0, 0], [10, 0], [10, 9.5]]),
      line('b', [[10, 9.5], [9.5, 10]]),
      line('c', [[9.5, 10], [0, 10], [0, 0]]),
    ];
    const p = chainPath(es as LineEntity[])!;
    expect(p.closed).toBe(true);
    expect(p.points).toHaveLength(5);
    const inset = offsetPath(p, 2)!; // the loop runs anticlockwise: its inside is on the left
    expectPoints(inset.points, [[2, 2], [8, 2], [8, 8], [2, 8]]);
    expect(offsetPath(p, 6)).toBeNull();
  });

  it('follows its source, and its distance is a dimension that takes P expressions', () => {
    const rect: RectangleEntity = { id: 'case', type: 'rectangle', center: { x: 0, y: 0 }, width: 40, height: 30, cornerRadius: 3 };
    const made = addOffset([rect], ['case'], { distance: 1.5, side: -1, join: 'arc' }, newId, 'P/2')!;
    expect(made).not.toBeNull();
    const lip = () => made.entities.find((e) => e.id === made.offsetId) as RectangleEntity;
    expect(lip()).toMatchObject({ width: 37, height: 27, cornerRadius: 1.5 });
    const dim = made.entities.find((e) => e.id === made.dimensionId) as DimensionEntity;
    expect(dim).toMatchObject({ offsetDistance: true, targetEntityId: made.offsetId, expression: 'P/2' });
    expect(measureDimension(dim, made.entities)).toBeCloseTo(1.5, 9);

    // the case grows: the lip follows
    const grown = propagateDerived(made.entities.map((e) => (e.id === 'case' ? { ...rect, width: 50 } : e)));
    expect(grown.find((e) => e.id === made.offsetId)).toMatchObject({ width: 47, height: 27 });

    // the dimension sets the distance, directly or from P
    const sketch = { id: 's', name: 's', visible: true, entities: grown, constraints: [] };
    const edited = dimensionEntities(sketch, made.dimensionId, 2) as Entity[];
    expect(edited.find((e) => e.id === made.offsetId)).toMatchObject({ width: 46, height: 26, cornerRadius: 1 });
    const resolved = resolveSketch(sketch, { P: 4 }).sketch.entities;
    expect(resolved.find((e) => e.id === made.offsetId)).toMatchObject({ width: 46, height: 26, sourceTransform: { distance: 2 } });
    // an inside offset bigger than the shape doesn't happen
    expect(dimensionEntities(sketch, made.dimensionId, 20)).toBeNull();

    // unlinked: the shape stays, the link and the dimension go
    const free = unlinkOffset(edited, made.offsetId)!;
    const lip2 = free.find((e) => e.id === made.offsetId) as RectangleEntity;
    expect(lip2.sourceId).toBeUndefined();
    expect(lip2.width).toBe(46);
    expect(free.find((e) => e.id === made.dimensionId)).toBeUndefined();
    expect(propagateDerived(free.map((e) => (e.id === 'case' ? { ...rect, width: 60 } : e))).find((e) => e.id === made.offsetId)).toMatchObject({ width: 46 });
  });

  it('follows a chain of lines when one of them moves', () => {
    const es: Entity[] = [line('a', [[0, 0], [10, 0]]), line('b', [[10, 0], [10, 10]])];
    const made = addOffset(es, ['a', 'b'], { distance: 1, side: 1, join: 'arc' }, newId)!;
    const moved = propagateDerived(made.entities.map((e) => (e.id === 'b' ? line('b', [[10, 0], [10, 20]]) : e)));
    expectPoints((moved.find((e) => e.id === made.offsetId) as LineEntity).points, [[0, 1], [9, 1], [9, 20]]);
    // copies can't be offset (they follow something else already)
    expect(addOffset(made.entities, [made.offsetId], { distance: 1, side: 1, join: 'arc' }, newId)).toBeNull();
  });

  it('picks up the lines joined end to end with a clicked one, stopping where the chain branches', () => {
    const es: Entity[] = [
      line('a', [[0, 0], [10, 0]]),
      line('b', [[10, 10], [10, 0]]),
      line('c', [[10, 10], [0, 10]]),
      line('x', [[-5, 0], [0, 0]]), // with y, a branch at (0,0)
      line('y', [[0, 0], [0, -5]]),
      line('far', [[50, 50], [60, 50]]),
    ];
    expect(connectedChain(es, 'b')).toEqual(['c', 'b', 'a']); // in b's direction
    expect(connectedChain(es, 'far')).toEqual(['far']);
    expect(canOffset(['a', 'b', 'c'], lookupIn(es))).toBe(true);
    expect(canOffset(['a', 'far'], lookupIn(es))).toBe(false);
  });
});
