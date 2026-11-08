import { getJson } from '../util/http.js';
import { RateLimiter } from '../util/limiter.js';
import type { DiscoveredToken, MarketSnapshot, TxnCount } from '../types.js';
import { QUOTE_MINTS, SOL_MINT, USDC_MINT, USDT_MINT } from './constants.js';

const BASE = 'https://api.dexscreener.com';

// docs.dexscreener.com: profiles/boosts 60 req/min, tokens/v1 300 req/min
export const dsDiscoveryLimiter = new RateLimiter('dexscreener-discovery', 1100, 2);
export const dsMarketLimiter = new RateLimiter('dexscreener-market', 220, 4); // ~272/min

interface DsProfile {
  chainId: string;
  tokenAddress: string;
  icon?: string;
  description?: string;
}

export async function fetchLatestProfiles(): Promise<DiscoveredToken[]> {
  const list = await getJson<DsProfile[]>(`${BASE}/token-profiles/latest/v1`, { limiter: dsDiscoveryLimiter });
  return profilesToTokens(list, 'ds-profile');
}

export async function fetchLatestBoosts(): Promise<DiscoveredToken[]> {
  const list = await getJson<DsProfile[]>(`${BASE}/token-boosts/latest/v1`, { limiter: dsDiscoveryLimiter });
  return profilesToTokens(list, 'ds-boost');
}

export function profilesToTokens(list: DsProfile[], source: 'ds-profile' | 'ds-boost'): DiscoveredToken[] {
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  const out: DiscoveredToken[] = [];
  for (const p of list) {
    if (p?.chainId !== 'solana' || !p.tokenAddress || QUOTE_MINTS.has(p.tokenAddress)) continue;
    if (seen.has(p.tokenAddress)) continue;
    seen.add(p.tokenAddress);
    out.push({
      mint: p.tokenAddress,
      symbol: '',
      name: '',
      imageUrl: p.icon && p.icon.startsWith('http') ? p.icon : null,
      decimals: null,
      source,
      poolAddress: null,
      poolCreatedAt: null,
    });
  }
  return out;
}

const n = (v: unknown) => {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
};
const tx = (t: any): TxnCount => ({ buys: n(t?.buys), sells: n(t?.sells) });

/** Normalise one DexScreener pair object. */
export function normalizePair(p: any, now = Date.now()): MarketSnapshot {
  return {
    mint: p.baseToken?.address,
    symbol: String(p.baseToken?.symbol ?? '').slice(0, 24),
    name: String(p.baseToken?.name ?? '').slice(0, 64),
    pairAddress: p.pairAddress,
    dexId: p.dexId ?? '',
    url: p.url ?? `https://dexscreener.com/solana/${p.pairAddress}`,
    priceUsd: n(p.priceUsd),
    priceNative: n(p.priceNative),
    liquidityUsd: n(p.liquidity?.usd),
    fdv: n(p.fdv),
    marketCap: n(p.marketCap),
    volume: { m5: n(p.volume?.m5), h1: n(p.volume?.h1), h6: n(p.volume?.h6), h24: n(p.volume?.h24) },
    priceChange: {
      m5: n(p.priceChange?.m5),
      h1: n(p.priceChange?.h1),
      h6: n(p.priceChange?.h6),
      h24: n(p.priceChange?.h24),
    },
    txns: { m5: tx(p.txns?.m5), h1: tx(p.txns?.h1), h6: tx(p.txns?.h6), h24: tx(p.txns?.h24) },
    pairCreatedAt: p.pairCreatedAt ? n(p.pairCreatedAt) : null,
    imageUrl: p.info?.imageUrl ?? null,
    ts: now,
  };
}

/**
 * Pick, for every requested mint, the pair where it is the base token with the
 * highest USD liquidity (fallback: highest 24h volume, e.g. pump.fun curve).
 */
export function bestPairs(pairs: any[], mints: string[], now = Date.now()): Map<string, MarketSnapshot> {
  const wanted = new Set(mints);
  const best = new Map<string, any>();
  for (const p of Array.isArray(pairs) ? pairs : []) {
    if (p?.chainId !== 'solana') continue;
    const mint = p.baseToken?.address;
    if (!wanted.has(mint)) continue;
    const cur = best.get(mint);
    const liq = n(p.liquidity?.usd);
    if (!cur) best.set(mint, p);
    else {
      const curLiq = n(cur.liquidity?.usd);
      if (liq > curLiq || (liq === curLiq && n(p.volume?.h24) > n(cur.volume?.h24))) best.set(mint, p);
    }
  }
  const out = new Map<string, MarketSnapshot>();
  for (const [mint, p] of best) out.set(mint, normalizePair(p, now));
  return out;
}

/** Up to 30 mints per request (DexScreener limit). */
export async function fetchTokens(mints: string[], prio = 5): Promise<{ map: Map<string, MarketSnapshot>; raw: any[] }> {
  const out = new Map<string, MarketSnapshot>();
  const raw: any[] = [];
  for (let i = 0; i < mints.length; i += 30) {
    const chunk = mints.slice(i, i + 30);
    const pairs = await getJson<any[]>(`${BASE}/tokens/v1/solana/${chunk.join(',')}`, {
      limiter: dsMarketLimiter,
      prio,
    });
    raw.push(...(Array.isArray(pairs) ? pairs : []));
    for (const [k, v] of bestPairs(pairs, chunk)) out.set(k, v);
  }
  return { map: out, raw };
}

/** SOL/USD from the most liquid SOL–stable pair on DexScreener. */
export async function fetchSolUsd(): Promise<number | null> {
  const pairs = await getJson<any[]>(`${BASE}/tokens/v1/solana/${SOL_MINT}`, { limiter: dsMarketLimiter, prio: 3 });
  let best: any = null;
  for (const p of pairs ?? []) {
    if (p.baseToken?.address !== SOL_MINT) continue;
    if (![USDC_MINT, USDT_MINT].includes(p.quoteToken?.address)) continue;
    if (!best || n(p.liquidity?.usd) > n(best.liquidity?.usd)) best = p;
  }
  const px = best ? n(best.priceUsd) : 0;
  return px > 0 ? px : null;
}
