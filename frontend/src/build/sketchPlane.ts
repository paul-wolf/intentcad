/**
 * Sketching on a planar face: the face plane's basis ↔ 2D sketch coordinates,
 * and the 3D orthographic camera that shows the plane exactly as the sketch
 * viewport shows the sketch.
 *
 * Plane basis: origin, xDir, normal, and yDir = normal × xDir (right-handed,
 * so xDir × yDir = normal, pointing at the viewer). Looking along −normal,
 * xDir points right and yDir up — the camera rows are [xDir, yDir, normal].
 *
 * The sketcher's world Y points DOWN the screen (screen = world·scale + offset;
 * the DXF export writes y as −y for the same reason), so a sketch point (x, y)
 * sits at plane coordinates (u, v) = (x, −y): P = origin + xDir·x − yDir·y.
 */

import { add, cross, dot, len, scale, sub, type Vec3 } from './dragHandle';
import { lookFrom, quatFromRows, quatToRows, type Quat } from './viewOrient';
import type { Plane } from '@/types/geometry';
import type { Point } from '@/types/document';

export interface PlaneBasis {
  origin: Vec3;
  xDir: Vec3;
  yDir: Vec3;
  normal: Vec3;
}

const unit = (v: Vec3): Vec3 => scale(v, 1 / (len(v) || 1));

export function planeBasis(plane: Plane): PlaneBasis {
  const normal = unit(plane.normal);
  // re-orthogonalise xAxis against the normal (stored values are rounded)
  const xDir = unit(sub(plane.xAxis, scale(normal, dot(plane.xAxis, normal))));
  return { origin: plane.origin, xDir, yDir: cross(normal, xDir), normal };
}

/** The sketch plane for a face: sketch X is screen-right in the same view as
 * "Normal to" this face (world Z up the screen on walls; X right, ±Y up on
 * top / bottom faces). The origin is the world origin projected onto the
 * plane, so sketch coordinates line up with the part's. */
export function planeForFace(center: Vec3, normal: Vec3): Plane {
  const n = unit(normal);
  const [xAxis] = quatToRows(lookFrom(n));
  return { origin: scale(n, dot(center, n)), normal: n, xAxis };
}

export function sketchToWorld(b: PlaneBasis, p: Point): Vec3 {
  return add(b.origin, add(scale(b.xDir, p.x), scale(b.yDir, -p.y)));
}

export function worldToSketch(b: PlaneBasis, w: Vec3): Point {
  const d = sub(w, b.origin);
  return { x: dot(d, b.xDir), y: -dot(d, b.yDir) };
}

/** Signed distance of a world point from the plane (+ on the normal's side). */
export const planeDistance = (b: PlaneBasis, w: Vec3): number => dot(sub(w, b.origin), b.normal);

/** The view rotation (world → view) that looks straight at the plane with
 * sketch +X to the right and sketch −Y (plane +v) up. */
export const planeQuat = (b: PlaneBasis): Quat => quatFromRows([b.xDir, b.yDir, b.normal]);

export interface Rect { left: number; top: number; width: number; height: number }

/**
 * The orthographic camera (centre on the plane, half-height in mm) for a GL
 * canvas at page rect `gl` so it shows the plane exactly as the sketch canvas
 * at page rect `sk` shows the sketch with viewport (offset, scale px/mm).
 * Rects in CSS px; the GL canvas's device-pixel ratio doesn't matter (it maps
 * halfH to half its height whatever its backing size).
 */
export function sketchCamera(
  b: PlaneBasis, vp: { offset: Point; scale: number }, sk: Rect, gl: Rect,
): { center: Vec3; halfH: number } {
  const sx = gl.left + gl.width / 2 - sk.left;   // GL centre in sketch-canvas px
  const sy = gl.top + gl.height / 2 - sk.top;
  const p = { x: (sx - vp.offset.x) / vp.scale, y: (sy - vp.offset.y) / vp.scale };
  return { center: sketchToWorld(b, p), halfH: gl.height / (2 * vp.scale) };
}

/** Viewport that fits sketch-space bounds into a canvas (w × h CSS px) with
 * a margin, centred. */
export function fitViewport(
  min: Point, max: Point, w: number, h: number, margin = 0.18,
): { offset: Point; scale: number } {
  const bw = Math.max(max.x - min.x, 1e-3), bh = Math.max(max.y - min.y, 1e-3);
  const s = Math.min(w / bw, h / bh) * (1 - 2 * margin);
  const cx = (min.x + max.x) / 2, cy = (min.y + max.y) / 2;
  return { offset: { x: w / 2 - cx * s, y: h / 2 - cy * s }, scale: s };
}
