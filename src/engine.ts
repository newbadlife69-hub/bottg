import { EventEmitter } from 'node:events';
import { scoreToken, type ScoreResult } from './agents/analyst.js';
import { sizePosition } from './agents/executor.js';
import { checkMarket, checkPumped, checkSafety, emptyRuleCounts, RULES } from './agents/filter.js';
import { evaluateRisk } from './agents/risk.js';
import { mergeSettings, type Settings } from './config.js';
import type { Db, TokenRow } from './db.js';
import { computeStats, type SessionStats } from './stats.js';
import type {
  AgentName,
  DiscoveredToken,
  Fill,
  Kill,
  LogEntry,
  MarketSnapshot,
  PoolStats,
  Position,
  RuleId,
  SafetyReport,
  TokenStatus,
} from './types.js';
import { signedUsd } from './util/num.js';

/** Everything with I/O is injected, so the same engine runs live and in replay. */
export interface Services {
  now(): number;
  safety(mint: string): Promise<SafetyReport | null>;
  poolStats(pairAddress: string): Promise<PoolStats | null>;
  quoteBuy(a: { mint: string; decimals: number; sizeUsd: number; snap: MarketSnapshot; solUsd: number }): Promise<Fill>;
  quoteSell(a: { pos: Position; snap: MarketSnapshot | null; solUsd: number }): Promise<Fill>;
  solUsd(): number;
}

export interface Counters {
  scanned: number;
  pairs: number;
  killed: number;
  scored: number;
  traded: number;
  expired: number;
  reasons: number;
  wins: number;
  losses: number;
  realizedPnl: number;
  feesUsd: number;
  bestTrade: number | null;
  worstTrade: number | null;
  lastTrade: { pnl: number; symbol: string; ts: number } | null;
  killedByRule: Record<RuleId, number>;
}

const emptyCounters = (): Counters => ({
  scanned: 0,
  pairs: 0,
  killed: 0,
  scored: 0,
  traded: 0,
  expired: 0,
  reasons: 0,
  wins: 0,
  losses: 0,
  realizedPnl: 0,
  feesUsd: 0,
  bestTrade: null,
  worstTrade: null,
  lastTrade: null,
  killedByRule: emptyRuleCounts(),
});

interface WatchItem {
  mint: string;
  symbol: string;
  name: string;
  imageUrl: string | null;
  decimals: number | null;
  source: string;
  discoveredAt: number;
  poolCreatedAt: number | null;
  status: TokenStatus;
  lastMarketAt: number;
  lastSoftFail: Kill | null;
  safetyFails: number;
  busy: boolean;
}

interface DeskToken {
  mint: string;
  symbol: string;
  imageUrl: string | null;
  ts: number;
}

export interface Desk {
  scout: (DeskToken & { text: string }) | null;
  filter: (DeskToken & { reason: string }) | null;
  analyst: (DeskToken & { score: number; passed: boolean; min: number }) | null;
  lastBuy: (DeskToken & { sizeUsd: number }) | null;
  lastLog: LogEntry | null;
}

export interface LiveGateState {
  requested: boolean;
  envConfirmed: boolean;
  armed: boolean;
}

const MAX_RECENT_LOGS = 60;
const EXIT_NO_ROUTE_WRITE_OFF_MS = 10 * 60_000;

export class Engine extends EventEmitter {
  settings: Settings;
  sessionId = 0;
  sessionStartedAt = 0;
  startEquity = 0;
  cash = 0;
  counters: Counters = emptyCounters();
  readonly watch = new Map<string, WatchItem>();
  readonly snaps = new Map<string, MarketSnapshot>();
  positions: Position[] = [];
  readonly cooldown = new Map<string, number>();
  desk: Desk = { scout: null, filter: null, analyst: null, lastBuy: null, lastLog: null };
  recentLogs: LogEntry[] = [];
  curve: [number, number][] = [];
  live: LiveGateState = { requested: false, envConfirmed: false, armed: false };
  health: Record<string, { ok: number; err: number; lastError: string }> = {};

