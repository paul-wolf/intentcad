import type { Entity, Point } from '@/types/document';
import { generateId } from '@/utils/id';

// ── DXF parser types ──

interface DxfEntity {
  type: string;
  groups: [number, string][];
}

// ── Low-level DXF parsing ──

/** Parse ASCII DXF group-code/value pairs. */
function parsePairs(text: string): [number, string][] {
  const lines = text.split(/\r?\n/);
  const pairs: [number, string][] = [];
  let i = 0;
  while (i + 1 < lines.length) {
    const code = parseInt(lines[i]!.trim(), 10);
    const value = lines[i + 1]!.trim();
    if (isNaN(code)) { i++; continue; }
    pairs.push([code, value]);
    i += 2;
  }
  return pairs;
}

/** Extract entities from the ENTITIES section. */
function extractEntities(pairs: [number, string][]): DxfEntity[] {
  // Find ENTITIES section
  let start = -1;
  for (let i = 0; i < pairs.length; i++) {
    if (pairs[i]![0] === 2 && pairs[i]![1] === 'ENTITIES') {
      start = i + 1;
      break;
    }
  }
  if (start < 0) return [];

  const entities: DxfEntity[] = [];
  let current: DxfEntity | null = null;

  for (let i = start; i < pairs.length; i++) {
    const [code, value] = pairs[i]!;
    if (code === 0) {
      if (value === 'ENDSEC') break;
      if (current) entities.push(current);
      current = { type: value, groups: [] };
    } else if (current) {
      current.groups.push([code, value]);
    }
  }
  if (current) entities.push(current);
  return entities;
}

// ── Helpers ──

function getFloat(groups: [number, string][], code: number, occurrence = 0): number {
  let count = 0;
  for (const [c, v] of groups) {
    if (c === code) {
      if (count === occurrence) return parseFloat(v);
      count++;
    }
  }
  return 0;
}

function getAllFloats(groups: [number, string][], code: number): number[] {
  return groups.filter(([c]) => c === code).map(([, v]) => parseFloat(v));
}

function getInt(groups: [number, string][], code: number): number {
  for (const [c, v] of groups) {
    if (c === code) return parseInt(v, 10);
  }
  return 0;
}

// ── Entity converters ──

/** DXF uses Y-up (math convention), our editor uses Y-down (screen convention). */
function dxfY(y: number): number { return -y; }

function convertLine(e: DxfEntity): Entity {
  const x1 = getFloat(e.groups, 10);
  const y1 = getFloat(e.groups, 20);
  const x2 = getFloat(e.groups, 11);
  const y2 = getFloat(e.groups, 21);
  return {
    id: generateId('ln'),
    type: 'line',
    points: [{ x: x1, y: dxfY(y1) }, { x: x2, y: dxfY(y2) }],
  };
}

function convertCircle(e: DxfEntity): Entity {
  return {
    id: generateId('cir'),
    type: 'circle',
    center: { x: getFloat(e.groups, 10), y: dxfY(getFloat(e.groups, 20)) },
    radius: getFloat(e.groups, 40),
  };
}

function convertArc(e: DxfEntity): Entity {
  const cx = getFloat(e.groups, 10);
  const cy = getFloat(e.groups, 20);
  const r = getFloat(e.groups, 40);
  const startDeg = getFloat(e.groups, 50);
  const endDeg = getFloat(e.groups, 51);

  // Convert DXF arc (center, radius, start/end angles in degrees CCW from +X)
  // to a 2-point line with bulge. Negate angles to flip from Y-up to Y-down.
  const sa = -(startDeg * Math.PI / 180);
  const ea = -(endDeg * Math.PI / 180);

  const p1: Point = { x: cx + r * Math.cos(sa), y: dxfY(cy) + r * Math.sin(sa) };
  const p2: Point = { x: cx + r * Math.cos(ea), y: dxfY(cy) + r * Math.sin(ea) };

  // Included angle — in Y-down space, CW becomes the positive arc direction
  let theta = ea - sa;
  if (theta >= 0) theta -= 2 * Math.PI;

  // bulge = tan(theta/4), negative = CW in Y-down space
  const bulge = Math.tan(theta / 4);

  return {
    id: generateId('ln'),
    type: 'line',
    points: [p1, p2],
    bulge: [bulge, 0],
  };
}

