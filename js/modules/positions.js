import { h, icon, refreshIcon, money, empty, notice } from '../ui.js';
import { setupBanner } from '../integrations.js';
import { poolsChanged } from '../automations.js';
import { readPositions, poolState, tokenMeta, usdPrices, positionAmounts, priceAtTick, isAddress, CHAINS, chainSettings, tokenLogos, scanV4, readV4Position, readV3Position, addedPositions, parsePosition, addPosition, chainClock, poolSwaps, swapFees, swapEarn } from '../uniswap.js';

const STALE_MS = 10 * 60 * 1000;
const YEAR_MS = 365 * 24 * 60 * 60 * 1000;
// The fee counter, used where swaps cannot be read, needs some time between two reads, or a few cents of fees
// turn into a wild yearly rate.
const APR_MIN_MS = 60 * 60 * 1000;
// The windows fee APR can be read over, in seconds, with their labels.
const WINDOWS = { '15m': [15 * 60, '15 min'], '1h': [3600, '1 h'], '3h': [3 * 3600, '3 h'], '6h': [6 * 3600, '6 h'], '24h': [86400, '24 h'], '7d': [7 * 86400, '7 d'], '30d': [30 * 86400, '30 d'] };
const MAX_TICK = 887272; // the widest possible range: a "full range" position

// View state: which rows are shown.
// layout: 'cards' or 'list'. sort: one of the SORTS keys; dir: 1 low to high, -1 high to low.
// adding: the form to add a position by hand is open; addMessage is its last error.
// window: the WINDOWS key fee APR is read over.
const view = { filter: 'all', chain: 'all', layout: 'cards', sort: 'value', dir: -1, adding: false, addMessage: '', window: '24h' };
// Loaded positions and the state of the last load. shallow: chains whose node would not search back to v4's start.
// stale: chains shown from the last good read because this one failed, with when that read was.
// pending: chains still being read in the current load.
const state = { status: 'idle', rows: [], error: '', warning: '', at: 0, shallow: [], stale: [], pending: [] };
// pools.json keeps the last good read of each chain and version, the last good prices of each chain, and how far
// each v4 search got. A read that fails then shows the old rows, marked as possibly out of date.
const COLLECTION = 'pools';
const tokenInfo = new Map(); // "chainId:token address" -> { symbol, decimals }
let loading = false;
const aprs = new Map(); // "window|ref" -> { apr, secs }: fee APR from the swaps in that window, and the time covered
let aprBusy = ''; // the window whose swaps are being read
let aprAgain = false; // read again when done: the rows changed meanwhile
let logoMap = new Map(); // "chainId:token address" -> logo URL, from the token list
let logosAsked = false;
const seen = new Set(); // rows already on screen: only new ones animate in
const shownTotals = { value: 0, fees: 0 }; // the totals on screen, so a change counts from there

const tokenKey = (chain, address) => `${chain.id}:${address}`;
// v3 rows keep their old key, so tasks made before v4 still match.
const refOf = (version, chainId, tokenId) => (version === 'v3' ? `${chainId}:${tokenId}` : `${chainId}:${version}:${tokenId}`);

// Builds one row from a position, its pool's current state and the token prices on its chain.
function buildRow(p, pool, prices, chain, pricesAt = null) {
  if (!pool) return null;
  const m0 = tokenInfo.get(tokenKey(chain, p.token0)) ?? { symbol: '?', decimals: 18 };
  const m1 = tokenInfo.get(tokenKey(chain, p.token1)) ?? { symbol: '?', decimals: 18 };
  const raw = positionAmounts(p, pool.sqrtPrice);
  const a0 = raw.a0 / 10 ** m0.decimals;
  const a1 = raw.a1 / 10 ** m1.decimals;
  const p0 = prices[p.token0.toLowerCase()] ?? null;
  const p1 = prices[p.token1.toLowerCase()] ?? null;
  const priced = p0 !== null && p1 !== null;
  const value = priced ? a0 * p0 + a1 * p1 : null;
  const fee0 = Number(p.owed0) / 10 ** m0.decimals;
  const fee1 = Number(p.owed1) / 10 ** m1.decimals;
  const fees = priced ? fee0 * p0 + fee1 * p1 : null;
  const full = p.tickLower <= -MAX_TICK && p.tickUpper >= MAX_TICK;
  const min = p.tickLower <= -MAX_TICK ? 0 : priceAtTick(p.tickLower, m0.decimals, m1.decimals);
  const max = p.tickUpper >= MAX_TICK ? Infinity : priceAtTick(p.tickUpper, m0.decimals, m1.decimals);
  const current = priceAtTick(pool.tick, m0.decimals, m1.decimals);
  // Where the current price sits in the range, on a log scale (prices move in ratios), clamped to the track.
  const marker = full || !(min > 0) || !Number.isFinite(max) || !(current > 0)
    ? null
    : Math.min(100, Math.max(0, ((Math.log(current) - Math.log(min)) / (Math.log(max) - Math.log(min))) * 100));
  return {
    version: p.version,
    ref: refOf(p.version, chain.id, p.tokenId),
    chain: chain.name,
    chainId: chain.id,
    tokenId: p.tokenId,
    wallet: p.owner.toLowerCase(),
    // Set when the values use saved prices (pricesAt) or the whole row is from an earlier read (staleAt).
    pricesAt,
    staleAt: null,
    owner: p.label,
    addr0: p.token0,
    addr1: p.token1,
    pair: `${m0.symbol} / ${m1.symbol}`,
    sym0: m0.symbol,
    sym1: m1.symbol,
    feePct: p.fee / 10000,
    inRange: pool.tick >= p.tickLower && pool.tick < p.tickUpper,
    full,
    min,
    max,
    current,
    marker,
    a0,
    a1,
    // Unclaimed fees in tokens, and the token prices, so fee APR counts fees earned and not price moves.
    fee0,
    fee1,
    p0,
    p1,
    value,
    fees,
    share0: value ? (a0 * p0) / value : null,
    url: chain.app ? `https://app.uniswap.org/positions/${p.version}/${chain.app}/${p.tokenId}` : null,
    // What fee APR from swaps needs: the range, the liquidity (as text, for JSON), the pool and the decimals.
    tickLower: p.tickLower,
    tickUpper: p.tickUpper,
    liq: p.liquidity.toString(),
    pool: pool.pool,
    feePips: p.fee,
    dec0: m0.decimals,
    dec1: m1.decimals,
  };
}

