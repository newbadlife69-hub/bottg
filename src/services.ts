import type { Settings } from './config.js';
import type { Services } from './engine.js';
import { jupiterToFill, simBuy, simSell } from './fills.js';
import type { Recorder } from './recorder.js';
import { SOL_MINT } from './sources/constants.js';
import { fetchPoolStats } from './sources/geckoterminal.js';
import { JupiterQuoter } from './sources/jupiter.js';
import { fetchSafety } from './sources/rugcheck.js';
import type { Fill, PoolStats, SafetyReport } from './types.js';

/**
 * Live implementations of the engine's I/O: RugCheck, GeckoTerminal pool
 * stats and Jupiter quotes, with a simulated fill when Jupiter is unavailable.
 */
export class LiveServices implements Services {
  sol = 0;
  readonly jup: JupiterQuoter;
  onHealth: (source: string, ok: boolean, err?: unknown) => void = () => {};

  constructor(
    jupApiKey: string,
    private getSettings: () => Settings,
    private rec: Recorder,
  ) {
    this.jup = new JupiterQuoter(jupApiKey);
  }

  now() {
    return Date.now();
  }

  solUsd() {
    return this.sol;
  }

  setSol(px: number) {
    if (px > 0) {
      this.sol = px;
      this.rec.write('sol', px);
    }
  }

  async safety(mint: string): Promise<SafetyReport | null> {
    const r = await fetchSafety(mint);
    if (r) this.rec.write('safety', r.report);
    return r?.report ?? null;
  }

  async poolStats(pair: string): Promise<PoolStats | null> {
    try {
      const [s] = await fetchPoolStats([pair]);
      this.onHealth('geckoterminal', true);
      if (s) this.rec.write('pool', s);
      return s ?? null;
    } catch (err) {
      this.onHealth('geckoterminal', false, err);
      return null;
    }
  }

  async quoteBuy(a: Parameters<Services['quoteBuy']>[0]): Promise<Fill> {
    const s = this.getSettings();
    const lamports = Math.round((a.sizeUsd / a.solUsd) * 1e9);
    try {
      const resp = await this.jup.order(SOL_MINT, a.mint, String(lamports));
      this.onHealth('jupiter', true);
      return jupiterToFill(resp, 9, a.decimals, s.fills.priorityFeeSol);
    } catch (err) {
      this.onHealth('jupiter', false, err);
      return simBuy(a.sizeUsd, {
        priceUsd: a.snap.priceUsd,
        liquidityUsd: a.snap.liquidityUsd,
        solUsd: a.solUsd,
        decimals: a.decimals,
        feePct: s.fills.simFeePct,
        priorityFeeSol: s.fills.priorityFeeSol,
      });
    }
  }

  async quoteSell(a: Parameters<Services['quoteSell']>[0]): Promise<Fill> {
    const s = this.getSettings();
    try {
      const resp = await this.jup.order(a.pos.mint, SOL_MINT, a.pos.qtyRaw);
      this.onHealth('jupiter', true);
      return jupiterToFill(resp, a.pos.decimals, 9, s.fills.priorityFeeSol);
    } catch (err) {
      this.onHealth('jupiter', false, err);
      if (!a.snap || !(a.snap.priceUsd > 0)) throw err;
      return simSell(a.pos.qty, a.pos.qtyRaw, {
        priceUsd: a.snap.priceUsd,
        liquidityUsd: a.snap.liquidityUsd,
        solUsd: a.solUsd,
        decimals: a.pos.decimals,
        feePct: s.fills.simFeePct,
        priorityFeeSol: s.fills.priorityFeeSol,
      });
    }
  }
}
