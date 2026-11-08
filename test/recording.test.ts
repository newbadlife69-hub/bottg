import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { RecordingDecoder, RecordingEncoder, type RawRecord } from '../src/recording.js';
import { runReplay } from '../src/replay.js';
import { goodSnap } from './helpers.js';

describe('recording codec', () => {
  it('round-trips snapshots and carries unchanged ones forward', () => {
    const out: RawRecord[] = [];
    const enc = new RecordingEncoder((r) => out.push(JSON.parse(JSON.stringify(r))));
    const t = 1_700_000_000_000;
    const a = goodSnap('mintA', t, 0.001);
    const b = goodSnap('mintB', t, 0.002);
    enc.market(['mintA', 'mintB', 'mintC'], [a, b], t);
    enc.market(['mintA', 'mintB'], [a, { ...b, priceUsd: 0.0025 }], t + 8000); // A unchanged
    const marketRecs = out.filter((r) => r.type === 'market');
    expect(marketRecs[1].data.s).toHaveLength(1); // only B was written again

    const dec = new RecordingDecoder();
    const evs = out.map((r) => dec.decode(r)).filter(Boolean) as any[];
    expect(evs).toHaveLength(2);
    expect(evs[0].requested).toEqual(['mintA', 'mintB', 'mintC']);
    expect(evs[0].snaps.has('mintC')).toBe(false); // no pair
    const second = evs[1];
    expect(second.snaps.get('mintA').priceUsd).toBe(0.001);
    expect(second.snaps.get('mintA').ts).toBe(t + 8000);
    expect(second.snaps.get('mintB').priceUsd).toBe(0.0025);
    expect(second.snaps.get('mintB').liquidityUsd).toBe(b.liquidityUsd);
    expect(second.snaps.get('mintB').symbol).toBe('GOOD');
  });
});

const sample = path.join(__dirname, 'fixtures', 'replay-sample.jsonl.gz');
describe.skipIf(!fs.existsSync(sample))('replay on a real recording', () => {
  // the sample covers a few minutes, so use a short watch window to get verdicts
  it('is deterministic and settings change the outcome', async () => {
    const base = { filter: { watchWindowMin: 2 } };
    const a = await runReplay([sample], base);
    const b = await runReplay([sample], base);
    expect(a.counters.scanned).toBeGreaterThan(10);
    expect(a.counters.killed).toBeGreaterThan(10);
    expect(a.counters).toEqual(b.counters);
    const loose = await runReplay([sample], { filter: { watchWindowMin: 2, minLiquidityUsd: 1_000, minVolumeUsd: 1_000 } });
    expect(loose.counters.killedByRule.liquidity).toBeLessThan(a.counters.killedByRule.liquidity);
  }, 60_000);
});
