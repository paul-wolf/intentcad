/**
 * Tests on the G-code itself: each job is generated, the G-code is parsed back
 * into motions, and the assertions are about what a machine would do, not about
 * internal toolpath objects. Shapes are in sketch coordinates (Y down); the
 * G-code has Y flipped (Y up).
 */
import { describe, it, expect } from 'vitest';
import type { Entity } from '@/types/document';
import type { CamJobConfig, CamOperation, OperationCuttingParams, ProfileOperation, ToolpathMove } from '@/types/cam';
import { createDefaultCutting, createDefaultJobConfig, migrateCamJobConfig, DEFAULT_POST } from '@/types/cam';
import { generateGcode } from './generate';
import { validateCamJob } from './validate';

// ── Shapes ──

const rect = (id: string, w = 40, h = 20, cornerRadius = 0): Entity =>
  ({ id, type: 'rectangle', center: { x: 0, y: 0 }, width: w, height: h, cornerRadius }) as Entity;
const square = (id: string, reversed: boolean): Entity => {
  const pts = [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 20 }, { x: 0, y: 20 }];
  return { id, type: 'line', closed: true, points: reversed ? [pts[0]!, ...pts.slice(1).reverse()] : pts } as Entity;
};
const circle = (id: string, x: number, y: number, r: number): Entity =>
  ({ id, type: 'circle', center: { x, y }, radius: r }) as Entity;
/** A closed polyline in sketch coordinates; bulge[i] belongs to the edge from point i to point i + 1. */
const poly = (id: string, points: XY[], bulge: number[] = []): Entity =>
  ({ id, type: 'line', closed: true, points, bulge }) as Entity;
const box = (cx: number, cy: number, w: number, h: number): XY[] => [
  { x: cx - w / 2, y: cy - h / 2 }, { x: cx + w / 2, y: cy - h / 2 }, { x: cx + w / 2, y: cy + h / 2 }, { x: cx - w / 2, y: cy + h / 2 },
];

// ── Jobs ──

const cutting = (over: Partial<OperationCuttingParams> = {}): OperationCuttingParams => ({ ...createDefaultCutting(), ...over });
const tool6 = { id: 't6', name: '6mm Flat End Mill', diameter: 6, type: 'flat' as const, fluteCount: 2, fluteLength: 20 };

const profile = (ids: string[], cutSide: 'inside' | 'outside' | 'on', c = cutting()): CamOperation =>
  ({ kind: 'profile', sketchId: 's', entityIds: ids, cutSide, cutDirection: 'climb', tabs: false, tabCount: 4, tabWidth: 5, tabHeight: 1, cutting: c });
const pocket = (ids: string[], c = cutting()): CamOperation =>
  ({ kind: 'pocket', sketchId: 's', entityIds: ids, stepover: 0.4, cutDirection: 'climb', cutting: c });
const facing = (ids: string[], c = cutting()): CamOperation =>
  ({ kind: 'facing', sketchId: 's', entityIds: ids, stepover: 0.4, cutDirection: 'climb', cutting: c });
const drill = (ids: string[], peckDepth: number, dwell: number, c = cutting()): CamOperation =>
  ({ kind: 'drill', sketchId: 's', entityIds: ids, peckDepth, dwell, cutting: c });

function run(entities: Entity[], operations: CamOperation[], tweak?: (c: CamJobConfig) => void) {
  const config = createDefaultJobConfig();
  config.selectedSketchIds = ['s'];
  config.operations = operations;
  tweak?.(config);
  const result = generateGcode(config, entities);
  expect(result.issues.filter((i) => i.severity === 'error')).toEqual([]);
  expect(result.gcode).not.toBe('');
  return { ...result, parsed: parse(result.gcode) };
}

// ── A small G-code reader ──

interface Pos { x: number; y: number; z: number }
interface Motion { g: number; from: Pos; to: Pos; f?: number; i?: number; j?: number; line: number }

function parse(gcode: string): { motions: Motion[]; lines: string[] } {
  const lines = gcode.split('\n');
  const motions: Motion[] = [];
  let cur: Pos = { x: NaN, y: NaN, z: NaN };
  let feed: number | undefined;
  lines.forEach((raw, line) => {
    const code = raw.split(';')[0]!.trim();
    const m = /^G([0-3])(\s|$)/.exec(code);
    if (!m) return;
    const word = (letter: string) => {
      const w = new RegExp(`${letter}(-?[0-9.]+)`).exec(code);
      return w ? Number(w[1]) : undefined;
    };
    const g = Number(m[1]);
    const to = { x: word('X') ?? cur.x, y: word('Y') ?? cur.y, z: word('Z') ?? cur.z };
    const f = word('F');
    if (f !== undefined) feed = f;
    motions.push({ g, from: { ...cur }, to, f: g === 0 ? undefined : feed, i: word('I'), j: word('J'), line });
    cur = to;
  });
  return { motions, lines };
}

/** Mid point of a G2/G3 arc (G2 = clockwise with Y up). */
function arcMid(m: Motion): { x: number; y: number; r: number } {
  const cx = m.from.x + m.i!, cy = m.from.y + m.j!;
  const r = Math.hypot(m.from.x - cx, m.from.y - cy);
  const a0 = Math.atan2(m.from.y - cy, m.from.x - cx);
  const a1 = Math.atan2(m.to.y - cy, m.to.x - cx);
  let sweep = m.g === 2 ? a0 - a1 : a1 - a0;
  if (sweep <= 1e-9) sweep += 2 * Math.PI;
  const a = m.g === 2 ? a0 - sweep / 2 : a0 + sweep / 2;
  return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a), r };
}

/** Bounding box of every point the tool reaches while below the stock top. */
function cutBox(motions: Motion[]) {
  const pts: { x: number; y: number }[] = [];
  for (const m of motions) {
    if (m.g === 0 || m.to.z >= 0) continue;
    pts.push(m.to);
    if (m.g === 2 || m.g === 3) pts.push(arcMid(m));
  }
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
}

const near = (a: number, b: number, tol = 1e-3) => Math.abs(a - b) <= tol;

// ── Outlines and cut points, in machine coordinates (Y up) ──

interface XY { x: number; y: number }
/** An edge of an outline; bulge > 0 turns counter-clockwise (machine, Y up). */
interface Edge { a: XY; b: XY; bulge: number }