const shortAddress = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const hasValue = (p) => p.liquidity > 0n || p.owed0 > 0n || p.owed1 > 0n;

// v3 baselines saved before v3 fees were read in full hold stale amounts, and would count every fee since the
// last collect as earned at once, so they start again.
const BASELINE_V = 2;
const baselineOf = (baselines, r) => {
  const b = baselines?.[r.ref];
  return b && (r.version !== 'v3' || b.v === BASELINE_V) ? b : null;
};

// The fee baseline of each position: its unclaimed fees in tokens when the board started counting. It restarts
// when the fees drop, which means they were collected. Rows from an earlier read keep their baseline as is.
function nextBaselines(old = {}, rows, now) {
  const out = { ...old };
  for (const r of rows) {
    if (typeof r.fee0 !== 'number' || typeof r.fee1 !== 'number') continue;
    const b = baselineOf(old, r);
    if (!b || r.fee0 < b.f0 || r.fee1 < b.f1) out[r.ref] = { at: now, f0: r.fee0, f1: r.fee1, v: BASELINE_V };
  }
  return out;
}

// Time left before the counter shows a fee APR, or null when it has no baseline yet.
function counterLeft(r, baselines) {
  const b = baselineOf(baselines, r);
  return b ? Math.max(0, b.at + APR_MIN_MS - Date.now()) : null;
}

// Yearly fee rate from the fees earned since the baseline, at today's prices. null until enough time has passed.
function feeApr(r, baselines) {
  const b = baselineOf(baselines, r);
  const elapsed = Date.now() - (b?.at ?? Date.now());
  if (!b || elapsed < APR_MIN_MS || !(r.value > 0) || r.p0 == null || r.p1 == null || typeof r.fee0 !== 'number') return null;
  const earned = Math.max(0, r.fee0 - b.f0) * r.p0 + Math.max(0, r.fee1 - b.f1) * r.p1;
  return (earned / r.value) * (YEAR_MS / elapsed);
}

// How safely a position sits in its range: full range first, then the room to the nearer edge, out of range last.
const rangeRoom = (r) => (r.full ? 101 : !r.inRange ? -1 : r.marker === null ? 0 : Math.min(r.marker, 100 - r.marker));

// What each sort reads from a row, and the direction it starts in. Position numbers only grow, so a higher
// number is a newer position on the same contract.
const SORTS = {
  value: { value: (r) => r.value, dir: -1 },
  fees: { value: (r) => r.fees, dir: -1 },
  apr: { value: (r) => r.apr, dir: -1 },
  number: { value: (r) => BigInt(r.tokenId), dir: -1 },
  pool: { value: (r) => r.pair, dir: 1 },
  chain: { value: (r) => r.chain, dir: 1 },
  range: { value: rangeRoom, dir: -1 },
  split: { value: (r) => r.share0, dir: -1 },
};
// The choices in the Sort menu. Sorting by a table column that is not here adds it to the menu as it is.
const PRESETS = [['value', -1, 'Value'], ['fees', -1, 'Unclaimed fees'], ['apr', -1, 'Fee APR'], ['number', -1, 'Newest'], ['number', 1, 'Oldest']];
const SORT_NAMES = { pool: 'Pool', chain: 'Chain', range: 'Price range', split: 'Distribution', value: 'Value', fees: 'Unclaimed fees', apr: 'Fee APR', number: 'Number' };

// Rows without the value sorted on go last, whatever the direction. Ties fall back to the newest first.
function sortRows(rows, key, dir) {
  const read = SORTS[key].value;
  const cmp = (a, b) => (typeof a === 'string' ? a.localeCompare(b) : a < b ? -1 : a > b ? 1 : 0);
  const newest = SORTS.number.value;
  return rows.sort((x, y) => {
    const a = read(x);
    const b = read(y);
    const missing = (a == null ? 1 : 0) - (b == null ? 1 : 0);
    if (missing) return missing;
    return (a == null ? 0 : dir * cmp(a, b)) || cmp(newest(y), newest(x));
  });
}

// A table header that sorts by its column; a second click flips the direction.
function sortHead(store, key, label, attrs = {}) {
  const on = view.sort === key;
  return h('th', { ...attrs, 'aria-sort': on ? (view.dir > 0 ? 'ascending' : 'descending') : null },
    h('button', {
      type: 'button',
      class: 'mon-sort',
      onclick: () => {
        view.dir = on ? -view.dir : SORTS[key].dir;
        view.sort = key;
        store.refresh();
      },
    }, label, h('span', { class: 'sort-mark' }, icon(on && view.dir > 0 ? 'chevron-up' : 'chevron-down'))));
}

// Finds and reads one chain's v4 positions: those the search found for each wallet, and those added by hand.
// saved is the search state the last load kept for this chain, keyed by lowercase wallet address.
async function readV4(chain, node, wallets, cfg, saved) {
  const scans = {};
  // One wallet at a time: each search sends many requests, and public nodes limit bursts.
  // A failed search or read fails the whole v4 read, so the last good one is shown instead of an empty list.
  for (const w of wallets) {
    const key = w.address.toLowerCase();
    scans[key] = await scanV4(chain, node, w.address, saved[key]);
  }
  const labels = new Map(wallets.map((w) => [w.address.toLowerCase(), w.label || w.address]));
  const manual = new Set(addedPositions(cfg).filter((x) => x.version === 'v4' && x.chainId === chain.id).map((x) => String(x.tokenId)));
  const ids = [...new Set([...Object.values(scans).flatMap((s) => s?.ids ?? []), ...manual])];
  const read = new Map((await Promise.all(ids.map((id) => readV4Position(chain, node, id)))).map((r, i) => [ids[i], r]));

  // A found position that was burned or sent to another address is dropped from the search, so it is not read again.
  for (const [key, s] of Object.entries(scans)) {
    s.ids = s.ids.filter((id) => read.get(id)?.position.owner === key);
  }
  const items = [...read.values()]
    .filter((r) => r && hasValue(r.position) && (manual.has(r.position.tokenId) || labels.has(r.position.owner)))
    .map((r) => ({ ...r, position: { ...r.position, label: labels.get(r.position.owner) ?? shortAddress(r.position.owner) } }));
  return { items, scans };
}

