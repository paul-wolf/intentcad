import type { Point } from '@/types/document';
import type { Renderer, Viewport, LineStyle, TextStyle } from '@/types/renderer';
import {
  DIMENSION_ARROW_LENGTH,
  DIMENSION_ARROW_HALF_WIDTH,
  DIMENSION_EXTENSION_GAP,
  DIMENSION_EXTENSION_OVERSHOOT,
  DIMENSION_TEXT_PAD,
} from '@/config';

export interface DimensionGeom {
  a: Point;
  b: Point;
  offset: number;
}

function formatLength(mm: number): string {
  return mm >= 10 ? mm.toFixed(1) : mm.toFixed(2);
}

function perpDir(a: Point, b: Point): Point {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len === 0) return { x: 0, y: -1 };
  return { x: -dy / len, y: dx / len };
}

export function drawDimension(
  renderer: Renderer,
  viewport: Viewport,
  geom: DimensionGeom,
  lineStyle: LineStyle,
  textStyle: TextStyle,
  bgColor?: string,
): void {
  const { a, b, offset } = geom;

  const perp = perpDir(a, b);
  // Offset points in world space
  const oa: Point = { x: a.x + perp.x * offset, y: a.y + perp.y * offset };
  const ob: Point = { x: b.x + perp.x * offset, y: b.y + perp.y * offset };

  const sa = viewport.worldToScreen(a);
  const sb = viewport.worldToScreen(b);
  const soa = viewport.worldToScreen(oa);
  const sob = viewport.worldToScreen(ob);

  // Screen-space perp direction (from segment toward dimension line)
  const spx = soa.x - sa.x;
  const spy = soa.y - sa.y;
  const spLen = Math.sqrt(spx * spx + spy * spy);
  if (spLen < 1) return;
  const snx = spx / spLen;
  const sny = spy / spLen;

  // Extension lines: from near geometry endpoint to past dimension line
  const gapPx = DIMENSION_EXTENSION_GAP;
  const overshoot = DIMENSION_EXTENSION_OVERSHOOT;
  renderer.drawLine(
    { x: sa.x + snx * gapPx, y: sa.y + sny * gapPx },
    { x: soa.x + snx * overshoot, y: soa.y + sny * overshoot },
    lineStyle,
  );
  renderer.drawLine(
    { x: sb.x + snx * gapPx, y: sb.y + sny * gapPx },
    { x: sob.x + snx * overshoot, y: sob.y + sny * overshoot },
    lineStyle,
  );

  // Dimension line
  renderer.drawLine(soa, sob, lineStyle);

  // Direction along dimension line in screen space
  const dlx = sob.x - soa.x;
  const dly = sob.y - soa.y;
  const dlLen = Math.sqrt(dlx * dlx + dly * dly);
  if (dlLen < 2) return;
  const dux = dlx / dlLen;
  const duy = dly / dlLen;

  // V-shaped arrowheads
  const aLen = DIMENSION_ARROW_LENGTH;
  const aHalf = DIMENSION_ARROW_HALF_WIDTH;
  // Arrow at soa pointing toward sob
  const a1 = { x: soa.x + dux * aLen + (-duy) * aHalf, y: soa.y + duy * aLen + dux * aHalf };
  const a2 = { x: soa.x + dux * aLen + (-duy) * (-aHalf), y: soa.y + duy * aLen + dux * (-aHalf) };
  renderer.drawLine(soa, a1, lineStyle);
  renderer.drawLine(soa, a2, lineStyle);
  // Arrow at sob pointing toward soa
  const b1 = { x: sob.x - dux * aLen + (-duy) * aHalf, y: sob.y - duy * aLen + dux * aHalf };
  const b2 = { x: sob.x - dux * aLen + (-duy) * (-aHalf), y: sob.y - duy * aLen + dux * (-aHalf) };
  renderer.drawLine(sob, b1, lineStyle);
  renderer.drawLine(sob, b2, lineStyle);

  // Text label
  const length = Math.sqrt((b.x - a.x) ** 2 + (b.y - a.y) ** 2);
  const label = formatLength(length);
  const mid: Point = { x: (soa.x + sob.x) / 2, y: (soa.y + sob.y) / 2 };

  const metrics = renderer.measureText(label, textStyle);
  const pad = DIMENSION_TEXT_PAD;
  if (bgColor) {
    renderer.drawRect(
      { x: mid.x - metrics.width / 2 - pad, y: mid.y - metrics.height / 2 - pad },
      { x: metrics.width + pad * 2, y: metrics.height + pad * 2 },
      bgColor,
    );
  }
  renderer.drawText(label, mid, textStyle);
}

export function drawSegmentLabel(
  renderer: Renderer,
  viewport: Viewport,
  a: Point,
  b: Point,
  textStyle: TextStyle,
  bgColor?: string,
): void {
  const sa = viewport.worldToScreen(a);
  const sb = viewport.worldToScreen(b);

  const mid: Point = { x: (sa.x + sb.x) / 2, y: (sa.y + sb.y) / 2 };

  // Offset text perpendicular to segment
  const dx = sb.x - sa.x;
  const dy = sb.y - sa.y;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < 2) return;
  const nx = -dy / len;
  const ny = dx / len;
  const textOffset = 12;
  const textPos: Point = { x: mid.x + nx * textOffset, y: mid.y + ny * textOffset };

  const length = Math.sqrt((b.x - a.x) ** 2 + (b.y - a.y) ** 2);
  const label = formatLength(length);

  const metrics = renderer.measureText(label, textStyle);
  const pad = DIMENSION_TEXT_PAD;
  if (bgColor) {
    renderer.drawRect(
      { x: textPos.x - metrics.width / 2 - pad, y: textPos.y - metrics.height / 2 - pad },
      { x: metrics.width + pad * 2, y: metrics.height + pad * 2 },
      bgColor,
    );
  }
  renderer.drawText(label, textPos, textStyle);
}
