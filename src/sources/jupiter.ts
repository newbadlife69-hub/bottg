import { getJson } from '../util/http.js';
import { RateLimiter } from '../util/limiter.js';

// developers.jup.ag: keyless 0.5 RPS on api.jup.ag, free key 1 RPS (x-api-key header)
const BASE = 'https://api.jup.ag/swap/v2';
export const jupLimiter = new RateLimiter('jupiter', 2100, 1);

export class JupiterQuoter {
  constructor(private apiKey: string) {
    jupLimiter.setInterval(apiKey ? 1050 : 2100);
  }

  get keyed() {
    return !!this.apiKey;
  }

  /** Quote-only order: no `taker` → response has outAmount/router/feeBps and transaction=null. */
  async order(inputMint: string, outputMint: string, amountRaw: string): Promise<any> {
    const url = `${BASE}/order?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amountRaw}`;
    const headers: Record<string, string> = {};
    if (this.apiKey) headers['x-api-key'] = this.apiKey;
    const resp = await getJson<any>(url, { limiter: jupLimiter, headers, prio: 1, retries: 2, timeoutMs: 10_000 });
    if (resp?.error || resp?.errorCode && !resp?.outAmount) throw new Error(`jupiter: ${resp.error ?? resp.errorMessage ?? resp.errorCode}`);
    return resp;
  }
}