/** The outline of a sketch polyline, in machine coordinates (Y flipped, so bulges change sign). */
function outline(points: XY[], bulge: number[] = []): Edge[] {
  return points
    .map((p, i) => {
      const q = points[(i + 1) % points.length]!;
      return { a: { x: p.x, y: -p.y }, b: { x: q.x, y: -q.y }, bulge: -(bulge[i] ?? 0) };
    })
    .filter((e) => Math.hypot(e.b.x - e.a.x, e.b.y - e.a.y) > 1e-9);
}
const circleOutline = (x: number, y: number, r: number) => outline([{ x, y: y - r }, { x, y: y + r }], [1, 1]);

function edgeArc(e: Edge) {
  const theta = 4 * Math.atan(e.bulge);
  const dx = e.b.x - e.a.x, dy = e.b.y - e.a.y, d = Math.hypot(dx, dy);
  const h = (d / 2) / Math.tan(theta / 2);
  const c = { x: (e.a.x + e.b.x) / 2 - (dy / d) * h, y: (e.a.y + e.b.y) / 2 + (dx / d) * h };
  return { c, r: Math.hypot(e.a.x - c.x, e.a.y - c.y), a0: Math.atan2(e.a.y - c.y, e.a.x - c.x), theta };
}
function edgePoint(e: Edge, t: number): XY {
  if (e.bulge === 0) return { x: e.a.x + (e.b.x - e.a.x) * t, y: e.a.y + (e.b.y - e.a.y) * t };
  const { c, r, a0, theta } = edgeArc(e);
  return { x: c.x + r * Math.cos(a0 + theta * t), y: c.y + r * Math.sin(a0 + theta * t) };
}
function nearestOnEdge(e: Edge, p: XY): XY {
  if (e.bulge === 0) {
    const dx = e.b.x - e.a.x, dy = e.b.y - e.a.y;
    const t = Math.max(0, Math.min(1, ((p.x - e.a.x) * dx + (p.y - e.a.y) * dy) / (dx * dx + dy * dy)));
    return { x: e.a.x + t * dx, y: e.a.y + t * dy };
  }
  const { c, r, a0, theta } = edgeArc(e);
  const ang = Math.atan2(p.y - c.y, p.x - c.x);
  let u = (ang - a0) * Math.sign(theta);
  u = ((u % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  if (u <= Math.abs(theta)) return { x: c.x + r * Math.cos(ang), y: c.y + r * Math.sin(ang) };
  return Math.hypot(p.x - e.a.x, p.y - e.a.y) < Math.hypot(p.x - e.b.x, p.y - e.b.y) ? e.a : e.b;
}
const distToEdge = (e: Edge, p: XY) => { const q = nearestOnEdge(e, p); return Math.hypot(p.x - q.x, p.y - q.y); };
/** Distance from a point to the nearest wall of one or more outlines. */
const distTo = (walls: Edge[], p: XY) => Math.min(...walls.map((e) => distToEdge(e, p)));
/** Inside an odd number of loops (loops inside loops are islands). */
function insideOf(walls: Edge[], p: XY): boolean {
  let c = false;
  for (const e of walls) {
    const n = e.bulge === 0 ? 1 : 256;
    for (let k = 0; k < n; k++) {
      // Exact end points, so neighbouring edges agree on which side of the ray they are.
      const a = k === 0 ? e.a : edgePoint(e, k / n), b = k + 1 === n ? e.b : edgePoint(e, (k + 1) / n);
      if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) c = !c;
    }
  }
  return c;
}
/** Points along the outline, about `step` mm apart. */
function outlineSamples(walls: Edge[], step = 0.5): XY[] {
  const out: XY[] = [];
  for (const e of walls) {
    const len = e.bulge === 0 ? Math.hypot(e.b.x - e.a.x, e.b.y - e.a.y) : edgeArc(e).r * Math.abs(edgeArc(e).theta);
    const n = Math.max(1, Math.ceil(len / step));
    for (let k = 0; k < n; k++) out.push(edgePoint(e, k / n));
  }
  return out;
}

interface Sample { p: XY; dir: XY; line: number; inner: boolean }
/**
 * Points along every feed move (G1/G2/G3) that runs at height `z` (or anywhere
 * below `below`), about 0.25 mm apart, arcs followed along the arc, with the
 * direction of travel there. `inner` is false for a move's two end points.
 */
function cutSamples(motions: Motion[], at: { z?: number; below?: number }): Sample[] {
  const out: Sample[] = [];
  for (const m of motions) {
    if (m.g === 0 || !known(m.from)) continue;
    if (at.z !== undefined && !(near(m.from.z, at.z) && near(m.to.z, at.z))) continue;
    if (at.below !== undefined && !(m.from.z < at.below && m.to.z < at.below)) continue;
    if (m.g === 1) {
      const dir = { x: m.to.x - m.from.x, y: m.to.y - m.from.y };
      const n = Math.max(1, Math.ceil(Math.hypot(dir.x, dir.y) / 0.25));
      for (let k = 0; k <= n; k++) {
        out.push({ p: { x: m.from.x + dir.x * k / n, y: m.from.y + dir.y * k / n }, dir, line: m.line, inner: k > 0 && k < n });
      }
    } else {
      const cx = m.from.x + m.i!, cy = m.from.y + m.j!;
      const r = Math.hypot(m.from.x - cx, m.from.y - cy);
      const a0 = Math.atan2(m.from.y - cy, m.from.x - cx);
      const a1 = Math.atan2(m.to.y - cy, m.to.x - cx);
      let sweep = m.g === 3 ? a1 - a0 : a0 - a1;
      if (sweep <= 1e-9) sweep += 2 * Math.PI;
      if (m.g === 2) sweep = -sweep;
      const n = Math.max(2, Math.ceil(r * Math.abs(sweep) / 0.25));
      for (let k = 0; k <= n; k++) {
        const a = a0 + sweep * k / n, s = Math.sign(sweep);
        out.push({ p: { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) }, dir: { x: -Math.sin(a) * s, y: Math.cos(a) * s }, line: m.line, inner: k > 0 && k < n });
      }
    }
  }
  return out;
}

/**
 * Which side of travel the wall is on, for cut points that touch a wall (one
 * tool radius from it): 'right' is climb milling with a clockwise (M3) spindle.
 */
