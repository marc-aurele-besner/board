import { h, icon, refreshIcon, money, empty, notice, uid, todayISO, copyable } from '../ui.js';
import { barChart, lineChart, legend } from '../chart.js';
import { toast } from '../toast.js';
import { setupBanner } from '../integrations.js';
import { positionFields, positionError } from '../position-input.js';
import { poolsChanged } from '../automations.js';
import { insightsPanel } from '../pool-insights.js';
import { readPositions, poolState, tokenMeta, usdPrices, positionAmounts, priceAtTick, isAddress, CHAINS, chainSettings, tokenLogos, scanV4, readV4Position, readV3Position, addedPositions, parsePosition, addPosition, chainClock, poolSwaps, swapFees, swapEarn, isClosed, positionHistory, collectFees, usdPricesAt, nodeSource, etherscanSource, collectTx, positionsInReceipt, walletPositionTxs } from '../uniswap.js';

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
// adding: the form to add a position by hand is open.
// window: the WINDOWS key fee APR is read over.
// feeSort, feeDir: the Fees collected table's sort. feeChain, feeToken, feeSource: its filters.
const view = { filter: 'all', chain: 'all', layout: 'cards', sort: 'value', dir: -1, adding: false, window: '24h', feeSort: 'date', feeDir: -1, feeChain: 'all', feeToken: 'all', feeSource: 'all', coverageOpen: false };
// Loaded positions and the state of the last load. shallow: chains whose node would not search back to v4's start.
// stale: chains shown from the last good read because this one failed, with when that read was.
// pending: chains still being read in the current load.
const state = { status: 'idle', rows: [], error: '', warning: '', at: 0, shallow: [], stale: [], pending: [] };
// pools.json keeps the last good read of each chain and version, the last good prices of each chain, and how far
// each v4 search got. A read that fails then shows the old rows, marked as possibly out of date.
const COLLECTION = 'pools';
const tokenInfo = new Map(); // "chainId:token address" -> { symbol, decimals }
let loading = false;
let readAgain = false; // a position was added during a load, so read once more when it ends
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
    // closed: emptied but not burned. It is kept out of the totals and shown under its own filter.
    closed: isClosed(p),
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
    // Fees read by a simulated collect, not the stored amounts, which lag. Only these can tell a collect apart.
    feesFull: Boolean(p.feesFull),
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

// Collections seen between the last saved read of a part (before) and this one: unclaimed fees only fall when they
// are collected. What was unclaimed at the last read is logged, so fees earned between that read and the collect
// are missed: the amount is a floor. Fees read from the stored amounts lag, so only full reads are compared.
function collectsOf(before, rows, now) {
  if (!before?.rows?.length) return [];
  const old = new Map(before.rows.map((r) => [r.ref, r]));
  const out = [];
  for (const r of rows) {
    const o = old.get(r.ref);
    if (!o?.feesFull || !r.feesFull || typeof o.fee0 !== 'number' || typeof r.fee0 !== 'number') continue;
    if (!(o.fee0 > 0 || o.fee1 > 0) || !(r.fee0 < o.fee0 || r.fee1 < o.fee1)) continue;
    const p0 = r.p0 ?? o.p0;
    const p1 = r.p1 ?? o.p1;
    out.push({
      id: uid(),
      at: new Date(now).toISOString(),
      since: new Date(before.at).toISOString(),
      source: 'auto',
      ref: r.ref,
      pair: r.pair,
      chain: r.chain,
      tokenId: r.tokenId,
      a0: o.fee0,
      a1: o.fee1,
      sym0: r.sym0,
      sym1: r.sym1,
      usd: p0 != null && p1 != null ? o.fee0 * p0 + o.fee1 * p1 : null,
    });
  }
  return out;
}

// Whether a fee counter entry stands for a collect made at time t (ms): it was seen between two reads around t.
const coversCollect = (c, t) => t >= Date.parse(c.since) - 60000 && t <= Date.parse(c.at) + 60000;

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
  move: { value: (r) => r.move, dir: -1 },
};
// The choices in the Sort menu. Sorting by a table column that is not here adds it to the menu as it is.
const PRESETS = [['value', -1, 'Value'], ['fees', -1, 'Unclaimed fees'], ['apr', -1, 'Fee APR'], ['move', -1, 'Movement'], ['number', -1, 'Newest'], ['number', 1, 'Oldest']];
const SORT_NAMES = { pool: 'Pool', chain: 'Chain', range: 'Price range', split: 'Distribution', move: 'Movement', value: 'Value', fees: 'Unclaimed fees', apr: 'Fee APR', number: 'Number' };

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
    .filter((r) => r && (manual.has(r.position.tokenId) || labels.has(r.position.owner)))
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
    .filter(Boolean)
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
const cacheKeys = (chains) => chains.flatMap((c) => (c.v4 ? [`${c.id}:v3`, `${c.id}:v4`] : [`${c.id}:v3`]));
const enabledChains = (cfg) => CHAINS.filter((chain) => chainSettings(cfg, chain).enabled);

// Open positions outside their price range as of the last saved read, for Home. Nothing is read from a chain here.
export function outOfRange(store) {
  const cfg = store.get('settings').uniswap ?? {};
  return savedRows(store, cfg, cacheKeys(enabledChains(cfg))).filter((r) => !r.inRange && !r.closed);
}

