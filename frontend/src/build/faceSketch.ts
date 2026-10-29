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
import { add, dot, len, scale, sub, type Vec3 } from './dragHandle';
import { planeBasis, planeForFace, sketchToWorld, worldToSketch, type PlaneBasis } from './sketchPlane';
import { isBroken, isRef } from '@/utils/brokenRefs';
import { isAxis } from '@/utils/sketchAxes';
import { followRefs, type OutlineEdge } from './sketchRefs';
import { matchProjected } from './projectEdges';

/** The face a sketch was drawn on, kept so the build can find it again when
 *  the part changes (modeling/sketch_profile.rebind). Sketches drawn before
 *  the outline box, perimeter, edge count and hint were kept have only
 *  center, normal and area. */
export interface FaceRef {
  center: Vec3; normal: Vec3; area: number;
  /** The face outline's bounding box in the sketch plane, [umin, vmin, umax, vmax]
   *  (u along xAxis, v = normal × xAxis: sketch (x, y) is (u, v) = (x, −y)). */
  box?: [number, number, number, number];
  perimeter?: number;
  edges?: number;
  /** "top face", "right face"… */
  hint?: string;
}

export interface FaceInfo { index: number; center: Vec3; normal: Vec3; area: number }

/** Where the last build put a face sketch: it follows its face along the
 *  face's normal (mirrors modeling.schemas.SketchBinding). */
export interface SketchBinding {
  status: 'same' | 'moved' | 'ambiguous' | 'not_found';
  /** mm along the sketch's normal */
  moved_by: number;
  plane: NonNullable<Sketch['plane']>;
  /** the matched face's edges in the sketch's coordinates on `plane`, for
   *  its reference outline to follow (sketchRefs.followRefs); absent when
   *  no face was matched */
  outline?: OutlineEdge[];
}
export type SketchBindings = Record<string, SketchBinding>;

/** The plane a sketch is on in the last build: where its face went, else as drawn.
 *  (The stored plane is never changed — the build works it out each time.) */
export function boundPlane(s: Sketch, bound?: SketchBindings | null,
                           planes?: Record<string, ConstructionPlane> | null): Sketch['plane'] {
  const on = s.planeRef ? planes?.[s.planeRef] : null;
  return (s.plane && bound?.[s.name]?.plane) || (on ? { origin: on.origin, normal: on.normal, xAxis: on.xAxis } : s.plane);
}

/** A construction plane's geometry, as the build reports it (RunResponse.planes). */
export interface ConstructionPlane { origin: Vec3; normal: Vec3; xAxis: Vec3 }

/** "top face", "front face"… from the outward normal. */
export function faceLabel(n: readonly number[]): string {
  const names: [number, number, string][] = [
    [2, 1, 'top'], [2, -1, 'bottom'], [1, -1, 'front'], [1, 1, 'back'], [0, 1, 'right'], [0, -1, 'left'],
  ];
  for (const [axis, sign, name] of names) if (n[axis]! * sign > 0.999) return `${name} face`;
  return 'angled face';
}

/** The sketch drawn on this face: same plane (where the last build put it,
 *  `bound`), nearest centre. */
export function findFaceSketch(sketches: Sketch[], face: FaceInfo, bound?: SketchBindings | null): Sketch | null {
  let best: Sketch | null = null, bestD = Infinity;
  for (const s of sketches) {
    const d = acrossDistance(s, face, bound);
    if (d != null && d < bestD) { bestD = d; best = s; }
  }
  return best;
}

// how far across its plane the face a sketch was drawn on is from `face`
// (null: the sketch isn't on that face's plane, where the last build put it)
function acrossDistance(s: Sketch, face: FaceInfo, bound?: SketchBindings | null): number | null {
  const plane = boundPlane(s, bound);
  if (!plane || !s.face) return null;
  const b = planeBasis(plane);
  if (dot(b.normal, face.normal) < 0.999) return null;
  if (Math.abs(dot(sub(face.center, b.origin), b.normal)) > 0.01) return null;
  // across the plane only: the face may have moved along its normal since
  const off = sub(s.face.center, face.center);
  return len(sub(off, scale(b.normal, dot(off, b.normal))));
}