function wallSides(samples: Sample[], outlines: Edge[][], toolRadius = 1.5): Set<'left' | 'right'> {
  const sides = new Set<'left' | 'right'>();
  for (const s of samples) {
    if (!s.inner) continue;
    for (const walls of outlines) {
      let best: { d: number; q: XY } | null = null;
      for (const e of walls) {
        const q = nearestOnEdge(e, s.p);
        const d = Math.hypot(q.x - s.p.x, q.y - s.p.y);
        if (!best || d < best.d) best = { d, q };
      }
      // Only points where the tool touches the wall: a link passing a few
      // hundredths clear of it doesn't cut it.
      if (!best || best.d > toolRadius + 0.01) continue;
      const wx = best.q.x - s.p.x, wy = best.q.y - s.p.y;
      const cross = (s.dir.x * wy - s.dir.y * wx) / (Math.hypot(s.dir.x, s.dir.y) * Math.hypot(wx, wy));
      if (Math.abs(cross) < 0.5) continue;
      sides.add(cross < 0 ? 'right' : 'left');
    }
  }
  return sides;
}

const known = (p: Pos) => !Number.isNaN(p.x) && !Number.isNaN(p.y);
/** XY length of a feed move, arcs along the arc. */
function pathLength(m: Motion): number {
  if (m.g !== 2 && m.g !== 3) return Math.hypot(m.to.x - m.from.x, m.to.y - m.from.y);
  const cx = m.from.x + m.i!, cy = m.from.y + m.j!;
  const a0 = Math.atan2(m.from.y - cy, m.from.x - cx), a1 = Math.atan2(m.to.y - cy, m.to.x - cx);
  let sweep = m.g === 2 ? a0 - a1 : a1 - a0;
  if (sweep <= 1e-9) sweep += 2 * Math.PI;
  return Math.hypot(m.from.x - cx, m.from.y - cy) * sweep;
}
const movesXY = (m: Motion) => known(m.from) && (!near(m.from.x, m.to.x) || !near(m.from.y, m.to.y));

const ALL_JOBS: [string, Entity[], CamOperation[]][] = [
  ['profile outside', [rect('r')], [profile(['r'], 'outside')]],
  ['profile inside, rounded', [rect('r', 40, 20, 5)], [profile(['r'], 'inside')]],
  ['profile on a circle', [circle('c', 0, 0, 10)], [profile(['c'], 'on')]],
  ['pocket', [rect('r')], [pocket(['r'])]],
  ['facing', [rect('r')], [facing(['r'])]],
  ['peck drill', [circle('h1', 0, 0, 1.5), circle('h2', 20, 0, 1.5)], [drill(['h1', 'h2'], 1, 0)]],
  ['profile with tabs', [rect('r')], [{ ...profile(['r'], 'outside'), tabs: true } as CamOperation]],
  ['pocket with an island', [poly('o', box(0, 0, 60, 40)), circle('i', 0, 0, 8)], [pocket(['o', 'i'])]],
  ['two pockets', [poly('a', box(-25, 0, 30, 20)), poly('b', box(25, 0, 30, 20))], [pocket(['a', 'b'])]],
];

// ── Profiles ──

describe('profile side', () => {
  it('cuts a rectangle outside when asked for outside', () => {
    const b = cutBox(run([rect('r')], [profile(['r'], 'outside')]).parsed.motions);
    expect([b.minX, b.maxX, b.minY, b.maxY]).toEqual([-21.5, 21.5, -11.5, 11.5]);
  });

  it('cuts a rectangle inside when asked for inside', () => {
    const b = cutBox(run([rect('r')], [profile(['r'], 'inside')]).parsed.motions);
    expect([b.minX, b.maxX, b.minY, b.maxY]).toEqual([-18.5, 18.5, -8.5, 8.5]);
  });

  it('does not depend on the direction the shape was drawn', () => {
    for (const reversed of [false, true]) {
      const b = cutBox(run([square('q', reversed)], [profile(['q'], 'outside')]).parsed.motions);
      expect([b.minX, b.maxX, b.minY, b.maxY]).toEqual([-1.5, 21.5, -21.5, 1.5]);
    }
  });

  it('cuts every edge at full depth, including the first', () => {
    const { motions } = run([rect('r')], [profile(['r'], 'outside')]).parsed;
    const atDepth = motions.filter((m) => m.g !== 0 && near(m.from.z, -3) && near(m.to.z, -3));
    const length = atDepth.reduce((s, m) => s + pathLength(m), 0);
    // Four sides, plus a quarter circle of the tool radius round each corner.
    expect(length).toBeCloseTo(2 * (40 + 20) + 2 * Math.PI * 1.5, 3);
  });

  it('rounds the outside corners with the tool radius, so the corner stays sharp', () => {
    const { motions } = run([rect('r')], [profile(['r'], 'outside')]).parsed;
    const arcs = motions.filter((m) => (m.g === 2 || m.g === 3) && near(m.to.z, -3));
    expect(arcs).toHaveLength(4);
    for (const m of arcs) {
      const mid = arcMid(m);
      expect(mid.r).toBeCloseTo(1.5, 3);
      expect(Math.min(...[[-20, -10], [20, -10], [20, 10], [-20, 10]].map(([x, y]) => Math.hypot(m.from.x + m.i! - x!, m.from.y + m.j! - y!)))).toBeCloseTo(0, 3);
    }
  });
});

describe('arcs', () => {
  it('round the corners of a rounded rectangle outward', () => {
    const { motions } = run([rect('r', 40, 20, 5)], [profile(['r'], 'on')]).parsed;
    const arcs = motions.filter((m) => m.g === 2 || m.g === 3);
    expect(arcs.length).toBeGreaterThan(0);
    for (const m of arcs) {
      const mid = arcMid(m);
      const chord = { x: (m.from.x + m.to.x) / 2, y: (m.from.y + m.to.y) / 2 };
      expect(Math.hypot(mid.x, mid.y)).toBeGreaterThan(Math.hypot(chord.x, chord.y));
      expect(mid.r).toBeCloseTo(5, 3);
    }
  });

  it('grow the corner radius by the tool radius when cutting outside', () => {
    const { motions } = run([rect('r', 40, 20, 5)], [profile(['r'], 'outside')]).parsed;
    for (const m of motions.filter((mm) => mm.g === 2 || mm.g === 3)) expect(arcMid(m).r).toBeCloseTo(6.5, 3);
    const b = cutBox(motions);
    expect([b.minX, b.maxX, b.minY, b.maxY]).toEqual([-21.5, 21.5, -11.5, 11.5]);
  });
});

