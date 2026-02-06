import type { Entity, Point } from '@/types/document';

/**
 * Get a characteristic point from an entity by index.
 *
 * Rectangle indices: 0=center, 1=TL, 2=TR, 3=BR, 4=BL
 * Line indices: 0..N-1 = polyline vertices
 * Polygon (line with polygonCenter): 0..N-1 = vertices, N = center
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
      if (entity.polygonCenter && pointIndex === entity.points.length) {
        return entity.polygonCenter;
      }
      return entity.points[pointIndex] ?? null;
    case 'bezier':
      return (pointIndex >= 0 && pointIndex < 4) ? entity.controlPoints[pointIndex] ?? null : null;
    default:
      return null;
  }
}

/**
 * Set a characteristic point on an entity by index. Returns new entity or null.
 *
 * For rectangle corners (1-4): anchor='corner' keeps the opposite corner fixed,
 * anchor='center' (default) resizes symmetrically around center.
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
      if (entity.anchor === 'corner') {
        // Two-point rect: resize keeping opposite corner fixed
        const oppositeIndex = ({ 1: 3, 2: 4, 3: 1, 4: 2 } as Record<number, number>)[pointIndex];
        if (!oppositeIndex) return null;
        const opposite = getEntityPoint(entity, oppositeIndex);
        if (!opposite) return null;
        const newWidth = Math.abs(pt.x - opposite.x);
        const newHeight = Math.abs(pt.y - opposite.y);
        if (newWidth <= 0 || newHeight <= 0) return null;
        return {
          ...entity,
          center: { x: (pt.x + opposite.x) / 2, y: (pt.y + opposite.y) / 2 },
          width: newWidth,
          height: newHeight,
        };
      }
      // Center-defined rect: resize symmetrically around center
      const current = getEntityPoint(entity, pointIndex);
      if (!current) return null;
      const dx = pt.x - current.x;
      const dy = pt.y - current.y;
      const hw = entity.width / 2;
      const hh = entity.height / 2;
      const newWidth = Math.abs(hw + (pointIndex === 2 || pointIndex === 3 ? dx : -dx)) * 2;
      const newHeight = Math.abs(hh + (pointIndex === 1 || pointIndex === 2 ? dy : -dy)) * 2;
      if (newWidth <= 0 || newHeight <= 0) return null;
      return { ...entity, width: newWidth, height: newHeight };
    }
    case 'bezier': {
      if (pointIndex < 0 || pointIndex >= 4) return null;
      const newCPs = [...entity.controlPoints] as [import('@/types/document').Point, import('@/types/document').Point, import('@/types/document').Point, import('@/types/document').Point];
      newCPs[pointIndex] = pt;
      return { ...entity, controlPoints: newCPs };
    }
    case 'line': {
      // Polygon: translate the entire polygon rigidly to preserve regular shape
      if (entity.polygonCenter) {
        let current: Point | null;
        if (pointIndex === entity.points.length) {
          current = entity.polygonCenter;
        } else {
          current = entity.points[pointIndex] ?? null;
        }
        if (!current) return null;
        const dx = pt.x - current.x;
        const dy = pt.y - current.y;
        return {
          ...entity,
          points: entity.points.map((p) => ({ x: p.x + dx, y: p.y + dy })),
          polygonCenter: { x: entity.polygonCenter.x + dx, y: entity.polygonCenter.y + dy },
        };
      }
      // Regular line: move individual vertex
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
    case 'line': {
      const pts: [number, Point][] = entity.points.map((p, i) => [i, p]);
      if (entity.polygonCenter) {
        pts.push([entity.points.length, entity.polygonCenter]);
      }
      return pts;
    }
    case 'bezier':
      return entity.controlPoints.map((p, i) => [i, p] as [number, Point]);
    default:
      return [];
  }
}
