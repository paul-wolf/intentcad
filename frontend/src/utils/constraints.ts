import type { Constraint, Entity, Point } from '@/types/document';
import { getEntityPoint } from '@/utils/entityPoints';
import { getEntitySegmentEndpoints, getSegmentBulge } from '@/utils/lineSegments';
import { arcMidpoint } from '@/utils/arcGeometry';

export interface ConstraintLink {
  constraintId: string;
  constraintType: Constraint['type'];
  entityId: string;
  targetEntityId: string;
}

export interface ConstraintPartnersResult {
  relatedIds: Set<string>;
  links: ConstraintLink[];
}

/** Unicode symbols for each two-entity constraint type. */
export const CONSTRAINT_SYMBOLS: Record<string, string> = {
  parallel: '\u2225',      // ∥
  perpendicular: '\u22A5', // ⊥
  tangent: '\u22A4',       // ⊤
  equal: '=',
  coincident: '\u2022',    // •
  midpoint: '\u25C6',      // ◆
  bisect: '\u2020',        // †
  horizontalPoints: 'H',
  verticalPoints: 'V',
  pointOnCurve: '\u2208',  // ∈
  symmetric: '\u21D4',     // ⇔
};

/**
 * Given a set of selected entity IDs and the full constraint list,
 * return the set of partner entity IDs and the link descriptors.
 * Single-entity constraints (fixed, horizontal, vertical) produce no partners.
 */
export function getConstraintPartners(
  selectedIds: Set<string>,
  constraints: Constraint[],
): ConstraintPartnersResult {
  const relatedIds = new Set<string>();
  const links: ConstraintLink[] = [];

  for (const c of constraints) {
    // Skip single-entity constraints
    if (c.type === 'fixed' || c.type === 'horizontal' || c.type === 'vertical') continue;
    if (c.type === 'symmetric') {
      // three shapes: the two points' and the line's
      const ids = [c.entityId, c.entityId2, c.targetEntityId];
      if (ids.some((id) => selectedIds.has(id))) for (const id of ids) if (!selectedIds.has(id)) relatedIds.add(id);
      continue;
    }

    const hasEntity = selectedIds.has(c.entityId);
    const hasTarget = selectedIds.has(c.targetEntityId);

    if (hasEntity && !hasTarget) {
      relatedIds.add(c.targetEntityId);
      links.push({
        constraintId: c.id,
        constraintType: c.type,
        entityId: c.entityId,
        targetEntityId: c.targetEntityId,
      });
    } else if (hasTarget && !hasEntity) {
      relatedIds.add(c.entityId);
      links.push({
        constraintId: c.id,
        constraintType: c.type,
        entityId: c.targetEntityId,
        targetEntityId: c.entityId,
      });
    }
  }

  return { relatedIds, links };
}

/**
 * Returns a representative point (centroid / center) for any entity type.
 * Useful for drawing constraint connection lines.
 */
export function getEntityRepresentativePoint(entity: Entity): Point | null {
  switch (entity.type) {
    case 'circle':
      return entity.center;
    case 'rectangle':
      return entity.center;
    case 'point':
      return entity.position;
    case 'line': {
      if (entity.polygonCenter) return entity.polygonCenter;
      // Vertex centroid
      if (entity.points.length === 0) return null;
      let sx = 0;
      let sy = 0;
      for (const p of entity.points) {
        sx += p.x;
        sy += p.y;
      }
      return { x: sx / entity.points.length, y: sy / entity.points.length };
    }
    case 'bezier': {
      // Evaluate at t=0.5: (1/8)P0 + (3/8)P1 + (3/8)P2 + (1/8)P3
      const [cp0, cp1, cp2, cp3] = entity.controlPoints;
      return {
        x: cp0.x / 8 + 3 * cp1.x / 8 + 3 * cp2.x / 8 + cp3.x / 8,
        y: cp0.y / 8 + 3 * cp1.y / 8 + 3 * cp2.y / 8 + cp3.y / 8,
      };
    }
    case 'dimension':
      return null;
    case 'text':
      return entity.position;
  }
}

/** A constraint's glyph drawn between two points: from one point to the other. */
export interface PointRelationMark {
  a: Point;
  b: Point;
  symbol: string;
}

/**
 * Point relations (two points level, ...) are marked between the points
 * themselves, not the shapes' centres. null for other constraints.
 */
export function pointRelationMarks(c: Constraint, entities: Map<string, Entity>): PointRelationMark[] | null {
  if (c.type === 'horizontalPoints' || c.type === 'verticalPoints') {
    const e1 = entities.get(c.entityId);
    const e2 = entities.get(c.targetEntityId);
    const a = e1 && getEntityPoint(e1, c.pointIndex);
    const b = e2 && getEntityPoint(e2, c.targetPointIndex);
    return a && b ? [{ a, b, symbol: CONSTRAINT_SYMBOLS[c.type]! }] : [];
  }
  if (c.type === 'pointOnCurve') {
    // from the point to the middle of its segment, or the circle's centre
    const e1 = entities.get(c.entityId);
    const e2 = entities.get(c.targetEntityId);
    const a = e1 && getEntityPoint(e1, c.pointIndex);
    const b = e2 && curveAnchor(e2, c.segmentIndex);
    return a && b ? [{ a, b, symbol: CONSTRAINT_SYMBOLS.pointOnCurve! }] : [];
  }
  if (c.type === 'symmetric') {
    // between the two points: the glyph sits on the line they mirror about
    const e1 = entities.get(c.entityId);
    const e2 = entities.get(c.entityId2);
    const a = e1 && getEntityPoint(e1, c.pointIndex);
    const b = e2 && getEntityPoint(e2, c.pointIndex2);
    return a && b ? [{ a, b, symbol: CONSTRAINT_SYMBOLS.symmetric! }] : [];
  }
  return null;
}

/** Where a point-on-curve mark ends: a segment's middle (on the arc, for an
 *  arc segment) or a circle's centre. */
function curveAnchor(entity: Entity, segmentIndex: number): Point | null {
  if (entity.type === 'circle') return entity.center;
  const ends = getEntitySegmentEndpoints(entity, segmentIndex);
  if (!ends) return null;
  const bulge = entity.type === 'line' ? getSegmentBulge(entity, segmentIndex) : 0;
  return bulge ? arcMidpoint(ends[0], ends[1], bulge) : { x: (ends[0].x + ends[1].x) / 2, y: (ends[0].y + ends[1].y) / 2 };
}
