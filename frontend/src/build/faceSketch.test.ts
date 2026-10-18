import { describe, it, expect } from 'vitest';
import type { Entity, Sketch } from '@/types/document';
import { sketchLoops, sketchProfile } from './faceSketch';

const sketch = (entities: Entity[], plane = true): Sketch => ({
  id: 'sk', name: 'S', visible: true, constraints: [], entities,
  ...(plane ? { plane: { origin: [0, 0, 6], normal: [0, 0, 1], xAxis: [1, 0, 0] } } : {}),
});
const line = (id: string, pts: [number, number][], extra: Partial<Entity> = {}): Entity =>
  ({ id, type: 'line', points: pts.map(([x, y]) => ({ x, y })), ...extra }) as Entity;

describe('sketchLoops', () => {
  it('takes circles, rectangles and closed polylines as they are', () => {
    const { loops, open } = sketchLoops(sketch([
      { id: 'c', type: 'circle', center: { x: 1, y: 2 }, radius: 3 },
      { id: 'r', type: 'rectangle', center: { x: 0, y: 0 }, width: 20, height: 10 },
      line('p', [[0, 0], [5, 0], [5, 5]], { closed: true }),
    ]));
    expect(open).toBe(0);
    expect(loops.map((l) => l.length)).toEqual([1, 4, 3]);
    expect(loops[0]![0]).toEqual({ t: 'circle', c: [1, 2], r: 3 });
  });

  it('skips construction geometry (the face outline)', () => {
    const { loops } = sketchLoops(sketch([
      { id: 'c', type: 'circle', center: { x: 0, y: 0 }, radius: 3, construction: true },
    ]));
    expect(loops).toEqual([]);
  });

  it('turns a filleted rectangle and bulged segments into arcs', () => {
    const { loops } = sketchLoops(sketch([
      { id: 'r', type: 'rectangle', center: { x: 0, y: 0 }, width: 20, height: 10, cornerRadius: 2 },
    ]));
    expect(loops[0]!.map((s) => s.t)).toEqual(['line', 'arc', 'line', 'arc', 'line', 'arc', 'line', 'arc']);
    const arc = loops[0]![1]!;
    if (arc.t !== 'arc') throw new Error('expected an arc');
    // the TR corner arc runs (8,5)→(10,3) about (8,3): its midpoint is r from the centre
    expect(Math.hypot(arc.p[1][0] - 8, arc.p[1][1] - 3)).toBeCloseTo(2, 5);
  });

  it('chains loose lines end to end, reversing pieces drawn backwards', () => {
    const { loops, open } = sketchLoops(sketch([
      line('a', [[0, 0], [10, 0]]),
      line('b', [[10, 10], [10, 0]]),          // drawn the other way
      line('c', [[10, 10], [0, 10], [0, 0]]),
    ]));
    expect(open).toBe(0);
    expect(loops).toHaveLength(1);
    const pts = loops[0]!.map((s) => (s.t === 'line' ? s.p : null));
    expect(pts).toEqual([[[0, 0], [10, 0]], [[10, 0], [10, 10]], [[10, 10], [0, 10]], [[0, 10], [0, 0]]]);
  });

  it('closes a line with a bezier', () => {
    const { loops } = sketchLoops(sketch([
      line('a', [[0, 0], [10, 0]]),
      { id: 'b', type: 'bezier', controlPoints: [{ x: 0, y: 0 }, { x: 2, y: 8 }, { x: 8, y: 8 }, { x: 10, y: 0 }] },
    ]));
    expect(loops).toHaveLength(1);
    expect(loops[0]!.map((s) => s.t)).toEqual(['line', 'bezier']);
    const b = loops[0]![1]!;
    expect(b.t === 'bezier' && b.p[0]).toEqual([10, 0]);   // reversed to continue from the line's end
  });

  it('counts chains that do not close', () => {
    const { loops, open } = sketchLoops(sketch([line('a', [[0, 0], [10, 0], [10, 10]]), line('b', [[50, 50], [60, 50]])]));
    expect(loops).toEqual([]);
    expect(open).toBe(2);
  });
});

describe('sketchProfile', () => {
  it('carries the plane, and is null off a face', () => {
    const s = sketch([{ id: 'c', type: 'circle', center: { x: 0, y: 0 }, radius: 1 }]);
    expect(sketchProfile(s)!.plane.origin).toEqual([0, 0, 6]);
    expect(sketchProfile(sketch([], false))).toBeNull();
  });
});