function convertLwpolyline(e: DxfEntity): Entity {
  const xs = getAllFloats(e.groups, 10);
  const ys = getAllFloats(e.groups, 20);
  const closed = (getInt(e.groups, 70) & 1) !== 0;

  const points: Point[] = [];
  const bulgeArr: number[] = [];

  // DXF bulge values appear per-vertex but only for vertices that have them.
  // We need to map them by occurrence order, filling missing with 0.
  // Build a map: for each vertex index, check if there's a bulge group after
  // its 10/20 group but before the next 10 group.
  let vertexIdx = 0;
  const bulgeMap = new Map<number, number>();
  let lastVertexSeen = -1;
  for (const [code, value] of e.groups) {
    if (code === 10) {
      lastVertexSeen = vertexIdx;
      vertexIdx++;
    } else if (code === 42) {
      if (lastVertexSeen >= 0) {
        bulgeMap.set(lastVertexSeen, parseFloat(value));
      }
    }
  }

  for (let i = 0; i < xs.length; i++) {
    points.push({ x: xs[i]!, y: dxfY(ys[i]!) });
    // Negate bulge: DXF bulge is CCW-positive (Y-up), we need CW-positive (Y-down)
    bulgeArr.push(-(bulgeMap.get(i) ?? 0));
  }

  return {
    id: generateId('ln'),
    type: 'line',
    points,
    bulge: bulgeArr,
    closed,
  };
}

function convertPoint(e: DxfEntity): Entity {
  return {
    id: generateId('pt'),
    type: 'point',
    position: { x: getFloat(e.groups, 10), y: dxfY(getFloat(e.groups, 20)) },
  };
}

function convertText(e: DxfEntity): Entity {
  const x = getFloat(e.groups, 10);
  const y = getFloat(e.groups, 20);
  const height = getFloat(e.groups, 40);
  const rotation = getFloat(e.groups, 50);
  // Group code 1 holds the text string
  const textValue = e.groups.find(([c]) => c === 1)?.[1] ?? '';
  return {
    id: generateId('txt'),
    type: 'text',
    position: { x, y: dxfY(y) },
    text: textValue,
    height: height || 2.5,
    rotation: rotation || undefined,
  };
}

function convertMtext(e: DxfEntity): Entity {
  const x = getFloat(e.groups, 10);
  const y = getFloat(e.groups, 20);
  const height = getFloat(e.groups, 40);
  const rotation = getFloat(e.groups, 50);
  // MTEXT content can span multiple group-1 entries and contain formatting codes
  let textValue = '';
  for (const [c, v] of e.groups) {
    if (c === 1 || c === 3) textValue += v; // 3 = additional text chunks
  }
  // Strip MTEXT formatting codes like {\fArial|...;text}
  textValue = textValue.replace(/\\[A-Za-z][^;]*;/g, '').replace(/[{}]/g, '').replace(/\\P/g, '\n').trim();
  return {
    id: generateId('txt'),
    type: 'text',
    position: { x, y: dxfY(y) },
    text: textValue,
    height: height || 2.5,
    rotation: rotation || undefined,
  };
}

// ── Spline → Bezier conversion ──
// DXF degree-3 splines with N control points → (N-1)/3 cubic bezier segments
// using knot insertion / de Boor decomposition into Bezier spans.

function convertSpline(e: DxfEntity): Entity[] {
  const degree = getInt(e.groups, 71);
  if (degree !== 3) return []; // Only handle cubic

  const nCtrl = getInt(e.groups, 73);
  const knots = getAllFloats(e.groups, 40);

  // Control points use group code 10/20/30
  const xs = getAllFloats(e.groups, 10);
  const ys = getAllFloats(e.groups, 20);

  // The DXF may also have fit points (code 11/21/31). We use control points.
  if (xs.length < 4 || knots.length < nCtrl + 4) return [];

  const ctrlPts: Point[] = [];
  for (let i = 0; i < nCtrl; i++) {
    ctrlPts.push({ x: xs[i]!, y: dxfY(ys[i]!) });
  }

  // Decompose cubic B-spline into Bezier segments via knot insertion.
  const bezierPts = bsplineToBezierPoints(degree, knots.slice(0, nCtrl + degree + 1), ctrlPts);

  const entities: Entity[] = [];
  for (let i = 0; i + 3 < bezierPts.length; i += 3) {
    entities.push({
      id: generateId('bez'),
      type: 'bezier',
      controlPoints: [bezierPts[i]!, bezierPts[i + 1]!, bezierPts[i + 2]!, bezierPts[i + 3]!],
    });
  }
  return entities;
}

