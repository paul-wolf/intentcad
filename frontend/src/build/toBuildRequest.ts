import type { Sketch, Entity } from '@/types/document';
import type { BuildEntity, BuildRequest, BuildFeature, BuildAxis } from '@/api/client';

/** A single modeling operation the Build panel can request. */
export type BuildOp =
  | { kind: 'extrude'; distance: number }
  | { kind: 'revolve'; angle: number; axis: BuildAxis };

/** Revolve axis choices: through the origin, or along an edge of the profile. */
export type AxisKind = 'y' | 'x' | 'left' | 'right' | 'top' | 'bottom';

export const AXIS_LABELS: Record<AxisKind, string> = {
  y: 'Y axis (x=0)',
  x: 'X axis (y=0)',
  left: 'Left edge',
  right: 'Right edge',
  top: 'Top edge',
  bottom: 'Bottom edge',
};

/** Bounding box of a sketch's non-construction profile geometry (sketch coords). */
function sketchBounds(sketch: Sketch) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, any = false;
  const acc = (x: number, y: number) => {
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y); any = true;
  };
  for (const e of sketch.entities) {
    if ('construction' in e && e.construction) continue;
    // Datum markers sit outside the part; they must not move a revolve axis.
    if ('reference' in e && e.reference) continue;
    if (e.type === 'line') { for (const p of e.points) acc(p.x, p.y); }
    else if (e.type === 'circle') { acc(e.center.x - e.radius, e.center.y - e.radius); acc(e.center.x + e.radius, e.center.y + e.radius); }
    else if (e.type === 'rectangle') {
      const hw = e.width / 2, hh = e.height / 2;
      const cx = e.anchor === 'corner' ? e.center.x + hw : e.center.x;
      const cy = e.anchor === 'corner' ? e.center.y + hh : e.center.y;
      acc(cx - hw, cy - hh); acc(cx + hw, cy + hh);
    }
  }
  return any ? { minX, maxX, minY, maxY } : null;
}

/** Resolve a revolve axis choice into two points, using the sketch's extent for edge axes. */
export function axisForKind(sketch: Sketch, kind: AxisKind): BuildAxis {
  const b = sketchBounds(sketch);
  const vert = (x: number): BuildAxis => ({ start: { x, y: 0 }, end: { x, y: 1 } });
  const horiz = (y: number): BuildAxis => ({ start: { x: 0, y }, end: { x: 1, y } });
  switch (kind) {
    case 'y': return vert(0);
    case 'x': return horiz(0);
    case 'left': return vert(b ? b.minX : 0);
    case 'right': return vert(b ? b.maxX : 0);
    case 'top': return horiz(b ? b.minY : 0);
    case 'bottom': return horiz(b ? b.maxY : 0);
  }
}

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
        cornerRadius: e.cornerRadius,
        anchor: e.anchor,
      };
    default:
      // dimension / point / text / bezier — not profile geometry
      return null;
  }
}

/** Build a request from a feature tree: all sketches bundled, features in order. */
export function treeToBuildRequest(sketches: Sketch[], features: BuildFeature[]): BuildRequest {
  return {
    sketches: sketches.map((sk) => ({
      id: sk.id,
      entities: sk.entities.map(toBuildEntity).filter((e): e is BuildEntity => e !== null),
    })),
    features,
  };
}

/** Build a self-contained request applying one operation to a single sketch. */
export function sketchToBuildRequest(sketch: Sketch, op: BuildOp): BuildRequest {
  const entities = sketch.entities
    .map(toBuildEntity)
    .filter((e): e is BuildEntity => e !== null);

  const feature: BuildFeature =
    op.kind === 'extrude'
      ? { id: 'op-1', type: 'extrude', sketchId: sketch.id, distance: op.distance, operation: 'add' }
      : { id: 'op-1', type: 'revolve', sketchId: sketch.id, angle: op.angle, axis: op.axis, operation: 'add' };

  return {
    sketches: [{ id: sketch.id, entities }],
    features: [feature],
  };
}
