import type { Sketch, Entity } from '@/types/document';
import type { BuildEntity, BuildRequest } from '@/api/client';

/** Entity types the server modeler can turn into a profile. */
function toBuildEntity(e: Entity): BuildEntity | null {
  switch (e.type) {
    case 'line':
      return {
        type: 'line',
        construction: e.construction,
        points: e.points.map((p) => ({ x: p.x, y: p.y })),
        closed: e.closed,
        bulge: e.bulge,
      };
    case 'circle':
      return {
        type: 'circle',
        construction: e.construction,
        center: { x: e.center.x, y: e.center.y },
        radius: e.radius,
      };
    case 'rectangle':
      return {
        type: 'rectangle',
        construction: e.construction,
        center: { x: e.center.x, y: e.center.y },
        width: e.width,
        height: e.height,
        anchor: e.anchor,
      };
    default:
      // dimension / point / text / bezier — not profile geometry
      return null;
  }
}

/**
 * Build a self-contained request that extrudes a single sketch.
 * The A/B prototype only wires extrude; more features come later.
 */
export function sketchToBuildRequest(sketch: Sketch, distance: number): BuildRequest {
  const entities = sketch.entities
    .map(toBuildEntity)
    .filter((e): e is BuildEntity => e !== null);

  return {
    sketches: [{ id: sketch.id, entities }],
    features: [{ id: 'extrude-1', type: 'extrude', sketchId: sketch.id, distance, operation: 'add' }],
  };
}
