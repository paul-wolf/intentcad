import { describe, it, expect } from 'vitest';
import type { CircleEntity, Constraint, Document, Entity, LineEntity, Sketch } from '@/types/document';
import {
  AXIS_H, AXIS_V, FACE_AXIS_H, FACE_AXIS_V, axisOrigin, axisPoint, docWithAxes, isAxis, isAxisConstraint,
  savedData, savedHistory, withAxes, withoutAxes,
} from './sketchAxes';
import { useDocumentStore } from '@/stores/documentStore';
import { createEmptyDocument } from './document';
import { solveConstraints } from './constraintSolver';
import { measureDimension, resolveSketch } from './resolveSketch';
import { entityBounds } from './bounds';
import { planeBasis, planeForFace, sketchToWorld } from '@/build/sketchPlane';
import { followRefs, outlineEntities, type OutlineEdge } from '@/build/sketchRefs';
import { newPlaneSketch, sketchBounds, sketchLoops, sketchProfile } from '@/build/faceSketch';
import { exportDocumentToDxf } from '@/export/dxf';

const axis = (sk: Sketch, id: string) => sk.entities.find((e) => e.id === id) as LineEntity;
const byId = <T extends Entity>(es: Entity[], id: string) => es.find((e) => e.id === id) as T;
const pointAt = (id: string, x: number, y: number): Entity => ({ id, type: 'point', position: { x, y } });
const posOf = (es: Entity[], id: string) => byId<Extract<Entity, { type: 'point' }>>(es, id).position;
const near = (a: number[], b: number[]) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i]!, 6));

// a face outline: the rectangle x0..x1, y0..y1 (sketch coordinates)
type XY = [number, number];
const ln = (a: XY, b: XY): OutlineEdge => ({ t: 'line', p: [a, b] });
const box = (x0: number, y0: number, x1: number, y1: number): OutlineEdge[] =>
  [ln([x0, y0], [x1, y0]), ln([x1, y0], [x1, y1]), ln([x1, y1], [x0, y1]), ln([x0, y1], [x0, y0])];

/** A sketch on the top face of a block standing off the origin, its plane
 *  through the face centre (as older face sketches were): the face spans
 *  world x 20..60, y 10..40 at z = 15. */
function offCentreFaceSketch(outline = box(-20, -15, 20, 15)): Sketch {
  const refs = outlineEntities(outline);
  return {
    id: 'sk', name: 'Lid', visible: true,
    plane: { origin: [40, 25, 15], normal: [0, 0, 1], xAxis: [1, 0, 0] },
    face: { center: [40, 25, 15], normal: [0, 0, 1], area: 40 * 30 },
    entities: refs,
    constraints: refs.map((e): Constraint => ({ id: `f-${e.id}`, type: 'fixed', entityId: e.id })),
  };
}

const plainSketch = (entities: Entity[] = []): Sketch => ({ id: 'p', name: 'Plain', visible: true, entities, constraints: [] });

function freshStore(): void {
  useDocumentStore.getState().setDocument(createEmptyDocument('Axes'));
}
const active = () => useDocumentStore.getState().getActiveSketch()!;

