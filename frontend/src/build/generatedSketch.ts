/**
 * Drawing a generated sketch (types/generated.ts): which output an element
 * belongs to, its outline as an SVG path in screen coordinates, the bounds
 * to fit, and the words the editor shows about outputs and checks.
 */
import type { Entity as SketchEntity } from '@/types/document';
import type { GenAnnotations, GenCheck, GenOutput } from '@/types/generated';
import type { UsedByPart } from '@/api/client';

/** The output a generated element belongs to: its id is "g:<output>:<n>". */
export function outputOf(entityId: string): string | null {
  const m = /^g:(.+):\d+$/.exec(entityId);
  return m ? m[1]! : null;
}

export interface View {
  /** the sketch point at the middle of the drawing */
  cx: number;
  cy: number;
  /** screen pixels per mm */
  scale: number;
  width: number;
  height: number;
}

export const toScreen = (v: View, x: number, y: number): [number, number] =>
  [(x - v.cx) * v.scale + v.width / 2, (y - v.cy) * v.scale + v.height / 2];

export const toSketch = (v: View, sx: number, sy: number): [number, number] =>
  [(sx - v.width / 2) / v.scale + v.cx, (sy - v.height / 2) / v.scale + v.cy];

const n = (v: number) => Number(v.toFixed(2));

/** An SVG arc command from the current point to (x2, y2) for a bulge
 *  (utils/arcGeometry.ts: positive puts the arc's middle on the side of
 *  (dy, -dx); in y-down screen coordinates that's a clockwise sweep). */
function arcTo(x1: number, y1: number, x2: number, y2: number, bulge: number): string {
  const d = Math.hypot(x2 - x1, y2 - y1);
  if (!bulge || d < 1e-9) return `L${n(x2)} ${n(y2)}`;
  const r = (d * (1 + bulge * bulge)) / (4 * Math.abs(bulge));
  return `A${n(r)} ${n(r)} 0 ${Math.abs(bulge) > 1 ? 1 : 0} ${bulge > 0 ? 1 : 0} ${n(x2)} ${n(y2)}`;
}

/** A line entity's outline (with its bulged segments) as an SVG path in
 *  screen coordinates; '' for other entities. */
export function linePath(e: SketchEntity, v: View): string {
  if (e.type !== 'line' || e.points.length < 2) return '';
  const pts = e.points.map((p) => toScreen(v, p.x, p.y));
  const closed = !!(e as { closed?: boolean }).closed;
  const bulge = (e as { bulge?: number[] }).bulge ?? [];
  let d = `M${n(pts[0]![0])} ${n(pts[0]![1])}`;
  const segs = closed ? pts.length : pts.length - 1;
  for (let i = 0; i < segs; i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % pts.length]!;
    d += arcTo(a[0], a[1], b[0], b[1], bulge[i] ?? 0);
  }
  return closed ? `${d}Z` : d;
}

export interface Bounds { minX: number; minY: number; maxX: number; maxY: number }

/** What the drawing holds (elements and notes), for Fit. */
export function boundsOf(entities: SketchEntity[], notes?: GenAnnotations | null): Bounds | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const add = (x: number, y: number) => {
    minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
  };
  for (const e of entities) {
    if (e.type === 'circle') { add(e.center.x - e.radius, e.center.y - e.radius); add(e.center.x + e.radius, e.center.y + e.radius); }
    else if (e.type === 'line') e.points.forEach((p) => add(p.x, p.y));
    else if (e.type === 'point') add(e.position.x, e.position.y);
  }
  for (const l of notes?.labels ?? []) add(l.at[0], l.at[1]);
  for (const d of notes?.dims ?? []) { add(d.p1[0], d.p1[1]); add(d.p2[0], d.p2[1]); }
  return isFinite(minX) ? { minX, minY, maxX, maxY } : null;
}

/** The view that shows `b` in a width × height drawing with a margin. */
export function fitView(b: Bounds | null, width: number, height: number, margin = 48): View {
  if (!b) return { cx: 0, cy: 0, scale: 2, width, height };
  const w = Math.max(b.maxX - b.minX, 1);
  const h = Math.max(b.maxY - b.minY, 1);
  const scale = Math.max(0.01, Math.min((width - 2 * margin) / w, (height - 2 * margin) / h));
  return { cx: (b.minX + b.maxX) / 2, cy: (b.minY + b.maxY) / 2, scale, width, height };
}

/** The names of the parts that ask for an output, by .group("…") or .named("…"). */
export function partsUsing(users: UsedByPart[], output: string): string[] {
  return users.filter((p) => p.uses.some((u) => u.groups.includes(output) || u.names.includes(output))).map((p) => p.name);
}

/** The outputs a part asks for. */
export function outputsUsedBy(p: UsedByPart): string[] {
  return [...new Set(p.uses.flatMap((u) => [...u.groups, ...u.names]))];
}

/** "Top plate, Bottom plate and Arm brace" */
export function andList(names: string[]): string {
  return names.length < 2 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** "used by Top plate and Arm brace" / "not used by any part yet" */
export function usedWords(users: UsedByPart[], output: string): string {
  const parts = partsUsing(users, output);
  return parts.length ? `used by ${andList(parts)}` : 'not used by any part yet';
}

/** The hover note on the drawing: "brace_holes: 36 holes Ø3.2 (Top plate, Arm brace)" */
export function hoverWords(o: GenOutput, users: UsedByPart[]): string {
  const parts = partsUsing(users, o.name);
  return `${o.name}: ${o.size}${parts.length ? ` (${parts.join(', ')})` : ''}`;
}

/** "2 of 3 pass", "All 3 pass" */
export function checksWords(checks: GenCheck[]): string {
  const ok = checks.filter((c) => c.ok).length;
  if (ok === checks.length) return checks.length === 1 ? 'It passes' : `All ${checks.length} pass`;
  return `${ok} of ${checks.length} pass`;
}

/** The icon for an output's kind. */
export const OUTPUT_ICON: Record<GenOutput['kind'], string> = { shapes: '▭', holes: '○', points: '·', lines: '╱' };

/** "Parts keep using the last good drawing" in a trial: "Can't generate with
 *  brace_r_in = 20: (message). Parts keep the drawing for brace_r_in = 42." */
export function trialErrorWords(trial: Record<string, number>, saved: Record<string, number | string>, message: string): string {
  const fmt = (v: number | string) => (typeof v === 'number' ? String(Number(v.toFixed(4))) : v);
  const names = Object.keys(trial);
  const tried = names.map((k) => `${k} = ${fmt(trial[k]!)}`).join(', ');
  const kept = names.filter((k) => saved[k] !== undefined).map((k) => `${k} = ${fmt(saved[k]!)}`).join(', ');
  return `Can't generate with ${tried}: ${message}.${kept ? ` Parts keep the drawing for ${kept}.` : ''}`;
}
