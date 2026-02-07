import type { Plane } from '@/types/part';

type Vec3 = [number, number, number];

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function scale(v: Vec3, s: number): Vec3 {
  return [v[0] * s, v[1] * s, v[2] * s];
}

function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function normalize(v: Vec3): Vec3 {
  const len = Math.sqrt(dot(v, v));
  if (len < 1e-12) return v;
  return scale(v, 1 / len);
}

/** Rodrigues' rotation: rotate v around unit axis k by angle theta (radians). */
function rodrigues(v: Vec3, k: Vec3, theta: number): Vec3 {
  const cosT = Math.cos(theta);
  const sinT = Math.sin(theta);
  const kxv = cross(k, v);
  const kdv = dot(k, v);
  return add(add(scale(v, cosT), scale(kxv, sinT)), scale(k, kdv * (1 - cosT)));
}

/**
 * Rotate a base plane by spin then tilt.
 * Spin: rotate xAxis around normal by spinDeg.
 * Tilt: rotate both normal and spun xAxis around the spun xAxis by tiltDeg.
 */
export function rotatePlane(
  base: Plane,
  spinDeg: number,
  tiltDeg: number,
): { normal: Vec3; xAxis: Vec3 } {
  const spinRad = (spinDeg * Math.PI) / 180;
  const tiltRad = (tiltDeg * Math.PI) / 180;

  // Spin: rotate xAxis around normal
  const spunXAxis = normalize(rodrigues(base.xAxis, base.normal, spinRad));

  // Tilt: rotate both normal and xAxis around the spun xAxis
  const tiltedNormal = normalize(rodrigues(base.normal, spunXAxis, tiltRad));
  const tiltedXAxis = normalize(rodrigues(spunXAxis, spunXAxis, tiltRad)); // xAxis is the rotation axis, so unchanged

  return { normal: tiltedNormal, xAxis: tiltedXAxis };
}

/**
 * Recover (spinDeg, tiltDeg) from a stored plane relative to a base plane.
 * Tilt = angle between base normal and stored normal.
 * Spin = angle of the tilt direction projected onto the base plane.
 */
export function decomposePlaneAngles(
  plane: Plane,
  base: Plane,
): { spinDeg: number; tiltDeg: number } {
  const storedNormal: Vec3 = plane.normal;
  const baseNormal: Vec3 = base.normal;
  const baseXAxis: Vec3 = base.xAxis;
  const baseYAxis: Vec3 = cross(baseNormal, baseXAxis);

  // Tilt = angle between base normal and stored normal
  const cosAngle = Math.max(-1, Math.min(1, dot(baseNormal, storedNormal)));
  const tiltRad = Math.acos(cosAngle);
  const tiltDeg = (tiltRad * 180) / Math.PI;

  if (tiltDeg < 0.01) {
    // No tilt — recover spin from xAxis directly
    const cosS = Math.max(-1, Math.min(1, dot(baseXAxis, plane.xAxis)));
    const sinS = dot(baseNormal, cross(baseXAxis, plane.xAxis));
    const spinDeg = (Math.atan2(sinS, cosS) * 180) / Math.PI;
    return { spinDeg: Math.round(spinDeg * 1000) / 1000, tiltDeg: 0 };
  }

  // The tilt axis is in the base plane. Find its direction by projecting the
  // displacement of the normal onto the base plane.
  // diff = storedNormal - baseNormal * cos(tilt), projected onto base plane
  const diff: Vec3 = [
    storedNormal[0] - baseNormal[0] * cosAngle,
    storedNormal[1] - baseNormal[1] * cosAngle,
    storedNormal[2] - baseNormal[2] * cosAngle,
  ];
  // The tilt axis is perpendicular to this diff direction, in the base plane.
  // The diff direction is baseYAxis rotated by spin, crossed with baseNormal gives the tilt axis.
  // Actually: diff lies along (baseNormal × tiltAxis), so tiltAxis = -(baseNormal × diff) normalized
  // But it's simpler: diff projected onto baseXAxis/baseYAxis gives the spin angle directly.
  const dx = dot(diff, baseXAxis);
  const dy = dot(diff, baseYAxis);
  // diff points in the direction of "tilt displacement" which is perpendicular to the tilt axis.
  // If spin=0, tilt rotates around baseXAxis, so the normal moves toward -baseYAxis direction.
  // Actually with our convention: tilt around spunXAxis rotates normal, and spin=0 means spunXAxis=baseXAxis.
  // Rotating baseNormal around baseXAxis by tiltDeg: normal moves into the baseYAxis direction.
  // So diff direction = sin(tilt)*baseYAxis when spin=0 → angle of diff = atan2(dy,dx).
  // For spin=0, diff is along baseYAxis (angle=90°), but we want spinDeg=0 for that case.
  // spin = atan2(dx, dy) would give 0 when diff is along Y.  Nope — atan2(0,1) = 0.
  // Let's think again: with spin=0, tiltAxis=baseXAxis, rotating baseNormal around baseXAxis by tilt:
  //   newNormal = baseNormal*cos(tilt) + (baseXAxis × baseNormal)*sin(tilt) = baseNormal*cos(tilt) + baseYAxis*sin(tilt)
  //   diff = baseYAxis*sin(tilt), so dx=0, dy=sin(tilt)>0.
  // With spin=S, the tilt axis becomes rodrigues(baseXAxis, baseNormal, S).
  //   newNormal = baseNormal*cos(tilt) + (tiltAxis × baseNormal)*sin(tilt)
  //   tiltAxis × baseNormal = rodrigues(baseXAxis,baseNormal,S) × baseNormal
  //   Since baseXAxis × baseNormal = -baseYAxis, and rodrigues rotates in-plane by S:
  //   = (cos(S)*baseXAxis + sin(S)*baseYAxis) × baseNormal = cos(S)*(-baseYAxis) + sin(S)*(baseXAxis)
  //   = sin(S)*baseXAxis - cos(S)*baseYAxis
  //   So diff = sin(tilt) * (sin(S)*baseXAxis - cos(S)*baseYAxis)
  //   dx = sin(tilt)*sin(S), dy = -sin(tilt)*cos(S)
  //   spin = atan2(dx, -dy) = atan2(sin(S), cos(S)) = S  ✓
  const spinRad = Math.atan2(dx, -dy);
  const spinDeg = (spinRad * 180) / Math.PI;

  return {
    spinDeg: Math.round(spinDeg * 1000) / 1000,
    tiltDeg: Math.round(tiltDeg * 1000) / 1000,
  };
}

/**
 * Find the closest plane preset name by comparing normals (largest dot product).
 */
export function closestPreset(
  normal: Vec3,
  presets: Record<string, Plane>,
): string {
  let best = '';
  let bestDot = -Infinity;
  for (const [name, preset] of Object.entries(presets)) {
    const d = dot(preset.normal, normal);
    if (d > bestDot) {
      bestDot = d;
      best = name;
    }
  }
  return best;
}
