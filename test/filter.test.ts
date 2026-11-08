import { describe, expect, it } from 'vitest';
import { checkMarket, checkPumped, checkSafety, runFilter } from '../src/agents/filter.js';
import { bestPairs, normalizePair, profilesToTokens } from '../src/sources/dexscreener.js';
import { parseNewPools, parsePoolStats } from '../src/sources/geckoterminal.js';
import { normalizeRugcheck } from '../src/sources/rugcheck.js';
import { SOL_MINT, QUOTE_MINTS } from '../src/sources/constants.js';
import { fixture, settings, snapFromFixture } from './helpers.js';

const f = () => settings().filter;
const rc = (name: string) => normalizeRugcheck(fixture(`rugcheck_${name}.json`));

describe('RugCheck normalisation on real reports', () => {
  it('clean token passes every safety rule', () => {
    const r = rc('pass');
    expect(r.mintAuthority).toBeNull();
    expect(r.freezeAuthority).toBeNull();
    expect(r.lpLockedPct).toBeGreaterThanOrEqual(90);
    expect(checkSafety(r, f())).toBeNull();
  });

  it('top-10 share excludes LP vaults / AMM pools', () => {
    const raw = fixture('rugcheck_pass.json');
    const naive = raw.topHolders.slice(0, 10).reduce((s: number, h: any) => s + h.pct, 0);
    const r = normalizeRugcheck(raw);
    // the biggest "holder" of a pump.fun token is its pool – it must not count
    expect(raw.topHolders[0].pct).toBeGreaterThan(5);
    expect(r.top10Pct).toBeLessThan(naive);
    expect(r.top10Count).toBe(10);
  });

  it('mint authority not revoked → kill', () => {
    expect(checkSafety(rc('mintAuthority'), f())).toEqual({ rule: 'mintAuthority', reason: 'mint authority not revoked' });
  });

  it('freeze authority not revoked → kill (real report with only freeze left)', () => {
    const raw = fixture('rugcheck_mintAuthority.json');
    raw.mintAuthority = null;
    raw.token.mintAuthority = null;
    const k = checkSafety(normalizeRugcheck(raw), f());
    expect(k?.rule).toBe('freezeAuthority');
  });

  it('LP not burned/locked uses the liquidity-weighted lpLockedPct', () => {
    const raw = fixture('rugcheck_lpLocked.json');
    let w = 0;
    let l = 0;
    for (const m of raw.markets) {
      const usd = m.lp.baseUSD + m.lp.quoteUSD;
      w += usd;
      l += usd * m.lp.lpLockedPct;
    }
    const r = normalizeRugcheck(raw);
    expect(r.lpLockedPct).toBeCloseTo(l / w, 1);
    const k = checkSafety(r, f());
    expect(k?.rule).toBe('lpLocked');
    expect(k?.reason).toMatch(/LP locked \d+% < 90%/);
  });

  it('top 10 holders > 25% → kill, threshold configurable', () => {
    const r = rc('top10');
    expect(r.top10Pct).toBeGreaterThan(25);
    expect(checkSafety(r, f())?.rule).toBe('top10');
    expect(checkSafety(r, { ...f(), maxTop10Pct: 40 })).toBeNull();
  });

  it('dev holding > 3% → kill', () => {
    const r = rc('devHolding');
    expect(r.devPct).toBeGreaterThan(3);
    expect(checkSafety(r, f())).toMatchObject({ rule: 'devHolding' });
  });

  it('bundled launch > 10% from insider networks → kill', () => {
    const r = rc('bundled');
    expect(r.bundleSource).toBe('insider networks');
    expect(r.bundlePct).toBeGreaterThan(10);
    expect(checkSafety(r, f())).toMatchObject({ rule: 'bundled', reason: expect.stringMatching(/^bundled launch \d+%$/) });
  });

  it('bundle risk flag in risks[] with a percentage is honoured', () => {
    const raw = fixture('rugcheck_pass.json');
    raw.insiderNetworks = null;
    raw.risks = [{ name: 'Bundled supply', value: '14%', description: '', score: 1000, level: 'danger' }];
    const r = normalizeRugcheck(raw);
    expect(r.bundlePct).toBe(14);
    expect(checkSafety(r, f())?.reason).toBe('bundled launch 14%');
  });

  it('safety rules are applied in order (mint before freeze before LP …)', () => {
    const r = rc('mintAuthority'); // has mint + freeze authority and no LP
    expect(checkSafety(r, f())?.rule).toBe('mintAuthority');
  });
});