/** Convert a clamped cubic B-spline to Bezier control points via Boehm knot insertion. */
function bsplineToBezierPoints(degree: number, knots: number[], ctrlPts: Point[]): Point[] {
  // Work on a mutable copy
  let K = [...knots];
  let P = ctrlPts.map((p) => ({ x: p.x, y: p.y }));
  const order = degree + 1;

  // Collect unique internal knots and their multiplicities
  const eps = 1e-10;
  const internalKnots: { value: number; mult: number }[] = [];
  for (let i = order; i < K.length - order; i++) {
    const v = K[i]!;
    if (internalKnots.length === 0 || Math.abs(v - internalKnots[internalKnots.length - 1]!.value) > eps) {
      internalKnots.push({ value: v, mult: 1 });
    } else {
      internalKnots[internalKnots.length - 1]!.mult++;
    }
  }

  // Insert each internal knot until it has multiplicity = degree
  for (const ik of internalKnots) {
    while (ik.mult < degree) {
      const result = insertKnot(degree, K, P, ik.value);
      K = result.knots;
      P = result.points;
      ik.mult++;
    }
  }

  return P;
}

/** Insert a single knot value into a B-spline (Boehm's algorithm). */
function insertKnot(
  degree: number,
  knots: number[],
  points: Point[],
  t: number,
): { knots: number[]; points: Point[] } {
  const n = points.length;
  // Find knot span: largest k such that knots[k] <= t < knots[k+1]
  let k = -1;
  for (let i = 0; i < knots.length - 1; i++) {
    if (knots[i]! <= t + 1e-10 && t < knots[i + 1]! + 1e-10) {
      k = i;
    }
  }
  if (k < 0) k = knots.length - 2;

  const newKnots = [...knots.slice(0, k + 1), t, ...knots.slice(k + 1)];
  const newPoints: Point[] = [];

  for (let i = 0; i <= n; i++) {
    if (i <= k - degree) {
      newPoints.push(points[i]!);
    } else if (i > k) {
      newPoints.push(points[i - 1]!);
    } else {
      const denom = knots[i + degree]! - knots[i]!;
      const alpha = denom < 1e-10 ? 0 : (t - knots[i]!) / denom;
      newPoints.push({
        x: (1 - alpha) * points[i - 1]!.x + alpha * points[i]!.x,
        y: (1 - alpha) * points[i - 1]!.y + alpha * points[i]!.y,
      });
    }
  }

  return { knots: newKnots, points: newPoints };
}

// ── Main import function ──

export interface DxfImportResult {
  entities: Entity[];
  skipped: number;
  skippedTypes: string[];
}

export function importDxf(text: string): DxfImportResult {
  const pairs = parsePairs(text);
  const dxfEntities = extractEntities(pairs);

  const entities: Entity[] = [];
  let skipped = 0;
  const skippedTypes = new Set<string>();

  for (const e of dxfEntities) {
    switch (e.type) {
      case 'LINE':
        entities.push(convertLine(e));
        break;
      case 'CIRCLE':
        entities.push(convertCircle(e));
        break;
      case 'ARC':
        entities.push(convertArc(e));
        break;
      case 'LWPOLYLINE':
        entities.push(convertLwpolyline(e));
        break;
      case 'POINT':
        entities.push(convertPoint(e));
        break;
      case 'TEXT':
        entities.push(convertText(e));
        break;
      case 'MTEXT':
        entities.push(convertMtext(e));
        break;
      case 'SPLINE': {
        const beziers = convertSpline(e);
        if (beziers.length > 0) {
          entities.push(...beziers);
        } else {
          skipped++;
          skippedTypes.add('SPLINE (non-cubic)');
        }
        break;
      }
      default:
        skipped++;
        skippedTypes.add(e.type);
        break;
    }
  }

  return { entities, skipped, skippedTypes: [...skippedTypes] };
}
