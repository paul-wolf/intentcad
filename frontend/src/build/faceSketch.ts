/**
 * Sketches drawn on a part's planar faces: finding the sketch for a face,
 * creating one (with the face outline as fixed construction geometry, so it
 * snaps like any other sketch geometry), and flattening a sketch into 3D
 * line segments on its plane for the viewer. Its closed shapes become the
 * "profile" the script's sketch("name") extrudes (modeling/sketch_profile.py).
 */

import type { Constraint, Entity, Point, Sketch } from '@/types/document';
import type { RunEdge } from '@/api/client';
import { generateId } from '@/utils/id';
import { arcFromBulge, arcMidpoint, bulgeFromMidpoint } from '@/utils/arcGeometry';
import { rectangleOutline, rectanglePath } from '@/utils/rectPath';
import { bezierPoint } from '@/utils/bezierGeometry';
import { dot, len, sub, type Vec3 } from './dragHandle';
import { planeBasis, planeForFace, sketchToWorld, worldToSketch, type PlaneBasis } from './sketchPlane';

/** The face a sketch was drawn on, kept for re-binding after a rebuild. */
export interface FaceRef { center: Vec3; normal: Vec3; area: number }

export interface FaceInfo { index: number; center: Vec3; normal: Vec3; area: number }

/** The sketch drawn on this face: same plane, nearest centre. */
export function findFaceSketch(sketches: Sketch[], face: FaceInfo): Sketch | null {
  let best: Sketch | null = null, bestD = Infinity;
  for (const s of sketches) {
    if (!s.plane || !s.face) continue;
    const b = planeBasis(s.plane);
    if (dot(b.normal, face.normal) < 0.999) continue;
    if (Math.abs(dot(sub(face.center, b.origin), b.normal)) > 0.01) continue;
    const d = len(sub(s.face.center, face.center));
    if (d < bestD) { bestD = d; best = s; }
  }
  return best;
}

const round = (v: Vec3): Vec3 => v.map((x) => Math.round(x * 1e6) / 1e6) as Vec3;

/** A new sketch on the face: plane + face description, and the face's edges
 *  as fixed construction lines/circles. */
export function newFaceSketch(name: string, face: FaceInfo, edges: RunEdge[]): Sketch {
  const plane = planeForFace(face.center, face.normal);
  const b = planeBasis(plane);
  const entities: Entity[] = [];
  const constraints: Constraint[] = [];
  for (const e of edges) {
    if (!e.faceIndices.includes(face.index) || e.polyline.length < 2) continue;
    const pts = e.polyline.map((p) => worldToSketch(b, p));
    const first = pts[0]!, last = pts[pts.length - 1]!;
    const closed = Math.hypot(first.x - last.x, first.y - last.y) < 1e-6;
    // reference (datum) + construction: drawn as a marker, snappable, never exported
    const ref = { construction: true, reference: true } as const;
    let ent: Entity;
    if (e.kind === 'circle' && closed) {
      const ring = pts.slice(0, -1);
      const c = { x: ring.reduce((s, p) => s + p.x, 0) / ring.length, y: ring.reduce((s, p) => s + p.y, 0) / ring.length };
      const r = ring.reduce((s, p) => s + Math.hypot(p.x - c.x, p.y - c.y), 0) / ring.length;
      ent = { id: generateId('e'), type: 'circle', center: c, radius: r, ...ref };
    } else if (e.kind === 'line' || (!closed && (e.kind === 'circle' || fitsArc(pts)))) {
      // a line, or an arc as one bulged segment (the sampled middle point fixes the bulge)
      const bulge = e.kind === 'line' ? 0 : bulgeFromMidpoint(first, last, pts[(pts.length - 1) >> 1]!);
      ent = { id: generateId('e'), type: 'line', points: [first, last], ...(bulge ? { bulge: [bulge] } : {}), ...ref };
    } else {
      const ring = closed ? pts.slice(0, -1) : pts;
      ent = { id: generateId('e'), type: 'line', points: closed ? ring : simplify(ring, 0.01), closed: closed || undefined, ...ref };
    }
    entities.push(ent);
    constraints.push({ id: generateId('c'), type: 'fixed', entityId: ent.id });
  }
  return {
    id: generateId('sk'), name, visible: true, entities, constraints,
    plane: { origin: round(plane.origin), normal: round(plane.normal), xAxis: round(plane.xAxis) },
    face: { center: face.center, normal: face.normal, area: face.area },
  };
}

// samples within 0.01 mm of the circle through the first, middle and last points
function fitsArc(pts: Point[]): boolean {
  if (pts.length < 3) return false;
  const a = pts[0]!, b = pts[(pts.length - 1) >> 1]!, c = pts[pts.length - 1]!;
  const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
  if (Math.abs(d) < 1e-9) return false;
  const sq = (p: Point) => p.x * p.x + p.y * p.y;
  const cx = (sq(a) * (b.y - c.y) + sq(b) * (c.y - a.y) + sq(c) * (a.y - b.y)) / d;
  const cy = (sq(a) * (c.x - b.x) + sq(b) * (a.x - c.x) + sq(c) * (b.x - a.x)) / d;
  const r = Math.hypot(a.x - cx, a.y - cy);
  return r < 1e5 && pts.every((p) => Math.abs(Math.hypot(p.x - cx, p.y - cy) - r) < 0.01);
}

