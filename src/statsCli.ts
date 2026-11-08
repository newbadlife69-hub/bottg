/** npm run stats – prints stats of the current (and last finished) sessions from SQLite. */
import { computeStats, formatStats } from './stats.js';
import { env } from './config.js';
import { Db } from './db.js';

const db = new Db(env.dbPath);
const sessions = db.listSessions(5);
if (!sessions.length) {
  console.log('No sessions yet.');
  process.exit(0);
}
for (const s of sessions.slice(0, 3)) {
  const counters = JSON.parse(s.counters || '{}');
  const closed = db.closedPositions(s.id, 100_000);
  const curve = db.equityCurve(s.id);
  const end = s.ended_at ? curve[curve.length - 1]?.[1] ?? s.cash : curve[curve.length - 1]?.[1] ?? s.cash;
  const st = computeStats(closed, curve, s.start_equity, end, counters.killedByRule ?? {});
  const when = `${new Date(s.started_at).toISOString().slice(0, 16)} → ${s.ended_at ? new Date(s.ended_at).toISOString().slice(0, 16) : 'running'}`;
  console.log(formatStats(st, `Session #${s.id} (${when}) · scanned ${counters.scanned ?? 0} · killed ${counters.killed ?? 0} · scored ${counters.scored ?? 0}`));
  console.log('');
}
db.close();
