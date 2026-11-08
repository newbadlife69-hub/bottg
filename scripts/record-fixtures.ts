/**
 * Records REAL API responses into test/fixtures so the unit tests run on
 * genuine data. Picks one RugCheck report per kill rule when it can find one.
 *   npm run record:fixtures
 */
import fs from 'node:fs';
import path from 'node:path';
import { defaultSettings } from '../src/config.js';
import { checkSafety } from '../src/agents/filter.js';
import { getJson } from '../src/util/http.js';
import { RateLimiter } from '../src/util/limiter.js';
import { normalizeRugcheck } from '../src/sources/rugcheck.js';
import { SOL_MINT } from '../src/sources/constants.js';

const OUT = path.resolve('test/fixtures');
fs.mkdirSync(OUT, { recursive: true });
const lim = new RateLimiter('fixtures', 600, 1);
const jupLim = new RateLimiter('jup', 2200, 1);
const save = (name: string, data: unknown) => {
  fs.writeFileSync(path.join(OUT, name), JSON.stringify(data, null, 1));
  console.log('saved', name);
};
const get = <T = any>(url: string, l = lim, headers: Record<string, string> = {}) => getJson<T>(url, { limiter: l, headers, retries: 2 });

async function main() {
  const f = defaultSettings().filter;

  const gt = await get('https://api.geckoterminal.com/api/v2/networks/solana/new_pools?include=base_token,quote_token&page=1');
  save('gt_new_pools.json', gt);
  const profiles = await get<any[]>('https://api.dexscreener.com/token-profiles/latest/v1');
  save('ds_profiles.json', profiles);
  const boosts = await get<any[]>('https://api.dexscreener.com/token-boosts/latest/v1');
  save('ds_boosts.json', boosts);

  // candidate mints from every discovery source + RugCheck's own lists
  const cands = new Set<string>();
  for (const p of [...profiles, ...boosts]) if (p.chainId === 'solana') cands.add(p.tokenAddress);
  for (const p of gt.data ?? []) cands.add(String(p.relationships?.base_token?.data?.id ?? '').replace('solana_', ''));
  for (const ep of ['new_tokens', 'recent', 'trending']) {
    try {
      const list = await get<any[]>(`https://api.rugcheck.xyz/v1/stats/${ep}`);
      for (const t of list ?? []) {
        const m = t.mint ?? t.token?.mint ?? t.address;
        if (m) cands.add(m);
      }
    } catch (e) {
      console.warn('rugcheck stats', ep, String(e).slice(0, 80));
    }
  }
  cands.delete('');
  cands.delete(SOL_MINT);
  const mints = [...cands];
  console.log('candidates', mints.length);

  const ds = await get<any[]>(`https://api.dexscreener.com/tokens/v1/solana/${mints.slice(0, 30).join(',')}`);
  save('ds_tokens.json', ds);

  // RugCheck: one real example per rule + a clean one
  const wanted = new Set(['mintAuthority', 'freezeAuthority', 'lpLocked', 'top10', 'devHolding', 'bundled', 'pass']);
  const picked: Record<string, string> = {};
  for (const mint of mints.slice(0, 90)) {
    if (!wanted.size) break;
    let raw: any;
    try {
      raw = await get(`https://api.rugcheck.xyz/v1/tokens/${mint}/report`);
    } catch {
      continue;
    }
    const rep = normalizeRugcheck(raw);
    const kill = checkSafety(rep, f);
    // also find "pure" examples for later rules (earlier rules would mask them)
    const tags: string[] = [kill ? kill.rule : 'pass'];
    if (rep.top10Pct > f.maxTop10Pct) tags.push('top10');
    if (rep.devPct > f.maxDevPct) tags.push('devHolding');
    if (rep.bundlePct > f.maxBundlePct) tags.push('bundled');
    if (rep.lpLockedPct < f.minLpLockedPct) tags.push('lpLocked');
    for (const tag of tags) {
      if (wanted.has(tag)) {
        wanted.delete(tag);
        picked[tag] = mint;
        save(`rugcheck_${tag}.json`, raw);
      }
    }
  }
  console.log('rugcheck picked', picked, 'missing', [...wanted]);

  // GeckoTerminal pool stats (unique buyers) for the first DS pairs
  const pairs = ds.slice(0, 5).map((p: any) => p.pairAddress);
  save('gt_pools_multi.json', await get(`https://api.geckoterminal.com/api/v2/networks/solana/pools/multi/${pairs.join(',')}`));

  // Jupiter quote-only orders (no taker) for the most liquid token
  const liquid = ds.filter((p: any) => (p.liquidity?.usd ?? 0) > 20_000).sort((a: any, b: any) => b.liquidity.usd - a.liquidity.usd)[0];
  if (liquid) {
    const key = process.env.JUP_API_KEY ? { 'x-api-key': process.env.JUP_API_KEY } : {};
    const buy = await get(`https://api.jup.ag/swap/v2/order?inputMint=${SOL_MINT}&outputMint=${liquid.baseToken.address}&amount=100000000`, jupLim, key);
    save('jup_buy.json', { token: liquid.baseToken, decimalsHint: null, response: buy });
    const sell = await get(`https://api.jup.ag/swap/v2/order?inputMint=${liquid.baseToken.address}&outputMint=${SOL_MINT}&amount=${buy.outAmount}`, jupLim, key);
    save('jup_sell.json', { token: liquid.baseToken, response: sell });
  }
  save('README.json', {
    recordedAt: new Date().toISOString(),
    note: 'Real responses from GeckoTerminal, DexScreener, RugCheck and Jupiter recorded by scripts/record-fixtures.ts',
    rugcheck: picked,
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