/** What the last build did with the face sketches, for the status line: how
 *  many followed their face, and a warning for each that lost it or matched
 *  more than one. */
export function sketchBindNotes(bound: SketchBindings | null | undefined, sketches: Sketch[],
                                prev?: SketchBindings | null): { moved: number; warnings: string[] } {
  let moved = 0;
  const warnings: string[] = [];
  // followed: put somewhere other than the build before put it (a first
  // build, or one that left them where they were, says nothing)
  const followed = (name: string, b: SketchBindings[string]) => {
    const was = prev?.[name]?.plane?.origin;
    const now = b.plane?.origin;
    return !!was && !!now && was.some((x, i) => Math.abs(x - now[i]!) > 1e-6);
  };
  for (const [name, b] of Object.entries(bound ?? {})) {
    const s = sketches.find((k) => k.name === name);
    if (!s?.face) continue;   // a base-plane sketch has no face to follow
    const hint = s.face.hint ?? faceLabel(s.face.normal);
    if (b.status === 'not_found') warnings.push(`Sketch '${name}' lost its face (${hint}); drawn where it was`);
    else {
      if (followed(name, b)) moved++;
      if (b.status === 'ambiguous') warnings.push(`Sketch '${name}' matched more than one face (${hint}); used the closest`);
    }
  }
  return { moved, warnings };
}

const round = (v: Vec3): Vec3 => v.map((x) => Math.round(x * 1e6) / 1e6) as Vec3;

interface Outline { entities: Entity[]; box?: FaceRef['box']; perimeter: number; count: number }

/** The face's edges as fixed reference (construction) lines and circles in
 *  the plane basis `b`, and the outline's box and perimeter. */
function faceOutline(face: FaceInfo, edges: RunEdge[], b: PlaneBasis): Outline {
  const entities: Entity[] = [];
  // the outline, for finding the face again after the part changes
  let umin = Infinity, vmin = Infinity, umax = -Infinity, vmax = -Infinity, perimeter = 0, count = 0;
  for (const e of edges) {
    if (!e.faceIndices.includes(face.index) || e.polyline.length < 2) continue;
    const pts = e.polyline.map((p) => worldToSketch(b, p));
    count++;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i]!;
      umin = Math.min(umin, p.x); umax = Math.max(umax, p.x);
      vmin = Math.min(vmin, -p.y); vmax = Math.max(vmax, -p.y);
      if (i) perimeter += Math.hypot(p.x - pts[i - 1]!.x, p.y - pts[i - 1]!.y);
    }
    const ent = edgeEntity(e.kind, pts);
    if (ent) entities.push(ent);
  }
  const r6 = (x: number) => Math.round(x * 1e6) / 1e6;
  return { entities, perimeter: r6(perimeter), count,
           ...(count ? { box: [umin, vmin, umax, vmax].map(r6) as FaceRef['box'] } : {}) };
}

/** An edge (its kind, and points along it in sketch coordinates) as a
 *  reference (datum) + construction entity — drawn as a marker, snappable,
 *  never exported: a circle, a line, an arc as one bulged segment, anything
 *  else as a polyline. Null when it has no length on the sketch (an edge
 *  seen end on). `inPlane`: the edge lies in the sketch plane (a face
 *  outline); else it is projected onto it, and a circle seen at an angle (an
 *  ellipse) is a polyline. */
