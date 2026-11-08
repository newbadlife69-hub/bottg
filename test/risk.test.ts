import { describe, expect, it } from 'vitest';
import { evaluateRisk, type RiskState } from '../src/agents/risk.js';
import { fixture, settings } from './helpers.js';

const r = () => settings().risk;
const T0 = Date.UTC(2026, 10, 8, 23, 0, 0);
const pos = (entry = 1): RiskState => ({ entryPrice: entry, peakPrice: entry, trailActive: false, openedAt: T0 });

/** Walk a price series through the risk manager like the live loop does. */
function walk(points: [number, number][], entry: number, cfg = r()) {
  const st = { ...pos(entry), openedAt: points[0][0] };
  for (const [t, price] of points) {
    const d = evaluateRisk(st, price, t, cfg);
    st.peakPrice = d.peakPrice;
    st.trailActive = d.trailActive;
    if (d.action === 'exit') return { exit: true, t, price, reason: d.reason, state: st };
  }
  return { exit: false, state: st };
}

describe('risk manager rules', () => {
  it('holds inside the band', () => {
    expect(evaluateRisk(pos(), 0.97, T0 + 60_000, r()).action).toBe('hold');
    expect(evaluateRisk(pos(), 1.1, T0 + 60_000, r()).action).toBe('hold');
  });

  it('stop loss at −6% from entry', () => {
    expect(evaluateRisk(pos(), 0.941, T0, r()).action).toBe('hold');
    const d = evaluateRisk(pos(), 0.94, T0, r());
    expect(d.action).toBe('exit');
    expect(d.reason).toBe('stop −6%');
  });

  it('trailing arms at +12% and exits 6% under the peak', () => {
    const st = pos();
    let d = evaluateRisk(st, 1.119, T0, r());
    expect(d.trailActive).toBe(false);
    d = evaluateRisk(st, 1.12, T0, r());
    expect(d.trailActive).toBe(true);
    Object.assign(st, { peakPrice: 1.3, trailActive: true });
    expect(evaluateRisk(st, 1.23, T0, r()).action).toBe('hold'); // −5.4% from peak
    const exit = evaluateRisk(st, 1.222, T0, r()); // −6% from peak
    expect(exit.action).toBe('exit');
    expect(exit.reason).toBe('trail');
    expect(exit.pnlPct).toBeCloseTo(22.2, 1); // profit locked in
  });

  it('time stop after 45 min, but never while trailing; 0 disables it', () => {
    const late = T0 + 45 * 60_000;
    expect(evaluateRisk(pos(), 1.02, late, r())).toMatchObject({ action: 'exit', reason: 'time stop 45m' });
    expect(evaluateRisk({ ...pos(), peakPrice: 1.2, trailActive: true }, 1.18, late, r()).action).toBe('hold');
    expect(evaluateRisk(pos(), 1.02, late, { ...r(), timeStopMin: 0 }).action).toBe('hold');
  });
});

describe('risk manager on real recorded price series (DexScreener, 2026-11-08)', () => {
  it('NVIDIH crash: stops out at the first print ≤ −6%', () => {
    const { points } = fixture<{ points: [number, number][] }>('price_series_nvidih.json');
    const entry = points[0][1];
    const res = walk(points, entry, { ...r(), timeStopMin: 0 });
    expect(res.exit).toBe(true);
    expect(res.reason).toBe('stop −6%');
    const first = points.find(([, p]) => p <= entry * 0.94)!;
    expect(res.t).toBe(first[0]);
    expect(res.price).toBe(first[1]);
  });

  it('GPU run-up: trailing arms and any exit locks in profit', () => {
    const { points } = fixture<{ points: [number, number][] }>('price_series_gpu.json');
    const entry = points[0][1];
    const peak = Math.max(...points.map(([, p]) => p));
    expect(peak / entry - 1).toBeGreaterThan(0.12); // the real move was big enough to arm the trail
    const res = walk(points, entry, { ...r(), timeStopMin: 0 });
    expect(res.state.trailActive).toBe(true);
    if (res.exit) {
      expect(res.reason).toBe('trail');
      expect(res.price!).toBeGreaterThan(entry);
      expect(res.price!).toBeLessThanOrEqual(res.state.peakPrice * 0.94);
    }
  });
});
