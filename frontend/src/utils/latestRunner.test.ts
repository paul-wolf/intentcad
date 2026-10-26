import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LatestRunner } from './latestRunner';

function deferred<T>() {
  let resolve!: (v: T) => void;
  const p = new Promise<T>((r) => { resolve = r; });
  return { p, resolve };
}

describe('LatestRunner', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('runs one at a time, drops results the value has left, and runs the latest next', async () => {
    const runs: number[] = [];
    const pending: Array<ReturnType<typeof deferred<string>>> = [];
    const got: Array<[number, string]> = [];
    const r = new LatestRunner<number, string>(
      (v) => { runs.push(v); const d = deferred<string>(); pending.push(d); return d.p; },
      (v, res) => got.push([v, res]),
    );
    r.submit(1);
    r.submit(2);
    r.submit(3);
    expect(runs).toEqual([1]);
    pending[0]!.resolve('one');
    await vi.runAllTimersAsync();
    expect(got).toEqual([]);             // 1's result: the slider is at 3 now
    expect(runs).toEqual([1, 3]);
    pending[1]!.resolve('three');
    await vi.runAllTimersAsync();
    expect(got).toEqual([[3, 'three']]);
  });

  it('waits for a pause, unless asked to run now', async () => {
    const runs: number[] = [];
    const r = new LatestRunner<number, number>(async (v) => { runs.push(v); return v; }, () => {}, { pause: 300 });
    r.submit(1);
    await vi.advanceTimersByTimeAsync(200);
    r.submit(2);
    await vi.advanceTimersByTimeAsync(200);
    expect(runs).toEqual([]);
    await vi.advanceTimersByTimeAsync(150);
    expect(runs).toEqual([2]);
    r.submit(5, true);
    await vi.advanceTimersByTimeAsync(0);
    expect(runs).toEqual([2, 5]);
  });

  it('keeps runs apart by the minimum interval', async () => {
    const runs: number[] = [];
    const r = new LatestRunner<number, number>(async (v) => { runs.push(v); return v; }, () => {}, { minInterval: 125 });
    r.submit(1);
    await vi.advanceTimersByTimeAsync(10);
    r.submit(2);
    await vi.advanceTimersByTimeAsync(50);
    expect(runs).toEqual([1]);
    await vi.advanceTimersByTimeAsync(100);
    expect(runs).toEqual([1, 2]);
  });

  it('drops a run in flight on cancel', async () => {
    const got: number[] = [];
    const d = deferred<number>();
    const r = new LatestRunner<number, number>(() => d.p, (_v, res) => got.push(res));
    r.submit(1);
    r.cancel();
    d.resolve(1);
    await vi.runAllTimersAsync();
    expect(got).toEqual([]);
  });
});
