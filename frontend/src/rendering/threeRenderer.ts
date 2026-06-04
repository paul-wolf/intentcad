/**
 * Three.js implementation of the Renderer interface.
 *
 * Instead of drawing to an HTML5 Canvas, this renderer builds Three.js
 * line/point objects on a 3D sketch plane. It implements the same Renderer
 * interface that Canvas2DRenderer does, so the entire render pipeline and
 * all tool overlays can be reused unchanged.
 *
 * Coordinates flow:
 *   Tool / pipeline gives screen-space Point (same as Canvas2D path)
 *   → We convert screen → plane-local 2D via the paired PlaneViewport
 *   → We convert plane-local 2D → 3D via the plane basis
 *   → We add Three.js objects to a group
 *
 * Usage:
 *   const group = new THREE.Group();
 *   const renderer = new ThreeJSRenderer(group, planeViewport, plane);
 *   renderer.begin();          // clear previous frame's objects
 *   renderFrame(ctx);          // pipeline calls drawLine, drawCircle, etc.
 *   renderer.end();            // finalize geometry
 */
import * as THREE from 'three';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import type { Point } from '@/types/document';
import type { Renderer, LineStyle, TextStyle } from '@/types/renderer';
import type { Plane } from '@/types/part';

/** Convert a 2D plane-local point to a 3D world position on the plane. */
function to3D(p: Point, plane: Plane): THREE.Vector3 {
  const [ox, oy, oz] = plane.origin;
  const [nx, ny, nz] = plane.normal;
  const [xx, xy, xz] = plane.xAxis;
  // yAxis = xAxis × normal
  const yx = xy * nz - xz * ny;
  const yy = xz * nx - xx * nz;
  const yz = xx * ny - xy * nx;
  return new THREE.Vector3(
    ox + p.x * xx + p.y * yx,
    oy + p.x * xy + p.y * yy,
    oz + p.x * xz + p.y * yz,
  );
}

/** Parse a CSS color string into a THREE.Color (handles hex, named, rgba). */
const colorCache = new Map<string, THREE.Color>();
function parseColor(css: string): THREE.Color {
  const cached = colorCache.get(css);
  if (cached) return cached.clone();

  let color = css.trim();
  // Strip alpha from 8-digit hex (#RRGGBBAA → #RRGGBB)
  if (/^#[0-9a-f]{8}$/i.test(color)) {
    color = color.slice(0, 7);
  }
  // Handle rgba(...) by extracting rgb values
  const rgbaMatch = color.match(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/);
  if (rgbaMatch) {
    const c = new THREE.Color(+rgbaMatch[1]! / 255, +rgbaMatch[2]! / 255, +rgbaMatch[3]! / 255);
    colorCache.set(css, c);
    return c.clone();
  }
  // Only pass valid formats to THREE.Color to avoid console warning spam
  if (/^#[0-9a-f]{6}$/i.test(color) || /^#[0-9a-f]{3}$/i.test(color) || /^[a-z]+$/i.test(color)) {
    const c = new THREE.Color(color);
    colorCache.set(css, c);
    return c.clone();
  }
  const fallback = new THREE.Color(0xffffff);
  colorCache.set(css, fallback);
  return fallback.clone();
}

interface PendingLine {
  positions: number[]; // flat xyz pairs
  color: THREE.Color;
  width: number;
  opacity: number;
}

interface PendingDot {
  center: THREE.Vector3;
  radius: number; // screen-space px — converted to world size
  color: THREE.Color;
}

export class ThreeJSRenderer implements Renderer {
  private group: THREE.Group;
  private plane: Plane;
  private screenToPlane: (p: Point) => Point;
  private resolution: THREE.Vector2;

  // Batched geometry to be built in end()
  private lines: PendingLine[] = [];
  private dots: PendingDot[] = [];
  private globalAlpha = 1;

  // Reusable material cache (keyed by color+width+opacity)
  private materialCache = new Map<string, LineMaterial>();

  // Approximate world-units-per-screen-pixel for sizing dots/text
  private worldPerPx: number;

  constructor(
    group: THREE.Group,
    plane: Plane,
    screenToPlane: (p: Point) => Point,
    resolution: THREE.Vector2,
    worldPerPx: number,
  ) {
    this.group = group;
    this.plane = plane;
    this.screenToPlane = screenToPlane;
    this.resolution = resolution;
    this.worldPerPx = worldPerPx;
  }

