import { describe, it, expect } from 'vitest';
import type { RectangleEntity } from '@/types/document';
import { arcFromBulge } from '@/utils/arcGeometry';
import {
  rectanglePath,
  rectangleCorners,
  rectangleOutline,
  effectiveCornerRadius,
  maxCornerRadius,
} from '@/utils/rectPath';

const rect = (over: Partial<RectangleEntity> = {}): RectangleEntity => ({
  id: 'r1',
  type: 'rectangle',
  center: { x: 0, y: 0 },
  width: 20,
  height: 20,
  ...over,
});

describe('rectanglePath', () => {
  it('returns the four sharp corners when there is no fillet', () => {
    const p = rectanglePath(rect());
    expect(p.points).toEqual(rectangleCorners(rect()));
    expect(p.bulge).toEqual([0, 0, 0, 0]);
  });

  it('treats a zero or negative radius as square', () => {
    expect(rectanglePath(rect({ cornerRadius: 0 })).points).toHaveLength(4);
    expect(rectanglePath(rect({ cornerRadius: -3 })).points).toHaveLength(4);
  });

  it('emits eight points with arcs on the odd segments when filleted', () => {
    const p = rectanglePath(rect({ cornerRadius: 2 }));
    expect(p.points).toHaveLength(8);
    expect(p.bulge.filter((b) => b !== 0)).toHaveLength(4);
    expect(p.bulge.map((b) => b !== 0)).toEqual([false, true, false, true, false, true, false, true]);
  });

  it('places every arc centre inward, one radius in from each sharp corner', () => {
    const r = 2;
    const e = rect({ cornerRadius: r });
    const { points, bulge } = rectanglePath(e);
    // Expected arc centres, in the order the arcs appear along the path
    // (TR, BR, BL, TL) — each is the sharp corner pulled r inward on both axes.
    const expected = [
      { x: 8, y: 8 },
      { x: 8, y: -8 },
      { x: -8, y: -8 },
      { x: -8, y: 8 },
    ];
    let seen = 0;
    for (let i = 0; i < points.length; i++) {
      if (bulge[i] === 0) continue;
      const arc = arcFromBulge(points[i]!, points[(i + 1) % points.length]!, bulge[i]!);
      expect(arc.radius).toBeCloseTo(r, 9);
      expect(arc.center.x).toBeCloseTo(expected[seen]!.x, 9);
      expect(arc.center.y).toBeCloseTo(expected[seen]!.y, 9);
      seen++;
    }
    expect(seen).toBe(4);
  });

  it('keeps every path point on the rectangle boundary', () => {
    const e = rect({ width: 30, height: 10, cornerRadius: 3, center: { x: 5, y: -4 } });
    for (const p of rectanglePath(e).points) {
      const onVertical = Math.abs(Math.abs(p.x - 5) - 15) < 1e-9;
      const onHorizontal = Math.abs(Math.abs(p.y + 4) - 5) < 1e-9;
      expect(onVertical || onHorizontal).toBe(true);
    }
  });

  it('clamps the radius to half the shorter side', () => {
    expect(maxCornerRadius(20, 10)).toBe(5);
    expect(effectiveCornerRadius(rect({ height: 10, cornerRadius: 99 }))).toBe(5);
    // Fully clamped: the two arcs on a short side meet, forming a stadium.
    const p = rectanglePath(rect({ height: 10, cornerRadius: 99 }));
    expect(p.points[2]).toEqual(p.points[3]);
  });
});

describe('rectangleOutline', () => {
  it('passes square rectangles through untouched', () => {
    expect(rectangleOutline(rect())).toEqual(rectangleCorners(rect()));
  });

  it('flattens arcs onto the true fillet radius', () => {
    const r = 4;
    const e = rect({ cornerRadius: r });
    const pts = rectangleOutline(e);
    expect(pts.length).toBeGreaterThan(8);
    // Every sampled point must lie on the rounded-rect boundary: clamp to the
    // straight-edge core, and the leftover offset is either 0 or exactly r.
    for (const p of pts) {
      const dx = Math.max(0, Math.abs(p.x) - (10 - r));
      const dy = Math.max(0, Math.abs(p.y) - (10 - r));
      const d = Math.hypot(dx, dy);
      expect(Math.abs(d - r) < 1e-9 || d < 1e-9).toBe(true);
    }
    // And it must not cut the corner: some sample sits near the 45° point.
    const diag = (10 - r) + r * Math.SQRT1_2;
    expect(pts.some((p) => Math.abs(p.x - diag) < 0.05 && Math.abs(p.y - diag) < 0.05)).toBe(true);
  });
});
