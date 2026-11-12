// Liquidity Pools without the DOM: reading Uniswap v3 and v4 positions from each chain's node, their fee APR from
// the pools' swaps, and the fees they collected (from the node and Etherscan). Everything read is saved in pools.json,
// which DeFi → Positions renders:
//   cache, prices, scan, fees, collected, earned, history, etherscan, as before;
//   read: { at, warnings: { "<chainId>:<version>": text }, stale: { "<chainId>:<version>": at }, shallow: [chain names],
//     pending: [chain names] }, the state of the last read;
//   aprs: { "<window>|<ref>": { apr, secs, full, prev, prevSecs, at } }, fee APR from swaps;
//   etherscanErrors: { <chain name>: text }.
// Cron reads open positions through openPositions().
import { uid } from '../ui.js';
import { readPositions, poolState, tokenMeta, isAddressSymbol, usdPrices, positionAmounts, priceAtTick, isAddress, CHAINS, chainSettings, addedPositions, scanV4, readV4Position, readV3Position, chainClock, poolSwaps, swapFees, swapEarn, isClosed, positionHistory, collectFees, usdPricesAt, nodeSource, etherscanSource, collectTx, positionsInReceipt, walletPositionTxs, nodeKey, nodeUrls } from '../uniswap.js';
import { etherscanKey } from '../chains.js';
import { poolsChanged } from '../automations.js';
/** @import { DataStore, UniswapSettings, Wallet, PoolsData, PoolRow, PoolCachePart, ChainPrices, FeeBaseline, CollectEntry, EarnedHours, V4Scan, AprEntry, PositionsReadState, PositionHistory } from '../../types/data' */
/** @import { PositionRow } from '../../types/defi' */
/** @import { Chain, Position, PoolState } from '../../types/uniswap' */
/**
 * A position as read from the chain, with its wallet's label.
 * @typedef {Position & { label: string }} LabeledPosition
 * @typedef {{ position: LabeledPosition, pool?: PoolState | null }} PositionRead
 * @typedef {NonNullable<Awaited<ReturnType<typeof readV4Position>>>} V4Read
 * @typedef {{ symbol: string, decimals: number, guessed?: boolean }} TokenInfo
 * @typedef {Awaited<ReturnType<typeof chainClock>>} Clock
 * @typedef {(chainId: number, text: string | null, lane?: string) => void} Say
 */

const COLLECTION = 'pools';
const YEAR_MS = 365 * 24 * 60 * 60 * 1000;
const DAY_MS = 86400000;
const MAX_TICK = 887272; // the widest possible range: a "full range" position
// The windows fee APR can be read over, in seconds, with their labels.
/** @type {Record<string, [number, string]>} */
export const WINDOWS = { '15m': [15 * 60, '15 min'], '1h': [3600, '1 h'], '3h': [3 * 3600, '3 h'], '6h': [6 * 3600, '6 h'], '24h': [86400, '24 h'], '7d': [7 * 86400, '7 d'], '30d': [30 * 86400, '30 d'] };
/** @type {Map<string, TokenInfo>} */
const tokenInfo = new Map(); // "chainId:token address" -> { symbol, decimals }, read once per process
export const knownTokens = () => tokenInfo;
/** @param {number} chainId */
const chainOf = (chainId) => CHAINS.find((c) => c.id === chainId);

/** @param {{ id: number }} chain @param {string} address */
export const tokenKey = (chain, address) => `${chain.id}:${address}`;
// v3 rows keep their old key, so tasks made before v4 still match.
/** @param {string} version @param {number} chainId @param {string | number} tokenId */
export const refOf = (version, chainId, tokenId) => (version === 'v3' ? `${chainId}:${tokenId}` : `${chainId}:${version}:${tokenId}`);

// Builds one row from a position, its pool's current state and the token prices on its chain.
/**
 * @param {LabeledPosition} p @param {PoolState | null | undefined} pool @param {Record<string, number>} prices @param {Chain} chain
 * @param {number | null} [pricesAt]
 * @returns {PoolRow | null}
 */
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
    share0: value ? (a0 * /** @type {number} */ (p0)) / value : null,
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

/** @param {string} a */
export const shortAddress = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;

// v3 baselines saved before v3 fees were read in full hold stale amounts, and would count every fee since the
// last collect as earned at once, so they start again.
const BASELINE_V = 2;
/** @param {Record<string, FeeBaseline> | undefined} baselines @param {{ ref: string, version: string }} r */
export const baselineOf = (baselines, r) => {
  const b = baselines?.[r.ref];
  return b && (r.version !== 'v3' || b.v === BASELINE_V) ? b : null;
};

