import { Auth } from './auth.js';
import { defaultSettings, env } from './config.js';
import { Db } from './db.js';
import { Engine } from './engine.js';
import { Recorder } from './recorder.js';
import { LiveRunner } from './runner.js';
import { buildServer } from './server.js';
import { LiveServices } from './services.js';
import { setRugcheckRps } from './sources/rugcheck.js';
import { formatStats } from './stats.js';

async function main() {
  if (!env.password && process.env.NODE_ENV === 'production') {
    console.error('DASHBOARD_PASSWORD is required in production (the dashboard is exposed to the internet).');
    process.exit(1);
  }
  setRugcheckRps(env.rugcheckRps);

  const db = new Db(env.dbPath);
  const rec = new Recorder(env.recordDir, env.recordMaxMb, env.record);
  let engine: Engine;
  const svc = new LiveServices(env.jupApiKey, () => engine.settings, rec);
  engine = new Engine(db, svc, defaultSettings(), { marketPollMs: env.marketPollMs });
  engine.init();

  engine.live.requested = env.tradingMode === 'live';
  engine.live.envConfirmed = engine.live.requested && env.liveConfirm === 'I_UNDERSTAND_REAL_MONEY';
  engine.log(
    'SYSTEM',
    'info',
    `start · ${engine.live.requested ? 'LIVE requested (stub, needs dashboard confirmation)' : 'PAPER'} · Jupiter ${
      svc.jup.keyed ? 'with API key' : 'keyless 0.5 rps'
    }`,
  );

  const runner = new LiveRunner(engine, svc, rec);
  runner.start();

  const auth = new Auth(env.password, env.sessionSecret);
  const app = await buildServer(engine, auth);
  await app.listen({ port: env.port, host: env.host });
  console.log(`Grok Bot listening on http://${env.host}:${env.port} · mode=${env.tradingMode} · auth=${auth.required ? 'on' : 'OFF'}`);
  if (!auth.required) console.warn('⚠ DASHBOARD_PASSWORD is empty – dashboard is open. Set it before exposing the server.');

  let shuttingDown = false;
  const shutdown = async (sig: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n${sig} → shutting down`);
    runner.stop();
    engine.saveState();
    console.log(formatStats(engine.stats(), `Session #${engine.sessionId} stats`));
    await app.close().catch(() => {});
    rec.stop();
    db.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
