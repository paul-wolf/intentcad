import { describe, it, expect } from 'vitest';
import type { Document, RectangleEntity } from '@/types/document';
import { exportDocumentToDxf } from '@/export/dxf';
import { entityToSegments } from '@/cam/entityToSegments';
import { arcFromBulge } from '@/utils/arcGeometry';

const rect: RectangleEntity = {
  id: 'r1',
  type: 'rectangle',
  center: { x: 0, y: 0 },
  width: 20,
  height: 20,
  cornerRadius: 2,
};

const doc = (entity: RectangleEntity): Document => ({
  id: 'd1',
  name: 'doc',
  activeSketchId: 's1',
  sketches: [{ id: 's1', name: 'Sketch1', visible: true, entities: [entity], constraints: [] }],
});

/** Pull the LWPOLYLINE vertices and bulges out of a DXF group-code stream.
 *  DXF alternates (code, value) lines, so this must walk in pairs — scanning
 *  every line would read a coordinate of "10" as a group code. */
function readPolyline(dxf: string): { x: number; y: number; bulge: number }[] {
  const g = dxf.split('\n');
  const start = g.indexOf('LWPOLYLINE');
  expect(start).toBeGreaterThan(-1);
  const verts: { x: number; y: number; bulge: number }[] = [];
  for (let i = start + 1; i < g.length - 1; i += 2) {
    const code = g[i];
    const value = g[i + 1]!;
    if (code === '0') break; // next entity
    if (code === '10') verts.push({ x: Number(value), y: NaN, bulge: 0 });
    else if (code === '20') verts[verts.length - 1]!.y = Number(value);
    else if (code === '42') verts[verts.length - 1]!.bulge = Number(value);
  }
  expect(verts.every((v) => isFinite(v.x) && isFinite(v.y))).toBe(true);
  return verts;
}

describe('DXF export of a filleted rectangle', () => {
  it('still writes 4 plain vertices when there is no fillet', () => {
    const verts = readPolyline(exportDocumentToDxf(doc({ ...rect, cornerRadius: undefined })));
    expect(verts).toHaveLength(4);
    expect(verts.every((v) => v.bulge === 0)).toBe(true);
  });

  it('writes 8 vertices with a bulge on each corner', () => {
    const verts = readPolyline(exportDocumentToDxf(doc(rect)));
    expect(verts).toHaveLength(8);
    expect(verts.filter((v) => v.bulge !== 0)).toHaveLength(4);
  });

  it('orients the corner arcs convex-outward in DXF Y-up space', () => {
    const verts = readPolyline(exportDocumentToDxf(doc(rect)));
    // The exported outline is CCW in DXF space, so a convex fillet is a
    // positive (counter-clockwise) bulge. A sign slip here would cut the arc
    // the wrong way round — a visibly wrong part, so pin it.
    for (const v of verts) {
      if (v.bulge !== 0) expect(v.bulge).toBeCloseTo(Math.tan(Math.PI / 8), 9);
    }
    // Each arc must curve about a centre 2mm inside the corner, not outside it.
    for (let i = 0; i < verts.length; i++) {
      if (verts[i]!.bulge === 0) continue;
      const a = verts[i]!;
      const b = verts[(i + 1) % verts.length]!;
      const arc = arcFromBulge({ x: a.x, y: a.y }, { x: b.x, y: b.y }, a.bulge);
      expect(arc.radius).toBeCloseTo(2, 9);
      expect(Math.abs(arc.center.x)).toBeCloseTo(8, 9);
      expect(Math.abs(arc.center.y)).toBeCloseTo(8, 9);
    }
  });
});

describe('CAM segments for a filleted rectangle', () => {
  it('emits 4 straight segments when there is no fillet', () => {
    const segs = entityToSegments([{ ...rect, cornerRadius: undefined }], ['r1']);
    expect(segs).toHaveLength(4);
    expect(segs.every((s) => s.bulge === 0)).toBe(true);
  });

  it('emits a closed 8-segment chain with real corner arcs', () => {
    const segs = entityToSegments([rect], ['r1']);
    expect(segs).toHaveLength(8);
    // Chain must be continuous and closed, or the toolpath breaks apart.
    for (let i = 0; i < segs.length; i++) {
      const next = segs[(i + 1) % segs.length]!;
      expect(segs[i]!.to.x).toBeCloseTo(next.from.x, 9);
      expect(segs[i]!.to.y).toBeCloseTo(next.from.y, 9);
    }
    for (const s of segs.filter((s) => s.bulge !== 0)) {
      const arc = arcFromBulge(s.from, s.to, s.bulge);
      expect(arc.radius).toBeCloseTo(2, 9);
      // Centre inside the rect: 8mm from origin on both axes, never 12mm.
      expect(Math.abs(arc.center.x)).toBeCloseTo(8, 9);
      expect(Math.abs(arc.center.y)).toBeCloseTo(8, 9);
    }
  });

  it('keeps the machined outline inside the nominal rectangle', () => {
    for (const s of entityToSegments([rect], ['r1'])) {
      for (const p of [s.from, s.to]) {
        expect(Math.abs(p.x)).toBeLessThanOrEqual(10 + 1e-9);
        expect(Math.abs(p.y)).toBeLessThanOrEqual(10 + 1e-9);
      }
    }
  });
});