// The fee baseline of each position: its unclaimed fees in tokens when the board started counting. It restarts
// when the fees drop, which means they were collected. Rows from an earlier read keep their baseline as is.
/** @param {Record<string, FeeBaseline> | undefined} old @param {PoolRow[]} rows @param {number} now */
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
/** @param {PoolCachePart | undefined} before @param {PoolRow[]} rows @param {number} now */
function collectsOf(before, rows, now) {
  if (!before?.rows?.length) return [];
  const old = new Map(before.rows.map((r) => [r.ref, r]));
  /** @type {CollectEntry[]} */
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
      chainId: r.chainId,
      tokenId: r.tokenId,
      a0: o.fee0,
      a1: o.fee1,
      sym0: r.sym0,
      sym1: r.sym1,
      addr0: r.addr0,
      addr1: r.addr1,
      usd: p0 != null && p1 != null ? o.fee0 * p0 + o.fee1 * p1 : null,
    });
  }
  return out;
}

// Whether a fee counter entry stands for a collect made at time t (ms): it was seen between two reads around t.
// Fee counter entries ('auto') always have since.
/** @param {CollectEntry} c @param {number} t */
export const coversCollect = (c, t) => t >= Date.parse(/** @type {string} */ (c.since)) - 60000 && t <= Date.parse(c.at) + 60000;


// Finds and reads one chain's v4 positions: those the search found for each wallet, and those added by hand.
// saved is the search state the last load kept for this chain, keyed by lowercase wallet address.
/**
 * @param {Chain} chain @param {string} node @param {Wallet[]} wallets @param {Partial<UniswapSettings>} cfg
 * @param {Record<string, V4Scan>} saved
 */
async function readV4(chain, node, wallets, cfg, saved) {
  /** @type {Record<string, V4Scan>} */
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
  const items = /** @type {V4Read[]} */ ([...read.values()]
    .filter((r) => r && (manual.has(r.position.tokenId) || labels.has(r.position.owner))))
    .map((r) => ({ ...r, position: { ...r.position, label: labels.get(r.position.owner) ?? shortAddress(r.position.owner) } }));
  return { items, scans };
}

