import { describe, it, expect, vi } from 'vitest';
import type { Constraint, Entity, LineEntity, Sketch } from '@/types/document';
import { brokenRefWarning, dimensionedToEdges, followRefs, matchEdges, outlineEntities, type OutlineEdge } from './sketchRefs';
import { buildFollowingSketches, followPartSketches } from './sketchParams';
import type { SketchBindings } from './faceSketch';
import { measureDimension, resolveSketch } from '@/utils/resolveSketch';
import { solveConstraints } from '@/utils/constraintSolver';

type XY = [number, number];
const line = (a: XY, b: XY): OutlineEdge => ({ t: 'line', p: [a, b] });

// the floor inside a 90 x 60 case with walls `w` thick, shifted by (dx, dy):
// bottom, right, top, left (sketch coordinates)
function floor(w: number, dx = 0, dy = 0): OutlineEdge[] {
  const x0 = -45 + w + dx, x1 = 45 - w + dx, y0 = -30 + w + dy, y1 = 30 - w + dy;
  return [line([x0, y0], [x1, y0]), line([x1, y0], [x1, y1]), line([x1, y1], [x0, y1]), line([x0, y1], [x0, y0])];
}

const fixedAll = (es: Entity[]): Constraint[] => es.map((e) => ({ id: `f-${e.id}`, type: 'fixed', entityId: e.id }));
const refIds = (s: Sketch) => s.entities.filter((e) => 'reference' in e && e.reference).map((e) => e.id).sort();
const byId = (s: Sketch, id: string) => s.entities.find((e) => e.id === id)!;
const pos = (s: Sketch, id: string) => (byId(s, id) as Extract<Entity, { type: 'point' }>).position;

// "Standoffs": a point 14 from the floor's left (inner) wall and 14 from its bottom one
function standoffs(w = 2): Sketch {
  const refs = outlineEntities(floor(w));
  const [bottom, , , left] = refs;
  return {
    id: 'sk', name: 'Standoffs', visible: true,
    plane: { origin: [0, 0, 2], normal: [0, 0, 1], xAxis: [1, 0, 0] },
    face: { center: [0, 0, 2], normal: [0, 0, 1], area: 86 * 56 },
    entities: [
      ...refs,
      { id: 'p', type: 'point', position: { x: -45 + w + 14, y: -30 + w + 14 } },
      { id: 'dx', type: 'dimension', targetEntityId: 'p', pointIndex: 0, targetEntityId2: left!.id,
        segmentIndex: 0, segmentIndex2: 0, offset: 3 },
      { id: 'dy', type: 'dimension', targetEntityId: 'p', pointIndex: 0, targetEntityId2: bottom!.id,
        segmentIndex: 0, segmentIndex2: 0, offset: 3 },
    ],
    constraints: fixedAll(refs),
  };
}