describe('circles', () => {
  it('cut a circle outside and inside at the right radius', () => {
    for (const [side, r] of [['outside', 11.5], ['inside', 8.5]] as const) {
      const { motions } = run([circle('c', 10, 10, 10)], [profile(['c'], side)]).parsed;
      const b = cutBox(motions);
      expect([b.minX, b.maxX, b.minY, b.maxY]).toEqual([10 - r, 10 + r, -10 - r, -10 + r]);
      for (const m of motions.filter((mm) => mm.g === 2 || mm.g === 3)) {
        const mid = arcMid(m);
        expect(Math.hypot(mid.x - 10, mid.y + 10)).toBeCloseTo(r, 3);
      }
    }
  });

  it('report a circle too small for the tool instead of crashing', () => {
    const config = createDefaultJobConfig();
    config.operations = [profile(['c'], 'inside')];
    const result = generateGcode(config, [circle('c', 0, 0, 1.2)]);
    expect(result.gcode).toBe('');
    expect(result.issues.some((i) => i.severity === 'error' && /too tight/.test(i.message))).toBe(true);
  });
});

describe('arcs that meet at a corner', () => {
  // A 40 mm square whose top edge is an arc: the arc meets the sides at an angle.
  const arcTop = (bulge: number): Entity => ({
    id: 'a', type: 'line', closed: true,
    points: [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 40 }, { x: 0, y: 40 }],
    bulge: [0, 0, bulge, 0],
  }) as Entity;

  it('are fine when cut on the line', () => {
    const { motions } = run([arcTop(-0.5)], [profile(['a'], 'on')]).parsed;
    expect(motions.some((m) => m.g === 2 || m.g === 3)).toBe(true);
  });
});

describe('profile corners: the tool centre stays exactly one tool radius from the outline', () => {
  const R = 1.5;
  const fillet = -Math.tan(Math.PI / 8); // a 90° arc turning clockwise in sketch (x, y): concave here
  const SHAPES: [string, XY[], number[]][] = [
    ['a square with a concave arc top', [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 40 }, { x: 0, y: 40 }], [0, 0, -0.5, 0]],
    ['a square with a convex arc top', [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 40 }, { x: 0, y: 40 }], [0, 0, 0.5, 0]],
    // The repeated point hides the corner between the arc and the line.
    ['a D shape', [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 0 }, { x: 0, y: 0 }], [0, 0, 1, 0]],
    ['an L with a concave fillet', [{ x: 0, y: 0 }, { x: 60, y: 0 }, { x: 60, y: 15 }, { x: 20, y: 15 }, { x: 15, y: 20 }, { x: 15, y: 60 }, { x: 0, y: 60 }], [0, 0, 0, fillet, 0, 0, 0]],
    ['an L with a fillet smaller than the tool', [{ x: 0, y: 0 }, { x: 60, y: 0 }, { x: 60, y: 15 }, { x: 16, y: 15 }, { x: 15, y: 16 }, { x: 15, y: 60 }, { x: 0, y: 60 }], [0, 0, 0, fillet, 0, 0, 0]],
  ];

  describe.each(SHAPES)('%s', (_name, points, bulge) => {
    const wall = outline(points, bulge);
    it.each(['inside', 'outside'] as const)('cut %s', (side) => {
      const { motions } = run([poly('p', points, bulge)], [profile(['p'], side)]).parsed;
      const samples = cutSamples(motions, { z: -3 });
      expect(samples.length).toBeGreaterThan(100);
      // Arcs that collapse on offset leave the tool further away there, never closer.
      const collapses = _name.includes('smaller');
      for (const s of samples) {
        const d = distTo(wall, s.p);
        expect(d, `line ${s.line} (${s.p.x.toFixed(3)}, ${s.p.y.toFixed(3)})`).toBeGreaterThanOrEqual(R - 2e-3);
        if (!collapses) expect(d, `line ${s.line} (${s.p.x.toFixed(3)}, ${s.p.y.toFixed(3)})`).toBeLessThanOrEqual(R + 2e-3);
        expect(insideOf(wall, s.p), `line ${s.line}`).toBe(side === 'inside');
      }
      // It goes all the way round: no part of the outline is left far from the tool.
      for (const o of outlineSamples(wall)) {
        expect(Math.min(...samples.map((s) => Math.hypot(s.p.x - o.x, s.p.y - o.y)))).toBeLessThan(R + 3.5);
      }
    });
  });
});

describe('profile cut direction', () => {
  const sq: XY[] = [{ x: 0, y: 0 }, { x: 30, y: 0 }, { x: 30, y: 20 }, { x: 0, y: 20 }];
  const wall = outline(sq, [0, 0, 0.3, 0]);
  it.each([
    ['outside', 'climb', 'right'], ['outside', 'conventional', 'left'],
    ['inside', 'climb', 'right'], ['inside', 'conventional', 'left'],
  ] as const)('%s, %s: the part wall is on the %s of travel (clockwise spindle)', (side, dir, expected) => {
    for (const reversed of [false, true]) {
      const pts = reversed ? [...sq].reverse() : sq;
      const b = reversed ? [-0.3, 0, 0, 0] : [0, 0, 0.3, 0];
      const op = { ...profile(['p'], side), cutDirection: dir } as CamOperation;
      const { motions } = run([poly('p', pts, b)], [op]).parsed;
      expect(wallSides(cutSamples(motions, { z: -3 }), [wall])).toEqual(new Set([expected]));
    }
  });
});

describe('fillets no bigger than the tool, cut inside', () => {
  it.each([1.5, 1])('become sharp corners of the tool path (radius %s, 3 mm tool)', (r) => {
    const { motions } = run([rect('r', 40, 20, r)], [profile(['r'], 'inside')]).parsed;
    expect(motions.some((m) => m.g === 2 || m.g === 3)).toBe(false);
    const b = cutBox(motions);
    expect([b.minX, b.maxX, b.minY, b.maxY]).toEqual([-18.5, 18.5, -8.5, 8.5]);
  });
});

