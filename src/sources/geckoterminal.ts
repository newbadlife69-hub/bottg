import { getJson } from '../util/http.js';
import { RateLimiter } from '../util/limiter.js';
import type { DiscoveredToken, PoolStats } from '../types.js';
import { QUOTE_MINTS, SOL_MINT } from './constants.js';

const BASE = 'https://api.geckoterminal.com/api/v2';

// Public API: ~30 calls/min → keep a safe 2.1 s spacing and back off on 429.
export const gtLimiter = new RateLimiter('geckoterminal', 2100, 1);

const stripNet = (id: string | undefined) => (id ? id.replace(/^solana_/, '') : '');

export interface NewPoolsResult {
  tokens: DiscoveredToken[];
  poolCount: number;
  solUsd: number | null;
}

export async function fetchNewPools(page = 1): Promise<NewPoolsResult> {
  const body = await getJson<any>(`${BASE}/networks/solana/new_pools?include=base_token,quote_token&page=${page}`, {
    limiter: gtLimiter,
    headers: { accept: 'application/json;version=20230302' },
  });
  return parseNewPools(body);
}

export function parseNewPools(body: any): NewPoolsResult {
  const included = new Map<string, any>();
  for (const inc of body?.included ?? []) included.set(inc.id, inc.attributes);
  const tokens: DiscoveredToken[] = [];
  let solUsd: number | null = null;
  for (const pool of body?.data ?? []) {
    const a = pool.attributes ?? {};
    const baseId = pool.relationships?.base_token?.data?.id;
    const quoteId = pool.relationships?.quote_token?.data?.id;
    let mint = stripNet(baseId);
    let tokenAttrs = included.get(baseId);
    if (QUOTE_MINTS.has(mint)) {
      // reversed pool (SOL is base) → the memecoin is the quote token
      mint = stripNet(quoteId);
      tokenAttrs = included.get(quoteId);
    }
    if (!mint || QUOTE_MINTS.has(mint)) continue;
    if (stripNet(quoteId) === SOL_MINT && Number(a.quote_token_price_usd) > 0) solUsd = Number(a.quote_token_price_usd);
    const nameFromPool = String(a.name ?? '').split(' / ')[0];
    tokens.push({
      mint,
      symbol: String(tokenAttrs?.symbol ?? nameFromPool ?? '').slice(0, 24),
      name: String(tokenAttrs?.name ?? nameFromPool ?? '').slice(0, 64),
      imageUrl: tokenAttrs?.image_url && String(tokenAttrs.image_url).startsWith('http') ? tokenAttrs.image_url : null,
      decimals: Number.isFinite(Number(tokenAttrs?.decimals)) ? Number(tokenAttrs.decimals) : null,
      source: 'geckoterminal',
      poolAddress: a.address ?? stripNet(pool.id),
      poolCreatedAt: a.pool_created_at ? Date.parse(a.pool_created_at) : null,
    });
  }
  return { tokens, poolCount: (body?.data ?? []).length, solUsd };
}

/** Unique buyers/sellers for up to 30 pools (used by the Analyst). */
export async function fetchPoolStats(pairAddresses: string[]): Promise<PoolStats[]> {
  if (!pairAddresses.length) return [];
  const body = await getJson<any>(`${BASE}/networks/solana/pools/multi/${pairAddresses.slice(0, 30).join(',')}`, {
    limiter: gtLimiter,
    prio: 2,
    headers: { accept: 'application/json;version=20230302' },
  });
  return parsePoolStats(body);
}

export function parsePoolStats(body: any, now = Date.now()): PoolStats[] {
  return (body?.data ?? []).map((p: any) => {
    const t = p.attributes?.transactions ?? {};
    return {
      pairAddress: p.attributes?.address ?? stripNet(p.id),
      buyersM5: Number(t.m5?.buyers) || 0,
      buyersH1: Number(t.h1?.buyers) || 0,
      sellersH1: Number(t.h1?.sellers) || 0,
      ts: now,
    };
  });
}
