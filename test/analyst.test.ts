import { describe, expect, it } from 'vitest';
import { scoreToken } from '../src/agents/analyst.js';
import { normalizeRugcheck } from '../src/sources/rugcheck.js';
import { fixture, goodSnap, settings, snapFromFixture } from './helpers.js';

const now = Date.UTC(2026, 10, 8, 23, 0, 0);
const safety = () => normalizeRugcheck(fixture('rugcheck_pass.json'));

describe('analyst score', () => {
  it('is always 0..100 on real DexScreener pairs', () => {
    const pairs = fixture<any[]>('ds_tokens.json');
    pairs.forEach((_, i) => {
      const r = scoreToken(snapFromFixture({}, i, now), safety(), null, settings().analyst, now);
      expect(r.score).toBeGreaterThanOrEqual(0);
      expect(r.score).toBeLessThanOrEqual(100);
    });
  });

  it('a healthy setup scores ≥ 70', () => {
    const r = scoreToken(goodSnap('m', now), safety(), { pairAddress: 'x', buyersM5: 60, buyersH1: 400, sellersH1: 200, ts: now }, settings().analyst, now);
    expect(r.score).toBeGreaterThanOrEqual(70);
  });

  it('RugCheck score_normalised is treated as risk (higher = worse)', () => {
    const clean = { ...safety(), scoreNormalised: 1 };
    const risky = { ...safety(), scoreNormalised: 81 };
    const a = scoreToken(goodSnap('m', now), clean, null, settings().analyst, now).score;
    const b = scoreToken(goodSnap('m', now), risky, null, settings().analyst, now).score;
    expect(a).toBeGreaterThan(b);
  });

  it('a parabolic 5-minute candle is penalised', () => {
    const base = goodSnap('m', now);
    const calm = scoreToken(base, safety(), null, settings().analyst, now);
    const para = scoreToken({ ...base, priceChange: { ...base.priceChange, m5: 55 } }, safety(), null, settings().analyst, now);
    expect(para.parts.momentum).toBeLessThan(calm.parts.momentum);
    expect(para.notes).toContain('m5 parabolic');
  });

  it('weights come from config', () => {
    const cfg = settings().analyst;
    cfg.weights = { momentum: 0, buySell: 0, volumeGrowth: 0, liqFdv: 0, pairAge: 0, uniqueBuyers: 0, rugcheck: 1 };
    const r = scoreToken(goodSnap('m', now), { ...safety(), scoreNormalised: 30 }, null, cfg, now);
    expect(r.score).toBe(70);
  });

  it('pair age sweet spot 10–120 min', () => {
    const cfg = settings().analyst;
    const age = (min: number) => scoreToken({ ...goodSnap('m', now), pairCreatedAt: now - min * 60_000 }, safety(), null, cfg, now).parts.pairAge;
    expect(age(1)).toBeLessThan(0.3);
    expect(age(30)).toBe(1);
    expect(age(119)).toBe(1);
    expect(age(600)).toBeLessThan(0.5);
  });
});
