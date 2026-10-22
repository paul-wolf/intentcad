/**
 * Review of CAM phase 2 (cam-phase2): one test per defect found by a G-code
 * review. Each job is generated, the G-code is parsed back into motions, and the
 * assertions are about what a GRBL machine would do. Shapes are in sketch
 * coordinates (Y down); the G-code has Y flipped (Y up). Helpers are copied
 * from gcode.test.ts.
 *
 * Each test failed before its fix. Tests marked "PINNED" passed already and
 * record a behaviour so that a change to it is noticed.
 */
import { describe, it, expect } from 'vitest';
import type { Entity } from '@/types/document';
import type { CamJobConfig, CamOperation, OperationCuttingParams } from '@/types/cam';
import { createDefaultCutting, createDefaultJobConfig } from '@/types/cam';
import { generateGcode } from './generate';

// ── Shapes ──

const rect = (id: string, w = 40, h = 20, cornerRadius = 0): Entity =>
  ({ id, type: 'rectangle', center: { x: 0, y: 0 }, width: w, height: h, cornerRadius }) as Entity;
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

const profile = (ids: string[], cutSide: 'inside' | 'outside' | 'on', c = cutting()): CamOperation =>
  ({ kind: 'profile', sketchId: 's', entityIds: ids, cutSide, cutDirection: 'climb', tabs: false, tabCount: 4, tabWidth: 5, tabHeight: 1, cutting: c });
const pocket = (ids: string[], c = cutting()): CamOperation =>
  ({ kind: 'pocket', sketchId: 's', entityIds: ids, stepover: 0.4, cutDirection: 'climb', cutting: c });

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

const known = (p: Pos) => !Number.isNaN(p.x) && !Number.isNaN(p.y);
const movesXY = (m: Motion) => known(m.from) && (!near(m.from.x, m.to.x) || !near(m.from.y, m.to.y));


/** Like run(), without asserting success (for jobs that are refused). */
function runRaw(entities: Entity[], operations: CamOperation[], tweak?: (c: CamJobConfig) => void) {
  const config = createDefaultJobConfig();
  config.selectedSketchIds = ['s'];
  config.operations = operations;
  tweak?.(config);
  const result = generateGcode(config, entities);
  return { ...result, parsed: parse(result.gcode) };
}

// ── Review helpers ──

const TOOL_R = 1.5; // the default 3 mm tool

/** Arcs whose rounded start and end are the same point: GRBL cuts those as a full 360° circle. */
const fullCircleArcs = (motions: Motion[]) =>
  motions.filter((m) => (m.g === 2 || m.g === 3) && known(m.from) && near(m.from.x, m.to.x, 1e-9) && near(m.from.y, m.to.y, 1e-9));

/**
 * Every plunge (a vertical feed down to a cutting depth) except the first one at
 * each depth, with the distance from the plunge point to the nearest point
 * already cut at that depth. A plunge further than a tool radius from any cut
 * puts more than half of a flat end mill straight down into solid material.
 */
function plungesIntoMaterial(motions: Motion[]) {
  const out: { line: number; x: number; y: number; z: number; clearance: number }[] = [];
  const seen = new Set<string>();
  motions.forEach((m, k) => {
    if (m.g !== 1 || !known(m.from) || movesXY(m) || !(m.to.z < m.from.z) || !(m.to.z < 0)) return;
    // Only plunges that start from above the stock (not tab returns, which go
    // back down into the slot just cut).
    if (m.from.z < 0) return;
    const key = m.to.z.toFixed(3);
    if (!seen.has(key)) { seen.add(key); return; }
    const done = cutSamples(motions.slice(0, k), { z: m.to.z });
    const d = Math.min(...done.map((s) => Math.hypot(s.p.x - m.to.x, s.p.y - m.to.y)));
    out.push({ line: m.line + 1, x: m.to.x, y: m.to.y, z: m.to.z, clearance: d });
  });
  return out;
}

/**
 * For a profile with tabs: on the deepest pass, the width of material left
 * between the full-depth cuts either side of each tab (the closest approach of
 * the two tool circles, so on a corner it is measured across the corner).
 */
function tabBridges(motions: Motion[], depth: number) {
  const plunge = motions.map((m, i) => ({ m, i })).filter(({ m }) => m.g === 1 && m.from.z >= 0 && near(m.to.z, depth)).pop()!.i;
  let end = motions.findIndex((m, i) => i > plunge && m.g === 0);
  if (end < 0) end = motions.length;
  const stretches: Motion[][] = [[]];
  let lifted = false;
  for (const m of motions.slice(plunge + 1, end)) {
    if (!movesXY(m)) {
      if (m.to.z > m.from.z) lifted = true;
      else { lifted = false; stretches.push([]); }
      continue;
    }
    if (!lifted) stretches[stretches.length - 1]!.push(m);
  }
  const pts = (ms: Motion[]) => cutSamples(ms, { z: depth }).map((s) => s.p);
  const out: { at: XY; bridge: number }[] = [];
  for (let k = 0; k + 1 < stretches.length; k++) {
    const a = pts(stretches[k]!), b = pts(stretches[k + 1]!);
    let d = Infinity;
    for (const p of a) for (const q of b) d = Math.min(d, Math.hypot(p.x - q.x, p.y - q.y));
    out.push({ at: a[a.length - 1]!, bridge: d - 2 * TOOL_R });
  }
  return out;
}

