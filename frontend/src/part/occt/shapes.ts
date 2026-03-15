import type { OC } from './init';
import type { Entity, RectangleEntity, CircleEntity, LineEntity } from '@/types/document';
import type { Plane } from '@/types/part';
import { castWire, findConstructorNumeric } from './helpers';

/** Tracks intermediate OCCT objects for cleanup via .delete(). */
export class OcctCleanup {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private objects: any[] = [];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  track<T extends { delete(): void }>(obj: T): T {
    this.objects.push(obj);
    return obj;
  }

  dispose() {
    for (const obj of this.objects) {
      try { obj.delete(); } catch { /* already deleted */ }
    }
    this.objects.length = 0;
  }
}

/** Transform a 2D sketch point to a 3D gp_Pnt using the plane basis. */
function to3D(
  oc: OC,
  x2d: number,
  y2d: number,
  plane: Plane,
  cleanup: OcctCleanup,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): any {
  const [ox, oy, oz] = plane.origin;
  const [nx, ny, nz] = plane.normal;
  const [xx, xy, xz] = plane.xAxis;
  // yAxis = xAxis × normal (matches screen-Y-down convention in 2D sketch editor)
  const yx = xy * nz - xz * ny;
  const yy = xz * nx - xx * nz;
  const yz = xx * ny - xy * nx;

  return cleanup.track(new oc.gp_Pnt_3(
    ox + x2d * xx + y2d * yx,
    oy + x2d * xy + y2d * yy,
    oz + x2d * xz + y2d * yz,
  ));
}

