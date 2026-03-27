import type { Entity, Sketch, Point, LineEntity, CircleEntity, RectangleEntity, BezierEntity } from '@/types/document';
import { isClosedProfile } from '@/types/document';

/** A closed chain of connected entities that forms an extrudable profile. */
export interface EntityChain {
  /** Synthetic ID for the chain (first entity's ID). */
  id: string;
  /** Ordered entities forming the closed loop. Each entity has a `reversed` flag if needed. */
  entities: Entity[];
  /** Polyline approximation of the closed chain (for reliable wire building). */
  polyline: Point[];
}

/** Get all extrudable (non-construction, closed) entities from a sketch. */
export function getExtrudableEntities(sketch: Sketch): Entity[] {
  return sketch.entities.filter((e) => {
    if (e.type === 'rectangle') return !e.construction;
    if (e.type === 'circle') return !e.construction;
    if (e.type === 'line') return isClosedProfile(e as LineEntity);
    return false;
  });
}

const TOLERANCE = 0.5;

function ptClose(a: Point, b: Point): boolean {
  const dx = a.x - b.x, dy = a.y - b.y;
  return dx * dx + dy * dy < TOLERANCE * TOLERANCE;
}

function ptDist(a: Point, b: Point): number {
  const dx = a.x - b.x, dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

function getEndpoints(e: Entity): [Point, Point] | null {
  if (e.type === 'line') {
    const l = e as LineEntity;
    if (l.points.length < 2) return null;
    return [l.points[0]!, l.points[l.points.length - 1]!];
  }
  if (e.type === 'bezier') {
    const b = e as BezierEntity;
    return [b.controlPoints[0], b.controlPoints[3]];
  }
  return null;
}

/** Check if a point lies on a circle (within tolerance). */
function pointOnCircle(p: Point, c: CircleEntity): boolean {
  return Math.abs(ptDist(p, c.center) - c.radius) < TOLERANCE;
}

/** Sample an arc from angle a1 to a2 on a circle as polyline points. */
function sampleArc(circle: CircleEntity, from: Point, to: Point): Point[] {
  const a1 = Math.atan2(from.y - circle.center.y, from.x - circle.center.x);
  let a2 = Math.atan2(to.y - circle.center.y, to.x - circle.center.x);

  // Choose the shorter arc
  let delta = a2 - a1;
  if (delta > Math.PI) delta -= 2 * Math.PI;
  if (delta < -Math.PI) delta += 2 * Math.PI;

  const steps = Math.max(4, Math.ceil(Math.abs(delta) / (Math.PI / 8)));
  const pts: Point[] = [];
  for (let i = 1; i <= steps; i++) {
    const t = a1 + (delta * i) / steps;
    pts.push({
      x: circle.center.x + circle.radius * Math.cos(t),
      y: circle.center.y + circle.radius * Math.sin(t),
    });
  }
  return pts;
}

/** Evaluate cubic bezier at parameter t. */
function evalBezier(cp: [Point, Point, Point, Point], t: number): Point {
  const u = 1 - t;
  return {
    x: u * u * u * cp[0].x + 3 * u * u * t * cp[1].x + 3 * u * t * t * cp[2].x + t * t * t * cp[3].x,
    y: u * u * u * cp[0].y + 3 * u * u * t * cp[1].y + 3 * u * t * t * cp[2].y + t * t * t * cp[3].y,
  };
}

/** Convert an entity to polyline points (start to end, NOT including the start point). */
function entityToPolyline(e: Entity, reversed: boolean): Point[] {
  if (e.type === 'line') {
    const l = e as LineEntity;
    const pts = reversed ? [...l.points].reverse() : [...l.points];
    return pts.slice(1); // skip start (it's the previous segment's end)
  }
  if (e.type === 'bezier') {
    const b = e as BezierEntity;
    const cp: [Point, Point, Point, Point] = reversed
      ? [b.controlPoints[3], b.controlPoints[2], b.controlPoints[1], b.controlPoints[0]]
      : [...b.controlPoints];
    const steps = 6;
    const pts: Point[] = [];
    for (let i = 1; i <= steps; i++) {
      pts.push(evalBezier(cp, i / steps));
    }
    return pts;
  }
  return [];
}

interface ChainEntry { entity: Entity; reversed: boolean }
interface CandidateChain {
  chain: ChainEntry[];
  chainStart: Point;
  closingArcPts: Point[] | null;
}

/** Try to build the longest chain starting from a given entity. */
function buildChainFrom(
  start: Entity,
  chainable: Entity[],
  circles: CircleEntity[],
): CandidateChain | null {
  const startEps = getEndpoints(start);
  if (!startEps) return null;

  const chain: ChainEntry[] = [{ entity: start, reversed: false }];
  const chainUsed = new Set<string>([start.id]);
  let currentEnd = startEps[1];
  let chainStart = startEps[0];
  let extended = true;

  // Grow forward from the end
  while (extended) {
    extended = false;
    for (const candidate of chainable) {
      if (chainUsed.has(candidate.id)) continue;
      const eps = getEndpoints(candidate);
      if (!eps) continue;

      if (ptClose(currentEnd, eps[0])) {
        chain.push({ entity: candidate, reversed: false });
        chainUsed.add(candidate.id);
        currentEnd = eps[1];
        extended = true;
        break;
      }
      if (ptClose(currentEnd, eps[1])) {
        chain.push({ entity: candidate, reversed: true });
        chainUsed.add(candidate.id);
        currentEnd = eps[0];
        extended = true;
        break;
      }
    }
  }

  // Grow backward from the start
  extended = true;
  while (extended) {
    extended = false;
    for (const candidate of chainable) {
      if (chainUsed.has(candidate.id)) continue;
      const eps = getEndpoints(candidate);
      if (!eps) continue;

      if (ptClose(chainStart, eps[1])) {
        chain.unshift({ entity: candidate, reversed: false });
        chainUsed.add(candidate.id);
        chainStart = eps[0];
        extended = true;
        break;
      }
      if (ptClose(chainStart, eps[0])) {
        chain.unshift({ entity: candidate, reversed: true });
        chainUsed.add(candidate.id);
        chainStart = eps[1];
        extended = true;
        break;
      }
    }
  }

  if (chain.length < 2) return null;

  // Check if directly closed
  if (ptClose(currentEnd, chainStart)) {
    return { chain, chainStart, closingArcPts: null };
  }

  // Check if both open ends lie on the same circle → close via arc
  for (const circle of circles) {
    if (pointOnCircle(currentEnd, circle) && pointOnCircle(chainStart, circle)) {
      return { chain, chainStart, closingArcPts: sampleArc(circle, currentEnd, chainStart) };
    }
  }

  return null;
}

/** Find closed chains of connected line/bezier entities, optionally closing via circle arcs. */
export function findClosedChains(sketch: Sketch): EntityChain[] {
  // Collect chainable entities (non-construction lines with 2+ points, and beziers)
  const chainable = sketch.entities.filter((e) => {
    if ('construction' in e && e.construction) return false;
    if (e.type === 'line') {
      const l = e as LineEntity;
      return l.points.length >= 2 && !l.closed;
    }
    if (e.type === 'bezier') return true;
    return false;
  });

  if (chainable.length < 2) return [];

  // Collect circles for arc closing
  const circles = sketch.entities.filter(
    (e) => e.type === 'circle' && !('construction' in e && e.construction),
  ) as CircleEntity[];

  // Try building a chain from every entity, collect all candidates
  const candidates: CandidateChain[] = [];
  for (const start of chainable) {
    const result = buildChainFrom(start, chainable, circles);
    if (result) candidates.push(result);
  }

  // Sort longest first — prefer chains that use more entities
  candidates.sort((a, b) => b.chain.length - a.chain.length);

  // Greedily pick non-overlapping chains
  const used = new Set<string>();
  const chains: EntityChain[] = [];

  for (const { chain, chainStart, closingArcPts } of candidates) {
    if (chain.some((c) => used.has(c.entity.id))) continue;
    for (const c of chain) used.add(c.entity.id);
    const polyline = buildPolyline(chain, chainStart, closingArcPts, null);
    chains.push({ id: chain[0]!.entity.id, entities: chain.map((c) => c.entity), polyline });
  }

  return chains;
}

/** Build a closed polyline from a chain of entities, optionally including arc points at the end. */
function buildPolyline(
  chain: { entity: Entity; reversed: boolean }[],
  chainStart: Point,
  closingArcPts: Point[] | null,
  _unused: null,
): Point[] {
  const pts: Point[] = [chainStart];

  for (const entry of chain) {
    const segPts = entityToPolyline(entry.entity, entry.reversed);
    pts.push(...segPts);
  }

  if (closingArcPts) {
    pts.push(...closingArcPts);
  }

  return pts;
}

/** Find the outermost closed profile in a sketch (largest by area). */
export function findOuterProfile(sketch: Sketch): Entity | null {
  const extrudable = getExtrudableEntities(sketch);
  if (extrudable.length === 0) return null;

  let best: Entity | null = null;
  let bestArea = -1;

  for (const e of extrudable) {
    const area = getEntityArea(e);
    if (area > bestArea) {
      bestArea = area;
      best = e;
    }
  }

  return best;
}

/** Find all top-level (not contained within any other) closed profiles in a sketch. */
export function findTopLevelProfiles(sketch: Sketch): Entity[] {
  const extrudable = getExtrudableEntities(sketch);
  return extrudable.filter((e) => {
    const center = getEntityCenter(e);
    if (!center) return true;
    const myArea = getEntityArea(e);
    // Only consider "contained" if the other entity is strictly larger
    return !extrudable.some((other) => {
      if (other.id === e.id) return false;
      return getEntityArea(other) > myArea && isPointInsideEntity(center.x, center.y, other);
    });
  });
}

/** Find all closed profiles contained within the outer entity. */
export function findHoles(outerEntity: Entity, sketch: Sketch): Entity[] {
  const extrudable = getExtrudableEntities(sketch);
  return extrudable.filter((e) => {
    if (e.id === outerEntity.id) return false;
    const center = getEntityCenter(e);
    if (!center) return false;
    return isPointInsideEntity(center.x, center.y, outerEntity);
  });
}

/** Approximate area of an entity (for comparison/sorting). */
export function getEntityArea(e: Entity): number {
  if (e.type === 'circle') {
    const c = e as CircleEntity;
    return Math.PI * c.radius * c.radius;
  }
  if (e.type === 'rectangle') {
    const r = e as RectangleEntity;
    return r.width * r.height;
  }
  if (e.type === 'line') {
    // Use shoelace formula for polygon area
    const pts = (e as LineEntity).points;
    let area = 0;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      area += (pts[j]!.x + pts[i]!.x) * (pts[j]!.y - pts[i]!.y);
    }
    return Math.abs(area / 2);
  }
  return 0;
}

function getEntityCenter(e: Entity): Point | null {
  if (e.type === 'circle') return (e as CircleEntity).center;
  if (e.type === 'rectangle') return (e as RectangleEntity).center;
  if (e.type === 'line') {
    const pts = (e as LineEntity).points;
    let cx = 0, cy = 0;
    for (const p of pts) { cx += p.x; cy += p.y; }
    return { x: cx / pts.length, y: cy / pts.length };
  }
  return null;
}

function isPointInsideEntity(px: number, py: number, entity: Entity): boolean {
  if (entity.type === 'circle') {
    const c = entity as CircleEntity;
    const dx = px - c.center.x, dy = py - c.center.y;
    return dx * dx + dy * dy < c.radius * c.radius;
  }
  if (entity.type === 'rectangle') {
    const r = entity as RectangleEntity;
    return Math.abs(px - r.center.x) < r.width / 2 && Math.abs(py - r.center.y) < r.height / 2;
  }
  if (entity.type === 'line') {
    return pointInPolygon(px, py, (entity as LineEntity).points);
  }
  return false;
}

function pointInPolygon(px: number, py: number, polygon: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i]!.x, yi = polygon[i]!.y;
    const xj = polygon[j]!.x, yj = polygon[j]!.y;
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}