// ── 1. Zero-length arcs become full circles ──

describe('review 1: a corner arc shorter than the output resolution', () => {
  // A nearly straight edge with a tiny convex kink in the middle (15 mm along,
  // 0.01 µm out of line). The tool-radius rounding arc at the kink is
  // ~1e-5 mm long, so its start and end round to the same 3-decimal point:
  //   G2 X15.000 Y-1.500 Z-1.000 I-0.000 J1.500 F800.000
  // GRBL runs that as a full 360° circle of radius 1.5 around the vertex,
  // cutting 1.5 mm into the part on every pass.
  const kinked = (eps: number) => poly('k', [{ x: 0, y: 0 }, { x: 15, y: eps }, { x: 30, y: 0 }, { x: 30, y: 30 }, { x: 0, y: 30 }]);

  it.each([
    ['inside', 1e-5],
    ['inside', 1e-3],
    ['outside', -1e-5],
  ] as const)('emits no G2/G3 whose start equals its end (%s cut, kink %s mm)', (side, eps) => {
    const { parsed } = run([kinked(eps)], [profile(['k'], side)]);
    const bad = fullCircleArcs(parsed.motions).map((m) => parsed.lines[m.line]);
    expect(bad).toEqual([]);
  });

  it('keeps the tool on the waste side of the outline (inside cut)', () => {
    const { parsed } = run([kinked(1e-5)], [profile(['k'], 'inside')]);
    const walls = outline([{ x: 0, y: 0 }, { x: 15, y: 1e-5 }, { x: 30, y: 0 }, { x: 30, y: 30 }, { x: 0, y: 30 }]);
    // As GRBL reads it (a G2 with start = end is a full circle), sampled every 0.25 mm.
    const outside = cutSamples(parsed.motions, { below: 0 }).filter((s) => !insideOf(walls, s.p) || distTo(walls, s.p) < TOOL_R - 1e-3);
    expect(outside.length).toBe(0);
  });
});

// ── 2. Pocket plunges into solid material ──

describe('review 2: pocket entries', () => {
  // The island rings are in the same tree node as the outer wall ring, so the
  // ring round each island is cut straight after the wall ring, before the
  // floor between them is cleared: the tool rapids over and plunges into
  // solid material 14 mm from anything cut.
  it('plunges only into material already cut at that depth (two round islands)', () => {
    const ents = [poly('o', box(0, 0, 60, 40)), circle('a', -8, 0, 5), circle('b', 8, 0, 5)];
    const { parsed } = run(ents, [pocket(['o', 'a', 'b'])]);
    const bad = plungesIntoMaterial(parsed.motions).filter((p) => p.clearance > TOOL_R);
    expect(bad).toEqual([]);
  });

  it('plunges only into material already cut at that depth (square island)', () => {
    const ents = [poly('o', box(0, 0, 60, 40)), poly('i', box(5, 3, 10, 10))];
    const { parsed } = run(ents, [pocket(['o', 'i'])]);
    const bad = plungesIntoMaterial(parsed.motions).filter((p) => p.clearance > TOOL_R);
    expect(bad).toEqual([]);
  });

  // With a stepover above 50 % the next ring is more than a tool radius from
  // the last one, so nearCut() rejects every feed link and each ring becomes
  // lift, rapid and plunge into solid material, 2.1 mm from the last cut.
  it('links rings with a feed at stepover 0.7 instead of plunging for each ring', () => {
    const { parsed } = run([rect('r')], [{ ...pocket(['r']), stepover: 0.7 } as CamOperation]);
    const bad = plungesIntoMaterial(parsed.motions).filter((p) => p.clearance > TOOL_R);
    expect(bad).toEqual([]);
  });
});

// ── 3. Valid profiles refused ──

