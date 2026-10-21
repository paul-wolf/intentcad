import { describe, it, expect } from 'vitest';
import { solveConstraints, validateConstraint } from './constraintSolver';
import { computeSketchDoF } from './dof';
import { resolveSketch } from './resolveSketch';
import { useDocumentStore } from '@/stores/documentStore';
import { isAxisConstraint } from './sketchAxes';
import type { CircleEntity, Constraint, Entity, LineEntity, RectangleEntity, Sketch } from '@/types/document';

const circle = (id: string, x: number, y: number, r = 1.5): CircleEntity =>
  ({ id, type: 'circle', center: { x, y }, radius: r });
const byId = <T extends Entity>(es: Entity[], id: string) => es.find((e) => e.id === id) as T;
const hp = (id: string, a: string, ai: number, b: string, bi: number): Constraint =>
  ({ id, type: 'horizontalPoints', entityId: a, pointIndex: ai, targetEntityId: b, targetPointIndex: bi });
const vp = (id: string, a: string, ai: number, b: string, bi: number): Constraint =>
  ({ id, type: 'verticalPoints', entityId: a, pointIndex: ai, targetEntityId: b, targetPointIndex: bi });

describe('horizontal / vertical between two points', () => {
  // Four standoffs drawn roughly on a rectangle, the first fixed at the origin
  const standoffs = (): Entity[] => [circle('s1', 0, 0), circle('s2', 50, 3), circle('s3', 2, 30), circle('s4', 47, 33)];
  const aligned: Constraint[] = [
    { id: 'f', type: 'fixed', entityId: 's1' },
    hp('h12', 's1', 0, 's2', 0),
    vp('v13', 's1', 0, 's3', 0),
    hp('h34', 's3', 0, 's4', 0),
    vp('v24', 's2', 0, 's4', 0),
  ];

  it('lines four standoff centres up on a rectangle, without moving the fixed one', () => {
    const { entities, converged } = solveConstraints(standoffs(), aligned);
    expect(converged).toBe(true);
    const c = (id: string) => byId<CircleEntity>(entities, id).center;
    expect(c('s1')).toEqual({ x: 0, y: 0 });
    expect(c('s2').y).toBeCloseTo(0, 9);
    expect(c('s2').x).toBeCloseTo(50, 9);     // only moved across the line, not along it
    expect(c('s3').x).toBeCloseTo(0, 9);
    expect(c('s4').x).toBeCloseTo(c('s2').x, 9);
    expect(c('s4').y).toBeCloseTo(c('s3').y, 9);
    // a radius is never touched
    expect(byId<CircleEntity>(entities, 's4').radius).toBe(1.5);
  });

  it('takes one degree of freedom each', () => {
    const dof = computeSketchDoF(standoffs(), aligned);
    expect(dof.get('s1')).toBe(0);
    expect(dof.get('s2')).toBe(2);
    expect(dof.get('s3')).toBe(2);
    expect(dof.get('s4')).toBe(1);
  });

  it('keeps the one being dragged where it is and moves the other', () => {
    const entities = [circle('a', 0, 0), circle('b', 20, 7)];
    const cs = [hp('h', 'a', 0, 'b', 0)];
    const out = solveConstraints(entities, cs, { movedIds: new Set(['b']) }).entities;
    expect(byId<CircleEntity>(out, 'b').center).toEqual({ x: 20, y: 7 });
    expect(byId<CircleEntity>(out, 'a').center).toEqual({ x: 0, y: 7 });
  });

  it('works between a polyline vertex, a rectangle corner and centre, and a point', () => {
    const line: LineEntity = { id: 'l', type: 'line', points: [{ x: 0, y: 0 }, { x: 10, y: 4 }, { x: 20, y: 1 }] };
    const rect: RectangleEntity = { id: 'r', type: 'rectangle', center: { x: 40, y: 10 }, width: 10, height: 6 };
    const pt: Entity = { id: 'p', type: 'point', position: { x: 60, y: 22 } };
    const cs: Constraint[] = [
      { id: 'f', type: 'fixed', entityId: 'l' },
      vp('v', 'l', 2, 'r', 0),      // the rectangle's centre under the polyline's end
      hp('h', 'l', 1, 'r', 1),      // its top-left corner level with the middle vertex
      hp('h2', 'r', 0, 'p', 0),     // the point level with its centre
    ];
    const { entities, converged } = solveConstraints([line, rect, pt], cs);
    expect(converged).toBe(true);
    const r = byId<RectangleEntity>(entities, 'r');
    expect(r.center.x).toBeCloseTo(20, 9);
    expect(r.center.y + r.height / 2).toBeCloseTo(4, 9);
    expect(byId<Extract<Entity, { type: 'point' }>>(entities, 'p').position.y).toBeCloseTo(r.center.y, 9);
  });

  it('holds together with a coincident chain and a horizontal segment', () => {
    const a: LineEntity = { id: 'a', type: 'line', points: [{ x: 0, y: 0 }, { x: 30, y: 5 }] };
    const b: LineEntity = { id: 'b', type: 'line', points: [{ x: 31, y: 6 }, { x: 31, y: 40 }] };
    const c = circle('c', 10, 37);
    const cs: Constraint[] = [
      { id: 'f', type: 'fixed', entityId: 'a' },
      { id: 'j', type: 'coincident', entityId: 'a', pointIndex: 1, targetEntityId: 'b', targetPointIndex: 0 },
      hp('h', 'b', 1, 'c', 0),
      { id: 'hb', type: 'vertical', entityId: 'b', segmentIndex: 0 },
    ];
    const { entities, converged } = solveConstraints([a, b, c], cs);
    expect(converged).toBe(true);
    const bb = byId<LineEntity>(entities, 'b');
    expect(bb.points[0]).toEqual({ x: 30, y: 5 });
    expect(bb.points[1]!.x).toBeCloseTo(30, 9);
    expect(byId<CircleEntity>(entities, 'c').center.y).toBeCloseTo(bb.points[1]!.y, 9);
  });

  it('follows a dimension set from a P expression', () => {
    const sketch: Sketch = {
      id: 'sk', name: 'Standoffs', visible: true,
      entities: [
        ...standoffs(),
        // centre to centre, s1 → s2 and s1 → s3
        { id: 'dw', type: 'dimension', targetEntityId: 's1', pointIndex: 0, targetEntityId2: 's2', pointIndex2: 0,
          segmentIndex: 0, offset: 5, expression: 'pcb_w - 8' },
        { id: 'dh', type: 'dimension', targetEntityId: 's1', pointIndex: 0, targetEntityId2: 's3', pointIndex2: 0,
          segmentIndex: 0, offset: 5, expression: 'pcb_h - 8' },
      ],
      constraints: aligned,
    };
    sketch.entities = solveConstraints(sketch.entities, sketch.constraints).entities;
    const r = resolveSketch(sketch, { pcb_w: 65, pcb_h: 56 });
    expect(r.warnings).toEqual([]);
    const c = (id: string) => byId<CircleEntity>(r.sketch.entities, id).center;
    expect(c('s2').x).toBeCloseTo(57, 6);
    expect(c('s2').y).toBeCloseTo(0, 6);
    expect(c('s3').y).toBeCloseTo(48, 6);
    expect(c('s3').x).toBeCloseTo(0, 6);
    expect(c('s4').x).toBeCloseTo(57, 6);
    expect(c('s4').y).toBeCloseTo(48, 6);
  });

  it('is refused on the same point twice or as a duplicate, either way round', () => {
    const es = standoffs();
    expect(validateConstraint(hp('x', 's1', 0, 's1', 0), [], es)).toMatchObject({ valid: false });
    const existing = [hp('h', 's1', 0, 's2', 0)];
    expect(validateConstraint(hp('x', 's2', 0, 's1', 0), existing, es)).toMatchObject({ valid: false, reason: 'Duplicate constraint' });
    // a different pair of points on the same two shapes is not a duplicate
    const rect: RectangleEntity = { id: 'r', type: 'rectangle', center: { x: 0, y: 0 }, width: 4, height: 4 };
    const onRect = [hp('h', 'r', 1, 's2', 0)];
    expect(validateConstraint(hp('x', 'r', 3, 's2', 0), onRect, [rect, ...es]).valid).toBe(true);
    // H and V on one pair puts the points together: allowed
    expect(validateConstraint(vp('x', 's1', 0, 's2', 0), existing, es).valid).toBe(true);
  });
});