export function edgeEntity(kind: string, pts: Point[], inPlane = true): Entity | null {
  if (pts.length < 2) return null;
  const first = pts[0]!, last = pts[pts.length - 1]!;
  const closed = Math.hypot(first.x - last.x, first.y - last.y) < 1e-6;
  let reach = 0;
  for (const p of pts) reach = Math.max(reach, Math.hypot(p.x - first.x, p.y - first.y));
  if (reach < 1e-6) return null;
  const ref = { construction: true, reference: true } as const;
  if (kind === 'circle' && closed) {
    const ring = pts.slice(0, -1);
    const c = { x: ring.reduce((s, p) => s + p.x, 0) / ring.length, y: ring.reduce((s, p) => s + p.y, 0) / ring.length };
    const r = ring.reduce((s, p) => s + Math.hypot(p.x - c.x, p.y - c.y), 0) / ring.length;
    if (inPlane || ring.every((p) => Math.abs(Math.hypot(p.x - c.x, p.y - c.y) - r) < Math.max(0.01, r * 1e-3))) {
      return { id: generateId('e'), type: 'circle', center: c, radius: r, ...ref };
    }
  } else if (kind === 'line' || (!closed && ((kind === 'circle' && inPlane) || fitsArc(pts)))) {
    if (Math.hypot(last.x - first.x, last.y - first.y) < 1e-6) return null;
    // a line, or an arc as one bulged segment (the sampled middle point fixes the bulge)
    const bulge = kind === 'line' ? 0 : bulgeFromMidpoint(first, last, pts[(pts.length - 1) >> 1]!);
    return { id: generateId('e'), type: 'line', points: [first, last], ...(bulge ? { bulge: [bulge] } : {}), ...ref };
  }
  const ring = closed ? pts.slice(0, -1) : pts;
  return { id: generateId('e'), type: 'line', points: closed ? ring : simplify(ring, 0.01), closed: closed || undefined, ...ref };
}

/** A new sketch on the face: plane + face description, and the face's edges
 *  as fixed construction lines/circles. */
export function newFaceSketch(name: string, face: FaceInfo, edges: RunEdge[]): Sketch {
  const plane = planeForFace(face.center, face.normal);
  const out = faceOutline(face, edges, planeBasis(plane));
  return {
    id: generateId('sk'), name, visible: true, entities: out.entities,
    constraints: out.entities.map((e): Constraint => ({ id: generateId('c'), type: 'fixed', entityId: e.id })),
    plane: { origin: round(plane.origin), normal: round(plane.normal), xAxis: round(plane.xAxis) },
    face: {
      center: face.center, normal: face.normal, area: face.area,
      ...(out.count ? { box: out.box, perimeter: out.perimeter, edges: out.count } : {}),
      hint: faceLabel(face.normal),
    },
  };
}

/** The sketch with its reference outline drawn again from the face as it is
 *  now (`plane`: where the last build put the sketch), and the part edges
 *  projected onto it found again (build/projectEdges.ts), or null when
 *  nothing changed: followRefs with the viewer's edges, for a sketch opened
 *  before a build has reported its face's outline. `face`: the face the
 *  sketch is on (none: a plane sketch, or its face wasn't found). Expression
 *  dimensions are set afterwards by the caller (resolveSketch). */
export function refreshOutline(sk: Sketch, face: FaceInfo | undefined, edges: RunEdge[], plane: NonNullable<Sketch['plane']>): Sketch | null {
  const b = planeBasis(plane);
  const outline = face && sk.face ? faceOutline(face, edges, b).entities : [];
  const r = followRefs(sk, outline, undefined, edges.length ? matchProjected(sk, edges, b) : undefined);
  return r.changed ? r.sketch : null;
}

/** What K / "Sketch on face" offers on a face that has sketches already:
 *  each of them (nearest first, with how many things are drawn in it) and a
 *  new one. null: none yet, start one straight away. */
export interface FaceSketchMenu { face: FaceInfo; items: { id: string; name: string; count: number }[] }

/** How many things are drawn in a sketch (not its references or dimensions). */
export function drawnCount(s: Sketch): number {
  return s.entities.filter((e) => !isRef(e) && e.type !== 'dimension').length;
}

export function faceSketchMenu(sketches: Sketch[], face: FaceInfo, bound?: SketchBindings | null): FaceSketchMenu | null {
  const items: { id: string; name: string; count: number; d: number }[] = [];
  for (const s of sketches) {
    const d = acrossDistance(s, face, bound);
    if (d == null) continue;
    items.push({ id: s.id, name: s.name, d,
                 count: drawnCount(s) });
  }
  if (!items.length) return null;
  items.sort((a, b) => a.d - b.d);
  return { face, items: items.map(({ id, name, count }) => ({ id, name, count })) };
}

/** The base planes through the origin, for sketching before there is a part
 *  (or independent of its faces). Normals as the standard views look from. */