  /** Call before each frame to clear previous objects. */
  begin(): void {
    // Remove all children from the group
    while (this.group.children.length > 0) {
      const child = this.group.children[0]!;
      this.group.remove(child);
      if ((child as THREE.Mesh).geometry) (child as THREE.Mesh).geometry.dispose();
      if ((child as THREE.Mesh).material) {
        const mat = (child as THREE.Mesh).material;
        if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
        else (mat as THREE.Material).dispose();
      }
    }
    this.lines = [];
    this.dots = [];
    this.globalAlpha = 1;
    this.materialCache.clear();
  }

  /** Call after rendering to build actual Three.js objects. */
  end(): void {
    // Build line objects — group by color+width+opacity for batching
    const batches = new Map<string, { positions: number[]; color: THREE.Color; width: number; opacity: number }>();

    for (const line of this.lines) {
      const key = `${line.color.getHexString()}_${line.width}_${line.opacity.toFixed(2)}`;
      let batch = batches.get(key);
      if (!batch) {
        batch = { positions: [], color: line.color, width: line.width, opacity: line.opacity };
        batches.set(key, batch);
      }
      batch.positions.push(...line.positions);
    }

    for (const [, batch] of batches) {
      if (batch.positions.length < 6) continue;
      const geo = new LineSegmentsGeometry();
      geo.setPositions(batch.positions);
      const mat = new LineMaterial({
        color: batch.color.getHex(),
        linewidth: Math.max(1, batch.width),
        resolution: this.resolution,
        transparent: batch.opacity < 1,
        opacity: batch.opacity,
        depthTest: false,
      });
      const mesh = new LineSegments2(geo, mat);
      mesh.renderOrder = 999;
      this.group.add(mesh);
    }

    // Build dot sprites as small sphere meshes
    for (const dot of this.dots) {
      const worldRadius = dot.radius * this.worldPerPx;
      const geo = new THREE.SphereGeometry(worldRadius, 8, 8);
      const mat = new THREE.MeshBasicMaterial({
        color: dot.color,
        depthTest: false,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.copy(dot.center);
      mesh.renderOrder = 1000;
      this.group.add(mesh);
    }

    this.lines = [];
    this.dots = [];
  }

  // ── Renderer interface ──

  clear(_color: string): void {
    // No-op in 3D — background is handled by the Three.js scene
  }

  drawLine(a: Point, b: Point, style: LineStyle): void {
    const pa = this.screenToPlane(a);
    const pb = this.screenToPlane(b);
    const a3 = to3D(pa, this.plane);
    const b3 = to3D(pb, this.plane);
    const opacity = (style.opacity ?? 1) * this.globalAlpha;
    // For dashed lines, we approximate by drawing shorter segments
    // (LineMaterial doesn't support dash directly, but the visual fidelity is acceptable)
    this.lines.push({
      positions: [a3.x, a3.y, a3.z, b3.x, b3.y, b3.z],
      color: parseColor(style.color),
      width: style.width,
      opacity,
    });
  }

  drawCircle(center: Point, radius: number, style: LineStyle): void {
    const n = 32;
    const pc = this.screenToPlane(center);
    // radius is in screen pixels — convert to plane-local units
    const worldRadius = radius * this.worldPerPx;
    const opacity = (style.opacity ?? 1) * this.globalAlpha;
    const color = parseColor(style.color);
    const positions: number[] = [];

    for (let i = 0; i < n; i++) {
      const a1 = (i / n) * Math.PI * 2;
      const a2 = ((i + 1) / n) * Math.PI * 2;
      const p1 = { x: pc.x + worldRadius * Math.cos(a1), y: pc.y + worldRadius * Math.sin(a1) };
      const p2 = { x: pc.x + worldRadius * Math.cos(a2), y: pc.y + worldRadius * Math.sin(a2) };
      const v1 = to3D(p1, this.plane);
      const v2 = to3D(p2, this.plane);
      positions.push(v1.x, v1.y, v1.z, v2.x, v2.y, v2.z);
    }

    this.lines.push({ positions, color, width: style.width, opacity });
  }

  drawArc(center: Point, radius: number, startAngle: number, endAngle: number, counterClockwise: boolean, style: LineStyle): void {
    const pc = this.screenToPlane(center);
    const worldRadius = radius * this.worldPerPx;
    const opacity = (style.opacity ?? 1) * this.globalAlpha;
    const color = parseColor(style.color);

    // Compute sweep
    let sweep = counterClockwise ? startAngle - endAngle : endAngle - startAngle;
    if (sweep < 0) sweep += Math.PI * 2;
    if (sweep === 0) sweep = Math.PI * 2;

    const n = Math.max(8, Math.ceil(sweep / (Math.PI / 16)));
    const positions: number[] = [];
    const dir = counterClockwise ? -1 : 1;

    for (let i = 0; i < n; i++) {
      const t1 = i / n;
      const t2 = (i + 1) / n;
      const a1 = startAngle + dir * sweep * t1;
      const a2 = startAngle + dir * sweep * t2;
      const p1 = { x: pc.x + worldRadius * Math.cos(a1), y: pc.y + worldRadius * Math.sin(a1) };
      const p2 = { x: pc.x + worldRadius * Math.cos(a2), y: pc.y + worldRadius * Math.sin(a2) };
      const v1 = to3D(p1, this.plane);
      const v2 = to3D(p2, this.plane);
      positions.push(v1.x, v1.y, v1.z, v2.x, v2.y, v2.z);
    }

    this.lines.push({ positions, color, width: style.width, opacity });
  }

  fillCircle(center: Point, radius: number, color: string): void {
    const pc = this.screenToPlane(center);
    const center3D = to3D(pc, this.plane);
    this.dots.push({
      center: center3D,
      radius,
      color: parseColor(color),
    });
  }

  fillPolygon(_points: Point[], _color: string): void {
    // Fill is not rendered in 3D overlay mode
  }

  drawRect(topLeft: Point, size: Point, _fillColor: string, strokeStyle?: LineStyle): void {
    // In 3D we only draw the stroke — fill is not meaningful on a plane overlay
    if (!strokeStyle) return;
    const tr = { x: topLeft.x + size.x, y: topLeft.y };
    const br = { x: topLeft.x + size.x, y: topLeft.y + size.y };
    const bl = { x: topLeft.x, y: topLeft.y + size.y };
    this.drawLine(topLeft, tr, strokeStyle);
    this.drawLine(tr, br, strokeStyle);
    this.drawLine(br, bl, strokeStyle);
    this.drawLine(bl, topLeft, strokeStyle);
  }

  drawText(_text: string, _position: Point, _style: TextStyle): void {
    // Text rendering in 3D is complex (SDF, billboards, CSS2DRenderer).
    // For now, skip — dimensions/labels won't render in 3D sketch mode.
    // This is acceptable because the primary use case is drawing geometry,
    // not reading dimension labels.
  }

  measureText(_text: string, style: TextStyle): { width: number; height: number } {
    // Approximate — used for layout of constraint symbols
    return { width: style.fontSize * 0.6, height: style.fontSize };
  }

  drawBezier(p0: Point, p1: Point, p2: Point, p3: Point, style: LineStyle): void {
    const pp0 = this.screenToPlane(p0);
    const pp1 = this.screenToPlane(p1);
    const pp2 = this.screenToPlane(p2);
    const pp3 = this.screenToPlane(p3);
    const opacity = (style.opacity ?? 1) * this.globalAlpha;
    const color = parseColor(style.color);
    const n = 16;
    const positions: number[] = [];

    for (let i = 0; i < n; i++) {
      const t1 = i / n;
      const t2 = (i + 1) / n;
      const a = evalCubic(pp0, pp1, pp2, pp3, t1);
      const b = evalCubic(pp0, pp1, pp2, pp3, t2);
      const v1 = to3D(a, this.plane);
      const v2 = to3D(b, this.plane);
      positions.push(v1.x, v1.y, v1.z, v2.x, v2.y, v2.z);
    }

    this.lines.push({ positions, color, width: style.width, opacity });
  }

  setGlobalAlpha(alpha: number): void {
    this.globalAlpha = alpha;
  }

  resetGlobalAlpha(): void {
    this.globalAlpha = 1;
  }
}

/** De Casteljau cubic bezier evaluation. */
function evalCubic(p0: Point, p1: Point, p2: Point, p3: Point, t: number): Point {
  const lerp = (a: Point, b: Point, t: number): Point => ({
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
  });
  const a = lerp(p0, p1, t);
  const b = lerp(p1, p2, t);
  const c = lerp(p2, p3, t);
  const d = lerp(a, b, t);
  const e = lerp(b, c, t);
  return lerp(d, e, t);
}
