import type { Sketch, Entity, LineEntity, CircleEntity, RectangleEntity, BezierEntity, Point } from '@/types/document';
import type { Plane } from '@/types/part';

export interface SketchOverlayResult {
  /** Flat array of line segment positions (pairs of xyz triplets) for LineSegments geometry */
  linePositions: Float32Array;
  /** Center of the bounding box in 3D, for placing the plane quad */
  planeCenter: [number, number, number];
  /** Normal of the plane */
  planeNormal: [number, number, number];
  /** xAxis of the plane */
  planeXAxis: [number, number, number];
  /** Size of the plane quad (1.5x bbox diagonal, min 20) */
  planeSize: number;
}

/** Transform a 2D sketch point to 3D on the given plane. */
function to3D(p: Point, plane: Plane): [number, number, number] {
  const [ox, oy, oz] = plane.origin;
  const [nx, ny, nz] = plane.normal;
  const [xx, xy, xz] = plane.xAxis;
  // yAxis = xAxis × normal (matches screen-Y-down convention in 2D sketch editor)
  const yx = xy * nz - xz * ny;
  const yy = xz * nx - xx * nz;
  const yz = xx * ny - xy * nx;
  return [
    ox + p.x * xx + p.y * yx,
    oy + p.x * xy + p.y * yy,
    oz + p.x * xz + p.y * yz,
  ];
}

/** De Casteljau evaluation for a cubic bezier at parameter t. */
function evalBezier(cp: [Point, Point, Point, Point], t: number): Point {
  const lerp = (a: Point, b: Point, t: number): Point => ({
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
  });
  const p01 = lerp(cp[0], cp[1], t);
  const p12 = lerp(cp[1], cp[2], t);
  const p23 = lerp(cp[2], cp[3], t);
  const p012 = lerp(p01, p12, t);
  const p123 = lerp(p12, p23, t);
  return lerp(p012, p123, t);
}

export function buildSketchOverlay(sketch: Sketch, plane: Plane): SketchOverlayResult {
  const segments: [number, number, number, number, number, number][] = [];
  const allPoints: [number, number, number][] = [];

  function addSegment(a: [number, number, number], b: [number, number, number]) {
    segments.push([a[0], a[1], a[2], b[0], b[1], b[2]]);
    allPoints.push(a, b);
  }

  for (const entity of sketch.entities) {
    if (entity.type === 'point' || entity.type === 'dimension') continue;
    if (entity.construction) continue;
    processEntity(entity, plane, addSegment);
  }

  // Build Float32Array
  const linePositions = new Float32Array(segments.length * 6);
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i]!;
    linePositions[i * 6] = s[0];
    linePositions[i * 6 + 1] = s[1];
    linePositions[i * 6 + 2] = s[2];
    linePositions[i * 6 + 3] = s[3];
    linePositions[i * 6 + 4] = s[4];
    linePositions[i * 6 + 5] = s[5];
  }

  // Compute bounding box
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const p of allPoints) {
    if (p[0] < minX) minX = p[0];
    if (p[1] < minY) minY = p[1];
    if (p[2] < minZ) minZ = p[2];
    if (p[0] > maxX) maxX = p[0];
    if (p[1] > maxY) maxY = p[1];
    if (p[2] > maxZ) maxZ = p[2];
  }

  const cx = allPoints.length > 0 ? (minX + maxX) / 2 : plane.origin[0];
  const cy = allPoints.length > 0 ? (minY + maxY) / 2 : plane.origin[1];
  const cz = allPoints.length > 0 ? (minZ + maxZ) / 2 : plane.origin[2];

  const dx = maxX - minX, dy = maxY - minY, dz = maxZ - minZ;
  const diagonal = Math.sqrt(dx * dx + dy * dy + dz * dz);
  const planeSize = Math.max(diagonal * 1.5, 20);

  return {
    linePositions,
    planeCenter: [cx, cy, cz],
    planeNormal: plane.normal,
    planeXAxis: plane.xAxis,
    planeSize,
  };
}

function processEntity(
  entity: Entity,
  plane: Plane,
  addSegment: (a: [number, number, number], b: [number, number, number]) => void,
) {
  switch (entity.type) {
    case 'line': {
      const line = entity as LineEntity;
      const pts = line.points;
      if (pts.length < 2) break;
      for (let i = 0; i < pts.length - 1; i++) {
        addSegment(to3D(pts[i]!, plane), to3D(pts[i + 1]!, plane));
      }
      if (line.closed && pts.length >= 3) {
        addSegment(to3D(pts[pts.length - 1]!, plane), to3D(pts[0]!, plane));
      }
      break;
    }
    case 'circle': {
      const circle = entity as CircleEntity;
      const n = 32;
      for (let i = 0; i < n; i++) {
        const a1 = (i / n) * Math.PI * 2;
        const a2 = ((i + 1) / n) * Math.PI * 2;
        const p1: Point = { x: circle.center.x + circle.radius * Math.cos(a1), y: circle.center.y + circle.radius * Math.sin(a1) };
        const p2: Point = { x: circle.center.x + circle.radius * Math.cos(a2), y: circle.center.y + circle.radius * Math.sin(a2) };
        addSegment(to3D(p1, plane), to3D(p2, plane));
      }
      break;
    }
    case 'rectangle': {
      const rect = entity as RectangleEntity;
      const hw = rect.width / 2, hh = rect.height / 2;
      const corners: Point[] = [
        { x: rect.center.x - hw, y: rect.center.y - hh },
        { x: rect.center.x + hw, y: rect.center.y - hh },
        { x: rect.center.x + hw, y: rect.center.y + hh },
        { x: rect.center.x - hw, y: rect.center.y + hh },
      ];
      for (let i = 0; i < 4; i++) {
        addSegment(to3D(corners[i]!, plane), to3D(corners[(i + 1) % 4]!, plane));
      }
      break;
    }
    case 'bezier': {
      const bezier = entity as BezierEntity;
      const n = 16;
      for (let i = 0; i < n; i++) {
        const t1 = i / n;
        const t2 = (i + 1) / n;
        const p1 = evalBezier(bezier.controlPoints, t1);
        const p2 = evalBezier(bezier.controlPoints, t2);
        addSegment(to3D(p1, plane), to3D(p2, plane));
      }
      break;
    }
    // Skip point and dimension entities
  }
}
