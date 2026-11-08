import fs from 'node:fs';
import path from 'node:path';
import { defaultSettings, type Settings } from '../src/config.js';
import type { Services } from '../src/engine.js';
import { simBuy, simSell } from '../src/fills.js';
import { normalizePair } from '../src/sources/dexscreener.js';
import type { MarketSnapshot, PoolStats, SafetyReport } from '../src/types.js';

export const fixture = <T = any>(name: string): T =>
  JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8')) as T;

export const settings = (): Settings => {
  // tests must not depend on the developer's .env
  const s = defaultSettings();
  s.startEquity = 150;
  s.maxPositionPct = 8;
  s.maxOpenPositions = 3;
  s.tokenCooldownMin = 30;
  Object.assign(s.filter, {
    minLiquidityUsd: 40_000,
    minVolumeUsd: 50_000,
    volumeWindow: 'h1',
    minLpLockedPct: 90,
    maxTop10Pct: 25,
    maxDevPct: 3,
    maxBundlePct: 10,
    maxPriceChangeH1: 80,
    watchWindowMin: 20,
  });
  Object.assign(s.risk, { stopLossPct: 6, trailActivatePct: 12, trailPct: 6, timeStopMin: 45 });
  s.analyst.minScore = 70;
  return s;
};

/** A real DexScreener pair from the fixture, with selected fields overridden. */
export function snapFromFixture(over: Partial<MarketSnapshot> = {}, idx = 0, now = Date.now()): MarketSnapshot {
  const pairs = fixture<any[]>('ds_tokens.json');
  const base = normalizePair(pairs[idx], now);
  return { ...base, ...over, ts: now };
}

/** A "healthy" snapshot that passes market rules and scores well. */
export function goodSnap(mint: string, now: number, price = 0.001): MarketSnapshot {
  return snapFromFixture(
    {
      mint,
      symbol: 'GOOD',
      name: 'Good Token',
      pairAddress: `pair-${mint}`,
      priceUsd: price,
      liquidityUsd: 90_000,
      fdv: 400_000,
      marketCap: 400_000,
      volume: { m5: 15_000, h1: 120_000, h6: 150_000, h24: 150_000 },
      priceChange: { m5: 6, h1: 35, h6: 40, h24: 40 },
      txns: { m5: { buys: 90, sells: 45 }, h1: { buys: 900, sells: 450 }, h6: { buys: 1000, sells: 500 }, h24: { buys: 1000, sells: 500 } },
      pairCreatedAt: now - 40 * 60_000,
    },
    0,
    now,
  );
}

export class FakeServices implements Services {
  t = Date.UTC(2026, 10, 8, 23, 0, 0);
  sol = 88;
  safetyMap = new Map<string, SafetyReport | null>();
  pool: PoolStats | null = null;
  quotes = 0;
  constructor(private getSettings: () => Settings) {}
  now() {
    return this.t;
  }
  solUsd() {
    return this.sol;
  }
  async safety(mint: string) {
    return this.safetyMap.get(mint) ?? null;
  }
  async poolStats() {
    return this.pool;
  }
  async quoteBuy(a: Parameters<Services['quoteBuy']>[0]) {
    this.quotes++;
    const f = this.getSettings().fills;
    return simBuy(a.sizeUsd, { priceUsd: a.snap.priceUsd, liquidityUsd: a.snap.liquidityUsd, solUsd: a.solUsd, decimals: a.decimals, feePct: f.simFeePct, priorityFeeSol: f.priorityFeeSol });
  }
  async quoteSell(a: Parameters<Services['quoteSell']>[0]) {
    this.quotes++;
    const f = this.getSettings().fills;
    if (!a.snap) throw new Error('no price');
    return simSell(a.pos.qty, a.pos.qtyRaw, { priceUsd: a.snap.priceUsd, liquidityUsd: a.snap.liquidityUsd, solUsd: a.solUsd, decimals: a.pos.decimals, feePct: f.simFeePct, priorityFeeSol: f.priorityFeeSol });
  }
}
