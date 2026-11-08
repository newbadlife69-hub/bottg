import { getJson, HttpError } from '../util/http.js';
import { RateLimiter } from '../util/limiter.js';
import type { RiskFlag, SafetyReport } from '../types.js';

const BASE = 'https://api.rugcheck.xyz/v1';
export const rugcheckLimiter = new RateLimiter('rugcheck', 500, 2);

const cache = new Map<string, { at: number; report: SafetyReport; raw: any }>();
const inflight = new Map<string, Promise<{ report: SafetyReport; raw: any } | null>>();
export const RUGCHECK_CACHE_MS = 60_000;

export function setRugcheckRps(rps: number) {
  rugcheckLimiter.setInterval(Math.max(100, Math.round(1000 / Math.max(0.1, rps))));
}

/** Fetch + normalise a RugCheck report. 60 s cache per mint, de-duplicated in-flight. */
export async function fetchSafety(mint: string, prio = 5): Promise<{ report: SafetyReport; raw: any } | null> {
  const hit = cache.get(mint);
  if (hit && Date.now() - hit.at < RUGCHECK_CACHE_MS) return { report: hit.report, raw: hit.raw };
  const pending = inflight.get(mint);
  if (pending) return pending;
  const p = (async () => {
    try {
      const raw = await getJson<any>(`${BASE}/tokens/${mint}/report`, { limiter: rugcheckLimiter, prio, timeoutMs: 20_000 });
      const report = normalizeRugcheck(raw);
      cache.set(mint, { at: Date.now(), report, raw });
      if (cache.size > 2000) {
        const cutoff = Date.now() - RUGCHECK_CACHE_MS;
        for (const [k, v] of cache) if (v.at < cutoff) cache.delete(k);
      }
      return { report, raw };
    } catch (err) {
      if (err instanceof HttpError && (err.status === 404 || err.status === 400)) return null;
      throw err;
    } finally {
      inflight.delete(mint);
    }
  })();
  inflight.set(mint, p);
  return p;
}

const num = (v: unknown) => {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
};

const PCT_RE = /(\d+(?:\.\d+)?)\s*%/;

/**
 * Turn a raw RugCheck report into the numbers our rules use.
 *  - top10Pct excludes LP vaults / AMM pools / lockers (markets[] + knownAccounts AMM|LOCKER)
 *  - lpLockedPct is liquidity-weighted across markets (dust pools don't dominate)
 *  - bundlePct = max(insider holders, insider networks, % from "bundle"/"insider" risks)
 */
export function normalizeRugcheck(raw: any, now = Date.now()): SafetyReport {
  const supply = num(raw?.token?.supply);
  const decimals = num(raw?.token?.decimals);
  const mintAuthority = raw?.token?.mintAuthority ?? raw?.mintAuthority ?? null;
  const freezeAuthority = raw?.token?.freezeAuthority ?? raw?.freezeAuthority ?? null;

  // --- addresses that are pools / LP vaults / lockers / programs
  const excluded = new Set<string>();
  for (const m of raw?.markets ?? []) {
    for (const k of ['pubkey', 'liquidityA', 'liquidityB']) if (m?.[k]) excluded.add(m[k]);
    if (m?.liquidityAAccount?.owner) excluded.add(m.liquidityAAccount.owner);
    if (m?.liquidityBAccount?.owner) excluded.add(m.liquidityBAccount.owner);
  }
  for (const [addr, info] of Object.entries<any>(raw?.knownAccounts ?? {})) {
    if (info?.type === 'AMM' || info?.type === 'LOCKER') excluded.add(addr);
  }
  for (const [addr] of Object.entries<any>(raw?.lockers ?? {})) excluded.add(addr);

  const holders: any[] = Array.isArray(raw?.topHolders) ? raw.topHolders : [];
  const realHolders = holders.filter((h) => !excluded.has(h?.owner) && !excluded.has(h?.address));
  const top10 = realHolders.slice(0, 10);
  const top10Pct = top10.reduce((s, h) => s + num(h.pct), 0);

  // --- dev holding
  const creator: string | null = raw?.creator ?? null;
  const creatorBalance = num(raw?.creatorBalance);
  let devPct = supply > 0 ? (creatorBalance / supply) * 100 : 0;
  if (creator) {
    const viaHolders = realHolders.filter((h) => h.owner === creator).reduce((s, h) => s + num(h.pct), 0);
    devPct = Math.max(devPct, viaHolders);
  }

  // --- LP locked/burned (liquidity weighted)
  let wSum = 0;
  let wLocked = 0;
  let anyLp = false;
  for (const m of raw?.markets ?? []) {
    const lp = m?.lp;
    if (!lp) continue;
    anyLp = true;
    const usd = num(lp.baseUSD) + num(lp.quoteUSD);
    wSum += usd;
    wLocked += usd * num(lp.lpLockedPct);
  }
  let lpLockedPct = 0;
  if (wSum > 0) lpLockedPct = wLocked / wSum;
  else if (anyLp) lpLockedPct = Math.max(...(raw.markets ?? []).map((m: any) => num(m?.lp?.lpLockedPct)));

  // --- bundles / insiders
  const insiderHoldersPct = holders.filter((h) => h?.insider === true).reduce((s, h) => s + num(h.pct), 0);
  const networksPct =
    supply > 0
      ? ((raw?.insiderNetworks ?? []) as any[]).reduce((s, nw) => s + num(nw?.currentHolding ?? nw?.tokenAmount), 0) /
        supply *
        100
      : 0;
  let bundlePct = Math.max(insiderHoldersPct, networksPct);
  let bundleSource = bundlePct === 0 ? 'none' : insiderHoldersPct >= networksPct ? 'insider holders' : 'insider networks';

  const risks: RiskFlag[] = ((raw?.risks ?? []) as any[]).map((r) => ({
    name: String(r?.name ?? ''),
    level: String(r?.level ?? ''),
    score: num(r?.score),
    value: String(r?.value ?? ''),
  }));
  for (const r of risks) {
    if (!/bundle|insider/i.test(r.name)) continue;
    const m = PCT_RE.exec(r.value) ?? PCT_RE.exec(r.name);
    if (m) {
      const pct = Number(m[1]);
      if (pct > bundlePct) {
        bundlePct = pct;
        bundleSource = `risk: ${r.name}`;
      }
    } else if (r.level === 'danger' && bundlePct < 100) {
      // flagged as dangerous but without a number → treat as fully bundled
      bundlePct = 100;
      bundleSource = `risk: ${r.name}`;
    }
  }

  return {
    mint: raw?.mint,
    mintAuthority,
    freezeAuthority,
    supply,
    decimals,
    creator,
    creatorBalance,
    devPct: round(devPct),
    top10Pct: round(top10Pct),
    top10Count: top10.length,
    lpLockedPct: round(lpLockedPct),
    bundlePct: round(bundlePct),
    bundleSource,
    scoreNormalised: num(raw?.score_normalised),
    rugged: raw?.rugged === true,
    risks,
    totalHolders: num(raw?.totalHolders),
    fetchedAt: now,
  };
}

const round = (x: number) => Math.round(x * 100) / 100;
