import { describe, it, expect } from 'vitest';
import type { Sketch } from '@/types/document';
import type { RunEdge } from '@/api/client';
import {
  boundPlane, findFaceSketch, lostSketches, moveFaceSketch, newFaceSketch, sketchBindNotes, sketchProfile, sketchSegments,
  type SketchBindings,
} from './faceSketch';
import { planeBasis, sketchToWorld, worldToSketch } from './sketchPlane';
import type { Vec3 } from './dragHandle';

// the top of a 60 x 40 plate, 6 thick: face 3, its four edges
const corners: Vec3[] = [[-30, -20, 6], [30, -20, 6], [30, 20, 6], [-30, 20, 6]];
const edges: RunEdge[] = corners.map((p, i) => ({
  index: i, kind: 'line', faceIndices: [3, 10 + i], polyline: [p, corners[(i + 1) % 4]!],
}));
const top = { index: 3, center: [0, 0, 6] as Vec3, normal: [0, 0, 1] as Vec3, area: 2400 };

function holeSketch(): Sketch {
  const s = newFaceSketch('Hole', top, edges);
  s.entities.push({ id: 'h', type: 'circle', center: { x: 10, y: 5 }, radius: 2.5 });
  return s;
}
// the plate made 10 thick: the build found the top 4 mm up
const thicker = (s: Sketch): SketchBindings => ({
  [s.name]: { status: 'moved', moved_by: 4, plane: { ...s.plane!, origin: [0, 0, 10] } },
});

describe('face record', () => {
  it('keeps the outline box in plane (u, v), its perimeter, edge count and a hint', () => {
    const f = holeSketch().face!;
    expect(f.box).toEqual([-30, -20, 30, 20]);
    expect(f.perimeter).toBeCloseTo(200, 6);
    expect(f.edges).toBe(4);
    expect(f.hint).toBe('top face');
    expect(f.area).toBe(2400);
  });

  it('goes to the build with the profile', () => {
    const s = holeSketch();
    expect(sketchProfile(s)!.face).toEqual(s.face);
    // a sketch from before the box was kept still sends what it has
    const old = { ...s, face: { center: top.center, normal: top.normal, area: top.area } };
    expect(sketchProfile(old)!.face).toEqual({ center: [0, 0, 6], normal: [0, 0, 1], area: 2400 });
  });

  it('maps world → sketch → world and plane (u, v) = (x, −y)', () => {
    const s = holeSketch();
    const b = planeBasis(s.plane!);
    for (const p of corners) {
      const q = worldToSketch(b, p);
      expect(sketchToWorld(b, q).map((x) => Math.round(x * 1e9) / 1e9)).toEqual(p);
      // the box is in (u, v): u = sketch x, v = −sketch y — here world x, y
      expect([q.x, -q.y]).toEqual([p[0], p[1]]);
    }
    // on the rebound plane a sketch point keeps its place across the face, 4 mm up
    const moved = planeBasis(boundPlane(s, thicker(s))!);
    const a = sketchToWorld(b, { x: 10, y: 5 }), c = sketchToWorld(moved, { x: 10, y: 5 });
    expect([c[0] - a[0], c[1] - a[1], c[2] - a[2]].map((x) => Math.round(x * 1e9) / 1e9)).toEqual([0, 0, 4]);
  });
});

describe('a sketch where the last build put it', () => {
  it('is found from its face at the new height, not duplicated', () => {
    const s = holeSketch();
    const face10 = { ...top, center: [0, 0, 10] as Vec3 };
    expect(findFaceSketch([s], face10)).toBeNull();              // the stored plane is still z=6
    expect(findFaceSketch([s], face10, thicker(s))).toBe(s);
    expect(findFaceSketch([s], top, thicker(s))).toBeNull();     // nothing is at z=6 any more
  });

  it('is drawn on the rebound plane, and the stored plane is left alone', () => {
    const s = holeSketch();
    const seg = sketchSegments(s, boundPlane(s, thicker(s)));
    expect(seg.length).toBeGreaterThan(0);
    for (let i = 2; i < seg.length; i += 3) expect(seg[i]).toBeCloseTo(10, 9);
    expect(sketchSegments(s).every((v, i) => i % 3 !== 2 || Math.abs(v - 6) < 1e-9)).toBe(true);
    expect(s.plane!.origin).toEqual([0, 0, 6]);
  });

  it('falls back to the stored plane when the build says nothing about it', () => {
    const s = holeSketch();
    expect(boundPlane(s, null)).toBe(s.plane);
    expect(boundPlane(s, { Other: thicker(s)[s.name]! })).toBe(s.plane);
  });
});

