/**
 * Tests on the G-code itself: each job is generated, the G-code is parsed back
 * into motions, and the assertions are about what a machine would do, not about
 * internal toolpath objects. Shapes are in sketch coordinates (Y down); the
 * G-code has Y flipped (Y up).
 */
import { describe, it, expect } from 'vitest';
import type { Entity } from '@/types/document';
import type { CamJobConfig, CamOperation, OperationCuttingParams, ToolpathMove } from '@/types/cam';
import { createDefaultCutting, createDefaultJobConfig } from '@/types/cam';
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

// ── Jobs ──

const cutting = (over: Partial<OperationCuttingParams> = {}): OperationCuttingParams => ({ ...createDefaultCutting(), ...over });
const tool6 = { id: 't6', name: '6mm Flat End Mill', diameter: 6, type: 'flat' as const, fluteCount: 2, fluteLength: 20 };

const profile = (ids: string[], cutSide: 'inside' | 'outside' | 'on', c = cutting()): CamOperation =>
  ({ kind: 'profile', sketchId: 's', entityIds: ids, cutSide, tabs: false, tabWidth: 5, tabHeight: 1, cutting: c });
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
const known = (p: Pos) => !Number.isNaN(p.x) && !Number.isNaN(p.y);
const movesXY = (m: Motion) => known(m.from) && (!near(m.from.x, m.to.x) || !near(m.from.y, m.to.y));

const ALL_JOBS: [string, Entity[], CamOperation[]][] = [
  ['profile outside', [rect('r')], [profile(['r'], 'outside')]],
  ['profile inside, rounded', [rect('r', 40, 20, 5)], [profile(['r'], 'inside')]],
  ['profile on a circle', [circle('c', 0, 0, 10)], [profile(['c'], 'on')]],
  ['pocket', [rect('r')], [pocket(['r'])]],
  ['facing', [rect('r')], [facing(['r'])]],
  ['peck drill', [circle('h1', 0, 0, 1.5), circle('h2', 20, 0, 1.5)], [drill(['h1', 'h2'], 1, 0)]],
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
    const atDepth = motions.filter((m) => m.g === 1 && near(m.from.z, -3) && near(m.to.z, -3));
    const length = atDepth.reduce((s, m) => s + Math.hypot(m.to.x - m.from.x, m.to.y - m.from.y), 0);
    expect(length).toBeCloseTo(2 * (43 + 23), 3);
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

  it.each([['outside', -0.5], ['inside', -0.5], ['outside', 0.5]] as const)(
    'are refused for %s cuts rather than gouged (bulge %s)', (side, bulge) => {
      const config = createDefaultJobConfig();
      config.operations = [profile(['a'], side)];
      const result = generateGcode(config, [arcTop(bulge)]);
      expect(result.gcode).toBe('');
      expect(result.issues.some((i) => i.severity === 'error' && /sharp corner/.test(i.message))).toBe(true);
    });

  it('are refused even when hidden behind a repeated point', () => {
    const D = {
      id: 'd', type: 'line', closed: true,
      points: [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 0 }, { x: 0, y: 0 }],
      bulge: [0, 0, 1, 0],
    } as Entity;
    for (const side of ['outside', 'inside'] as const) {
      const config = createDefaultJobConfig();
      config.operations = [profile(['d'], side)];
      const result = generateGcode(config, [D]);
      expect(result.gcode).toBe('');
      expect(result.issues.some((i) => i.severity === 'error' && /sharp corner/.test(i.message))).toBe(true);
    }
  });

  it('are fine when cut on the line', () => {
    const { motions } = run([arcTop(-0.5)], [profile(['a'], 'on')]).parsed;
    expect(motions.some((m) => m.g === 2 || m.g === 3)).toBe(true);
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

describe('pocket in an L shape', () => {
  // Sketch outline (Y down); in G-code Y is negated.
  const outline = [{ x: 0, y: 0 }, { x: 60, y: 0 }, { x: 60, y: 15 }, { x: 15, y: 15 }, { x: 15, y: 60 }, { x: 0, y: 60 }];
  const L = { id: 'L', type: 'line', closed: true, points: outline } as Entity;
  const machine = outline.map((p) => ({ x: p.x, y: -p.y }));

  const inside = (p: { x: number; y: number }) => {
    let c = false;
    for (let i = 0, j = machine.length - 1; i < machine.length; j = i++) {
      const a = machine[i]!, b = machine[j]!;
      if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) c = !c;
    }
    return c;
  };
  const distToWall = (p: { x: number; y: number }) => Math.min(...machine.map((a, i) => {
    const b = machine[(i + 1) % machine.length]!;
    const dx = b.x - a.x, dy = b.y - a.y;
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy)));
    return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
  }));

  it.each(['climb', 'conventional'] as const)('keeps the tool inside the wall (%s)', (dir) => {
    const op = { ...pocket(['L']), cutDirection: dir } as CamOperation;
    const { motions } = run([L], [op]).parsed;
    for (const m of motions.filter((mm) => mm.g !== 0 && mm.to.z < 0)) {
      // Sample along each cutting move, not just its end points.
      for (let k = 0; k <= 10; k++) {
        const p = { x: m.from.x + (m.to.x - m.from.x) * k / 10, y: m.from.y + (m.to.y - m.from.y) * k / 10 };
        expect(inside(p), `line ${m.line}`).toBe(true);
        expect(distToWall(p), `line ${m.line}`).toBeGreaterThanOrEqual(1.5 - 1e-3);
      }
    }
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

  it('refuses the unfinished "linearize" arc output', () => {
    const c = createDefaultJobConfig();
    c.postProcessor = { ...c.postProcessor, arcOutput: 'linearize' };
    expect(validateCamJob(c, [], []).some((i) => i.severity === 'error' && /linearize/.test(i.message))).toBe(true);
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
