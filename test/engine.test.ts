import { describe, expect, it } from 'vitest';
import { Db } from '../src/db.js';
import { Engine } from '../src/engine.js';
import { normalizeRugcheck } from '../src/sources/rugcheck.js';
import type { DiscoveredToken } from '../src/types.js';
import { FakeServices, fixture, goodSnap, settings, snapFromFixture } from './helpers.js';

function setup() {
  const db = new Db(':memory:');
  let engine: Engine;
  const svc = new FakeServices(() => engine.settings);
  engine = new Engine(db, svc, settings(), { marketPollMs: 8000 });
  engine.init();
  return { engine, svc, db };
}

const tok = (mint: string, symbol = mint.toUpperCase()): DiscoveredToken => ({
  mint,
  symbol,
  name: symbol,
  imageUrl: null,
  decimals: 6,
  source: 'geckoterminal',
  poolAddress: `pool-${mint}`,
  poolCreatedAt: null,
});

const clean = () => normalizeRugcheck(fixture('rugcheck_pass.json'));

describe('engine pipeline (scout → filter → analyst → executor → risk → logger)', () => {
  it('kills an old illiquid pair immediately and counts the rule', async () => {
    const { engine, svc } = setup();
    engine.onDiscovered([tok('aaa')]);
    expect(engine.counters.scanned).toBe(1);
    const snap = snapFromFixture({ mint: 'aaa', liquidityUsd: 9_000, pairCreatedAt: svc.t - 5 * 3600_000 }, 0, svc.t);
    engine.onMarket(new Map([['aaa', snap]]), ['aaa']);
    await engine.idle();
    expect(engine.counters.killed).toBe(1);
    expect(engine.counters.killedByRule.liquidity).toBe(1);
    expect(engine.recentLogs.at(-1)?.msg).toBe('killed $AAA · liq $9.0k < $40k');
  });

  it('gives a young pair the watch window to grow into liq/vol thresholds', async () => {
    const { engine, svc } = setup();
    engine.onDiscovered([tok('young')]);
    const small = snapFromFixture({ mint: 'young', liquidityUsd: 5_000, pairCreatedAt: svc.t - 60_000 }, 0, svc.t);
    engine.onMarket(new Map([['young', small]]), ['young']);
    await engine.idle();
    expect(engine.counters.killed).toBe(0);
    expect(engine.watch.has('young')).toBe(true);
    svc.t += 21 * 60_000;
    engine.onMarket(new Map([['young', { ...small, ts: svc.t }]]), ['young']);
    await engine.idle();
    expect(engine.counters.killedByRule.liquidity).toBe(1);
  });

  it('kills on RugCheck rules after market rules pass (real report)', async () => {
    const { engine, svc } = setup();
    engine.onDiscovered([tok('t10')]);
    svc.safetyMap.set('t10', normalizeRugcheck(fixture('rugcheck_top10.json')));
    engine.onMarket(new Map([['t10', goodSnap('t10', svc.t)]]), ['t10']);
    await engine.idle();
    expect(engine.counters.killedByRule.top10).toBe(1);
    expect(engine.desk.filter?.reason).toMatch(/^top 10 holders \d+%$/);
  });

  it('analyst rejects score < 70 and logs the reason', async () => {
    const { engine, svc } = setup();
    engine.onDiscovered([tok('meh')]);
    svc.safetyMap.set('meh', clean());
    const s = goodSnap('meh', svc.t);
    const weak = { ...s, priceChange: { m5: -4, h1: -15, h6: 0, h24: 0 }, txns: { ...s.txns, h1: { buys: 100, sells: 300 }, m5: { buys: 5, sells: 20 } } };
    engine.onMarket(new Map([['meh', weak]]), ['meh']);
    await engine.idle();
    expect(engine.counters.scored).toBe(1);
    expect(engine.counters.traded).toBe(0);
    expect(engine.recentLogs.at(-1)?.msg).toMatch(/^killed \$MEH · score \d+ < 70$/);
  });

  it('buys a good token, trails the run-up and sells with profit', async () => {
    const { engine, svc } = setup();
    engine.onDiscovered([tok('win')]);
    svc.safetyMap.set('win', clean());
    svc.pool = { pairAddress: 'pair-win', buyersM5: 60, buyersH1: 400, sellersH1: 200, ts: svc.t };
    engine.onMarket(new Map([['win', goodSnap('win', svc.t, 0.001)]]), ['win']);
    await engine.idle();
    expect(engine.counters.traded).toBe(1);
    expect(engine.positions).toHaveLength(1);
    const p = engine.positions[0];
    expect(p.sizeUsd).toBe(12); // 8% of $150
    expect(engine.cash).toBeCloseTo(150 - p.costUsd, 6);

    const tickTo = async (price: number) => {
      svc.t += 3_000;
      engine.onMarket(new Map([['win', { ...goodSnap('win', svc.t, price) }]]), []);
      await engine.idle();
    };
    await tickTo(0.00112);
    await tickTo(0.0013); // +30% → trail armed
    expect(engine.positions[0].trailActive).toBe(true);
    await tickTo(0.00125); // −3.8% from peak: hold
    expect(engine.positions).toHaveLength(1);
    await tickTo(0.0012); // −7.7% from peak: trail exit
    expect(engine.positions).toHaveLength(0);
    expect(engine.counters.wins).toBe(1);
    expect(engine.counters.lastTrade!.pnl).toBeGreaterThan(0);
    expect(engine.recentLogs.at(-1)?.msg).toMatch(/^trail → sold \$WIN · \+\$\d+\.\d\d$/);
    const st = engine.stats();
    expect(st.trades).toBe(1);
    expect(st.winrate).toBe(100);
    expect(st.netPnlUsd).toBeCloseTo(engine.equity() - 150, 6);
    expect(st.feesUsd).toBeGreaterThan(0);
  });

  it('stop loss −6% closes the position with a loss', async () => {
    const { engine, svc } = setup();
    engine.onDiscovered([tok('lose')]);
    svc.safetyMap.set('lose', clean());
    engine.onMarket(new Map([['lose', goodSnap('lose', svc.t, 0.001)]]), ['lose']);
    await engine.idle();
    expect(engine.positions).toHaveLength(1);
    const entry = engine.positions[0].entryPrice;
    svc.t += 2_500;
    engine.onMarket(new Map([['lose', goodSnap('lose', svc.t, entry * 0.93)]]), []);
    await engine.idle();
    expect(engine.positions).toHaveLength(0);
    expect(engine.counters.losses).toBe(1);
    expect(engine.recentLogs.at(-1)?.msg).toMatch(/^stop −6% → sold \$LOSE · −\$/);
  });

  it('respects max open positions', async () => {
    const { engine, svc } = setup();
    const mints = ['p1', 'p2', 'p3', 'p4'];
    engine.onDiscovered(mints.map((m) => tok(m)));
    for (const m of mints) svc.safetyMap.set(m, clean());
    engine.onMarket(new Map(mints.map((m) => [m, goodSnap(m, svc.t)])), mints);
    await engine.idle();
    expect(engine.positions).toHaveLength(3);
    expect(engine.recentLogs.some((l) => l.kind === 'skip' && l.msg.includes('max 3 open'))).toBe(true);
  });

  it('session reset starts from zero and keeps stats of the old session', async () => {
    const { engine, db } = setup();
    engine.onDiscovered([tok('x')]);
    const oldId = engine.sessionId;
    engine.resetSession(200);
    expect(engine.sessionId).not.toBe(oldId);
    expect(engine.counters.scanned).toBe(0);
    expect(engine.equity()).toBe(200);
    expect(db.listSessions().find((s) => s.id === oldId)?.ended_at).toBeTruthy();
  });
});
