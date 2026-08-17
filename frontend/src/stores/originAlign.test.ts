import { describe, it, expect, beforeEach } from 'vitest';
import { useDocumentStore } from '@/stores/documentStore';
import { entityBounds } from '@/utils/bounds';
import type { Entity } from '@/types/document';

/** A square plate drawn far from the origin, as CAD exports of a part taken
 *  from a larger assembly typically are. */
function plateFarFromOrigin(prefix: string): Entity[] {
  const x0 = 12000, y0 = -5000, size = 400;
  return [
    {
      id: `${prefix}_outline`,
      type: 'line',
      points: [
        { x: x0, y: y0 },
        { x: x0 + size, y: y0 },
        { x: x0 + size, y: y0 + size },
        { x: x0, y: y0 + size },
      ],
      closed: true,
    },
    {
      id: `${prefix}_hole`,
      type: 'circle',
      center: { x: x0 + size / 2, y: y0 + size / 2 },
      radius: 25,
    },
  ] as Entity[];
}

function activeEntities() {
  const d = useDocumentStore.getState().document;
  return d.sketches.find((s) => s.id === d.activeSketchId)!.entities;
}

function boundsOf(ids: string[]) {
  return entityBounds(activeEntities().filter((e) => ids.includes(e.id)))!;
}

describe('alignToOrigin', () => {
  let importedIds: string[];

  beforeEach(() => {
    useDocumentStore.getState().addSketch('test');
    for (const e of plateFarFromOrigin('imported')) {
      useDocumentStore.getState().addEntity(e);
    }
    importedIds = ['imported_outline', 'imported_hole'];
  });

  it('centres the bounding box on the origin', () => {
    useDocumentStore.getState().alignToOrigin('center', importedIds);
    const b = boundsOf(importedIds);
    expect((b.min.x + b.max.x) / 2).toBeCloseTo(0, 6);
    expect((b.min.y + b.max.y) / 2).toBeCloseTo(0, 6);
    // size is preserved — this is a translation, not a fit
    expect(b.max.x - b.min.x).toBeCloseTo(400, 6);
    expect(b.max.y - b.min.y).toBeCloseTo(400, 6);
  });

  it('puts the lower-left corner on the origin in min mode', () => {
    useDocumentStore.getState().alignToOrigin('min', importedIds);
    const b = boundsOf(importedIds);
    expect(b.min.x).toBeCloseTo(0, 6);
    expect(b.min.y).toBeCloseTo(0, 6);
  });

  it('is a no-op in none mode', () => {
    const before = boundsOf(importedIds);
    useDocumentStore.getState().alignToOrigin('none', importedIds);
    expect(boundsOf(importedIds)).toEqual(before);
  });

  // The regression: aligning used to measure and move the whole active sketch,
  // so importing next to existing geometry left the import off-origin and
  // dragged the existing work thousands of units away with it.
  it('leaves pre-existing sketch geometry untouched', () => {
    useDocumentStore.getState().addEntity({
      id: 'pre_existing',
      type: 'circle',
      center: { x: 500, y: 500 },
      radius: 10,
    } as Entity);

    useDocumentStore.getState().alignToOrigin('center', importedIds);

    const imported = boundsOf(importedIds);
    expect((imported.min.x + imported.max.x) / 2).toBeCloseTo(0, 6);
    expect((imported.min.y + imported.max.y) / 2).toBeCloseTo(0, 6);

    const pre = boundsOf(['pre_existing']);
    expect((pre.min.x + pre.max.x) / 2).toBeCloseTo(500, 6);
    expect((pre.min.y + pre.max.y) / 2).toBeCloseTo(500, 6);
  });

  // A CNC touch-off marker sits outside the outline. It has to survive the
  // import (it is what the operator zeroes on) but must not skew the box the
  // part is centred by — otherwise the plate lands off-centre by half the
  // marker's overhang.
  describe('reference/datum markers', () => {
    const MARKER = 'imported_datum';

    beforeEach(() => {
      // r1.5 circle tangent to the plate's left edge, as in the real DXF:
      // it hangs 3.0 past the outline and so widens the box by 3.
      useDocumentStore.getState().addEntity({
        id: MARKER,
        type: 'circle',
        center: { x: 12000 - 1.5, y: -5000 + 200 },
        radius: 1.5,
        reference: true,
      } as Entity);
      importedIds = ['imported_outline', 'imported_hole', MARKER];
    });

    it('excludes the marker from the bounding box it centres by', () => {
      useDocumentStore.getState().alignToOrigin('center', importedIds);

      const plate = boundsOf(['imported_outline']);
      expect((plate.min.x + plate.max.x) / 2).toBeCloseTo(0, 6);
      expect((plate.min.y + plate.max.y) / 2).toBeCloseTo(0, 6);
    });

    it('still moves the marker with the part, preserving its offset', () => {
      const before = boundsOf([MARKER]);
      const plateBefore = boundsOf(['imported_outline']);

      useDocumentStore.getState().alignToOrigin('center', importedIds);

      const after = boundsOf([MARKER]);
      const plateAfter = boundsOf(['imported_outline']);
      // marker keeps its exact relationship to the outline
      expect(after.min.x - plateAfter.min.x).toBeCloseTo(before.min.x - plateBefore.min.x, 6);
      expect(after.min.y - plateAfter.min.y).toBeCloseTo(before.min.y - plateBefore.min.y, 6);
      // and it did actually move
      expect(after.min.x).not.toBeCloseTo(before.min.x, 3);
    });

    it('an unflagged marker does skew the box (the bug being guarded against)', () => {
      useDocumentStore.getState().toggleReference([MARKER]);
      useDocumentStore.getState().alignToOrigin('center', importedIds);

      const plate = boundsOf(['imported_outline']);
      // marker hangs 3 units past the left edge -> plate pushed right by 1.5
      expect((plate.min.x + plate.max.x) / 2).toBeCloseTo(1.5, 6);
    });

    it('measures markers when the selection is nothing but markers', () => {
      useDocumentStore.getState().alignToOrigin('center', [MARKER]);
      const b = boundsOf([MARKER]);
      expect((b.min.x + b.max.x) / 2).toBeCloseTo(0, 6);
      expect((b.min.y + b.max.y) / 2).toBeCloseTo(0, 6);
    });
  });

  it('aligns the whole sketch when no subset is given', () => {
    useDocumentStore.getState().addEntity({
      id: 'other',
      type: 'circle',
      center: { x: 12000, y: -5000 },
      radius: 10,
    } as Entity);

    useDocumentStore.getState().alignToOrigin('center', null);

    const all = entityBounds(activeEntities())!;
    expect((all.min.x + all.max.x) / 2).toBeCloseTo(0, 6);
    expect((all.min.y + all.max.y) / 2).toBeCloseTo(0, 6);
  });
});