  private seen = new Set<string>();
  private pendingBuys = 0;
  private reservedCash = 0;
  private pairSet = new Set<string>();
  private pending = new Set<Promise<unknown>>();
  private exitFailSince = new Map<number, number>();
  private lastPosPersist = new Map<number, number>();
  private dirty = true;

  constructor(
    readonly db: Db,
    readonly svc: Services,
    defaults: Settings,
    readonly opts: { persistTokens?: boolean; marketPollMs?: number } = {},
  ) {
    super();
    this.setMaxListeners(100);
    this.settings = mergeSettings(defaults, db.loadSettings());
  }

  // ------------------------------------------------------------------ lifecycle
  init() {
    const now = this.svc.now();
    let s = this.db.currentSession();
    if (!s) s = this.db.createSession(now, this.settings.startEquity, 'paper');
    this.sessionId = s.id;
    this.sessionStartedAt = s.started_at;
    this.startEquity = s.start_equity;
    this.cash = s.cash;
    this.counters = { ...emptyCounters(), ...JSON.parse(s.counters || '{}') };
    this.counters.killedByRule = { ...emptyRuleCounts(), ...(this.counters.killedByRule ?? {}) };
    this.positions = this.db.openPositions(s.id).map((p) => ({ ...p, status: 'open' as const }));
    for (const m of this.db.seenMints(s.id, now - 24 * 3600_000)) this.seen.add(m);
    for (const t of this.db.activeTokens(s.id)) {
      this.watch.set(t.mint, {
        mint: t.mint,
        symbol: t.symbol ?? '',
        name: t.name ?? '',
        imageUrl: t.image_url,
        decimals: t.decimals,
        source: t.source,
        discoveredAt: t.discovered_at,
        poolCreatedAt: null,
        status: 'watching',
        lastMarketAt: 0,
        lastSoftFail: null,
        safetyFails: 0,
        busy: false,
      });
    }
    this.recentLogs = this.db.recentLogs(s.id, MAX_RECENT_LOGS).reverse();
    this.desk.lastLog = [...this.recentLogs].reverse().find((l) => l.kind !== 'info' && l.kind !== 'warn') ?? null;
    this.curve = this.db.equityCurve(s.id);
    if (!this.curve.length) this.sampleEquity(true);
    this.restoreDesk();
  }

  /** Rebuild the "last event" column of the desk from the log after a restart. */
  private restoreDesk() {
    const sid = this.sessionId;
    const img = (mint: string | null) => (mint ? this.db.tokenImage(sid, mint) : null);
    const t = this.db.latestNamedToken(sid);
    if (t) this.desk.scout = { mint: t.mint, symbol: t.symbol, imageUrl: t.image_url, ts: t.discovered_at, text: 'new pair' };
    const k = this.db.lastLogOfKind(sid, 'kill');
    if (k?.mint) {
      this.desk.filter = { mint: k.mint, symbol: k.symbol ?? '', imageUrl: img(k.mint), ts: k.ts, reason: k.msg.split(' · ').slice(1).join(' · ') };
    }
    const a = this.db.lastLogOfKind(sid, 'score', 'ANALYST');
    if (a?.mint) {
      const m = /score (\d+)/.exec(a.msg);
      this.desk.analyst = {
        mint: a.mint,
        symbol: a.symbol ?? '',
        imageUrl: img(a.mint),
        ts: a.ts,
        score: m ? Number(m[1]) : 0,
        passed: a.msg.includes('≥'),
        min: this.settings.analyst.minScore,
      };
    }
    const b = this.db.lastLogOfKind(sid, 'buy');
    if (b?.mint) {
      const m = /\$(\d+(?:\.\d+)?) ·/.exec(b.msg.split(' · ').slice(1).join(' · ') + ' ·');
      this.desk.lastBuy = { mint: b.mint, symbol: b.symbol ?? '', imageUrl: img(b.mint), ts: b.ts, sizeUsd: m ? Number(m[1]) : 0 };
    }
  }

  /** Resolves when every in-flight evaluation has finished (used by replay/tests). */
  async idle() {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }

  private track<T>(p: Promise<T>): Promise<T> {
    this.pending.add(p);
    p.catch((err) => this.warn('SYSTEM', `internal error: ${err?.message ?? err}`)).finally(() => this.pending.delete(p));
    return p;
  }