// Douglas–Peucker: drop points within `tol` of the simplified line
function simplify(pts: Point[], tol: number): Point[] {
  if (pts.length < 3) return pts;
  const a = pts[0]!, b = pts[pts.length - 1]!;
  const dx = b.x - a.x, dy = b.y - a.y, l = Math.hypot(dx, dy) || 1;
  let worst = 0, at = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const p = pts[i]!;
    const dist = Math.abs((p.x - a.x) * dy - (p.y - a.y) * dx) / l;
    if (dist > worst) { worst = dist; at = i; }
  }
  if (worst <= tol) return [a, b];
  return [...simplify(pts.slice(0, at + 1), tol).slice(0, -1), ...simplify(pts.slice(at), tol)];
}

/** The sketch-space bounding box of a sketch's geometry (null if empty). */
export function sketchBounds(sketch: Sketch): { min: Point; max: Point } | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const e of sketch.entities) {
    for (const line of entityPolylines(e, true)) {
      for (const p of line) {
        minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
        minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
      }
    }
  }
  return Number.isFinite(minX) ? { min: { x: minX, y: minY }, max: { x: maxX, y: maxY } } : null;
}

const ARC_STEPS = 24;

function arcPoints(p1: Point, p2: Point, bulge: number): Point[] {
  const arc = arcFromBulge(p1, p2, bulge);
  if (arc.radius === 0) return [];
  let sweep = arc.endAngle - arc.startAngle;
  if (arc.counterClockwise) { while (sweep > 0) sweep -= Math.PI * 2; } else { while (sweep < 0) sweep += Math.PI * 2; }
  const out: Point[] = [];
  for (let s = 1; s < ARC_STEPS; s++) {
    const a = arc.startAngle + (sweep * s) / ARC_STEPS;
    out.push({ x: arc.center.x + arc.radius * Math.cos(a), y: arc.center.y + arc.radius * Math.sin(a) });
  }
  return out;
}

/** An entity as sketch-space polylines (construction geometry only when asked). */
export function entityPolylines(e: Entity, withConstruction = false): Point[][] {
  if ('construction' in e && e.construction && !withConstruction) return [];
  switch (e.type) {
    case 'line': {
      const out: Point[] = [];
      const n = e.closed ? e.points.length : e.points.length - 1;
      for (let i = 0; i < n; i++) {
        const p1 = e.points[i]!, p2 = e.points[(i + 1) % e.points.length]!;
        out.push(p1);
        const b = e.bulge?.[i] ?? 0;
        if (b) out.push(...arcPoints(p1, p2, b));
      }
      if (e.points.length) out.push(e.closed ? e.points[0]! : e.points[e.points.length - 1]!);
      return [out];
    }
    case 'circle': {
      const out: Point[] = [];
      for (let i = 0; i <= 64; i++) {
        const a = (i / 64) * Math.PI * 2;
        out.push({ x: e.center.x + e.radius * Math.cos(a), y: e.center.y + e.radius * Math.sin(a) });
      }
      return [out];
    }
    case 'rectangle': {
      const pts = rectangleOutline(e);
      return [[...pts, pts[0]!]];
    }
    case 'bezier': {
      const [a, b, c, d] = e.controlPoints;
      return [Array.from({ length: 33 }, (_, i) => bezierPoint(a, b, c, d, i / 32))];
    }
    case 'point': {
      const s = 0.6;
      return [[{ x: e.position.x - s, y: e.position.y }, { x: e.position.x + s, y: e.position.y }],
              [{ x: e.position.x, y: e.position.y - s }, { x: e.position.x, y: e.position.y + s }]];
    }
    default:
      return [];   // dimensions, text
  }
}

/** A face sketch as 3D segment pairs on its plane, for the viewer. */
export function sketchSegments(sketch: Sketch): number[] {
  if (!sketch.plane) return [];
  const b: PlaneBasis = planeBasis(sketch.plane);
  const out: number[] = [];
  for (const e of sketch.entities) {
    for (const line of entityPolylines(e)) {
      for (let i = 0; i + 1 < line.length; i++) {
        out.push(...sketchToWorld(b, line[i]!), ...sketchToWorld(b, line[i + 1]!));
      }
    }
  }
  return out;
}

type XY = [number, number];

/** One edge of a closed shape, in sketch coordinates (y down). */
export type ProfileSegment =
  | { t: 'line'; p: [XY, XY] }
  | { t: 'arc'; p: [XY, XY, XY] }                  // start, a point on it, end
  | { t: 'circle'; c: XY; r: number }
  | { t: 'bezier'; p: [XY, XY, XY, XY] };