describe('every sketch has its axes', () => {
  it('a new sketch gets H and V through its origin, fixed', () => {
    freshStore();
    useDocumentStore.getState().addSketch('Second');
    for (const sk of useDocumentStore.getState().document.sketches) {
      expect(sk.entities.filter(isAxis).map((e) => e.id)).toEqual([AXIS_H, AXIS_V]);
      expect(axis(sk, AXIS_H).points).toEqual([{ x: -10000, y: 0 }, { x: 10000, y: 0 }]);
      expect(axis(sk, AXIS_V).points).toEqual([{ x: 0, y: -10000 }, { x: 0, y: 10000 }]);
      expect(sk.constraints.filter(isAxisConstraint).map((c) => [c.type, (c as { entityId: string }).entityId]))
        .toEqual([['fixed', AXIS_H], ['fixed', AXIS_V]]);
    }
  });

  it('an old sketch (saved without them) gets them on load', () => {
    const old: Document = { id: 'd', name: 'Old', parameters: {}, activeSketchId: 'p',
      sketches: [plainSketch([pointAt('a', 3, 4)]), newPlaneSketch('Top', 'top')] };
    useDocumentStore.getState().setDocument(old);
    for (const sk of useDocumentStore.getState().document.sketches) {
      expect(sk.entities.filter(isAxis).length).toBe(2);
    }
    expect(posOf(active().entities, 'a')).toEqual({ x: 3, y: 4 });
  });

  it('withAxes leaves a sketch that has them alone', () => {
    const sk = withAxes(plainSketch());
    expect(withAxes(sk)).toBe(sk);
    expect(docWithAxes({ id: 'd', name: 'd', parameters: {}, activeSketchId: 'p', sketches: [sk] }).sketches[0]).toBe(sk);
  });

  it("can't be deleted, moved or restyled, and come back after undo", () => {
    freshStore();
    const ds = () => useDocumentStore.getState();
    ds().beginTransaction('Delete');
    ds().removeEntities([AXIS_H, AXIS_V]);
    ds().moveEntities([AXIS_V], { x: 5, y: 5 });
    ds().toggleConstruction([AXIS_H]);
    ds().removeConstraints(active().constraints.map((c) => c.id));
    expect(withAxes(active())).toBe(active());
    ds().undo();
    expect(withAxes(active())).toBe(active());
  });

  it('are left out of what is saved, keeping the constraints that use them', () => {
    const sk = withAxes(plainSketch([pointAt('a', 3, 4)]));
    sk.constraints.push({ id: 'on', type: 'pointOnCurve', entityId: 'a', pointIndex: 0, targetEntityId: AXIS_V, segmentIndex: 0 });
    const doc = { id: 'd', name: 'd', parameters: {}, activeSketchId: 'p', sketches: [sk] };
    const saved = savedData(doc);
    expect(saved.sketches[0]!.entities.map((e) => e.id)).toEqual(['a']);
    expect(saved.sketches[0]!.constraints.map((c) => c.id)).toEqual(['on']);
    const hist = savedHistory({ undo: [{ label: 'x', doc }], redo: [] });
    expect(hist.undo[0]!.doc.sketches[0]!.entities.some(isAxis)).toBe(false);
    // and on load they're back where they were
    expect(withAxes(saved.sketches[0]!).entities.filter(isAxis)).toEqual(sk.entities.filter(isAxis));
  });
});

describe('using the axes', () => {
  it('mirrors about the V axis and the H axis', () => {
    freshStore();
    const ds = () => useDocumentStore.getState();
    const c: CircleEntity = { id: 'c', type: 'circle', center: { x: 12, y: 5 }, radius: 3 };
    ds().addEntity(c);
    for (const [id, want] of [[AXIS_V, { x: -12, y: 5 }], [AXIS_H, { x: 12, y: -5 }]] as const) {
      const ax = axis(active(), id);
      // the axis in the selection is left out: only the circle is mirrored
      const [copy] = ds().mirrorEntities(['c', id], ax.points[0]!, ax.points[1]!);
      expect(byId<CircleEntity>(active().entities, copy!).center).toEqual(want);
    }
    expect(active().entities.filter(isAxis).length).toBe(2);
  });

  it('holds two points symmetric about an axis', () => {
    const sk = withAxes(plainSketch([pointAt('a', 7, 2), pointAt('b', -3, 9)]));
    const sym: Constraint = { id: 's', type: 'symmetric', entityId: 'a', pointIndex: 0, entityId2: 'b', pointIndex2: 0, targetEntityId: AXIS_V, segmentIndex: 0 };
    const r = solveConstraints(sk.entities, [...sk.constraints, sym], { movedIds: new Set(['a']), maxIterations: 50 });
    const a = posOf(r.entities, 'a'), b = posOf(r.entities, 'b');
    expect(a.x + b.x).toBeCloseTo(0, 6);
    expect(a.y).toBeCloseTo(b.y, 6);
    // the axis didn't move
    expect(axis({ ...sk, entities: r.entities }, AXIS_V)).toEqual(axis(sk, AXIS_V));
  });

  it('dimensions a point to an axis', () => {
    const dim: Entity = { id: 'd', type: 'dimension', targetEntityId: 'p', pointIndex: 0, targetEntityId2: AXIS_V,
      segmentIndex: 0, segmentIndex2: 0, offset: 3, expression: '20' };
    const sk = withAxes(plainSketch([pointAt('p', 12, 7), dim]));
    expect(measureDimension(dim, sk.entities)).toBeCloseTo(12, 6);
    const r = resolveSketch(sk, {});
    expect(r.changed).toBe(true);
    expect(measureDimension(dim, r.sketch.entities)).toBeCloseTo(20, 6);
    expect(axis(r.sketch, AXIS_V)).toEqual(axis(sk, AXIS_V));
  });
});

