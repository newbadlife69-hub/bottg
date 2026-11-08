import { env } from './config.js';
import type { Engine } from './engine.js';
import type { Recorder } from './recorder.js';
import type { LiveServices } from './services.js';
import { fetchLatestBoosts, fetchLatestProfiles, fetchSolUsd, fetchTokens } from './sources/dexscreener.js';
import { fetchNewPools } from './sources/geckoterminal.js';
import type { MarketSnapshot } from './types.js';

/**
 * Drives the engine with live data. Every loop is independent, self-scheduling
 * (no overlap) and survives API errors.
 */
export class LiveRunner {
  private timers: NodeJS.Timeout[] = [];
  private stopped = false;
  private lastGtPage2 = 0;

  constructor(
    private engine: Engine,
    private svc: LiveServices,
    private rec: Recorder,
  ) {
    svc.onHealth = (s, ok, err) => engine.noteHealth(s, ok, err);
  }

  start() {
    // a new recording file starts with the watch list restored from SQLite, so replay sees it too
    const restored = this.engine.watchTokens();
    if (restored.length) this.rec.discover(restored);
    this.loop('sol', 60_000, () => this.refreshSol(), 0);
    this.loop('scout-gt', env.gtPollMs, () => this.scoutGecko(), 500);
    this.loop('scout-ds', env.dsDiscoveryPollMs, () => this.scoutDexScreener(), 1500);
    this.loop('market', env.marketPollMs, () => this.refreshWatchlist(), 3000);
    this.loop('risk', env.riskPollMs, () => this.refreshPositions(), 1000);
    this.loop('ticker', 20_000, () => this.refreshTicker(), 10_000);
    this.loop('housekeeping', 10_000, async () => {
      this.engine.tick();
      this.engine.sampleEquity();
      this.engine.saveState();
    }, 10_000);
    this.loop('prune', 3600_000, async () => this.engine.db.pruneLogs(), 60_000);
  }

  stop() {
    this.stopped = true;
    for (const t of this.timers) clearTimeout(t);
  }

  private loop(name: string, every: number, fn: () => Promise<void>, firstDelay: number) {
    const run = async () => {
      if (this.stopped) return;
      const t0 = Date.now();
      try {
        await fn();
      } catch (err: any) {
        this.engine.warn('SYSTEM', `${name}: ${String(err?.message ?? err).slice(0, 140)}`);
      }
      if (!this.stopped) this.timers.push(setTimeout(run, Math.max(250, every - (Date.now() - t0))));
    };
    this.timers.push(setTimeout(run, firstDelay));
  }

  private async refreshSol() {
    try {
      const px = await fetchSolUsd();
      if (px) this.svc.setSol(px);
      this.engine.noteHealth('dexscreener', true);
    } catch (err) {
      this.engine.noteHealth('dexscreener', false, err);
      throw err;
    }
  }

  private async scoutGecko() {
    try {
      const r = await fetchNewPools(1);
      this.engine.noteHealth('geckoterminal', true);
      if (r.solUsd && !this.svc.sol) this.svc.setSol(r.solUsd);
      let tokens = r.tokens;
      // if a whole page was new we probably missed some → also read page 2
      const unseen = tokens.filter((t) => !this.engine.watch.has(t.mint)).length;
      if (unseen >= 18 && Date.now() - this.lastGtPage2 > 30_000) {
        this.lastGtPage2 = Date.now();
        const r2 = await fetchNewPools(2);
        tokens = tokens.concat(r2.tokens);
      }
      this.rec.discover(tokens);
      this.engine.onDiscovered(tokens);
    } catch (err) {
      this.engine.noteHealth('geckoterminal', false, err);
      throw err;
    }
  }

  private async scoutDexScreener() {
    try {
      const [profiles, boosts] = await Promise.all([fetchLatestProfiles(), fetchLatestBoosts()]);
      const tokens = [...profiles, ...boosts];
      this.engine.noteHealth('dexscreener', true);
      this.rec.discover(tokens);
      this.engine.onDiscovered(tokens);
    } catch (err) {
      this.engine.noteHealth('dexscreener', false, err);
      throw err;
    }
  }

  private async market(mints: string[], prio: number): Promise<Map<string, MarketSnapshot>> {
    if (!mints.length) return new Map();
    try {
      const { map } = await fetchTokens(mints, prio);
      this.engine.noteHealth('dexscreener', true);
      this.rec.market(mints, [...map.values()]);
      return map;
    } catch (err) {
      this.engine.noteHealth('dexscreener', false, err);
      throw err;
    }
  }

  private async refreshWatchlist() {
    const due = this.engine.dueForMarket();
    for (let i = 0; i < due.length; i += 30) {
      const chunk = due.slice(i, i + 30);
      const map = await this.market(chunk, 5);
      this.engine.onMarket(map, chunk);
    }
  }

  private async refreshPositions() {
    const mints = this.engine.openMints();
    if (!mints.length) return;
    const map = await this.market(mints, 1);
    this.engine.onMarket(map, []);
  }

  private async refreshTicker() {
    const mints = this.engine.tickerMints().filter((m) => !this.engine.watch.has(m));
    if (!mints.length) return;
    const map = await this.market(mints.slice(0, 30), 7);
    this.engine.onMarket(map, []);
  }
}