/** A face sketch's closed shapes on its plane — what sketch("name") builds from. */
export interface SketchProfile { plane: NonNullable<Sketch['plane']>; loops: ProfileSegment[][] }

const xy = (p: Point): XY => [Math.round(p.x * 1e6) / 1e6, Math.round(p.y * 1e6) / 1e6];
const JOIN_TOL = 1e-4;

function ends(s: ProfileSegment): [XY, XY] | null {
  return s.t === 'circle' ? null : [s.p[0], s.p[s.p.length - 1]!];
}

function reversed(s: ProfileSegment): ProfileSegment {
  return s.t === 'circle' ? s : ({ ...s, p: [...s.p].reverse() } as ProfileSegment);
}

const near = (a: XY, b: XY) => Math.hypot(a[0] - b[0], a[1] - b[1]) < JOIN_TOL;

// a polyline's segments: straight, or an arc where it has a bulge
function pathSegments(points: Point[], bulge: number[] | undefined, closed: boolean): ProfileSegment[] {
  const out: ProfileSegment[] = [];
  const n = closed ? points.length : points.length - 1;
  for (let i = 0; i < n; i++) {
    const a = points[i]!, b = points[(i + 1) % points.length]!;
    if (Math.hypot(a.x - b.x, a.y - b.y) < 1e-9) continue;
    const k = bulge?.[i] ?? 0;
    out.push(k ? { t: 'arc', p: [xy(a), xy(arcMidpoint(a, b, k)), xy(b)] } : { t: 'line', p: [xy(a), xy(b)] });
  }
  return out;
}

/** The closed shapes of a sketch's real (non-construction) geometry: circles,
 *  closed polylines and rectangles as they are, and open lines, arcs and
 *  curves chained end to end. `open` counts chains that don't close. */
export function sketchLoops(sketch: Sketch): { loops: ProfileSegment[][]; open: number } {
  const loops: ProfileSegment[][] = [];
  const pool: ProfileSegment[] = [];
  for (const e of sketch.entities) {
    if ('construction' in e && e.construction) continue;
    switch (e.type) {
      case 'circle':
        if (e.radius > 0) loops.push([{ t: 'circle', c: xy(e.center), r: e.radius }]);
        break;
      case 'rectangle': {
        const path = rectanglePath(e);
        if (e.width > 0 && e.height > 0) loops.push(pathSegments(path.points, path.bulge, true));
        break;
      }
      case 'line': {
        const segs = pathSegments(e.points, e.bulge, !!e.closed);
        if (e.closed && segs.length) loops.push(segs);
        else pool.push(...segs);
        break;
      }
      case 'bezier':
        pool.push({ t: 'bezier', p: e.controlPoints.map(xy) as [XY, XY, XY, XY] });
        break;
      default:
        break;   // points, dimensions, text
    }
  }
  // chain the loose pieces: grow each chain from its end until it meets its start
  let open = 0;
  const used = new Array(pool.length).fill(false);
  for (let i = 0; i < pool.length; i++) {
    if (used[i]) continue;
    used[i] = true;
    const chain = [pool[i]!];
    const start = ends(pool[i]!)![0];
    let end = ends(pool[i]!)![1];
    for (;;) {
      if (chain.length > 1 && near(end, start)) break;
      let next = -1, flip = false;
      for (let j = 0; j < pool.length && next < 0; j++) {
        if (used[j]) continue;
        const [a, b] = ends(pool[j]!)!;
        if (near(a, end)) next = j;
        else if (near(b, end)) { next = j; flip = true; }
      }
      if (next < 0) break;
      used[next] = true;
      const seg = flip ? reversed(pool[next]!) : pool[next]!;
      chain.push(seg);
      end = ends(seg)![1];
    }
    // a single segment closes only as a full curve (a bezier ending where it began)
    if (near(end, start) && (chain.length > 1 || chain[0]!.t === 'bezier')) loops.push(chain);
    else open++;
  }
  return { loops, open };
}

/** The profile stored with a face sketch (null for a sketch with no plane). */
export function sketchProfile(sketch: Sketch): SketchProfile | null {
  if (!sketch.plane) return null;
  return { plane: sketch.plane, loops: sketchLoops(sketch).loops };
}

// matches the engine's SKETCH_REF (modeling/engine.py)
const SKETCH_REF = /\bsketch\(\s*(["'])(.+?)\1\s*\)/g;

/** The profiles of the face sketches `code` extrudes, by name — sent with a
 *  build, and part of its cache key (the build depends on them too). */
export function referencedProfiles(code: string, sketches: Sketch[]): Record<string, SketchProfile> {
  const out: Record<string, SketchProfile> = {};
  for (const m of code.matchAll(SKETCH_REF)) {
    const s = sketches.find((k) => k.name === m[2]);
    const p = s && sketchProfile(s);
    if (p) out[m[2]!] = p;
  }
  return out;
}