// Every wallet's v3 positions on a chain, and those added by hand, each with its pool's current state.
async function readV3(chain, node, wallets, cfg) {
  const owned = (await Promise.all(wallets.map(async (w) => (await readPositions(chain, node, w.address)).map((p) => ({ ...p, label: w.label || w.address }))))).flat();
  const labels = new Map(wallets.map((w) => [w.address.toLowerCase(), w.label || w.address]));
  const have = new Set(owned.map((p) => p.tokenId));
  const added = addedPositions(cfg).filter((x) => x.version === 'v3' && x.chainId === chain.id && !have.has(String(x.tokenId)));
  const extra = (await Promise.all(added.map((x) => readV3Position(chain, node, x.tokenId))))
    .filter((p) => p && hasValue(p))
    .map((p) => ({ ...p, label: labels.get(p.owner) ?? shortAddress(p.owner) }));
  const positions = [...owned, ...extra];
  const pools = new Map();
  const poolKeys = [...new Set(positions.map((p) => `${p.token0}|${p.token1}|${p.fee}`))];
  await Promise.all(poolKeys.map(async (key) => {
    const [token0, token1, fee] = key.split('|');
    pools.set(key, await poolState(chain, node, { token0, token1, fee: Number(fee) }).catch(() => null));
  }));
  return { items: positions.map((p) => ({ position: p, pool: pools.get(`${p.token0}|${p.token1}|${p.fee}`) })) };
}

// Turns read positions into rows: their tokens' symbols, then USD prices. Prices that fail fall back to the last
// ones read for this chain (savedPrices).
async function toRows(chain, node, items, savedPrices) {
  const tokens = [...new Set(items.flatMap((x) => [x.position.token0, x.position.token1]))];
  await Promise.all(tokens.filter((t) => !tokenInfo.has(tokenKey(chain, t))).map(async (t) => tokenInfo.set(tokenKey(chain, t), await tokenMeta(node, t, chain))));
  let prices = {};
  let pricesAt = null;
  let fresh = null;
  let warning = '';
  try {
    prices = await usdPrices(chain, tokens);
    fresh = prices;
  } catch (err) {
    if (savedPrices) {
      prices = savedPrices.usd;
      pricesAt = savedPrices.at;
      warning = `${chain.name} token prices could not be read (${err.message}), so values use the prices from ${ago(pricesAt)}.`;
    } else {
      warning = `${chain.name} token prices are unavailable (${err.message}), so values are not shown.`;
    }
  }
  return { rows: items.map((x) => buildRow(x.position, x.pool, prices, chain, pricesAt)).filter(Boolean), prices: fresh, warning };
}

