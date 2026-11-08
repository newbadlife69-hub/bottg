import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { RecordingEncoder, type RawRecord } from './recording.js';
import type { DiscoveredToken, MarketSnapshot } from './types.js';

/**
 * Records the normalised data the engine consumed into gzip'ed JSONL files
 * (one per process start and per UTC day). `npm run replay` feeds these back
 * through the same engine so filter settings can be compared on identical
 * market history. Oldest files are deleted above RECORD_MAX_MB.
 */
export class Recorder {
  private gz: zlib.Gzip | null = null;
  private file = '';
  private day = '';
  private enc: RecordingEncoder | null = null;
  private flushTimer: NodeJS.Timeout | null = null;
  private written = 0;

  constructor(
    private dir: string,
    private maxMb: number,
    private enabled: boolean,
  ) {
    if (enabled) {
      fs.mkdirSync(dir, { recursive: true });
      this.flushTimer = setInterval(() => this.gz?.flush(zlib.constants.Z_SYNC_FLUSH), 30_000);
      this.flushTimer.unref();
    }
  }

  private ensure(t: number): RecordingEncoder | null {
    if (!this.enabled) return null;
    const day = new Date(t).toISOString().slice(0, 10);
    if (day !== this.day || !this.enc) {
      this.close();
      this.day = day;
      const stamp = new Date(t).toISOString().slice(11, 19).replace(/:/g, '');
      this.file = path.join(this.dir, `rec-${day}-${stamp}.jsonl.gz`);
      this.gz = zlib.createGzip({ level: 6 });
      this.gz.pipe(fs.createWriteStream(this.file));
      this.enc = new RecordingEncoder((r: RawRecord) => {
        const line = JSON.stringify(r) + '\n';
        this.written += line.length;
        this.gz!.write(line);
      });
      this.enforceLimit();
    }
    if (this.written > 50 * 1024 * 1024) {
      this.written = 0;
      this.enforceLimit();
    }
    return this.enc;
  }

  discover(tokens: DiscoveredToken[], t = Date.now()) {
    this.ensure(t)?.discover(tokens, t);
  }
  market(requested: string[], snaps: MarketSnapshot[], t = Date.now()) {
    this.ensure(t)?.market(requested, snaps, t);
  }
  write(type: 'safety' | 'pool' | 'sol', data: unknown, t = Date.now()) {
    this.ensure(t)?.other(type, data, t);
  }

  /** Delete the oldest recordings once the directory exceeds RECORD_MAX_MB. */
  private enforceLimit() {
    try {
      const files = fs
        .readdirSync(this.dir)
        .filter((f) => f.startsWith('rec-'))
        .map((f) => ({ f: path.join(this.dir, f), st: fs.statSync(path.join(this.dir, f)) }))
        .sort((a, b) => a.st.mtimeMs - b.st.mtimeMs);
      let total = files.reduce((s, x) => s + x.st.size, 0);
      const limit = this.maxMb * 1024 * 1024;
      for (const x of files) {
        if (total <= limit) break;
        if (x.f === this.file) continue;
        fs.unlinkSync(x.f);
        total -= x.st.size;
      }
    } catch {
      /* ignore */
    }
  }

  close() {
    this.gz?.end();
    this.gz = null;
    this.enc = null;
  }

  stop() {
    if (this.flushTimer) clearInterval(this.flushTimer);
    this.close();
  }
}