  isDirty() {
    const d = this.dirty;
    this.dirty = false;
    return d;
  }
  private touch() {
    this.dirty = true;
  }

  saveState() {
    this.db.saveSessionState(this.sessionId, this.cash, this.counters);
  }

  // ------------------------------------------------------------------ logging
  log(agent: AgentName, kind: LogEntry['kind'], msg: string, extra: Partial<LogEntry> = {}) {
    const entry: LogEntry = {
      ts: this.svc.now(),
      agent,
      kind,
      mint: extra.mint ?? null,
      symbol: extra.symbol ?? null,
      msg,
      rule: extra.rule ?? null,
      pnl: extra.pnl ?? null,
    };
    entry.id = this.db.insertLog(this.sessionId, entry);
    if (kind !== 'info' && kind !== 'warn') this.counters.reasons++;
    this.recentLogs.push(entry);
    if (this.recentLogs.length > MAX_RECENT_LOGS) this.recentLogs.shift();
    if (kind !== 'info' && kind !== 'warn') this.desk.lastLog = entry;
    this.emit('log', entry);
    this.touch();
  }

  private lastWarn = new Map<string, number>();
  /** Rate-limited warning (same text at most once per minute). */
  warn(agent: AgentName, msg: string) {
    const now = Date.now();
    const key = msg.slice(0, 60);
    if ((this.lastWarn.get(key) ?? 0) > now - 60_000) return;
    this.lastWarn.set(key, now);
    this.log(agent, 'warn', msg);
  }

  noteHealth(source: string, ok: boolean, err?: unknown) {
    const h = (this.health[source] ??= { ok: 0, err: 0, lastError: '' });
    if (ok) h.ok = Date.now();
    else {
      h.err = Date.now();
      h.lastError = String((err as any)?.message ?? err ?? '').slice(0, 200);
    }
  }

  // ------------------------------------------------------------------ SCOUT
  onDiscovered(tokens: DiscoveredToken[]) {
    const now = this.svc.now();
    for (const t of tokens) {
      if (t.poolAddress) this.addPair(t.poolAddress);
      if (this.seen.has(t.mint)) continue;
      this.seen.add(t.mint);
      this.counters.scanned++;
      const item: WatchItem = {
        mint: t.mint,
        symbol: t.symbol,
        name: t.name,
        imageUrl: t.imageUrl,
        decimals: t.decimals,
        source: t.source,
        discoveredAt: now,
        poolCreatedAt: t.poolCreatedAt,
        status: 'watching',
        lastMarketAt: 0,
        lastSoftFail: null,
        safetyFails: 0,
        busy: false,
      };
      this.watch.set(t.mint, item);
      this.persistToken(item, null, null, null);
      if (t.symbol) this.desk.scout = { mint: t.mint, symbol: t.symbol, imageUrl: t.imageUrl, ts: now, text: 'new pair' };
    }
    this.touch();
  }

  private addPair(addr: string) {
    if (this.pairSet.has(addr)) return;
    this.pairSet.add(addr);
    this.counters.pairs++;
    if (this.pairSet.size > 300_000) this.pairSet.clear();
  }

  /** Watch-list mints that need fresh market data (oldest first). */
  dueForMarket(max = 900): string[] {
    const now = this.svc.now();
    const every = (this.opts.marketPollMs ?? 8000) * 0.8;
    return [...this.watch.values()]
      .filter((w) => w.status === 'watching' && !w.busy && now - w.lastMarketAt >= every)
      .sort((a, b) => a.lastMarketAt - b.lastMarketAt)
      .slice(0, max)
      .map((w) => w.mint);
  }

  openMints(): string[] {
    return [...new Set(this.positions.map((p) => p.mint))];
  }

  /** Mints for the ticker strip: open positions first, then most active recent tokens. */
  tickerMints(n = 16): string[] {
    const now = this.svc.now();
    const pos = this.openMints();
    const rest = [...this.snaps.values()]
      .filter((s) => now - s.ts < 30 * 60_000 && s.liquidityUsd >= 15_000 && s.priceUsd > 0 && !pos.includes(s.mint))
      .sort((a, b) => b.volume.h1 - a.volume.h1)
      .slice(0, Math.max(0, n - pos.length))
      .map((s) => s.mint);
    return [...pos, ...rest];
  }