describe('face sketch axes', () => {
  it('cross at the world origin projected onto the face (Y flipped)', () => {
    const sk = withAxes(offCentreFaceSketch());
    const o = axisOrigin(sk);
    expect(o).toEqual({ x: -40, y: 25 });   // sketch +Y is world −Y here
    const b = planeBasis(sk.plane!);
    near(sketchToWorld(b, axisPoint(axis(sk, AXIS_H))), [0, 0, 15]);
    near(sketchToWorld(b, axisPoint(axis(sk, AXIS_V))), [0, 0, 15]);
    // a wall: the plane made for it (origin already the projected world origin)
    const wall = planeForFace([30, -25, 8], [0, -1, 0]);
    const onWall: Sketch = { ...offCentreFaceSketch(), plane: wall, face: { center: [30, -25, 8], normal: [0, -1, 0], area: 1 } };
    near(sketchToWorld(planeBasis(wall), axisPoint(axis(withAxes(onWall), AXIS_V))), [0, -25, 0]);
  });

  it("have the face's own centre lines, which follow the face as it grows", () => {
    const sk = withAxes(offCentreFaceSketch());
    expect(axisPoint(axis(sk, FACE_AXIS_H))).toEqual({ x: 0, y: 0 });
    expect(axis(sk, FACE_AXIS_V).points[0]!.x).toBe(0);
    // the face grows 10 to the left and 6 downwards (sketch +y)
    const r = followRefs(sk, outlineEntities(box(-30, -15, 20, 21)));
    expect(r.changed).toBe(true);
    expect(axisPoint(axis(r.sketch, FACE_AXIS_H))).toEqual({ x: -5, y: 3 });
    expect(axis(r.sketch, FACE_AXIS_H).points.every((p) => p.y === 3)).toBe(true);
    expect(axis(r.sketch, FACE_AXIS_V).points.every((p) => p.x === -5)).toBe(true);
    // the origin axes don't move with the face
    expect(axis(r.sketch, AXIS_V)).toEqual(axis(sk, AXIS_V));
    expect(withAxes(r.sketch)).toBe(r.sketch);
  });

  it('keep a point dimensioned to a face centre line there when the face grows', () => {
    const dim: Entity = { id: 'd', type: 'dimension', targetEntityId: 'p', pointIndex: 0, targetEntityId2: FACE_AXIS_V,
      segmentIndex: 0, segmentIndex2: 0, offset: 3 };
    const base = withAxes(offCentreFaceSketch());
    const sk = { ...base, entities: [...base.entities, pointAt('p', 8, 0), dim] };
    const r = followRefs(sk, outlineEntities(box(-30, -15, 20, 15)));
    expect(posOf(r.sketch.entities, 'p').x).toBeCloseTo(-5 + 8, 6);
  });
});

describe('the axes are never part of the drawing', () => {
  const rect: Entity = { id: 'r', type: 'rectangle', center: { x: 30, y: 20 }, width: 10, height: 6 };

  it('not in profiles or bounds', () => {
    const without = plainSketch([rect]);
    const sk = withAxes(without);
    expect(sketchLoops(sk)).toEqual(sketchLoops(without));
    expect(sketchProfile(sk)).toEqual(sketchProfile(without));
    expect(sketchBounds(sk)).toEqual(sketchBounds(without));
    expect(entityBounds(sk.entities)).toEqual(entityBounds([rect]));
    // a sketch of nothing but its axes has nothing in it
    expect(sketchProfile(withAxes(plainSketch()))).toBeNull();
    expect(entityBounds(withAxes(plainSketch()).entities)).toBeNull();
  });

  it('not in a face sketch profile either', () => {
    const face = offCentreFaceSketch();
    expect(sketchBounds(withAxes(face))).toEqual(sketchBounds(face));
  });

  it('not in exports', () => {
    const doc = (sk: Sketch): Document => ({ id: 'd', name: 'd', parameters: {}, activeSketchId: sk.id, sketches: [sk] });
    expect(exportDocumentToDxf(doc(withAxes(plainSketch([rect]))))).toBe(exportDocumentToDxf(doc(plainSketch([rect]))));
    expect(withoutAxes(withAxes(plainSketch([rect])))).toEqual(plainSketch([rect]));
  });
});