describe('a rounded rectangle drawn as a polyline the other way round', () => {
  it('still cuts outside with outward corners', () => {
    // Clockwise on screen this time; rectanglePath() runs the other way.
    const k = Math.tan(Math.PI / 8);
    const poly = {
      id: 'p', type: 'line', closed: true,
      points: [
        { x: -15, y: -10 }, { x: 15, y: -10 }, { x: 20, y: -5 }, { x: 20, y: 5 },
        { x: 15, y: 10 }, { x: -15, y: 10 }, { x: -20, y: 5 }, { x: -20, y: -5 },
      ],
      bulge: [0, k, 0, k, 0, k, 0, k],
    } as Entity;
    const { motions } = run([poly], [profile(['p'], 'outside')]).parsed;
    const b = cutBox(motions);
    expect([b.minX, b.maxX, b.minY, b.maxY]).toEqual([-21.5, 21.5, -11.5, 11.5]);
    for (const m of motions.filter((mm) => mm.g === 2 || mm.g === 3)) {
      const mid = arcMid(m);
      const chord = { x: (m.from.x + m.to.x) / 2, y: (m.from.y + m.to.y) / 2 };
      expect(Math.hypot(mid.x, mid.y)).toBeGreaterThan(Math.hypot(chord.x, chord.y));
      expect(mid.r).toBeCloseTo(6.5, 3);
    }
  });
});

// ── Safety rules, for every kind of job ──

describe.each(ALL_JOBS)('safe motion: %s', (_name, entities, ops) => {
  const { motions } = run(entities, ops).parsed;

  it('never moves at rapid below the stock top, except straight up out of a cut', () => {
    for (const m of motions.filter((mm) => mm.g === 0)) {
      expect(m.to.z, `line ${m.line}`).toBeGreaterThanOrEqual(0);
      if (m.from.z < 0) expect(movesXY(m), `line ${m.line}`).toBe(false);
    }
  });

  it('enters material only by a straight plunge at the plunge rate', () => {
    for (const m of motions.filter((mm) => mm.g !== 0 && mm.from.z >= 0 && mm.to.z < 0)) {
      expect(movesXY(m), `line ${m.line}`).toBe(false);
      expect(m.f, `line ${m.line}`).toBe(200);
    }
  });

  it('never descends while moving sideways at rapid', () => {
    for (const m of motions.filter((mm) => mm.g === 0 && movesXY(mm))) {
      expect(m.to.z, `line ${m.line}`).toBeGreaterThanOrEqual(m.from.z);
    }
  });
});

// ── Pockets and facing ──

describe('pocket', () => {
  it('stays inside the wall and reaches full depth', () => {
    const { motions } = run([rect('r')], [pocket(['r'])]).parsed;
    const b = cutBox(motions);
    expect(b.minX).toBeGreaterThanOrEqual(-18.5 - 1e-3);
    expect(b.maxX).toBeLessThanOrEqual(18.5 + 1e-3);
    expect(b.minY).toBeGreaterThanOrEqual(-8.5 - 1e-3);
    expect(b.maxY).toBeLessThanOrEqual(8.5 + 1e-3);
    expect(Math.min(...motions.map((m) => m.to.z))).toBeCloseTo(-3, 3);
  });
});

const L_OUTLINE: XY[] = [{ x: 0, y: 0 }, { x: 60, y: 0 }, { x: 60, y: 15 }, { x: 15, y: 15 }, { x: 15, y: 60 }, { x: 0, y: 60 }];
const POCKETS: [string, Entity[], Edge[][]][] = [
  ['an L', [poly('L', L_OUTLINE)], [outline(L_OUTLINE)]],
  ['a pocket with a round island', [poly('o', box(0, 0, 60, 40)), circle('i', 0, 0, 8)], [outline(box(0, 0, 60, 40)), circleOutline(0, 0, 8)]],
  ['an island off centre, close to the wall', [poly('o', box(0, 0, 60, 40)), circle('i', 18, 6, 9)], [outline(box(0, 0, 60, 40)), circleOutline(18, 6, 9)]],
  ['two separate pockets', [poly('a', box(-25, 0, 30, 20)), poly('b', box(25, 0, 30, 20))], [outline(box(-25, 0, 30, 20)), outline(box(25, 0, 30, 20))]],
];

describe.each(POCKETS)('pocket: %s', (_name, entities, outlines) => {
  const walls = outlines.flat();
  const ops = (dir: 'climb' | 'conventional', stepover = 0.4) =>
    [{ ...pocket(entities.map((e) => e.id)), cutDirection: dir, stepover } as CamOperation];

  it.each(['climb', 'conventional'] as const)('keeps every cutting point inside the wall, a tool radius from it (%s)', (dir) => {
    const { motions } = run(entities, ops(dir)).parsed;
    const samples = cutSamples(motions, { below: 0 });
    expect(samples.length).toBeGreaterThan(100);
    for (const s of samples) {
      expect(insideOf(walls, s.p), `line ${s.line}`).toBe(true);
      expect(distTo(walls, s.p), `line ${s.line} (${s.p.x.toFixed(3)}, ${s.p.y.toFixed(3)})`).toBeGreaterThanOrEqual(1.5 - 1e-3);
    }
  });

  it.each([
    ['climb', 'right'], ['conventional', 'left'],
  ] as const)('%s: walls and islands are on the %s of travel (clockwise spindle)', (dir, side) => {
    const { motions } = run(entities, ops(dir)).parsed;
    expect(wallSides(cutSamples(motions, { z: -3 }), outlines)).toEqual(new Set([side]));
  });

  it.each([0.4, 0.7])('clears the whole area at full depth (stepover %s)', (stepover) => {
    const { motions } = run(entities, ops('climb', stepover)).parsed;
    const pts = cutSamples(motions, { z: -3 }).map((s) => s.p);
    const xs = walls.map((e) => e.a.x), ys = walls.map((e) => e.a.y);
    for (let x = Math.min(...xs); x <= Math.max(...xs); x += 1) {
      for (let y = Math.min(...ys); y <= Math.max(...ys); y += 1) {
        const p = { x, y };
        // Leave out the corners a round tool can't reach.
        if (!insideOf(walls, p) || distTo(walls, p) < 0.5) continue;
        const d = Math.min(...pts.map((q) => Math.hypot(q.x - p.x, q.y - p.y)));
        expect(d, `(${x}, ${y}) left uncut`).toBeLessThanOrEqual(1.5 + 0.05);
      }
    }
  });
});