describe('status line notes', () => {
  it('counts the sketches that followed their faces and warns about the ambiguous (a lost one fails its step)', () => {
    const a = holeSketch();
    const b = { ...newFaceSketch('USB cutout', { index: 5, center: [30, 0, 3], normal: [1, 0, 0], area: 240 }, []) };
    const c = { ...newFaceSketch('Boss hole', top, edges) };
    const base: Sketch = { id: 'p', name: 'Rib', visible: true, entities: [], constraints: [],
                           plane: { origin: [0, 0, 0], normal: [0, -1, 0], xAxis: [1, 0, 0] } };
    const plane = a.plane!;
    const up = { ...plane, origin: [0, 0, 10] as Vec3 };
    const now: SketchBindings = {
      Hole: { status: 'moved', moved_by: 4, plane: up },
      'USB cutout': { status: 'not_found', moved_by: 0, plane: b.plane! },
      'Boss hole': { status: 'ambiguous', moved_by: 0, plane },
      Rib: { status: 'same', moved_by: 0, plane: base.plane! },
    };
    // the build before had the hole at z=6: it followed its face this time
    const before: SketchBindings = { ...now, Hole: { status: 'same', moved_by: 0, plane } };
    const notes = sketchBindNotes(now, [a, b, c, base], before);
    expect(notes.moved).toBe(1);
    expect(notes.warnings).toEqual([
      "Sketch 'Boss hole' matched more than one face (top face); used the closest",
    ]);
    expect(sketchBindNotes(undefined, [a])).toEqual({ moved: 0, warnings: [] });
  });

  it('says a sketch followed its face only when it is somewhere else than the build before put it', () => {
    const a = holeSketch();
    const up: SketchBindings = { Hole: { status: 'moved', moved_by: 4, plane: { ...a.plane!, origin: [0, 0, 10] } } };
    // still 4 mm up from where it was drawn, but where the last build had it too (another parameter changed)
    expect(sketchBindNotes(up, [a], up).moved).toBe(0);
    expect(sketchBindNotes(up, [a], structuredClone(up)).moved).toBe(0);
    // a first build has nothing to compare with
    expect(sketchBindNotes(up, [a], null).moved).toBe(0);
    expect(sketchBindNotes(up, [a], { Hole: { status: 'same', moved_by: 0, plane: a.plane! } }).moved).toBe(1);
  });
});

describe('a sketch that lost its face', () => {
  const lost = (s: Sketch): SketchBindings => ({ [s.name]: { status: 'not_found', moved_by: 0, plane: s.plane! } });

  it('is offered by K on another face, only when the last build lost it', () => {
    const a = holeSketch();
    const base: Sketch = { id: 'p', name: 'Base', visible: true, entities: [], constraints: [],
                           plane: { origin: [0, 0, 0], normal: [0, 0, 1], xAxis: [1, 0, 0] } };
    expect(lostSketches([a, base], lost(a)).map((s) => s.name)).toEqual(['Hole']);
    expect(lostSketches([a, base], thicker(a))).toEqual([]);
    expect(lostSketches([a, base], null)).toEqual([]);
    // a plane sketch has no face to lose
    expect(lostSketches([base], { Base: { status: 'not_found', moved_by: 0, plane: base.plane! } })).toEqual([]);
  });

  it('is shown on its own plane, not where the build lost it', () => {
    const a = holeSketch();
    const side = { index: 5, center: [30, 0, 3] as Vec3, normal: [1, 0, 0] as Vec3, area: 240 };
    const m = moveFaceSketch(a, side, []);
    expect(boundPlane(m, lost(a))).toBe(m.plane);
    expect(boundPlane(m, thicker(a))).not.toBe(m.plane);
  });

  it('moved onto a face facing the same way keeps what is drawn where it was, seen from above', () => {
    const a = holeSketch();
    a.constraints.push({ id: 'k', type: 'fixed', entityId: 'h' });
    // the top is now a 40 x 40 face at z = 9, off to one side
    const c2: Vec3[] = [[0, 0, 9], [40, 0, 9], [40, 40, 9], [0, 40, 9]];
    const e2: RunEdge[] = c2.map((p, i) => ({ index: i, kind: 'line', faceIndices: [7, 20 + i], polyline: [p, c2[(i + 1) % 4]!] }));
    const face = { index: 7, center: [20, 20, 9] as Vec3, normal: [0, 0, 1] as Vec3, area: 1600 };
    const m = moveFaceSketch(a, face, e2);
    expect(m.id).toBe(a.id);
    expect(m.name).toBe('Hole');
    expect(m.plane!.origin).toEqual([0, 0, 9]);
    expect(m.plane!.xAxis).toEqual(a.plane!.xAxis);
    expect(m.face).toMatchObject({ center: [20, 20, 9], area: 1600, box: [0, 0, 40, 40], edges: 4, hint: 'top face' });
    // the circle is kept with its constraint; the old outline's four lines are the new face's
    const hole = m.entities.find((e) => e.id === 'h')!;
    expect(hole).toEqual(a.entities.find((e) => e.id === 'h'));
    expect(m.constraints.some((c) => c.id === 'k')).toBe(true);
    const oldRefs = new Set(a.entities.filter((e) => e.id !== 'h').map((e) => e.id));
    expect(m.entities.some((e) => oldRefs.has(e.id))).toBe(false);
    expect(m.entities.length).toBe(5);
    expect(m.constraints.length).toBe(5);
    expect(m.constraints.every((c) => !('entityId' in c) || !oldRefs.has(c.entityId as string))).toBe(true);
  });

  it('moved onto a side face is placed as a new sketch there', () => {
    const a = holeSketch();
    const side = { index: 5, center: [30, 0, 3] as Vec3, normal: [1, 0, 0] as Vec3, area: 240 };
    const m = moveFaceSketch(a, side, []);
    expect(m.plane).toEqual(newFaceSketch('x', side, []).plane);
    expect(m.face!.hint).toBe('right face');
    expect(m.entities.map((e) => e.id)).toEqual(['h']);
  });
});