export const BASE_PLANES = {
  top: { name: 'Top plane', axes: 'XY', normal: [0, 0, 1] as Vec3 },
  front: { name: 'Front plane', axes: 'XZ', normal: [0, -1, 0] as Vec3 },
  right: { name: 'Right plane', axes: 'YZ', normal: [1, 0, 0] as Vec3 },
};
export type BasePlane = keyof typeof BASE_PLANES;

/** The base plane a sketch is on (null: on a part face, or none). */
export function sketchBasePlane(s: Sketch): BasePlane | null {
  if (!s.plane || s.face || s.planeRef) return null;
  const b = planeBasis(s.plane);
  if (len(b.origin) > 1e-6) return null;
  for (const [k, p] of Object.entries(BASE_PLANES)) if (dot(b.normal, p.normal) > 0.999) return k as BasePlane;
  return null;
}

/** A sketch on a tangent plane (planes.tangent_plane): it faces out of the
 *  material, so it extrudes like a face sketch (a cut goes in), not like a
 *  sketch on a base or offset plane. */
export function onTangentPlane(s: Sketch, planes: Record<string, { kind: string }> | undefined): boolean {
  return !!s.planeRef && planes?.[s.planeRef]?.kind === 'tangent';
}

/** A new sketch on a base plane, with the origin as a fixed reference point. */
export function newPlaneSketch(name: string, which: BasePlane): Sketch {
  const plane = planeForFace([0, 0, 0], BASE_PLANES[which].normal);
  const origin: Entity = { id: generateId('e'), type: 'point', position: { x: 0, y: 0 }, construction: true, reference: true };
  return {
    id: generateId('sk'), name, visible: true, entities: [origin],
    constraints: [{ id: generateId('c'), type: 'fixed', entityId: origin.id }],
    plane: { origin: [0, 0, 0], normal: round(plane.normal), xAxis: round(plane.xAxis) },
  };
}

/** A new sketch on the construction plane `planeName` (where the build last
 *  put it), with the plane's origin as a fixed reference point. */
export function newConstructionSketch(name: string, planeName: string, plane: ConstructionPlane): Sketch {
  const origin: Entity = { id: generateId('e'), type: 'point', position: { x: 0, y: 0 }, construction: true, reference: true };
  return {
    id: generateId('sk'), name, visible: true, entities: [origin],
    constraints: [{ id: generateId('c'), type: 'fixed', entityId: origin.id }],
    plane: { origin: round(plane.origin), normal: round(plane.normal), xAxis: round(plane.xAxis) },
    planeRef: planeName,
  };
}

/** The sketches drawn on the construction plane `name`. */
export function planeSketches(sketches: Sketch[], name: string): Sketch[] {
  return sketches.filter((s) => s.planeRef === name);
}