describe('matching the reference outline to the face', () => {
  it('keeps every id when the outline grows, shrinks or shifts', () => {
    const sk = standoffs(2);
    for (const next of [floor(1), floor(3), floor(2, 5, -3), floor(4, -2, 1)]) {
      const r = followRefs(sk, outlineEntities(next));
      expect(r.changed).toBe(true);
      expect(r.moved).toBe(true);
      expect(r.added).toBe(0);
      expect(r.broken).toEqual([]);
      expect(refIds(r.sketch)).toEqual(refIds(sk));
      // and each edge is where its new face edge is, drawn the same way round
      const left = r.sketch.entities[3] as LineEntity;
      expect(left.points.map((p) => [p.x, p.y])).toEqual((next[3] as Extract<OutlineEdge, { t: 'line' }>).p);
    }
  });

  it('changes nothing when the face is where it was', () => {
    const sk = standoffs(2);
    const r = followRefs(sk, outlineEntities(floor(2)));
    expect(r.changed).toBe(false);
    expect(r.sketch).toBe(sk);
  });

  it('keeps an edge drawn the other way round the way it was', () => {
    const sk = standoffs(2);
    const flipped = floor(3).map((e) => (e.t === 'line' ? line(e.p[1], e.p[0]) : e));
    const r = followRefs(sk, outlineEntities(flipped));
    const bottom = r.sketch.entities[0] as LineEntity;
    expect(bottom.points).toEqual([{ x: -42, y: -27 }, { x: 42, y: -27 }]);
  });

  it('adds the edges of a notch as new reference edges', () => {
    const sk = standoffs(2);
    // a 10 wide, 4 deep notch in the top edge (y = 28)
    const notched = [
      ...floor(2).slice(0, 2),
      line([43, 28], [5, 28]), line([5, 28], [5, 24]), line([5, 24], [-5, 24]), line([-5, 24], [-5, 28]), line([-5, 28], [-43, 28]),
      floor(2)[3]!,
    ];
    const r = followRefs(sk, outlineEntities(notched));
    expect(r.added).toBe(4);
    expect(r.broken).toEqual([]);
    expect(refIds(r.sketch)).toEqual(expect.arrayContaining(refIds(sk)));
    expect(refIds(r.sketch)).toHaveLength(8);
    // the new edges are fixed like the rest
    for (const id of refIds(r.sketch)) expect(r.sketch.constraints.some((c) => c.type === 'fixed' && c.entityId === id)).toBe(true);
    // the point didn't move
    expect(pos(r.sketch, 'p')).toEqual(pos(sk, 'p'));
  });

  it('marks an edge that is gone broken when something uses it, and drops it otherwise', () => {
    const sk = standoffs(2);
    const [, right, , left] = sk.entities;
    // the face lost its left and right edges (a slot right across)
    const r = followRefs(sk, outlineEntities([floor(2)[0]!, floor(2)[2]!]));
    expect(r.broken).toEqual([left!.id]);                                         // dimensioned: kept
    expect(byId(r.sketch, left!.id)).toMatchObject({ broken: true });
    expect(r.sketch.entities.some((e) => e.id === right!.id)).toBe(false);       // unused: gone
    expect(r.sketch.constraints.some((c) => c.entityId === right!.id)).toBe(false);
    expect(brokenRefWarning(r.sketch)).toBe("Sketch 'Standoffs': 1 dimension refers to an edge that no longer exists");
    expect(pos(r.sketch, 'p')).toEqual(pos(sk, 'p'));

    // the edge coming back mends it
    const back = followRefs(r.sketch, outlineEntities(floor(2)));
    expect(back.broken).toEqual([]);
    expect(byId(back.sketch, left!.id)).not.toHaveProperty('broken');
    expect(brokenRefWarning(back.sketch)).toBeNull();
  });

  it('matches circles and arcs by centre and radius, and not across a big change of size', () => {
    const hole = (x: number, r: number): OutlineEdge => ({ t: 'circle', c: [x, 0], r });
    const corner = (r: number): OutlineEdge => ({ t: 'arc', c: [40, 20], r, p: [[40 + r, 20], [40 + r * Math.SQRT1_2, 20 + r * Math.SQRT1_2], [40, 20 + r]] });
    const old = outlineEntities([hole(10, 1.7), hole(-10, 1.7), corner(3)]);
    const pairs = matchEdges(old, outlineEntities([corner(4), hole(-9, 2.2), hole(11, 1.7)]));
    expect(pairs.sort()).toEqual([[0, 2], [1, 1], [2, 0]]);
    expect(matchEdges(old.slice(0, 1), outlineEntities([hole(10, 6)]))).toEqual([]);
  });

  it('does not match lines more than half a degree apart', () => {
    const a = outlineEntities([line([0, 0], [100, 0])]);
    expect(matchEdges(a, outlineEntities([line([0, 0], [100, 0.8])]))).toHaveLength(1);   // 0.46°
    expect(matchEdges(a, outlineEntities([line([0, 0], [100, 1])]))).toHaveLength(0);     // 0.57°
  });
});