describe('market rules on real DexScreener pairs', () => {
  it('picks the most liquid pair per token', () => {
    const pairs = fixture<any[]>('ds_tokens.json');
    const mints = [...new Set(pairs.map((p) => p.baseToken.address))];
    const best = bestPairs(pairs, mints);
    for (const [mint, snap] of best) {
      const maxLiq = Math.max(...pairs.filter((p) => p.baseToken.address === mint).map((p) => p.liquidity?.usd ?? 0));
      expect(snap.liquidityUsd).toBe(maxLiq);
    }
  });

  it('kills illiquid pairs with a readable reason', () => {
    const pairs = fixture<any[]>('ds_tokens.json');
    for (const p of pairs) {
      const s = normalizePair(p);
      const k = checkMarket(s, f());
      if (s.liquidityUsd < 40_000) {
        expect(k?.rule).toBe('liquidity');
        if (s.liquidityUsd > 0) expect(k?.reason).toMatch(/^liq \$[\d.]+k? < \$40k$/);
      } else if (s.volume.h1 < 50_000) expect(k?.rule).toBe('volume');
      else expect(k).toBeNull();
    }
  });

  it('volume window and threshold are configurable', () => {
    const s = snapFromFixture({ liquidityUsd: 100_000, volume: { m5: 1_000, h1: 60_000, h6: 200_000, h24: 300_000 } });
    expect(checkMarket(s, f())).toBeNull();
    expect(checkMarket(s, { ...f(), volumeWindow: 'm5' })?.rule).toBe('volume');
    expect(checkMarket(s, { ...f(), minVolumeUsd: 70_000 })?.reason).toBe('vol h1 $60k < $70k');
  });

  it('"already +80% in 1h" kill', () => {
    const s = snapFromFixture({ priceChange: { m5: 5, h1: 112, h6: 120, h24: 130 } });
    expect(checkPumped(s, f())).toEqual({ rule: 'pumped', reason: 'already +112% in 1h' });
    expect(checkPumped({ ...s, priceChange: { ...s.priceChange, h1: 79 } }, f())).toBeNull();
  });

  it('runFilter checks liquidity before on-chain safety', () => {
    const s = snapFromFixture({ liquidityUsd: 1_000 });
    expect(runFilter(s, rc('mintAuthority'), f())?.rule).toBe('liquidity');
    expect(runFilter(undefined, rc('pass'), f())).toEqual({ rule: 'liquidity', reason: 'no pair yet' });
  });
});

describe('scout parsers on real responses', () => {
  it('GeckoTerminal new_pools → memecoin mints (never SOL/USDC)', () => {
    const r = parseNewPools(fixture('gt_new_pools.json'));
    expect(r.tokens.length).toBeGreaterThan(0);
    for (const t of r.tokens) {
      expect(QUOTE_MINTS.has(t.mint)).toBe(false);
      expect(t.source).toBe('geckoterminal');
      expect(t.poolAddress).toBeTruthy();
    }
    expect(r.solUsd).toBeGreaterThan(10);
  });

  it('DexScreener profiles/boosts keep only Solana and de-duplicate', () => {
    const list = [...fixture<any[]>('ds_profiles.json'), ...fixture<any[]>('ds_boosts.json')];
    const toks = profilesToTokens(list, 'ds-profile');
    const sol = new Set(list.filter((p) => p.chainId === 'solana').map((p) => p.tokenAddress));
    sol.delete(SOL_MINT);
    expect(toks.length).toBe(sol.size);
    expect(new Set(toks.map((t) => t.mint)).size).toBe(toks.length);
  });

  it('GeckoTerminal pools/multi → unique buyers', () => {
    const stats = parsePoolStats(fixture('gt_pools_multi.json'));
    expect(stats.length).toBeGreaterThan(0);
    for (const s of stats) {
      expect(s.pairAddress).toBeTruthy();
      expect(s.buyersH1).toBeGreaterThanOrEqual(0);
    }
  });
});
