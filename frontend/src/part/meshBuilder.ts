import * as THREE from 'three';
import type { RectangleEntity, CircleEntity, LineEntity, Entity } from '@/types/document';
import type { Plane } from '@/types/part';

export type ShapeDef =
  | { kind: 'polygon'; points: { x: number; y: number }[] }
  | { kind: 'circle'; cx: number; cy: number; r: number }
  | { kind: 'rectangle'; cx: number; cy: number; w: number; h: number };

/** Convert a sketch entity to a ShapeDef for mesh building. */
export function entityToShapeDef(entity: Entity): ShapeDef | null {
  if (entity.type === 'rectangle') {
    const r = entity as RectangleEntity;
    return { kind: 'rectangle', cx: r.center.x, cy: r.center.y, w: r.width, h: r.height };
  }
  if (entity.type === 'circle') {
    const c = entity as CircleEntity;
    return { kind: 'circle', cx: c.center.x, cy: c.center.y, r: c.radius };
  }
  if (entity.type === 'line') {
    const line = entity as LineEntity;
    let pts = [...line.points];
    // Strip duplicate closing point
    if (pts.length > 1) {
      const first = pts[0]!, last = pts[pts.length - 1]!;
      const dx = first.x - last.x, dy = first.y - last.y;
      if (dx * dx + dy * dy < 1) pts = pts.slice(0, -1);
    }
    if (pts.length < 3) return null;
    return { kind: 'polygon', points: pts };
  }
  return null;
}

const CYLINDER_SEGMENTS = 48;

/**
 * Build an extruded mesh from a 2D profile with holes.
 * Uses THREE.ExtrudeGeometry for proper triangulation of concave shapes with holes.
 */
export function buildProfileMesh(
  outer: ShapeDef,
  holes: ShapeDef[],
  plane: Plane,
  distance: number,
): THREE.BufferGeometry {
  const shape = new THREE.Shape();

  if (outer.kind === 'circle') {
    shape.absarc(outer.cx, outer.cy, outer.r, 0, Math.PI * 2, false);
  } else if (outer.kind === 'rectangle') {
    const hw = outer.w / 2, hh = outer.h / 2;
    shape.moveTo(outer.cx - hw, outer.cy - hh);
    shape.lineTo(outer.cx + hw, outer.cy - hh);
    shape.lineTo(outer.cx + hw, outer.cy + hh);
    shape.lineTo(outer.cx - hw, outer.cy + hh);
  } else {
    shape.moveTo(outer.points[0]!.x, outer.points[0]!.y);
    for (let i = 1; i < outer.points.length; i++) {
      shape.lineTo(outer.points[i]!.x, outer.points[i]!.y);
    }
  }

  for (const hole of holes) {
    const holePath = new THREE.Path();
    if (hole.kind === 'circle') {
      holePath.absarc(hole.cx, hole.cy, hole.r, 0, Math.PI * 2, true);
    } else if (hole.kind === 'rectangle') {
      const hw = hole.w / 2, hh = hole.h / 2;
      holePath.moveTo(hole.cx - hw, hole.cy - hh);
      holePath.lineTo(hole.cx + hw, hole.cy - hh);
      holePath.lineTo(hole.cx + hw, hole.cy + hh);
      holePath.lineTo(hole.cx - hw, hole.cy + hh);
    } else {
      holePath.moveTo(hole.points[0]!.x, hole.points[0]!.y);
      for (let i = 1; i < hole.points.length; i++) {
        holePath.lineTo(hole.points[i]!.x, hole.points[i]!.y);
      }
    }
    shape.holes.push(holePath);
  }

  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: distance,
    bevelEnabled: false,
    curveSegments: CYLINDER_SEGMENTS,
  });

  // Transform from shape local (XY + extrude Z) to world coordinates
  const [nx, ny, nz] = plane.normal;
  const [xx, xy, xz] = plane.xAxis;
  const yx = ny * xz - nz * xy;
  const yy = nz * xx - nx * xz;
  const yz = nx * xy - ny * xx;

  const matrix = new THREE.Matrix4();
  matrix.set(
    xx, yx, nx, plane.origin[0],
    xy, yy, ny, plane.origin[1],
    xz, yz, nz, plane.origin[2],
    0,  0,  0,  1,
  );
  geometry.applyMatrix4(matrix);

  return geometry;
}
