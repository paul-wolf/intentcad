import { describe, it, expect, beforeEach } from 'vitest';
import { useCamStore } from '@/stores/camStore';
import { createDefaultJobConfig, type ToolpathMove } from '@/types/cam';

const path: ToolpathMove[] = [
  { kind: 'dwell', to: { x: 0, y: 0 }, z: 5, seconds: 2 },
  { kind: 'rapid', to: { x: 10, y: 0 }, z: 5 },
];

/** Play for `seconds` of wall-clock time in 50 ms ticks. */
function playFor(seconds: number) {
  for (let t = 0; t < Math.round(seconds * 20); t++) useCamStore.getState().simTick(50);
}

describe('simulator', () => {
  beforeEach(() => {
    useCamStore.setState({ jobConfig: createDefaultJobConfig(), toolpath: path, simState: 'idle', simSpeed: 1 });
    useCamStore.getState().simPlay();
  });

  it('waits out a dwell before the next move', () => {
    playFor(1.9);
    expect(useCamStore.getState().simMoveIndex).toBe(0);
    playFor(0.2);
    expect(useCamStore.getState().simMoveIndex).toBe(1);
  });

  it('shortens the dwell with the playback speed', () => {
    useCamStore.setState({ simSpeed: 4 });
    playFor(0.45);
    expect(useCamStore.getState().simMoveIndex).toBe(0);
    playFor(0.1);
    expect(useCamStore.getState().simMoveIndex).toBe(1);
  });

  it('starts at safe Z above the stock top', () => {
    useCamStore.getState().simStop();
    const config = createDefaultJobConfig();
    config.stock.zTop = 10;
    useCamStore.setState({ jobConfig: config });
    useCamStore.getState().simPlay();
    expect(useCamStore.getState().simZ).toBe(15);
  });
});
