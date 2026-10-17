/**
 * View orientation for the 3D viewer: a unit quaternion for the rotation
 * world → view (view x right, y up, z toward the viewer), the standard views,
 * "normal to" a direction, and the Z-up turntable orbit. Pure math, no GL.
 *
 * The world is Z-up (the bed is the Z=0 plane), so every named view keeps
 * world Z pointing up the screen — except top/bottom, which look along Z and
 * keep +Y / −Y up instead.
 */

import { cross, dot, len, scale, sub, type Vec3 } from './dragHandle';

/** [x, y, z, w] */
export type Quat = [number, number, number, number];

export const quatFromAxisAngle = (axis: Vec3, angle: number): Quat => {
  const s = Math.sin(angle / 2);
  return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(angle / 2)];
};

/** a * b: apply b, then a. */
export function quatMul(a: Quat, b: Quat): Quat {
  const [ax, ay, az, aw] = a, [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

export function quatNormalize(q: Quat): Quat {
  const l = Math.hypot(...q) || 1;
  return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
}

/** Spherical interpolation along the shorter arc. */
export function slerp(a: Quat, b: Quat, t: number): Quat {
  let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  let bb = b;
  if (d < 0) { d = -d; bb = [-b[0], -b[1], -b[2], -b[3]]; }
  if (d > 0.9995) {   // nearly equal: lerp is exact enough and avoids 0/0
    return quatNormalize([0, 1, 2, 3].map((i) => a[i]! + (bb[i]! - a[i]!) * t) as Quat);
  }
  const th = Math.acos(d), s = Math.sin(th);
  const ka = Math.sin((1 - t) * th) / s, kb = Math.sin(t * th) / s;
  return [0, 1, 2, 3].map((i) => a[i]! * ka + bb[i]! * kb) as Quat;
}

/** The rotation as rows of a 3x3 (row r = world direction of view axis r). */
export function quatToRows(q: Quat): [Vec3, Vec3, Vec3] {
  const [x, y, z, w] = q;
  return [
    [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
    [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
    [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
  ];
}

/** Column-major 4x4 rotation, for GL. */
export function quatToMat4(q: Quat): Float32Array {
  const r = quatToRows(q);
  const m = new Float32Array(16);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) m[i + j * 4] = r[i]![j]!;
  m[15] = 1;
  return m;
}

/** Quaternion of a rotation matrix given by rows (must be orthonormal). */
export function quatFromRows(r: [Vec3, Vec3, Vec3]): Quat {
  const [[m00, m01, m02], [m10, m11, m12], [m20, m21, m22]] = r;
  const tr = m00 + m11 + m22;
  let q: Quat;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    q = [(m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s, s / 4];
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    q = [s / 4, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s];
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    q = [(m01 + m10) / s, s / 4, (m12 + m21) / s, (m02 - m20) / s];
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    q = [(m02 + m20) / s, (m12 + m21) / s, s / 4, (m10 - m01) / s];
  }
  return quatNormalize(q);
}

/** World direction pointing from the model toward the viewer. */
export const viewOut = (q: Quat): Vec3 => quatToRows(q)[2];

const norm = (v: Vec3): Vec3 => scale(v, 1 / len(v));

/** Look at the model from direction `out` (model → viewer), world Z up the
 * screen; looking straight down/up Z, +Y (top) or −Y (bottom) is up. */
export function lookFrom(out: Vec3): Quat {
  const o = norm(out);
  const up: Vec3 = Math.abs(o[2]) > 0.999
    ? [0, Math.sign(o[2]), 0]
    : norm(sub([0, 0, 1], scale(o, o[2])));
  return quatFromRows([cross(up, o), up, o]);
}

export type StandardView = 'front' | 'back' | 'left' | 'right' | 'top' | 'bottom' | 'iso';

const S3 = 1 / Math.sqrt(3);
export const VIEW_DIRS: Record<StandardView, Vec3> = {
  front: [0, -1, 0], back: [0, 1, 0],
  left: [-1, 0, 0], right: [1, 0, 0],
  top: [0, 0, 1], bottom: [0, 0, -1],
  iso: [S3, -S3, S3],   // front-right-top
};

/** Number keys for the standard views. */
export const VIEW_KEYS: Record<string, StandardView> = {
  '1': 'front', '2': 'back', '3': 'left', '4': 'right', '5': 'top', '6': 'bottom', '0': 'iso',
};

const AXES: Record<'X' | 'Y' | 'Z', Vec3> = { X: [1, 0, 0], Y: [0, 1, 0], Z: [0, 0, 1] };

/** Clicking an axis in the gizmo: look from its + side, or from its − side if
 * already looking from the + side. */
export function axisView(axis: 'X' | 'Y' | 'Z', current: Quat): Quat {
  const a = AXES[axis];
  return lookFrom(dot(viewOut(current), a) > 0.999 ? scale(a, -1) : a);
}

/** Z-up turntable orbit for a pointer drag of (dx, dy) CSS px: horizontal
 * spins the model about world Z, vertical tilts it about the screen's x axis.
 * Upside down (world Z pointing down the screen) horizontal is inverted so
 * the model still follows the pointer. */
export function orbit(q: Quat, dx: number, dy: number, speed = 0.01): Quat {
  const [, up, out] = quatToRows(q);
  const zUp = Math.abs(up[2]) > 1e-6 ? up[2] : out[2];   // straight down/up: by which side we're on
  const spin = quatFromAxisAngle([0, 0, 1], dx * speed * (zUp < 0 ? -1 : 1));
  const tilt = quatFromAxisAngle([1, 0, 0], dy * speed);
  return quatNormalize(quatMul(tilt, quatMul(q, spin)));
}

export const easeInOutCubic = (t: number): number =>
  t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