const on = (id: string, a: string, ai: number, b: string, seg: number): Constraint =>
  ({ id, type: 'pointOnCurve', entityId: a, pointIndex: ai, targetEntityId: b, segmentIndex: seg });
const sym = (id: string, a: string, ai: number, b: string, bi: number, line: string, seg = 0): Constraint =>
  ({ id, type: 'symmetric', entityId: a, pointIndex: ai, entityId2: b, pointIndex2: bi, targetEntityId: line, segmentIndex: seg });
const pointAt = (id: string, x: number, y: number): Entity => ({ id, type: 'point', position: { x, y } });
const posOf = (es: Entity[], id: string) => byId<Extract<Entity, { type: 'point' }>>(es, id).position;
const seg = (id: string, a: [number, number], b: [number, number], construction = false): LineEntity =>
  ({ id, type: 'line', points: [{ x: a[0], y: a[1] }, { x: b[0], y: b[1] }], ...(construction ? { construction } : {}) });

describe('point on curve', () => {
  it('puts a point on the line through a segment, beyond its ends too', () => {
    const cs: Constraint[] = [{ id: 'f', type: 'fixed', entityId: 'l' }, on('o', 'p', 0, 'l', 0)];
    const { entities, converged } = solveConstraints([seg('l', [0, 0], [10, 10]), pointAt('p', 40, 20)], cs);
    expect(converged).toBe(true);
    // the nearest point of the infinite line y = x
    expect(posOf(entities, 'p').x).toBeCloseTo(30, 9);
    expect(posOf(entities, 'p').y).toBeCloseTo(30, 9);
  });

  it('puts a point on a circle, and a vertex on the circle of an arc segment', () => {
    const arcLine: LineEntity = { id: 'a', type: 'line', points: [{ x: -10, y: 0 }, { x: 10, y: 0 }], bulge: [1] };  // a half circle, r 10 round the origin
    const other = seg('o', [3, 4], [30, 30]);
    const cs: Constraint[] = [
      { id: 'f1', type: 'fixed', entityId: 'c' }, { id: 'f2', type: 'fixed', entityId: 'a' },
      on('p1', 'p', 0, 'c', -1),
      on('p2', 'o', 0, 'a', 0),
    ];
    const { entities, converged } = solveConstraints([circle('c', 100, 0, 5), pointAt('p', 100, 1), arcLine, other], cs);
    expect(converged).toBe(true);
    expect(posOf(entities, 'p').x).toBeCloseTo(100, 9);
    expect(posOf(entities, 'p').y).toBeCloseTo(5, 9);
    const v = byId<LineEntity>(entities, 'o').points[0]!;
    expect(Math.hypot(v.x, v.y)).toBeCloseTo(10, 9);
    expect(v.y / v.x).toBeCloseTo(4 / 3, 9);    // straight out from the centre
    expect(byId<LineEntity>(entities, 'o').points[1]).toEqual({ x: 30, y: 30 });   // only that vertex moved
  });

  it('moves the line instead when the point is fixed or being dragged', () => {
    const fixedPt: Constraint[] = [{ id: 'f', type: 'fixed', entityId: 'p' }, on('o', 'p', 0, 'l', 0)];
    const out = solveConstraints([seg('l', [0, 0], [10, 0]), pointAt('p', 5, 5)], fixedPt).entities;
    expect(posOf(out, 'p')).toEqual({ x: 5, y: 5 });
    expect(byId<LineEntity>(out, 'l').points.map((q) => q.y)).toEqual([5, 5]);

    const dragged = solveConstraints([seg('l', [0, 0], [10, 0]), pointAt('p', 5, 5)], [on('o', 'p', 0, 'l', 0)], { movedIds: new Set(['p']) }).entities;
    expect(posOf(dragged, 'p')).toEqual({ x: 5, y: 5 });
    expect(byId<LineEntity>(dragged, 'l').points[0]!.y).toBeCloseTo(5, 9);
  });

  it('takes one degree of freedom from the point', () => {
    const dof = computeSketchDoF([seg('l', [0, 0], [10, 0]), pointAt('p', 5, 5)], [{ id: 'f', type: 'fixed', entityId: 'l' }, on('o', 'p', 0, 'l', 0)]);
    expect(dof.get('p')).toBe(1);
  });

  it('holds with H between points and a dimension from a P expression', () => {
    // a hole above a fixed one (P sets how far), and another level with it on a 30° line
    const sketch: Sketch = {
      id: 'sk', name: 'Holes', visible: true,
      entities: [
        seg('slope', [0, 0], [Math.sqrt(3), 1], true), circle('h1', 0, 0), circle('h2', 2, 33), circle('h3', 1, 35),
        { id: 'd', type: 'dimension', targetEntityId: 'h1', pointIndex: 0, targetEntityId2: 'h3', pointIndex2: 0,
          segmentIndex: 0, offset: 5, expression: 'pitch * 2' },
      ],
      constraints: [
        { id: 'f1', type: 'fixed', entityId: 'slope' }, { id: 'f2', type: 'fixed', entityId: 'h1' },
        vp('v', 'h1', 0, 'h3', 0),
        hp('h', 'h3', 0, 'h2', 0),
        on('o', 'h2', 0, 'slope', 0),
      ],
    };
    sketch.entities = solveConstraints(sketch.entities, sketch.constraints).entities;
    const r = resolveSketch(sketch, { pitch: 20 });
    expect(r.warnings).toEqual([]);
    const c = (id: string) => byId<CircleEntity>(r.sketch.entities, id).center;
    expect(c('h3').x).toBeCloseTo(0, 9);
    expect(c('h3').y).toBeCloseTo(40, 6);
    expect(c('h2').y).toBeCloseTo(40, 6);
    expect(c('h2').x).toBeCloseTo(40 * Math.sqrt(3), 6);     // on the line, level with h3
  });

  it('is refused on a point that makes the curve, and as a duplicate', () => {
    const l: LineEntity = { id: 'l', type: 'line', points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }] };
    expect(validateConstraint(on('x', 'l', 1, 'l', 0), [], [l]).valid).toBe(false);   // its own end
    expect(validateConstraint(on('x', 'l', 2, 'l', 0), [], [l]).valid).toBe(true);    // another vertex of the polyline
    expect(validateConstraint(on('x', 'c', 0, 'c', -1), [], [circle('c', 0, 0)]).valid).toBe(false);
    const es = [l, pointAt('p', 3, 3)];
    expect(validateConstraint(on('x', 'p', 0, 'l', 0), [on('o', 'p', 0, 'l', 0)], es)).toMatchObject({ valid: false, reason: 'Duplicate constraint' });
    expect(validateConstraint(on('x', 'p', 0, 'l', 1), [on('o', 'p', 0, 'l', 0)], es).valid).toBe(true);
    expect(validateConstraint(on('x', 'p', 0, 'l', 0), [{ id: 'a', type: 'fixed', entityId: 'p' }, { id: 'b', type: 'fixed', entityId: 'l' }], es).valid).toBe(false);
  });
});