// Reads every enabled chain in parallel, and v3 and v4 side by side on each. Each part shows as soon as it is read,
// replacing what was on screen for it; until then the earlier rows stay. A part that fails shows its last good read.
// again: a load already running reads once more when it ends, as it took the settings before the change.
async function load(store, { again = false } = {}) {
  if (loading) {
    if (again) readAgain = true;
    return;
  }
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
            // A collect already read from the chain is not logged again from the fee counter.
            const found = collectsOf(d.cache?.[key], done.rows, Date.now())
              .filter((f) => !(d.collected ?? []).some((c) => c.tx && c.ref === f.ref && coversCollect(f, Date.parse(c.at))));
            if (found.length) d.collected = [...(d.collected ?? []), ...found];
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
        chain.v4 ? part('v4', () => readV4(chain, node, wallets, cfg, saved.scan?.[chain.id] ?? {})) : null,
      ]);
      state.pending = state.pending.filter((name) => name !== chain.name);
      publish();
    }));

    state.status = 'ok';
    state.at = Date.now();
    // Tell the automation rules and the notifications which positions left their range. Old rows are left out.
    poolsChanged(store, state.rows.filter((r) => !r.staleAt && !r.closed));
  } catch (err) {
    state.status = 'error';
    state.error = err.message;
  } finally {
    loading = false;
    state.pending = [];
    store.refresh();
  }
  if (readAgain) {
    readAgain = false;
    return load(store);
  }
  if (state.status === 'ok') {
    loadAprs(store);
    loadHistory(store);
  }
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
  for (const r of state.rows.filter((x) => x.liq != null && x.pool && !x.closed)) byChain.set(r.chainId, [...(byChain.get(r.chainId) ?? []), r]);
  await Promise.all([...byChain].map(async ([chainId, rows]) => {
    const chain = chainOf(chainId);
    const { node } = chainSettings(cfg, chain);
    let clock;
    try {
      clock = await chainClock(node);
    } catch {
      return;
    }
    // Two windows are read: the chosen one, and the one before it, for the APR's movement.
    const curFrom = clock.head - Math.ceil(secs / clock.perBlock);
    const from = clock.head - Math.ceil((2 * secs) / clock.perBlock);
    const pools = new Map();
    for (const r of rows) pools.set(`${r.version}:${r.pool}`, [...(pools.get(`${r.version}:${r.pool}`) ?? []), r]);
    for (const list of pools.values()) {
      try {
        const c = await poolSwaps(chain, node, list[0].version, list[0].pool, from, clock.head);
        const start = Math.max(curFrom, c.from);
        const prevStart = Math.max(from, c.from);
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
          const usd = (a, b) => (Number(a) / 10 ** r.dec0) * r.p0 + (Number(b) / 10 ** r.dec1) * r.p1;
          const rate = (earned, over) => (earned / r.value) * (YEAR_MS / (over * 1000));
          // The window before, valued at today's prices and value too, so the movement is the fee rate alone.
          let p0 = 0n;
          let p1 = 0n;
          let prevCovered = 0;
          if (c.from < curFrom && c.from <= clock.head) {
            const e = swapFees(c.swaps, prevStart, pos, curFrom);
            p0 = e.e0;
            p1 = e.e1;
            prevCovered = (curFrom - prevStart) * clock.perBlock;
          }
          for (const [hour, [h0, h1]] of Object.entries(hours)) {
            const t = Number(hour) * HOUR;
            if (t >= winFrom - secs && t + HOUR <= Math.min(readFrom, winFrom)) {
              p0 += BigInt(h0);
              p1 += BigInt(h1);
              prevCovered += HOUR;
            }
          }
          prevCovered = Math.min(secs, prevCovered);
          aprs.set(`${win}|${r.ref}`, {
            apr: rate(usd(e0, e1), covered),
            secs: covered,
            full: covered >= secs * 0.95,
            prev: prevCovered > 0 ? rate(usd(p0, p1), prevCovered) : null,
            prevSecs: prevCovered,
          });
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

// Collects read from the chain, three ways, each a check on the others:
// - v3, from the node: the position manager's events give the exact fees, even when liquidity was removed in an
//   earlier transaction (level 4);
// - v4, from the node: the pool manager's events find each collect, and its transaction says what it paid;
// - with an Etherscan key: each wallet's transactions to the position managers, read the same way, back to the
//   wallet's first one, however little history the node keeps.
// A collect is one transaction for one position. When two ways read it, the surer one (higher level) stays. Each
// replaces the fee counter's entry for the same collect; one the user removed is remembered in `hidden`.
// One position or transaction at a time per chain, as public nodes and Etherscan limit bursts.
const ETHERSCAN_TXS = 40; // transactions read from Etherscan per chain and load
const collectKey = (c) => (c.tx && c.ref ? `${c.ref}|${String(c.tx).toLowerCase()}` : c.id);
// Entries from the v3 events came before levels, and are the surest.
const levelOf = (c) => c.level ?? (c.source === 'chain' ? 4 : 0);
const etherscanErrors = new Map(); // chain name -> the last Etherscan error, shown on Fees collected

// Whether a reading of a collect would add to the log: new, or surer than the one kept, and not removed.
function wanted(store, ref, tx, level) {
  const d = store.get(COLLECTION) ?? {};
  const key = `${ref}|${String(tx).toLowerCase()}`;
  if ((d.hidden ?? []).includes(key)) return false;
  const have = (d.collected ?? []).find((c) => collectKey(c) === key);
  return !have || level > levelOf(have);
}

// A log entry for a reading: fees in tokens, valued at the token prices when they were collected.
async function collectEntry(chain, r, tx, time, f0, f1, level, source) {
  const a0 = f0 / 10 ** r.dec0;
  const a1 = f1 / 10 ** r.dec1;
  let usd = null;
  try {
    const p = await usdPricesAt(chain, [r.addr0, r.addr1], time);
    const p0 = p[r.addr0.toLowerCase()];
    const p1 = p[r.addr1.toLowerCase()];
    if (p0 != null && p1 != null) usd = a0 * p0 + a1 * p1;
  } catch {
    // Logged without a value; the totals leave it out and say so.
  }
  return { id: `chain:${r.ref}:${tx}`, at: new Date(time * 1000).toISOString(), source, level, tx, ref: r.ref, pair: r.pair, chain: r.chain, chainId: r.chainId, tokenId: r.tokenId, a0, a1, sym0: r.sym0, sym1: r.sym1, addr0: r.addr0, addr1: r.addr1, usd };
}

function mergeCollects(d, found) {
  const hidden = new Set(d.hidden ?? []);
  const list = [...(d.collected ?? [])];
  for (const f of found) {
    const key = collectKey(f);
    if (hidden.has(key)) continue;
    const i = list.findIndex((c) => collectKey(c) === key);
    if (i < 0) list.push(f);
    else if (levelOf(f) > levelOf(list[i])) list[i] = f;
  }
  d.collected = list.filter((c) => !(c.source === 'auto' && list.some((x) => x.tx && x.ref === c.ref && coversCollect(c, Date.parse(x.at)))));
}

// What a row needs for reading its collect transactions.
const posOf = (r) => ({ version: r.version, tokenId: r.tokenId, owner: r.wallet, token0: r.addr0, token1: r.addr1 });

// What each chain's search is doing right now, said under Search coverage: chainId -> text.
const activity = new Map();
const clocks = new Map(); // chainId -> the chain's clock, to put dates on the block ranges searched
function tell(store, chainId, text) {
  activity.set(chainId, text);
  store.refresh();
}

// A block range as dates, from the chain's clock, with the blocks. Dates are estimated from the block time, so a
// short range shows the hour too.
function blockSpan(chainId, from, to) {
  const blocks = `blocks ${from.toLocaleString()}–${to.toLocaleString()}`;
  const clock = clocks.get(chainId);
  if (!clock) return blocks;
  const at = (b) => new Date((clock.time - (clock.head - b) * clock.perBlock) * 1000);
  const a = at(from);
  const b = at(to);
  const opts = b - a < 2 * DAY_MS ? { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' } : { month: 'short', day: 'numeric', year: 'numeric' };
  return `${a.toLocaleString(undefined, opts)} – ${b.toLocaleString(undefined, opts)} (${blocks})`;
}

// One position's collects from the node. step names it among the chain's positions ("2 of 7").
async function nodeCollects(store, chain, node, r, step) {
  const label = `Position ${step}: ${r.pair} #${r.tokenId} (${r.version})`;
  const prev = store.get(COLLECTION)?.history?.[r.ref];
  tell(store, chain.id, `${label} · reading new blocks`);
  const s = await positionHistory(chain, node, { version: r.version, tokenId: r.tokenId, liquidity: r.liq, pool: r.pool }, prev,
    ({ dir, from, to }) => tell(store, chain.id, `${label} · ${dir === 'new' ? 'new blocks' : 'searching back'}, ${blockSpan(chain.id, from, to)}`));
  const found = [];
  if (r.version === 'v3') {
    for (const e of collectFees(s.events)) {
      if (!e.time || (e.f0 === 0n && e.f1 === 0n) || !wanted(store, r.ref, e.tx, 4)) continue;
      found.push(await collectEntry(chain, r, e.tx, e.time, Number(e.f0), Number(e.f1), 4, 'chain'));
    }
  } else {
    // Transactions read before and found to collect nothing are not read again.
    const checked = new Set(prev?.node === node ? prev.checked ?? [] : []);
    const txs = [...new Map(s.events.filter((e) => e.kind !== 'add' && e.time).map((e) => [e.tx, e.time]))]
      .filter(([tx]) => !checked.has(tx) && wanted(store, r.ref, tx, 3));
    for (const [i, [tx, time]] of txs.entries()) {
      tell(store, chain.id, `${label} · reading what transaction ${i + 1} of ${txs.length} collected (${new Date(time * 1000).toLocaleString()})`);
      const res = await collectTx(chain, nodeSource(node), node, tx, posOf(r));
      if (!res || res.level > 1) checked.add(tx);
      if (res && (res.f0 > 0 || res.f1 > 0) && wanted(store, r.ref, tx, res.level)) found.push(await collectEntry(chain, r, tx, time, res.f0, res.f1, res.level, 'chain'));
    }
    s.checked = [...checked];
  }
  store.update(COLLECTION, (d) => {
    d.history = { ...d.history, [r.ref]: s };
    if (found.length) mergeCollects(d, found);
  });
}

// One chain's collects from each wallet's transactions on Etherscan, from where the last load got to. Only
// positions the board shows are logged: a burned position no longer says what its tokens are.
async function etherscanCollects(store, chain, node, key, wallets, rows) {
  const src = etherscanSource(key, chain.id);
  const byRef = new Map(rows.map((r) => [r.ref, r]));
  let budget = ETHERSCAN_TXS;
  for (const wallet of wallets) {
    const saved = store.get(COLLECTION)?.etherscan?.[chain.id]?.[wallet] ?? { block: 0, checked: [] };
    const checked = new Set(saved.checked);
    let block = saved.block;
    const found = [];
    let more = true;
    // cut: transactions were left for the next load. With no budget left, the last load's answer stands.
    let cut = budget <= 0 && !saved.caughtUp;
    const who = `Etherscan: wallet ${shortAddress(wallet)}`;
    while (more && budget > 0) {
      const start = block;
      tell(store, chain.id, `${who} · listing its position transactions from block ${start.toLocaleString()}`);
      const page = await walletPositionTxs(key, chain, wallet, start);
      const todo = page.txs.filter((t) => !checked.has(t.tx));
      const count = Math.min(todo.length, budget);
      for (const [i, t] of todo.entries()) {
        if (budget <= 0) {
          cut = true;
          break;
        }
        budget--;
        tell(store, chain.id, `${who} · reading transaction ${i + 1} of ${count} (${new Date(t.time * 1000).toLocaleString()})`);
        const receipt = await src.call('eth_getTransactionReceipt', [t.tx]);
        for (const p of await positionsInReceipt(chain, node, receipt)) {
          const r = byRef.get(refOf(p.version, chain.id, p.tokenId));
          if (!r || !wanted(store, r.ref, t.tx, 3)) continue;
          const res = await collectTx(chain, src, node, t.tx, posOf(r), receipt);
          if (res && (res.f0 > 0 || res.f1 > 0) && wanted(store, r.ref, t.tx, res.level)) found.push(await collectEntry(chain, r, t.tx, t.time, res.f0, res.f1, res.level, 'etherscan'));
        }
        checked.add(t.tx);
        block = t.block;
      }
      // The next call starts at the newest block read in full; its transactions already read are skipped.
      if (budget > 0) block = Math.max(block, page.last ?? block);
      more = page.more && budget > 0 && page.last != null && page.last > start;
      if (page.more && !more) cut = true;
    }
    // Caught up: every transaction of this wallet to the position managers, back to its first, has been read.
    const caughtUp = !cut;
    store.update(COLLECTION, (d) => {
      // Only the transactions of the block the next call starts at need remembering.
      d.etherscan = { ...d.etherscan, [chain.id]: { ...d.etherscan?.[chain.id], [wallet]: { block, checked: [...checked].slice(-200), caughtUp, at: Date.now() } } };
      if (found.length) mergeCollects(d, found);
    });
  }
}

// Chains whose collect search is running. Each chain searches on its own, so one can be pushed further while others wait.
const searching = new Set();

// One search pass for collects: each position's events a step further back, then Etherscan. `only` limits it to one
// chain, for the Search further button. A chain already searching is left to finish.
async function loadHistory(store, only = null) {
  const cfg = store.get('settings').uniswap ?? {};
  const key = String(cfg.etherscan ?? '').trim();
  const wallets = (cfg.wallets ?? []).filter((w) => isAddress(w.address)).map((w) => w.address.toLowerCase());
  const byChain = new Map();
  for (const r of state.rows.filter((x) => !x.staleAt && x.liq != null && (x.version === 'v3' || x.pool) && (only === null || x.chainId === only))) {
    byChain.set(r.chainId, [...(byChain.get(r.chainId) ?? []), r]);
  }
  const todo = [...byChain].filter(([chainId]) => !searching.has(chainId));
  if (!todo.length) return;
  todo.forEach(([chainId]) => searching.add(chainId));
  store.refresh();
  await Promise.all(todo.map(async ([chainId, rows]) => {
    const chain = chainOf(chainId);
    const { node } = chainSettings(cfg, chain);
    try {
      try {
        clocks.set(chainId, await chainClock(node));
      } catch {
        // Without the clock, the ranges are said in blocks only.
      }
      for (const [i, r] of rows.entries()) {
        try {
          await nodeCollects(store, chain, node, r, `${i + 1} of ${rows.length}`);
        } catch {
          // This position keeps the other readings until its history can be read.
        }
      }
      if (!key || chain.etherscan === false) return;
      try {
        await etherscanCollects(store, chain, node, key, wallets, rows);
        etherscanErrors.delete(chain.name);
      } catch (err) {
        etherscanErrors.set(chain.name, err.message);
      }
    } finally {
      searching.delete(chainId);
      activity.delete(chainId);
      store.refresh();
    }
  }));
}

// How far the search for collects has got, per position, from 0 to 1. A position is covered in full once its
// event search reached its opening, or once Etherscan read every transaction of its wallet. Until then, the
// share of blocks searched back toward the earliest block it could have opened at (v4's start, or for v3 the
// chain's first block, so a v3 search that has not found its opening reads low).
function searchShare(r, d, cfg) {
  const ether = String(cfg.etherscan ?? '').trim() && chainOf(r.chainId)?.etherscan !== false;
  if (ether && d.etherscan?.[r.chainId]?.[r.wallet]?.caughtUp) return 1;
  const s = d.history?.[r.ref];
  if (!s) return 0;
  const floor = s.floor ?? (r.version === 'v4' ? chainOf(r.chainId)?.v4?.start ?? 0 : 0);
  if (s.reached || s.from <= floor) return 1;
  const head = s.to;
  if (!(head > floor)) return 0;
  return Math.min(1, Math.max(0, (head - s.from + 1) / (head - floor + 1)));
}

// The search coverage of every position shown, open and closed: per chain and for all of them.
function collectCoverage(store) {
  const d = store.get(COLLECTION) ?? {};
  const cfg = store.get('settings').uniswap ?? {};
  const chains = new Map();
  for (const r of state.rows) {
    const c = chains.get(r.chain) ?? { name: r.chain, chainId: r.chainId, sum: 0, done: 0, total: 0 };
    const share = searchShare(r, d, cfg);
    c.sum += share;
    c.done += share >= 1 ? 1 : 0;
    c.total += 1;
    chains.set(r.chain, c);
  }
  const list = [...chains.values()].map((c) => ({ ...c, pct: c.sum / c.total })).sort((a, b) => a.pct - b.pct || a.name.localeCompare(b.name));
  const total = list.reduce((n, c) => n + c.total, 0);
  const sum = list.reduce((n, c) => n + c.sum, 0);
  return { chains: list, total, done: list.reduce((n, c) => n + c.done, 0), pct: total ? sum / total : 0 };
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
// A row with its fee APR over the chosen window, and its movement from the window before when both cover at
// least half of it. From the counter where swaps could not be read, which has no movement.
function aprOf(store) {
  const baselines = store.get(COLLECTION)?.fees ?? {};
  const secs = WINDOWS[view.window][0];
  return (r) => {
    const s = aprs.get(`${view.window}|${r.ref}`);
    if (!s) return { ...r, apr: feeApr(r, baselines), aprLeft: counterLeft(r, baselines), move: null };
    const move = s.prev != null && s.prevSecs >= secs / 2 && s.secs >= secs / 2 ? s.apr - s.prev : null;
    return { ...r, apr: s.apr, aprSecs: s.secs, aprFull: s.full, aprPrev: s.prev, move };
  };
}

// The APR's movement in percentage points, with an arrow.
function moveView(r) {
  if (r.closed) return h('span', { class: 'muted' }, '—');
  if (r.move == null) return h('span', { class: 'muted', title: moveTitle(r) }, aprBusy ? '…' : '—');
  const pts = r.move * 100;
  const flat = Math.abs(pts) < 0.005;
  const kind = flat ? 'flat' : pts > 0 ? 'up' : 'down';
  return h('span', { class: `apr-move ${kind}`, title: moveTitle(r) },
    flat ? null : icon(pts > 0 ? 'chevron-up' : 'chevron-down'),
    `${pts > 0 && !flat ? '+' : ''}${pts.toFixed(2)} pts`);
}
function moveTitle(r) {
  const win = WINDOWS[view.window][1];
  if (r.move == null) return `Needs fee APR over the last ${win} and the ${win} before it. Swaps or saved hours do not cover both yet.`;
  return `Fee APR over the last ${win} (${pct(r.apr)}) minus the ${win} before it (${pct(r.aprPrev)}), in percentage points. Both at today's value and prices.`;
}

// Prices are shown in token1 per token0 unless the pair is flipped. The choice is saved per pair, so it is the
// default everywhere the pair shows.
const flipKey = (r) => `${r.sym0}/${r.sym1}`;
const isFlipped = (store, r) => Boolean(store.get(COLLECTION)?.flip?.[flipKey(r)]);
function sideOf(r, flip) {
  if (!flip) return { min: r.min, max: r.max, current: r.current, marker: r.marker, unit: r.sym1, base: r.sym0 };
  return {
    min: r.max === Infinity ? 0 : 1 / r.max,
    max: r.min > 0 ? 1 / r.min : Infinity,
    current: r.current > 0 ? 1 / r.current : 0,
    marker: r.marker == null ? null : 100 - r.marker,
    unit: r.sym0,
    base: r.sym1,
  };
}
function flipButton(store, r, flip) {
  const other = flip ? r.sym1 : r.sym0;
  return h('button', {
    type: 'button',
    class: 'icon-btn flip-btn',
    title: `Show prices in ${other}`,
    'aria-label': `Show ${r.pair} prices in ${other}`,
    onclick: (e) => {
      e.stopPropagation();
      store.update(COLLECTION, (d) => {
        const next = { ...d.flip };
        if (flip) delete next[flipKey(r)];
        else next[flipKey(r)] = true;
        d.flip = next;
      });
    },
  }, icon('arrow-left-right'));
}

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
// Logos already shown once are drawn at once on a redraw: no lazy load and no fade, which made them blink.
const shownLogos = new Set();
export function logo(src, label, cls = '') {
  const monogram = () => h('span', { class: 'mono', style: { '--hue': hueOf(label) }, 'aria-hidden': 'true' }, String(label).slice(0, 2).toUpperCase());
  if (!src) return h('span', { class: `logo ${cls}`, title: label }, monogram());
  const known = shownLogos.has(src);
  return h('span', { class: `logo ${cls}`, title: label },
    h('img', {
      src,
      alt: '',
      class: known ? null : 'fresh',
      loading: known ? null : 'lazy',
      onload: () => shownLogos.add(src),
      onerror: (e) => e.currentTarget.replaceWith(monogram()),
    }));
}

const tokenLogoOf = (row, address) => logoMap.get(`${row.chainId}:${address.toLowerCase()}`) ?? null;
const chainOf = (chainId) => CHAINS.find((c) => c.id === chainId);

// The price range as a track: the band is the position's range and the dot is the current price.
function rangeView(r, store) {
  const flip = isFlipped(store, r);
  const p = sideOf(r, flip);
  return h('div', { class: 'range' },
    h('div', { class: 'range-head' },
      h('span', { class: 'muted small' }, r.full ? 'Price range' : `${p.unit} per ${p.base}`),
      r.full ? null : flipButton(store, r, flip)),
    h('div', { class: r.full ? 'range-track full' : 'range-track' },
      h('span', { class: 'range-band' }),
      r.full ? null : h('span', { class: `range-marker ${r.inRange ? 'in' : 'out'}`, style: { left: `${p.marker}%` } })),
    h('div', { class: 'range-foot' },
      h('span', null, r.full ? 'Full range' : `${price(p.min)} ${p.unit}`),
      h('span', { class: 'now' }, r.full ? '' : `now ${price(p.current)}`),
      h('span', null, r.full ? '' : `${price(p.max)} ${p.unit}`)));
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

function statusPill(r) {
  if (r.closed) return h('span', { class: 'status-pill closed', title: 'No liquidity and no unclaimed fees left' }, h('span', { class: 'dot' }), 'Closed');
  return h('span', { class: r.inRange ? 'status-pill in' : 'status-pill out' }, h('span', { class: 'dot' }), r.inRange ? 'In range' : 'Out of range');
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
function poolCard(r, i, collected, store) {
  const chain = chainOf(r.chainId);
  return h('article', {
    class: `pool-card clickable ${r.closed ? 'is-closed' : r.inRange ? 'is-in' : 'is-out'}${i === null ? '' : ' enter'}`,
    style: { '--i': i ?? 0 },
    onclick: (e) => {
      if (!e.target.closest('a, button, select, input')) openDetail(store, r.ref);
    },
  },
    h('header', { class: 'pool-head' },
      h('div', { class: 'pair' },
        logo(tokenLogoOf(r, r.addr0), r.sym0, 'token'),
        logo(tokenLogoOf(r, r.addr1), r.sym1, 'token second')),
      h('div', { class: 'pool-title' },
        h('button', { type: 'button', class: 'link-btn pool-name', title: 'See this position', onclick: () => openDetail(store, r.ref) }, r.pair),
        h('div', { class: 'pool-meta' },
          h('span', { class: 'chain-chip' }, logo(chain?.logo, r.chain, 'xs'), r.chain),
          h('span', { class: 'version-pill', title: `Uniswap ${r.version}` }, r.version),
          h('span', { class: 'fee-pill' }, `${r.feePct}%`),
          statusPill(r),
          outdatedPill(r))),
      r.url ? h('a', { href: r.url, target: '_blank', rel: 'noopener', class: 'icon-btn pool-open', title: 'Open on Uniswap', 'aria-label': `Open position ${r.tokenId} on Uniswap` }, icon('link')) : null),
    rangeView(r, store),
    h('div', { class: r.closed ? 'pool-stats' : 'pool-stats four' },
      poolStat('Value', usdOrDash(r.value)),
      poolStat('Unclaimed fees', usdOrDash(r.fees)),
      r.closed
        ? poolStat('Fees collected', collected.has(r.ref) ? money(collected.get(r.ref), 'USD') : '—', 'The collections of this position in the fee log')
        : [poolStat(`Fee APR · ${WINDOWS[view.window][1]}`, aprText(r), aprTitle(r)),
            poolStat(`Movement · ${WINDOWS[view.window][1]}`, moveView(r), moveTitle(r))]),
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

// The list's price range cell: the range in the pair's chosen currency, with the switch to the other.
function rangeCell(r, store) {
  const flip = isFlipped(store, r);
  const p = sideOf(r, flip);
  return [
    h('div', { class: 'range-cell' },
      h('span', null, r.full ? 'Full range' : `${price(p.min)} → ${price(p.max)} ${p.unit}`),
      r.full ? null : flipButton(store, r, flip)),
    h('div', { class: 'row' },
      statusPill(r),
      r.full || r.closed ? null : h('span', { class: 'muted small' }, `now ${price(p.current)}`)),
  ];
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
        sortHead(store, 'move', 'Movement', { class: 'num', title: 'The change in fee APR from the window before, in percentage points' }),
        h('th', null, ''))),
      h('tbody', null, rows.map((r) =>
        h('tr', {
          class: 'clickable',
          onclick: (e) => {
            if (!e.target.closest('a, button, select, input')) openDetail(store, r.ref);
          },
        },
          h('td', null, h('div', { class: 'row' },
            h('div', { class: 'pair' }, logo(tokenLogoOf(r, r.addr0), r.sym0, 'token'), logo(tokenLogoOf(r, r.addr1), r.sym1, 'token second')),
            h('div', null, h('button', { type: 'button', class: 'link-btn', title: 'See this position', onclick: () => openDetail(store, r.ref) }, r.pair), ' ', h('span', { class: 'version-pill', title: `Uniswap ${r.version}` }, r.version), outdatedPill(r), h('div', { class: 'muted small' }, `${r.owner} · #${r.tokenId}`)))),
          h('td', null, h('span', { class: 'chain-chip' }, logo(chainOf(r.chainId)?.logo, r.chain, 'xs'), r.chain), h('div', { class: 'muted small' }, `${r.feePct}% fee`)),
          h('td', null, rangeCell(r, store)),
          h('td', null, distribution(r)),
          h('td', { class: 'num' }, usdOrDash(r.value)),
          h('td', { class: 'num' }, usdOrDash(r.fees)),
          h('td', { class: 'num', title: aprTitle(r) }, aprText(r)),
          h('td', { class: 'num' }, moveView(r)),
          h('td', null, r.url
            ? h('a', { href: r.url, target: '_blank', rel: 'noopener', class: 'icon-btn', title: 'Open on Uniswap', 'aria-label': `Open position ${r.tokenId} on Uniswap` }, icon('link'))
            : null))))));
}

// The add form is built once and kept while it is open. A load re-renders the section each time a chain lands, and
// a new form each time would drop what was typed, the focus and the last message.
let addEl = null;

function openAdd(store) {
  view.adding = true;
  store.refresh();
  // Ready to paste: focused, and any text left in it selected so a paste replaces it. The page draws on the next
  // frame, so this waits for it.
  requestAnimationFrame(() => {
    addEl?.elements.position.focus();
    addEl?.elements.position.select();
  });
}

function closeAdd(store) {
  view.adding = false;
  addEl = null;
  store.refresh();
}

// Adds positions the board did not find: a link copied from the Uniswap app, or a number with its chain and
// version. Each is saved in Settings, where it can be removed, and read straight away. The form stays open and
// empty after each one, so several can be pasted in a row.
function addForm(store) {
  if (addEl) return addEl;
  const message = h('div', { 'aria-live': 'polite' });
  const say = (tone, text) => message.replaceChildren(notice({ tone, text }));
  const f = positionFields({ placeholder: 'https://app.uniswap.org/positions/v3/base/556505 or 556505' });
  const submit = (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    const text = form.elements.position.value;
    const entry = parsePosition(text, Number(form.elements.chain.value), String(form.elements.version.value));
    const error = entry ? addPosition(store, entry) : positionError(text);
    if (error) {
      say('error', error);
      return form.elements.position.focus();
    }
    const chain = chainOf(entry.chainId)?.name ?? `Chain ${entry.chainId}`;
    say('ok', `Added ${chain} ${entry.version} #${entry.tokenId}. It shows here once it is read.`);
    form.elements.position.value = '';
    form.elements.position.dispatchEvent(new Event('input'));
    form.elements.position.focus();
    load(store, { again: true });
  };
  addEl = h('form', { class: 'card panel stack lp-add', onsubmit: submit },
    h('h3', null, 'Add a position'),
    h('p', { class: 'muted small' }, 'For a position the board does not find: a v3 position held by an address not in your wallets, or a v4 position older than the node keeps. Paste its link from app.uniswap.org and the chain and version are read from it. A plain number needs both picked.'),
    f.input,
    f.hint,
    h('div', { class: 'row' },
      f.pickers,
      h('button', { type: 'submit', class: 'btn-small' }, 'Add'),
      h('button', { type: 'button', class: 'btn-small', onclick: () => closeAdd(store) }, 'Done')),
    message);
  return addEl;
}

// A re-render moves the kept add form into the new page, which takes the focus away from it. This puts the focus
// and the caret back once the new page is on screen.
function keepAddFocus() {
  const el = document.activeElement;
  if (!addEl || !el || !addEl.contains(el)) return;
  const caret = el.tagName === 'INPUT' ? [el.selectionStart, el.selectionEnd] : null;
  queueMicrotask(() => {
    // Something else may have taken the focus in between, such as the form after an add.
    if (!el.isConnected || (document.activeElement && document.activeElement !== document.body)) return;
    el.focus({ preventScroll: true });
    if (caret) el.setSelectionRange(...caret);
  });
}

// ---- Fees collected: the log of collections, its averages and a chart over time ----

const DAY_MS = 86400000;
const FEE_RANGES = { today: [0, 'Today'], yesterday: [0, 'Yesterday'], all: [0, 'All time'], 7: [7, '7 days'], 30: [30, '30 days'], 90: [90, '90 days'], 365: [365, '1 year'], month: [0, 'This month'], lastmonth: [0, 'Last month'] };
const FEE_RANGE_ORDER = ['today', 'yesterday', '7', '30', '90', '365', 'month', 'lastmonth', 'all'];
// A range's start and its end (excluded) in ms; null for no bound. Months are calendar months in local time.
function feeRangeBounds(key, nowMs) {
  const now = new Date(nowMs);
  const monthStart = (back) => new Date(now.getFullYear(), now.getMonth() - back, 1).getTime();
  const dayStart = (back) => new Date(now.getFullYear(), now.getMonth(), now.getDate() - back).getTime();
  if (key === 'today') return [dayStart(0), null];
  if (key === 'yesterday') return [dayStart(1), dayStart(0)];
  if (key === 'month') return [monthStart(0), null];
  if (key === 'lastmonth') return [monthStart(1), monthStart(0)];
  const days = FEE_RANGES[key][0];
  return [days ? nowMs - days * DAY_MS : null, null];
}
const FEE_GROUPS = [['day', 'Day'], ['week', 'Week'], ['month', 'Month']];
// Days by default; a year or more of days is too many bars, so 1 year and All time start on months.
const defaultFeeGroup = (range) => (range === '365' || range === 'all' ? 'month' : 'day');

// Local calendar keys, so a collect late in the evening counts on its own day.
const localDay = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
function bucketOf(date, group) {
  if (group === 'month') return localDay(date).slice(0, 7);
  if (group === 'week') return localDay(new Date(date.getFullYear(), date.getMonth(), date.getDate() - ((date.getDay() + 6) % 7))); // its Monday
  return localDay(date);
}
// Every bucket from the first to the last, so quiet days or months show as gaps rather than vanishing.
function bucketsBetween(from, to, group) {
  const keys = [];
  const d = new Date(from.getFullYear(), from.getMonth(), group === 'month' ? 1 : from.getDate());
  if (group === 'week') d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  while (d <= to && keys.length < 2000) {
    keys.push(bucketOf(d, group));
    if (group === 'month') d.setMonth(d.getMonth() + 1);
    else d.setDate(d.getDate() + (group === 'week' ? 7 : 1));
  }
  return keys;
}
const bucketLabel = (key, group) => (group === 'month'
  ? new Date(`${key}-01T00:00`).toLocaleDateString(undefined, { month: 'short', year: '2-digit' })
  : new Date(`${key}T00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }));

// The full name of a bucket, for the chart's tooltip.
function bucketName(key, group) {
  if (group === 'month') return new Date(`${key}-01T00:00`).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  const date = new Date(`${key}T00:00`).toLocaleDateString(undefined, { weekday: group === 'day' ? 'short' : undefined, month: 'short', day: 'numeric', year: 'numeric' });
  return group === 'week' ? `Week of ${date}` : date;
}

// One bar's tooltip: its total, how many collections, and the positions that gave the most.
function bucketTip(key, group, list) {
  const total = list.reduce((s, c) => s + (c.usd ?? 0), 0);
  const byPos = new Map();
  for (const c of list) {
    const name = c.pair ? `${c.pair}${c.tokenId ? ` #${c.tokenId}` : ''}` : 'No position';
    byPos.set(name, (byPos.get(name) ?? 0) + (c.usd ?? 0));
  }
  const top = [...byPos].sort((a, b) => b[1] - a[1]);
  return [
    h('span', { class: 'muted' }, bucketName(key, group)),
    h('strong', null, money(total, 'USD')),
    h('span', { class: 'muted' }, list.length ? plural(list.length, 'collection') : 'No collections'),
    top.slice(0, 3).map(([name, usd]) => h('span', { class: 'tip-row' }, h('span', null, name), h('span', null, money(usd, 'USD')))),
    top.length > 3 ? h('span', { class: 'muted' }, `and ${plural(top.length - 3, 'more position')}`) : null,
  ];
}

const collectedOf = (store) => store.get(COLLECTION)?.collected ?? [];

// What the log holds per position, in USD, for the closed cards.
function collectedByRef(store) {
  const out = new Map();
  for (const c of collectedOf(store)) if (c.ref) out.set(c.ref, (out.get(c.ref) ?? 0) + (c.usd ?? 0));
  return out;
}

// A collect read from the chain or Etherscan would be read again, so its key is kept in `hidden`.
function removeCollect(store, entry) {
  store.update(COLLECTION, (d) => {
    d.collected = (d.collected ?? []).filter((c) => c.id !== entry.id);
    if (entry.tx) d.hidden = [...(d.hidden ?? []), collectKey(entry)];
  });
  toast('Collection removed.', {
    undo: () => store.update(COLLECTION, (d) => {
      d.collected = [...(d.collected ?? []), entry];
      d.hidden = (d.hidden ?? []).filter((key) => key !== collectKey(entry));
    }),
  });
}

// Logs a collection by hand: one the board did not see, such as a collect with no read before it.
function logForm(store) {
  const rows = [...state.rows].sort((a, b) => a.pair.localeCompare(b.pair));
  const submit = (e) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const usd = Number(String(form.get('usd')).replace(/[$,\s]/g, ''));
    const date = String(form.get('date'));
    if (!(usd > 0) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      view.logMessage = 'Enter the date and the amount collected in USD.';
      return store.refresh();
    }
    const r = rows.find((x) => x.ref === form.get('ref'));
    const note = String(form.get('note') ?? '').trim();
    // Noon local time, so the entry stays on its day in any time zone.
    const at = new Date(`${date}T12:00`).toISOString();
    view.logging = false;
    view.logMessage = '';
    store.update(COLLECTION, (d) => {
      d.collected = [...(d.collected ?? []), {
        id: uid(), at, source: 'manual', usd, note,
        ...(r ? { ref: r.ref, pair: r.pair, chain: r.chain, tokenId: r.tokenId } : {}),
      }];
    });
  };
  return h('form', { class: 'card panel stack lp-add', onsubmit: submit },
    h('h3', null, 'Log a collection'),
    h('p', { class: 'muted small' }, 'For a collection the board did not see. A collect between two reads is logged by itself.'),
    h('div', { class: 'row' },
      h('input', { type: 'date', name: 'date', value: todayISO(), max: todayISO(), 'aria-label': 'Date collected' }),
      h('input', { name: 'usd', inputmode: 'decimal', placeholder: 'Amount in USD', autofocus: true, 'aria-label': 'Amount collected in USD' })),
    h('select', { name: 'ref', 'aria-label': 'Position' },
      h('option', { value: '' }, 'No position'),
      rows.map((r) => h('option', { value: r.ref }, `${r.pair} · ${r.chain} · #${r.tokenId}${r.closed ? ' (closed)' : ''}`))),
    h('input', { name: 'note', placeholder: 'Note (optional)', 'aria-label': 'Note' }),
    h('div', { class: 'row' },
      h('button', { type: 'submit', class: 'btn-small' }, 'Log'),
      h('button', { type: 'button', class: 'btn-small', onclick: () => { view.logging = false; store.refresh(); } }, 'Cancel')),
    view.logMessage ? notice({ text: view.logMessage }) : null);
}

// A token's logo for a collection: from its position, or the addresses it saved, or any position with the symbol.
function collectLogo(c, sym) {
  const row = state.rows.find((r) => r.ref === c.ref);
  const i = c.sym0 === sym ? 0 : c.sym1 === sym ? 1 : -1;
  if (row && i >= 0) return tokenLogoOf(row, i ? row.addr1 : row.addr0);
  const addr = i === 0 ? c.addr0 : i === 1 ? c.addr1 : null;
  if (addr && c.chainId) return logoMap.get(`${c.chainId}:${addr.toLowerCase()}`) ?? null;
  return symbolLogo(sym);
}
function symbolLogo(sym) {
  for (const r of state.rows) {
    if (r.sym0 === sym && tokenLogoOf(r, r.addr0)) return tokenLogoOf(r, r.addr0);
    if (r.sym1 === sym && tokenLogoOf(r, r.addr1)) return tokenLogoOf(r, r.addr1);
  }
  return null;
}

// The tokens of a collection, one per line with its logo.
function tokenCell(c) {
  if (c.a0 == null) {
    const syms = tokensOf(c);
    return syms.length ? h('div', { class: 'lp-tokens muted' }, syms.map((t) => h('span', { class: 'lp-token' }, logo(symbolLogo(t), t, 'xs'), t))) : '';
  }
  return h('div', { class: 'lp-tokens' },
    [[c.a0, c.sym0], [c.a1, c.sym1]].map(([n, sym]) => h('span', { class: n ? 'lp-token' : 'lp-token muted' }, logo(collectLogo(c, sym), sym, 'xs'), `${amount(n)} ${sym}`)));
}

// Whether a collection's position is still open: a dot on the log, so closed positions stand out.
function positionDot(c) {
  if (!c.ref) return null;
  const row = state.rows.find((r) => r.ref === c.ref);
  const kind = !row ? 'gone' : row.closed ? 'closed' : row.inRange ? 'in' : 'out';
  const title = {
    in: 'Open position, in range',
    out: 'Open position, out of range',
    closed: 'Closed position: no liquidity left',
    gone: 'Not among the positions read: burned, moved, or not read yet',
  }[kind];
  return h('span', { class: `pos-dot ${kind}`, title, role: 'img', 'aria-label': title });
}

// The searchable token filter: logo, symbol and count per token. Typing filters the list in place, without a
// re-render, so the field keeps its focus.
const picker = { open: false, query: '' };
let pickerOutside = null;
function closePicker(store) {
  picker.open = false;
  picker.query = '';
  if (pickerOutside) document.removeEventListener('pointerdown', pickerOutside, true);
  pickerOutside = null;
  store.refresh();
}
function tokenPicker(store, options) {
  const current = options.find((o) => o.value === view.feeToken) ?? options[0];
  const choose = (value) => {
    view.feeToken = value;
    closePicker(store);
  };
  const item = (o) => h('li', { role: 'option', 'aria-selected': String(o.value === view.feeToken) },
    h('button', { type: 'button', class: o.value === view.feeToken ? 'lp-picker-item active' : 'lp-picker-item', 'data-value': o.value, onclick: () => choose(o.value) },
      o.value === 'all' ? h('span', { class: 'logo xs lp-picker-all' }, icon('coins')) : logo(o.logo, o.label, 'xs'),
      h('span', { class: 'lp-picker-name' }, o.label),
      h('span', { class: 'chip-count' }, o.count)));
  const list = h('ul', { class: 'lp-picker-list', role: 'listbox', 'aria-label': 'Tokens' });
  const fill = () => {
    const q = picker.query.trim().toLowerCase();
    const shown = options.filter((o) => !q || o.value === 'all' || o.label.toLowerCase().includes(q));
    list.replaceChildren(...shown.map(item), ...(shown.length <= 1 && q ? [h('li', { class: 'muted small lp-picker-none' }, 'No token matches.')] : []));
  };
  const move = (step) => {
    const items = [...list.querySelectorAll('.lp-picker-item')];
    const at = items.indexOf(document.activeElement);
    items[Math.max(0, Math.min(items.length - 1, at + step))]?.focus();
  };
  const search = h('input', {
    type: 'search',
    class: 'lp-picker-search',
    placeholder: 'Search tokens',
    'aria-label': 'Search tokens',
    value: picker.query,
    autocomplete: 'off',
    oninput: (e) => {
      picker.query = e.currentTarget.value;
      fill();
    },
    onkeydown: (e) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        list.querySelector('.lp-picker-item')?.focus();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const first = [...list.querySelectorAll('.lp-picker-item')].find((b) => b.dataset.value !== 'all' || !picker.query.trim());
        if (first) choose(first.dataset.value);
      }
    },
  });
  fill();
  const wrap = h('div', {
    class: picker.open ? 'lp-picker open' : 'lp-picker',
    onkeydown: (e) => {
      if (e.key === 'Escape' && picker.open) {
        e.stopPropagation();
        closePicker(store);
      } else if (picker.open && e.target !== search && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
        e.preventDefault();
        move(e.key === 'ArrowDown' ? 1 : -1);
      }
    },
  },
    h('button', {
      type: 'button',
      class: 'lp-picker-btn',
      'aria-haspopup': 'listbox',
      'aria-expanded': String(picker.open),
      onclick: () => {
        if (picker.open) return closePicker(store);
        picker.open = true;
        pickerOutside = (e) => {
          if (!e.target.closest?.('.lp-picker')) closePicker(store);
        };
        document.addEventListener('pointerdown', pickerOutside, true);
        store.refresh();
      },
    },
      current.value === 'all' ? icon('coins') : logo(current.logo, current.label, 'xs'),
      current.value === 'all' ? 'All tokens' : current.label,
      h('span', { class: 'sort-mark' }, icon(picker.open ? 'chevron-up' : 'chevron-down'))),
    picker.open ? h('div', { class: 'lp-picker-pop' }, search, list) : null);
  return wrap;
}

// A re-render while the picker is open builds a new search field; this gives it the focus once the page is on
// screen, unless the focus was elsewhere on the page.
function keepPickerFocus(root) {
  if (!picker.open) return;
  const input = root.querySelector('.lp-picker-search');
  const active = document.activeElement;
  if (!input || (active && active !== document.body && !active.closest?.('.lp-picker'))) return;
  queueMicrotask(() => {
    if (!input.isConnected) return;
    input.focus({ preventScroll: true });
    const end = input.value.length;
    input.setSelectionRange(end, end);
  });
}

const COLLECT_TITLE = 'The fees in this collect, without the liquidity it paid out, at the token prices of that day.';
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

const SOURCE_NAMES = { chain: 'From the chain', etherscan: 'From Etherscan', auto: 'Seen by the board', manual: 'Logged by hand' };
const sourceOf = (c) => (Object.hasOwn(SOURCE_NAMES, c.source) ? c.source : 'auto');
// The tokens of a collection: its symbols, or the pair's for one logged by hand.
const tokensOf = (c) => [...new Set(c.sym0 ? [c.sym0, c.sym1] : String(c.pair ?? '').split('/').map((t) => t.trim()).filter(Boolean))];

// What each column of the log sorts by, and the direction it starts in.
const FEE_SORTS = {
  date: { value: (c) => c.at, dir: -1 },
  chain: { value: (c) => c.chain || null, dir: 1 },
  position: { value: (c) => c.pair || null, dir: 1 },
  tokens: { value: (c) => (c.a0 != null ? tokensOf(c).join(' / ') : null), dir: 1 },
  source: { value: (c) => SOURCE_NAMES[sourceOf(c)], dir: 1 },
  value: { value: (c) => c.usd ?? null, dir: -1 },
};

// Rows without the value sorted on go last; ties fall back to the newest first.
function sortCollects(list, key, dir) {
  const read = FEE_SORTS[key].value;
  const cmp = (a, b) => (typeof a === 'string' ? a.localeCompare(b) : a < b ? -1 : a > b ? 1 : 0);
  return list.sort((x, y) => {
    const a = read(x);
    const b = read(y);
    const missing = (a == null ? 1 : 0) - (b == null ? 1 : 0);
    if (missing) return missing;
    return (a == null ? 0 : dir * cmp(a, b)) || y.at.localeCompare(x.at);
  });
}

function feeSortHead(store, key, label, attrs = {}) {
  const on = view.feeSort === key;
  return h('th', { ...attrs, 'aria-sort': on ? (view.feeDir > 0 ? 'ascending' : 'descending') : null },
    h('button', {
      type: 'button',
      class: 'mon-sort',
      onclick: () => {
        view.feeDir = on ? -view.feeDir : FEE_SORTS[key].dir;
        view.feeSort = key;
        store.refresh();
      },
    }, label, h('span', { class: 'sort-mark' }, icon(on && view.feeDir > 0 ? 'chevron-up' : 'chevron-down'))));
}

// A token's logo from the collections that hold it, for the token picker.
function tokenLogoIn(list, sym) {
  for (const c of list) {
    if (c.sym0 === sym || c.sym1 === sym) {
      const src = collectLogo(c, sym);
      if (src) return src;
    }
  }
  return symbolLogo(sym);
}

// The chain, token and source filters, each read from the log so only choices with collections show.
function feeFilters(store, inRange) {
  const count = (pred) => inRange.filter(pred).length;
  const chip = (active, label, n, onclick, logoSrc = null) => h('button', {
    type: 'button',
    class: active ? 'lp-chip chain active' : 'lp-chip chain',
    'aria-pressed': String(active),
    onclick,
  }, logoSrc ? logo(logoSrc, label, 'xs') : null, label, h('span', { class: 'chip-count' }, n));
  const set = (key, value) => () => {
    view[key] = value;
    store.refresh();
  };
  const chains = [...new Set(inRange.map((c) => c.chain).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const tokens = [...new Set(inRange.flatMap(tokensOf))].sort((a, b) => a.localeCompare(b));
  const sources = Object.keys(SOURCE_NAMES).filter((k) => inRange.some((c) => sourceOf(c) === k));
  const select = (key, label, options) => h('select', {
    'aria-label': label,
    onchange: (e) => set(key, e.currentTarget.value)(),
  }, options.map(([value, text]) => h('option', { value, selected: view[key] === value }, text)));
  return h('div', { class: 'row lp-filters' },
    chains.length > 1 ? [
      chip(view.feeChain === 'all', 'All chains', inRange.length, set('feeChain', 'all')),
      chains.map((name) => chip(view.feeChain === name, name, count((c) => c.chain === name), set('feeChain', name), CHAINS.find((x) => x.name === name)?.logo)),
    ] : null,
    tokens.length > 1 ? tokenPicker(store, [
      { value: 'all', label: 'All tokens', count: inRange.length, logo: null },
      ...tokens.map((t) => ({ value: t, label: t, count: count((c) => tokensOf(c).includes(t)), logo: tokenLogoIn(inRange, t) })),
    ]) : null,
    sources.length > 1 ? select('feeSource', 'Source', [['all', 'All sources'], ...sources.map((k) => [k, `${SOURCE_NAMES[k]} (${count((c) => sourceOf(c) === k)})`])]) : null);
}

// A share as a percent that only reads 100% when the search is complete.
const coveragePct = (x) => (x >= 1 ? '100%' : `${Math.min(99.9, Math.floor(x * 1000) / 10)}%`);
const COVERAGE_TITLE = 'How far the search for collect events has got, over every position shown, open and closed. A position counts in full once its search reached the transaction that opened it, or once Etherscan read every transaction of its wallet. Until then, the share of blocks searched back. Each load searches further.';

// How sure the log is to hold every collect: the search coverage, for all chains and per chain.
function coverageCard(store) {
  const cov = collectCoverage(store);
  if (!cov.total) return null;
  const busy = searching.size > 0 || loading;
  const meter = (x) => h('div', { class: 'meter', role: 'presentation' }, h('span', { style: { width: `${x * 100}%` } }));
  const status = busy ? 'Searching…' : cov.pct >= 1 ? 'Every collect found' : 'Searches further on each load';
  // Collapsed by default to a one-line recap; the per-chain detail opens on demand.
  const toggle = h('button', {
    type: 'button',
    class: 'lp-coverage-toggle',
    'aria-expanded': String(Boolean(view.coverageOpen)),
    onclick: () => {
      view.coverageOpen = !view.coverageOpen;
      store.refresh();
    },
  },
    h('h3', null, 'Search coverage'),
    view.coverageOpen ? null : [h('strong', { class: 'lp-coverage-pct' }, coveragePct(cov.pct)), meter(cov.pct)],
    h('span', { class: 'muted small lp-coverage-recap' }, view.coverageOpen ? status : `${cov.done}/${cov.total} positions · ${status}`),
    h('span', { class: 'sort-mark' }, icon(view.coverageOpen ? 'chevron-up' : 'chevron-down')));
  // What each chain is searching now, one line per chain.
  const now = (chainId) => (activity.has(chainId) ? h('p', { class: 'muted small lp-coverage-now' }, activity.get(chainId)) : null);
  if (!view.coverageOpen) {
    return h('section', { class: 'card lp-coverage collapsed', title: COVERAGE_TITLE },
      toggle,
      [...activity.keys()].map((id) => h('p', { class: 'muted small lp-coverage-now' }, h('strong', null, `${chainOf(id)?.name ?? id}: `), activity.get(id))));
  }
  return h('section', { class: 'card stack lp-coverage', title: COVERAGE_TITLE },
    toggle,
    h('div', { class: 'lp-coverage-all' },
      h('strong', null, coveragePct(cov.pct)),
      meter(cov.pct),
      h('span', { class: 'muted small' }, `${cov.done} of ${plural(cov.total, 'position')} searched back to their opening`)),
    cov.chains.length
      ? h('ul', { class: 'lp-coverage-chains' }, cov.chains.map((c) => h('li', null,
          h('span', { class: 'chain-chip' }, logo(chainOf(c.chainId)?.logo, c.name, 'xs'), c.name),
          meter(c.pct),
          h('strong', null, coveragePct(c.pct)),
          h('span', { class: 'muted small' }, `${c.done}/${c.total}`),
          h('button', {
            type: 'button',
            class: 'btn-small lp-search-more',
            disabled: searching.has(c.chainId) || loading,
            'aria-busy': searching.has(c.chainId) ? 'true' : null,
            title: searching.has(c.chainId) ? `Searching ${c.name}…` : `Search ${c.name} further back for collects now, without waiting for the next load`,
            'aria-label': `Search ${c.name} further`,
            onclick: () => loadHistory(store, c.chainId),
          }, refreshIcon(searching.has(c.chainId))),
          now(c.chainId))))
      : null);
}

// ---- Fees collected insights: outlook, running total, pace, breakdown and calendar ----

// When a bucket ends, in ms, so an estimate can be read at the end of each future bucket.
function bucketEnd(key, group) {
  if (group === 'month') {
    const d = new Date(`${key}-01T00:00`);
    return new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime();
  }
  const d = new Date(`${key}T00:00`);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + (group === 'week' ? 7 : 1)).getTime();
}
const sumUsd = (list) => list.reduce((s, c) => s + (c.usd ?? 0), 0);
const sumBetween = (list, from, to) => sumUsd(list.filter((c) => {
  const t = Date.parse(c.at);
  return t >= from && t < to;
}));
const signedChange = (now, before) => (before > 0 ? signedPct((now / before - 1) * 100) : now > 0 ? 'New' : '—');
// The round totals worth a note, from $100 up.
function nextMilestone(total) {
  for (let base = 100; base < 1e12; base *= 10) {
    for (const m of [1, 2.5, 5]) if (base * m > total) return base * m;
  }
  return null;
}
const shortDate = (ms) => new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: new Date(ms).getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });

// The outlook tiles: how this range compares with the one before, what the month and year should end on, the
// next round total, and how often fees get collected.
function feeOutlook(ctx) {
  const { list, pool, start, end, from, nowMs, stat } = ctx;
  const tiles = [];
  if (from !== null) {
    const len = end - start;
    const before = sumBetween(pool, start - len, start);
    tiles.push(stat('vs the period before', signedChange(sumUsd(list), before), `${money(before, 'USD')} in the ${plural(Math.max(1, Math.round(len / DAY_MS)), 'day')} before`));
  }
  // Estimates run at the last 30 days' pace: long enough to smooth a big collect, short enough to follow changes.
  const rate30 = sumBetween(pool, nowMs - 30 * DAY_MS, nowMs + 1) / 30;
  const today = new Date(nowMs);
  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1).getTime();
  const monthEnd = new Date(today.getFullYear(), today.getMonth() + 1, 1).getTime();
  const yearStart = new Date(today.getFullYear(), 0, 1).getTime();
  const yearEnd = new Date(today.getFullYear() + 1, 0, 1).getTime();
  const mtd = sumBetween(pool, monthStart, nowMs + 1);
  const ytd = sumBetween(pool, yearStart, nowMs + 1);
  tiles.push(stat('Month-end estimate', money(mtd + rate30 * ((monthEnd - nowMs) / DAY_MS), 'USD'), `${money(mtd, 'USD')} so far, at the 30-day pace`));
  tiles.push(stat('Year-end estimate', money(ytd + rate30 * ((yearEnd - nowMs) / DAY_MS), 'USD'), `${money(ytd, 'USD')} so far in ${today.getFullYear()}`));
  const lifetime = sumUsd(pool);
  const goal = nextMilestone(lifetime);
  if (goal) {
    const days = rate30 > 0 ? (goal - lifetime) / rate30 : null;
    tiles.push(stat(`Next ${money(goal, 'USD')}`, days === null ? '—' : days < 1 ? 'Today' : `~${plural(Math.ceil(days), 'day')}`,
      days === null ? `${money(lifetime, 'USD')} in all; nothing in the last 30 days` : `${money(goal - lifetime, 'USD')} to go, around ${shortDate(nowMs + days * DAY_MS)}`));
  }
  // The usual time between collects, from the days that had one.
  const collectDays = [...new Set(pool.map((c) => localDay(new Date(c.at))))].sort();
  if (collectDays.length) {
    const last = Date.parse(pool.reduce((a, c) => (c.at > a ? c.at : a), pool[0].at));
    const gaps = collectDays.slice(1).map((d, i) => (Date.parse(`${d}T00:00`) - Date.parse(`${collectDays[i]}T00:00`)) / DAY_MS).sort((a, b) => a - b);
    const median = gaps.length ? gaps[Math.floor(gaps.length / 2)] : null;
    const since = Math.floor((nowMs - last) / DAY_MS);
    tiles.push(stat('Last collect', since < 1 ? 'Today' : `${plural(since, 'day')} ago`, median ? `Usually every ${plural(Math.round(median), 'day')}` : shortDate(last)));
  }
  const priced = list.filter((c) => c.usd != null);
  if (priced.length) {
    const largest = priced.reduce((a, c) => (a.usd >= c.usd ? a : c));
    tiles.push(stat('Average collect', money(sumUsd(priced) / priced.length, 'USD'), `Largest ${money(largest.usd, 'USD')} on ${shortDate(Date.parse(largest.at))}`));
  }
  return h('div', { class: 'lp-stats' }, tiles);
}

// The running total over the range, with a dashed estimate past today at the range's own pace.
function cumulativeChart(ctx) {
  const { list, start, end, to, perDay, nowMs, group } = ctx;
  const keys = bucketsBetween(new Date(start), new Date(end - 1), group);
  const sums = new Map();
  for (const c of list) {
    const k = bucketOf(new Date(c.at), group);
    sums.set(k, (sums.get(k) ?? 0) + (c.usd ?? 0));
  }
  let run = 0;
  const actual = keys.map((k) => (run += sums.get(k) ?? 0));
  const total = run;
  // Only a range that runs to now looks ahead: about a third of its length, at least a few buckets.
  const ahead = to === null && perDay > 0 && keys.length ? Math.max(3, Math.ceil(keys.length / 3)) : 0;
  const future = [];
  if (ahead) {
    const last = keys[keys.length - 1];
    const d = new Date(`${group === 'month' ? `${last}-01` : last}T00:00`);
    for (let i = 0; i < ahead; i++) {
      if (group === 'month') d.setMonth(d.getMonth() + 1);
      else d.setDate(d.getDate() + (group === 'week' ? 7 : 1));
      future.push(bucketOf(d, group));
    }
  }
  const all = [...keys, ...future];
  // The estimate starts on the last real point, so the two lines join.
  const estimate = all.map((k, i) => (i < keys.length - 1 ? null : i === keys.length - 1 ? total : total + perDay * ((bucketEnd(k, group) - nowMs) / DAY_MS)));
  const series = [{ name: 'Collected', color: 'var(--accent)', values: [...actual, ...future.map(() => null)], area: true }];
  if (ahead) series.push({ name: 'Estimate', color: 'var(--income)', values: estimate, dashed: true });
  const chart = lineChart(all.map((k) => bucketLabel(k, group)), series, {
    format: (v) => money(v, 'USD'),
    tip: (i) => [
      h('span', { class: 'muted' }, bucketName(all[i], group)),
      i < keys.length
        ? [h('strong', null, money(actual[i], 'USD')), h('span', { class: 'muted' }, `+${money(sums.get(all[i]) ?? 0, 'USD')} this ${group}`)]
        : [h('strong', null, money(estimate[i], 'USD')), h('span', { class: 'muted' }, 'Estimate at this range\'s pace')],
    ],
  });
  const note = ahead ? `About ${money(estimate[estimate.length - 1], 'USD')} by the end of ${bucketName(future[future.length - 1], group)}` : money(total, 'USD');
  return panel('Running total', note, chart, legend(series));
}

// The pace of fees per day: a short and a long rolling average, so a speed-up or slow-down shows early.
function paceChart(ctx) {
  const { pool, end, spanDays } = ctx;
  const shown = Math.min(365, Math.max(30, Math.round(spanDays)));
  const daily = new Map();
  for (const c of pool) {
    const k = localDay(new Date(c.at));
    daily.set(k, (daily.get(k) ?? 0) + (c.usd ?? 0));
  }
  // 29 days before the first shown day, so the 30-day average is whole from the start.
  const keys = bucketsBetween(new Date(end - (shown + 29) * DAY_MS), new Date(end - 1), 'day');
  const vals = keys.map((k) => daily.get(k) ?? 0);
  const rolling = (n) => vals.map((_, i) => (i < n - 1 ? null : vals.slice(i - n + 1, i + 1).reduce((s, v) => s + v, 0) / n));
  const r7 = rolling(7).slice(29);
  const r30 = rolling(30).slice(29);
  const days = keys.slice(29);
  if (!days.length) return null;
  const last7 = r7[r7.length - 1] ?? 0;
  const last30 = r30[r30.length - 1] ?? 0;
  const change = last30 > 0 ? (last7 / last30 - 1) * 100 : null;
  const note = change === null ? 'No collects in the last 30 days'
    : Math.abs(change) < 10 ? 'Steady: the week matches the month'
    : `${change > 0 ? 'Speeding up' : 'Slowing down'}: the week is ${signedPct(change)} on the month`;
  const series = [
    { name: '7-day average', color: 'var(--accent)', values: r7 },
    { name: '30-day average', color: 'var(--warn)', values: r30 },
  ];
  return panel('Pace per day', note,
    lineChart(days.map((k) => bucketLabel(k, 'day')), series, {
      format: (v) => money(v, 'USD'),
      tip: (i) => [
        h('span', { class: 'muted' }, bucketName(days[i], 'day')),
        series.map((sr) => h('span', { class: 'tip-row' },
          h('span', null, h('span', { class: 'legend-swatch', style: { background: sr.color } }), ` ${sr.name}`),
          h('strong', null, money(sr.values[i] ?? 0, 'USD')))),
        h('span', { class: 'tip-row' }, h('span', null, 'Collected that day'), h('span', null, money(daily.get(days[i]) ?? 0, 'USD'))),
      ],
    }),
    legend(series),
    h('p', { class: 'muted small' }, 'When the 7-day line runs above the 30-day line, fees are coming in faster than usual.'));
}

const FEE_SPLITS = [['position', 'Position'], ['chain', 'Chain'], ['source', 'Source']];
// Where the range's fees came from: each position, chain or source with its share, the largest first.
function breakdown(store, ctx) {
  const { list } = ctx;
  const split = view.feeSplit ?? 'position';
  const groups = new Map();
  for (const c of list) {
    const [key, label] = split === 'chain' ? [c.chain || '', c.chain || 'No chain']
      : split === 'source' ? [sourceOf(c), SOURCE_NAMES[sourceOf(c)]]
      : [c.ref || c.pair || '', c.pair ? `${c.pair}${c.tokenId ? ` #${c.tokenId}` : ''}` : 'No position'];
    const g = groups.get(key) ?? { key, label, usd: 0, n: 0, sample: c };
    g.usd += c.usd ?? 0;
    g.n++;
    groups.set(key, g);
  }
  const rows = [...groups.values()].sort((a, b) => b.usd - a.usd);
  const total = sumUsd(list);
  // Eight rows at most; the rest share one line.
  const top = rows.slice(0, 8);
  if (rows.length > 8) {
    const rest = rows.slice(8);
    top.push({ key: null, label: plural(rest.length, 'other'), usd: rest.reduce((s, g) => s + g.usd, 0), n: rest.reduce((s, g) => s + g.n, 0) });
  }
  const max = Math.max(...top.map((g) => g.usd)) || 1;
  const pills = h('div', { class: 'row' }, FEE_SPLITS.map(([key, label]) => h('button', {
    type: 'button',
    class: split === key ? 'period-btn active' : 'period-btn',
    'aria-pressed': String(split === key),
    onclick: () => {
      view.feeSplit = key;
      store.refresh();
    },
  }, label)));
  const name = (g) => {
    if (split === 'chain' && g.key) return h('span', { class: 'chain-chip' }, logo(CHAINS.find((x) => x.name === g.key)?.logo, g.label, 'xs'), g.label);
    if (split === 'position' && g.sample?.ref) {
      return h('span', { class: 'lp-pos' }, positionDot(g.sample),
        h('button', { type: 'button', class: 'link-btn', title: 'See this position', onclick: () => openDetail(store, g.sample.ref) }, g.label));
    }
    return h('span', null, g.label);
  };
  const share = (usd) => (total > 0 ? pct(usd / total) : '—');
  const lead = rows[0];
  return h('section', { class: 'card stack lp-panel' },
    h('div', { class: 'lp-panel-head' }, h('h3', null, 'Where fees came from'), pills),
    h('ul', { class: 'fee-split' }, top.map((g) => h('li', null,
      h('div', { class: 'fee-split-name' }, name(g), h('span', { class: 'muted small' }, plural(g.n, 'collection'))),
      h('div', { class: 'meter', role: 'presentation' }, h('span', { style: { width: `${(g.usd / max) * 100}%` } })),
      h('strong', { class: 'num' }, money(g.usd, 'USD')),
      h('span', { class: 'muted small num' }, share(g.usd))))),
    lead && rows.length > 1 && total > 0 ? h('p', { class: 'muted small' }, `${lead.label} gave ${share(lead.usd)} of the range.`) : null);
}

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
// Each day of the last 26 weeks as a square, darker for more fees: streaks and quiet spells at a glance.
function feeCalendar(ctx) {
  const { pool, nowMs } = ctx;
  const daily = new Map();
  for (const c of pool) {
    const k = localDay(new Date(c.at));
    const d = daily.get(k) ?? { usd: 0, n: 0 };
    daily.set(k, { usd: d.usd + (c.usd ?? 0), n: d.n + 1 });
  }
  const today = new Date(nowMs);
  const first = new Date(today.getFullYear(), today.getMonth(), today.getDate() - ((today.getDay() + 6) % 7) - 25 * 7);
  const keys = bucketsBetween(first, today, 'day');
  const shown = keys.map((k) => daily.get(k)?.usd ?? 0);
  // Four shades by quartile of the days with fees, so one big day does not wash out the rest.
  const sorted = shown.filter((v) => v > 0).sort((a, b) => a - b);
  if (!sorted.length) return panel('Last 26 weeks', null, h('p', { class: 'muted small' }, 'No collects in the last 26 weeks.'));
  const q = [0.25, 0.5, 0.75].map((p) => sorted[Math.floor(p * (sorted.length - 1))]);
  const level = (v) => (v <= 0 ? 0 : v <= q[0] ? 1 : v <= q[1] ? 2 : v <= q[2] ? 3 : 4);
  const byWeekday = WEEKDAYS.map(() => 0);
  keys.forEach((k, i) => { byWeekday[(new Date(`${k}T00:00`).getDay() + 6) % 7] += shown[i]; });
  const sum = byWeekday.reduce((s, v) => s + v, 0);
  const best = byWeekday.indexOf(Math.max(...byWeekday));
  const grid = h('div', { class: 'fee-cal', role: 'img', 'aria-label': `Fees per day over the last 26 weeks: ${plural(sorted.length, 'day')} with collects` },
    keys.map((k, i) => {
      const d = daily.get(k);
      return h('span', {
        class: `fee-cal-day l${level(shown[i])}`,
        title: `${bucketName(k, 'day')}: ${d ? `${money(d.usd, 'USD')} · ${plural(d.n, 'collection')}` : 'no collects'}`,
      });
    }));
  return panel('Last 26 weeks', `${plural(sorted.length, 'day')} with collects`,
    h('div', { class: 'fee-cal-wrap' },
      h('div', { class: 'fee-cal-days muted', 'aria-hidden': 'true' }, WEEKDAYS.map((d, i) => h('span', null, i % 2 ? '' : d.slice(0, 3)))),
      grid),
    h('div', { class: 'row between muted small' },
      h('span', null, sum > 0 ? `Most fees on ${WEEKDAYS[best]}s: ${pct(byWeekday[best] / sum)}` : ''),
      h('span', { class: 'fee-cal-key', 'aria-hidden': 'true' }, 'Less', [0, 1, 2, 3, 4].map((l) => h('span', { class: `fee-cal-day l${l}` })), 'More')));
}

function feeInsights(store, ctx) {
  return [
    h('section', { class: 'stack' }, h('h3', null, 'Outlook'), feeOutlook(ctx)),
    ctx.list.length ? h('div', { class: 'lp-insight-grid' }, cumulativeChart(ctx), paceChart(ctx)) : null,
    ctx.list.length ? h('div', { class: 'lp-insight-grid' }, breakdown(store, ctx), feeCalendar(ctx)) : null,
  ];
}

function feesView(store) {
  const all = [...collectedOf(store)].sort((a, b) => b.at.localeCompare(a.at));
  const nowMs = Date.now();
  const [todayStart] = feeRangeBounds('today', nowMs);
  const anyToday = all.some((c) => Date.parse(c.at) >= todayStart);
  const [yesterdayStart] = feeRangeBounds('yesterday', nowMs);
  const anyYesterday = all.some((c) => Date.parse(c.at) >= yesterdayStart && Date.parse(c.at) < todayStart);
  // Today and Yesterday only show when they have collects, or when picked.
  const shown = { today: anyToday, yesterday: anyYesterday };
  // With no range picked, open on Today when something was collected today, else on 7 days.
  if (view.feeAuto) view.feeRange = anyToday ? 'today' : '7';
  const [from, to] = feeRangeBounds(view.feeRange, nowMs);
  const inRange = all.filter((c) => (from === null || Date.parse(c.at) >= from) && (to === null || Date.parse(c.at) < to));
  // A choice with nothing left in the range falls back to all, so the log never sits empty behind a hidden filter.
  if (!inRange.some((c) => c.chain === view.feeChain)) view.feeChain = 'all';
  if (!inRange.some((c) => tokensOf(c).includes(view.feeToken))) view.feeToken = 'all';
  if (!inRange.some((c) => sourceOf(c) === view.feeSource)) view.feeSource = 'all';
  const matches = (c) => (view.feeChain === 'all' || c.chain === view.feeChain)
    && (view.feeToken === 'all' || tokensOf(c).includes(view.feeToken))
    && (view.feeSource === 'all' || sourceOf(c) === view.feeSource);
  const list = inRange.filter(matches);
  // Every collection with the filters but not the range: the outlook, pace and calendar look past the range.
  const pool = all.filter(matches);
  const filtered = list.length !== inRange.length;
  const total = list.reduce((s, c) => s + (c.usd ?? 0), 0);
  const unpriced = list.filter((c) => c.usd == null).length;
  // Averages run from the first collection, or the start of the range, to now, so quiet days count too.
  const first = all.length ? Math.min(nowMs, Date.parse(all[all.length - 1].at)) : nowMs;
  // A past range, such as last month, ends at its own end; the others run to now.
  const end = to === null ? nowMs : Math.min(nowMs, to);
  const start = from === null ? first : Math.max(from, Math.min(first, end));
  const spanDays = Math.max(1, (end - start) / DAY_MS);
  const perDay = total / spanDays;

  const stat = (label, value, hint = null) => h('div', { class: 'card lp-stat' },
    h('span', { class: 'muted' }, label), h('strong', null, value), hint ? h('span', { class: 'muted small' }, hint) : null);
  const pills = (items, current, set) => h('div', { class: 'row lp-filters' }, items.map(([key, label]) =>
    h('button', {
      type: 'button',
      class: current === key ? 'period-btn active' : 'period-btn',
      'aria-pressed': String(current === key),
      onclick: () => {
        set(key);
        store.refresh();
      },
    }, label)));

  let chart = null;
  if (list.length) {
    const sums = new Map();
    const groups = new Map();
    for (const c of list) {
      const key = bucketOf(new Date(c.at), view.feeGroup);
      sums.set(key, (sums.get(key) ?? 0) + (c.usd ?? 0));
      groups.set(key, [...(groups.get(key) ?? []), c]);
    }
    const keys = bucketsBetween(new Date(start), new Date(end - 1), view.feeGroup);
    chart = barChart(keys.map((k) => bucketLabel(k, view.feeGroup)), [{ name: 'Collected', color: 'var(--accent)', values: keys.map((k) => sums.get(k) ?? 0) }], {
      format: (v) => money(v, 'USD'),
      tip: (i) => bucketTip(keys[i], view.feeGroup, groups.get(keys[i]) ?? []),
    });
  }

  const table = h('div', { class: 'card mon-scroll' },
    h('table', { class: 'mon-table' },
      h('thead', null, h('tr', null,
        feeSortHead(store, 'date', 'Date'),
        feeSortHead(store, 'chain', 'Chain'),
        feeSortHead(store, 'position', 'Position'),
        feeSortHead(store, 'tokens', 'Tokens'),
        feeSortHead(store, 'source', 'Source'),
        feeSortHead(store, 'value', 'Value', { class: 'num' }),
        h('th', null, ''))),
      h('tbody', null, sortCollects([...list], view.feeSort, view.feeDir).map((c) => h('tr', null,
        h('td', { title: c.since ? `Collected between ${new Date(c.since).toLocaleString()} and ${new Date(c.at).toLocaleString()}` : null },
          new Date(c.at).toLocaleDateString(),
          // One logged by hand is set to noon, a placeholder, so it shows no time.
          c.source === 'manual' ? null : h('span', { class: 'muted' }, ` ${new Date(c.at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`),
          c.level === 1 ? h('div', { class: 'muted small' }, `The ${c.sym0} part could not be read`) : null),
        h('td', null, c.chain
          ? h('span', { class: 'chain-chip' }, logo(CHAINS.find((x) => x.name === c.chain)?.logo, c.chain, 'xs'), c.chain)
          : h('span', { class: 'muted' }, '—')),
        h('td', null,
          c.pair
            ? h('div', { class: 'lp-pos' },
                positionDot(c),
                c.ref
                  ? h('button', { type: 'button', class: 'link-btn', title: 'See this position', onclick: () => openDetail(store, c.ref) }, c.pair)
                  : h('strong', null, c.pair))
            : h('span', { class: 'muted' }, '—'),
          h('div', { class: 'muted small' }, [c.tokenId ? `#${c.tokenId}` : '', c.note].filter(Boolean).join(' · '))),
        h('td', { class: 'small' }, tokenCell(c)),
        h('td', { class: 'small muted', title: c.tx ?? null }, SOURCE_NAMES[sourceOf(c)]),
        h('td', { class: 'num', title: { auto: 'The unclaimed fees at the read before the collect. Fees earned after that read are not counted.', chain: COLLECT_TITLE, etherscan: COLLECT_TITLE }[c.source] ?? null }, usdOrDash(c.usd ?? null)),
        h('td', null, h('button', {
          type: 'button',
          class: 'icon-btn',
          title: 'Remove',
          'aria-label': `Remove the collection of ${new Date(c.at).toLocaleDateString()}`,
          onclick: () => removeCollect(store, c),
        }, icon('trash'))))))));

  return h('div', { class: 'stack-lg' },
    h('div', { class: 'row between' },
      pills(FEE_RANGE_ORDER.filter((k) => (shown[k] ?? true) || view.feeRange === k).map((k) => [k, FEE_RANGES[k][1]]), view.feeRange, (k) => { view.feeRange = k; view.feeAuto = false; view.feeGroup = defaultFeeGroup(k); }),
      view.logging ? null : h('button', {
        type: 'button',
        class: 'btn-small',
        onclick: () => {
          view.logging = true;
          view.logMessage = '';
          store.refresh();
        },
      }, icon('plus'), 'Log a collection')),
    view.logging ? logForm(store) : null,
    feeFilters(store, inRange),
    h('div', { class: 'lp-stats' },
      stat('Collected', money(total, 'USD'), plural(list.length, 'collection')),
      stat('Per day', money(perDay, 'USD'), `over ${plural(Math.round(spanDays), 'day')}`),
      stat('Per week', money(perDay * 7, 'USD')),
      stat('Per month', money(perDay * 30.44, 'USD')),
      stat('Per year', money(perDay * 365, 'USD'))),
    coverageCard(store),
    etherscanErrors.size
      ? notice({ tone: 'info', text: `Etherscan could not be read for ${[...etherscanErrors].map(([name, text]) => `${name} (${text})`).join(', ')}. Collects there come from the node only.` })
      : null,
    unpriced ? h('p', { class: 'muted small' }, `${plural(unpriced, 'collection')} without a USD value (prices were unavailable) ${unpriced === 1 ? 'is' : 'are'} left out of the totals.`) : null,
    list.length
      ? h('section', { class: 'card stack' },
          h('div', { class: 'row between' }, h('h3', null, 'Over time'), pills(FEE_GROUPS, view.feeGroup, (k) => { view.feeGroup = k; })),
          chart)
      : null,
    pool.length ? feeInsights(store, { list, pool, start, end, from, to, perDay, spanDays, nowMs, stat, group: view.feeGroup }) : null,
    list.length
      ? table
      : h('div', { class: 'lp-empty' },
          h('span', { class: 'float' }, icon('coins')),
          h('p', null, filtered ? 'No collections match these filters.' : all.length ? 'No collections in this range.' : 'No collections yet. Collects are read from the chain, and from Etherscan when its key is set in Settings. Between two reads, a drop in unclaimed fees is logged too. You can also log one by hand.')));
}

// ---- One position in detail: opened from a card, a list row, or a collection in the fee log ----

// The detail page plays its entrance motion once when it opens, not on each redraw while it is shown.
let detailEnter = false;
function openDetail(store, ref) {
  view.detailFrom = view.tab === 'fees' ? 'fees' : 'positions';
  view.detail = ref;
  detailEnter = true;
  if (picker.open) closePicker(store);
  store.refresh();
  window.scrollTo({ top: 0 });
}
function closeDetail(store) {
  view.detail = null;
  view.tab = view.detailFrom ?? view.tab;
  store.refresh();
}

// Block explorers, for the wallet, pool and token links. A chain without one gets no links.
const EXPLORERS = {
  1: 'https://etherscan.io',
  8453: 'https://basescan.org',
  42161: 'https://arbiscan.io',
  10: 'https://optimistic.etherscan.io',
  137: 'https://polygonscan.com',
  56: 'https://bscscan.com',
  43114: 'https://snowtrace.io',
  130: 'https://uniscan.xyz',
  324: 'https://era.zksync.network',
};
const explorerLink = (chainId, kind, id) => (EXPLORERS[chainId] && /^0x[0-9a-fA-F]{40}$/.test(id ?? '') ? `${EXPLORERS[chainId]}/${kind}/${id}` : null);

// The row for a position: as read now, or from any saved read, so a position whose wallet was removed still
// shows its range and holdings, marked as from that read.
function detailRow(store, ref) {
  const now = state.rows.find((r) => r.ref === ref);
  if (now) return now;
  for (const part of Object.values(store.get(COLLECTION)?.cache ?? {})) {
    const r = part?.rows?.find((x) => x.ref === ref);
    if (r) return { ...r, max: r.max ?? Infinity, staleAt: part.at };
  }
  return null;
}

// What a position earned over the last secs seconds, from the hours saved for fee APR, at today's prices.
// covered: the seconds those hours span, so a part-covered window is said as such.
function earnedOver(store, r, secs) {
  const hours = store.get(COLLECTION)?.earned?.[r.ref];
  if (!hours || r.p0 == null || r.p1 == null) return null;
  const last = Math.floor(Date.now() / 1000 / HOUR) - 1;
  const first = last - Math.round(secs / HOUR) + 1;
  let usd = 0;
  let n = 0;
  for (const [hour, [h0, h1]] of Object.entries(hours)) {
    const k = Number(hour);
    if (k < first || k > last) continue;
    usd += (Number(h0) / 10 ** r.dec0) * r.p0 + (Number(h1) / 10 ** r.dec1) * r.p1;
    n++;
  }
  if (!n) return null;
  const covered = n * HOUR;
  return { usd, covered, apr: r.value > 0 ? (usd / r.value) * (YEAR_MS / (covered * 1000)) : null };
}

// What a position earned per day over the last 30 days, from the saved hours, at today's prices.
function earnedChart(store, r) {
  const hours = store.get(COLLECTION)?.earned?.[r.ref];
  if (!hours || r.p0 == null || r.p1 == null) return null;
  const days = new Map();
  const since = Date.now() - 30 * DAY_MS;
  for (const [hour, [h0, h1]] of Object.entries(hours)) {
    const t = Number(hour) * HOUR * 1000;
    if (t < since) continue;
    const key = localDay(new Date(t));
    const d = days.get(key) ?? { a0: 0, a1: 0, hours: 0 };
    days.set(key, { a0: d.a0 + Number(h0) / 10 ** r.dec0, a1: d.a1 + Number(h1) / 10 ** r.dec1, hours: d.hours + 1 });
  }
  if (!days.size) return null;
  const first = [...days.keys()].sort()[0];
  const keys = bucketsBetween(new Date(`${first}T00:00`), new Date(), 'day');
  const usd = (d) => (d ? d.a0 * r.p0 + d.a1 * r.p1 : 0);
  const total = [...days.values()].reduce((s, d) => s + usd(d), 0);
  const chart = barChart(keys.map((k) => bucketLabel(k, 'day')), [{ name: 'Earned', color: 'var(--income)', values: keys.map((k) => usd(days.get(k))) }], {
    format: (v) => money(v, 'USD'),
    tip: (i) => {
      const d = days.get(keys[i]);
      return [
        h('span', { class: 'muted' }, bucketName(keys[i], 'day')),
        h('strong', null, money(usd(d), 'USD')),
        d ? h('span', { class: 'tip-row' }, h('span', null, r.sym0), h('span', null, amount(d.a0))) : h('span', { class: 'muted' }, 'No hours saved'),
        d ? h('span', { class: 'tip-row' }, h('span', null, r.sym1), h('span', null, amount(d.a1))) : null,
        d && d.hours < 24 ? h('span', { class: 'muted' }, `${plural(d.hours, 'hour')} saved`) : null,
      ];
    },
  });
  return { chart, total, days: keys.length };
}

// A section card with a title, an optional note on the right, and its content.
function panel(title, note, ...children) {
  return h('section', { class: 'card stack lp-panel' },
    h('div', { class: 'lp-panel-head' }, h('h3', null, title), note ? h('span', { class: 'muted small' }, note) : null),
    ...children);
}

// How far the price moves, as a percent, to reach a price.
const moveTo = (from, to) => (from > 0 && to > 0 && Number.isFinite(to) ? (to / from - 1) * 100 : null);
const signedPct = (x) => (x == null ? '—' : `${x > 0 ? '+' : ''}${Math.abs(x) >= 100 ? x.toFixed(0) : x.toFixed(1)}%`);

// The range on a price scale wider than it, so the price shows where it sits even out of range. Log scale:
// prices move in ratios.
function rangeScale(r, p) {
  const lo = Math.log(p.min);
  const hi = Math.log(p.max);
  const cur = Math.log(p.current);
  const pad = Math.max((hi - lo) * 0.45, 0.02);
  const from = Math.min(lo - pad, cur - pad / 2);
  const to = Math.max(hi + pad, cur + pad / 2);
  const at = (x) => ((x - from) / (to - from)) * 100;
  const kind = r.closed ? 'closed' : r.inRange ? 'in' : 'out';
  return h('div', { class: `rv rv-${kind}`, role: 'img', 'aria-label': `Range ${price(p.min)} to ${price(p.max)} ${p.unit}, price now ${price(p.current)}` },
    h('div', { class: 'rv-now', style: { left: `${Math.min(92, Math.max(8, at(cur)))}%` } }, h('span', null, 'Now'), h('strong', null, price(p.current))),
    h('div', { class: 'rv-track' },
      h('span', { class: 'rv-band', style: { left: `${at(lo)}%`, width: `${at(hi) - at(lo)}%` } }),
      h('span', { class: 'rv-edge', style: { left: `${at(lo)}%` } }),
      h('span', { class: 'rv-edge', style: { left: `${at(hi)}%` } }),
      h('span', { class: 'rv-marker', style: { left: `${at(cur)}%` } })),
    h('div', { class: 'rv-labels' },
      h('span', { class: 'rv-min', style: { left: `${at(lo)}%` } }, price(p.min)),
      h('span', { class: 'rv-max', style: { left: `${at(hi)}%` } }, price(p.max))));
}

// The price range: the scale, the bounds, the room to each edge, the width and the ticks.
function detailRange(store, r) {
  const flip = isFlipped(store, r);
  const p = sideOf(r, flip);
  const head = (note) => h('div', { class: 'lp-panel-head' },
    h('h3', null, 'Price range'),
    h('span', { class: 'row muted small' }, note, r.full ? null : flipButton(store, r, flip)));
  if (r.full || !(p.min > 0) || !Number.isFinite(p.max) || !(p.current > 0)) {
    return h('section', { class: 'card stack lp-panel' },
      head(`${p.unit} per ${p.base}`),
      h('div', { class: 'lp-range-full' },
        h('strong', null, 'Full range'),
        h('span', { class: 'muted' }, `The position earns at every price. Now ${price(p.current)} ${p.unit} per ${p.base}.`)));
  }
  const down = moveTo(p.current, p.min);
  const up = moveTo(p.current, p.max);
  const width = moveTo(p.min, p.max);
  const where = r.closed
    ? 'Closed: no liquidity in this range.'
    : r.inRange
      ? `In range. The price can move ${signedPct(down)} or ${signedPct(up)} before it leaves.`
      : p.current < p.min
        ? `Out of range, below. The price needs ${signedPct(down)} to reach it again.`
        : `Out of range, above. The price needs ${signedPct(up)} to reach it again.`;
  const box = (label, value, hint, cls = '') => h('div', { class: `mini ${cls}` }, h('span', { class: 'muted small' }, label), h('strong', null, value), h('span', { class: 'muted small' }, hint));
  return h('section', { class: 'card stack lp-panel' },
    head(`${p.unit} per ${p.base}`),
    rangeScale(r, p),
    h('p', { class: `lp-range-where ${r.closed ? 'closed' : r.inRange ? 'in' : 'out'}` }, where),
    h('div', { class: 'mini-stats' },
      box('Min price', price(p.min), `${signedPct(down)} from now`),
      box('Current', price(p.current), `${p.unit} per ${p.base}`),
      box('Max price', price(p.max), `${signedPct(up)} from now`),
      box('Width', signedPct(width), 'max over min')),
    h('p', { class: 'muted small' },
      `1 ${r.sym0} = ${price(r.current)} ${r.sym1} · 1 ${r.sym1} = ${price(r.current > 0 ? 1 / r.current : 0)} ${r.sym0} · ticks ${r.tickLower} → ${r.tickUpper}`));
}

// What the position holds: each token's amount, value and share, then the unclaimed fees.
function detailHoldings(r) {
  const total = r.value > 0 ? r.value : null;
  const line = (addr, sym, n, px, share = null) => h('li', null,
    h('span', { class: 'lp-token' }, logo(tokenLogoOf(r, addr), sym, 'xs'), h('strong', null, sym)),
    h('span', { class: 'num' }, amount(n)),
    h('span', { class: 'num muted' }, px == null ? '—' : money(n * px, 'USD')),
    share == null ? null : h('span', { class: 'lp-share', title: `${Math.round(share * 100)}% of the value`, style: { '--w': `${Math.round(share * 100)}%` } }),
    share == null ? null : h('span', { class: 'lp-share-pct muted small' }, `${Math.round(share * 100)}%`));
  const fees = typeof r.fee0 === 'number';
  return panel('Holdings', total ? money(total, 'USD') : null,
    h('ul', { class: 'lp-holdings' },
      line(r.addr0, r.sym0, r.a0, r.p0, total ? (r.a0 * r.p0) / total : null),
      line(r.addr1, r.sym1, r.a1, r.p1, total ? (r.a1 * r.p1) / total : null)),
    h('div', { class: 'lp-panel-head' }, h('h3', null, 'Unclaimed fees'), h('span', { class: 'muted small' }, usdOrDash(r.fees))),
    fees
      ? h('ul', { class: 'lp-holdings' }, line(r.addr0, r.sym0, r.fee0, r.p0), line(r.addr1, r.sym1, r.fee1, r.p1))
      : h('p', { class: 'muted small' }, 'Not read.'));
}

// Fees earned over the last day, week and month, from the saved hours, with the yearly rate each makes.
function detailEarnings(store, r) {
  const rows = [['24 h', 86400], ['7 days', 7 * 86400], ['30 days', 30 * 86400]].map(([label, secs]) => [label, secs, earnedOver(store, r, secs)]);
  if (!rows.some(([, , e]) => e)) return null;
  return panel('Earnings', 'From the swaps, at today\'s prices',
    h('table', { class: 'mon-table lp-earn' },
      h('thead', null, h('tr', null, h('th', null, 'Over'), h('th', { class: 'num' }, 'Earned'), h('th', { class: 'num' }, 'Fee APR'), h('th', { class: 'num' }, 'Covered'))),
      h('tbody', null, rows.map(([label, secs, e]) => h('tr', null,
        h('td', null, label),
        h('td', { class: 'num' }, e ? money(e.usd, 'USD') : '—'),
        h('td', { class: 'num' }, e?.apr != null ? pct(e.apr) : '—'),
        h('td', { class: 'num muted' }, e ? (e.covered >= secs * 0.95 ? 'full' : span(e.covered)) : '—'))))));
}

// The facts: chain, numbers, addresses with explorer links, and how fresh the read is.
function detailFacts(store, r) {
  const d = store.get(COLLECTION) ?? {};
  const cfg = store.get('settings').uniswap ?? {};
  const address = (kind, id, label = shortAddress(id)) => h('span', { class: 'row lp-addr' },
    copyable(id, { label }),
    explorerLink(r.chainId, kind, id) ? h('a', { href: explorerLink(r.chainId, kind, id), target: '_blank', rel: 'noopener', class: 'icon-btn', title: 'Open in the block explorer', 'aria-label': `Open ${label} in the block explorer` }, icon('link')) : null);
  const share = searchShare(r, d, cfg);
  const facts = [
    ['Chain', h('span', { class: 'chain-chip' }, logo(chainOf(r.chainId)?.logo, r.chain, 'xs'), r.chain)],
    ['Protocol', `Uniswap ${r.version} · ${r.feePct}% fee tier`],
    ['Position', r.url ? h('a', { href: r.url, target: '_blank', rel: 'noopener' }, `#${r.tokenId}`) : `#${r.tokenId}`],
    ['Owner', r.owner],
    ['Wallet', address('address', r.wallet)],
    [r.version === 'v4' ? 'Pool ID' : 'Pool', r.pool ? (r.version === 'v4' ? copyable(r.pool, { label: `${r.pool.slice(0, 10)}…${r.pool.slice(-6)}` }) : address('address', r.pool)) : '—'],
    [r.sym0, address('token', r.addr0)],
    [r.sym1, address('token', r.addr1)],
    ['Liquidity', BigInt(r.liq ?? '0').toLocaleString()],
    ['Read', r.staleAt ? `${ago(r.staleAt)} (outdated)` : state.at ? ago(state.at) : '—'],
    ['Prices', r.pricesAt ? `from ${ago(r.pricesAt)}` : 'Current'],
    ['Collect search', h('span', { class: 'row lp-search', title: COVERAGE_TITLE }, h('div', { class: 'meter', role: 'presentation' }, h('span', { style: { width: `${share * 100}%` } })), coveragePct(share))],
  ];
  return panel('Details', null,
    h('dl', { class: 'lp-facts' }, facts.map(([k, v]) => h('div', null, h('dt', { class: 'muted small' }, k), h('dd', null, v)))));
}

// The position's collections, newest first, with their total.
function detailCollections(collects) {
  const total = collects.reduce((s, c) => s + (c.usd ?? 0), 0);
  return panel('Collections', collects.length ? `${plural(collects.length, 'collection')} · ${money(total, 'USD')}` : null,
    collects.length
      ? h('div', { class: 'mon-scroll' }, h('table', { class: 'mon-table' },
          h('thead', null, h('tr', null, h('th', null, 'Date'), h('th', null, 'Tokens'), h('th', null, 'Source'), h('th', { class: 'num' }, 'Value'))),
          h('tbody', null, collects.map((c) => h('tr', null,
            h('td', null, new Date(c.at).toLocaleDateString()),
            h('td', { class: 'small' }, tokenCell(c)),
            h('td', { class: 'small muted', title: c.tx ?? null }, SOURCE_NAMES[sourceOf(c)]),
            h('td', { class: 'num' }, usdOrDash(c.usd ?? null)))))))
      : h('p', { class: 'muted small' }, 'No collections logged for this position.'));
}

// Everything the board knows about one position. One no longer read anywhere shows what the fee log holds.
function detailView(store, ref) {
  const raw = detailRow(store, ref);
  const r = raw ? aprOf(store)(raw) : null;
  const collects = collectedOf(store).filter((c) => c.ref === ref).sort((a, b) => b.at.localeCompare(a.at));
  const known = r ?? collects[0];
  const back = h('button', { type: 'button', class: 'btn-small lp-back', onclick: () => closeDetail(store) },
    icon('arrow-left'), view.detailFrom === 'fees' ? 'Fees Collected' : 'Positions');
  if (!known) {
    return h('div', { class: 'stack-lg lp' }, back,
      notice({ tone: 'info', text: loading ? 'Reading the positions…' : 'This position is not among those read, and the fee log has nothing for it.' }));
  }
  const chain = r ? chainOf(r.chainId) : CHAINS.find((x) => x.name === known.chain);
  const syms = r ? [r.sym0, r.sym1] : tokensOf(known);
  const collectedUsd = collects.reduce((s, c) => s + (c.usd ?? 0), 0);
  const win = WINDOWS[view.window][1];
  const stat = (label, value, hint = null, title = null) => h('div', { class: 'card lp-stat', title },
    h('span', { class: 'muted' }, label), h('strong', null, value), hint ? h('span', { class: 'muted small' }, hint) : null);
  const earned = r ? earnedChart(store, r) : null;
  const kind = !r ? 'gone' : r.closed ? 'closed' : r.inRange ? 'in' : 'out';

  const hero = h('header', { class: `card lp-hero is-${kind}` },
    h('div', { class: 'lp-hero-main' },
      h('div', { class: 'pair lp-hero-pair' },
        r ? logo(tokenLogoOf(r, r.addr0), r.sym0, 'token') : logo(symbolLogo(syms[0]), syms[0] ?? '?', 'token'),
        r ? logo(tokenLogoOf(r, r.addr1), r.sym1, 'token second') : logo(symbolLogo(syms[1]), syms[1] ?? '?', 'token second')),
      h('div', { class: 'pool-title' },
        h('h2', null, known.pair ?? 'Position'),
        h('div', { class: 'pool-meta' },
          known.chain ? h('span', { class: 'chain-chip' }, logo(chain?.logo, known.chain, 'xs'), known.chain) : null,
          r ? h('span', { class: 'version-pill', title: `Uniswap ${r.version}` }, r.version) : null,
          r ? h('span', { class: 'fee-pill' }, `${r.feePct}%`) : null,
          r ? statusPill(r) : h('span', { class: 'status-pill closed' }, h('span', { class: 'dot' }), 'Not read'),
          r ? outdatedPill(r) : null,
          h('span', { class: 'muted small' }, `#${known.tokenId ?? '—'}${r ? ` · ${r.owner}` : ''}`)))),
    h('div', { class: 'lp-hero-side' },
      r ? h('div', { class: 'lp-hero-value' }, h('span', { class: 'muted small' }, 'Value'), h('strong', null, usdOrDash(r.value))) : null,
      h('div', { class: 'row' },
        r?.url ? h('a', { href: r.url, target: '_blank', rel: 'noopener', class: 'btn-small' }, icon('link'), 'Uniswap') : null,
        r && explorerLink(r.chainId, 'address', r.wallet)
          ? h('a', { href: explorerLink(r.chainId, 'address', r.wallet), target: '_blank', rel: 'noopener', class: 'btn-small', title: 'Open the wallet in the block explorer' }, icon('globe'), 'Wallet')
          : null)));

  return h('div', { class: 'stack-lg lp lp-detail' },
    back,
    hero,
    !r ? notice({ tone: 'info', text: 'This position is not among those read, and no saved read has it: it was burned, or its wallet was removed before it was read. Below is what the fee log holds for it.' }) : null,
    r?.closed ? notice({ tone: 'info', text: 'Closed: this position holds no liquidity now. Its range, its last prices and its fee history are shown as read.' }) : null,
    h('div', { class: 'lp-stats' },
      r ? stat('Unclaimed fees', usdOrDash(r.fees)) : null,
      r && !r.closed ? stat(`Fee APR · ${win}`, aprText(r), null, aprTitle(r)) : null,
      r && !r.closed ? stat(`Movement · ${win}`, moveView(r), r.aprPrev != null ? `from ${pct(r.aprPrev)}` : null, moveTitle(r)) : null,
      stat('Fees collected', money(collectedUsd, 'USD'), plural(collects.length, 'collection')),
      r && r.fees != null ? stat('Total earned', money(collectedUsd + r.fees, 'USD'), 'collected and unclaimed') : null),
    r && !r.closed
      ? h('label', { class: 'inline lp-sort', title: 'The time fee APR is read over' }, 'APR window',
          h('select', {
            'aria-label': 'Fee APR window',
            onchange: (e) => {
              view.window = e.target.value;
              store.refresh();
              loadAprs(store);
            },
          }, Object.entries(WINDOWS).map(([key, [, label]]) => h('option', { value: key, selected: key === view.window }, label))))
      : null,
    r ? detailRange(store, r) : null,
    // A closed position holds nothing, so its holdings are left out unless fees are still owed.
    r ? h('div', { class: 'lp-detail-grid' }, r.closed && !(r.a0 || r.a1 || r.fee0 || r.fee1) ? null : detailHoldings(r), detailEarnings(store, r)) : null,
    earned
      ? panel('Fees earned per day', `${money(earned.total, 'USD')} over ${plural(earned.days, 'day')} · ${money(earned.total / earned.days, 'USD')} a day`, earned.chart)
      : null,
    detailCollections(collects),
    r ? detailFacts(store, r) : null);
}

const FEES_SUBTITLE = 'Fees collected from your positions: read from the chain, from Etherscan when its key is set, and logged by hand.';

// The tab's two views: the positions, and the fees collected from them. Sub-tabs, as in Monitoring and Tools.
function tabs(store) {
  return h('nav', { class: 'sub-tabs lp-tabs', role: 'tablist', 'aria-label': 'Liquidity Pools view' },
    [['positions', 'Positions', 'droplet'], ['fees', 'Fees Collected', 'coins']].map(([key, label, iconName]) =>
      h('button', {
        type: 'button',
        role: 'tab',
        class: view.tab === key ? 'sub-tab active' : 'sub-tab',
        'aria-selected': String(view.tab === key),
        onclick: () => {
          view.tab = key;
          store.refresh();
        },
      }, icon(iconName), label)));
}

function showDetail(root, store) {
  if (detailEnter) root.classList.add('enter');
  detailEnter = false;
  root.replaceChildren(detailView(store, view.detail));
}

function draw(root, store) {
  keepAddFocus();
  const cfg = store.get('settings').uniswap ?? {};
  const wallets = (cfg.wallets ?? []).filter((w) => isAddress(w.address));
  if (!wallets.length && !addedPositions(cfg).length) {
    // The log of collections stays reachable once there is one, even with no wallet left.
    const logged = collectedOf(store).length > 0;
    if (!logged) view.tab = 'positions';
    if (view.detail && logged) {
      showDetail(root, store);
      return;
    }
    root.replaceChildren(h('div', { class: 'stack-lg lp' },
      h('header', null,
        h('h2', null, 'Liquidity Pools'),
        logged && view.tab === 'fees' ? h('p', { class: 'muted small' }, FEES_SUBTITLE) : null),
      logged ? tabs(store) : null,
      view.tab === 'fees'
        ? feesView(store)
        : [setupBanner('uniswap', 'Add a wallet address in Settings to see its Uniswap positions.'),
            view.adding ? addForm(store) : h('button', { type: 'button', class: 'btn-small', onclick: () => openAdd(store) }, icon('plus'), 'Add a position by link or number')]));
    keepPickerFocus(root);
    return;
  }
  // Until the first read lands, show what the last one saved.
  if (state.status === 'idle' && !state.rows.length) {
    state.rows = savedRows(store, cfg, cacheKeys(enabledChains(cfg))).sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
  }
  if (state.status === 'idle' || (state.status === 'ok' && Date.now() - state.at > STALE_MS)) {
    setTimeout(() => load(store), 0);
  }
  askLogos(store);
  if (view.detail) {
    showDetail(root, store);
    return;
  }

  const chainCount = enabledChains(cfg).length;
  const all = state.rows;
  // Chain chips show only chains that have positions, so the row stays short.
  const chainsWithRows = CHAINS.filter((c) => all.some((r) => r.chainId === c.id));
  if (view.chain !== 'all' && !chainsWithRows.some((c) => c.id === view.chain)) view.chain = 'all';
  const inChain = view.chain === 'all' ? all : all.filter((r) => r.chainId === view.chain);
  // Closed positions only show under their own filter, and never count in the totals.
  const byChain = inChain.filter((r) => !r.closed);
  const closedRows = inChain.filter((r) => r.closed);
  const showClosed = view.filter === 'closed';
  const inRange = byChain.filter((r) => r.inRange).length;
  const pick = { in: byChain.filter((r) => r.inRange), out: byChain.filter((r) => !r.inRange), closed: closedRows }[view.filter] ?? byChain;
  const withApr = aprOf(store);
  const shown = sortRows(pick.map(withApr), view.sort, view.dir);
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
  }, key === 'all' ? null : h('span', { class: `pos-dot ${key}`, 'aria-hidden': 'true' }), label, h('span', { class: 'chip-count' }, count));

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
    const collected = collectedByRef(store);
    body = view.layout === 'list'
      ? poolTable(shown, store)
      : h('div', { class: 'lp-grid' }, shown.map((r) => poolCard(r, seen.has(r.ref) ? null : order++, collected, store)));
    shown.forEach((r) => seen.add(r.ref));
  } else {
    const filtered = view.filter !== 'all' || view.chain !== 'all';
    body = h('div', { class: 'lp-empty' },
      h('span', { class: 'float' }, icon('wallet')),
      h('p', null, showClosed ? 'No closed positions.' : all.length && filtered ? 'No positions match this filter.' : 'No open Uniswap positions for these wallets.'));
  }

  root.replaceChildren(h('div', { class: 'stack-lg lp' },
    h('div', { class: 'row between lp-head' },
      h('div', null,
        h('h2', null, 'Liquidity Pools'),
        h('p', { class: 'muted small' },
          view.tab === 'fees'
            ? FEES_SUBTITLE
            : `Uniswap v3 and v4 positions on ${chainCount} chain${chainCount === 1 ? '' : 's'}, read from the chain. Read-only.`,
          state.pending.length ? ` Reading ${state.pending.join(', ')}…` : state.at ? ` ${updatedText()}.` : '')),
      h('div', { class: 'row' },
        view.tab === 'fees' ? null : h('button', { type: 'button', class: 'btn-small', onclick: () => openAdd(store), title: 'Add a position the board did not find' }, icon('plus'), 'Add position'),
        h('button', { type: 'button', class: 'btn-small', disabled: reading || chainCount === 0, onclick: () => load(store) },
        refreshIcon(reading),
          reading ? 'Reading…' : 'Refresh'))),

    tabs(store),
    view.adding && view.tab !== 'fees' ? addForm(store) : null,
    state.shallow.length
      ? notice({ tone: 'info', text: `The node for ${state.shallow.join(', ')} keeps only recent history, so older v4 positions there are not found. Add them with Add position, or set a node that keeps full history in Settings.` })
      : null,
    staleText ? notice({ tone: 'info', text: staleText }) : null,
    !state.at && all.length ? notice({ tone: 'info', text: 'Showing the positions saved by the last read while the chains are read again.' }) : null,
    state.warning ? notice({ tone: 'info', text: state.warning }) : null,
    state.status === 'error' ? notice({ text: `The positions could not be read: ${state.error}` }) : null,
    chainCount === 0 ? notice({ tone: 'info', text: 'No chains are selected. Pick the chains to read in Settings.' }) : null,

    view.tab === 'fees' ? feesView(store) : [
    h('div', { class: 'lp-stats' },
      h('div', { class: 'card lp-stat' }, h('span', { class: 'muted' }, 'Total liquidity'), valueEl),
      h('div', { class: 'card lp-stat' }, h('span', { class: 'muted' }, 'Unclaimed fees'), feesEl),
      h('div', { class: 'card lp-stat' }, h('span', { class: 'muted' }, 'Positions'), h('strong', null, `${byChain.length} · ${inRange} in range`))),

    firstRead ? null : insightsPanel(store, byChain.map(withApr), {
      sideOf: (r) => sideOf(r, isFlipped(store, r)),
      isFlipped: (pair) => isFlipped(store, pair),
    }),

    chainsWithRows.length > 1
      ? h('div', { class: 'row lp-filters lp-chains' },
          chainChip('all', 'All chains', null, all.filter((r) => !!r.closed === showClosed).length),
          chainsWithRows.map((c) => chainChip(c.id, c.name, c.logo, all.filter((r) => r.chainId === c.id && !!r.closed === showClosed).length)))
      : null,

    h('div', { class: 'row between' },
      h('div', { class: 'row lp-filters' },
        chip('all', 'All', byChain.length),
        chip('in', 'In range', inRange),
        chip('out', 'Out of range', byChain.length - inRange),
        closedRows.length || showClosed ? chip('closed', 'Closed', closedRows.length) : null),
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

    body]));

  for (const run of counters) run();
  keepPickerFocus(root);
}

export default {
  id: 'positions',
  title: 'Liquidity Pools',
  short: 'Pools',
  icon: 'droplet',
  collection: COLLECTION,
  defaults: { cache: {}, prices: {}, scan: {}, fees: {}, earned: {}, collected: [], history: {}, hidden: [], etherscan: {}, flip: {}, insights: [] },
  render: draw,
  serialize: () => ({
    filter: view.filter === 'all' ? '' : view.filter,
    chain: view.chain === 'all' ? '' : String(view.chain),
    view: view.layout === 'list' ? 'list' : '',
    sort: view.sort === 'value' && view.dir === -1 ? '' : sortName(view.sort, view.dir),
    apr: view.window === '24h' ? '' : view.window,
    tab: view.tab === 'fees' ? 'fees' : '',
    range: view.feeAuto ? '' : view.feeRange,
    by: view.feeGroup === defaultFeeGroup(view.feeRange) ? '' : view.feeGroup,
    fsort: view.feeSort === 'date' && view.feeDir === -1 ? '' : sortName(view.feeSort, view.feeDir),
    fchain: view.feeChain === 'all' ? '' : view.feeChain,
    ftoken: view.feeToken === 'all' ? '' : view.feeToken,
    fsource: view.feeSource === 'all' ? '' : view.feeSource,
    pos: view.detail ?? '',
    from: view.detail && view.detailFrom === 'fees' ? 'fees' : '',
  }),
  restore: (p = {}) => {
    view.filter = ['in', 'out', 'closed'].includes(p.filter) ? p.filter : 'all';
    view.layout = p.view === 'list' ? 'list' : 'cards';
    [view.sort, view.dir] = parseSort(p.sort);
    view.window = Object.hasOwn(WINDOWS, p.apr) ? p.apr : '24h';
    const id = Number(p.chain);
    view.chain = CHAINS.some((c) => c.id === id) ? id : 'all';
    view.tab = p.tab === 'fees' ? 'fees' : 'positions';
    view.feeAuto = !Object.hasOwn(FEE_RANGES, p.range);
    view.feeRange = view.feeAuto ? '7' : p.range;
    view.feeGroup = FEE_GROUPS.some(([k]) => k === p.by) ? p.by : defaultFeeGroup(view.feeRange);
    const [fkey, fdir] = String(p.fsort ?? '').split('-');
    [view.feeSort, view.feeDir] = Object.hasOwn(FEE_SORTS, fkey) ? [fkey, fdir === 'asc' ? 1 : -1] : ['date', -1];
    // Chain and token names are checked against the log when it is drawn.
    view.feeChain = p.fchain || 'all';
    view.feeToken = p.ftoken || 'all';
    view.feeSource = Object.hasOwn(SOURCE_NAMES, p.fsource) ? p.fsource : 'all';
    // The position shown in detail, checked against the rows and the log when it is drawn.
    view.detail = typeof p.pos === 'string' && p.pos ? p.pos : null;
    view.detailFrom = p.from === 'fees' ? 'fees' : view.tab;
  },
};