  // ------------------------------------------------------------------ market data → FILTER / RISK
  onMarket(map: Map<string, MarketSnapshot>, requested: string[] = []) {
    const now = this.svc.now();
    for (const [mint, snap] of map) {
      this.snaps.set(mint, snap);
      this.addPair(snap.pairAddress);
    }
    const toEval = new Set<string>([...requested, ...map.keys()]);
    for (const mint of toEval) {
      const item = this.watch.get(mint);
      if (!item || item.status !== 'watching' || item.busy) continue;
      item.lastMarketAt = now;
      const snap = map.get(mint);
      if (snap) {
        if (!item.symbol && snap.symbol) {
          item.symbol = snap.symbol;
          item.name = snap.name;
          this.desk.scout = { mint, symbol: snap.symbol, imageUrl: snap.imageUrl ?? item.imageUrl, ts: now, text: 'new pair' };
        }
        if (snap.imageUrl) item.imageUrl = snap.imageUrl;
      }
      this.track(this.evaluate(item, snap));
    }
    for (const pos of this.positions) {
      const snap = map.get(pos.mint);
      if (snap && pos.status === 'open') this.track(this.riskCheck(pos, snap));
    }
    this.touch();
  }

  /** Periodic housekeeping: expire watch items that never got data, prune snapshots. */
  tick() {
    const now = this.svc.now();
    const windowMs = this.settings.filter.watchWindowMin * 60_000;
    const grace = 3 * (this.opts.marketPollMs ?? 8000);
    for (const item of this.watch.values()) {
      if (item.status !== 'watching' || item.busy) continue;
      if (now - item.discoveredAt > windowMs + grace && now - item.lastMarketAt > grace) {
        this.kill(item, item.lastSoftFail ?? { rule: 'liquidity', reason: 'no pair yet' });
      }
    }
    const open = new Set(this.openMints());
    for (const [mint, s] of this.snaps) if (now - s.ts > 45 * 60_000 && !open.has(mint)) this.snaps.delete(mint);
    // stuck positions with no price updates → try to exit via quote
    for (const pos of this.positions) {
      if (pos.status === 'open' && now - pos.lastPriceAt > 5 * 60_000) this.track(this.closePosition(pos, 'stale price', null));
    }
  }

  private deadline(item: WatchItem, snap: MarketSnapshot | undefined): number {
    const created = snap?.pairCreatedAt ?? item.poolCreatedAt;
    const ageMin = created ? (this.svc.now() - created) / 60_000 : 0;
    // old pairs get no grace period – they had their chance to grow
    if (ageMin > this.settings.analyst.ageSweetMax) return item.discoveredAt;
    return item.discoveredAt + this.settings.filter.watchWindowMin * 60_000;
  }

  private async evaluate(item: WatchItem, snap: MarketSnapshot | undefined) {
    const f = this.settings.filter;
    const soft = checkMarket(snap, f);
    if (soft) {
      item.lastSoftFail = soft;
      if (this.svc.now() >= this.deadline(item, snap)) this.kill(item, soft);
      return;
    }
    // ---- passed liquidity + volume → on-chain safety (RugCheck)
    item.busy = true;
    item.status = 'checking';
    let safety: SafetyReport | null;
    try {
      safety = await this.svc.safety(item.mint);
      this.noteHealth('rugcheck', true);
    } catch (err) {
      this.noteHealth('rugcheck', false, err);
      item.busy = false;
      item.status = 'watching';
      if (++item.safetyFails >= 5) this.expire(item, 'RugCheck unavailable');
      return;
    }
    if (!safety) return this.expire(item, 'no RugCheck report');
    if (safety.decimals) item.decimals = safety.decimals;
    const hard = checkSafety(safety, f);
    if (hard) return this.kill(item, hard);
    const latest = this.snaps.get(item.mint) ?? snap!;
    const pumped = checkPumped(latest, f);
    if (pumped) return this.kill(item, pumped);

    // ---- ANALYST
    item.status = 'analysing';
    const pool = await this.svc.poolStats(latest.pairAddress).catch(() => null);
    const res = scoreToken(latest, safety, pool, this.settings.analyst, this.svc.now());
    const min = this.settings.analyst.minScore;
    const sym = item.symbol || latest.symbol;
    this.desk.analyst = {
      mint: item.mint,
      symbol: sym,
      imageUrl: item.imageUrl,
      ts: this.svc.now(),
      score: res.score,
      passed: res.score >= min,
      min,
    };
    if (res.score < min) {
      this.finish(item, 'scored', null, `score ${res.score} < ${min}`, res.score);
      this.counters.scored++;
      this.log('ANALYST', 'score', `killed $${sym} · score ${res.score} < ${min}`, { mint: item.mint, symbol: sym });
      return;
    }
    this.counters.scored++;
    this.log('ANALYST', 'score', `$${sym} score ${res.score} ≥ ${min} → executor`, { mint: item.mint, symbol: sym });
    await this.executeBuy(item, latest, safety, res);
  }