describe('symmetric', () => {
  const axis = () => seg('ax', [0, -50], [0, 50], true);
  const fixAxis: Constraint = { id: 'fa', type: 'fixed', entityId: 'ax' };

  it('mirrors the second point onto the first about the line', () => {
    const { entities, converged } = solveConstraints([axis(), circle('a', -10, 3), circle('b', 12, 5)], [fixAxis, sym('s', 'a', 0, 'b', 0, 'ax')], { movedIds: new Set(['a']) });
    expect(converged).toBe(true);
    expect(byId<CircleEntity>(entities, 'a').center).toEqual({ x: -10, y: 3 });
    expect(byId<CircleEntity>(entities, 'b').center.x).toBeCloseTo(10, 9);
    expect(byId<CircleEntity>(entities, 'b').center.y).toBeCloseTo(3, 9);
  });

  it('keeps the one being dragged and moves its partner, about a slanted line too', () => {
    const slant = seg('ax', [0, 0], [10, 10]);
    const out = solveConstraints([slant, pointAt('a', 5, 0), pointAt('b', 1, 9)],
      [{ id: 'f', type: 'fixed', entityId: 'ax' }, sym('s', 'a', 0, 'b', 0, 'ax')], { movedIds: new Set(['b']) }).entities;
    expect(posOf(out, 'b')).toEqual({ x: 1, y: 9 });
    expect(posOf(out, 'a').x).toBeCloseTo(9, 9);
    expect(posOf(out, 'a').y).toBeCloseTo(1, 9);
  });

  it('centres a slot (two ends of one polyline) on a centre line, with an equal-length dimension from P', () => {
    // a slot: two straight sides joined by arcs, drawn off centre
    const slot: LineEntity = {
      id: 'slot', type: 'line', closed: true,
      points: [{ x: 3, y: 0 }, { x: 25, y: 0 }, { x: 25, y: 6 }, { x: 3, y: 6 }],
      bulge: [0, 1, 0, 1],
    };
    const sketch: Sketch = {
      id: 'sk', name: 'Slot', visible: true,
      entities: [axis(), slot,
        { id: 'd', type: 'dimension', targetEntityId: 'slot', pointIndex: 0, targetEntityId2: 'slot', pointIndex2: 1,
          segmentIndex: 0, offset: 5, expression: 'slot_len' }],
      constraints: [fixAxis, sym('s1', 'slot', 0, 'slot', 1, 'ax'), sym('s2', 'slot', 3, 'slot', 2, 'ax'),
        { id: 'h', type: 'horizontal', entityId: 'slot', segmentIndex: 0 }],
    };
    sketch.entities = solveConstraints(sketch.entities, sketch.constraints).entities;
    const r = resolveSketch(sketch, { slot_len: 30 });
    expect(r.warnings).toEqual([]);
    const p = byId<LineEntity>(r.sketch.entities, 'slot').points;
    expect(p[0]!.x).toBeCloseTo(-p[1]!.x, 6);
    expect(p[3]!.x).toBeCloseTo(-p[2]!.x, 6);
    expect(p[1]!.x - p[0]!.x).toBeCloseTo(30, 6);
    expect(p[0]!.y).toBeCloseTo(p[1]!.y, 6);
  });

  it('slides a rectangle so two of its corners are mirror images', () => {
    const rect: RectangleEntity = { id: 'r', type: 'rectangle', center: { x: 7, y: 2 }, width: 10, height: 4 };
    const { entities, converged } = solveConstraints([axis(), rect], [fixAxis, sym('s', 'r', 1, 'r', 2, 'ax')]);
    expect(converged).toBe(true);
    const r = byId<RectangleEntity>(entities, 'r');
    expect(r.center.x).toBeCloseTo(0, 9);
    expect([r.width, r.height]).toEqual([10, 4]);
  });

  it('moves the line when both points are fixed', () => {
    const cs: Constraint[] = [{ id: 'f1', type: 'fixed', entityId: 'a' }, { id: 'f2', type: 'fixed', entityId: 'b' }, sym('s', 'a', 0, 'b', 0, 'ax')];
    const out = solveConstraints([axis(), pointAt('a', 4, 0), pointAt('b', 20, 0)], cs).entities;
    expect(byId<LineEntity>(out, 'ax').points.map((q) => q.x)).toEqual([12, 12]);
  });

  it('takes two degrees of freedom from the second point', () => {
    const dof = computeSketchDoF([axis(), circle('a', -10, 3), circle('b', 12, 5)], [fixAxis, sym('s', 'a', 0, 'b', 0, 'ax')]);
    expect(dof.get('a')).toBe(3);
    expect(dof.get('b')).toBe(1);
  });

  it('is refused about an arc, on one point twice, on the line’s own end, or as a duplicate', () => {
    const arc: LineEntity = { id: 'arc', type: 'line', points: [{ x: 0, y: 0 }, { x: 10, y: 0 }], bulge: [0.5] };
    const es = [axis(), arc, pointAt('a', -3, 0), pointAt('b', 3, 0)];
    expect(validateConstraint(sym('x', 'a', 0, 'b', 0, 'arc'), [], es).valid).toBe(false);
    expect(validateConstraint(sym('x', 'a', 0, 'a', 0, 'ax'), [], es).valid).toBe(false);
    expect(validateConstraint(sym('x', 'ax', 0, 'b', 0, 'ax'), [], es).valid).toBe(false);
    const existing = [sym('s', 'a', 0, 'b', 0, 'ax')];
    expect(validateConstraint(sym('x', 'b', 0, 'a', 0, 'ax'), existing, es)).toMatchObject({ valid: false, reason: 'Duplicate constraint' });
    expect(validateConstraint(sym('x', 'a', 0, 'b', 0, 'ax'), [], es).valid).toBe(true);
  });

  it('goes when any of its three shapes is deleted', () => {
    const ds = useDocumentStore.getState();
    ds.addSketch('sym');
    for (const e of [axis(), pointAt('a', -3, 0), pointAt('b', 3, 0)]) useDocumentStore.getState().addEntity(e);
    useDocumentStore.getState().toggleSymmetric({ entityId: 'a', pointIndex: 0 }, { entityId: 'b', pointIndex: 0 }, { entityId: 'ax', segmentIndex: 0 });
    // the sketch's own axes are held by 'fixed' constraints; leave them out
    const constraints = () => useDocumentStore.getState().getActiveSketch()!.constraints.filter((c) => !isAxisConstraint(c));
    expect(constraints().map((c) => c.type)).toEqual(['symmetric']);
    useDocumentStore.getState().removeEntities(['ax']);
    expect(constraints()).toEqual([]);
  });
});
