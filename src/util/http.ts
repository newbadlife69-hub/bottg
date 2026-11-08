import { RateLimiter } from './limiter.js';

export class HttpError extends Error {
  constructor(
    public status: number,
    public url: string,
    public body: string,
  ) {
    super(`HTTP ${status} ${url} ${body.slice(0, 160)}`);
  }
}

export interface GetJsonOpts {
  limiter: RateLimiter;
  headers?: Record<string, string>;
  prio?: number;
  timeoutMs?: number;
  /** retries on 429/5xx/network errors */
  retries?: number;
}

const UA = 'grok-bot/1.0 (paper trading research)';

/**
 * GET JSON through a rate limiter. On 429 the whole limiter is paused with
 * exponential backoff (honours Retry-After), then the request is retried.
 */
export async function getJson<T = unknown>(url: string, opts: GetJsonOpts): Promise<T> {
  const retries = opts.retries ?? 3;
  let attempt = 0;
  for (;;) {
    try {
      return await opts.limiter.schedule(async () => {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 12_000);
        try {
          const res = await fetch(url, {
            headers: { accept: 'application/json', 'user-agent': UA, ...(opts.headers ?? {}) },
            signal: ctrl.signal,
          });
          const text = await res.text();
          if (!res.ok) {
            if (res.status === 429) {
              const ra = Number(res.headers.get('retry-after'));
              const backoff = Number.isFinite(ra) && ra > 0 ? ra * 1000 : 2000 * 2 ** attempt;
              opts.limiter.pause(Math.min(backoff, 60_000));
            }
            throw new HttpError(res.status, url, text);
          }
          return JSON.parse(text) as T;
        } finally {
          clearTimeout(t);
        }
      }, opts.prio ?? 5);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 0;
      const retriable = status === 0 || status === 429 || status >= 500;
      if (!retriable || attempt >= retries) throw err;
      attempt++;
      await sleep(Math.min(500 * 2 ** attempt, 8000));
    }
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