  private kill(item: WatchItem, k: Kill) {
    item.busy = false;
    this.counters.killed++;
    this.counters.killedByRule[k.rule] = (this.counters.killedByRule[k.rule] ?? 0) + 1;
    this.finish(item, 'killed', k.rule, k.reason, null);
    const sym = item.symbol || item.mint.slice(0, 6);
    this.desk.filter = { mint: item.mint, symbol: sym, imageUrl: item.imageUrl, ts: this.svc.now(), reason: k.reason };
    this.log('FILTER', 'kill', `killed $${sym} · ${k.reason}`, { mint: item.mint, symbol: sym, rule: k.rule });
  }

  private expire(item: WatchItem, reason: string) {
    item.busy = false;
    this.counters.expired++;
    this.finish(item, 'killed', null, reason, null);
    this.warn('FILTER', `skipped $${item.symbol || item.mint.slice(0, 6)} · ${reason}`);
  }

  private finish(item: WatchItem, status: TokenStatus, rule: RuleId | null, reason: string, score: number | null) {
    item.status = status;
    item.busy = false;
    this.watch.delete(item.mint);
    this.persistToken(item, rule, reason, score);
    this.touch();
  }

  private persistToken(item: WatchItem, rule: RuleId | null, reason: string | null, score: number | null) {
    if (this.opts.persistTokens === false) return;
    const row: TokenRow = {
      mint: item.mint,
      symbol: item.symbol,
      name: item.name,
      image_url: item.imageUrl,
      source: item.source,
      discovered_at: item.discoveredAt,
      status: item.status,
      rule,
      reason,
      score,
      decided_at: ['killed', 'scored', 'traded'].includes(item.status) ? this.svc.now() : null,
      decimals: item.decimals,
    };
    this.db.upsertToken(this.sessionId, row);
  }