/** The sketches with a plane renamed from `old` to `name` pointing at it. */
export function renamePlaneRefs(sketches: Sketch[], old: string, name: string): Sketch[] {
  return sketches.map((s) => (s.planeRef === old ? { ...s, planeRef: name } : s));
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
  if (isAxis(e)) return [];   // the sketch's axes: drawn across the view, never part of its shape
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

/** A face sketch as 3D segment pairs on its plane (or `plane`: where the
 *  last build put it), for the viewer. */
export function sketchSegments(sketch: Sketch, plane: Sketch['plane'] = sketch.plane): number[] {
  if (!plane) return [];
  const b: PlaneBasis = planeBasis(plane);
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

export type XY = [number, number];

/** One edge of a closed shape, in sketch coordinates (y down). */
export type ProfileSegment =
  | { t: 'line'; p: [XY, XY] }
  | { t: 'arc'; p: [XY, XY, XY] }                  // start, a point on it, end
  | { t: 'circle'; c: XY; r: number }
  | { t: 'bezier'; p: [XY, XY, XY, XY] };

/** A face sketch's closed shapes and points on its plane — what sketch("name")
 *  and sketch_points("name") build from — and the face it was drawn on, so the
 *  build can follow that face. */
export interface SketchProfile {
  plane: NonNullable<Sketch['plane']>;
  loops: ProfileSegment[][];
  points?: XY[];        // its point entities: with the circle centres, where sketch_points() puts holes
  lines?: Record<string, [XY, XY]>;   // its straight construction / reference lines (the axes too), for sketch_line()
  face?: FaceRef;
  planeRef?: string;    // on a construction plane: the build takes the plane from PLANES[planeRef]
}

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
  const points = sketch.entities.flatMap((e) => (e.type === 'point' ? [xy(e.position)] : []));
  const lines = axisLines(sketch);
  return {
    plane: sketch.plane, loops: sketchLoops(sketch).loops,
    ...(points.length ? { points } : {}),
    ...(Object.keys(lines).length ? { lines } : {}),
    ...(sketch.face ? { face: sketch.face } : {}),
    ...(sketch.planeRef ? { planeRef: sketch.planeRef } : {}),
  };
}

/** The straight lines a revolve can turn about, by id: the built-in axes
 *  and the sketch's 2-point construction and reference lines. */
export function axisLines(sketch: Sketch): Record<string, [XY, XY]> {
  const out: Record<string, [XY, XY]> = {};
  for (const e of sketch.entities) {
    if (e.type !== 'line' || e.points.length !== 2 || e.closed || e.bulge?.some((b) => b) || isBroken(e)) continue;
    if (!e.construction && !e.reference) continue;
    const [a, b] = e.points as [Point, Point];
    if (Math.hypot(b.x - a.x, b.y - a.y) < 1e-9) continue;
    out[e.id] = [xy(a), xy(b)];
  }
  return out;
}

/** Where sketch_points("name") puts holes: the sketch's points and the
 *  centres of its (non-construction) circles, each place once. */
export function sketchHolePoints(sketch: Sketch): Point[] {
  const out: Point[] = [];
  for (const e of sketch.entities) {
    const p = e.type === 'point' ? e.position
      : e.type === 'circle' && !e.construction && e.radius > 0 ? e.center : null;
    if (p && !out.some((o) => Math.hypot(o.x - p.x, o.y - p.y) < 1e-6)) out.push(p);
  }
  return out;
}

// matches the engine's SKETCH_REF (modeling/engine.py)
const SKETCH_REF = /\bsketch(?:_points|_line)?\(\s*(["'])(.+?)\1\s*[,)]/g;

/** The names of the sketches `code` uses (sketch("name"), sketch_points("name"),
 *  sketch_line("name", "line")), each once. */
export function referencedSketchNames(code: string): string[] {
  return [...new Set([...code.matchAll(SKETCH_REF)].map((m) => m[2]!))];
}

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

// ── extrude preview ──

/** What an extrude does, as far as its direction and reach go. */
export interface ExtrudeShape {
  op: 'cut' | 'join' | 'new';
  depth: number;
  through: boolean;   // cut through the part (op 'cut' only)
  flip: boolean;
  both?: boolean;     // symmetric: `depth` each way (not with through)
  datum?: boolean;    // on a base plane, not a part face
  until?: boolean;    // up to a face or the next one: no depth to say
}

/** +1: along the plane normal, −1: against it. A face sketch's normal points
 *  out of the part, so a cut goes in (−1) and a join grows out (+1); a base
 *  plane has no outside, so everything goes along it. Flip reverses. Matches
 *  the script line paramedit.add_extrude writes. */
export function extrudeSign(o: ExtrudeShape): 1 | -1 {
  const into = o.op === 'cut' && !o.datum;
  return into !== o.flip ? -1 : 1;
}

/** A depth typed or dragged below zero: the extrude goes the other way
 *  (Flip) and the depth stays positive — a depth is never negative. Both
 *  ways (symmetric) has no other way: just the size. */
export function typedDepth(x: number, flip: boolean, both = false): { depth: number; flip: boolean } {
  return x < 0 ? { depth: -x, flip: both ? flip : !flip } : { depth: x, flip };
}

/** What typing `raw` into a depth field does: a number sets the depth (below
 *  0: positive, flipped); anything else (a lone "-", an empty field) is text
 *  still being typed, kept in the field without touching the depth. */
export function depthEdit(raw: string, flip: boolean, both = false): { depth: number; flip: boolean } | { draft: string } {
  const x = raw.trim() === '' ? NaN : Number(raw);
  return Number.isFinite(x) ? typedDepth(x, flip, both) : { draft: raw };
}

/** The offsets along the plane normal an extrude spans, [from, to] (from ≤ to).
 *  A through cut reaches across the part: `extent` is the part's [min, max]
 *  signed distance from the plane (null: no part, e.g. a first body). */
export function extrudeSpan(o: ExtrudeShape, extent: [number, number] | null): [number, number] {
  const s = extrudeSign(o);
  if (o.op === 'cut' && o.through) {
    const [lo, hi] = extent ?? [-50, 50];
    if (o.datum) return [Math.min(lo, 0), Math.max(hi, 0)];   // both ways
    const reach = s < 0 ? -lo : hi;
    const d = reach > 1e-3 ? reach : Math.max(hi - lo, 1);    // flipped out of the face: nothing to cut
    return s < 0 ? [-d, 0] : [0, d];
  }
  const d = Math.max(o.depth || 0, 0);
  if (o.both) return [-d, d];
  return s < 0 ? [-d, 0] : [0, d];
}

const AXIS_WORDS: [Vec3, string, string][] = [
  [[0, 0, 1], 'up', 'Z'], [[0, 0, -1], 'down', 'Z'],
  [[0, -1, 0], 'toward the front', 'Y'], [[0, 1, 0], 'toward the back', 'Y'],
  [[1, 0, 0], 'to the right', 'X'], [[-1, 0, 0], 'to the left', 'X'],
];

/** Where the part's middle is from a plane, along its normal (+: the side the
 *  normal points to), from the part's box. */
export const partSide = (origin: Vec3, normal: Vec3, min: readonly number[], max: readonly number[]): number =>
  dot(sub(scale(add(min as Vec3, max as Vec3), 0.5), origin), normal);

/** A depth in words: 5, 2.5 (no float noise); "?" when it isn't a number. */
const mmWords = (d: number): string => (Number.isFinite(d) ? `${Math.round(d * 1000) / 1000}` : '?');

/** What the extrude does and which way, in plain words: "Cut 5 mm into the
 *  part, down (−Z)", "Add 5 mm out of the face, up (+Z)", "5 mm up (+Z)" (a
 *  new body), "Add 4 mm each way (±Y)". `partAt` (partSide) says, for a
 *  tilted plane with no axis to name, whether it goes toward the part or away
 *  from it. Matches the steps list's (paramedit._extrude_words). */
export function extrudeDirectionText(o: ExtrudeShape, normal: Vec3, partAt?: number): string {
  const s = extrudeSign(o);
  const d = scale(normal, s);
  const ax = AXIS_WORDS.find(([v]) => dot(v, d) > 0.999);
  const axBoth = AXIS_WORDS.find(([v]) => Math.abs(dot(v, d)) > 0.999);
  const verb = o.op === 'cut' ? 'Cut ' : o.op === 'join' ? 'Add ' : '';
  const through = o.op === 'cut' && o.through;
  if (through && o.datum) return `${verb}through the part, both ways from the plane`;
  if (o.both && !through) return `${verb}${mmWords(o.depth)} mm each way ${axBoth ? `(±${axBoth[2]})` : 'from the plane'}`;
  if (o.until) {
    const way = o.datum ? '' : s < 0 ? 'into the part' : 'out of the face';
    return `${verb}${[way, ax ? `${ax[1]} (${dot(ax[0], [1, 1, 1]) > 0 ? '+' : '−'}${ax[2]})` : ''].filter(Boolean).join(', ')
      || 'along the plane'}`.trim();
  }
  const far = through ? 'through the part' : `${mmWords(o.depth)} mm`;
  const sign = ax ? (dot(ax[0], [1, 1, 1]) > 0 ? '+' : '−') : '';
  const axis = ax ? `${ax[1]} (${sign}${ax[2]})` : '';
  if (o.datum) {
    if (axis) return `${verb}${far} ${axis}`;
    if (partAt === undefined || Math.abs(partAt) < 1e-6) return `${verb}${far} from the plane`;
    return `${verb}${far} ${partAt * s > 0 ? 'toward the part' : 'away from the part'}`;
  }
  const where = s < 0 ? 'into the part' : 'out of the face';
  const nothing = o.op === 'cut' && s > 0 ? ' — cuts nothing there' : '';
  return `${verb}${through ? `through the part${s > 0 ? ', ' + where : ''}` : `${far} ${where}`}${axis ? `, ${axis}` : ''}${nothing}`;
}

// a closed shape as a sketch-space polyline, plus its corners (where side
// edges of the extruded prism are drawn)
function loopOutline(loop: ProfileSegment[]): { pts: Point[]; corners: Point[] } {
  const P = (p: XY): Point => ({ x: p[0], y: p[1] });
  const pts: Point[] = [], corners: Point[] = [];
  for (const s of loop) {
    if (s.t === 'circle') {
      for (let i = 0; i <= 48; i++) {
        const a = (i / 48) * Math.PI * 2;
        pts.push({ x: s.c[0] + s.r * Math.cos(a), y: s.c[1] + s.r * Math.sin(a) });
      }
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * Math.PI * 2;
        corners.push({ x: s.c[0] + s.r * Math.cos(a), y: s.c[1] + s.r * Math.sin(a) });
      }
      continue;
    }
    corners.push(P(s.p[0]));
    // each piece adds its start and inside points: the next piece's start ends it
    if (s.t === 'line') pts.push(P(s.p[0]));
    else if (s.t === 'bezier') {
      const [a, b, c, d] = s.p.map(P) as [Point, Point, Point, Point];
      for (let i = 0; i < 24; i++) pts.push(bezierPoint(a, b, c, d, i / 24));
    } else {
      const [a, m, b] = s.p.map(P) as [Point, Point, Point];
      const k = bulgeFromMidpoint(a, b, m);
      pts.push(a, ...arcPoints(a, b, k));
      corners.push(m);
    }
  }
  if (loop[0]?.t !== 'circle' && pts.length) pts.push(pts[0]!);   // close it
  return { pts, corners };
}

/** A preview of an extrude, as 3D segment pairs: the shapes at each end of
 *  `span` (and on the plane, when the span crosses it), side edges at their
 *  corners, and arrows from the shapes' middle showing which way it goes. */
export function extrudeGhost(
  sketch: Sketch, span: [number, number], plane: Sketch['plane'] = sketch.plane, outline?: XY[][],
): { edges: number[]; arrows: number[] } {
  const edges: number[] = [], arrows: number[] = [];
  if (!plane) return { edges, arrows };
  const b = planeBasis(plane);
  const at = (p: Point, off: number): Vec3 => {
    const w = sketchToWorld(b, p);
    return [w[0] + b.normal[0] * off, w[1] + b.normal[1] * off, w[2] + b.normal[2] * off];
  };
  const levels = [span[0], span[1]];
  if (span[0] < -1e-6 && span[1] > 1e-6) levels.push(0);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  // the regions picked: their outline, else every closed shape
  const outlines = outline
    ? outline.map((e) => {
      const pts = e.map(([x, y]) => ({ x, y }));
      return { pts, corners: [pts[0]!, pts[pts.length - 1]!] };
    })
    : sketchLoops(sketch).loops.map(loopOutline);
  for (const { pts, corners } of outlines) {
    for (const off of levels) {
      for (let i = 0; i + 1 < pts.length; i++) edges.push(...at(pts[i]!, off), ...at(pts[i + 1]!, off));
    }
    for (const c of corners) edges.push(...at(c, span[0]), ...at(c, span[1]));
    for (const p of pts) {
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
    }
  }
  if (!Number.isFinite(minX)) return { edges, arrows };
  const mid: Point = { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
  const size = Math.max(maxX - minX, maxY - minY);
  for (const end of span) {
    if (Math.abs(end) < 1e-6) continue;
    const tip = at(mid, end);
    const head = Math.min(Math.abs(end) * 0.35, size * 0.2, 12);
    const back = end - Math.sign(end) * head;
    arrows.push(...at(mid, 0), ...tip);
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      arrows.push(...tip, ...at({ x: mid.x + dx! * head * 0.45, y: mid.y + dy! * head * 0.45 }, back));
    }
  }
  return { edges, arrows };
}