describe('pocket links', () => {
  const plunges = (motions: Motion[]) => motions.filter((m) => m.g === 1 && m.from.z >= 0 && m.to.z < 0).length;

  it('feeds from ring to ring inside cleared material: one plunge per depth pass', () => {
    expect(plunges(run([rect('r')], [pocket(['r'])]).parsed.motions)).toBe(3);
    expect(plunges(run([poly('L', L_OUTLINE)], [pocket(['L'])]).parsed.motions)).toBe(3);
  });

  it('lifts, travels and plunges between separate pockets', () => {
    const { motions } = run([poly('a', box(-25, 0, 30, 20)), poly('b', box(25, 0, 30, 20))], [pocket(['a', 'b'])]).parsed;
    expect(plunges(motions)).toBe(6);
    // Never feeds across the gap between them.
    for (const s of cutSamples(motions, { below: 0 })) expect(Math.abs(s.p.x), `line ${s.line}`).toBeGreaterThanOrEqual(10 + 1.5 - 1e-3);
  });

  it('reports a pocket too narrow for the tool', () => {
    const config = createDefaultJobConfig();
    config.operations = [pocket(['n'])];
    // Each arm is 2.8 mm wide; the bounding box alone would let a 3 mm tool through.
    const result = generateGcode(config, [poly('n', [{ x: 0, y: 0 }, { x: 30, y: 0 }, { x: 30, y: 2.8 }, { x: 2.8, y: 2.8 }, { x: 2.8, y: 30 }, { x: 0, y: 30 }])]);
    expect(result.gcode).toBe('');
    expect(result.issues.some((i) => i.severity === 'error')).toBe(true);
  });

  it('warns about an arm too narrow for the tool, and cuts the rest', () => {
    // A 40 × 20 pocket with a 2.8 mm wide arm sticking out of its top edge.
    const shape = [
      { x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 20 }, { x: 21.4, y: 20 },
      { x: 21.4, y: 30 }, { x: 18.6, y: 30 }, { x: 18.6, y: 20 }, { x: 0, y: 20 },
    ];
    const { issues, parsed } = run([poly('a', shape)], [pocket(['a'])]);
    expect(issues.some((i) => i.severity === 'warning' && /too narrow.*uncut/.test(i.message))).toBe(true);
    // The tool only reaches into the arm's mouth, where it touches both corners:
    // 20 - sqrt(1.5² - 1.4²) = 19.46 mm.
    for (const s of cutSamples(parsed.motions, { below: 0 })) expect(s.p.y, `line ${s.line}`).toBeGreaterThanOrEqual(-19.47);
  });

  it('reports an outline that is not closed', () => {
    const config = createDefaultJobConfig();
    config.operations = [pocket(['o'])];
    const open = { id: 'o', type: 'line', closed: false, points: [{ x: 0, y: 0 }, { x: 30, y: 0 }, { x: 30, y: 30 }] } as Entity;
    const result = generateGcode(config, [open]);
    expect(result.gcode).toBe('');
    expect(result.issues.some((i) => i.severity === 'error' && /closed/.test(i.message))).toBe(true);
  });
});

describe('pocket direction', () => {
  /** Signed area (machine X/Y, Y up) of the first ring cut at the first depth. */
  const firstRingArea = (dir: 'climb' | 'conventional') => {
    const op = { ...pocket(['r']), cutDirection: dir } as CamOperation;
    const { motions } = run([rect('r')], [op]).parsed;
    const plunge = motions.findIndex((m) => m.g === 1 && m.to.z < 0);
    const start = motions[plunge]!.to;
    const pts: { x: number; y: number }[] = [start];
    for (const m of motions.slice(plunge + 1)) {
      pts.push(m.to);
      if (near(m.to.x, start.x) && near(m.to.y, start.y)) break;
    }
    let a = 0;
    for (let i = 0; i < pts.length - 1; i++) a += pts[i]!.x * pts[i + 1]!.y - pts[i + 1]!.x * pts[i]!.y;
    return a / 2;
  };

  it('climb runs counter-clockwise on the machine (clockwise spindle, inside a pocket)', () => {
    expect(firstRingArea('climb')).toBeGreaterThan(0);
    expect(firstRingArea('conventional')).toBeLessThan(0);
  });
});

describe('facing', () => {
  it('cuts every row at every depth, including the first', () => {
    const { motions } = run([rect('r')], [facing(['r'])]).parsed;
    const rowsAt = (z: number) => new Set(motions
      .filter((m) => m.g === 1 && near(m.from.z, z) && near(m.to.z, z) && near(m.from.y, m.to.y) && !near(m.from.x, m.to.x))
      .map((m) => m.to.y.toFixed(3)));
    // 20 + 2 × 3 mm tall area, rows 1.2 mm apart from 1.5 mm inside each edge: 20 rows.
    expect(rowsAt(-1).size).toBe(20);
    expect(rowsAt(-3).size).toBe(20);
  });
});

// ── Drilling ──

describe('drill', () => {
  it('dwells for the time asked', () => {
    const { lines } = run([circle('h', 0, 0, 1.5)], [drill(['h'], 0, 3)]).parsed;
    expect(lines.some((l) => /^G4 P3(\.0+)?(\s|;|$)/.test(l))).toBe(true);
  });

  it('adds no dwells that were not asked for', () => {
    const { lines } = run([rect('r')], [profile(['r'], 'outside')]).parsed;
    const dwells = lines.filter((l) => l.startsWith('G4'));
    expect(dwells.every((l) => /^G4 P2\b/.test(l))).toBe(true); // spindle spin-up only
  });
});

// ── Start, end, tool changes, coolant ──