  // ------------------------------------------------------------------ EXECUTOR
  private async executeBuy(item: WatchItem, snap: MarketSnapshot, safety: SafetyReport, res: ScoreResult) {
    const now = this.svc.now();
    const sym = item.symbol || snap.symbol;
    const solUsd = this.svc.solUsd();
    const skip = (reason: string) => {
      this.finish(item, 'scored', null, `executor: ${reason}`, res.score);
      this.log('EXECUTOR', 'skip', `skip $${sym} · ${reason}`, { mint: item.mint, symbol: sym });
    };
    if (!(solUsd > 0)) return skip('no SOL/USD price');
    // slots and cash already promised to buys that are still waiting for a quote
    const sizing = sizePosition(
      {
        equity: this.equity(),
        cash: this.cash - this.reservedCash,
        openCount: this.positions.length + this.pendingBuys,
        cooldownUntil: this.cooldown.get(item.mint),
        now,
        feeReserveUsd: this.settings.fills.priorityFeeSol * solUsd * 2,
      },
      this.settings,
    );
    if (!sizing.ok) return skip(sizing.reason);
    const decimals = safety.decimals || item.decimals || 6;
    let fill: Fill;
    this.pendingBuys++;
    this.reservedCash += sizing.sizeUsd;
    try {
      fill = await this.svc.quoteBuy({ mint: item.mint, decimals, sizeUsd: sizing.sizeUsd, snap, solUsd });
    } catch (err: any) {
      return skip(`no quote (${String(err?.message ?? err).slice(0, 60)})`);
    } finally {
      this.pendingBuys--;
      this.reservedCash -= sizing.sizeUsd;
    }
    if (!(fill.outUi > 0)) return skip('empty quote');
    const entryPrice = sizing.sizeUsd / fill.outUi;
    if (fill.priceImpactPct > 15) return skip(`impact ${fill.priceImpactPct.toFixed(1)}%`);
    if (snap.priceUsd > 0 && entryPrice > snap.priceUsd * 1.25) return skip('quote >25% above market');
    if (this.live.armed) {
      this.log('EXECUTOR', 'info', `LIVE stub: would buy $${sym} for $${sizing.sizeUsd.toFixed(2)} – signing not implemented, paper only`);
    }
    const networkFeeUsd = fill.networkFeeSol * solUsd;
    const costUsd = sizing.sizeUsd + networkFeeUsd;
    this.cash -= costUsd;
    const pos: Omit<Position, 'id'> = {
      sessionId: this.sessionId,
      mint: item.mint,
      symbol: sym,
      name: item.name || snap.name,
      imageUrl: item.imageUrl ?? snap.imageUrl,
      pairAddress: snap.pairAddress,
      decimals,
      status: 'open',
      openedAt: now,
      entryPrice,
      qtyRaw: fill.outAmountRaw,
      qty: fill.outUi,
      sizeUsd: sizing.sizeUsd,
      costUsd,
      entryFill: fill,
      score: res.score,
      peakPrice: Math.max(entryPrice, snap.priceUsd),
      lastPrice: snap.priceUsd || entryPrice,
      lastPriceAt: now,
      trailActive: false,
      closedAt: null,
      exitPrice: null,
      proceedsUsd: null,
      pnlUsd: null,
      pnlPct: null,
      exitReason: null,
      exitFill: null,
      feesUsd: networkFeeUsd + (sizing.sizeUsd * fill.feeBps) / 10_000,
    };
    const id = this.db.insertPosition(pos);
    this.positions.push({ ...pos, id });
    this.counters.traded++;
    this.cooldown.set(item.mint, now + this.settings.tokenCooldownMin * 60_000);
    this.finish(item, 'traded', null, `bought $${sizing.sizeUsd.toFixed(2)}`, res.score);
    this.desk.lastBuy = { mint: item.mint, symbol: sym, imageUrl: pos.imageUrl, ts: now, sizeUsd: sizing.sizeUsd };
    this.log(
      'EXECUTOR',
      'buy',
      `bought $${sym} · $${sizing.sizeUsd.toFixed(2)} · score ${res.score} · ${fill.source}/${fill.router}`,
      { mint: item.mint, symbol: sym },
    );
    this.saveState();
    this.sampleEquity(true);
    this.emit('trade');
  }

  // ------------------------------------------------------------------ RISK
  private async riskCheck(pos: Position, snap: MarketSnapshot) {
    if (pos.status !== 'open' || !(snap.priceUsd > 0)) return;
    const now = this.svc.now();
    pos.lastPrice = snap.priceUsd;
    pos.lastPriceAt = now;
    const d = evaluateRisk(pos, snap.priceUsd, now, this.settings.risk);
    pos.peakPrice = d.peakPrice;
    if (d.trailActive && !pos.trailActive) {
      pos.trailActive = true;
      this.log('RISK', 'info', `trail armed $${pos.symbol} · ${d.pnlPct >= 0 ? '+' : ''}${d.pnlPct.toFixed(1)}%`, {
        mint: pos.mint,
        symbol: pos.symbol,
      });
    }
    if (d.action === 'exit') {
      await this.closePosition(pos, d.reason, snap);
      return;
    }
    if ((this.lastPosPersist.get(pos.id) ?? 0) < now - 10_000) {
      this.lastPosPersist.set(pos.id, now);
      this.db.updatePosition(pos);
    }
  }

