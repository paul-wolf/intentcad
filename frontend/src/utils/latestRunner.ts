/**
 * Runs previews for a value that keeps changing (a dragged slider): one run
 * at a time, no more often than `minInterval`, always for the latest value.
 * A result for a value that has since moved on is dropped, and the run for
 * the latest value goes next. `pause` > 0 waits until the value has stopped
 * changing that long (a part rebuild); `submit(v, true)` runs at once (the
 * slider was released, Enter was pressed).
 */
export interface LatestRunnerOptions<A> {
  /** at least this many ms between run starts (default 0) */
  minInterval?: number;
  /** wait until the value has been still this long (default 0: run live) */
  pause?: number;
  /** two values are the same run when their keys match (default JSON) */
  key?: (a: A) => string;
  /** told when a run starts and when nothing is left to run */
  onBusy?: (busy: boolean) => void;
}

export class LatestRunner<A, R> {
  private latest: A | undefined;
  private has = false;
  private running = false;
  private lastStart = -Infinity;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private generation = 0;
  private readonly key: (a: A) => string;

  constructor(
    private readonly run: (a: A) => Promise<R>,
    private readonly deliver: (a: A, r: R) => void,
    private readonly opts: LatestRunnerOptions<A> = {},
  ) {
    this.key = opts.key ?? ((a) => JSON.stringify(a));
  }

  submit(a: A, now = false): void {
    this.latest = a;
    this.has = true;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.running) return;          // it goes next, when the run in flight ends
    this.schedule(now ? 0 : (this.opts.pause ?? 0));
  }

  /** Forget the value and any run in flight (its result is dropped). */
  cancel(): void {
    this.generation++;
    this.has = false;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.running) { this.running = false; this.opts.onBusy?.(false); }
  }

  private schedule(pause: number): void {
    const wait = Math.max(pause, this.lastStart + (this.opts.minInterval ?? 0) - Date.now());
    if (wait <= 0) { void this.start(); return; }
    this.timer = setTimeout(() => { this.timer = null; void this.start(); }, wait);
  }

  private async start(): Promise<void> {
    if (!this.has || this.running) return;
    const a = this.latest as A;
    const gen = this.generation;
    this.has = false;
    this.running = true;
    this.lastStart = Date.now();
    this.opts.onBusy?.(true);
    let result: R | undefined;
    let ok = false;
    try {
      result = await this.run(a);
      ok = true;
    } catch { /* a failed preview shows nothing new */ }
    if (gen !== this.generation) return;      // cancelled meanwhile
    this.running = false;
    const moved = this.has && this.key(this.latest as A) !== this.key(a);
    if (ok && !moved) this.deliver(a, result as R);
    if (this.has && moved) this.schedule(0);
    else { this.has = false; this.opts.onBusy?.(false); }
  }
}