describe('program', () => {
  it('starts by moving up to safe Z before any sideways move', () => {
    const { motions } = run([rect('r')], [profile(['r'], 'outside', cutting({ safeZ: 8 }))]).parsed;
    expect(motions[0]!.g).toBe(0);
    expect(motions[0]!.to.z).toBe(8);
    expect(Number.isNaN(motions[0]!.to.x)).toBe(true);
  });

  it('ends at the highest safe Z of the job, then goes home', () => {
    const { motions } = run([rect('r'), circle('h', 0, 0, 1.5)],
      [profile(['r'], 'outside', cutting({ safeZ: 8 })), drill(['h'], 0, 0)]).parsed;
    const last = motions[motions.length - 1]!;
    expect([last.g, last.to.x, last.to.y]).toEqual([0, 0, 0]);
    expect(last.from.z).toBe(8);
  });

  it('pauses for a tool change when the tool changes', () => {
    const { lines, motions } = run([rect('r'), circle('h', 30, 0, 3.5)],
      [profile(['r'], 'outside'), drill(['h'], 0, 0, cutting({ tool: tool6 }))]).parsed;
    const m0 = lines.findIndex((l) => /^M0\b/.test(l));
    expect(m0).toBeGreaterThan(-1);
    const before = motions.filter((m) => m.line < m0);
    expect(before[before.length - 1]!.to.z).toBeGreaterThanOrEqual(5);
    const m5 = lines.findIndex((l, i) => i < m0 && i > before[before.length - 1]!.line && /^M5\b/.test(l));
    expect(m5).toBeGreaterThan(-1);
    expect(lines.slice(m5, m0 + 1).join('\n')).toContain('6mm Flat End Mill');
    const firstSideways = motions.find((m) => m.line > m0 && /[XY]/.test(lines[m.line]!))!;
    expect(lines.slice(m0, firstSideways.line).some((l) => /^M3 S\d+/.test(l))).toBe(true);
  });

  it('lifts to safe Z right after the tool-change pause, before any sideways move', () => {
    const { lines, motions } = run([rect('r'), circle('h', 30, 0, 3.5)],
      [profile(['r'], 'outside'), drill(['h'], 0, 0, cutting({ tool: tool6 }))]).parsed;
    const m0 = lines.findIndex((l) => /^M0\b/.test(l));
    const after = motions.filter((m) => m.line > m0);
    // The operator just set Z zero with the tool on the stock: the first move is straight up.
    expect(after[0]!.g).toBe(0);
    expect(lines[after[0]!.line]).toMatch(/^G0 Z5\.000/);
    expect(movesXY(after[1]!) || /X/.test(lines[after[1]!.line]!)).toBe(true);
    expect(after[1]!.to.z).toBe(5);
  });

  it('does not pause when only the spindle speed changes', () => {
    const { lines } = run([rect('r'), circle('h', 30, 0, 1.5)],
      [profile(['r'], 'outside'), drill(['h'], 0, 0, cutting({ spindleSpeed: 8000 }))]).parsed;
    expect(lines.some((l) => /^M0\b/.test(l))).toBe(false);
    expect(lines.some((l) => /^M3 S8000/.test(l))).toBe(true);
  });

  it('turns flood coolant on and off when asked', () => {
    const on = run([rect('r')], [profile(['r'], 'outside')], (c) => { c.useFloodCoolant = true; }).parsed.lines;
    const m3 = on.findIndex((l) => /^M3\b/.test(l));
    expect(on.findIndex((l) => /^M8\b/.test(l))).toBeGreaterThan(m3);
    expect(on.findIndex((l) => /^M9\b/.test(l))).toBeLessThan(on.findIndex((l) => /^M30\b/.test(l)));
    const off = run([rect('r')], [profile(['r'], 'outside')]).parsed.lines;
    expect(off.some((l) => /^M[89]\b/.test(l))).toBe(false);
  });
});

// ── Tabs ──

describe('tabs', () => {
  // 40 × 20 outside, 3 mm tool: the tool path is 120 + 3π mm long.
  const tabbed = (over: Partial<ProfileOperation> = {}) =>
    ({ ...profile(['r'], 'outside'), tabs: true, tabCount: 4, tabWidth: 5, tabHeight: 1, ...over }) as CamOperation;
  const pathLen = 2 * (40 + 20) + 2 * Math.PI * 1.5;

  /** The full-depth pass as stretches of travel at each height, in order. */
  function lastPass(motions: Motion[]) {
    const plunge = motions.map((m, i) => ({ m, i })).filter(({ m }) => m.g === 1 && m.from.z >= 0 && m.to.z < 0).pop()!.i;
    const end = motions.findIndex((m, i) => i > plunge && m.g === 0);
    return motions.slice(plunge + 1, end);
  }

  it('lifts over each tab on the full-depth pass, exactly the tab width plus the tool diameter long', () => {
    const { motions } = run([rect('r')], [tabbed()]).parsed;
    const pass = lastPass(motions);
    // Walk the pass: distance along the path where each lift starts and ends.
    let along = 0;
    const tabs: { from: number; to: number }[] = [];
    for (const m of pass) {
      const xy = movesXY(m);
      if (!xy && m.to.z > m.from.z) {
        expect(m.to.z).toBeCloseTo(-2, 3); // up to the tab top: 3 mm deep less 1 mm tab
        expect(m.g).toBe(1);
        tabs.push({ from: along, to: NaN });
      } else if (!xy && m.to.z < m.from.z) {
        expect(m.to.z).toBeCloseTo(-3, 3);
        tabs[tabs.length - 1]!.to = along;
      } else {
        expect(m.from.z).toBeCloseTo(m.to.z, 6);
        // Over a tab the tool is at the tab top; elsewhere at full depth.
        const onTab = tabs.length > 0 && Number.isNaN(tabs[tabs.length - 1]!.to);
        expect(m.to.z).toBeCloseTo(onTab ? -2 : -3, 3);
        along += pathLength(m);
      }
    }
    expect(along).toBeCloseTo(pathLen, 2);
    expect(tabs).toHaveLength(4);
    tabs.forEach((t, i) => {
      expect(t.to - t.from).toBeCloseTo(5 + 3, 2);
      // Evenly spaced round the path.
      expect((t.from + t.to) / 2).toBeCloseTo((i + 0.5) * pathLen / 4, 2);
    });
  });

  it('leaves the shallower passes alone', () => {
    const { motions } = run([rect('r')], [tabbed()]).parsed;
    // Passes at 1 and 2 mm deep: the tab top is at 2 mm, so neither lifts.
    const lifts = motions.filter((m) => m.g === 1 && !movesXY(m) && m.to.z > m.from.z);
    expect(lifts).toHaveLength(4);
    expect(lifts.every((m) => near(m.from.z, -3))).toBe(true);
  });

  it('refuses tabs as tall as the cut, and tabs that do not fit', () => {
    for (const over of [{ tabHeight: 3 }, { tabCount: 20 }, { tabCount: 0 }]) {
      const config = createDefaultJobConfig();
      config.operations = [tabbed(over)];
      const result = generateGcode(config, [rect('r')]);
      expect(result.gcode, JSON.stringify(over)).toBe('');
      expect(result.issues.some((i) => i.severity === 'error' && /tab/i.test(i.message)), JSON.stringify(over)).toBe(true);
    }
  });
});

