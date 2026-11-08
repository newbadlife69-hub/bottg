import type { Settings } from '../config.js';

export interface SizingInput {
  equity: number;
  cash: number;
  openCount: number;
  cooldownUntil: number | undefined;
  now: number;
  feeReserveUsd: number;
}

export type SizingResult = { ok: true; sizeUsd: number } | { ok: false; reason: string };

/** Position sizing: ≤ maxPositionPct of equity, ≤ free cash, max N open, per-token cooldown. */
export function sizePosition(i: SizingInput, s: Settings): SizingResult {
  if (i.openCount >= s.maxOpenPositions) return { ok: false, reason: `max ${s.maxOpenPositions} open` };
  if (i.cooldownUntil && i.cooldownUntil > i.now) {
    return { ok: false, reason: `cooldown ${Math.ceil((i.cooldownUntil - i.now) / 60_000)}m` };
  }
  const target = (i.equity * s.maxPositionPct) / 100;
  const sizeUsd = Math.floor(Math.min(target, i.cash - i.feeReserveUsd) * 100) / 100;
  if (!(sizeUsd >= 1)) return { ok: false, reason: 'no free cash' };
  return { ok: true, sizeUsd };
}