describe('review 3: a notch no wider than the tool', () => {
  // A 30 × 20 plate with a semicircular notch (or bump) of radius rr in the
  // middle of one long edge. The tool can't follow it, but it can cut past it
  // without touching the part. Today the collapsed arc leaves two collinear
  // offset lines, intersect() returns null and the job is refused:
  //   "two edges of the shape can't be joined at this tool size".
  const notched = (rr: number, bulge: number) =>
    poly('n', [{ x: 0, y: 0 }, { x: 15 - rr, y: 0 }, { x: 15 + rr, y: 0 }, { x: 30, y: 0 }, { x: 30, y: 20 }, { x: 0, y: 20 }], [0, bulge]);

  it.each([1, 1.5, 2])('cuts outside past a notch of radius %s mm', (rr) => {
    const res = runRaw([notched(rr, -1)], [profile(['n'], 'outside')]);
    expect(res.issues.filter((i) => i.severity === 'error').map((i) => i.message)).toEqual([]);
  });

  it.each([1, 1.5, 2])('cuts inside past a bump of radius %s mm', (rr) => {
    const res = runRaw([notched(rr, 1)], [profile(['n'], 'inside')]);
    expect(res.issues.filter((i) => i.severity === 'error').map((i) => i.message)).toEqual([]);
  });

  // A notch between one and two tool radii: the offset arc is too small to meet
  // the offset edges either side of it, so it's left out and the tool cuts past.
  it.each([
    [1, -1, 'outside'],
    [2, -1, 'outside'],
    [2, 1, 'inside'],
  ] as const)('stays a tool radius clear of the part past a notch of radius %s (bulge %s, %s)', (rr, bulge, side) => {
    const { parsed } = run([notched(rr, bulge)], [profile(['n'], side)]);
    const pts = [{ x: 0, y: 0 }, { x: 15 - rr, y: 0 }, { x: 15 + rr, y: 0 }, { x: 30, y: 0 }, { x: 30, y: 20 }, { x: 0, y: 20 }];
    const walls = outline(pts, [0, bulge]);
    const samples = cutSamples(parsed.motions, { below: 0 });
    expect(Math.min(...samples.map((s) => distTo(walls, s.p)))).toBeGreaterThan(TOOL_R - 1e-3);
    expect(samples.every((s) => insideOf(walls, s.p) === (side === 'inside'))).toBe(true);
  });
});

// ── 4. Tabs on corners ──

describe('review 4: tab bridges', () => {
  // Tabs are spaced by path length from the path start with no regard for
  // corners. On a 40 × 20 rectangle with 3 tabs, two land on corners and the
  // material left across the corner is ~3.1 mm instead of the 5 mm asked for.
  it('leaves at least the tab width of material at every tab (40 × 20 outside, 3 tabs)', () => {
    const op = { ...profile(['r'], 'outside'), tabs: true, tabCount: 3, tabWidth: 5, tabHeight: 1 } as CamOperation;
    const { parsed } = run([rect('r')], [op]);
    const thin = tabBridges(parsed.motions, -3).filter((t) => t.bridge < 5 - 0.05);
    expect(thin).toEqual([]);
  });

  it('PINNED (passes): a straight-edge tab leaves exactly the tab width (40 × 20 outside, 6 tabs)', () => {
    const op = { ...profile(['r'], 'outside'), tabs: true, tabCount: 6, tabWidth: 5, tabHeight: 1 } as CamOperation;
    const { parsed } = run([rect('r')], [op]);
    for (const t of tabBridges(parsed.motions, -3)) expect(t.bridge).toBeCloseTo(5, 2);
  });
});

// ── 5. Nested loops in one profile ──

describe('review 5: a washer as one outside profile', () => {
  // Fixed: both loops used to be offset to their own outside, so the 5 mm hole
  // was cut with the tool centre at radius 6.5 and came out at radius 8. A loop
  // inside another is now a hole of the same part and is cut on its inside.
  it('cuts the inner hole on its inside (the hole stays r5)', () => {
    const { parsed } = run([circle('a', 0, 0, 20), circle('b', 0, 0, 5)], [profile(['a', 'b'], 'outside')]);
    const radii = new Set(cutSamples(parsed.motions, { z: -3 }).map((s) => Math.hypot(s.p.x, s.p.y).toFixed(2)));
    expect([...radii].sort()).toEqual(['21.50', '3.50']);
  });

  it('cuts a part inside the hole on its outside again (three nested loops)', () => {
    const ents = [circle('a', 0, 0, 20), circle('b', 0, 0, 10), circle('c', 0, 0, 4)];
    const { parsed } = run(ents, [profile(['a', 'b', 'c'], 'outside')]);
    const radii = new Set(cutSamples(parsed.motions, { z: -3 }).map((s) => Math.hypot(s.p.x, s.p.y).toFixed(2)));
    expect([...radii].sort()).toEqual(['21.50', '5.50', '8.50']);
  });

  // When the outer loop is cut through first, the part is loose before its
  // hole is cut (standard practice is inner features first).
  it('cuts the hole before the outside on a through cut', () => {
    const { parsed } = run([circle('a', 0, 0, 20), circle('b', 0, 0, 5)], [profile(['a', 'b'], 'outside')]);
    const deep = parsed.motions.filter((m) => m.g !== 0 && near(m.to.z, -3) && movesXY(m));
    const outerLast = Math.max(...deep.filter((m) => Math.hypot(m.to.x, m.to.y) > 15).map((m) => m.line));
    const innerLast = Math.max(...deep.filter((m) => Math.hypot(m.to.x, m.to.y) < 15).map((m) => m.line));
    expect(innerLast).toBeLessThan(outerLast);
  });
});
