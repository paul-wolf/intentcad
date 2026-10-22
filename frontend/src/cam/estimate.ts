import type { Point } from '@/types/document';
import type { ToolpathMove } from '@/types/cam';
import { moveLength } from './simulatorInterp';

/**
 * Roughly how long the toolpath takes: cutting moves at their feed, rapids at
 * the machine's rapid rate, dwells as written. Acceleration is ignored, so
 * real runs take longer on short moves.
 */
export function estimateSeconds(moves: ToolpathMove[], start: Point, startZ: number, rapidRate: number): number {
  let from = start;
  let z = startZ;
  let seconds = 0;
  for (const m of moves) {
    if (m.kind === 'dwell') {
      seconds += m.seconds;
    } else {
      const len = moveLength(from, m, z);
      const rate = m.kind === 'rapid' ? rapidRate : m.feed > 0 ? m.feed : rapidRate;
      if (rate > 0) seconds += (len / rate) * 60;
    }
    from = m.to;
    z = m.z;
  }
  return seconds;
}

export function formatDuration(seconds: number): string {
  if (!(seconds > 0)) return '0 min';
  if (seconds < 60) return '<1 min';
  const min = Math.round(seconds / 60);
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)} h ${min % 60} min`;
}

/** Where the operations' moves are in the toolpath, by plan operation id. */
export interface OpRange { opId: string; start: number; end: number }
