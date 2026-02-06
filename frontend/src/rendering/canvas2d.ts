import type { Point } from '@/types/document';
import type { Renderer, LineStyle, TextStyle } from '@/types/renderer';

export class Canvas2DRenderer implements Renderer {
  private ctx: CanvasRenderingContext2D;

  constructor(ctx: CanvasRenderingContext2D) {
    this.ctx = ctx;
  }

  clear(color: string): void {
    const { canvas } = this.ctx;
    this.ctx.fillStyle = color;
    this.ctx.fillRect(0, 0, canvas.width, canvas.height);
  }

  drawLine(a: Point, b: Point, style: LineStyle): void {
    const { ctx } = this;
    if (style.dash) ctx.setLineDash(style.dash);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.strokeStyle = style.color;
    ctx.lineWidth = style.width;
    if (style.opacity !== undefined) {
      const prev = ctx.globalAlpha;
      ctx.globalAlpha = style.opacity;
      ctx.stroke();
      ctx.globalAlpha = prev;
    } else {
      ctx.stroke();
    }
    if (style.dash) ctx.setLineDash([]);
  }

  drawCircle(center: Point, radius: number, style: LineStyle): void {
    const { ctx } = this;
    if (style.dash) ctx.setLineDash(style.dash);
    ctx.beginPath();
    ctx.arc(center.x, center.y, radius, 0, Math.PI * 2);
    ctx.strokeStyle = style.color;
    ctx.lineWidth = style.width;
    ctx.stroke();
    if (style.dash) ctx.setLineDash([]);
  }

  drawArc(center: Point, radius: number, startAngle: number, endAngle: number, counterClockwise: boolean, style: LineStyle): void {
    const { ctx } = this;
    if (style.dash) ctx.setLineDash(style.dash);
    ctx.beginPath();
    ctx.arc(center.x, center.y, radius, startAngle, endAngle, counterClockwise);
    ctx.strokeStyle = style.color;
    ctx.lineWidth = style.width;
    if (style.opacity !== undefined) {
      const prev = ctx.globalAlpha;
      ctx.globalAlpha = style.opacity;
      ctx.stroke();
      ctx.globalAlpha = prev;
    } else {
      ctx.stroke();
    }
    if (style.dash) ctx.setLineDash([]);
  }

  fillCircle(center: Point, radius: number, color: string): void {
    const { ctx } = this;
    ctx.beginPath();
    ctx.arc(center.x, center.y, radius, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
  }

  drawRect(topLeft: Point, size: Point, fillColor: string, strokeStyle?: LineStyle): void {
    const { ctx } = this;
    ctx.fillStyle = fillColor;
    ctx.fillRect(topLeft.x, topLeft.y, size.x, size.y);
    if (strokeStyle) {
      ctx.strokeStyle = strokeStyle.color;
      ctx.lineWidth = strokeStyle.width;
      ctx.strokeRect(topLeft.x, topLeft.y, size.x, size.y);
    }
  }

  drawText(text: string, position: Point, style: TextStyle): void {
    const { ctx } = this;
    const family = style.fontFamily ?? 'sans-serif';
    ctx.font = `${style.fontSize}px ${family}`;
    ctx.fillStyle = style.color;
    ctx.textAlign = style.textAlign ?? 'center';
    ctx.textBaseline = style.textBaseline ?? 'middle';
    ctx.fillText(text, position.x, position.y);
  }

  measureText(text: string, style: TextStyle): { width: number; height: number } {
    const { ctx } = this;
    const family = style.fontFamily ?? 'sans-serif';
    ctx.font = `${style.fontSize}px ${family}`;
    const metrics = ctx.measureText(text);
    return { width: metrics.width, height: style.fontSize };
  }

  drawBezier(p0: Point, p1: Point, p2: Point, p3: Point, style: LineStyle): void {
    const { ctx } = this;
    if (style.dash) ctx.setLineDash(style.dash);
    ctx.beginPath();
    ctx.moveTo(p0.x, p0.y);
    ctx.bezierCurveTo(p1.x, p1.y, p2.x, p2.y, p3.x, p3.y);
    ctx.strokeStyle = style.color;
    ctx.lineWidth = style.width;
    if (style.opacity !== undefined) {
      const prev = ctx.globalAlpha;
      ctx.globalAlpha = style.opacity;
      ctx.stroke();
      ctx.globalAlpha = prev;
    } else {
      ctx.stroke();
    }
    if (style.dash) ctx.setLineDash([]);
  }

  setGlobalAlpha(alpha: number): void {
    this.ctx.globalAlpha = alpha;
  }

  resetGlobalAlpha(): void {
    this.ctx.globalAlpha = 1;
  }
}
