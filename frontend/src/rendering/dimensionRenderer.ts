import type { Point } from '@/types/document';
import type { Renderer, Viewport, LineStyle, TextStyle } from '@/types/renderer';
import {
  DIMENSION_ARROW_LENGTH,
  DIMENSION_ARROW_HALF_WIDTH,
  DIMENSION_EXTENSION_GAP,
  DIMENSION_EXTENSION_OVERSHOOT,
  DIMENSION_TEXT_PAD,
} from '@/config';
import { lineLineIntersection } from '@/utils/geometry';

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

export function getDimensionTextScreenPos(
  viewport: Viewport,
  geom: DimensionGeom,
): Point {
  const { a, b, offset } = geom;
  const perp = perpDir(a, b);
  const oa: Point = { x: a.x + perp.x * offset, y: a.y + perp.y * offset };
  const ob: Point = { x: b.x + perp.x * offset, y: b.y + perp.y * offset };
  const soa = viewport.worldToScreen(oa);
  const sob = viewport.worldToScreen(ob);
  return { x: (soa.x + sob.x) / 2, y: (soa.y + sob.y) / 2 };
}

export function getDiameterTextScreenPos(
  viewport: Viewport,
  center: Point,
  radius: number,
  offset: number,
): Point {
  const a: Point = { x: center.x - radius, y: center.y };
  const b: Point = { x: center.x + radius, y: center.y };
  const oa: Point = { x: a.x, y: a.y + offset };
  const ob: Point = { x: b.x, y: b.y + offset };
  const soa = viewport.worldToScreen(oa);
  const sob = viewport.worldToScreen(ob);
  return { x: (soa.x + sob.x) / 2, y: (soa.y + sob.y) / 2 };
}

export function drawDimension(
  renderer: Renderer,
  viewport: Viewport,
  geom: DimensionGeom,
  lineStyle: LineStyle,
  textStyle: TextStyle,
  bgColor?: string,
  derived?: boolean,
  label?: string,
  scale = 1,
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
  const aLen = DIMENSION_ARROW_LENGTH * scale;
  const aHalf = DIMENSION_ARROW_HALF_WIDTH * scale;
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
  const displayLabel = label?.replace('{v}', formatLength(length)) ?? (derived ? `(${formatLength(length)})` : formatLength(length));
  const mid: Point = { x: (soa.x + sob.x) / 2, y: (soa.y + sob.y) / 2 };

  const metrics = renderer.measureText(displayLabel, textStyle);
  const pad = DIMENSION_TEXT_PAD;
  if (bgColor) {
    renderer.drawRect(
      { x: mid.x - metrics.width / 2 - pad, y: mid.y - metrics.height / 2 - pad },
      { x: metrics.width + pad * 2, y: metrics.height + pad * 2 },
      bgColor,
    );
  }
  renderer.drawText(displayLabel, mid, textStyle);
}

export function drawDiameterDimension(
  renderer: Renderer,
  viewport: Viewport,
  center: Point,
  radius: number,
  offset: number,
  lineStyle: LineStyle,
  textStyle: TextStyle,
  bgColor?: string,
  derived?: boolean,
  label?: string,
  scale = 1,
): void {
  // Horizontal diameter endpoints in world space
  const a: Point = { x: center.x - radius, y: center.y };
  const b: Point = { x: center.x + radius, y: center.y };

  // Offset points (perpendicular = up in world, offset in Y)
  const oa: Point = { x: a.x, y: a.y + offset };
  const ob: Point = { x: b.x, y: b.y + offset };

  const sa = viewport.worldToScreen(a);
  const sb = viewport.worldToScreen(b);
  const soa = viewport.worldToScreen(oa);
  const sob = viewport.worldToScreen(ob);

  // Screen-space perpendicular direction (from circle edge toward dimension line)
  const spx = soa.x - sa.x;
  const spy = soa.y - sa.y;
  const spLen = Math.sqrt(spx * spx + spy * spy);
  if (spLen < 1) return;
  const snx = spx / spLen;
  const sny = spy / spLen;

  // Extension lines
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

  // Direction along dimension line
  const dlx = sob.x - soa.x;
  const dly = sob.y - soa.y;
  const dlLen = Math.sqrt(dlx * dlx + dly * dly);
  if (dlLen < 2) return;
  const dux = dlx / dlLen;
  const duy = dly / dlLen;

  // V-shaped arrowheads
  const aLen = DIMENSION_ARROW_LENGTH * scale;
  const aHalf = DIMENSION_ARROW_HALF_WIDTH * scale;
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

  // Text label with diameter symbol
  const diameter = radius * 2;
  const displayLabel = label?.replace('{v}', `\u2300${formatLength(diameter)}`) ?? (derived ? `(\u2300${formatLength(diameter)})` : `\u2300${formatLength(diameter)}`);
  const mid: Point = { x: (soa.x + sob.x) / 2, y: (soa.y + sob.y) / 2 };

  const metrics = renderer.measureText(displayLabel, textStyle);
  const pad = DIMENSION_TEXT_PAD;
  if (bgColor) {
    renderer.drawRect(
      { x: mid.x - metrics.width / 2 - pad, y: mid.y - metrics.height / 2 - pad },
      { x: metrics.width + pad * 2, y: metrics.height + pad * 2 },
      bgColor,
    );
  }
  renderer.drawText(displayLabel, mid, textStyle);
}

