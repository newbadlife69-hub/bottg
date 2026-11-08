/**
 * npm run replay -- [files|dirs…] [--set key=value]… [--grid key=v1,v2,…]… [--quiet]
 *
 * Re-runs recorded market data (data/recordings/*.jsonl[.gz]) through the same
 * Engine with a virtual clock and simulated fills, so different filter /
 * analyst / risk settings can be compared on identical history.
 *
 * Examples:
 *   npm run replay
 *   npm run replay -- --set filter.minLiquidityUsd=25000 --set analyst.minScore=65
 *   npm run replay -- --grid filter.minLiquidityUsd=20000,40000,60000 --grid analyst.minScore=60,70
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import zlib from 'node:zlib';
import { RULES } from './agents/filter.js';
import { defaultSettings, type Settings } from './config.js';
import { Db } from './db.js';
import { Engine, type Services } from './engine.js';
import { simBuy, simSell } from './fills.js';
import { RecordingDecoder, type RawRecord, type ReplayEvent } from './recording.js';
import { formatStats, type SessionStats } from './stats.js';
import type { PoolStats, SafetyReport } from './types.js';

export interface ReplayResult {
  label: string;
  stats: SessionStats;
  counters: Engine['counters'];
  events: number;
  spanMin: number;
  openAtEnd: number;
}

export async function* readRecords(file: string): AsyncGenerator<RawRecord> {
  let input: NodeJS.ReadableStream = fs.createReadStream(file);
  if (file.endsWith('.gz')) {
    // tolerate files of a still-running bot (no gzip trailer yet)
    input = input.pipe(zlib.createGunzip({ finishFlush: zlib.constants.Z_SYNC_FLUSH }));
  }
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      yield JSON.parse(line) as RawRecord;
    } catch {
      /* truncated last line */
    }
  }
}

export function findRecordings(inputs: string[]): string[] {
  const out: string[] = [];
  for (const inp of inputs) {
    if (!fs.existsSync(inp)) continue;
    const st = fs.statSync(inp);
    if (st.isDirectory()) {
      for (const f of fs.readdirSync(inp).sort()) if (/\.jsonl(\.gz)?$/.test(f)) out.push(path.join(inp, f));
    } else out.push(inp);
  }
  return out;
}

class ReplayServices implements Services {
  t = 0;
  sol = 0;
  safetyByMint = new Map<string, { t: number; r: SafetyReport }[]>();
  poolByPair = new Map<string, { t: number; s: PoolStats }[]>();
  constructor(private settings: () => Settings) {}

  now() {
    return this.t;
  }
  solUsd() {
    return this.sol;
  }
  /** report fetched for this decision: first one recorded within [t-60s, t+120s], else latest before t */
  private pick<T>(list: { t: number }[] | undefined): T | null {
    if (!list?.length) return null;
    const near = list.find((x) => x.t >= this.t - 60_000 && x.t <= this.t + 120_000);
    if (near) return near as T;
    const before = list.filter((x) => x.t <= this.t);
    return (before[before.length - 1] as T) ?? null;
  }
  async safety(mint: string) {
    return this.pick<{ r: SafetyReport }>(this.safetyByMint.get(mint))?.r ?? null;
  }
  async poolStats(pair: string) {
    return this.pick<{ s: PoolStats }>(this.poolByPair.get(pair))?.s ?? null;
  }
  async quoteBuy(a: Parameters<Services['quoteBuy']>[0]) {
    const f = this.settings().fills;
    return simBuy(a.sizeUsd, { priceUsd: a.snap.priceUsd, liquidityUsd: a.snap.liquidityUsd, solUsd: a.solUsd, decimals: a.decimals, feePct: f.simFeePct, priorityFeeSol: f.priorityFeeSol });
  }
  async quoteSell(a: Parameters<Services['quoteSell']>[0]) {
    if (!a.snap) throw new Error('no price');
    const f = this.settings().fills;
    return simSell(a.pos.qty, a.pos.qtyRaw, { priceUsd: a.snap.priceUsd, liquidityUsd: a.snap.liquidityUsd, solUsd: a.solUsd, decimals: a.pos.decimals, feePct: f.simFeePct, priorityFeeSol: f.priorityFeeSol });
  }
}

export async function runReplay(files: string[], overrides: Record<string, unknown>, label = 'baseline'): Promise<ReplayResult> {
  const db = new Db(':memory:');
  let engine: Engine;
  const svc = new ReplayServices(() => engine.settings);

  // pass 1: index safety / pool / sol records (fetched asynchronously in live mode)
  let firstT = 0;
  for (const file of files) {
    const dec = new RecordingDecoder();
    for await (const raw of readRecords(file)) {
      const ev = dec.decode(raw);
      if (!ev) continue;
      if (!firstT) firstT = ev.t;
      if (ev.type === 'safety') {
        const l = svc.safetyByMint.get(ev.report.mint) ?? [];
        l.push({ t: ev.t, r: ev.report });
        svc.safetyByMint.set(ev.report.mint, l);
      } else if (ev.type === 'pool') {
        const l = svc.poolByPair.get(ev.stats.pairAddress) ?? [];
        l.push({ t: ev.t, s: ev.stats });
        svc.poolByPair.set(ev.stats.pairAddress, l);
      } else if (ev.type === 'sol' && !svc.sol) svc.sol = ev.price;
    }
  }
  svc.t = firstT || Date.now();
  engine = new Engine(db, svc, defaultSettings(), { persistTokens: false, marketPollMs: 8000 });
  engine.init();
  if (Object.keys(overrides).length) engine.updateSettings(overrides);

  // pass 2: drive the engine in recorded order with a virtual clock
  let events = 0;
  let lastTick = svc.t;
  let lastT = svc.t;
  for (const file of files) {
    const dec = new RecordingDecoder();
    for await (const raw of readRecords(file)) {
      const ev: ReplayEvent | null = dec.decode(raw);
      if (!ev) continue;
      svc.t = Math.max(svc.t, ev.t);
      lastT = svc.t;
      events++;
      if (ev.type === 'discover') engine.onDiscovered(ev.tokens);
      else if (ev.type === 'market') {
        engine.onMarket(ev.snaps, ev.requested);
        await engine.idle();
      } else if (ev.type === 'sol') svc.sol = ev.price;
      if (svc.t - lastTick >= 10_000) {
        lastTick = svc.t;
        engine.tick();
        await engine.idle();
        engine.sampleEquity();
      }
    }
  }
  engine.sampleEquity(true);
  const result: ReplayResult = {
    label,
    stats: engine.stats(),
    counters: engine.counters,
    events,
    spanMin: (lastT - firstT) / 60_000,
    openAtEnd: engine.positions.length,
  };
  db.close();
  return result;
}

