/**
 * Corner fillets: a sharp corner between two straight segments of a polyline
 * replaced by an arc segment (a bulge) tangent to both, the neighbours
 * shortened to meet it. A rectangle rounds all four corners together (its
 * cornerRadius, see rectPath.ts).
 */
import type { Constraint, DimensionEntity, Entity, LineEntity, Point, RectangleEntity } from '@/types/document';
import { DIMENSION_OFFSET_MM } from '@/config';
import { remapRefs } from '@/utils/remapRefs';
import { getSegmentBulge, getSegmentCount } from '@/utils/lineSegments';
import { arcFromBulge } from '@/utils/arcGeometry';
import { lineLineIntersection } from '@/utils/geometry';
import { maxCornerRadius } from '@/utils/rectPath';

/** A corner to round: a polyline's vertex, or a rectangle's corner (0=TL,
 *  1=TR, 2=BR, 3=BL, as rectangleCorners numbers them). */
export interface Corner {
  entityId: string;
  index: number;
}

function unit(from: Point, to: Point): Point | null {
  const dx = to.x - from.x, dy = to.y - from.y;
  const len = Math.hypot(dx, dy);
  return len < 1e-9 ? null : { x: dx / len, y: dy / len };
}

/** Vertex `i` of `line` as a corner that can be rounded: two straight
 *  segments meeting at an angle. null at an open end, next to an arc, or
 *  where the segments run straight on (or double back). */
export function cornerAt(line: LineEntity, i: number): { prev: Point; v: Point; next: Point } | null {
  const n = line.points.length;
  if (n < 3 || i < 0 || i >= n) return null;
  if (!line.closed && (i === 0 || i === n - 1)) return null;
  if (getSegmentBulge(line, (i - 1 + n) % n) !== 0 || getSegmentBulge(line, i) !== 0) return null;
  const prev = line.points[(i - 1 + n) % n]!, v = line.points[i]!, next = line.points[(i + 1) % n]!;
  const a = unit(v, prev), b = unit(v, next);
  if (!a || !b) return null;
  if (Math.abs(a.x * b.y - a.y * b.x) < 1e-6) return null;
  return { prev, v, next };
}

export interface FilletGeom {
  /** where the arc meets the segment from `prev`, and the one to `next` */
  t1: Point;
  t2: Point;
  /** the arc segment t1 → t2 */
  bulge: number;
  radius: number;
  /** the radius asked for didn't fit: this is the largest that does */
  clamped: boolean;
}

/** The fillet of radius `r` at corner `v` between the lines to `prev` and
 *  `next`, its tangent points no further than `maxPrev` / `maxNext` from the
 *  corner (else the radius is cut down to fit). */
export function filletGeom(prev: Point, v: Point, next: Point, r: number, maxPrev: number, maxNext: number): FilletGeom | null {
  const a = unit(v, prev), b = unit(v, next);
  if (!a || !b || !(r > 0)) return null;
  const theta = Math.acos(Math.max(-1, Math.min(1, a.x * b.x + a.y * b.y)));
  if (theta < 1e-6 || Math.PI - theta < 1e-6) return null;
  const tanHalf = Math.tan(theta / 2);
  let t = r / tanHalf;
  let radius = r;
  let clamped = false;
  const maxT = Math.min(maxPrev, maxNext);
  if (t > maxT + 1e-9) {
    t = maxT;
    radius = t * tanHalf;
    clamped = true;
  }
  const t1 = { x: v.x + a.x * t, y: v.y + a.y * t };
  const t2 = { x: v.x + b.x * t, y: v.y + b.y * t };
  // the arc bows toward the corner: arcMidpoint puts a positive bulge's
  // middle on the right of t1 → t2
  const cross = (t2.x - t1.x) * (v.y - t1.y) - (t2.y - t1.y) * (v.x - t1.x);
  const bulge = (cross > 0 ? -1 : 1) * Math.tan((Math.PI - theta) / 4);
  return { t1, t2, bulge, radius, clamped };
}

export interface FilletedLine {
  entity: LineEntity;
  /** new index of an old point / segment; null when it is gone */
  pointMap: (i: number) => number | null;
  segmentMap: (i: number) => number | null;
  /** the old segments now shorter (their length dimensions no longer apply) */
  shortened: Set<number>;
  /** the new arc segments, by the vertex each rounds */
  arcs: { vertex: number; segment: number; radius: number; clamped: boolean }[];
  /** vertices asked for that aren't corners (see cornerAt) */
  skipped: number[];
}

/** `line` with each of `vertices` rounded to radius `r`. Two rounded corners
 *  on one segment share it half and half. Drops a regular polygon's centre:
 *  rounded, it is an ordinary outline. */
