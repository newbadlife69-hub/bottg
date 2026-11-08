import type { Fill } from './types.js';

/**
 * Paper-fill maths. Real fills come from a Jupiter quote (outAmount already
 * has route fees + Jupiter platform fee deducted). Without a quote we simulate
 * a constant-product pool: half of DexScreener liquidity sits on each side, so
 * price impact = size / (liquidity/2 + size), plus an AMM fee and priority fee.
 */
export interface SimCtx {
  priceUsd: number;
  liquidityUsd: number;
  solUsd: number;
  decimals: number;
  feePct: number;
  priorityFeeSol: number;
}

export function priceImpact(sizeUsd: number, liquidityUsd: number): number {
  const reserve = Math.max(liquidityUsd / 2, 1);
  return sizeUsd / (reserve + sizeUsd);
}

export function simBuy(sizeUsd: number, c: SimCtx): Fill {
  if (!(c.priceUsd > 0) || !(c.solUsd > 0)) throw new Error('sim fill needs price and SOL/USD');
  const impact = priceImpact(sizeUsd, c.liquidityUsd);
  const usdAfter = sizeUsd * (1 - c.feePct / 100) * (1 - impact);
  const tokens = usdAfter / c.priceUsd;
  const lamports = Math.round((sizeUsd / c.solUsd) * 1e9);
  return {
    source: 'sim',
    router: 'sim-cpmm',
    inAmountRaw: String(lamports),
    outAmountRaw: toRaw(tokens, c.decimals),
    inUi: lamports / 1e9,
    outUi: tokens,
    priceImpactPct: impact * 100,
    feeBps: Math.round(c.feePct * 100),
    networkFeeSol: c.priorityFeeSol,
  };
}

export function simSell(qty: number, qtyRaw: string, c: SimCtx): Fill {
  if (!(c.priceUsd > 0) || !(c.solUsd > 0)) throw new Error('sim fill needs price and SOL/USD');
  const valueUsd = qty * c.priceUsd;
  const impact = priceImpact(valueUsd, c.liquidityUsd);
  const usdOut = valueUsd * (1 - c.feePct / 100) * (1 - impact);
  const sol = usdOut / c.solUsd;
  return {
    source: 'sim',
    router: 'sim-cpmm',
    inAmountRaw: qtyRaw,
    outAmountRaw: String(Math.round(sol * 1e9)),
    inUi: qty,
    outUi: sol,
    priceImpactPct: impact * 100,
    feeBps: Math.round(c.feePct * 100),
    networkFeeSol: c.priorityFeeSol,
  };
}

/** Convert a Jupiter /swap/v2/order (quote-only, no taker) response into a Fill. */
export function jupiterToFill(resp: any, inDecimals: number, outDecimals: number, priorityFeeSol: number): Fill {
  const out = Number(resp?.outAmount);
  const inn = Number(resp?.inAmount);
  if (!(out > 0) || !(inn > 0)) throw new Error('jupiter: empty quote');
  const lamportFees =
    (Number(resp.signatureFeeLamports) || 0) + (Number(resp.prioritizationFeeLamports) || 0) + (Number(resp.rentFeeLamports) || 0);
  return {
    source: 'jupiter',
    router: String(resp.router ?? resp.swapType ?? 'jupiter'),
    inAmountRaw: String(resp.inAmount),
    outAmountRaw: String(resp.outAmount),
    inUi: inn / 10 ** inDecimals,
    outUi: out / 10 ** outDecimals,
    priceImpactPct: Math.abs(Number(resp.priceImpact ?? Number(resp.priceImpactPct) * 100) || 0),
    feeBps: Number(resp.feeBps) || 0,
    networkFeeSol: priorityFeeSol + lamportFees / 1e9,
  };
}

export function toRaw(ui: number, decimals: number): string {
  if (!(ui > 0)) return '0';
  // BigInt-safe conversion for large supplies
  const [i, f = ''] = ui.toFixed(Math.min(decimals, 12)).split('.');
  const frac = (f + '0'.repeat(decimals)).slice(0, decimals);
  return (BigInt(i) * 10n ** BigInt(decimals) + BigInt(frac || '0')).toString();
}
