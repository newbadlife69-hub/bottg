import { describe, expect, it } from 'vitest';
import { sizePosition } from '../src/agents/executor.js';
import { jupiterToFill, priceImpact, simBuy, simSell, toRaw } from '../src/fills.js';
import { fixture, settings } from './helpers.js';

describe('Jupiter quote → paper fill (real /swap/v2/order response, no taker)', () => {
  it('uses outAmount from the real quote', () => {
    const { response } = fixture('jup_buy.json');
    expect(response.transaction).toBeNull(); // quote only, nothing to sign
    const decimals = 6;
    const fill = jupiterToFill(response, 9, decimals, 0.0001);
    expect(fill.source).toBe('jupiter');
    expect(fill.inUi).toBeCloseTo(Number(response.inAmount) / 1e9, 9);
    expect(fill.outUi).toBeCloseTo(Number(response.outAmount) / 10 ** decimals, 6);
    expect(fill.router).toBe(response.router);
    expect(fill.feeBps).toBe(response.feeBps);
    expect(fill.networkFeeSol).toBeGreaterThanOrEqual(0.0001);
  });

  it('a round trip through two real quotes loses money (fees + spread)', () => {
    const buy = fixture('jup_buy.json').response;
    const sell = fixture('jup_sell.json').response;
    expect(sell.inAmount).toBe(buy.outAmount);
    expect(Number(sell.outAmount)).toBeLessThan(Number(buy.inAmount));
  });

  it('rejects empty quotes', () => {
    expect(() => jupiterToFill({ inAmount: '1', outAmount: '0' }, 9, 6, 0)).toThrow();
  });
});

describe('simulated fill (fallback without Jupiter)', () => {
  const ctx = { priceUsd: 0.001, liquidityUsd: 40_000, solUsd: 88, decimals: 6, feePct: 0.3, priorityFeeSol: 0.0001 };

  it('price impact grows with size vs liquidity (constant product)', () => {
    expect(priceImpact(12, 40_000)).toBeCloseTo(12 / 20_012, 8);
    expect(priceImpact(2_000, 40_000)).toBeGreaterThan(priceImpact(200, 40_000));
  });

  it('buy: size minus 0.3% fee minus impact, priority fee in SOL', () => {
    const f = simBuy(12, ctx);
    const expected = (12 * (1 - 0.003) * (1 - priceImpact(12, 40_000))) / 0.001;
    expect(f.outUi).toBeCloseTo(expected, 6);
    expect(f.networkFeeSol).toBe(0.0001);
    expect(Number(f.inAmountRaw)).toBe(Math.round((12 / 88) * 1e9));
  });

  it('round trip at an unchanged price costs ≈ 2 × (fee + impact)', () => {
    const b = simBuy(12, ctx);
    const s = simSell(b.outUi, b.outAmountRaw, ctx);
    const back = s.outUi * 88;
    expect(back).toBeLessThan(12);
    expect(back).toBeGreaterThan(12 * (1 - 2 * (0.003 + priceImpact(12, 40_000))) - 0.01);
  });

  it('toRaw converts without float drift', () => {
    expect(toRaw(1.5, 6)).toBe('1500000');
    expect(toRaw(123456789.123456, 6)).toBe('123456789123456');
    expect(toRaw(0, 9)).toBe('0');
  });
});

describe('executor sizing', () => {
  const s = settings();
  const base = { equity: 150, cash: 150, openCount: 0, cooldownUntil: undefined, now: 0, feeReserveUsd: 0.02 };
  it('max 8% of equity', () => expect(sizePosition(base, s)).toEqual({ ok: true, sizeUsd: 12 }));
  it('never more than free cash', () => expect(sizePosition({ ...base, cash: 5 }, s)).toEqual({ ok: true, sizeUsd: 4.98 }));
  it('max open positions', () => expect(sizePosition({ ...base, openCount: 3 }, s)).toEqual({ ok: false, reason: 'max 3 open' }));
  it('per-token cooldown', () => expect(sizePosition({ ...base, cooldownUntil: 10 * 60_000 }, s)).toEqual({ ok: false, reason: 'cooldown 10m' }));
});