// Every wallet's v3 positions on a chain, and those added by hand, each with its pool's current state.
/** @param {Chain} chain @param {string} node @param {Wallet[]} wallets @param {Partial<UniswapSettings>} cfg */
async function readV3(chain, node, wallets, cfg) {
  const owned = (await Promise.all(wallets.map(async (w) => (await readPositions(chain, node, w.address)).map((p) => ({ ...p, label: w.label || w.address }))))).flat();
  const labels = new Map(wallets.map((w) => [w.address.toLowerCase(), w.label || w.address]));
  const have = new Set(owned.map((p) => p.tokenId));
  const added = addedPositions(cfg).filter((x) => x.version === 'v3' && x.chainId === chain.id && !have.has(String(x.tokenId)));
  const extra = /** @type {Position[]} */ ((await Promise.all(added.map((x) => readV3Position(chain, node, x.tokenId))))
    .filter(Boolean))
    .map((p) => ({ ...p, label: labels.get(p.owner) ?? shortAddress(p.owner) }));
  const positions = [...owned, ...extra];
  /** @type {Map<string, PoolState | null>} */
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
/** @param {Chain} chain @param {string} node @param {PositionRead[]} items @param {ChainPrices | undefined} savedPrices */
async function toRows(chain, node, items, savedPrices) {
  const tokens = [...new Set(items.flatMap((x) => [x.position.token0, x.position.token1]))];
  // A symbol that could not be read is asked for again, rather than showing the address for good.
  await Promise.all(tokens.filter((t) => !tokenInfo.has(tokenKey(chain, t)) || /** @type {TokenInfo} */ (tokenInfo.get(tokenKey(chain, t))).guessed).map(async (t) => tokenInfo.set(tokenKey(chain, t), await tokenMeta(node, t, chain))));
  /** @type {Record<string, number>} */
  let prices = {};
  /** @type {number | null} */
  let pricesAt = null;
  /** @type {Record<string, number> | null} */
  let fresh = null;
  let warning = '';
  try {
    prices = await usdPrices(chain, tokens);
    fresh = prices;
  } catch (err) {
    if (savedPrices) {
      prices = savedPrices.usd;
      pricesAt = savedPrices.at;
      warning = `${chain.name} token prices could not be read (${/** @type {Error} */ (err).message}), so values use the prices from ${ago(pricesAt)}.`;
    } else {
      warning = `${chain.name} token prices are unavailable (${/** @type {Error} */ (err).message}), so values are not shown.`;
    }
  }
  return { rows: /** @type {PoolRow[]} */ (items.map((x) => buildRow(x.position, x.pool, prices, chain, pricesAt)).filter(Boolean)), prices: fresh, warning };
}


// How long ago a time was, in words.
/** @param {number} at */
function ago(at) {
  const mins = Math.round((Date.now() - at) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} days ago`;
}

// Public nodes keep about a day of logs, so what each position earned is also saved per hour (unix hour ->
// [raw token0, raw token1], as text), for the 7 and 30 day windows. Only hours the swaps read cover in full are
// saved, an hour already saved is kept, and hours older than 31 days are dropped.
const HOUR = 3600;
/**
 * @param {EarnedHours | undefined} old @param {Awaited<ReturnType<typeof poolSwaps>>} c
 * @param {{ tickLower: number, tickUpper: number, liquidity: string, fee: number }} pos @param {Clock} clock @param {number} readFrom
 */
function keepHours(old = {}, c, pos, clock, readFrom) {
  /** @type {EarnedHours} */
  const out = {};
  const oldest = Math.floor(clock.time / HOUR) - 31 * 24;
  for (const [hour, v] of Object.entries(old)) if (Number(hour) >= oldest) out[hour] = v;
  if (c.from > clock.head) return out;
  const first = Math.ceil(readFrom / HOUR);
  const last = Math.floor(clock.time / HOUR) - 1; // the last hour that has ended
  /** @type {Map<number, [bigint, bigint]>} */
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
/** @type {Set<string>} */
const aprBusy = new Set();
export const readingAprs = () => aprBusy.size > 0;

// Fee APR over the window `win`, saved in pools.json aprs. A window already being read is left to finish.
/** @param {DataStore} store @param {PositionRow[]} rows @param {string} [win] */
export async function readAprs(store, rows, win = '24h') {
  if (aprBusy.has(win) || !WINDOWS[win]) return;
  aprBusy.add(win);
  const secs = WINDOWS[win][0];
  /** @type {Record<string, AprEntry>} */
  const found = {};
  const cfg = store.get('settings').uniswap ?? {};
  /** @type {Map<number, PositionRow[]>} */
  const byChain = new Map();
  for (const r of rows.filter((x) => x.liq != null && x.pool && !x.closed)) byChain.set(r.chainId, [...(byChain.get(r.chainId) ?? []), r]);
  await Promise.all([...byChain].map(async ([chainId, rows]) => {
    // The rows are those of the chains in CHAINS (cachedRows).
    const chain = /** @type {Chain} */ (chainOf(chainId));
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
    /** @type {Map<string, PositionRow[]>} */
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
        /** @type {Record<string, EarnedHours>} */
        const kept = {};
        for (const r of list) {
          const pos = { tickLower: r.tickLower, tickUpper: r.tickUpper, liquidity: r.liq, fee: r.feePips };
          const hours = keepHours(store.get(COLLECTION)?.earned?.[r.ref], c, pos, clock, readFrom);
          kept[r.ref] = hours;
          if (!(/** @type {number} */ (r.value) > 0) || r.p0 == null || r.p1 == null) continue;
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
          // value, p0 and p1 were checked above.
          /** @param {bigint} a @param {bigint} b */
          const usd = (a, b) => (Number(a) / 10 ** r.dec0) * /** @type {number} */ (r.p0) + (Number(b) / 10 ** r.dec1) * /** @type {number} */ (r.p1);
          /** @param {number} earned @param {number} over */
          const rate = (earned, over) => (earned / /** @type {number} */ (r.value)) * (YEAR_MS / (over * 1000));
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
          found[`${win}|${r.ref}`] = {
            apr: rate(usd(e0, e1), covered),
            secs: covered,
            full: covered >= secs * 0.95,
            prev: prevCovered > 0 ? rate(usd(p0, p1), prevCovered) : null,
            prevSecs: prevCovered,
            at: Date.now(),
          };
        }
        store.update(COLLECTION, (d) => {
          d.earned = { ...d.earned, ...kept };
        });
      } catch {
        // This pool keeps the counter's APR.
      }
    }
  }));
  aprBusy.delete(win);
  // Saved together, so the page does not redraw for each pool. A window read anew replaces what it said before.
  store.update(COLLECTION, (d) => {
    const kept = Object.fromEntries(Object.entries(d.aprs ?? {}).filter(([k]) => !k.startsWith(`${win}|`)));
    d.aprs = { ...kept, ...found };
  });
}

// Collects read from the chain, three ways, each a check on the others:
// - v3, from the node: the position manager's events give the exact fees, even when liquidity was removed in an
//   earlier transaction (level 4);
// - v4, from the node: the pool manager's events find each collect, and its transaction says what it paid;
// - with an Etherscan key: each wallet's transactions to the position managers, read the same way, back to the
//   wallet's first one, however little history the node keeps.
// A collect is one transaction for one position. When two ways read it, the surer one (higher level) stays. Each
// replaces the fee counter's entry for the same collect; one the user removed is remembered in `hidden`.
// Public nodes and Etherscan limit bursts, so a chain with one node reads one position or transaction at a time.
// A chain with several nodes reads as many at once as it has nodes, each call going to the node expected to answer
// first. Etherscan is still read one transaction at a time.
const ETHERSCAN_TXS = 40; // transactions read from Etherscan per chain and load
/** @param {CollectEntry} c */
export const collectKey = (c) => (c.tx && c.ref ? `${c.ref}|${String(c.tx).toLowerCase()}` : c.id);
// Entries from the v3 events came before levels, and are the surest.
/** @param {CollectEntry} c */
export const levelOf = (c) => c.level ?? (c.source === 'chain' ? 4 : 0);

// Whether a reading of a collect would add to the log: new, or surer than the one kept, and not removed.
/** @param {DataStore} store @param {string} ref @param {string} tx @param {number} level */
function wanted(store, ref, tx, level) {
  const d = store.get(COLLECTION) ?? {};
  const key = `${ref}|${String(tx).toLowerCase()}`;
  if ((d.hidden ?? []).includes(key)) return false;
  const have = (d.collected ?? []).find((c) => collectKey(c) === key);
  return !have || level > levelOf(have);
}

// A log entry for a reading: fees in tokens, valued at the token prices when they were collected.
/**
 * @param {Chain} chain @param {PositionRow} r @param {string} tx @param {number} time @param {number} f0 @param {number} f1
 * @param {number} level @param {string} source
 * @returns {Promise<CollectEntry>}
 */
async function collectEntry(chain, r, tx, time, f0, f1, level, source) {
  const a0 = f0 / 10 ** r.dec0;
  const a1 = f1 / 10 ** r.dec1;
  /** @type {number | null} */
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

/** @param {PoolsData} d @param {CollectEntry[]} found */
export function mergeCollects(d, found) {
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

// Fee log entries saved while a token's symbol could not be read show its address. Puts the symbol back from this
// chain's rows and the symbols read since, and rebuilds the pair name from it.
/** @param {PoolsData} d @param {{ id: number, name: string }} chain @param {PoolRow[]} [rows] */
export function fixSymbols(d, chain, rows = []) {
  /** @type {Map<string, string>} */
  const known = new Map();
  for (const r of rows) {
    if (!isAddressSymbol(r.sym0)) known.set(String(r.addr0).toLowerCase(), r.sym0);
    if (!isAddressSymbol(r.sym1)) known.set(String(r.addr1).toLowerCase(), r.sym1);
  }
  for (const [key, m] of tokenInfo) {
    const [id, addr] = key.split(':');
    if (Number(id) === chain.id && !m.guessed) known.set(addr.toLowerCase(), m.symbol);
  }
  const byRef = new Map(rows.map((r) => [r.ref, r]));
  let changed = false;
  d.collected = (d.collected ?? []).map((c) => {
    // Entries seen by the board kept no chain id or addresses before: the chain's name and the row give them.
    if ((c.chainId ?? (c.chain === chain.name ? chain.id : null)) !== chain.id) return c;
    // An entry with no ref finds no row.
    const row = byRef.get(/** @type {string} */ (c.ref));
    const addr0 = c.addr0 ?? row?.addr0;
    const addr1 = c.addr1 ?? row?.addr1;
    const s0 = isAddressSymbol(c.sym0) && addr0 ? known.get(String(addr0).toLowerCase()) : null;
    const s1 = isAddressSymbol(c.sym1) && addr1 ? known.get(String(addr1).toLowerCase()) : null;
    // An entry logged by hand keeps only the pair name: its position's row gives the symbols.
    const pairFix = !c.sym0 && row && String(c.pair ?? '').split('/').some((t) => isAddressSymbol(t.trim())) && !/0x/i.test(row.pair) ? row.pair : null;
    if (!s0 && !s1 && !pairFix) return c;
    changed = true;
    if (pairFix) return { ...c, pair: pairFix };
    const sym0 = s0 ?? c.sym0;
    const sym1 = s1 ?? c.sym1;
    return { ...c, chainId: chain.id, addr0, addr1, sym0, sym1, pair: `${sym0} / ${sym1}` };
  });
  return changed;
}

// The fee log's tokens still shown as an address once a chain is read, such as those of a position no longer
// held: their symbols are read from the node, or the token list.
/** @param {DataStore} store @param {Chain} chain @param {string} node @param {PositionRow[]} shown */
async function fixLeftSymbols(store, chain, node, shown) {
  /** @type {Set<string>} */
  const left = new Set();
  const rows = new Map(shown.map((r) => [r.ref, r]));
  for (const c of store.get(COLLECTION)?.collected ?? []) {
    if ((c.chainId ?? (c.chain === chain.name ? chain.id : null)) !== chain.id) continue;
    const row = rows.get(/** @type {string} */ (c.ref));
    const addr0 = c.addr0 ?? row?.addr0;
    const addr1 = c.addr1 ?? row?.addr1;
    if (isAddressSymbol(c.sym0) && addr0) left.add(addr0);
    if (isAddressSymbol(c.sym1) && addr1) left.add(addr1);
  }
  const ask = [...left].filter((a) => !tokenInfo.has(tokenKey(chain, a)) || /** @type {TokenInfo} */ (tokenInfo.get(tokenKey(chain, a))).guessed);
  if (!left.size) return;
  await Promise.all(ask.map(async (a) => tokenInfo.set(tokenKey(chain, a), await tokenMeta(node, a, chain))));
  const d = structuredClone(store.get(COLLECTION) ?? {});
  if (fixSymbols(d, chain, shown.filter((r) => r.chainId === chain.id))) store.update(COLLECTION, (x) => { x.collected = d.collected; });
}

// What a row needs for reading its collect transactions.
/** @param {PositionRow} r */
const posOf = (r) => ({ version: r.version, tokenId: r.tokenId, owner: r.wallet, token0: r.addr0, token1: r.addr1 });

// What each chain's search is doing right now, for the page that runs it: say(chainId, text, lane). The runners
// pass none.
/** @type {Say} */
let tell = () => {};
/** @type {Map<number, Clock>} */
const clocks = new Map(); // chainId -> the chain's clock, to put dates on the block ranges searched

// Runs fn on every item, at most `width` at a time.
/**
 * @template T
 * @param {T[]} items @param {number} width @param {(item: T, i: number) => Promise<void>} fn
 */
async function eachLimit(items, width, fn) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(width, items.length)) }, worker));
}

// A block range as dates, from the chain's clock, with the blocks. Dates are estimated from the block time, so a
// short range shows the hour too.
/** @param {number} chainId @param {number} from @param {number} to */
function blockSpan(chainId, from, to) {
  const blocks = `blocks ${from.toLocaleString()}–${to.toLocaleString()}`;
  const clock = clocks.get(chainId);
  if (!clock) return blocks;
  /** @param {number} b */
  const at = (b) => new Date((clock.time - (clock.head - b) * clock.perBlock) * 1000);
  const a = at(from);
  const b = at(to);
  /** @type {Intl.DateTimeFormatOptions} */
  // @ts-expect-error Date minus Date is their distance in ms, which TypeScript does not allow
  const opts = b - a < 2 * DAY_MS ? { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' } : { month: 'short', day: 'numeric', year: 'numeric' };
  return `${a.toLocaleString(undefined, opts)} – ${b.toLocaleString(undefined, opts)} (${blocks})`;
}

// One position's collects from the node. step names it among the chain's positions ("2 of 7"). lanes: how many
// block ranges or transactions it reads at once.
/** @param {DataStore} store @param {Chain} chain @param {string} node @param {PositionRow} r @param {string} step @param {number} [lanes] */
async function nodeCollects(store, chain, node, r, step, lanes = 1) {
  const label = `Position ${step}: ${r.pair} #${r.tokenId} (${r.version})`;
  /** @param {string} text */
  const say = (text) => tell(chain.id, text, r.ref);
  const prev = store.get(COLLECTION)?.history?.[r.ref];
  say(`${label} · reading new blocks`);
  const s = await positionHistory(chain, node, { version: r.version, tokenId: r.tokenId, liquidity: r.liq, pool: r.pool }, prev,
    ({ dir, from, to }) => say(`${label} · ${dir === 'new' ? 'new blocks' : 'searching back'}, ${blockSpan(chain.id, from, to)}`), lanes);
  /** @type {CollectEntry[]} */
  const found = [];
  if (r.version === 'v3') {
    for (const e of collectFees(s.events)) {
      if (!e.time || (e.f0 === 0n && e.f1 === 0n) || !wanted(store, r.ref, e.tx, 4)) continue;
      found.push(await collectEntry(chain, r, e.tx, e.time, Number(e.f0), Number(e.f1), 4, 'chain'));
    }
  } else {
    // Transactions read before and found to collect nothing are not read again.
    const checked = new Set(nodeKey(prev?.node) === nodeKey(node) ? /** @type {PositionHistory} */ (prev).checked ?? [] : []);
    const txs = [...new Map(s.events.filter((e) => e.kind !== 'add' && e.time).map((e) => /** @type {[string, number]} */ ([e.tx, e.time])))]
      .filter(([tx]) => !checked.has(tx) && wanted(store, r.ref, tx, 3));
    let read = 0;
    await eachLimit(txs, lanes, async ([tx, time]) => {
      say(`${label} · reading what transaction ${++read} of ${txs.length} collected (${new Date(time * 1000).toLocaleString()})`);
      const res = await collectTx(chain, nodeSource(node), node, tx, posOf(r));
      if (!res || res.level > 1) checked.add(tx);
      if (res && (res.f0 > 0 || res.f1 > 0) && wanted(store, r.ref, tx, res.level)) found.push(await collectEntry(chain, r, tx, time, res.f0, res.f1, res.level, 'chain'));
    });
    s.checked = [...checked];
  }
  store.update(COLLECTION, (d) => {
    d.history = { ...d.history, [r.ref]: s };
    if (found.length) mergeCollects(d, found);
  });
}

// One chain's collects from each wallet's transactions on Etherscan, from where the last load got to. Only
// positions the board shows are logged: a burned position no longer says what its tokens are.
/**
 * @param {DataStore} store @param {Chain} chain @param {string} node @param {string} key @param {string[]} wallets
 * @param {PositionRow[]} rows
 */
async function etherscanCollects(store, chain, node, key, wallets, rows) {
  const src = etherscanSource(key, chain.id);
  const byRef = new Map(rows.map((r) => [r.ref, r]));
  let budget = ETHERSCAN_TXS;
  for (const wallet of wallets) {
    const saved = store.get(COLLECTION)?.etherscan?.[chain.id]?.[wallet] ?? { block: 0, checked: [] };
    const checked = new Set(saved.checked);
    let block = saved.block;
    /** @type {CollectEntry[]} */
    const found = [];
    let more = true;
    // cut: transactions were left for the next load. With no budget left, the last load's answer stands.
    let cut = budget <= 0 && !saved.caughtUp;
    const who = `Etherscan: wallet ${shortAddress(wallet)}`;
    while (more && budget > 0) {
      const start = block;
      tell(chain.id, `${who} · listing its position transactions from block ${start.toLocaleString()}`);
      const page = await walletPositionTxs(key, chain, wallet, start);
      const todo = page.txs.filter((t) => !checked.has(t.tx));
      const count = Math.min(todo.length, budget);
      for (const [i, t] of todo.entries()) {
        if (budget <= 0) {
          cut = true;
          break;
        }
        budget--;
        tell(chain.id, `${who} · reading transaction ${i + 1} of ${count} (${new Date(t.time * 1000).toLocaleString()})`);
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
/** @type {Set<number>} */
const searching = new Set();
export const searchingChains = () => [...searching];

// One search pass for collects: each position's events a step further back, then Etherscan. `only` limits it to one
// chain, for the Search further button. A chain already searching is left to finish. `say(chainId, text, lane)`
// reports what each chain is doing, null text ending a lane. Etherscan errors are saved in pools.json etherscanErrors.
/**
 * @param {DataStore} store @param {PositionRow[]} rows
 * @param {{ only?: number | null, say?: Say }} [options]
 */
export async function readHistory(store, rows, { only = null, say = () => {} } = {}) {
  tell = say;
  const cfg = store.get('settings').uniswap ?? {};
  const key = etherscanKey(store.get('settings'));
  const wallets = (cfg.wallets ?? []).filter((w) => isAddress(w.address)).map((w) => w.address.toLowerCase());
  /** @type {Map<number, PositionRow[]>} */
  const byChain = new Map();
  for (const r of rows.filter((x) => !x.staleAt && x.liq != null && (x.version === 'v3' || x.pool) && (only === null || x.chainId === only))) {
    byChain.set(r.chainId, [...(byChain.get(r.chainId) ?? []), r]);
  }
  const todo = [...byChain].filter(([chainId]) => !searching.has(chainId));
  if (!todo.length) return;
  todo.forEach(([chainId]) => searching.add(chainId));
  await Promise.all(todo.map(async ([chainId, list]) => {
    // The rows are those of the chains in CHAINS (cachedRows).
    const chain = /** @type {Chain} */ (chainOf(chainId));
    const { node } = chainSettings(cfg, chain);
    try {
      try {
        clocks.set(chainId, await chainClock(node));
      } catch {
        // Without the clock, the ranges are said in blocks only.
      }
      // One lane per node: positions read side by side, and when there are fewer positions than nodes, each one
      // searches several block ranges at once.
      const nodes = nodeUrls(node).length;
      const side = Math.max(1, Math.min(nodes, list.length));
      const lanes = Math.max(1, Math.floor(nodes / side));
      await eachLimit(list, side, async (r, i) => {
        try {
          await nodeCollects(store, chain, node, r, `${i + 1} of ${list.length}`, lanes);
        } catch {
          // This position keeps the other readings until its history can be read.
        } finally {
          tell(chainId, null, r.ref);
        }
      });
      if (!key || chain.etherscan === false) return;
      /** @type {string | null} */
      let error = null;
      try {
        await etherscanCollects(store, chain, node, key, wallets, list);
      } catch (err) {
        error = /** @type {Error} */ (err).message;
      }
      store.save(COLLECTION, (d) => {
        const errors = { ...d.etherscanErrors };
        if (error) errors[chain.name] = error;
        else delete errors[chain.name];
        d.etherscanErrors = errors;
      });
    } finally {
      searching.delete(chainId);
      tell(chainId, null, '*');
    }
  }));
}

// Rows saved by the last read, for the wallets and chains still chosen. JSON has no Infinity, so an open-ended range
// comes back as null and is restored here. A row of a part the last read could not read is marked with staleAt.
/** @param {Chain[]} chains */
export const cacheKeys = (chains) => chains.flatMap((c) => (c.v4 ? [`${c.id}:v3`, `${c.id}:v4`] : [`${c.id}:v3`]));
/** @param {Partial<UniswapSettings>} cfg */
export const enabledChains = (cfg) => CHAINS.filter((chain) => chainSettings(cfg, chain).enabled);

/**
 * @param {DataStore} store @param {Partial<UniswapSettings>} [cfg] @param {string[]} [keys]
 * @returns {PositionRow[]}
 */
export function cachedRows(store, cfg = store.get('settings').uniswap ?? {}, keys = cacheKeys(enabledChains(cfg))) {
  const d = store.get(COLLECTION) ?? {};
  const cache = d.cache ?? {};
  const stale = d.read?.stale ?? {};
  const wallets = new Set((cfg.wallets ?? []).map((w) => w.address.toLowerCase()));
  const manual = new Set(addedPositions(cfg).map((x) => refOf(x.version, x.chainId, x.tokenId)));
  return keys.flatMap((key) => (cache[key]?.rows ?? [])
    .filter((r) => wallets.has(r.wallet) || manual.has(r.ref))
    .map((r) => ({ ...r, max: r.max ?? Infinity, staleAt: stale[key] ?? null })));
}

// A symbol saved as an address while it could not be read, from another row of the same token that has it.
/** @param {PositionRow[]} rows @param {number} chainId @param {string} sym @param {string} addr */
function symbolFrom(rows, chainId, sym, addr) {
  if (!isAddressSymbol(sym) || !addr) return sym;
  const a = String(addr).toLowerCase();
  for (const r of rows) {
    if (r.chainId !== chainId) continue;
    if (String(r.addr0).toLowerCase() === a && !isAddressSymbol(r.sym0)) return r.sym0;
    if (String(r.addr1).toLowerCase() === a && !isAddressSymbol(r.sym1)) return r.sym1;
  }
  return sym;
}

// Open positions as of the last saved read, for Home and Cron. Nothing is read from a chain here.
/** @param {DataStore} store */
export function openPositions(store) {
  const rows = cachedRows(store);
  return rows
    .map((r) => {
      const sym0 = symbolFrom(rows, r.chainId, r.sym0, r.addr0);
      const sym1 = symbolFrom(rows, r.chainId, r.sym1, r.addr1);
      return { ...r, sym0, sym1, pair: `${sym0} / ${sym1}` };
    })
    .filter((r) => !r.closed);
}

let reading = false;
export const readingPositions = () => reading;

// Reads every enabled chain in parallel, and v3 and v4 side by side on each, and saves each part as it lands. A part
// that fails keeps its last good read, marked stale. Returns the rows read, or null when a read is already running.
/** @param {DataStore} store */
export async function readAllPositions(store) {
  if (reading) return null;
  reading = true;
  try {
    const cfg = store.get('settings').uniswap ?? {};
    const wallets = (cfg.wallets ?? []).filter((w) => isAddress(w.address));
    const chains = CHAINS.map((chain) => ({ chain, ...chainSettings(cfg, chain) })).filter((c) => c.enabled);
    const saved = store.get(COLLECTION) ?? {};
    const shallow = new Set(saved.read?.shallow ?? []);
    /** @param {(r: Partial<PositionsReadState>) => Partial<PositionsReadState>} patch */
    const setRead = (patch) => store.update(COLLECTION, (d) => {
      d.read = { warnings: {}, stale: {}, shallow: [], pending: [], ...d.read, ...patch(d.read ?? {}) };
    });
    setRead(() => ({ pending: chains.map((c) => c.chain.name) }));

    await Promise.all(chains.map(async ({ chain, node }) => {
      const savedPrices = saved.prices?.[chain.id];
      /** @param {string} version @param {() => Promise<{ items: PositionRead[], scans?: Record<string, V4Scan> }>} read */
      const part = async (version, read) => {
        const key = `${chain.id}:${version}`;
        try {
          const got = await read();
          const done = await toRows(chain, node, got.items, savedPrices);
          if (got.scans) {
            const short = Object.values(got.scans).some((x) => x?.done && x.from > /** @type {NonNullable<Chain['v4']>} */ (chain.v4).start);
            if (short) shallow.add(chain.name);
            else shallow.delete(chain.name);
          }
          // Saved as each part lands, so a reload mid-read keeps what was already read.
          store.update(COLLECTION, (d) => {
            // A collect already read from the chain is not logged again from the fee counter.
            const found = collectsOf(d.cache?.[key], done.rows, Date.now())
              .filter((f) => !(d.collected ?? []).some((c) => c.tx && c.ref === f.ref && coversCollect(f, Date.parse(c.at))));
            if (found.length) d.collected = [...(d.collected ?? []), ...found];
            fixSymbols(d, chain, done.rows);
            d.cache = { ...d.cache, [key]: { at: Date.now(), rows: done.rows } };
            d.fees = nextBaselines(d.fees, done.rows, Date.now());
            if (done.prices) d.prices = { ...d.prices, [chain.id]: { at: Date.now(), usd: { ...d.prices?.[chain.id]?.usd, ...done.prices } } };
            // Keep how far each v4 search got, so the next read goes on from there.
            if (got.scans) d.scan = { ...d.scan, [chain.id]: got.scans };
            const { [key]: _, ...stale } = d.read?.stale ?? {};
            // setRead() filled read before the chains were read.
            d.read = { .../** @type {PositionsReadState} */ (d.read), stale, shallow: [...shallow], warnings: { ...d.read?.warnings, [key]: done.warning } };
          });
        } catch (err) {
          const at = saved.cache?.[key]?.at;
          setRead((r) => ({
            warnings: { ...r.warnings, [key]: `${chain.name} ${version} positions could not be read: ${/** @type {Error} */ (err).message}` },
            stale: at ? { ...r.stale, [key]: at } : r.stale,
          }));
        }
      };
      await Promise.all([
        part('v3', () => readV3(chain, node, wallets, cfg)),
        chain.v4 ? part('v4', () => readV4(chain, node, wallets, cfg, saved.scan?.[chain.id] ?? {})) : null,
      ]);
      await fixLeftSymbols(store, chain, node, cachedRows(store, cfg));
      setRead((r) => ({ pending: (r.pending ?? []).filter((name) => name !== chain.name) }));
    }));
    // Parts of chains no longer read leave no warning behind.
    const keys = new Set(cacheKeys(chains.map((c) => c.chain)));
    setRead((r) => ({
      at: Date.now(),
      pending: [],
      warnings: Object.fromEntries(Object.entries(r.warnings ?? {}).filter(([k, v]) => keys.has(k) && v)),
      stale: Object.fromEntries(Object.entries(r.stale ?? {}).filter(([k]) => keys.has(k))),
    }));
    const rows = cachedRows(store, cfg);
    // Tell the automation rules and the notifications which positions left their range. Old rows are left out.
    poolsChanged(store, rows.filter((r) => !r.staleAt && !r.closed));
    return rows;
  } finally {
    reading = false;
  }
}