  async closePosition(pos: Position, reason: string, snap: MarketSnapshot | null) {
    if (pos.status !== 'open') return;
    pos.status = 'closing';
    const now = this.svc.now();
    const solUsd = this.svc.solUsd();
    let fill: Fill | null = null;
    try {
      fill = await this.svc.quoteSell({ pos, snap: snap ?? this.snaps.get(pos.mint) ?? null, solUsd });
      this.exitFailSince.delete(pos.id);
    } catch (err: any) {
      const since = this.exitFailSince.get(pos.id) ?? now;
      this.exitFailSince.set(pos.id, since);
      if (now - since < EXIT_NO_ROUTE_WRITE_OFF_MS) {
        pos.status = 'open';
        this.warn('RISK', `exit $${pos.symbol} failed (${String(err?.message ?? err).slice(0, 60)}), retrying`);
        return;
      }
      reason = `${reason} · no route, written off`;
    }
    const proceedsSol = fill ? fill.outUi : 0;
    const grossUsd = proceedsSol * solUsd;
    const networkFeeUsd = fill ? fill.networkFeeSol * solUsd : 0;
    const proceedsUsd = Math.max(0, grossUsd - networkFeeUsd);
    const pnlUsd = proceedsUsd - pos.costUsd;
    pos.status = 'closed';
    pos.closedAt = now;
    pos.exitFill = fill;
    pos.exitPrice = pos.qty > 0 ? grossUsd / pos.qty : 0;
    pos.proceedsUsd = proceedsUsd;
    pos.pnlUsd = pnlUsd;
    pos.pnlPct = pos.costUsd > 0 ? (pnlUsd / pos.costUsd) * 100 : 0;
    pos.exitReason = reason;
    pos.feesUsd += networkFeeUsd + (fill ? (grossUsd * fill.feeBps) / 10_000 : 0);
    this.cash += proceedsUsd;
    this.positions = this.positions.filter((p) => p.id !== pos.id);
    this.db.updatePosition(pos);

    const c = this.counters;
    if (pnlUsd > 0) c.wins++;
    else c.losses++;
    c.realizedPnl += pnlUsd;
    c.feesUsd += pos.feesUsd;
    c.bestTrade = c.bestTrade === null ? pnlUsd : Math.max(c.bestTrade, pnlUsd);
    c.worstTrade = c.worstTrade === null ? pnlUsd : Math.min(c.worstTrade, pnlUsd);
    c.lastTrade = { pnl: pnlUsd, symbol: pos.symbol, ts: now };
    this.cooldown.set(pos.mint, now + this.settings.tokenCooldownMin * 60_000);
    this.log('RISK', 'sell', `${reason} → sold $${pos.symbol} · ${signedUsd(pnlUsd)}`, {
      mint: pos.mint,
      symbol: pos.symbol,
      pnl: pnlUsd,
    });
    this.saveState();
    this.sampleEquity(true);
    this.emit('trade');
  }

  async closeById(id: number, reason = 'manual') {
    const pos = this.positions.find((p) => p.id === id);
    if (!pos) return false;
    await this.closePosition(pos, reason, this.snaps.get(pos.mint) ?? null);
    return true;
  }

  // ------------------------------------------------------------------ equity & stats
  positionValue(p: Position) {
    return p.qty * (p.lastPrice || p.entryPrice);
  }

  equity() {
    return this.cash + this.positions.reduce((s, p) => s + this.positionValue(p), 0);
  }

  sampleEquity(force = false) {
    const now = this.svc.now();
    const eq = this.equity();
    const last = this.curve[this.curve.length - 1];
    if (!force && last && now - last[0] < 10_000) return;
    this.curve.push([now, eq]);
    if (this.curve.length > 20_000) this.curve.splice(0, this.curve.length - 20_000);
    this.db.insertEquity(this.sessionId, now, eq);
    this.emit('equity', [now, eq]);
  }

  stats(): SessionStats {
    return computeStats(this.db.closedPositions(this.sessionId, 100_000), this.curve, this.startEquity, this.equity(), this.counters.killedByRule);
  }

  // ------------------------------------------------------------------ settings & session
  updateSettings(patch: unknown) {
    this.settings = mergeSettings(this.settings, patch);
    this.db.saveSettings(this.settings);
    this.log('SYSTEM', 'info', 'settings updated');
    this.touch();
    return this.settings;
  }

