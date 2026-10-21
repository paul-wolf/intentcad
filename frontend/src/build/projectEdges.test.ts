import { describe, it, expect } from 'vitest';
import type { CircleEntity, Entity, LineEntity, Sketch } from '@/types/document';
import type { RunEdge } from '@/api/client';
import { matchProjected, pickCandidate, projectCandidates, projectEdge } from './projectEdges';
import { followRefs, brokenRefWarning } from './sketchRefs';
import { followPartSketches } from './sketchParams';
import { newFaceSketch, refreshOutline } from './faceSketch';
import { planeBasis } from './sketchPlane';
import { measureDimension } from '@/utils/resolveSketch';
import type { Vec3 } from './dragHandle';

// A case's lid, sketched on its top (z = 20, looking down: sketch x = world x,
// sketch y = −world y), over a standoff (a 3 mm radius post at (x, 5), from
// the floor at z = 3 up to z = 12) and the inner wall's top edge at y = 18.
const plane = { origin: [0, 0, 20] as Vec3, normal: [0, 0, 1] as Vec3, xAxis: [1, 0, 0] as Vec3 };
const b = planeBasis(plane);

function rim(index: number, cx: number, cy: number, z: number, r: number, faces: [number, number]): RunEdge {
  const polyline: Vec3[] = [];
  for (let i = 0; i <= 32; i++) {
    const t = (2 * Math.PI * i) / 32;
    polyline.push([cx + r * Math.cos(t), cy + r * Math.sin(t), z]);
  }
  const face = (n: Vec3) => ({ center: [cx, cy, z] as Vec3, normal: n, area: 1 });
  return {
    index, kind: 'circle', faceIndices: faces, polyline,
    ref: { faces: [face([0, 0, 1]), face([1, 0, 0])], kind: 'circle', midpoint: [cx + r, cy, z], length: 2 * Math.PI * r,
           center: [cx, cy, z], radius: r, axis: [0, 0, 1] },
  };
}

function edge(index: number, a: Vec3, c: Vec3, faces: [number, number]): RunEdge {
  const l = Math.hypot(c[0] - a[0], c[1] - a[1], c[2] - a[2]);
  const mid: Vec3 = [(a[0] + c[0]) / 2, (a[1] + c[1]) / 2, (a[2] + c[2]) / 2];
  return {
    index, kind: 'line', faceIndices: faces, polyline: [a, c],
    ref: { faces: [{ center: mid, normal: [0, 0, 1], area: 1 }, { center: mid, normal: [0, -1, 0], area: 1 }], kind: 'line',
           midpoint: mid, length: l, direction: [(c[0] - a[0]) / l, (c[1] - a[1]) / l, (c[2] - a[2]) / l] },
  };
}

/** The part's edges with the standoff at x = `sx`. */
const part = (sx: number, standoff = true): RunEdge[] => [
  ...(standoff ? [rim(0, sx, 5, 12, 3, [1, 2]), rim(1, sx, 5, 3, 3, [2, 3])] : []),
  edge(2, [-28, 18, 17], [28, 18, 17], [4, 5]),
  edge(3, [30, -20, 3], [30, -20, 17], [5, 6]),      // upright: seen end on from the lid
  edge(4, [-28, -18, 25], [28, -18, 25], [7, 8]),    // above the lid
];

/** A plane sketch on the lid with the standoff's top rim projected and a
 *  hole 10 mm to its right, dimensioned centre to centre. */
function lidSketch(): Sketch {
  const p = projectEdge(part(10)[0]!, b)!;
  return {
    id: 'sk', name: 'Lid', visible: true, plane,
    entities: [
      { ...p, id: 'p1' },
      { id: 'h', type: 'circle', center: { x: 20, y: -5 }, radius: 1.5 },
      { id: 'd', type: 'dimension', targetEntityId: 'p1', segmentIndex: 0, pointIndex: 0, targetEntityId2: 'h', pointIndex2: 0, offset: 3 },
    ],
    constraints: [{ id: 'c1', type: 'fixed', entityId: 'p1' }],
  };
}

const byId = (s: Sketch, id: string) => s.entities.find((e) => e.id === id)!;

