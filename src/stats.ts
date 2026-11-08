import { RULES } from './agents/filter.js';
import type { Position, RuleId } from './types.js';

export interface SessionStats {
  trades: number;
  wins: number;
  losses: number;
  winrate: number;
  avgWinUsd: number;
  avgLossUsd: number;
  avgWinPct: number;
  avgLossPct: number;
  profitFactor: number | null;
  netPnlUsd: number;
  feesUsd: number;
  grossPnlUsd: number;
  maxDrawdownUsd: number;
  maxDrawdownPct: number;
  bestUsd: number | null;
  worstUsd: number | null;
  startEquity: number;
  endEquity: number;
  returnPct: number;
  killsByRule: Record<RuleId, number>;
  exitReasons: Record<string, number>;
}

export function maxDrawdown(curve: [number, number][]): { usd: number; pct: number } {
  let peak = -Infinity;
  let usd = 0;
  let pct = 0;
  for (const [, eq] of curve) {
    if (eq > peak) peak = eq;
    const dd = peak - eq;
    if (dd > usd) usd = dd;
    if (peak > 0 && dd / peak > pct) pct = dd / peak;
  }
  return { usd, pct: pct * 100 };
}

export function computeStats(
  closed: Position[],
  curve: [number, number][],
  startEquity: number,
  endEquity: number,
  killsByRule: Record<RuleId, number>,
): SessionStats {
  const pnls = closed.map((p) => p.pnlUsd ?? 0);
  const wins = closed.filter((p) => (p.pnlUsd ?? 0) > 0);
  const losses = closed.filter((p) => (p.pnlUsd ?? 0) <= 0);
  const sum = (a: number[]) => a.reduce((s, x) => s + x, 0);
  const avg = (a: number[]) => (a.length ? sum(a) / a.length : 0);
  const grossWin = sum(wins.map((p) => p.pnlUsd ?? 0));
  const grossLoss = -sum(losses.map((p) => p.pnlUsd ?? 0));
  const fees = sum(closed.map((p) => p.feesUsd ?? 0));
  const net = sum(pnls);
  const dd = maxDrawdown([...curve, [Date.now(), endEquity]]);
  const exitReasons: Record<string, number> = {};
  for (const p of closed) {
    const key = (p.exitReason ?? 'other').split(' ')[0];
    exitReasons[key] = (exitReasons[key] ?? 0) + 1;
  }
  const kills = Object.fromEntries(RULES.map((r) => [r.id, killsByRule?.[r.id] ?? 0])) as Record<RuleId, number>;
  return {
    trades: closed.length,
    wins: wins.length,
    losses: losses.length,
    winrate: closed.length ? (wins.length / closed.length) * 100 : 0,
    avgWinUsd: avg(wins.map((p) => p.pnlUsd ?? 0)),
    avgLossUsd: avg(losses.map((p) => p.pnlUsd ?? 0)),
    avgWinPct: avg(wins.map((p) => p.pnlPct ?? 0)),
    avgLossPct: avg(losses.map((p) => p.pnlPct ?? 0)),
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : null,
    netPnlUsd: net,
    feesUsd: fees,
    grossPnlUsd: net + fees,
    maxDrawdownUsd: dd.usd,
    maxDrawdownPct: dd.pct,
    bestUsd: pnls.length ? Math.max(...pnls) : null,
    worstUsd: pnls.length ? Math.min(...pnls) : null,
    startEquity,
    endEquity,
    returnPct: startEquity > 0 ? (endEquity / startEquity - 1) * 100 : 0,
    killsByRule: kills,
    exitReasons,
  };
}

export function formatStats(s: SessionStats, title = 'Session stats'): string {
  const f = (x: number, d = 2) => x.toFixed(d);
  const lines = [
    `── ${title} ──`,
    `equity        $${f(s.startEquity)} → $${f(s.endEquity)} (${s.returnPct >= 0 ? '+' : ''}${f(s.returnPct)}%)`,
    `trades        ${s.trades}  (W ${s.wins} / L ${s.losses})  winrate ${f(s.winrate, 1)}%`,
    `avg win       $${f(s.avgWinUsd)} (${f(s.avgWinPct, 1)}%)   avg loss $${f(s.avgLossUsd)} (${f(s.avgLossPct, 1)}%)`,
    `profit factor ${s.profitFactor === null ? '—' : f(s.profitFactor)}`,
    `PnL net/fees  $${f(s.netPnlUsd)} after $${f(s.feesUsd)} fees (gross $${f(s.grossPnlUsd)})`,
    `max drawdown  $${f(s.maxDrawdownUsd)} (${f(s.maxDrawdownPct, 1)}%)`,
    `exits         ${Object.entries(s.exitReasons).map(([k, v]) => `${k}:${v}`).join('  ') || '—'}`,
    `kills by rule ${RULES.map((r) => `${r.id}:${s.killsByRule[r.id]}`).join('  ')}`,
  ];
  return lines.join('\n');
}