/** Create an OCCT wire from a sketch entity on the given plane. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function entityToWire(oc: OC, entity: Entity, plane: Plane, cleanup: OcctCleanup): any | null {
  if (entity.type === 'rectangle') {
    return rectangleToWire(oc, entity as RectangleEntity, plane, cleanup);
  }
  if (entity.type === 'circle') {
    return circleToWire(oc, entity as CircleEntity, plane, cleanup);
  }
  if (entity.type === 'line') {
    return polygonToWire(oc, entity as LineEntity, plane, cleanup);
  }
  return null;
}

function rectangleToWire(
  oc: OC, rect: RectangleEntity, plane: Plane, cleanup: OcctCleanup,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): any {
  const hw = rect.width / 2;
  const hh = rect.height / 2;
  const cx = rect.center.x;
  const cy = rect.center.y;

  const p1 = to3D(oc, cx - hw, cy - hh, plane, cleanup);
  const p2 = to3D(oc, cx + hw, cy - hh, plane, cleanup);
  const p3 = to3D(oc, cx + hw, cy + hh, plane, cleanup);
  const p4 = to3D(oc, cx - hw, cy + hh, plane, cleanup);

  const poly = cleanup.track(new oc.BRepBuilderAPI_MakePolygon_1());
  poly.Add_1(p1);
  poly.Add_1(p2);
  poly.Add_1(p3);
  poly.Add_1(p4);
  poly.Close();

  return poly.Wire();
}

function circleToWire(
  oc: OC, circle: CircleEntity, plane: Plane, cleanup: OcctCleanup,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): any {
  // Try exact OCCT circle first
  try {
    const center = to3D(oc, circle.center.x, circle.center.y, plane, cleanup);
    const [nx, ny, nz] = plane.normal;
    const [xx, xy, xz] = plane.xAxis;
    const dir = cleanup.track(new oc.gp_Dir_4(nx, ny, nz));
    const xDir = cleanup.track(new oc.gp_Dir_4(xx, xy, xz));
    const axis = cleanup.track(new oc.gp_Ax2_2(center, dir, xDir));

    // GC_MakeCircle → Handle(Geom_Circle) → BRepBuilderAPI_MakeEdge
    const gcCtor = findConstructorNumeric(oc, 'GC_MakeCircle', 10,
      [[axis, circle.radius]], (m) => typeof m.Value === 'function');
    if (gcCtor) {
      const gcMaker = cleanup.track(new gcCtor(axis, circle.radius));
      const curveHandle = gcMaker.Value();
      const edgeCtor = findConstructorNumeric(oc, 'BRepBuilderAPI_MakeEdge', 35,
        [[curveHandle]], (eb) => typeof eb.IsDone === 'function' && eb.IsDone());
      if (edgeCtor) {
        const eb = cleanup.track(new edgeCtor(curveHandle));
        const wireBuilder = cleanup.track(new oc.BRepBuilderAPI_MakeWire_2(eb.Edge()));
        return wireBuilder.Wire();
      }
    }

    // Fallback: gp_Circ → BRepBuilderAPI_MakeEdge
    const circ = cleanup.track(new oc.gp_Circ_2(axis, circle.radius));
    const edgeCtor2 = findConstructorNumeric(oc, 'BRepBuilderAPI_MakeEdge', 35,
      [[circ]], (eb) => typeof eb.IsDone === 'function' && eb.IsDone());
    if (edgeCtor2) {
      const eb = cleanup.track(new edgeCtor2(circ));
      const wireBuilder = cleanup.track(new oc.BRepBuilderAPI_MakeWire_2(eb.Edge()));
      return wireBuilder.Wire();
    }
  } catch (e) {
    console.warn('[OCCT] Exact circle construction failed, using polygon:', e);
  }

  // Fallback: approximate circle as 72-sided polygon
  console.warn('[OCCT] Using polygon approximation for circle');
  const n = 72;
  const poly = cleanup.track(new oc.BRepBuilderAPI_MakePolygon_1());
  for (let i = 0; i < n; i++) {
    const angle = (2 * Math.PI * i) / n;
    const x = circle.center.x + circle.radius * Math.cos(angle);
    const y = circle.center.y + circle.radius * Math.sin(angle);
    const pt = to3D(oc, x, y, plane, cleanup);
    poly.Add_1(pt);
  }
  poly.Close();
  return poly.Wire();
}

function polygonToWire(
  oc: OC, line: LineEntity, plane: Plane, cleanup: OcctCleanup,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): any {
  let pts = [...line.points];
  // Strip duplicate closing point
  if (pts.length > 1) {
    const first = pts[0]!;
    const last = pts[pts.length - 1]!;
    const dx = first.x - last.x;
    const dy = first.y - last.y;
    if (dx * dx + dy * dy < 1) pts = pts.slice(0, -1);
  }
  if (pts.length < 3) return null;

  const poly = cleanup.track(new oc.BRepBuilderAPI_MakePolygon_1());
  for (const pt of pts) {
    const p3d = to3D(oc, pt.x, pt.y, plane, cleanup);
    poly.Add_1(p3d);
  }
  poly.Close();

  return poly.Wire();
}

/**
 * Build an OCCT face from an outer wire and optional hole wires.
 * Returns a TopoDS_Face.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function buildFace(oc: OC, outerWire: any, holeWires: any[], cleanup: OcctCleanup): any {
  // BRepBuilderAPI_MakeFace(Wire, OnlyPlane)
  const makeFaceCtor = findConstructorNumeric(oc, 'BRepBuilderAPI_MakeFace', 25,
    [[outerWire, true]], (fb) => typeof fb.Face === 'function');

  if (!makeFaceCtor) {
    throw new Error('Could not find BRepBuilderAPI_MakeFace overload for (Wire, bool)');
  }

  const faceBuilder = cleanup.track(new makeFaceCtor(outerWire, true));

  for (const hole of holeWires) {
    // Inner wire (hole) must have opposite orientation to the outer wire.
    // Reversed() returns a TopoDS_Shape — downcast back to TopoDS_Wire.
    const reversed = hole.Reversed();
    const wire = castWire(oc, reversed);
    faceBuilder.Add(wire);
    if (typeof faceBuilder.Error === 'function') {
      const err = faceBuilder.Error();
      if (err && err.value !== undefined && err.value !== 0) {
        console.warn(`[OCCT] buildFace: Add hole wire error code=${err.value}`);
      }
    }
  }

  return faceBuilder.Face();
}