// How long ago a time was, in words.
function ago(at) {
  const mins = Math.round((Date.now() - at) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} days ago`;
}

// Rows saved by an earlier read, for the wallets and chains still chosen. JSON has no Infinity, so an open-ended
// range comes back as null and is restored here.
function savedRows(store, cfg, keys) {
  const cache = store.get(COLLECTION)?.cache ?? {};
  const wallets = new Set((cfg.wallets ?? []).map((w) => w.address.toLowerCase()));
  const manual = new Set(addedPositions(cfg).map((x) => refOf(x.version, x.chainId, x.tokenId)));
  return keys.flatMap((key) => (cache[key]?.rows ?? [])
    .filter((r) => wallets.has(r.wallet) || manual.has(r.ref))
    .map((r) => ({ ...r, max: r.max ?? Infinity, staleAt: cache[key].at })));
}
const cacheKeys = (chains) => chains.flatMap((c) => [`${c.id}:v3`, `${c.id}:v4`]);
const enabledChains = (cfg) => CHAINS.filter((chain) => chainSettings(cfg, chain).enabled);

// Positions outside their price range as of the last saved read, for Home. Nothing is read from a chain here.
export function outOfRange(store) {
  const cfg = store.get('settings').uniswap ?? {};
  return savedRows(store, cfg, cacheKeys(enabledChains(cfg))).filter((r) => !r.inRange);
}

// Reads every enabled chain in parallel, and v3 and v4 side by side on each. Each part shows as soon as it is read,
// replacing what was on screen for it; until then the earlier rows stay. A part that fails shows its last good read.
async function load(store) {
  if (loading) return;
  loading = true;
  state.status = 'loading';
  state.error = '';
  try {
    const cfg = store.get('settings').uniswap ?? {};
    const wallets = (cfg.wallets ?? []).filter((w) => isAddress(w.address));
    const chains = CHAINS.map((chain) => ({ chain, ...chainSettings(cfg, chain) })).filter((c) => c.enabled);
    const saved = store.get(COLLECTION) ?? {};

    // What is on screen now, by part ("chainId:version"), for the chains and wallets still chosen.
    const keep = new Set(savedRows(store, cfg, cacheKeys(chains.map((c) => c.chain))).map((r) => r.ref));
    const parts = new Map();
    for (const r of state.rows.filter((x) => keep.has(x.ref))) {
      const key = `${r.chainId}:${r.version}`;
      parts.set(key, [...(parts.get(key) ?? []), r]);
    }
    const warnings = new Map();
    const stale = new Map();
    const shallow = new Set(state.shallow);
    state.pending = chains.map((c) => c.chain.name);
    const publish = () => {
      state.rows = [...parts.values()].flat().sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
      state.warning = [...warnings.values()].filter(Boolean).join(' ');
      const byChain = new Map();
      for (const [key, at] of stale) {
        const name = chainOf(Number(key.split(':')[0]))?.name;
        byChain.set(name, Math.min(byChain.get(name) ?? Infinity, at));
      }
      state.stale = [...byChain].map(([name, at]) => ({ name, at }));
      state.shallow = [...shallow];
      store.refresh();
    };
    publish();

    await Promise.all(chains.map(async ({ chain, node }) => {
      const savedPrices = saved.prices?.[chain.id];
      const part = async (version, read) => {
        const key = `${chain.id}:${version}`;
        try {
          const got = await read();
          const done = await toRows(chain, node, got.items, savedPrices);
          parts.set(key, done.rows);
          warnings.set(key, done.warning);
          stale.delete(key);
          if (got.scans) {
            const short = Object.values(got.scans).some((x) => x?.done && x.from > chain.v4.start);
            if (short) shallow.add(chain.name);
            else shallow.delete(chain.name);
          }
          // Save as each part lands, so a reload mid-read keeps what was already read.
          store.update(COLLECTION, (d) => {
            d.cache = { ...d.cache, [key]: { at: Date.now(), rows: done.rows } };
            d.fees = nextBaselines(d.fees, done.rows, Date.now());
            if (done.prices) d.prices = { ...d.prices, [chain.id]: { at: Date.now(), usd: { ...d.prices?.[chain.id]?.usd, ...done.prices } } };
            // Keep how far each v4 search got, so the next load goes on from there.
            if (got.scans) d.scan = { ...d.scan, [chain.id]: got.scans };
          });
        } catch (err) {
          parts.set(key, savedRows(store, cfg, [key]));
          warnings.set(key, `${chain.name} ${version} positions could not be read: ${err.message}`);
          const at = saved.cache?.[key]?.at;
          if (at) stale.set(key, at);
        }
        publish();
      };
      await Promise.all([
        part('v3', () => readV3(chain, node, wallets, cfg)),
        part('v4', () => readV4(chain, node, wallets, cfg, saved.scan?.[chain.id] ?? {})),
      ]);
      state.pending = state.pending.filter((name) => name !== chain.name);
      publish();
    }));

    state.status = 'ok';
    state.at = Date.now();
    // Tell the automation rules and the notifications which positions left their range. Old rows are left out.
    poolsChanged(store, state.rows.filter((r) => !r.staleAt));
  } catch (err) {
    state.status = 'error';
    state.error = err.message;
  } finally {
    loading = false;
    state.pending = [];
    store.refresh();
  }
  if (state.status === 'ok') loadAprs(store);
}

// Public nodes keep about a day of logs, so what each position earned is also saved per hour (unix hour ->
// [raw token0, raw token1], as text), for the 7 and 30 day windows. Only hours the swaps read cover in full are
// saved, an hour already saved is kept, and hours older than 31 days are dropped.
const HOUR = 3600;
function keepHours(old = {}, c, pos, clock, readFrom) {
  const out = {};
  const oldest = Math.floor(clock.time / HOUR) - 31 * 24;
  for (const [hour, v] of Object.entries(old)) if (Number(hour) >= oldest) out[hour] = v;
  if (c.from > clock.head) return out;
  const first = Math.ceil(readFrom / HOUR);
  const last = Math.floor(clock.time / HOUR) - 1; // the last hour that has ended
  const sums = new Map();
  for (const s of c.swaps) {
    const hour = Math.floor((clock.time - (clock.head - s.block) * clock.perBlock) / HOUR);
    if (hour < first || hour > last || out[hour]) continue;
    const [f0, f1] = swapEarn(s, pos);
    const sum = sums.get(hour) ?? [0n, 0n];
    sums.set(hour, [sum[0] + f0, sum[1] + f1]);
  }
  for (let hour = first; hour <= last; hour++) {
    if (out[hour]) continue;
    const [e0, e1] = sums.get(hour) ?? [0n, 0n];
    out[hour] = [e0.toString(), e1.toString()];
  }
  return out;
}

// Fee APR over the chosen window, from each pool's swaps in it. One pool at a time per chain, as public nodes limit
// bursts; each pool's APR shows as soon as it is read.
async function loadAprs(store) {
  if (aprBusy) {
    aprAgain = true;
    return;
  }
  const win = view.window;
  aprBusy = win;
  const secs = WINDOWS[win][0];
  const cfg = store.get('settings').uniswap ?? {};
  const byChain = new Map();
  for (const r of state.rows.filter((x) => x.liq != null && x.pool)) byChain.set(r.chainId, [...(byChain.get(r.chainId) ?? []), r]);
  await Promise.all([...byChain].map(async ([chainId, rows]) => {
    const chain = chainOf(chainId);
    const { node } = chainSettings(cfg, chain);
    let clock;
    try {
      clock = await chainClock(node);
    } catch {
      return;
    }
    const from = clock.head - Math.ceil(secs / clock.perBlock);
    const pools = new Map();
    for (const r of rows) pools.set(`${r.version}:${r.pool}`, [...(pools.get(`${r.version}:${r.pool}`) ?? []), r]);
    for (const list of pools.values()) {
      try {
        const c = await poolSwaps(chain, node, list[0].version, list[0].pool, from, clock.head);
        const start = Math.max(from, c.from);
        // Swaps read now cover start..head. Older parts of the window come from the hours saved by earlier loads.
        const readFrom = clock.time - (clock.head - c.from) * clock.perBlock;
        const winFrom = clock.time - secs;
        const kept = {};
        for (const r of list) {
          const pos = { tickLower: r.tickLower, tickUpper: r.tickUpper, liquidity: r.liq, fee: r.feePips };
          const hours = keepHours(store.get(COLLECTION)?.earned?.[r.ref], c, pos, clock, readFrom);
          kept[r.ref] = hours;
          if (!(r.value > 0) || r.p0 == null || r.p1 == null) continue;
          const e = swapFees(c.swaps, start, pos);
          let e0 = c.from <= clock.head ? e.e0 : 0n;
          let e1 = c.from <= clock.head ? e.e1 : 0n;
          let covered = Math.max(0, Math.min(secs, (clock.head - start + 1) * clock.perBlock));
          for (const [hour, [h0, h1]] of Object.entries(hours)) {
            const t = Number(hour) * HOUR;
            if (t >= winFrom && t + HOUR <= Math.min(readFrom, clock.time)) {
              e0 += BigInt(h0);
              e1 += BigInt(h1);
              covered += HOUR;
            }
          }
          if (!(covered > 0)) continue;
          const earned = (Number(e0) / 10 ** r.dec0) * r.p0 + (Number(e1) / 10 ** r.dec1) * r.p1;
          aprs.set(`${win}|${r.ref}`, { apr: (earned / r.value) * (YEAR_MS / (covered * 1000)), secs: covered, full: covered >= secs * 0.95 });
        }
        store.update(COLLECTION, (d) => {
          d.earned = { ...d.earned, ...kept };
        });
      } catch {
        // This pool keeps the counter's APR.
      }
    }
  }));
  aprBusy = '';
  store.refresh();
  if (aprAgain || view.window !== win) {
    aprAgain = false;
    loadAprs(store);
  }
}

// Token logos arrive once, from the token list. The page redraws when they do.
function askLogos(store) {
  if (logosAsked) return;
  logosAsked = true;
  tokenLogos().then((map) => {
    logoMap = map;
    store.refresh();
  });
}

const amount = (n) => (n >= 1000 ? n.toLocaleString(undefined, { maximumFractionDigits: 0 }) : n >= 1 ? n.toFixed(2) : n.toPrecision(4));
const price = (n) => (n === Infinity ? '∞' : n === 0 ? '0' : amount(n));
const usdOrDash = (n) => (n === null ? '—' : money(n, 'USD'));
const pct = (n) => `${(n * 100).toFixed(n < 0.1 ? 2 : 1)}%`;
const span = (secs) => (secs >= 2 * 86400 ? `${(secs / 86400).toFixed(1)} days` : secs >= 2 * 3600 ? `${(secs / 3600).toFixed(1)} hours` : `${Math.round(secs / 60)} min`);
// Fee APR as shown: from swaps, else from the counter, else how long the counter still needs.
function aprText(r) {
  if (r.apr != null && r.aprSecs != null && !r.aprFull) return `${pct(r.apr)} · ${span(r.aprSecs).replace(/ (days|hours)$/, (m) => (m === ' days' ? ' d' : ' h'))}`;
  if (r.apr != null) return pct(r.apr);
  if (r.aprLeft > 0) return `counting · ${Math.ceil(r.aprLeft / 60000)} min`;
  return aprBusy ? '…' : '—';
}
function aprTitle(r) {
  if (r.aprSecs != null) {
    return r.aprFull
      ? `Fees from the swaps in the last ${WINDOWS[view.window][1]}, as a yearly rate of the value. An estimate.`
      : `Fees from the swaps in the last ${span(r.aprSecs)} only, as a yearly rate: the node gave no more history in this load.`;
  }
  return 'The swaps could not be read, so this counts the fees earned since the board started counting, as a yearly rate. Shown after an hour.';
}

// A short, stable colour for a symbol, so a missing logo still looks like it belongs to its token.
function hueOf(text) {
  let hash = 0;
  for (const c of String(text)) hash = (hash * 31 + c.charCodeAt(0)) % 360;
  return hash;
}

// A logo image, or a monogram when there is no image or it fails to load.
function logo(src, label, cls = '') {
  const monogram = () => h('span', { class: 'mono', style: { '--hue': hueOf(label) }, 'aria-hidden': 'true' }, String(label).slice(0, 2).toUpperCase());
  if (!src) return h('span', { class: `logo ${cls}`, title: label }, monogram());
  return h('span', { class: `logo ${cls}`, title: label },
    h('img', { src, alt: '', loading: 'lazy', onerror: (e) => e.currentTarget.replaceWith(monogram()) }));
}

const tokenLogoOf = (row, address) => logoMap.get(`${row.chainId}:${address.toLowerCase()}`) ?? null;
const chainOf = (chainId) => CHAINS.find((c) => c.id === chainId);

// The price range as a track: the band is the position's range and the dot is the current price.
function rangeView(r) {
  return h('div', { class: 'range' },
    h('div', { class: r.full ? 'range-track full' : 'range-track' },
      h('span', { class: 'range-band' }),
      r.full ? null : h('span', { class: `range-marker ${r.inRange ? 'in' : 'out'}`, style: { left: `${r.marker}%` } })),
    h('div', { class: 'range-foot' },
      h('span', null, r.full ? 'Full range' : `${price(r.min)} ${r.sym1}`),
      h('span', { class: 'now' }, r.full ? '' : `now ${price(r.current)}`),
      h('span', null, r.full ? '' : `${price(r.max)} ${r.sym1}`)));
}

// The token split as a bar: the share of value in each token.
function distribution(row) {
  if (row.share0 === null) return h('div', { class: 'muted small' }, `${amount(row.a0)} ${row.sym0} · ${amount(row.a1)} ${row.sym1}`);
  const pct0 = Math.round(row.share0 * 100);
  return h('div', { class: 'dist' },
    h('div', { class: 'dist-bar' },
      h('span', { class: 'dist-a', style: { width: `${pct0}%` } }),
      h('span', { class: 'dist-b', style: { width: `${100 - pct0}%` } })),
    h('div', { class: 'muted small' }, `${pct0}% ${row.sym0} · ${100 - pct0}% ${row.sym1}`));
}

// Marks a row that may be out of date: read earlier, or valued with earlier prices.
function outdatedPill(r) {
  if (r.staleAt) return h('span', { class: 'outdated-pill', title: `This read failed. Showing the read from ${ago(r.staleAt)}.` }, `Outdated · ${ago(r.staleAt)}`);
  if (r.pricesAt) return h('span', { class: 'outdated-pill', title: `Prices could not be read. Values use the prices from ${ago(r.pricesAt)}.` }, 'Old prices');
  return null;
}

// A sort as text, "value-desc", for the menu and the address. The first names (newest, oldest, fees, apr) still read.
const sortName = (key, dir) => `${key}-${dir > 0 ? 'asc' : 'desc'}`;
function parseSort(text = '') {
  const old = { newest: ['number', -1], oldest: ['number', 1] }[text];
  if (old) return old;
  const [key, d] = String(text).split('-');
  if (!Object.hasOwn(SORTS, key)) return ['value', -1];
  return [key, d === 'asc' ? 1 : d === 'desc' ? -1 : SORTS[key].dir];
}
function sortOptions() {
  const current = sortName(view.sort, view.dir);
  const options = PRESETS.map(([key, dir, label]) => [sortName(key, dir), label]);
  if (!options.some(([name]) => name === current)) {
    options.push([current, `${SORT_NAMES[view.sort]} ${view.dir > 0 ? '↑' : '↓'}`]);
  }
  return options.map(([name, label]) => h('option', { value: name, selected: name === current }, label));
}

const APR_TITLE = 'Fees from the pool\'s swaps in the chosen window, as a yearly rate of the value. Where swaps cannot be read, the fees earned since the board started counting.';

function poolStat(label, value, title = null) {
  return h('div', { class: 'pool-stat', title }, h('span', null, label), h('strong', null, value));
}

// One position as a card: the pair, its chain and fee, the range, the value and the token split.
function poolCard(r, i) {
  const chain = chainOf(r.chainId);
  return h('article', { class: `pool-card ${r.inRange ? 'is-in' : 'is-out'}${i === null ? '' : ' enter'}`, style: { '--i': i ?? 0 } },
    h('header', { class: 'pool-head' },
      h('div', { class: 'pair' },
        logo(tokenLogoOf(r, r.addr0), r.sym0, 'token'),
        logo(tokenLogoOf(r, r.addr1), r.sym1, 'token second')),
      h('div', { class: 'pool-title' },
        h('strong', null, r.pair),
        h('div', { class: 'pool-meta' },
          h('span', { class: 'chain-chip' }, logo(chain?.logo, r.chain, 'xs'), r.chain),
          h('span', { class: 'version-pill', title: `Uniswap ${r.version}` }, r.version),
          h('span', { class: 'fee-pill' }, `${r.feePct}%`),
          h('span', { class: r.inRange ? 'status-pill in' : 'status-pill out' },
            h('span', { class: 'dot' }),
            r.inRange ? 'In range' : 'Out of range'),
          outdatedPill(r))),
      r.url ? h('a', { href: r.url, target: '_blank', rel: 'noopener', class: 'icon-btn pool-open', title: 'Open on Uniswap', 'aria-label': `Open position ${r.tokenId} on Uniswap` }, icon('link')) : null),
    rangeView(r),
    h('div', { class: 'pool-stats' },
      poolStat('Value', usdOrDash(r.value)),
      poolStat('Unclaimed fees', usdOrDash(r.fees)),
      poolStat(`Fee APR · ${WINDOWS[view.window][1]}`, aprText(r), aprTitle(r))),
    distribution(r),
    h('footer', { class: 'pool-foot muted small' },
      h('span', null, r.owner),
      h('span', null, `#${r.tokenId}`)));
}

