import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import type { LogEntry, Position, TokenStatus } from './types.js';

export interface SessionRow {
  id: number;
  started_at: number;
  ended_at: number | null;
  start_equity: number;
  cash: number;
  mode: string;
  counters: string;
  stats: string | null;
}

export interface TokenRow {
  mint: string;
  symbol: string;
  name: string;
  image_url: string | null;
  source: string;
  discovered_at: number;
  status: TokenStatus;
  rule: string | null;
  reason: string | null;
  score: number | null;
  decided_at: number | null;
  decimals: number | null;
}

/** All persistence lives here (synchronous better-sqlite3, WAL mode). */
export class Db {
  readonly db: Database.Database;

  constructor(file: string) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    this.db = new Database(file);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.migrate();
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK (id = 1), json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        start_equity REAL NOT NULL,
        cash REAL NOT NULL,
        mode TEXT NOT NULL,
        counters TEXT NOT NULL DEFAULT '{}',
        stats TEXT
      );
      CREATE TABLE IF NOT EXISTS tokens (
        session_id INTEGER NOT NULL,
        mint TEXT NOT NULL,
        symbol TEXT, name TEXT, image_url TEXT, source TEXT,
        discovered_at INTEGER NOT NULL,
        status TEXT NOT NULL,
        rule TEXT, reason TEXT, score REAL, decided_at INTEGER, decimals INTEGER,
        PRIMARY KEY (session_id, mint)
      );
      CREATE INDEX IF NOT EXISTS tokens_status ON tokens(session_id, status);
      CREATE TABLE IF NOT EXISTS positions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id INTEGER NOT NULL,
        mint TEXT NOT NULL,
        status TEXT NOT NULL,
        opened_at INTEGER NOT NULL,
        closed_at INTEGER,
        pnl_usd REAL,
        json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS positions_session ON positions(session_id, status);
      CREATE TABLE IF NOT EXISTS logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id INTEGER NOT NULL,
        ts INTEGER NOT NULL,
        agent TEXT NOT NULL,
        kind TEXT NOT NULL,
        mint TEXT, symbol TEXT, msg TEXT NOT NULL, rule TEXT, pnl REAL
      );
      CREATE INDEX IF NOT EXISTS logs_session ON logs(session_id, id);
      CREATE TABLE IF NOT EXISTS equity (session_id INTEGER NOT NULL, ts INTEGER NOT NULL, equity REAL NOT NULL);
      CREATE INDEX IF NOT EXISTS equity_session ON equity(session_id, ts);
    `);
  }

  // ---------- settings
  loadSettings(): unknown | null {
    const row = this.db.prepare('SELECT json FROM settings WHERE id = 1').get() as { json: string } | undefined;
    return row ? JSON.parse(row.json) : null;
  }
  saveSettings(s: unknown) {
    this.db.prepare('INSERT INTO settings (id, json) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json').run(JSON.stringify(s));
  }

  // ---------- sessions
  currentSession(): SessionRow | null {
    return (this.db.prepare('SELECT * FROM sessions WHERE ended_at IS NULL ORDER BY id DESC LIMIT 1').get() as SessionRow) ?? null;
  }
  createSession(startedAt: number, startEquity: number, mode: string): SessionRow {
    const info = this.db
      .prepare('INSERT INTO sessions (started_at, start_equity, cash, mode, counters) VALUES (?, ?, ?, ?, ?)')
      .run(startedAt, startEquity, startEquity, mode, '{}');
    return this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(info.lastInsertRowid) as SessionRow;
  }
  saveSessionState(id: number, cash: number, counters: unknown) {
    this.db.prepare('UPDATE sessions SET cash = ?, counters = ? WHERE id = ?').run(cash, JSON.stringify(counters), id);
  }
  endSession(id: number, endedAt: number, stats: unknown) {
    this.db.prepare('UPDATE sessions SET ended_at = ?, stats = ? WHERE id = ?').run(endedAt, JSON.stringify(stats), id);
  }
  listSessions(limit = 20): SessionRow[] {
    return this.db.prepare('SELECT * FROM sessions ORDER BY id DESC LIMIT ?').all(limit) as SessionRow[];
  }

  // ---------- tokens
  upsertToken(sessionId: number, t: TokenRow) {
    this.db
      .prepare(
        `INSERT INTO tokens (session_id, mint, symbol, name, image_url, source, discovered_at, status, rule, reason, score, decided_at, decimals)
         VALUES (@session_id, @mint, @symbol, @name, @image_url, @source, @discovered_at, @status, @rule, @reason, @score, @decided_at, @decimals)
         ON CONFLICT(session_id, mint) DO UPDATE SET symbol = excluded.symbol, name = excluded.name, image_url = excluded.image_url,
           status = excluded.status, rule = excluded.rule, reason = excluded.reason, score = excluded.score,
           decided_at = excluded.decided_at, decimals = excluded.decimals`,
      )
      .run({ session_id: sessionId, ...t });
  }
  activeTokens(sessionId: number): TokenRow[] {
    return this.db
      .prepare(`SELECT * FROM tokens WHERE session_id = ? AND status IN ('watching','checking','analysing')`)
      .all(sessionId) as TokenRow[];
  }
  tokenImage(sessionId: number, mint: string): string | null {
    const r = this.db.prepare('SELECT image_url FROM tokens WHERE session_id = ? AND mint = ?').get(sessionId, mint) as { image_url: string | null } | undefined;
    return r?.image_url ?? null;
  }
  latestNamedToken(sessionId: number): TokenRow | null {
    return (this.db
      .prepare(`SELECT * FROM tokens WHERE session_id = ? AND symbol IS NOT NULL AND symbol != '' ORDER BY discovered_at DESC LIMIT 1`)
      .get(sessionId) as TokenRow) ?? null;
  }
  lastLogOfKind(sessionId: number, kind: string, agent?: string): LogEntry | null {
    const row = agent
      ? this.db.prepare('SELECT * FROM logs WHERE session_id = ? AND kind = ? AND agent = ? ORDER BY id DESC LIMIT 1').get(sessionId, kind, agent)
      : this.db.prepare('SELECT * FROM logs WHERE session_id = ? AND kind = ? ORDER BY id DESC LIMIT 1').get(sessionId, kind);
    return (row as LogEntry) ?? null;
  }
  seenMints(sessionId: number, since: number): string[] {
    return (this.db.prepare('SELECT mint FROM tokens WHERE session_id = ? AND discovered_at >= ?').all(sessionId, since) as { mint: string }[]).map(
      (r) => r.mint,
    );
  }

  // ---------- positions
  insertPosition(p: Omit<Position, 'id'>): number {
    const info = this.db
      .prepare('INSERT INTO positions (session_id, mint, status, opened_at, closed_at, pnl_usd, json) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(p.sessionId, p.mint, p.status, p.openedAt, p.closedAt, p.pnlUsd, '{}');
    const id = Number(info.lastInsertRowid);
    this.updatePosition({ ...(p as Position), id });
    return id;
  }
  updatePosition(p: Position) {
    this.db
      .prepare('UPDATE positions SET status = ?, closed_at = ?, pnl_usd = ?, json = ? WHERE id = ?')
      .run(p.status, p.closedAt, p.pnlUsd, JSON.stringify(p), p.id);
  }
  openPositions(sessionId: number): Position[] {
    return (this.db.prepare(`SELECT json FROM positions WHERE session_id = ? AND status != 'closed' ORDER BY id`).all(sessionId) as { json: string }[]).map(
      (r) => JSON.parse(r.json) as Position,
    );
  }
  closedPositions(sessionId: number, limit = 500): Position[] {
    return (
      this.db
        .prepare(`SELECT json FROM positions WHERE session_id = ? AND status = 'closed' ORDER BY closed_at DESC LIMIT ?`)
        .all(sessionId, limit) as { json: string }[]
    ).map((r) => JSON.parse(r.json) as Position);
  }

  // ---------- logs
  insertLog(sessionId: number, l: LogEntry): number {
    const info = this.db
      .prepare('INSERT INTO logs (session_id, ts, agent, kind, mint, symbol, msg, rule, pnl) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(sessionId, l.ts, l.agent, l.kind, l.mint, l.symbol, l.msg, l.rule ?? null, l.pnl ?? null);
    return Number(info.lastInsertRowid);
  }
  recentLogs(sessionId: number, limit = 50, beforeId?: number): LogEntry[] {
    const rows = beforeId
      ? this.db.prepare('SELECT * FROM logs WHERE session_id = ? AND id < ? ORDER BY id DESC LIMIT ?').all(sessionId, beforeId, limit)
      : this.db.prepare('SELECT * FROM logs WHERE session_id = ? ORDER BY id DESC LIMIT ?').all(sessionId, limit);
    return rows as LogEntry[];
  }
  pruneLogs(keep = 100_000) {
    this.db.prepare('DELETE FROM logs WHERE id < (SELECT COALESCE(MAX(id), 0) - ? FROM logs)').run(keep);
  }

  // ---------- equity
  insertEquity(sessionId: number, ts: number, equity: number) {
    this.db.prepare('INSERT INTO equity (session_id, ts, equity) VALUES (?, ?, ?)').run(sessionId, ts, equity);
  }
  equityCurve(sessionId: number): [number, number][] {
    return (this.db.prepare('SELECT ts, equity FROM equity WHERE session_id = ? ORDER BY ts').all(sessionId) as { ts: number; equity: number }[]).map(
      (r) => [r.ts, r.equity],
    );
  }

  close() {
    this.db.close();
  }
}
