import 'dotenv/config';

/** Runtime settings – editable from the dashboard and persisted in SQLite. */
export interface Settings {
  startEquity: number;
  maxPositionPct: number;
  maxOpenPositions: number;
  tokenCooldownMin: number;
  filter: {
    minLiquidityUsd: number;
    minVolumeUsd: number;
    volumeWindow: 'm5' | 'h1' | 'h6' | 'h24';
    minLpLockedPct: number;
    maxTop10Pct: number;
    maxDevPct: number;
    maxBundlePct: number;
    maxPriceChangeH1: number;
    /** how long a freshly discovered token may "grow into" the liq/vol thresholds */
    watchWindowMin: number;
  };
  analyst: {
    minScore: number;
    ageSweetMin: number;
    ageSweetMax: number;
    weights: {
      momentum: number;
      buySell: number;
      volumeGrowth: number;
      liqFdv: number;
      pairAge: number;
      uniqueBuyers: number;
      rugcheck: number;
    };
  };
  risk: {
    stopLossPct: number;
    trailActivatePct: number;
    trailPct: number;
    timeStopMin: number;
  };
  fills: {
    simFeePct: number;
    priorityFeeSol: number;
  };
}

const num = (v: string | undefined, d: number) => {
  const n = Number(v);
  return v !== undefined && v !== '' && Number.isFinite(n) ? n : d;
};

export function defaultSettings(): Settings {
  const e = process.env;
  return {
    startEquity: num(e.START_EQUITY, 150),
    maxPositionPct: num(e.MAX_POSITION_PCT, 8),
    maxOpenPositions: num(e.MAX_OPEN_POSITIONS, 3),
    tokenCooldownMin: num(e.TOKEN_COOLDOWN_MIN, 30),
    filter: {
      minLiquidityUsd: num(e.FILTER_MIN_LIQ_USD, 40_000),
      minVolumeUsd: num(e.FILTER_MIN_VOL_USD, 50_000),
      volumeWindow: (['m5', 'h1', 'h6', 'h24'].includes(e.FILTER_VOL_WINDOW ?? '')
        ? e.FILTER_VOL_WINDOW
        : 'h1') as Settings['filter']['volumeWindow'],
      minLpLockedPct: num(e.FILTER_MIN_LP_LOCKED_PCT, 90),
      maxTop10Pct: num(e.FILTER_MAX_TOP10_PCT, 25),
      maxDevPct: num(e.FILTER_MAX_DEV_PCT, 3),
      maxBundlePct: num(e.FILTER_MAX_BUNDLE_PCT, 10),
      maxPriceChangeH1: num(e.FILTER_MAX_H1_CHANGE_PCT, 80),
      watchWindowMin: num(e.FILTER_WATCH_WINDOW_MIN, 20),
    },
    analyst: {
      minScore: num(e.ANALYST_MIN_SCORE, 70),
      ageSweetMin: 10,
      ageSweetMax: 120,
      weights: {
        momentum: 20,
        buySell: 15,
        volumeGrowth: 15,
        liqFdv: 15,
        pairAge: 10,
        uniqueBuyers: 10,
        rugcheck: 15,
      },
    },
    risk: {
      stopLossPct: num(e.RISK_STOP_LOSS_PCT, 6),
      trailActivatePct: num(e.RISK_TRAIL_ACTIVATE_PCT, 12),
      trailPct: num(e.RISK_TRAIL_PCT, 6),
      timeStopMin: num(e.RISK_TIME_STOP_MIN, 45),
    },
    fills: {
      simFeePct: 0.3,
      priorityFeeSol: num(e.PRIORITY_FEE_SOL, 0.0001),
    },
  };
}

/** Deep-merge a partial settings patch onto settings, keeping only known keys with matching types. */
export function mergeSettings<T>(base: T, patch: unknown): T {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return base;
  const out: any = Array.isArray(base) ? [...(base as any)] : { ...(base as any) };
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    if (!(k in (base as any))) continue;
    const cur = (base as any)[k];
    if (cur && typeof cur === 'object') out[k] = mergeSettings(cur, v);
    else if (typeof cur === 'number') {
      const n = Number(v);
      if (Number.isFinite(n)) out[k] = n;
    } else if (typeof cur === 'string' && typeof v === 'string') out[k] = v;
    else if (typeof cur === 'boolean' && typeof v === 'boolean') out[k] = v;
  }
  return out;
}

/** Process-level config (env only, not editable at runtime). */
export const env = {
  port: num(process.env.PORT, 8080),
  host: process.env.HOST || '0.0.0.0',
  dbPath: process.env.DB_PATH || './data/grokbot.db',
  password: process.env.DASHBOARD_PASSWORD || '',
  sessionSecret: process.env.SESSION_SECRET || '',
  tradingMode: (process.env.TRADING_MODE === 'live' ? 'live' : 'paper') as 'paper' | 'live',
  liveConfirm: process.env.LIVE_CONFIRM || '',
  jupApiKey: process.env.JUP_API_KEY || '',
  record: (process.env.RECORD ?? 'true') !== 'false',
  recordDir: process.env.RECORD_DIR || './data/recordings',
  recordMaxMb: num(process.env.RECORD_MAX_MB, 300),
  gtPollMs: num(process.env.SCOUT_GT_POLL_MS, 8000),
  dsDiscoveryPollMs: num(process.env.SCOUT_DS_POLL_MS, 15000),
  marketPollMs: num(process.env.MARKET_POLL_MS, 8000),
  riskPollMs: num(process.env.RISK_POLL_MS, 2500),
  rugcheckRps: num(process.env.RUGCHECK_RPS, 2),
};
