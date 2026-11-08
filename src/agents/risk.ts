import type { Settings } from '../config.js';

export interface RiskState {
  entryPrice: number;
  peakPrice: number;
  trailActive: boolean;
  openedAt: number;
}

export interface RiskDecision {
  action: 'hold' | 'exit';
  reason: string;
  pnlPct: number;
  peakPrice: number;
  trailActive: boolean;
}

/**
 * Stop loss from entry, trailing stop armed once the peak is +X% and then
 * exits Y% under the peak, optional time stop (skipped while trailing).
 */
export function evaluateRisk(p: RiskState, price: number, now: number, r: Settings['risk']): RiskDecision {
  const peakPrice = Math.max(p.peakPrice, price);
  const pnlPct = (price / p.entryPrice - 1) * 100;
  const peakPct = (peakPrice / p.entryPrice - 1) * 100;
  const trailActive = p.trailActive || peakPct >= r.trailActivatePct;
  const base = { pnlPct, peakPrice, trailActive };

  if (pnlPct <= -r.stopLossPct) return { ...base, action: 'exit', reason: `stop −${r.stopLossPct}%` };
  if (trailActive && price <= peakPrice * (1 - r.trailPct / 100)) {
    return { ...base, action: 'exit', reason: 'trail' };
  }
  if (r.timeStopMin > 0 && !trailActive && now - p.openedAt >= r.timeStopMin * 60_000) {
    return { ...base, action: 'exit', reason: `time stop ${r.timeStopMin}m` };
  }
  return { ...base, action: 'hold', reason: '' };
}