/** A radius dimension: a leader from the centre out through the arc, an
 *  arrow where it meets the arc, the label "R…" at its end. */
export function drawRadiusDimension(
  renderer: Renderer,
  viewport: Viewport,
  center: Point,
  arcPoint: Point,
  end: Point,
  radius: number,
  lineStyle: LineStyle,
  textStyle: TextStyle,
  bgColor?: string,
  derived?: boolean,
  label?: string,
  scale = 1,
): void {
  const sc = viewport.worldToScreen(center);
  const sa = viewport.worldToScreen(arcPoint);
  const se = viewport.worldToScreen(end);
  renderer.drawLine(sc, se, lineStyle);
  const dx = sa.x - sc.x, dy = sa.y - sc.y;
  const len = Math.hypot(dx, dy);
  if (len >= 2) {
    const ux = dx / len, uy = dy / len;
    const aLen = DIMENSION_ARROW_LENGTH * scale;
    const aHalf = DIMENSION_ARROW_HALF_WIDTH * scale;
    renderer.drawLine(sa, { x: sa.x - ux * aLen - uy * aHalf, y: sa.y - uy * aLen + ux * aHalf }, lineStyle);
    renderer.drawLine(sa, { x: sa.x - ux * aLen + uy * aHalf, y: sa.y - uy * aLen - ux * aHalf }, lineStyle);
  }
  const value = `R${formatLength(radius)}`;
  const displayLabel = label?.replace('{v}', value) ?? (derived ? `(${value})` : value);
  const metrics = renderer.measureText(displayLabel, textStyle);
  const pad = DIMENSION_TEXT_PAD;
  if (bgColor) {
    renderer.drawRect(
      { x: se.x - metrics.width / 2 - pad, y: se.y - metrics.height / 2 - pad },
      { x: metrics.width + pad * 2, y: metrics.height + pad * 2 },
      bgColor,
    );
  }
  renderer.drawText(displayLabel, se, textStyle);
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

// ── Angle dimension ──────────────────────────────────────────────────

export interface AngleDimensionGeom {
  intersection: Point;
  startAngle: number;
  endAngle: number;
  arcRadius: number;
}

export function computeAngleDimensionGeom(
  p1: Point,
  p2: Point,
  q1: Point,
  q2: Point,
  arcRadius: number,
): AngleDimensionGeom | null {
  const ix = lineLineIntersection(p1, p2, q1, q2);
  if (!ix) return null;

  // Direction vectors oriented toward each segment's midpoint (away from intersection)
  const mid1x = (p1.x + p2.x) / 2 - ix.x;
  const mid1y = (p1.y + p2.y) / 2 - ix.y;
  const mid2x = (q1.x + q2.x) / 2 - ix.x;
  const mid2y = (q1.y + q2.y) / 2 - ix.y;

  const startAngle = Math.atan2(mid1y, mid1x);
  const endAngle = Math.atan2(mid2y, mid2x);

  return { intersection: ix, startAngle, endAngle, arcRadius };
}

function normalizeAngle(a: number): number {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}

export function getAngleDimensionTextScreenPos(
  viewport: Viewport,
  geom: AngleDimensionGeom,
): Point {
  const midAngle = (geom.startAngle + geom.endAngle) / 2;
  // Choose the arc side that gives the smaller sweep
  let sweep = normalizeAngle(geom.endAngle - geom.startAngle);
  let actualMid = midAngle;
  if (Math.abs(sweep) > Math.PI) {
    actualMid = midAngle + Math.PI;
  }
  const worldPt: Point = {
    x: geom.intersection.x + Math.cos(actualMid) * geom.arcRadius,
    y: geom.intersection.y + Math.sin(actualMid) * geom.arcRadius,
  };
  return viewport.worldToScreen(worldPt);
}

export function drawAngleDimension(
  renderer: Renderer,
  viewport: Viewport,
  geom: AngleDimensionGeom,
  lineStyle: LineStyle,
  textStyle: TextStyle,
  bgColor?: string,
  derived?: boolean,
  label?: string,
  scale = 1,
): void {
  const screenCenter = viewport.worldToScreen(geom.intersection);
  const screenRadius = geom.arcRadius * viewport.scale;

  // Compute sweep (no Y-flip in worldToScreen, so world angles = screen angles)
  let sweep = normalizeAngle(geom.endAngle - geom.startAngle);
  const counterClockwise = sweep < 0;
  const absSweep = Math.abs(sweep);

  // Draw arc (world angles used directly as screen angles)
  renderer.drawArc(screenCenter, screenRadius, geom.startAngle, geom.endAngle, counterClockwise, lineStyle);

  // Extension lines from intersection outward along each segment direction
  const extLen = geom.arcRadius * 1.15;
  const ext1World: Point = {
    x: geom.intersection.x + Math.cos(geom.startAngle) * extLen,
    y: geom.intersection.y + Math.sin(geom.startAngle) * extLen,
  };
  const ext2World: Point = {
    x: geom.intersection.x + Math.cos(geom.endAngle) * extLen,
    y: geom.intersection.y + Math.sin(geom.endAngle) * extLen,
  };
  const gapFraction = 0.3;
  const gap1World: Point = {
    x: geom.intersection.x + Math.cos(geom.startAngle) * geom.arcRadius * gapFraction,
    y: geom.intersection.y + Math.sin(geom.startAngle) * geom.arcRadius * gapFraction,
  };
  const gap2World: Point = {
    x: geom.intersection.x + Math.cos(geom.endAngle) * geom.arcRadius * gapFraction,
    y: geom.intersection.y + Math.sin(geom.endAngle) * geom.arcRadius * gapFraction,
  };
  renderer.drawLine(viewport.worldToScreen(gap1World), viewport.worldToScreen(ext1World), lineStyle);
  renderer.drawLine(viewport.worldToScreen(gap2World), viewport.worldToScreen(ext2World), lineStyle);

  // V-shaped arrowheads at arc endpoints (tangent direction)
  const aLen = DIMENSION_ARROW_LENGTH * scale;
  const aHalf = DIMENSION_ARROW_HALF_WIDTH * scale;

  // Arrow at start angle point
  const arcPt1 = viewport.worldToScreen({
    x: geom.intersection.x + Math.cos(geom.startAngle) * geom.arcRadius,
    y: geom.intersection.y + Math.sin(geom.startAngle) * geom.arcRadius,
  });
  // Tangent at start: perpendicular to radius, in direction of sweep
  const tangentSign1 = counterClockwise ? -1 : 1;
  const st1x = -Math.sin(geom.startAngle) * tangentSign1;
  const st1y = Math.cos(geom.startAngle) * tangentSign1;
  // Perpendicular to tangent
  const sn1x = -st1y;
  const sn1y = st1x;
  renderer.drawLine(arcPt1, { x: arcPt1.x + st1x * aLen + sn1x * aHalf, y: arcPt1.y + st1y * aLen + sn1y * aHalf }, lineStyle);
  renderer.drawLine(arcPt1, { x: arcPt1.x + st1x * aLen - sn1x * aHalf, y: arcPt1.y + st1y * aLen - sn1y * aHalf }, lineStyle);

  // Arrow at end angle point
  const arcPt2 = viewport.worldToScreen({
    x: geom.intersection.x + Math.cos(geom.endAngle) * geom.arcRadius,
    y: geom.intersection.y + Math.sin(geom.endAngle) * geom.arcRadius,
  });
  const tangentSign2 = counterClockwise ? 1 : -1;
  const st2x = -Math.sin(geom.endAngle) * tangentSign2;
  const st2y = Math.cos(geom.endAngle) * tangentSign2;
  const sn2x = -st2y;
  const sn2y = st2x;
  renderer.drawLine(arcPt2, { x: arcPt2.x + st2x * aLen + sn2x * aHalf, y: arcPt2.y + st2y * aLen + sn2y * aHalf }, lineStyle);
  renderer.drawLine(arcPt2, { x: arcPt2.x + st2x * aLen - sn2x * aHalf, y: arcPt2.y + st2y * aLen - sn2y * aHalf }, lineStyle);

  // Text label at arc midpoint
  const angleDeg = absSweep * 180 / Math.PI;
  const displayLabel = label?.replace('{v}', `${angleDeg.toFixed(1)}°`) ?? (derived ? `(${angleDeg.toFixed(1)}°)` : `${angleDeg.toFixed(1)}°`);
  const textPos = getAngleDimensionTextScreenPos(viewport, geom);

  const metrics = renderer.measureText(displayLabel, textStyle);
  const pad = DIMENSION_TEXT_PAD;
  if (bgColor) {
    renderer.drawRect(
      { x: textPos.x - metrics.width / 2 - pad, y: textPos.y - metrics.height / 2 - pad },
      { x: metrics.width + pad * 2, y: metrics.height + pad * 2 },
      bgColor,
    );
  }
  renderer.drawText(displayLabel, textPos, textStyle);
}

export function drawDiameterLabel(
  renderer: Renderer,
  viewport: Viewport,
  center: Point,
  radius: number,
  textStyle: TextStyle,
  bgColor?: string,
): void {
  const screenCenter = viewport.worldToScreen(center);
  const textOffset = 12;
  const textPos: Point = { x: screenCenter.x, y: screenCenter.y - radius * viewport.scale - textOffset };

  const diameter = radius * 2;
  const label = `\u2300${formatLength(diameter)}`;

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
