import { describe, it, expect } from 'vitest';
import { solveConstraints, validateConstraint } from './constraintSolver';
import { computeSketchDoF } from './dof';
import { resolveSketch } from './resolveSketch';
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
