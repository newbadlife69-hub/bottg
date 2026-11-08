import type { Settings } from '../config.js';
import type { MarketSnapshot, PoolStats, SafetyReport } from '../types.js';
import { clamp, pl } from '../util/num.js';

export type ScoreParts = Record<keyof Settings['analyst']['weights'], number>;

export interface ScoreResult {
  score: number;
  parts: ScoreParts;
  notes: string[];
}

const BS_CURVE: [number, number][] = [
  [0.8, 0],
  [1.2, 0.6],
  [2.5, 1],
  [5, 0.7],
];

/**
 * 0–100 score for tokens that passed the filter. Each component is 0..1, the
 * final score is the weighted mean × 100. Weights live in settings.
 */
export function scoreToken(
  m: MarketSnapshot,
  s: SafetyReport,
  pool: PoolStats | null,
  cfg: Settings['analyst'],
  now: number,
): ScoreResult {
  const notes: string[] = [];
  const ageMin = m.pairCreatedAt ? (now - m.pairCreatedAt) / 60_000 : NaN;

  // momentum: want green, but not a parabola
  const h1 = pl(m.priceChange.h1, [
    [-20, 0],
    [0, 0.3],
    [10, 0.7],
    [50, 1],
    [80, 0.6],
  ]);
  const m5 = pl(m.priceChange.m5, [
    [-5, 0],
    [0, 0.4],
    [8, 1],
    [20, 1],
    [40, 0.3],
    [60, 0.1],
  ]);
  const momentum = 0.5 * h1 + 0.5 * m5;
  if (m.priceChange.m5 > 25) notes.push('m5 parabolic');

  // buy pressure: buys/sells, too one-sided smells like bots
  const ratio = (t: { buys: number; sells: number }) => t.buys / Math.max(t.sells, 1);
  const buySell = 0.6 * pl(ratio(m.txns.h1), BS_CURVE) + 0.4 * pl(ratio(m.txns.m5), BS_CURVE);

  // volume acceleration: last 5 min scaled to the observed window vs the h1 volume
  const windowFactor = Number.isFinite(ageMin) ? clamp(ageMin / 5, 1, 12) : 12;
  const growth = (m.volume.m5 * windowFactor) / Math.max(m.volume.h1, 1);
  const volumeGrowth = pl(growth, [
    [0.5, 0],
    [1, 0.6],
    [2, 1],
  ]);

  // liquidity depth vs valuation
  const lf = m.fdv > 0 ? m.liquidityUsd / m.fdv : 0;
  const liqFdv = pl(lf, [
    [0.03, 0],
    [0.1, 0.6],
    [0.25, 1],
  ]);

  // pair age sweet spot (default 10–120 min)
  const pairAge = Number.isFinite(ageMin)
    ? pl(ageMin, [
        [2, 0.2],
        [cfg.ageSweetMin, 1],
        [cfg.ageSweetMax, 1],
        [cfg.ageSweetMax * 3, 0.3],
        [cfg.ageSweetMax * 6, 0.2],
      ])
    : 0.5;

  // unique buyers (GeckoTerminal); proxy from DexScreener buy count when missing
  const buyersCurve: [number, number][] = [
    [30, 0],
    [100, 0.6],
    [300, 1],
  ];
  let uniqueBuyers: number;
  if (pool && pool.buyersH1 > 0) uniqueBuyers = pl(pool.buyersH1, buyersCurve);
  else {
    uniqueBuyers = 0.8 * pl(m.txns.h1.buys / 3, buyersCurve);
    notes.push('buyers≈txns');
  }

  // RugCheck: score_normalised is a *risk* score (1 = clean, high = risky)
  const rugcheck = 1 - clamp(s.scoreNormalised, 0, 100) / 100;

  const parts: ScoreParts = { momentum, buySell, volumeGrowth, liqFdv, pairAge, uniqueBuyers, rugcheck };
  let wSum = 0;
  let acc = 0;
  for (const [k, w] of Object.entries(cfg.weights) as [keyof ScoreParts, number][]) {
    if (!(w > 0)) continue;
    wSum += w;
    acc += w * clamp(parts[k], 0, 1);
  }
  const score = wSum > 0 ? Math.round((acc / wSum) * 100) : 0;
  return { score, parts, notes };
}