describe('projecting part edges onto a sketch', () => {
  it('flattens a circle and a line onto the plane, keeping what the build said of the edge', () => {
    const c = projectEdge(part(10)[0]!, b) as CircleEntity;
    expect(c.type).toBe('circle');
    expect(c.center.x).toBeCloseTo(10, 6);
    expect(c.center.y).toBeCloseTo(-5, 6);
    expect(c.radius).toBeCloseTo(3, 6);
    expect(c).toMatchObject({ construction: true, reference: true, edgeRef: { kind: 'circle', radius: 3 } });
    const l = projectEdge(part(10)[2]!, b) as LineEntity;
    expect(l.points.map((p) => [p.x, p.y])).toEqual([[-28, -18], [28, -18]]);
    expect(l.bulge).toBeUndefined();
    // an upright edge is a point from above: nothing to project
    expect(projectEdge(part(10)[3]!, b)).toBeNull();
    // a seam (no description) isn't projected
    expect(projectEdge({ ...part(10)[2]!, ref: null }, b)).toBeNull();
  });

  it('picks the edge nearest the viewer where two lie over each other, and leaves out the part cut away', () => {
    const cands = projectCandidates(part(10), b, true);
    expect(cands.map((c) => c.index).sort()).toEqual([0, 1, 2]);   // not end on, not above a face sketch
    expect(projectCandidates(part(10), b, false).map((c) => c.index).sort()).toEqual([0, 1, 2, 4]);
    expect(pickCandidate(cands, { x: 13.05, y: -5 }, 0.5)?.index).toBe(0);   // the top rim, not the bottom one
    expect(pickCandidate(cands, { x: 0, y: -18.2 }, 0.5)?.index).toBe(2);
    expect(pickCandidate(cands, { x: 0, y: 0 }, 0.5)).toBeNull();
  });

  it('follows the standoff when the part changes: the same id, and the hole keeps its distance', () => {
    const s = lidSketch();
    expect(measureDimension(byId(s, 'd'), s.entities)).toBeCloseTo(10, 6);
    const map = matchProjected(s, part(14), b);
    expect([...map.keys()]).toEqual(['p1']);
    const r = followRefs(s, [], undefined, map);
    expect(r.changed && r.moved).toBe(true);
    const p1 = byId(r.sketch, 'p1') as CircleEntity;
    expect(p1.center.x).toBeCloseTo(14, 6);
    expect(p1.edgeRef?.center).toEqual([14, 5, 12]);
    expect(measureDimension(byId(r.sketch, 'd'), r.sketch.entities)).toBeCloseTo(10, 6);
    expect((byId(r.sketch, 'h') as CircleEntity).center.x).toBeCloseTo(24, 6);
    // and the same after a build, for a sketch on a plane (no face)
    const f = followPartSketches([s], null, null, part(14), null);
    expect(f.changed).toEqual(['Lid']);
    expect((byId(f.sketches[0]!, 'p1') as CircleEntity).center.x).toBeCloseTo(14, 6);
    // nothing moved: nothing changes
    expect(followPartSketches([s], null, null, part(10), null).changed).toEqual([]);
  });

  it('keeps a projection whose edge has gone, marked broken, and mends it when the edge is back', () => {
    const s = lidSketch();
    const gone = followRefs(s, [], undefined, matchProjected(s, part(10, false), b));
    expect(byId(gone.sketch, 'p1')).toMatchObject({ broken: true });
    expect(gone.broken).toEqual(['p1']);
    expect(byId(gone.sketch, 'd')).toBeDefined();
    expect(brokenRefWarning(gone.sketch)).toMatch(/1 dimension refers to an edge that no longer exists/);
    // a different edge isn't taken for it (the wall's line is another kind)
    expect(matchProjected(s, part(10, false), b).get('p1')).toBeNull();
    const back = followRefs(gone.sketch, [], undefined, matchProjected(gone.sketch, part(10), b));
    expect('broken' in byId(back.sketch, 'p1')).toBe(false);
    expect(back.broken).toEqual([]);
  });

  it("isn't dropped by a face sketch's outline following its face", () => {
    // the lid's top face, 60 x 40, and the standoff projected onto it
    const top = (w: number): RunEdge[] => {
      const c: Vec3[] = [[-w / 2, -20, 20], [w / 2, -20, 20], [w / 2, 20, 20], [-w / 2, 20, 20]];
      return c.map((p, i) => ({ index: 10 + i, kind: 'line', faceIndices: [9, 30 + i], polyline: [p, c[(i + 1) % 4]!] }));
    };
    const face = (w: number) => ({ index: 9, center: [0, 0, 20] as Vec3, normal: [0, 0, 1] as Vec3, area: w * 40 });
    const s = newFaceSketch('Lid', face(60), top(60));
    s.plane = plane;
    const outlineIds = s.entities.map((e) => e.id);
    s.entities.push({ ...projectEdge(part(10)[0]!, b)!, id: 'p1' } as Entity);
    s.constraints.push({ id: 'cp', type: 'fixed', entityId: 'p1' });
    // unchanged part: nothing to do
    expect(refreshOutline(s, face(60), [...top(60), ...part(10)], plane)).toBeNull();
    // the case widens and the standoff moves: the outline follows its face, the projection its edge
    const r = refreshOutline(s, face(80), [...top(80), ...part(16)], plane)!;
    expect(r.entities.filter((e) => outlineIds.includes(e.id))).toHaveLength(4);
    expect((byId(r, 'p1') as CircleEntity).center.x).toBeCloseTo(16, 6);
    // without the part's other edges (the outline alone), the projection stays as it was
    const alone = followRefs(s, refreshOutline(s, face(80), top(80), plane)!.entities.filter((e) => outlineIds.includes(e.id)));
    expect(byId(alone.sketch, 'p1')).toEqual(byId(s, 'p1'));
  });
});