export function filletLine(line: LineEntity, vertices: number[], r: number): FilletedLine | null {
  const n = line.points.length;
  const want = new Set(vertices.filter((i) => cornerAt(line, i)));
  const skipped = vertices.filter((i) => !want.has(i));
  if (!want.size) return null;
  const segLen = (k: number) => {
    const p = line.points[k]!, q = line.points[(k + 1) % n]!;
    return Math.hypot(q.x - p.x, q.y - p.y);
  };
  const geoms = new Map<number, FilletGeom>();
  for (const i of want) {
    const c = cornerAt(line, i)!;
    const pi = (i - 1 + n) % n, ni = (i + 1) % n;
    const maxPrev = segLen(pi) / (want.has(pi) ? 2 : 1);
    const maxNext = segLen(i) / (want.has(ni) ? 2 : 1);
    const g = filletGeom(c.prev, c.v, c.next, r, maxPrev, maxNext);
    if (g) geoms.set(i, g);
  }
  if (!geoms.size) return null;

  // points tagged with the old vertex they are (none: a tangent point),
  // segments with the old segment or the vertex whose arc they are
  const pts: { p: Point; vertex?: number }[] = [];
  const segs: { bulge: number; old?: number; arc?: FilletGeom & { vertex: number } }[] = [];
  const shortened = new Set<number>();
  const segCount = getSegmentCount(line);
  for (let j = 0; j < n; j++) {
    const g = geoms.get(j);
    if (g) {
      pts.push({ p: g.t1 });
      segs.push({ bulge: g.bulge, arc: { ...g, vertex: j } });
      pts.push({ p: g.t2 });
      shortened.add((j - 1 + n) % n);
      shortened.add(j);
    } else {
      pts.push({ p: line.points[j]!, vertex: j });
    }
    if (j < segCount) segs.push({ bulge: getSegmentBulge(line, j), old: j });
  }
  // A clamped fillet reaches the far end of its neighbour (or the next
  // fillet's start): drop the straight piece of no length left between.
  for (let m = 0; m < segs.length;) {
    const a = pts[m]!, bIdx = (m + 1) % pts.length, b = pts[bIdx]!;
    const gone = segs[m]!.bulge === 0 && Math.hypot(b.p.x - a.p.x, b.p.y - a.p.y) < 1e-9;
    if (!gone || (a.vertex != null && b.vertex != null)) { m++; continue; }
    segs.splice(m, 1);
    if (a.vertex == null) {
      pts.splice(m, 1);
    } else if (bIdx > 0) {
      pts.splice(bIdx, 1);
    } else {
      // the closing piece, into the first point: the old first segment now
      // closes the outline
      pts.shift();
      segs.push(segs.shift()!);
    }
  }
  const pointIdx = new Map<number, number>();
  const segIdx = new Map<number, number>();
  pts.forEach((x, i) => { if (x.vertex != null) pointIdx.set(x.vertex, i); });
  const arcs: FilletedLine['arcs'] = [];
  segs.forEach((x, i) => {
    if (x.old != null) segIdx.set(x.old, i);
    if (x.arc) arcs.push({ vertex: x.arc.vertex, segment: i, radius: x.arc.radius, clamped: x.arc.clamped });
  });
  const { polygonCenter: _, ...rest } = line;
  return {
    entity: { ...rest, points: pts.map((x) => x.p), bulge: segs.map((x) => x.bulge) },
    pointMap: (i) => pointIdx.get(i) ?? null,
    segmentMap: (i) => segIdx.get(i) ?? null,
    shortened,
    arcs,
    skipped,
  };
}

/** `rect` with its corners rounded to `r`, or the most that fits. */
export function filletRectangle(rect: RectangleEntity, r: number): { entity: RectangleEntity; radius: number; clamped: boolean } {
  const max = maxCornerRadius(rect.width, rect.height);
  const radius = Math.min(r, max);
  return { entity: { ...rect, cornerRadius: radius }, radius, clamped: r > max + 1e-9 };
}

/** The radius of arc segment `seg`; null when it is straight. */
export function arcSegmentRadius(line: LineEntity, seg: number): number | null {
  const b = getSegmentBulge(line, seg);
  if (!b) return null;
  const p = line.points[seg], q = line.points[(seg + 1) % line.points.length];
  if (!p || !q) return null;
  return arcFromBulge(p, q, b).radius;
}

/** Whether the arc at `p` (centre `c`) runs on along the line from `from`. */
function tangentAt(c: Point, p: Point, from: Point): boolean {
  const radial = unit(c, p), along = unit(from, p);
  return !!radial && !!along && Math.abs(radial.x * along.x + radial.y * along.y) < 1e-3;
}

/** `line` with arc segment `seg` at radius `r`. A fillet (tangent to straight
 *  neighbours that meet at a corner) is refitted into that corner, its
 *  neighbours lengthened or shortened, no further than their far ends; any
 *  other arc keeps its ends and changes its bulge (no less than a half
 *  circle across them). */
