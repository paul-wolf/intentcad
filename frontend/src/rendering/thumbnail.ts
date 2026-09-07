import type { Sketch, Entity, Point } from '@/types/document';
import { getSegmentCount, getSegmentPointIndices, getSegmentBulge } from '@/utils/lineSegments';
import { arcFromBulge } from '@/utils/arcGeometry';
import { rectangleOutline } from '@/utils/rectPath';

interface ThumbnailOptions {
  width: number;
  height: number;
  background: string;
  stroke: string;
  lineWidth: number;
  padding: number;
}

function computeBounds(entities: Entity[]): { minX: number; minY: number; maxX: number; maxY: number } | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  let hasGeometry = false;

  for (const entity of entities) {
    if (entity.type === 'dimension') continue;
    if (entity.type === 'line') {
      for (const p of entity.points) {
        minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
      }
      hasGeometry = true;
    } else if (entity.type === 'circle') {
      minX = Math.min(minX, entity.center.x - entity.radius);
      minY = Math.min(minY, entity.center.y - entity.radius);
      maxX = Math.max(maxX, entity.center.x + entity.radius);
      maxY = Math.max(maxY, entity.center.y + entity.radius);
      hasGeometry = true;
    } else if (entity.type === 'rectangle') {
      const hw = entity.width / 2, hh = entity.height / 2;
      minX = Math.min(minX, entity.center.x - hw);
      minY = Math.min(minY, entity.center.y - hh);
      maxX = Math.max(maxX, entity.center.x + hw);
      maxY = Math.max(maxY, entity.center.y + hh);
      hasGeometry = true;
    } else if (entity.type === 'point') {
      minX = Math.min(minX, entity.position.x);
      minY = Math.min(minY, entity.position.y);
      maxX = Math.max(maxX, entity.position.x);
      maxY = Math.max(maxY, entity.position.y);
      hasGeometry = true;
    } else if (entity.type === 'bezier') {
      for (const p of entity.controlPoints) {
        minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
      }
      hasGeometry = true;
    }
  }

  return hasGeometry ? { minX, minY, maxX, maxY } : null;
}

function worldToScreen(p: Point, scale: number, offsetX: number, offsetY: number): [number, number] {
  return [p.x * scale + offsetX, p.y * scale + offsetY];
}

export function renderSketchThumbnail(
  canvas: HTMLCanvasElement,
  sketch: Sketch,
  opts: Partial<ThumbnailOptions> = {},
) {
  const o: ThumbnailOptions = {
    width: canvas.width,
    height: canvas.height,
    background: '#1e293b',
    stroke: '#94a3b8',
    lineWidth: 1.5,
    padding: 12,
    ...opts,
  };

  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  // Clear
  ctx.fillStyle = o.background;
  ctx.fillRect(0, 0, o.width, o.height);

  const entities = sketch.entities.filter((e) => e.type !== 'dimension');
  const bounds = computeBounds(entities);
  if (!bounds) return;

  // Compute scale and offset to fit entities with padding
  const drawW = o.width - o.padding * 2;
  const drawH = o.height - o.padding * 2;
  const bbW = (bounds.maxX - bounds.minX) || 1;
  const bbH = (bounds.maxY - bounds.minY) || 1;
  const scale = Math.min(drawW / bbW, drawH / bbH);
  const centerX = (bounds.minX + bounds.maxX) / 2;
  const centerY = (bounds.minY + bounds.maxY) / 2;
  const offsetX = o.width / 2 - centerX * scale;
  const offsetY = o.height / 2 - centerY * scale;

  const w2s = (p: Point) => worldToScreen(p, scale, offsetX, offsetY);

  ctx.strokeStyle = o.stroke;
  ctx.lineWidth = o.lineWidth;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  for (const entity of entities) {
    if (entity.construction) {
      ctx.setLineDash([4, 3]);
      ctx.globalAlpha = 0.5;
    } else {
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
    }

    switch (entity.type) {
      case 'line': {
        const segCount = getSegmentCount(entity);
        for (let i = 0; i < segCount; i++) {
          const [i1, i2] = getSegmentPointIndices(entity, i);
          const bulge = getSegmentBulge(entity, i);
          if (bulge !== 0) {
            const arc = arcFromBulge(entity.points[i1]!, entity.points[i2]!, bulge);
            const [cx, cy] = w2s(arc.center);
            const r = arc.radius * scale;
            ctx.beginPath();
            ctx.arc(cx, cy, r, arc.startAngle, arc.endAngle, arc.counterClockwise);
            ctx.stroke();
          } else {
            const [ax, ay] = w2s(entity.points[i1]!);
            const [bx, by] = w2s(entity.points[i2]!);
            ctx.beginPath();
            ctx.moveTo(ax, ay);
            ctx.lineTo(bx, by);
            ctx.stroke();
          }
        }
        break;
      }
      case 'circle': {
        const [cx, cy] = w2s(entity.center);
        const r = entity.radius * scale;
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.stroke();
        break;
      }
      case 'rectangle': {
        // Flattened outline: a thumbnail is a few dozen pixels wide, so sampled
        // arcs are indistinguishable from true ones and need no arc plumbing.
        const pts = rectangleOutline(entity).map(w2s);
        ctx.beginPath();
        ctx.moveTo(pts[0]![0], pts[0]![1]);
        for (let i = 1; i < pts.length; i++) {
          ctx.lineTo(pts[i]![0], pts[i]![1]);
        }
        ctx.closePath();
        ctx.stroke();
        break;
      }
      case 'point': {
        const [px, py] = w2s(entity.position);
        ctx.beginPath();
        ctx.arc(px, py, 2, 0, Math.PI * 2);
        ctx.fillStyle = o.stroke;
        ctx.fill();
        break;
      }
      case 'bezier': {
        const [p0, p1, p2, p3] = entity.controlPoints;
        const [x0, y0] = w2s(p0);
        const [x1, y1] = w2s(p1);
        const [x2, y2] = w2s(p2);
        const [x3, y3] = w2s(p3);
        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.bezierCurveTo(x1, y1, x2, y2, x3, y3);
        ctx.stroke();
        break;
      }
    }
  }

  ctx.globalAlpha = 1;
  ctx.setLineDash([]);
}