// Placeholders shown while the first read is running.
function skeletonCard(i) {
  return h('article', { class: 'pool-card ghost', style: { '--i': i }, 'aria-hidden': 'true' },
    h('div', { class: 'pool-head' },
      h('span', { class: 'skeleton sk-circle' }),
      h('div', { class: 'sk-stack' }, h('span', { class: 'skeleton sk-line w60' }), h('span', { class: 'skeleton sk-line w40' }))),
    h('span', { class: 'skeleton sk-line' }),
    h('div', { class: 'pool-stats' }, h('span', { class: 'skeleton sk-block' }), h('span', { class: 'skeleton sk-block' })));
}

// Counts a number from what was shown to its new value.
function countUp(el, from, to, format) {
  const start = performance.now();
  const duration = 900;
  const step = (now) => {
    const t = Math.min(1, (now - start) / duration);
    const eased = 1 - (1 - t) ** 3;
    el.textContent = format(from + (to - from) * eased);
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function updatedText() {
  if (!state.at) return '';
  const mins = Math.round((Date.now() - state.at) / 60000);
  return mins < 1 ? 'Updated just now' : `Updated ${mins} min ago`;
}

// The same positions as a table, for comparing many at once.
function poolTable(rows, store) {
  return h('div', { class: 'card mon-scroll' },
    h('table', { class: 'mon-table lp-table' },
      h('thead', null, h('tr', null,
        sortHead(store, 'pool', 'Pool'),
        sortHead(store, 'chain', 'Chain'),
        sortHead(store, 'range', 'Price range', { title: 'Full range first, then by room to the nearer edge, out of range last' }),
        sortHead(store, 'split', 'Distribution', { title: `By the share of the first token` }),
        sortHead(store, 'value', 'Value', { class: 'num' }),
        sortHead(store, 'fees', 'Unclaimed fees', { class: 'num' }),
        sortHead(store, 'apr', 'Fee APR', { class: 'num', title: APR_TITLE }),
        h('th', null, ''))),
      h('tbody', null, rows.map((r) =>
        h('tr', null,
          h('td', null, h('div', { class: 'row' },
            h('div', { class: 'pair' }, logo(tokenLogoOf(r, r.addr0), r.sym0, 'token'), logo(tokenLogoOf(r, r.addr1), r.sym1, 'token second')),
            h('div', null, h('strong', null, r.pair), ' ', h('span', { class: 'version-pill', title: `Uniswap ${r.version}` }, r.version), outdatedPill(r), h('div', { class: 'muted small' }, `${r.owner} · #${r.tokenId}`)))),
          h('td', null, h('span', { class: 'chain-chip' }, logo(chainOf(r.chainId)?.logo, r.chain, 'xs'), r.chain), h('div', { class: 'muted small' }, `${r.feePct}% fee`)),
          h('td', null,
            h('div', null, r.full ? 'Full range' : `${price(r.min)} → ${price(r.max)} ${r.sym1}`),
            h('div', { class: 'row' },
              h('span', { class: r.inRange ? 'status-pill in' : 'status-pill out' }, h('span', { class: 'dot' }), r.inRange ? 'In range' : 'Out of range'),
              r.full ? null : h('span', { class: 'muted small' }, `now ${price(r.current)}`))),
          h('td', null, distribution(r)),
          h('td', { class: 'num' }, usdOrDash(r.value)),
          h('td', { class: 'num' }, usdOrDash(r.fees)),
          h('td', { class: 'num', title: aprTitle(r) }, aprText(r)),
          h('td', null, r.url
            ? h('a', { href: r.url, target: '_blank', rel: 'noopener', class: 'icon-btn', title: 'Open on Uniswap', 'aria-label': `Open position ${r.tokenId} on Uniswap` }, icon('link'))
            : null))))));
}

function openAdd(store) {
  view.adding = true;
  view.addMessage = '';
  store.refresh();
}

// Adds one position the board did not find: a link copied from the Uniswap app, or a number with its chain and
// version. It is saved in Settings, where it can be removed, and read straight away.
function addForm(store) {
  const submit = (e) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const entry = parsePosition(form.get('position'), Number(form.get('chain')), String(form.get('version')));
    if (!entry) {
      view.addMessage = 'Paste a position link from app.uniswap.org, or type the position number and pick its chain and version.';
      return store.refresh();
    }
    const error = addPosition(store, entry);
    if (error) {
      view.addMessage = error;
      return store.refresh();
    }
    view.adding = false;
    view.addMessage = '';
    store.refresh();
    load(store);
  };
  return h('form', { class: 'card panel stack lp-add', onsubmit: submit },
    h('h3', null, 'Add a position'),
    h('p', { class: 'muted small' }, 'For a position the board does not find: a v3 position held by an address not in your wallets, or a v4 position older than the node keeps. A link from app.uniswap.org names its chain and version. A number needs both picked.'),
    h('input', { name: 'position', placeholder: 'https://app.uniswap.org/positions/v4/base/123456 or 123456', spellcheck: false, autofocus: true, 'aria-label': 'Position link or number' }),
    h('div', { class: 'row' },
      h('select', { name: 'chain', 'aria-label': 'Chain of the position' }, CHAINS.map((c) => h('option', { value: String(c.id) }, c.name))),
      h('select', { name: 'version', 'aria-label': 'Uniswap version' }, h('option', { value: 'v4' }, 'v4'), h('option', { value: 'v3' }, 'v3')),
      h('button', { type: 'submit', class: 'btn-small' }, 'Add'),
      h('button', { type: 'button', class: 'btn-small', onclick: () => { view.adding = false; store.refresh(); } }, 'Cancel')),
    view.addMessage ? notice({ text: view.addMessage }) : null);
}

function draw(root, store) {
  const cfg = store.get('settings').uniswap ?? {};
  const wallets = (cfg.wallets ?? []).filter((w) => isAddress(w.address));
  if (!wallets.length && !addedPositions(cfg).length) {
    return root.replaceChildren(h('div', { class: 'stack-lg' },
      h('h2', null, 'Liquidity Pools'),
      setupBanner('uniswap', 'Add a wallet address in Settings to see its Uniswap positions.'),
      view.adding ? addForm(store) : h('button', { type: 'button', class: 'btn-small', onclick: () => openAdd(store) }, icon('plus'), 'Add a position by link or number')));
  }
  // Until the first read lands, show what the last one saved.
  if (state.status === 'idle' && !state.rows.length) {
    state.rows = savedRows(store, cfg, cacheKeys(enabledChains(cfg))).sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
  }
  if (state.status === 'idle' || (state.status === 'ok' && Date.now() - state.at > STALE_MS)) {
    setTimeout(() => load(store), 0);
  }
  askLogos(store);

  const chainCount = enabledChains(cfg).length;
  const all = state.rows;
  // Chain chips show only chains that have positions, so the row stays short.
  const chainsWithRows = CHAINS.filter((c) => all.some((r) => r.chainId === c.id));
  if (view.chain !== 'all' && !chainsWithRows.some((c) => c.id === view.chain)) view.chain = 'all';
  const byChain = view.chain === 'all' ? all : all.filter((r) => r.chainId === view.chain);
  const inRange = byChain.filter((r) => r.inRange).length;
  const baselines = store.get(COLLECTION)?.fees ?? {};
  const shown = sortRows((view.filter === 'in' ? byChain.filter((r) => r.inRange) : view.filter === 'out' ? byChain.filter((r) => !r.inRange) : byChain)
    .map((r) => {
      const s = aprs.get(`${view.window}|${r.ref}`);
      return s
        ? { ...r, apr: s.apr, aprSecs: s.secs, aprFull: s.full }
        : { ...r, apr: feeApr(r, baselines), aprLeft: counterLeft(r, baselines) };
    }), view.sort, view.dir);
  const totalValue = byChain.reduce((s, r) => s + (r.value ?? 0), 0);
  const totalFees = byChain.reduce((s, r) => s + (r.fees ?? 0), 0);
  const totalValueKnown = byChain.some((r) => r.value !== null);
  const totalFeesKnown = byChain.some((r) => r.fees !== null);

  // Totals count from the old number to the new one when it changes, as each chain lands or a filter changes.
  const counters = [];
  const total = (el, known, value, key) => {
    if (!known) return;
    const from = shownTotals[key];
    shownTotals[key] = value;
    if (from === value) el.textContent = usdOrDash(value);
    else counters.push(() => countUp(el, from, value, (n) => money(n, 'USD')));
  };
  const valueEl = h('strong', null, '—');
  const feesEl = h('strong', null, '—');
  total(valueEl, totalValueKnown, totalValue, 'value');
  total(feesEl, totalFeesKnown, totalFees, 'fees');

  const chip = (key, label, count) => h('button', {
    type: 'button',
    class: view.filter === key ? 'lp-chip active' : 'lp-chip',
    onclick: () => {
      view.filter = key;
      store.refresh();
    },
  }, label, h('span', { class: 'chip-count' }, count));

  const chainChip = (key, label, logoSrc, count) => h('button', {
    type: 'button',
    class: view.chain === key ? 'lp-chip chain active' : 'lp-chip chain',
    onclick: () => {
      view.chain = key;
      store.refresh();
    },
  }, key === 'all' ? null : logo(logoSrc, label, 'xs'), label, h('span', { class: 'chip-count' }, count));

  const reading = state.status === 'loading';
  const firstRead = reading && all.length === 0;
  const staleText = state.stale.length
    ? `Could not read ${state.stale.map((x) => `${x.name} (last read ${ago(x.at)})`).join(', ')}. Those positions are from the last read and may be out of date.`
    : '';

  let body;
  if (firstRead) {
    body = h('div', { class: 'lp-grid' }, [0, 1, 2].map((i) => skeletonCard(i)));
  } else if (shown.length) {
    // Rows new to the screen slide in, one after another; the rest stay still.
    let order = 0;
    body = view.layout === 'list'
      ? poolTable(shown, store)
      : h('div', { class: 'lp-grid' }, shown.map((r) => poolCard(r, seen.has(r.ref) ? null : order++)));
    shown.forEach((r) => seen.add(r.ref));
  } else {
    const filtered = view.filter !== 'all' || view.chain !== 'all';
    body = h('div', { class: 'lp-empty' },
      h('span', { class: 'float' }, icon('wallet')),
      h('p', null, all.length && filtered ? 'No positions match this filter.' : 'No open Uniswap positions for these wallets.'));
  }

  root.replaceChildren(h('div', { class: 'stack-lg lp' },
    h('div', { class: 'row between lp-head' },
      h('div', null,
        h('h2', null, 'Liquidity Pools'),
        h('p', { class: 'muted small' },
          `Uniswap v3 and v4 positions on ${chainCount} chain${chainCount === 1 ? '' : 's'}, read from the chain. Read-only.`,
          state.pending.length ? ` Reading ${state.pending.join(', ')}…` : state.at ? ` ${updatedText()}.` : '')),
      h('div', { class: 'row' },
        h('button', { type: 'button', class: 'btn-small', onclick: () => openAdd(store), title: 'Add a position the board did not find' }, icon('plus'), 'Add position'),
        h('button', { type: 'button', class: 'btn-small', disabled: reading || chainCount === 0, onclick: () => load(store) },
        refreshIcon(reading),
          reading ? 'Reading…' : 'Refresh'))),

    view.adding ? addForm(store) : null,
    state.shallow.length
      ? notice({ tone: 'info', text: `The node for ${state.shallow.join(', ')} keeps only recent history, so older v4 positions there are not found. Add them with Add position, or set a node that keeps full history in Settings.` })
      : null,
    staleText ? notice({ tone: 'info', text: staleText }) : null,
    !state.at && all.length ? notice({ tone: 'info', text: 'Showing the positions saved by the last read while the chains are read again.' }) : null,
    state.warning ? notice({ tone: 'info', text: state.warning }) : null,
    state.status === 'error' ? notice({ text: `The positions could not be read: ${state.error}` }) : null,
    chainCount === 0 ? notice({ tone: 'info', text: 'No chains are selected. Pick the chains to read in Settings.' }) : null,

    h('div', { class: 'lp-stats' },
      h('div', { class: 'card lp-stat' }, h('span', { class: 'muted' }, 'Total liquidity'), valueEl),
      h('div', { class: 'card lp-stat' }, h('span', { class: 'muted' }, 'Unclaimed fees'), feesEl),
      h('div', { class: 'card lp-stat' }, h('span', { class: 'muted' }, 'Positions'), h('strong', null, `${byChain.length} · ${inRange} in range`))),

    chainsWithRows.length > 1
      ? h('div', { class: 'row lp-filters lp-chains' },
          chainChip('all', 'All chains', null, all.length),
          chainsWithRows.map((c) => chainChip(c.id, c.name, c.logo, all.filter((r) => r.chainId === c.id).length)))
      : null,

    h('div', { class: 'row between' },
      h('div', { class: 'row lp-filters' },
        chip('all', 'All', byChain.length),
        chip('in', 'In range', inRange),
        chip('out', 'Out of range', byChain.length - inRange)),
      h('div', { class: 'row lp-tools' },
      h('label', { class: 'inline lp-sort', title: 'The time fee APR is read over' }, 'APR',
        h('select', {
          'aria-label': 'Fee APR window',
          onchange: (e) => {
            view.window = e.target.value;
            store.refresh();
            loadAprs(store);
          },
        }, Object.entries(WINDOWS).map(([key, [, label]]) => h('option', { value: key, selected: key === view.window }, label)))),
      h('label', { class: 'inline lp-sort' }, 'Sort',
        h('select', {
          'aria-label': 'Sort positions',
          onchange: (e) => {
            [view.sort, view.dir] = parseSort(e.target.value);
            store.refresh();
          },
        }, sortOptions())),
      h('div', { class: 'segmented lp-layout', role: 'group', 'aria-label': 'View' },
        [['cards', 'Cards', 'cards'], ['list', 'List', 'list']].map(([key, label, iconName]) =>
          h('button', {
            type: 'button',
            class: view.layout === key ? 'seg active' : 'seg',
            'aria-pressed': String(view.layout === key),
            onclick: () => {
              view.layout = key;
              store.refresh();
            },
          }, icon(iconName), label))))),

    body));

  for (const run of counters) run();
}

export default {
  id: 'positions',
  title: 'Liquidity Pools',
  short: 'Pools',
  icon: 'droplet',
  collection: COLLECTION,
  defaults: { cache: {}, prices: {}, scan: {}, fees: {}, earned: {} },
  render: draw,
  serialize: () => ({
    filter: view.filter === 'all' ? '' : view.filter,
    chain: view.chain === 'all' ? '' : String(view.chain),
    view: view.layout === 'list' ? 'list' : '',
    sort: view.sort === 'value' && view.dir === -1 ? '' : sortName(view.sort, view.dir),
    apr: view.window === '24h' ? '' : view.window,
  }),
  restore: (p = {}) => {
    view.filter = ['in', 'out'].includes(p.filter) ? p.filter : 'all';
    view.layout = p.view === 'list' ? 'list' : 'cards';
    [view.sort, view.dir] = parseSort(p.sort);
    view.window = Object.hasOwn(WINDOWS, p.apr) ? p.apr : '24h';
    const id = Number(p.chain);
    view.chain = CHAINS.some((c) => c.id === id) ? id : 'all';
  },
};
