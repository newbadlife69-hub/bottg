import type { DiscoveredToken, MarketSnapshot, PoolStats, SafetyReport } from './types.js';

/**
 * Compact recording codec (JSON lines, gzip on disk).
 *  - every mint gets a small integer id per file ("id" record)
 *  - static pair data (symbol, image, pair address…) is written once ("meta")
 *  - market batches store numeric tuples and only snapshots that changed;
 *    the decoder carries the last known snapshot forward for requested mints
 */
export type RawRecord = { t: number; type: string; data: any };

export type ReplayEvent =
  | { t: number; type: 'discover'; tokens: DiscoveredToken[] }
  | { t: number; type: 'market'; requested: string[]; snaps: Map<string, MarketSnapshot> }
  | { t: number; type: 'safety'; report: SafetyReport }
  | { t: number; type: 'pool'; stats: PoolStats }
  | { t: number; type: 'sol'; price: number };

type Meta = Pick<MarketSnapshot, 'symbol' | 'name' | 'imageUrl' | 'pairAddress' | 'dexId' | 'pairCreatedAt' | 'url'>;

const metaKey = (m: Meta) => `${m.pairAddress}|${m.symbol}|${m.imageUrl ?? ''}|${m.pairCreatedAt ?? ''}`;

const usd = (x: number) => Math.round(x);
const pct2 = (x: number) => Math.round(x * 100) / 100;
const tuple = (s: MarketSnapshot): number[] => [
  s.priceUsd,
  s.priceNative,
  usd(s.liquidityUsd),
  usd(s.fdv),
  usd(s.marketCap),
  usd(s.volume.m5),
  usd(s.volume.h1),
  usd(s.volume.h6),
  usd(s.volume.h24),
  pct2(s.priceChange.m5),
  pct2(s.priceChange.h1),
  pct2(s.priceChange.h6),
  pct2(s.priceChange.h24),
  s.txns.m5.buys,
  s.txns.m5.sells,
  s.txns.h1.buys,
  s.txns.h1.sells,
  s.txns.h6.buys,
  s.txns.h6.sells,
  s.txns.h24.buys,
  s.txns.h24.sells,
];

export class RecordingEncoder {
  private ids = new Map<string, number>();
  private metas = new Map<number, string>();
  private last = new Map<number, string>();
  private discovered = new Set<string>();

  constructor(private emit: (r: RawRecord) => void) {}

  private id(mint: string, t: number): number {
    let id = this.ids.get(mint);
    if (id === undefined) {
      id = this.ids.size + 1;
      this.ids.set(mint, id);
      this.emit({ t, type: 'id', data: [id, mint] });
    }
    return id;
  }

  discover(tokens: DiscoveredToken[], t: number) {
    // the engine only acts on the first sighting of a mint → record each mint once per file
    const fresh = tokens.filter((tk) => !this.discovered.has(tk.mint));
    if (!fresh.length) return;
    for (const tk of fresh) this.discovered.add(tk.mint);
    this.emit({ t, type: 'discover', data: fresh.map((tk) => ({ ...tk, id: this.id(tk.mint, t) })) });
  }

  market(requested: string[], snaps: MarketSnapshot[], t: number) {
    const r = requested.map((m) => this.id(m, t));
    const s: number[][] = [];
    for (const snap of snaps) {
      const id = this.id(snap.mint, t);
      const meta: Meta = {
        symbol: snap.symbol,
        name: snap.name,
        imageUrl: snap.imageUrl,
        pairAddress: snap.pairAddress,
        dexId: snap.dexId,
        pairCreatedAt: snap.pairCreatedAt,
        url: snap.url,
      };
      const mk = metaKey(meta);
      if (this.metas.get(id) !== mk) {
        this.metas.set(id, mk);
        const { url: _url, ...compact } = meta; // url is rebuilt from pairAddress
        this.emit({ t, type: 'meta', data: { id, ...compact } });
      }
      const tp = tuple(snap);
      const key = tp.join(',');
      if (this.last.get(id) === key) continue; // unchanged since last record
      this.last.set(id, key);
      s.push([id, ...tp]);
    }
    this.emit({ t, type: 'market', data: { r, s } });
  }

  other(type: 'safety' | 'pool' | 'sol', data: unknown, t: number) {
    this.emit({ t, type, data });
  }
}

export class RecordingDecoder {
  private mints = new Map<number, string>();
  private metas = new Map<number, Meta>();
  private last = new Map<number, MarketSnapshot>();

  /** Feed one raw record; returns an event for the engine (or null for bookkeeping records). */
  decode(rec: RawRecord): ReplayEvent | null {
    const { t, type, data } = rec;
    switch (type) {
      case 'id':
        this.mints.set(data[0], data[1]);
        return null;
      case 'meta': {
        const { id, ...m } = data;
        this.metas.set(id, { ...m, url: m.url ?? `https://dexscreener.com/solana/${m.pairAddress}` });
        return null;
      }
      case 'discover':
        return { t, type: 'discover', tokens: data.map(({ id: _id, ...tk }: any) => tk as DiscoveredToken) };
      case 'market': {
        // legacy (uncompressed) format: { requested, snaps }
        if (Array.isArray(data.snaps)) {
          const snaps = new Map<string, MarketSnapshot>();
          for (const s of data.snaps) snaps.set(s.mint, { ...s, ts: t });
          return { t, type: 'market', requested: data.requested ?? [], snaps };
        }
        for (const row of data.s as number[][]) {
          const [id, ...v] = row;
          const mint = this.mints.get(id);
          const meta = this.metas.get(id);
          if (!mint || !meta) continue;
          this.last.set(id, {
            mint,
            ...meta,
            priceUsd: v[0],
            priceNative: v[1],
            liquidityUsd: v[2],
            fdv: v[3],
            marketCap: v[4],
            volume: { m5: v[5], h1: v[6], h6: v[7], h24: v[8] },
            priceChange: { m5: v[9], h1: v[10], h6: v[11], h24: v[12] },
            txns: {
              m5: { buys: v[13], sells: v[14] },
              h1: { buys: v[15], sells: v[16] },
              h6: { buys: v[17], sells: v[18] },
              h24: { buys: v[19], sells: v[20] },
            },
            ts: t,
          });
        }
        const requested: string[] = [];
        const snaps = new Map<string, MarketSnapshot>();
        const touched = new Set<number>([...(data.r as number[]), ...(data.s as number[][]).map((x) => x[0])]);
        for (const id of data.r as number[]) {
          const m = this.mints.get(id);
          if (m) requested.push(m);
        }
        for (const id of touched) {
          const s = this.last.get(id);
          if (s) snaps.set(s.mint, { ...s, ts: t });
        }
        return { t, type: 'market', requested, snaps };
      }
      case 'safety':
        return { t, type: 'safety', report: data };
      case 'pool':
        return { t, type: 'pool', stats: data };
      case 'sol':
        return { t, type: 'sol', price: Number(data) };
      default:
        return null;
    }
  }
}