// ── Stock ──

describe('stock top', () => {
  const at10 = (c: CamJobConfig) => { c.stock = { thickness: 5, zTop: 10 }; };

  it('measures Z from the stock top', () => {
    const { motions, lines } = run([rect('r')], [profile(['r'], 'outside')], at10).parsed;
    expect(motions[0]!.to.z).toBe(15); // safe Z 5 above the top
    const cutting = motions.filter((m) => m.g !== 0 && known(m.from));
    expect(Math.min(...cutting.map((m) => m.to.z))).toBeCloseTo(7, 3);
    expect(Math.max(...cutting.filter((m) => movesXY(m)).map((m) => m.to.z))).toBeCloseTo(9, 3);
    expect(lines.join('\n')).toMatch(/stock top.*Z ?10/i);
  });

  it('keeps every motion rule against the stock top, not Z 0', () => {
    const { motions } = run([rect('r')], [pocket(['r'])], at10).parsed;
    for (const m of motions.filter((mm) => mm.g === 0)) {
      expect(m.to.z, `line ${m.line}`).toBeGreaterThanOrEqual(10);
      if (m.from.z < 10) expect(movesXY(m), `line ${m.line}`).toBe(false);
    }
    for (const m of motions.filter((mm) => mm.g !== 0 && mm.from.z >= 10 && mm.to.z < 10)) {
      expect(movesXY(m), `line ${m.line}`).toBe(false);
    }
  });

  it('says when an operation cuts right through the stock', () => {
    const through = run([rect('r')], [profile(['r'], 'outside')], (c) => { c.stock.thickness = 3; });
    expect(through.issues.some((i) => i.severity === 'info' && /through/.test(i.message))).toBe(true);
    const not = run([rect('r')], [profile(['r'], 'outside')], (c) => { c.stock.thickness = 6; });
    expect(not.issues.some((i) => /through/.test(i.message))).toBe(false);
  });

  it('still warns when a cut goes past the bottom of the stock', () => {
    const { issues } = run([rect('r')], [profile(['r'], 'outside')], (c) => { c.stock = { thickness: 2, zTop: 10 }; });
    expect(issues.some((i) => i.severity === 'warning' && /below the stock/.test(i.message))).toBe(true);
  });
});

// ── Arc output ──

describe('arc output', () => {
  it('always writes true arcs, even for an old job saved with "linearize"', () => {
    const { motions } = run([rect('r', 40, 20, 5)], [profile(['r'], 'outside')], (c) => {
      Object.assign(c, migrateCamJobConfig({ ...c, postProcessor: { ...c.postProcessor, arcOutput: 'linearize', linearizeTolerance: 0.01 } }));
    }).parsed;
    expect(motions.filter((m) => m.g === 2 || m.g === 3).length).toBeGreaterThan(0);
  });

  it('drops the old arc settings when loading a job', () => {
    const c = migrateCamJobConfig({ ...createDefaultJobConfig(), postProcessor: { ...DEFAULT_POST, arcOutput: 'linearize', linearizeTolerance: 0.01 } });
    expect(c.postProcessor).not.toHaveProperty('arcOutput');
    expect(c.postProcessor).not.toHaveProperty('linearizeTolerance');
  });

  it('gives old profile operations a cut direction and a tab count', () => {
    const old = { ...profile(['r'], 'outside') } as Record<string, unknown>;
    delete old.cutDirection;
    delete old.tabCount;
    const c = migrateCamJobConfig({ ...createDefaultJobConfig(), operations: [old] });
    expect(c.operations[0]).toMatchObject({ cutDirection: 'climb', tabCount: 4 });
  });
});

// ── The safety check on toolpaths ──

describe('validateCamJob safety check', () => {
  const config = createDefaultJobConfig();
  const check = (moves: ToolpathMove[]) => validateCamJob(config, [], moves);

  it('refuses a rapid below the stock top', () => {
    const issues = check([
      { kind: 'rapid', to: { x: 0, y: 0 }, z: 5 },
      { kind: 'linear', to: { x: 0, y: 0 }, z: -1, feed: 200 },
      { kind: 'rapid', to: { x: 10, y: 0 }, z: -1 },
    ]);
    expect(issues.some((i) => i.severity === 'error' && /rapid/i.test(i.message))).toBe(true);
  });

  it('refuses entering material while moving sideways', () => {
    const issues = check([
      { kind: 'rapid', to: { x: 0, y: 0 }, z: 5 },
      { kind: 'linear', to: { x: 10, y: 0 }, z: -1, feed: 800 },
    ]);
    expect(issues.some((i) => i.severity === 'error' && /plunge/i.test(i.message))).toBe(true);
  });

  it('warns when a cut goes deeper than the stock', () => {
    const issues = check([
      { kind: 'rapid', to: { x: 0, y: 0 }, z: 5 },
      { kind: 'linear', to: { x: 0, y: 0 }, z: -4, feed: 200 },
    ]);
    expect(issues.some((i) => i.severity === 'warning' && /stock/i.test(i.message))).toBe(true);
  });

  it('refuses a first move that is already a cut below the stock top', () => {
    const issues = check([{ kind: 'linear', to: { x: 0, y: 0 }, z: -1, feed: 800 }]);
    expect(issues.some((i) => i.severity === 'error' && /plunge/i.test(i.message))).toBe(true);
  });

  it('refuses a safe Z at or below the stock top', () => {
    const c = createDefaultJobConfig();
    c.operations = [profile(['r'], 'outside', cutting({ safeZ: 0 }))];
    expect(validateCamJob(c, [rect('r')], []).some((i) => i.severity === 'error' && /safe Z/.test(i.message))).toBe(true);
  });


  it('accepts a clean plunge and cut', () => {
    const issues = check([
      { kind: 'rapid', to: { x: 0, y: 0 }, z: 5 },
      { kind: 'linear', to: { x: 0, y: 0 }, z: -1, feed: 200 },
      { kind: 'linear', to: { x: 10, y: 0 }, z: -1, feed: 800 },
      { kind: 'rapid', to: { x: 10, y: 0 }, z: 5 },
    ]);
    expect(issues).toEqual([]);
  });
});
