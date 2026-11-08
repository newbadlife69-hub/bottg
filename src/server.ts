import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import path from 'node:path';
import type { ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import { Auth } from './auth.js';
import type { Engine } from './engine.js';
import { formatStats } from './stats.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const PUBLIC_DIR = path.resolve(here, '..', 'public');

export const LIVE_PHRASE = 'LIVE';

export async function buildServer(engine: Engine, auth: Auth) {
  const app = Fastify({ logger: false, trustProxy: true, bodyLimit: 64 * 1024 });
  await app.register(cookie);

  const clients = new Set<ServerResponse>();

  // ---------------------------------------------------------------- auth guard
  app.addHook('onRequest', async (req, reply) => {
    const url = req.url.split('?')[0];
    if (!url.startsWith('/api/')) return;
    if (url === '/api/login' || url === '/api/health' || url === '/api/me') return;
    if (!auth.verify(req.cookies[Auth.COOKIE])) {
      reply.code(401).send({ error: 'unauthorized' });
    }
  });

  app.get('/api/health', async () => ({ ok: true, uptime: Math.round(process.uptime()) }));

  app.get('/api/me', async (req) => ({
    auth: auth.verify(req.cookies[Auth.COOKIE]),
    passwordRequired: auth.required,
  }));

  app.post('/api/login', async (req, reply) => {
    const ip = req.ip;
    if (!auth.allowAttempt(ip)) return reply.code(429).send({ error: 'Za dużo prób. Spróbuj za 15 minut.' });
    const { password } = (req.body ?? {}) as { password?: string };
    if (auth.required && !auth.checkPassword(password ?? '')) return reply.code(401).send({ error: 'Złe hasło' });
    auth.resetAttempts(ip);
    reply.setCookie(Auth.COOKIE, auth.issue(), {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: req.protocol === 'https',
      maxAge: Auth.MAX_AGE_S,
    });
    return { ok: true };
  });

  app.post('/api/logout', async (_req, reply) => {
    reply.clearCookie(Auth.COOKIE, { path: '/' });
    return { ok: true };
  });

  // ---------------------------------------------------------------- data
  app.get('/api/state', async () => engine.snapshot(true));

  app.get('/api/logs', async (req) => {
    const q = req.query as { before?: string; limit?: string };
    const limit = Math.min(200, Number(q.limit) || 100);
    return engine.db.recentLogs(engine.sessionId, limit, q.before ? Number(q.before) : undefined);
  });

  app.get('/api/trades', async () =>
    engine.db.closedPositions(engine.sessionId, 300).map((p) => ({
      id: p.id,
      mint: p.mint,
      symbol: p.symbol,
      imageUrl: p.imageUrl,
      openedAt: p.openedAt,
      closedAt: p.closedAt,
      sizeUsd: p.sizeUsd,
      costUsd: p.costUsd,
      proceedsUsd: p.proceedsUsd,
      pnlUsd: p.pnlUsd,
      pnlPct: p.pnlPct,
      exitReason: p.exitReason,
      score: p.score,
      entry: `${p.entryFill.source}/${p.entryFill.router}`,
      exit: p.exitFill ? `${p.exitFill.source}/${p.exitFill.router}` : '—',
      feesUsd: p.feesUsd,
      url: `https://dexscreener.com/solana/${p.pairAddress}`,
    })),
  );

  app.get('/api/stats', async () => {
    const s = engine.stats();
    return { stats: s, text: formatStats(s), sessions: engine.db.listSessions(10).map((r) => ({ ...r, counters: undefined })) };
  });

  app.get('/api/settings', async () => engine.settings);
  app.put('/api/settings', async (req) => engine.updateSettings(req.body));

  app.post('/api/session/reset', async (req) => {
    const { startEquity } = (req.body ?? {}) as { startEquity?: number };
    const stats = engine.resetSession(Number(startEquity) || undefined);
    broadcast('snapshot', engine.snapshot(true));
    return { ok: true, stats, text: formatStats(stats, 'Previous session') };
  });

  app.post('/api/positions/:id/close', async (req, reply) => {
    const ok = await engine.closeById(Number((req.params as any).id), 'manual');
    if (!ok) return reply.code(404).send({ error: 'not found' });
    return { ok };
  });

  // LIVE is a stub: requires TRADING_MODE=live + LIVE_CONFIRM in env (1st confirmation)
  // and the typed phrase from the dashboard (2nd confirmation). Signing is not implemented.
  app.post('/api/live/arm', async (req, reply) => {
    const { phrase, confirmed } = (req.body ?? {}) as { phrase?: string; confirmed?: boolean };
    if (!engine.live.requested) return reply.code(400).send({ error: 'TRADING_MODE=live nie jest ustawione w .env' });
    if (!engine.live.envConfirmed) return reply.code(400).send({ error: 'Brak LIVE_CONFIRM=I_UNDERSTAND_REAL_MONEY w .env' });
    if (confirmed !== true || phrase !== LIVE_PHRASE) return reply.code(400).send({ error: 'Potwierdzenie nieprawidłowe' });
    engine.live.armed = true;
    engine.log('SYSTEM', 'warn', 'LIVE armed (stub) – no transactions are signed or sent');
    return { ok: true, live: engine.live };
  });
  app.post('/api/live/disarm', async () => {
    engine.live.armed = false;
    engine.log('SYSTEM', 'info', 'LIVE disarmed – paper mode');
    return { ok: true, live: engine.live };
  });

  // ---------------------------------------------------------------- SSE
  app.get('/api/stream', (req: FastifyRequest, reply: FastifyReply) => {
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write(`retry: 3000\n\n`);
    send(res, 'snapshot', engine.snapshot(true));
    clients.add(res);
    req.raw.on('close', () => clients.delete(res));
  });

  function send(res: ServerResponse, event: string, data: unknown) {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }
  function broadcast(event: string, data: unknown) {
    if (!clients.size) return;
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of clients) c.write(payload);
  }

  engine.on('log', (l) => broadcast('log', l));
  engine.on('equity', (p) => broadcast('equity', p));
  engine.on('trade', () => broadcast('trade', {}));
  engine.on('reset', () => broadcast('snapshot', engine.snapshot(true)));
  const tickTimer = setInterval(() => {
    if (engine.isDirty()) broadcast('tick', engine.snapshot(false));
  }, 1000);
  const pingTimer = setInterval(() => {
    // a named event (not a comment) so the client watchdog can see it
    for (const c of clients) c.write(`event: ping\ndata: ${Date.now()}\n\n`);
  }, 15_000);
  app.addHook('onClose', async () => {
    clearInterval(tickTimer);
    clearInterval(pingTimer);
    for (const c of clients) c.end();
  });

  // ---------------------------------------------------------------- static shell (PWA)
  await app.register(fastifyStatic, {
    root: PUBLIC_DIR,
    index: ['index.html'],
    cacheControl: false, // we set it ourselves below
    setHeaders(res, file) {
      const base = path.basename(file);
      if (base === 'index.html' || base === 'sw.js' || base.endsWith('.webmanifest')) {
        res.setHeader('cache-control', 'no-cache');
      } else res.setHeader('cache-control', 'public, max-age=86400');
      if (base === 'sw.js') res.setHeader('service-worker-allowed', '/');
    },
  });

  return app;
}