  resetSession(startEquity?: number) {
    const now = this.svc.now();
    // paper positions are closed at their last mark (no quote needed)
    for (const p of this.positions) {
      const value = this.positionValue(p);
      p.status = 'closed';
      p.closedAt = now;
      p.exitPrice = p.lastPrice;
      p.proceedsUsd = value;
      p.pnlUsd = value - p.costUsd;
      p.pnlPct = p.costUsd > 0 ? (p.pnlUsd / p.costUsd) * 100 : 0;
      p.exitReason = 'session reset';
      this.db.updatePosition(p);
      this.cash += value;
    }
    this.positions = [];
    const stats = this.stats();
    this.db.endSession(this.sessionId, now, stats);
    if (startEquity && startEquity > 0) this.updateSettings({ startEquity });
    const s = this.db.createSession(now, this.settings.startEquity, 'paper');
    this.sessionId = s.id;
    this.sessionStartedAt = s.started_at;
    this.startEquity = s.start_equity;
    this.cash = s.cash;
    this.counters = emptyCounters();
    this.watch.clear();
    this.seen.clear();
    this.pairSet.clear();
    this.cooldown.clear();
    this.recentLogs = [];
    this.curve = [];
    this.desk = { scout: null, filter: null, analyst: null, lastBuy: null, lastLog: null };
    this.log('SYSTEM', 'info', `new session · $${this.startEquity.toFixed(2)}`);
    this.sampleEquity(true);
    this.saveState();
    this.emit('reset', stats);
    return stats;
  }

  // ------------------------------------------------------------------ UI snapshot
  snapshot(full = true) {
    const now = this.svc.now();
    const equity = this.equity();
    const c = this.counters;
    const ticker = this.tickerMints().map((m) => {
      const s = this.snaps.get(m)!;
      return { mint: m, symbol: s.symbol, imageUrl: s.imageUrl, priceUsd: s.priceUsd, change: s.priceChange.h1 };
    });
    const positions = this.positions.map((p) => {
      const value = this.positionValue(p);
      const s = this.snaps.get(p.mint);
      return {
        id: p.id,
        mint: p.mint,
        symbol: p.symbol,
        imageUrl: p.imageUrl,
        url: s?.url ?? `https://dexscreener.com/solana/${p.pairAddress}`,
        openedAt: p.openedAt,
        sizeUsd: p.sizeUsd,
        costUsd: p.costUsd,
        entryPrice: p.entryPrice,
        lastPrice: p.lastPrice,
        peakPrice: p.peakPrice,
        value,
        pnlUsd: value - p.costUsd,
        pnlPct: ((p.lastPrice || p.entryPrice) / p.entryPrice - 1) * 100,
        trailActive: p.trailActive,
        score: p.score,
        fillSource: `${p.entryFill.source}/${p.entryFill.router}`,
        status: p.status,
      };
    });
    const base = {
      now,
      mode: this.live.armed ? 'live' : 'paper',
      live: this.live,
      session: { id: this.sessionId, startedAt: this.sessionStartedAt, startEquity: this.startEquity },
      equity,
      cash: this.cash,
      counters: c,
      killedPct: c.scanned ? (c.killed / c.scanned) * 100 : 0,
      watching: this.watch.size,
      desk: this.desk,
      ticker,
      positions,
      rules: RULES,
      maxPositionPct: this.settings.maxPositionPct,
      risk: this.settings.risk,
      minScore: this.settings.analyst.minScore,
      health: this.health,
      solUsd: this.svc.solUsd(),
    };
    if (!full) return base;
    return { ...base, logs: this.recentLogs.slice(-40), curve: downsample(this.curve, 360), settings: this.settings };
  }
}

export function downsample(curve: [number, number][], max: number): [number, number][] {
  if (curve.length <= max) return curve;
  const step = curve.length / max;
  const out: [number, number][] = [];
  for (let i = 0; i < max - 1; i++) out.push(curve[Math.floor(i * step)]);
  out.push(curve[curve.length - 1]);
  return out;
}
