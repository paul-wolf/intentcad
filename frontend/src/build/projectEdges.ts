/**
 * Part edges projected onto a sketch: in sketch-on-face/plane mode an edge of
 * the part (a standoff's rim, a wall that isn't on the sketch's own face) can
 * be clicked into the sketch as reference geometry, flattened onto the
 * sketch plane, to dimension and constrain to. Each keeps the edge as the
 * build described it (`edgeRef`); after the part changes it is matched to
 * the edge nearest that description — same kind, a line running the same
 * way, a circle on the same axis — and projected again with the same id, so
 * what is dimensioned to it follows (build/sketchRefs.followRefs). When no
 * edge matches it is kept where it was, marked broken.
 */
import type { Entity, Point, ProjectedEdgeRef, Sketch } from '@/types/document';
import type { RunEdge } from '@/api/client';
import { isProjected } from '@/utils/brokenRefs';
import { edgeEntity } from './faceSketch';
import { selectable } from './edgePick';
import { planeDistance, worldToSketch, type PlaneBasis } from './sketchPlane';
import type { Vec3 } from './dragHandle';

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const norm = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** The edge flattened onto the plane `b` as a reference entity carrying its
 *  description; null for an edge without one (a seam) or one seen end on. */
export function projectEdge(edge: RunEdge, b: PlaneBasis): Entity | null {
  if (!edge.ref || edge.polyline.length < 2) return null;
  const e = edgeEntity(edge.kind, edge.polyline.map((p) => worldToSketch(b, p)), false);
  if (!e || (e.type !== 'line' && e.type !== 'circle')) return null;
  return { ...e, edgeRef: edge.ref } as Entity;
}

/** An edge the project tool can pick: flattened onto the plane (sketch
 *  coordinates), and how far it stands in front of the plane (its nearest
 *  point to the viewer). */
export interface ProjectCandidate { index: number; pts: Point[]; front: number; edge: RunEdge }

/** The part's edges that can be projected onto `b`: those between two faces
 *  that the build describes, not seen end on. `clipped`: the part in front
 *  of the plane is cut away in the view (a face sketch), so edges wholly in
 *  front of it are left out. */
export function projectCandidates(edges: RunEdge[], b: PlaneBasis, clipped: boolean): ProjectCandidate[] {
  const out: ProjectCandidate[] = [];
  for (const e of edges) {
    if (!e.ref || !selectable(e) || e.polyline.length < 2) continue;
    const ds = e.polyline.map((p) => planeDistance(b, p));
    if (clipped && Math.min(...ds) > 0.05) continue;
    const pts = e.polyline.map((p) => worldToSketch(b, p));
    let reach = 0;
    for (const p of pts) reach = Math.max(reach, Math.hypot(p.x - pts[0]!.x, p.y - pts[0]!.y));
    if (reach < 1e-6) continue;
    out.push({ index: e.index, pts, front: Math.max(...ds), edge: e });
  }
  return out;
}

function segDist(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** The candidate nearest `p` within `tol` (sketch units). Edges that lie
 *  over each other on the sketch (a standoff's top and bottom rims): the
 *  one nearest the viewer. */
export function pickCandidate(cands: ProjectCandidate[], p: Point, tol: number): ProjectCandidate | null {
  const near: [number, ProjectCandidate][] = [];
  for (const c of cands) {
    let d = Infinity;
    for (let i = 0; i + 1 < c.pts.length; i++) d = Math.min(d, segDist(p, c.pts[i]!, c.pts[i + 1]!));
    if (d <= tol) near.push([d, c]);
  }
  if (!near.length) return null;
  // within a tenth of the pick distance of the nearest counts as the same place
  const least = Math.min(...near.map(([d]) => d));
  return near.filter(([d]) => d <= least + tol * 0.1).reduce((x, y) => (y[1].front > x[1].front ? y : x))[1];
}

const PARALLEL = Math.cos(Math.PI / 180);   // within 1°

/** How unlike the edge `n` is the edge `o` was (Infinity: it can't be it):
 *  the same kind; a line running the same way, by how far its middle moved
 *  and its length changed; a circle or arc on the same axis, by how far its
 *  centre moved and its radius changed; anything else by its middle and
 *  length. Beyond the edge's length (at least 5 mm) it's another edge. */
export function edgeScore(o: ProjectedEdgeRef, n: ProjectedEdgeRef): number {
  if (o.kind !== n.kind) return Infinity;
  let s: number;
  if (o.direction && n.direction) {
    if (Math.abs(dot(o.direction, n.direction)) < PARALLEL) return Infinity;
    s = norm(sub(o.midpoint, n.midpoint)) + Math.abs(o.length - n.length);
  } else if (o.center && n.center && o.radius != null && n.radius != null) {
    if (o.axis && n.axis && Math.abs(dot(o.axis, n.axis)) < PARALLEL) return Infinity;
    s = norm(sub(o.center, n.center)) + Math.abs(o.radius - n.radius) + 0.1 * norm(sub(o.midpoint, n.midpoint));
  } else {
    s = norm(sub(o.midpoint, n.midpoint)) + Math.abs(o.length - n.length);
  }
  return s <= Math.max(o.length, 5) ? s : Infinity;
}

/** For each projected edge of the sketch: the edge it is now (projected
 *  again onto `b`, carrying the new description), or null when no edge
 *  matches (or the match is seen end on). Nearest pairs first, each edge
 *  taken once. */
export function matchProjected(sk: Sketch, edges: RunEdge[], b: PlaneBasis): Map<string, Entity | null> {
  const mine = sk.entities.filter(isProjected) as (Entity & { edgeRef: ProjectedEdgeRef })[];
  const out = new Map<string, Entity | null>();
  if (!mine.length) return out;
  const cands = edges.filter((e) => e.ref && selectable(e));
  const pairs: [number, number, number][] = [];
  mine.forEach((m, i) => cands.forEach((e, j) => {
    const s = edgeScore(m.edgeRef, e.ref!);
    if (s < Infinity) pairs.push([s, i, j]);
  }));
  pairs.sort((x, y) => x[0] - y[0]);
  const takenE = new Set<number>();
  for (const [, i, j] of pairs) {
    const id = mine[i]!.id;
    if (out.has(id) || takenE.has(j)) continue;
    takenE.add(j);
    out.set(id, projectEdge(cands[j]!, b));
  }
  for (const m of mine) if (!out.has(m.id)) out.set(m.id, null);
  return out;
}
