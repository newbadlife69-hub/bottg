/**
 * Small async rate limiter: min interval between calls + priority queue +
 * global pause (used for 429 backoff). One instance per upstream API.
 */
type Job = { prio: number; seq: number; run: () => void };

export class RateLimiter {
  private queue: Job[] = [];
  private last = 0;
  private pausedUntil = 0;
  private timer: NodeJS.Timeout | null = null;
  private seq = 0;
  private inFlight = 0;

  constructor(
    public readonly name: string,
    private minIntervalMs: number,
    private maxConcurrent = 4,
  ) {}

  setInterval(ms: number) {
    this.minIntervalMs = ms;
  }

  /** Pause all calls (e.g. after HTTP 429). */
  pause(ms: number) {
    this.pausedUntil = Math.max(this.pausedUntil, Date.now() + ms);
    this.kick();
  }

  get pending() {
    return this.queue.length;
  }

  get pausedMs() {
    return Math.max(0, this.pausedUntil - Date.now());
  }

  /** Lower prio number = served first. */
  schedule<T>(fn: () => Promise<T>, prio = 5): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({
        prio,
        seq: this.seq++,
        run: () => {
          this.inFlight++;
          fn()
            .then(resolve, reject)
            .finally(() => {
              this.inFlight--;
              this.kick();
            });
        },
      });
      this.queue.sort((a, b) => a.prio - b.prio || a.seq - b.seq);
      this.kick();
    });
  }

  private kick() {
    if (this.timer || this.queue.length === 0) return;
    const now = Date.now();
    const wait = Math.max(this.pausedUntil - now, this.last + this.minIntervalMs - now, 0);
    if (wait > 0 || this.inFlight >= this.maxConcurrent) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.kick();
      }, Math.max(wait, 25));
      return;
    }
    const job = this.queue.shift()!;
    this.last = Date.now();
    job.run();
    if (this.queue.length) this.kick();
  }
}
