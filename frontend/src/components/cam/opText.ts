import type { ResolvedOp } from '@/cam/resolve';
import { computePassDepths } from '@/cam/depthPasses';

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