export function setArcRadius(line: LineEntity, seg: number, r: number): LineEntity | null {
  const n = line.points.length;
  const segCount = getSegmentCount(line);
  const b = getSegmentBulge(line, seg);
  if (!b || seg < 0 || seg >= segCount || !(r > 0)) return null;
  const i1 = seg, i2 = (seg + 1) % n;
  const p1 = line.points[i1]!, p2 = line.points[i2]!;
  const hasPrev = line.closed || seg > 0;
  const hasNext = line.closed || seg < segCount - 1;
  if (hasPrev && hasNext && segCount >= 3) {
    const pSeg = (seg - 1 + segCount) % segCount, nSeg = (seg + 1) % segCount;
    const p0 = line.points[pSeg]!, p3 = line.points[(i2 + 1) % n]!;
    const { center } = arcFromBulge(p1, p2, b);
    if (getSegmentBulge(line, pSeg) === 0 && getSegmentBulge(line, nSeg) === 0
      && tangentAt(center, p1, p0) && tangentAt(center, p2, p3)) {
      const v = lineLineIntersection(p0, p1, p3, p2);
      if (v) {
        const g = filletGeom(p0, v, p3, r, Math.hypot(p0.x - v.x, p0.y - v.y), Math.hypot(p3.x - v.x, p3.y - v.y));
        if (g) {
          const points = line.points.slice();
          points[i1] = g.t1;
          points[i2] = g.t2;
          const bulge = (line.bulge ?? []).slice();
          bulge[seg] = g.bulge;
          return { ...line, points, bulge };
        }
      }
    }
  }
  const chord = Math.hypot(p2.x - p1.x, p2.y - p1.y);
  if (chord < 1e-9) return null;
  const rr = Math.max(r, chord / 2);
  let sweep = 2 * Math.asin(Math.min(1, chord / (2 * rr)));
  if (Math.abs(b) > 1) sweep = 2 * Math.PI - sweep;
  const bulge = (line.bulge ?? []).slice();
  bulge[seg] = Math.sign(b) * Math.tan(sweep / 4);
  return { ...line, bulge };
}

export interface FilletOutcome {
  entities: Entity[];
  constraints: Constraint[];
  /** corners rounded */
  rounded: number;
  /** the smallest radius used where the one asked for didn't fit (else null) */
  clampedTo: number | null;
  /** constraints and dimensions dropped: on a corner point now gone, or a
   *  length on a segment now shorter */
  dropped: number;
  /** corners that couldn't be rounded (not a corner, a copy, reference geometry) */
  skipped: number;
}

/** The sketch with `corners` rounded to radius `r`, each new arc given a
 *  radius dimension (a rectangle: one for its four corners). null when no
 *  corner could be rounded. */
export function filletSketch(entities: Entity[], constraints: Constraint[], corners: Corner[], r: number, newId: () => string): FilletOutcome | null {
  const byEntity = new Map<string, number[]>();
  for (const c of corners) byEntity.set(c.entityId, [...(byEntity.get(c.entityId) ?? []), c.index]);
  let rounded = 0, dropped = 0, skipped = 0;
  let clampedTo: number | null = null;
  const clamp = (radius: number) => { clampedTo = clampedTo == null ? radius : Math.min(clampedTo, radius); };
  const newDims: DimensionEntity[] = [];
  for (const [id, idx] of byEntity) {
    const e = entities.find((x) => x.id === id);
    const locked = !e || ('sourceId' in e && !!e.sourceId) || ('reference' in e && !!e.reference);
    if (locked || (e.type !== 'line' && e.type !== 'rectangle')) { skipped += idx.length; continue; }
    if (e.type === 'rectangle') {
      const f = filletRectangle(e, r);
      entities = entities.map((x) => (x.id === id ? f.entity : x));
      if (f.clamped) clamp(f.radius);
      rounded += 4; // a rectangle rounds all four (its one corner radius)
      if (!entities.some((x) => x.type === 'dimension' && x.radius && x.targetEntityId === id)) {
        newDims.push({ id: newId(), type: 'dimension', targetEntityId: id, segmentIndex: idx[0]!, offset: DIMENSION_OFFSET_MM, radius: true });
      }
      continue;
    }
    const f = filletLine(e, [...new Set(idx)], r);
    if (!f) { skipped += idx.length; continue; }
    skipped += f.skipped.length;
    const onShortened = (x: Constraint | Entity) => {
      if (x.type === 'dimension') {
        return !x.radius && !x.angleMode && x.targetEntityId === id && x.pointIndex == null
          && x.targetEntityId2 == null && f.shortened.has(x.segmentIndex);
      }
      if (x.type === 'equal') {
        return (x.entityId === id && x.segmentIndex != null && f.shortened.has(x.segmentIndex))
          || (x.targetEntityId === id && x.targetSegmentIndex != null && f.shortened.has(x.targetSegmentIndex));
      }
      return false;
    };
    const re = remapRefs(entities, constraints, { entityId: id, point: f.pointMap, segment: f.segmentMap }, (x) => !onShortened(x));
    entities = re.entities.map((x) => (x.id === id ? f.entity : x));
    constraints = re.constraints;
    dropped += re.dropped;
    for (const a of f.arcs) {
      rounded++;
      if (a.clamped) clamp(a.radius);
      newDims.push({ id: newId(), type: 'dimension', targetEntityId: id, segmentIndex: a.segment, offset: DIMENSION_OFFSET_MM, radius: true });
    }
  }
  if (!rounded) return null;
  return { entities: [...entities, ...newDims], constraints, rounded, clampedTo, dropped, skipped };
}
