const MAX_LAG_MS = 2000;

interface Lag {
  lag: number;
  jitter: number;
}

/** `?lag=MS&jitter=MS` adds MS to the round trip, plus up to `jitter` each way, so high ping can be felt on purpose. */
function lagFromQuery(search: string): Lag | null {
  const params = new URLSearchParams(search);
  const ms = (key: string): number => {
    const n = Number(params.get(key) ?? 0);
    return Number.isFinite(n) ? Math.min(MAX_LAG_MS, Math.max(0, n)) : 0;
  };
  const lag = ms('lag');
  const jitter = ms('jitter');
  return lag > 0 || jitter > 0 ? { lag, jitter } : null;
}

/** Read once at load, because creating or joining a party replaces the URL. */
const SIM = lagFromQuery(location.search);

/**
 * Runs each job half the lag plus some jitter later. An ordered line never runs a job before an earlier one, as on one
 * TCP stream or a reliable channel. An unordered one lets jitter reorder them, as UDP does.
 */
export class DelayLine {
  private queue: { at: number; run: () => void }[] = [];
  private last = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private sim: Lag,
    private ordered: boolean,
  ) {}

  push(run: () => void): void {
    let at = performance.now() + this.sim.lag / 2 + Math.random() * this.sim.jitter;
    if (this.ordered) at = this.last = Math.max(this.last, at);
    const i = this.queue.findLastIndex((job) => job.at <= at) + 1;
    this.queue.splice(i, 0, { at, run });
    if (i > 0 && this.timer) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = this.arm();
  }

  clear(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.queue = [];
  }

  private arm(): ReturnType<typeof setTimeout> {
    return setTimeout(this.flush, Math.max(0, Math.ceil(this.queue[0].at - performance.now())));
  }

  private flush = (): void => {
    const now = performance.now();
    // The timer was set for the first job, so that one runs even if the clock reads a hair early.
    let n = 1;
    while (n < this.queue.length && this.queue[n].at <= now) n++;
    const due = this.queue.splice(0, n);
    this.timer = this.queue.length ? this.arm() : null;
    for (const job of due) job.run();
  };
}

/** A line for `?lag` and `?jitter`, or null when they are off, so everything passes straight through. */
export const delayLine = (ordered: boolean): DelayLine | null => SIM && new DelayLine(SIM, ordered);

export const after = (line: DelayLine | null, job: () => void): void => (line ? line.push(job) : job());
