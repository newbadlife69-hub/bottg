import type { Settings } from '../config.js';
import type { Kill, MarketSnapshot, RuleId, SafetyReport } from '../types.js';
import { usdShort } from '../util/num.js';

/** The 8 kill rules (+ "already pumped") in evaluation order, with UI grouping. */
export const RULES: { id: RuleId; label: string; group: string }[] = [
  { id: 'liquidity', label: 'Liq < $40k', group: 'liqvol' },
  { id: 'volume', label: 'Vol 1h < $50k', group: 'liqvol' },
  { id: 'mintAuthority', label: 'Mint not revoked', group: 'authority' },
  { id: 'freezeAuthority', label: 'Freeze not revoked', group: 'authority' },
  { id: 'lpLocked', label: 'LP not burned/locked', group: 'lp' },
  { id: 'top10', label: 'Top 10 holders > 25%', group: 'top10' },
  { id: 'devHolding', label: 'Dev > 3%', group: 'devbundle' },
  { id: 'bundled', label: 'Bundled > 10%', group: 'devbundle' },
  { id: 'pumped', label: 'Already +80% in 1h', group: 'pumped' },
];

export const emptyRuleCounts = (): Record<RuleId, number> =>
  Object.fromEntries(RULES.map((r) => [r.id, 0])) as Record<RuleId, number>;

type F = Settings['filter'];

/** Market-only rules (cheap, DexScreener data). These are "soft": young tokens may grow into them. */
export function checkMarket(m: MarketSnapshot | undefined, f: F): Kill | null {
  const liq = m?.liquidityUsd ?? 0;
  if (liq < f.minLiquidityUsd) {
    if (!m) return { rule: 'liquidity', reason: 'no pair yet' };
    if (liq <= 0) return { rule: 'liquidity', reason: m.dexId === 'pumpfun' ? 'still on bonding curve' : 'no liquidity' };
    return { rule: 'liquidity', reason: `liq ${usdShort(liq)} < ${usdShort(f.minLiquidityUsd)}` };
  }
  const vol = m?.volume?.[f.volumeWindow] ?? 0;
  if (vol < f.minVolumeUsd) {
    return { rule: 'volume', reason: `vol ${f.volumeWindow} ${usdShort(vol)} < ${usdShort(f.minVolumeUsd)}` };
  }
  return null;
}

/** On-chain safety rules from RugCheck (hard: kill immediately). */
export function checkSafety(s: SafetyReport, f: F): Kill | null {
  if (s.mintAuthority) return { rule: 'mintAuthority', reason: 'mint authority not revoked' };
  if (s.freezeAuthority) return { rule: 'freezeAuthority', reason: 'freeze authority not revoked' };
  if (s.lpLockedPct < f.minLpLockedPct) {
    return {
      rule: 'lpLocked',
      reason: s.lpLockedPct <= 0 ? 'LP not burned' : `LP locked ${fmt(s.lpLockedPct)}% < ${f.minLpLockedPct}%`,
    };
  }
  if (s.top10Pct > f.maxTop10Pct) return { rule: 'top10', reason: `top 10 holders ${fmt(s.top10Pct)}%` };
  if (s.devPct > f.maxDevPct) return { rule: 'devHolding', reason: `dev holds ${fmt(s.devPct)}%` };
  if (s.bundlePct > f.maxBundlePct) return { rule: 'bundled', reason: `bundled launch ${fmt(s.bundlePct)}%` };
  return null;
}

export function checkPumped(m: MarketSnapshot, f: F): Kill | null {
  if (m.priceChange.h1 > f.maxPriceChangeH1) {
    return { rule: 'pumped', reason: `already +${fmt(m.priceChange.h1)}% in 1h` };
  }
  return null;
}

/** Full filter in rule order. */
export function runFilter(m: MarketSnapshot | undefined, s: SafetyReport, f: F): Kill | null {
  return checkMarket(m, f) ?? checkSafety(s, f) ?? (m ? checkPumped(m, f) : null);
}

const fmt = (x: number) => (x >= 10 ? x.toFixed(0) : x.toFixed(1)).replace(/\.0$/, '');
