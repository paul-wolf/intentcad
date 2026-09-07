import { describe, it, expect } from 'vitest';
import type { Entity, RectangleEntity } from '@/types/document';
import { ViewportImpl } from '@/rendering/viewport';
import { hitTestEntities, hitTestSegment } from '@/hittest/hitTest';

// 40×40mm at the origin with a 10mm fillet, at 4 px/mm: the fillet is 40px on
// screen, so a sharp-corner hit test would sit ~11.7px off the real arc —
// well outside HIT_TOL (8px) and therefore unclickable.
const rect: RectangleEntity = {
  id: 'r1',
  type: 'rectangle',
  center: { x: 0, y: 0 },
  width: 40,
  height: 40,
  cornerRadius: 10,
};
const entities: Entity[] = [rect];
const viewport = new ViewportImpl(400, 400, { x: 200, y: 200 }, 4);
const screen = (x: number, y: number) => viewport.worldToScreen({ x, y });

/** The point on the top-right fillet arc at 45° — the arc's furthest excursion
 *  from the sharp corner it replaces. */
const onArc = () => {
  const d = 10 + 10 * Math.SQRT1_2; // centre 10mm in, then one radius out at 45°
  return screen(d, d);
};

describe('hit testing a filleted rectangle', () => {
  it('picks the entity when clicking on the corner arc itself', () => {
    expect(hitTestEntities(onArc(), entities, viewport)?.id).toBe('r1');
  });

  it('does not pick it at the sharp corner the arc has cut away', () => {
    expect(hitTestEntities(screen(20, 20), entities, viewport)).toBeNull();
  });

  it('still picks straight edges', () => {
    expect(hitTestEntities(screen(0, 20), entities, viewport)?.id).toBe('r1');
    expect(hitTestEntities(screen(20, 0), entities, viewport)?.id).toBe('r1');
  });

  it('reports arcs under one of the four edge indices dimensions understand', () => {
    const hit = hitTestSegment(onArc(), entities, viewport);
    expect(hit?.entityId).toBe('r1');
    // The TR arc is attributed to edge 0 (TL→TR), the edge running into it.
    expect(hit?.segmentIndex).toBe(0);
  });

  it('keeps square rectangles behaving exactly as before', () => {
    const square: Entity[] = [{ ...rect, cornerRadius: undefined }];
    expect(hitTestEntities(screen(20, 20), square, viewport)?.id).toBe('r1');
    // Edge 0 is TL→TR, the y = +20 side; the opposite side is edge 2.
    expect(hitTestSegment(screen(0, 20), square, viewport)?.segmentIndex).toBe(0);
    expect(hitTestSegment(screen(0, -20), square, viewport)?.segmentIndex).toBe(2);
  });
});