describe('what is dimensioned to the outline follows it', () => {
  it('keeps a point 14 from the inner wall when the wall moves 1', () => {
    const sk = standoffs(2);
    const r = followRefs(sk, outlineEntities(floor(3)));
    expect(pos(r.sketch, 'p').x).toBeCloseTo(-28, 6);
    expect(pos(r.sketch, 'p').y).toBeCloseTo(-13, 6);
    for (const d of ['dx', 'dy']) expect(measureDimension(byId(r.sketch, d), r.sketch.entities)).toBeCloseTo(14, 6);
  });

  it('applies expression dimensions after, with the part’s values', () => {
    const sk = standoffs(2);
    (sk.entities.find((e) => e.id === 'dx') as Extract<Entity, { type: 'dimension' }>).expression = 'inset + 1';
    const r = followRefs(sk, outlineEntities(floor(3)), { inset: 9 });
    expect(measureDimension(byId(r.sketch, 'dx'), r.sketch.entities)).toBeCloseTo(10, 6);
    expect(measureDimension(byId(r.sketch, 'dy'), r.sketch.entities)).toBeCloseTo(14, 6);
  });

  it('leaves the constraints and expression dimensions on a broken edge out of the solve', () => {
    const sk = standoffs(2);
    const left = sk.entities[3]!;
    const r = followRefs(sk, outlineEntities([floor(2)[0]!, floor(2)[2]!]));
    // a point held to the broken edge's end, then moved: the solve doesn't pull it back
    const q: Entity = { id: 'q', type: 'point', position: { x: 0, y: 0 } };
    const tie: Constraint = { id: 'k', type: 'coincident', entityId: 'q', pointIndex: 0, targetEntityId: left.id, targetPointIndex: 0 };
    const solved = solveConstraints([...r.sketch.entities, q], [...r.sketch.constraints, tie]);
    expect(solved.entities.find((e) => e.id === 'q')).toMatchObject({ position: { x: 0, y: 0 } });
    // …nor is its expression set
    const withExpr: Sketch = { ...r.sketch, entities: r.sketch.entities.map((e) => (e.id === 'dx' ? { ...e, expression: '20' } : e)) };
    expect(resolveSketch(withExpr, {}).changed).toBe(false);
  });

  it('says which sketches have dimensions to their face edges', () => {
    expect(dimensionedToEdges(standoffs())).toBe(true);
    const s = standoffs();
    expect(dimensionedToEdges({ ...s, entities: s.entities.filter((e) => e.type !== 'dimension') })).toBe(false);
  });
});

describe('after a build', () => {
  const bound = (w: number): SketchBindings => ({
    Standoffs: { status: 'same', moved_by: 0, plane: { origin: [0, 0, 2], normal: [0, 0, 1], xAxis: [1, 0, 0] }, outline: floor(w) },
  });

  it('follows the face sketches the build reports outlines for, and says which profiles changed', () => {
    const other: Sketch = { ...standoffs(), id: 'sk2', name: 'Lid' };
    const sketches = [standoffs(2), other];
    const r = followPartSketches(sketches, bound(3));
    expect(r.changed).toEqual(['Standoffs']);
    expect(r.moved).toEqual(['Standoffs']);
    expect(r.profileChanged).toEqual(['Standoffs']);   // the point is part of the profile
    expect(r.sketches[1]).toBe(other);
    expect(followPartSketches(r.sketches, bound(3)).changed).toEqual([]);   // settled
    expect(followPartSketches(sketches, bound(2)).sketches).toBe(sketches);
    expect(followPartSketches(sketches, null).sketches).toBe(sketches);
  });

  it('builds once more when the follow changed a profile, and never twice more', async () => {
    const run = vi.fn(async () => 'built');
    // nothing to follow: one build
    expect(await buildFollowingSketches(run, () => false)).toEqual({ result: 'built', rebuilt: false, unsettled: false });
    expect(run).toHaveBeenCalledTimes(1);
    // a profile moved, then settled: two builds
    run.mockClear();
    let n = 0;
    expect(await buildFollowingSketches(run, () => n++ === 0)).toEqual({ result: 'built', rebuilt: true, unsettled: false });
    expect(run).toHaveBeenCalledTimes(2);
    // still moving after the rebuild: stops at two, unsettled
    run.mockClear();
    expect(await buildFollowingSketches(run, () => true)).toEqual({ result: 'built', rebuilt: true, unsettled: true });
    expect(run).toHaveBeenCalledTimes(2);
  });
});