function parseValue(v: string): unknown {
  const n = Number(v);
  return v !== '' && Number.isFinite(n) ? n : v;
}

function setPath(o: Record<string, any>, key: string, v: unknown) {
  const ks = key.split('.');
  let cur = o;
  for (const k of ks.slice(0, -1)) cur = cur[k] ??= {};
  cur[ks[ks.length - 1]] = v;
}

async function main() {
  const args = process.argv.slice(2);
  const inputs: string[] = [];
  const sets: Record<string, unknown> = {};
  const grid: [string, unknown[]][] = [];
  let quiet = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--set') {
      const [k, v] = args[++i].split('=');
      setPath(sets, k, parseValue(v));
    } else if (a === '--grid') {
      const [k, v] = args[++i].split('=');
      grid.push([k, v.split(',').map(parseValue)]);
    } else if (a === '--quiet') quiet = true;
    else inputs.push(a);
  }
  let files = findRecordings(inputs.length ? inputs : [process.env.RECORD_DIR || './data/recordings']);
  if (!files.length) files = findRecordings(['test/fixtures/replay-sample.jsonl.gz']);
  if (!files.length) {
    console.error('No recordings found. Run the bot with RECORD=true first (data/recordings).');
    process.exit(1);
  }
  console.log(`Replaying ${files.length} file(s): ${files.map((f) => path.basename(f)).join(', ')}`);

  // cartesian product of grid values on top of --set
  let variants: { label: string; patch: Record<string, unknown> }[] = [{ label: 'baseline', patch: structuredClone(sets) }];
  for (const [k, vals] of grid) {
    variants = variants.flatMap((v) =>
      vals.map((val) => {
        const patch = structuredClone(v.patch);
        setPath(patch, k, val);
        return { label: (v.label === 'baseline' ? '' : v.label + ' ') + `${k.split('.').pop()}=${val}`, patch };
      }),
    );
  }
  if (Object.keys(sets).length && !grid.length) variants[0].label = Object.entries(flatten(sets)).map(([k, v]) => `${k.split('.').pop()}=${v}`).join(' ');

  const results: ReplayResult[] = [];
  for (const v of variants) {
    const r = await runReplay(files, v.patch, v.label);
    results.push(r);
    if (!quiet) {
      const c = r.counters;
      console.log(`\n### ${r.label}  (${r.events} events, ${r.spanMin.toFixed(1)} min of market data)`);
      console.log(`scanned ${c.scanned} · killed ${c.killed} · scored ${c.scored} · traded ${c.traded} · no data ${c.expired} · open at end ${r.openAtEnd}`);
      if (c.expired) console.log(`  (${c.expired} token(s) passed liq/vol here but have no recorded RugCheck report – the live bot never checked them)`);
      console.log(formatStats(r.stats, 'Replay stats'));
    }
  }
  if (results.length > 1) {
    console.log('\n' + ['variant'.padEnd(34), 'kill%', 'scored', 'trades', 'win%', 'net PnL', 'maxDD%'].join('  '));
    for (const r of results) {
      const c = r.counters;
      console.log(
        [
          r.label.padEnd(34).slice(0, 34),
          (c.scanned ? ((c.killed / c.scanned) * 100).toFixed(0) + '%' : '—').padStart(5),
          String(c.scored).padStart(6),
          String(r.stats.trades).padStart(6),
          r.stats.winrate.toFixed(0).padStart(4),
          ((r.stats.netPnlUsd >= 0 ? '+' : '') + r.stats.netPnlUsd.toFixed(2)).padStart(8),
          r.stats.maxDrawdownPct.toFixed(1).padStart(6),
        ].join('  '),
      );
    }
    console.log(`\nkills by rule: ${RULES.map((x) => x.id).join(', ')}`);
    for (const r of results) console.log(`  ${r.label.padEnd(34).slice(0, 34)} ${RULES.map((x) => r.counters.killedByRule[x.id]).join(' / ')}`);
  }
}

function flatten(o: Record<string, any>, pre = ''): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    if (v && typeof v === 'object') Object.assign(out, flatten(v, pre + k + '.'));
    else out[pre + k] = v;
  }
  return out;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]).replace(/\.(ts|js)$/, '') === path.resolve(new URL(import.meta.url).pathname).replace(/\.(ts|js)$/, '');
if (isMain) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
