// The DeFi reads: Liquidity Pools positions and fee APR, their collect history, wallet balances and Aave accounts,
// all into pools.json, plus an hourly snapshot into defi-snapshots.json. Public nodes limit bursts, so the four reads
// run one after another, never side by side: each waits in one queue. A failed read keeps the last good one.
import { readAllPositions, readAprs, readHistory, cachedRows, WINDOWS } from '../../js/defi/positions-read.js';
import { readWallets, walletsOf } from '../../js/defi/wallets-read.js';
import { readAllLending } from '../../js/defi/lending-read.js';
import { addedPositions, CHAINS } from '../../js/uniswap.js';
import { lendingChanged } from '../../js/automations.js';

let queue = Promise.resolve();
// Runs work after every DeFi read already waiting, so two never overlap.
function inTurn(work) {
  const next = queue.then(work, work);
  queue = next.catch(() => {});
  return next;
}

const hasPools = (store) => {
  const cfg = store.get('settings').uniswap ?? {};
  return walletsOf(store).length > 0 || addedPositions(cfg).length > 0;
};

const positions = {
  id: 'defi-positions',
  delay: 9000,
  timeout: 10 * 60000,
  run: ({ store, params }) => inTurn(async () => {
    if (!hasPools(store)) return { waiting: 'No wallet or position is set in Settings → Wallets.' };
    // A new APR window picked on the page: only its APR is read, from the rows saved.
    if (params.aprOnly && WINDOWS[params.window]) {
      await readAprs(store, cachedRows(store), params.window);
      return {};
    }
    const rows = await readAllPositions(store);
    if (!rows) return {};
    const read = store.get('pools').read ?? {};
    const warnings = Object.values(read.warnings ?? {}).filter(Boolean);
    if (!rows.length && warnings.length) throw new Error(warnings.join(' '));
    // Fee APR over 24 hours, and over the window the page shows when it is another one.
    const chosen = params.window ?? store.get('pools').aprWindow;
    for (const win of new Set(['24h', ...(WINDOWS[chosen] ? [chosen] : [])])) await readAprs(store, rows, win);
    return { positions: rows.filter((r) => !r.closed).length, warnings: warnings.length || null };
  }),
};

const history = {
  id: 'defi-history',
  delay: 20000,
  timeout: 30 * 60000,
  run: ({ store, params }) => inTurn(async () => {
    if (!hasPools(store)) return { waiting: 'No wallet or position is set in Settings → Wallets.' };
    // Each pass searches a step further back, from where the last one stopped.
    await readHistory(store, cachedRows(store), { only: params.chainId ?? null });
    const errors = Object.entries(store.get('pools').etherscanErrors ?? {}).map(([name, text]) => ({ text: `Etherscan on ${name}: ${text}` }));
    return { collected: (store.get('pools').collected ?? []).length, errors };
  }),
};

const wallets = {
  id: 'defi-wallets',
  delay: 12000,
  timeout: 5 * 60000,
  run: ({ store }) => inTurn(async () => {
    if (!walletsOf(store).length) return { waiting: 'No wallet is set in Settings → Wallets.' };
    const state = await readWallets(store);
    if (state?.failed?.length && !Object.keys(store.get('pools').balances ?? {}).length) throw new Error(state.failed.map((f) => `${f.name}: ${f.error}`).join('; '));
    return { failed: state?.failed?.length || null };
  }),
};

const lending = {
  id: 'defi-lending',
  delay: 15000,
  timeout: 5 * 60000,
  run: ({ store }) => inTurn(async () => {
    if (!walletsOf(store).length) return { waiting: 'No wallet is set in Settings → Wallets.' };
    const state = await readAllLending(store);
    const failedChains = new Set((state?.failed ?? []).map((f) => f.name));
    const rows = Object.entries(store.get('pools').lending ?? {})
      .flatMap(([chainId, part]) => (part.rows ?? []).map((r) => ({ ...r, chainName: CHAINS.find((c) => c.id === Number(chainId))?.name })))
      .filter((r) => !failedChains.has(r.chainName));
    lendingChanged(store, rows);
    return { accounts: rows.length, failed: state?.failed?.length || null };
  }),
};

// One entry an hour of what the DeFi reads saved, from the files only: no node is asked. Hourly entries are kept for
// 90 days, then one a day.
const HOUR_MS = 3600000;
const DAY_MS = 24 * HOUR_MS;
const snapshots = {
  id: 'defi-snapshots',
  delay: 30000,
  timeout: 60000,
  run: async ({ store }) => {
    if (!hasPools(store)) return { waiting: 'No wallet or position is set in Settings → Wallets.' };
    const d = store.get('pools');
    const entries = store.get('defi-snapshots').entries ?? [];
    const last = entries.at(-1);
    if (last && Date.now() - Date.parse(last.at) < HOUR_MS - 60000) return {};
    const entry = { at: new Date().toISOString(), wallets: {}, positions: {}, lending: {} };
    for (const part of Object.values(d.balances ?? {})) {
      for (const r of part.rows ?? []) {
        const w = (entry.wallets[r.wallet] ??= { usd: 0 });
        w.usd = Math.round((w.usd + (r.value ?? 0)) * 100) / 100;
      }
    }
    for (const r of cachedRows(store).filter((x) => !x.closed)) {
      entry.positions[r.ref] = { usd: r.value == null ? null : Math.round(r.value * 100) / 100, inRange: r.inRange, feesUsd: r.fees == null ? null : Math.round(r.fees * 100) / 100 };
    }
    for (const part of Object.values(d.lending ?? {})) {
      for (const r of part.rows ?? []) entry.lending[r.wallet] = { health: r.health };
    }
    const cut = Date.now() - 90 * DAY_MS;
    const seenDays = new Set();
    const kept = [...entries, entry].filter((e) => {
      if (Date.parse(e.at) >= cut) return true;
      const day = e.at.slice(0, 10);
      if (seenDays.has(day)) return false;
      seenDays.add(day);
      return true;
    });
    store.save('defi-snapshots', (s) => {
      s.entries = kept;
    });
    return { entries: kept.length };
  },
};

export default [positions, history, wallets, lending, snapshots];
