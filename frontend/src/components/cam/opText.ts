import type { Entity } from '@/types/document';
import type { ResolvedOp } from '@/cam/resolve';
import type { PlanOperation } from '@/cam/setup';
import { computePassDepths } from '@/cam/depthPasses';
import { entityToSegments } from '@/cam/entityToSegments';
import { groupContours } from '@/cam/contours';

const fmt = (v: number) => String(Number(v.toFixed(2)));

/** "Outside profile", "Pocket", "Drill 4 holes"… */
export function opTitle(r: ResolvedOp): string {
  const op = r.op;
  const n = op.entityIds.length;
  switch (op.kind) {
    case 'profile': return `${op.cutSide === 'outside' ? 'Outside' : op.cutSide === 'inside' ? 'Inside' : 'On-line'} profile`;
    case 'pocket': return 'Pocket';
    case 'drill': return `${r.fields.holeMethod.value === 'helix' ? 'Helix' : 'Drill'} ${n} hole${n === 1 ? '' : 's'}`;
    case 'facing': return 'Face the stock';
  }
}

/**
 * What an operation cuts, counted the way the toolpath sees it: lines that
 * meet end to end are one outline ("1 outline (16 lines)"). "" for holes and
 * facing, whose title says it.
 */
export function shapesText(op: PlanOperation, entities: Entity[]): string {
  if (op.kind === 'drill' || op.kind === 'facing') return '';
  const n = op.entityIds.length;
  const outlines = groupContours(entityToSegments(entities, op.entityIds)).length;
  if (outlines === 0 || outlines >= n) return `${n} shape${n === 1 ? '' : 's'}`;
  const ids = new Set(op.entityIds);
  const allLines = entities.filter((e) => ids.has(e.id)).every((e) => e.type === 'line');
  return `${outlines} outline${outlines === 1 ? '' : 's'} (${n} ${allLines ? 'lines' : 'shapes'})`;
}

export function passDepths(r: ResolvedOp): number[] {
  const f = r.fields;
  return computePassDepths(f.depth.value, f.depthPerPass.value, f.lastPassDepth.value);
}

/** One line: how deep, in how many passes, how fast. */
export function opSummary(r: ResolvedOp): string {
  const f = r.fields;
  const parts: string[] = [];
  const passes = r.op.kind === 'drill' && f.holeMethod.value === 'drill' ? null : passDepths(r).length;
  parts.push(`${fmt(f.depth.value)} mm deep${passes ? ` in ${passes} pass${passes === 1 ? '' : 'es'}` : ''}`);
  if (r.dial) parts.push(`dial ${r.dial.setting} (${r.rpm} rpm)`);
  else parts.push(`${r.rpm} rpm`);
  parts.push(`${Math.round(r.feed)} mm/min`);
  if (r.op.kind === 'profile' && f.tabs.value) parts.push(`${f.tabCount.value} tabs`);
  if (r.op.kind === 'profile' && f.entry.value === 'ramp') parts.push(`ramps in at ${fmt(f.rampAngle.value)}°`);
  return parts.join(' · ');
}
