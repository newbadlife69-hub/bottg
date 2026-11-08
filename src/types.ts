export type AgentName = 'SCOUT' | 'FILTER' | 'ANALYST' | 'EXECUTOR' | 'RISK' | 'LOGGER' | 'SYSTEM';

export type DiscoverySource = 'geckoterminal' | 'ds-profile' | 'ds-boost' | 'replay';

export interface DiscoveredToken {
  mint: string;
  symbol: string;
  name: string;
  imageUrl: string | null;
  decimals: number | null;
  source: DiscoverySource;
  poolAddress: string | null;
  poolCreatedAt: number | null;
}

export interface TxnCount {
  buys: number;
  sells: number;
}

/** Normalised DexScreener pair (the most liquid pair of a token). */
export interface MarketSnapshot {
  mint: string;
  symbol: string;
  name: string;
  pairAddress: string;
  dexId: string;
  url: string;
  priceUsd: number;
  priceNative: number;
  liquidityUsd: number;
  fdv: number;
  marketCap: number;
  volume: { m5: number; h1: number; h6: number; h24: number };
  priceChange: { m5: number; h1: number; h6: number; h24: number };
  txns: { m5: TxnCount; h1: TxnCount; h6: TxnCount; h24: TxnCount };
  pairCreatedAt: number | null;
  imageUrl: string | null;
  ts: number;
}

export interface RiskFlag {
  name: string;
  level: string;
  score: number;
  value: string;
}

/** Normalised RugCheck report – only what the filter/analyst need. */
export interface SafetyReport {
  mint: string;
  mintAuthority: string | null;
  freezeAuthority: string | null;
  supply: number;
  decimals: number;
  creator: string | null;
  creatorBalance: number;
  devPct: number;
  top10Pct: number;
  top10Count: number;
  lpLockedPct: number;
  bundlePct: number;
  bundleSource: string;
  scoreNormalised: number;
  rugged: boolean;
  risks: RiskFlag[];
  totalHolders: number;
  fetchedAt: number;
}

export interface PoolStats {
  pairAddress: string;
  buyersM5: number;
  buyersH1: number;
  sellersH1: number;
  ts: number;
}

export type RuleId =
  | 'liquidity'
  | 'volume'
  | 'mintAuthority'
  | 'freezeAuthority'
  | 'lpLocked'
  | 'top10'
  | 'devHolding'
  | 'bundled'
  | 'pumped';

export interface Kill {
  rule: RuleId;
  reason: string;
}

export interface Fill {
  source: 'jupiter' | 'sim';
  router: string;
  inAmountRaw: string;
  outAmountRaw: string;
  inUi: number;
  outUi: number;
  priceImpactPct: number;
  feeBps: number;
  /** extra network fees paid in SOL (priority + signature + rent) */
  networkFeeSol: number;
}

export type TokenStatus = 'watching' | 'checking' | 'analysing' | 'killed' | 'scored' | 'traded';

export interface LogEntry {
  id?: number;
  ts: number;
  agent: AgentName;
  kind: 'kill' | 'score' | 'buy' | 'sell' | 'info' | 'warn' | 'skip';
  mint: string | null;
  symbol: string | null;
  msg: string;
  rule?: RuleId | null;
  pnl?: number | null;
}

export interface Position {
  id: number;
  sessionId: number;
  mint: string;
  symbol: string;
  name: string;
  imageUrl: string | null;
  pairAddress: string;
  decimals: number;
  status: 'open' | 'closing' | 'closed';
  openedAt: number;
  entryPrice: number;
  qtyRaw: string;
  qty: number;
  sizeUsd: number;
  costUsd: number;
  entryFill: Fill;
  score: number;
  peakPrice: number;
  lastPrice: number;
  lastPriceAt: number;
  trailActive: boolean;
  closedAt: number | null;
  exitPrice: number | null;
  proceedsUsd: number | null;
  pnlUsd: number | null;
  pnlPct: number | null;
  exitReason: string | null;
  exitFill: Fill | null;
  feesUsd: number;
}
