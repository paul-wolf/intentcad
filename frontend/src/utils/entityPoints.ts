import type { Entity, Point } from '@/types/document';

/**
 * Get a characteristic point from an entity by index.
 *
 * Rectangle indices: 0=center, 1=TL, 2=TR, 3=BR, 4=BL
 * Line indices: 0..N-1 = polyline vertices
 * Circle: 0=center
 * Point: 0=position
 */
export function getEntityPoint(entity: Entity, pointIndex: number): Point | null {
  switch (entity.type) {
    case 'point':
      return pointIndex === 0 ? entity.position : null;
    case 'circle':
      return pointIndex === 0 ? entity.center : null;
    case 'rectangle': {
      const hw = entity.width / 2;
      const hh = entity.height / 2;
      const c = entity.center;
      switch (pointIndex) {
        case 0: return c;
        case 1: return { x: c.x - hw, y: c.y + hh }; // TL
        case 2: return { x: c.x + hw, y: c.y + hh }; // TR
        case 3: return { x: c.x + hw, y: c.y - hh }; // BR
        case 4: return { x: c.x - hw, y: c.y - hh }; // BL
        default: return null;
      }
    }
    case 'line':
      return entity.points[pointIndex] ?? null;
    default:
      return null;
  }
}

/**
 * Set a characteristic point on an entity by index. Returns new entity or null.
 *
 * For rectangle corners (1-4), translates the whole rectangle so the corner
 * lands on the target point.
 */
export function setEntityPoint(entity: Entity, pointIndex: number, pt: Point): Entity | null {
  switch (entity.type) {
    case 'point':
      return pointIndex === 0 ? { ...entity, position: pt } : null;
    case 'circle':
      return pointIndex === 0 ? { ...entity, center: pt } : null;
    case 'rectangle': {
      if (pointIndex === 0) {
        return { ...entity, center: pt };
      }
      // For corners, translate the whole rectangle so the corner lands on pt
      const current = getEntityPoint(entity, pointIndex);
      if (!current) return null;
      const dx = pt.x - current.x;
      const dy = pt.y - current.y;
      return { ...entity, center: { x: entity.center.x + dx, y: entity.center.y + dy } };
    }
    case 'line': {
      if (pointIndex < 0 || pointIndex >= entity.points.length) return null;
      const newPoints = [...entity.points];
      newPoints[pointIndex] = pt;
      return { ...entity, points: newPoints };
    }
    default:
      return null;
  }
}

/**
 * Get all (index, point) pairs for an entity.
 * Rectangle returns 5 points: center + 4 corners.
 */
export function getEntityPoints(entity: Entity): [number, Point][] {
  switch (entity.type) {
    case 'point':
      return [[0, entity.position]];
    case 'circle':
      return [[0, entity.center]];
    case 'rectangle': {
      const hw = entity.width / 2;
      const hh = entity.height / 2;
      const c = entity.center;
      return [
        [0, c],
        [1, { x: c.x - hw, y: c.y + hh }],
        [2, { x: c.x + hw, y: c.y + hh }],
        [3, { x: c.x + hw, y: c.y - hh }],
        [4, { x: c.x - hw, y: c.y - hh }],
      ];
    }
    case 'line':
      return entity.points.map((p, i) => [i, p]);
    default:
      return [];
  }
}
