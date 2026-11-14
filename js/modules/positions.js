import { h, icon, refreshIcon, money, empty, notice, noticePills, uid, todayISO, copyable, CURRENCIES } from '../ui.js';
import { knownRate, fetchDayRate } from '../fx.js';
import { barChart, lineChart, legend } from '../chart.js';
import { toast } from '../toast.js';
import { setupBanner } from '../integrations.js';
import { positionFields, positionError } from '../position-input.js';
import { insightsPanel } from '../pool-insights.js';
import { WINDOWS, refOf, shortAddress, baselineOf, coversCollect, collectKey, levelOf, mergeCollects, cachedRows, enabledChains, openPositions, knownTokens } from '../defi/positions-read.js';
import { runJob, jobState } from '../runners.js';
import { readPositions, poolState, tokenMeta, isAddressSymbol, usdPrices, positionAmounts, priceAtTick, isAddress, CHAINS, chainSettings, tokenLogos, tokenList, scanV4, readV4Position, readV3Position, addedPositions, parsePosition, addPosition, chainClock, poolSwaps, swapFees, swapEarn, isClosed, positionHistory, collectFees, usdPricesAt, nodeSource, etherscanSource, collectTx, positionsInReceipt, walletPositionTxs, nodeKey, nodeUrls, dexName, dexLogo, scanKey } from '../uniswap.js';
import { chainById, explorerUrl, etherscanKey } from '../chains.js';
import { walletsTab, walletsView } from './defi-wallets.js';
import { lendingTab, lendingView } from './defi-lending.js';
import { summaryTab } from './defi-summary.js';
import { dateLocale, numberLocale } from '../locale.js';
/** @import { Store, PoolsData, CollectEntry, FeeBaseline, IconName } from '../../types/data' */
/** @import { PositionRow, DefiUi, DefiTab, DefiNotice, LpSummary } from '../../types/defi' */
/** @import { Child } from '../../types/ui' */
/**
 * A row with its fee APR over the chosen window (aprOf): from swaps (aprSecs, aprFull, aprPrev), else from the
 * counter (aprLeft), and its movement from the window before.
 * @typedef {PositionRow & { apr?: number | null, aprLeft?: number | null, aprSecs?: number, aprFull?: boolean, aprPrev?: number | null, move?: number | null }} Row
 * @typedef {{ min: number, max: number, current: number, marker: number | null, unit: string, base: string }} Side
 * @typedef {string | number | bigint} Sortable
 * @typedef {NonNullable<ReturnType<typeof parsePosition>>} Entry
 * @typedef {HTMLFormElement & { elements: { position: HTMLInputElement, chain: HTMLSelectElement, version: HTMLSelectElement } }} AddForm
 * @typedef {{ value: string, label: string, count: number, logo: string | null }} PickerOption
 * @typedef {(label: string, value: Child, hint?: string | null) => HTMLElement} Stat
 * @typedef {{ key: string | null, label: string, usd: number, n: number, sample?: CollectEntry, amount?: number | null }} FeeGroup
 * @typedef {{ list: CollectEntry[], pool: CollectEntry[], start: number, end: number, from: number | null, to: number | null, perDay: number, spanDays: number, nowMs: number, stat: Stat, group: string }} FeeCtx
 */
/**
 * @typedef {object} View
 * @property {string} currency
 * @property {string} filter
 * @property {number | 'all'} chain
 * @property {string} layout
 * @property {string} sort
 * @property {number} dir
 * @property {boolean} adding
 * @property {string} window
 * @property {string} feeSort
 * @property {number} feeDir
 * @property {string} feeChain
 * @property {string} feeToken
 * @property {string} feeSource
 * @property {string} dex
 * @property {string} version
 * @property {string} feeDex
 * @property {string} feeVersion
 * @property {boolean} coverageOpen
 * @property {string} tab
 * @property {string | null} detail
 * @property {string} detailFrom
 * @property {boolean} feeAuto
 * @property {string} feeRange
 * @property {string} feeGroup
 * @property {string} [feeSplit]
 * @property {boolean} [logging]
 * @property {string} [logMessage]
 */

const YEAR_MS = 365 * 24 * 60 * 60 * 1000;
// The fee counter, used where swaps cannot be read, needs some time between two reads, or a few cents of fees
// turn into a wild yearly rate.
const APR_MIN_MS = 60 * 60 * 1000;

// View state: which rows are shown.
// layout: 'cards' or 'list'. sort: one of the SORTS keys; dir: 1 low to high, -1 high to low.
// adding: the form to add a position by hand is open.
// window: the WINDOWS key fee APR is read over.
// dex, version: the exchange and version picked on LP positions; feeDex, feeVersion the same on Fees collected.
// feeSort, feeDir: the Fees collected table's sort. feeChain, feeToken, feeSource: its filters.
// currency: what amounts are shown in. They are read in USD.
// The tab, detail and fee range fields are set by restore(), which runs before the first draw.
const view = /** @type {View} */ ({ currency: 'USD', filter: 'all', chain: 'all', layout: 'cards', sort: 'value', dir: -1, adding: false, window: '24h', feeSort: 'date', feeDir: -1, feeChain: 'all', feeToken: 'all', feeSource: 'all', dex: 'all', version: 'all', feeDex: 'all', feeVersion: 'all', coverageOpen: false });
// The reads run in js/defi/positions-read.js and save all they find in pools.json; the page draws that file.
// loading: a read this tab started is running. error: why it failed.
const COLLECTION = 'pools';
let loading = false;
let readAgain = false; // a position was added during a read, so read once more when it ends
let loadError = '';
let askedAt = 0; // when this tab last started a read, so a stale page asks once, not on every redraw
/** @type {Store | null} */
let bound = null; // the store of the page drawn last, for the state below
// The collect search runs in the runners; it is running while their job is, or while this tab waits on it.
const historyRunning = () => historyAsking || Boolean(jobState('defi-history')?.running);
/** @type {{ has: (chainId: number) => boolean, readonly size: number }} */
const searching = { has: () => historyRunning(), get size() { return historyRunning() ? 1 : 0; } };
const aprBusy = () => aprAsking;

// The last read as the page shows it: rows from pools.json, and the read's state.
/** @returns {Partial<NonNullable<PoolsData['read']>>} */
const readOf = () => bound?.get(COLLECTION)?.read ?? {};
/** @type {PositionRow[] | null} */
let memo = null;
/** @type {PositionRow[]} */
let symbolRows = []; // the rows knownSymbol looks symbols up in
/** @param {Store} store */
function shownRows(store) {
  if (memo) return memo;
  const cfg = store.get('settings').uniswap ?? {};
  symbolRows = cachedRows(store, cfg);
  memo = symbolRows
    .map((r) => {
      // A symbol saved as an address while it could not be read is looked up again.
      const sym0 = knownSymbol(r.chainId, r.sym0, r.addr0);
      const sym1 = knownSymbol(r.chainId, r.sym1, r.addr1);
      return { ...r, sym0, sym1, pair: `${sym0} / ${sym1}` };
    })
    .sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
  // Worked out once per redraw: everything a redraw reads runs in the same task.
  queueMicrotask(() => {
    memo = null;
  });
  return memo;
}
const state = {
  get rows() {
    return bound ? shownRows(bound) : [];
  },
  get status() {
    return loading ? 'loading' : loadError ? 'error' : readOf().at ? 'ok' : 'idle';
  },
  get error() {
    return loadError;
  },
  get at() {
    return readOf().at ?? 0;
  },
  get warning() {
    return Object.values(readOf().warnings ?? {}).filter(Boolean).join(' ');
  },
  // Chains shown from an earlier read because the last one failed, with when that read was.
  get stale() {
    /** @type {Map<string, number>} */
    const byChain = new Map();
    for (const [key, at] of Object.entries(readOf().stale ?? {})) {
      const name = chainOf(Number(key.split(':')[0]))?.name;
      if (name) byChain.set(name, Math.min(byChain.get(name) ?? Infinity, at));
    }
    return [...byChain].map(([name, at]) => ({ name, at }));
  },
  get shallow() {
    return readOf().shallow ?? [];
  },
  get pending() {
    return loading || jobState('defi-positions')?.running ? readOf().pending ?? [] : [];
  },
};
/** @type {Map<string, string>} */
let logoMap = new Map(); // "chainId:token address" -> logo URL, from the token list
let logosAsked = false;
/** @type {Map<string, string>} */
let listedSyms = new Map(); // "chainId:token address" and "chainId:short address" -> symbol, from the token list
/** @type {Set<string>} */
const seen = new Set(); // rows already on screen: only new ones animate in
/** @type {Record<'value' | 'fees', number>} */
const shownTotals = { value: 0, fees: 0 }; // the totals on screen, so a change counts from there

// Time left before the counter shows a fee APR, or null when it has no baseline yet.
/** @param {PositionRow} r @param {Record<string, FeeBaseline>} baselines */
function counterLeft(r, baselines) {
  const b = baselineOf(baselines, r);
  return b ? Math.max(0, b.at + APR_MIN_MS - Date.now()) : null;
}

// Yearly fee rate from the fees earned since the baseline, at today's prices. null until enough time has passed.
/** @param {PositionRow} r @param {Record<string, FeeBaseline>} baselines */
function feeApr(r, baselines) {
  const b = baselineOf(baselines, r);
  const elapsed = Date.now() - (b?.at ?? Date.now());
  // null > 0 is false, so a row with no value stops here.
  if (!b || elapsed < APR_MIN_MS || !(/** @type {number} */ (r.value) > 0) || r.p0 == null || r.p1 == null || typeof r.fee0 !== 'number') return null;
  const earned = Math.max(0, r.fee0 - b.f0) * r.p0 + Math.max(0, r.fee1 - b.f1) * r.p1;
  return (earned / /** @type {number} */ (r.value)) * (YEAR_MS / elapsed);
}

// How safely a position sits in its range: full range first, then the room to the nearer edge, out of range last.
/** @param {Row} r */
const rangeRoom = (r) => (r.full ? 101 : !r.inRange ? -1 : r.marker === null ? 0 : Math.min(r.marker, 100 - r.marker));

// What each sort reads from a row, and the direction it starts in. Position numbers only grow, so a higher
// number is a newer position on the same contract.
/** @type {Record<string, { value: (r: Row) => Sortable | null | undefined, dir: number }>} */
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
/** @type {[string, number, string][]} */
const PRESETS = [['value', -1, 'Value'], ['fees', -1, 'Unclaimed fees'], ['apr', -1, 'Fee APR'], ['move', -1, 'Movement'], ['number', -1, 'Newest'], ['number', 1, 'Oldest']];
/** @type {Record<string, string>} */
const SORT_NAMES = { pool: 'Pool', chain: 'Chain', range: 'Price range', split: 'Distribution', move: 'Movement', value: 'Value', fees: 'Unclaimed fees', apr: 'Fee APR', number: 'Number' };

// Rows without the value sorted on go last, whatever the direction. Ties fall back to the newest first.
/** @param {Row[]} rows @param {string} key @param {number} dir */
function sortRows(rows, key, dir) {
  const read = SORTS[key].value;
  // Both values come from the same sort, so they are of one kind.
  /** @param {Sortable} a @param {Sortable} b */
  const cmp = (a, b) => (typeof a === 'string' ? a.localeCompare(/** @type {string} */ (b)) : a < /** @type {number | bigint} */ (b) ? -1 : a > /** @type {number | bigint} */ (b) ? 1 : 0);
  const newest = SORTS.number.value;
  return rows.sort((x, y) => {
    const a = read(x);
    const b = read(y);
    const missing = (a == null ? 1 : 0) - (b == null ? 1 : 0);
    if (missing) return missing;
    // Here b is set too: a missing one returned above.
    return (a == null ? 0 : dir * cmp(a, /** @type {Sortable} */ (b))) || cmp(/** @type {bigint} */ (newest(y)), /** @type {bigint} */ (newest(x)));
  });
}

// A table header that sorts by its column; a second click flips the direction.
/** @param {Store} store @param {string} key @param {string} label @param {Record<string, string>} [attrs] */
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

// How long ago a time was, in words.
/** @param {number} at */
function ago(at) {
  const mins = Math.round((Date.now() - at) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} days ago`;
}

// Open positions as of the last saved read, for Home. Nothing is read from a chain here.
export { openPositions };
/** @param {Store} store */
export const outOfRange = (store) => openPositions(store).filter((r) => !r.inRange);

// The runners read the chains (tools/jobs/defi.js) every few minutes and save what they find in pools.json; the page
// only draws it. Refresh, a new APR window and Search further ask them to read now.
// again: a read already running reads once more when it ends, as it took the settings before the change.
/** @param {Store} store @param {{ again?: boolean }} [options] */
async function load(store, { again = false } = {}) {
  if (loading) {
    if (again) readAgain = true;
    return;
  }
  loading = true;
  loadError = '';
  askedAt = Date.now();
  store.refresh();
  try {
    await runJob('defi-positions', { window: view.window });
    await store.sync();
  } catch (err) {
    loadError = /** @type {Error} */ (err).message;
  } finally {
    loading = false;
    store.refresh();
  }
  if (readAgain) {
    readAgain = false;
    return load(store);
  }
}

let aprAsking = false;
// Fee APR over the chosen window. The window is saved, so the runners keep reading it.
/** @param {Store} store */
function loadAprs(store) {
  if (store.get(COLLECTION).aprWindow !== view.window) store.update(COLLECTION, (d) => { d.aprWindow = view.window; });
  if (aprAsking || store.get(COLLECTION).aprs && Object.keys(/** @type {object} */ (store.get(COLLECTION).aprs)).some((k) => k.startsWith(`${view.window}|`))) return;
  aprAsking = true;
  runJob('defi-positions', { window: view.window, aprOnly: true })
    .then(() => store.sync())
    .catch(() => {})
    .finally(() => {
      aprAsking = false;
      store.refresh();
    });
  store.refresh();
}

let historyAsking = false;
// One search pass for collects, or of one chain (`only`, the Search further button), in the runners.
/** @param {Store} store @param {number | null} [only] */
function loadHistory(store, only = null) {
  if (historyAsking) return;
  historyAsking = true;
  runJob('defi-history', only === null ? {} : { chainId: only })
    .then(() => store.sync())
    .catch((err) => toast(/** @type {Error} */ (err).message))
    .finally(() => {
      historyAsking = false;
      store.refresh();
    });
  store.refresh();
}

// How far the search for collects has got, per position, from 0 to 1. A position is covered in full once its
// event search reached its opening, or once Etherscan read every transaction of its wallet. Until then, the
// share of blocks searched back toward the earliest block it could have opened at (v4's start, or for v3 the
// chain's first block, so a v3 search that has not found its opening reads low).
/** @param {PositionRow} r @param {Partial<PoolsData>} d @param {string} key */
function searchShare(r, d, key) {
  const ether = key && chainOf(r.chainId)?.etherscan !== false;
  if (ether && d.etherscan?.[scanKey({ id: r.chainId, dex: r.dex })]?.[r.wallet]?.caughtUp) return 1;
  const s = d.history?.[r.ref];
  if (!s) return 0;
  const floor = s.floor ?? (r.version === 'v4' ? chainOf(r.chainId)?.v4?.start ?? 0 : 0);
  if (s.reached || s.from <= floor) return 1;
  const head = s.to;
  if (!(head > floor)) return 0;
  return Math.min(1, Math.max(0, (head - s.from + 1) / (head - floor + 1)));
}

// The search coverage of every position shown, open and closed: per chain and for all of them.
/** @param {Store} store */
function collectCoverage(store) {
  const d = store.get(COLLECTION) ?? {};
  /** @type {Map<string, { name: string, chainId: number, sum: number, done: number, total: number }>} */
  const chains = new Map();
  for (const r of state.rows) {
    if (r.version === 'v2') continue; // nothing is collected from a v2 pair
    const c = chains.get(r.chain) ?? { name: r.chain, chainId: r.chainId, sum: 0, done: 0, total: 0 };
    const share = searchShare(r, d, etherscanKey(store.get('settings')));
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
/** @param {Store} store */
function askLogos(store) {
  if (logosAsked) return;
  logosAsked = true;
  Promise.all([tokenLogos(), tokenList()]).then(([map, tokens]) => {
    logoMap = map;
    listedSyms = new Map(tokens.filter((t) => t.symbol).flatMap((t) => [
      [`${t.chainId}:${t.address.toLowerCase()}`, t.symbol],
      [`${t.chainId}:${shortAddress(t.address).toLowerCase()}`, t.symbol],
    ]));
    store.refresh();
  });
}

// The symbol of a token saved as its short address, from the rows read, the symbols read since, or the token list.
// An entry that kept no address is matched by its short address.
/**
 * @template {string | undefined} S
 * @param {number | undefined} chainId @param {S} sym @param {string | null | undefined} addr
 * @returns {S | string}
 */
function knownSymbol(chainId, sym, addr) {
  if (!isAddressSymbol(sym)) return sym;
  const keys = [addr && String(addr).toLowerCase(), String(sym).toLowerCase()].filter(Boolean);
  for (const k of keys) {
    for (const r of symbolRows) {
      if (r.chainId !== chainId) continue;
      const a0 = String(r.addr0).toLowerCase();
      const a1 = String(r.addr1).toLowerCase();
      if ((k === a0 || k === shortAddress(a0)) && !isAddressSymbol(r.sym0)) return r.sym0;
      if ((k === a1 || k === shortAddress(a1)) && !isAddressSymbol(r.sym1)) return r.sym1;
    }
    for (const [key, m] of knownTokens()) {
      const [id, a] = key.split(':');
      const low = a.toLowerCase();
      if (Number(id) === chainId && !m.guessed && (k === low || k === shortAddress(low))) return m.symbol;
    }
    const listed = listedSyms.get(`${chainId}:${k}`);
    if (listed) return listed;
  }
  return sym;
}

// A fee log entry as shown: tokens saved as an address while their symbol could not be read get their symbol.
/** @param {CollectEntry} c @returns {CollectEntry} */
function named(c) {
  const chainId = c.chainId ?? CHAINS.find((x) => x.name === c.chain)?.id;
  const row = c.ref ? state.rows.find((r) => r.ref === c.ref) : null;
  if (c.sym0 || c.sym1) {
    const sym0 = knownSymbol(chainId, c.sym0, c.addr0 ?? row?.addr0);
    const sym1 = knownSymbol(chainId, c.sym1, c.addr1 ?? row?.addr1);
    return sym0 === c.sym0 && sym1 === c.sym1 ? c : { ...c, sym0, sym1, pair: `${sym0} / ${sym1}` };
  }
  // An entry logged by hand keeps only the pair name.
  const parts = String(c.pair ?? '').split('/').map((t) => t.trim());
  if (parts.length !== 2 || !parts.some(isAddressSymbol)) return c;
  const pair = parts.map((t, i) => knownSymbol(chainId, t, row?.[i ? 'addr1' : 'addr0'])).join(' / ');
  return pair === c.pair ? c : { ...c, pair };
}

/** @param {number} n */
const amount = (n) => (n >= 1000 ? n.toLocaleString(numberLocale(), { maximumFractionDigits: 0 }) : n >= 1 ? n.toFixed(2) : n.toPrecision(4));
/** @param {number} n */
const price = (n) => (n === Infinity ? '∞' : n === 0 ? '0' : amount(n));
// Amounts are read in USD. In CAD they use today's rate, the same for every amount, and stay in USD until it is known.
const fxToday = { day: '', status: 'idle', error: '' };
const shownRate = () => (view.currency === 'CAD' ? knownRate(todayISO()) : null);
/** @param {number} n */
const cash = (n) => {
  const rate = shownRate();
  return rate ? money(n * rate, 'CAD') : money(n, 'USD');
};
/** @param {number | null} n */
const usdOrDash = (n) => (n === null ? '—' : cash(n));
// How a position is named beside its pair: its number, or for v2 its pair's address, shortened.
/** @param {{ version?: string, tokenId?: string | null }} r */
const numberOf = (r) => (r.version === 'v2' && r.tokenId ? shortAddress(r.tokenId) : `#${r.tokenId ?? '—'}`);
// v2 has no unclaimed fees: they are in the pair's reserves, so in the value.
const V2_FEES = 'Uniswap v2 adds the fees to the pool as they are paid: they are part of the value, and nothing waits to be claimed.';
// A staked position's fees, with the farm's reward it can harvest below them.
/** @param {PositionRow} r */
const unclaimed = (r) => (r.version === 'v2'
  ? h('span', { class: 'muted', title: V2_FEES }, 'In the pool')
  : r.staked
    // Its value alone fits a card; the tokens are in the tooltip.
    ? h('span', { class: 'lp-with-reward' }, usdOrDash(r.fees), h('span', { class: 'muted small', title: `${rewardText(r)}: the farm's reward, waiting to be harvested` },
        `+ ${r.rewardUsd != null ? cash(r.rewardUsd) : amount(r.reward ?? 0)} ${r.rewardSym ?? 'CAKE'}`))
    : usdOrDash(r.fees));
// The reward as tokens, and its value when the token is priced.
/** @param {PositionRow} r */
const rewardText = (r) => `${amount(r.reward ?? 0)} ${r.rewardSym ?? 'CAKE'}${r.rewardUsd != null ? ` (${cash(r.rewardUsd)})` : ''}`;
// The exchange of a row with its logo and version.
/** @param {PositionRow} r */
const platformTag = (r) => h('span', { class: 'lp-venue', title: `${dexName(r.dex)} ${r.version}` },
  logo(dexLogo(r.dex), dexName(r.dex), 'xs'), `${dexName(r.dex)} ${r.version}`);
// A leaf when the position is staked in its exchange's farm.
/** @param {PositionRow} r */
const farmTag = (r) => (r.staked
  ? h('span', { class: 'lp-farm', title: `Staked in ${dexName(r.dex)}'s farm, earning ${r.rewardSym ?? 'CAKE'}` }, icon('leaf'), 'Farming')
  : null);
// A chain with its logo, in the same quiet style.
/** @param {string} name @param {string | null | undefined} src */
const chainTag = (name, src) => h('span', { class: 'lp-venue' }, logo(src ?? null, name, 'xs'), name);
// The exchange and version with the pool's fee tier: one quiet line, a dot between them, no pills.
/** @param {PositionRow} r @param {Child} [more] */
const venueLine = (r, more = null) => h('div', { class: 'pool-meta' },
  platformTag(r),
  h('span', { class: 'lp-venue', title: 'The pool\'s fee tier' }, `${r.feePct}% fee`),
  more);

// The exchange and version of a collect, read from its position's ref (see refOf in js/defi/positions-read.js).
// A ref of two parts is Uniswap v3; else its second part is "v2", "v4" or "pancakeswap-v3". null when unknown.
/** @param {string | undefined} ref @returns {{ dex: string, version: string } | null} */
function kindOfRef(ref) {
  const parts = String(ref ?? '').split(':');
  if (parts.length === 2 && parts[0] && parts[1]) return { dex: 'uniswap', version: 'v3' };
  const m = /^(?:(.+)-)?(v\d+)$/.exec(parts[1] ?? '');
  return m ? { dex: m[1] ?? 'uniswap', version: m[2] } : null;
}
/** @param {{ dex?: string }} r */
const dexOf = (r) => r.dex || 'uniswap';
// The exchanges or versions found in a list, sorted, for the filter pills.
/** @param {(string | null | undefined)[]} keys @returns {string[]} */
const kindsIn = (keys) => [...new Set(/** @type {string[]} */ (keys.filter(Boolean)))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
// A row of pills picking one exchange or one version, with a count each. Hidden when there is only one choice.
/** @param {string[]} keys @param {string} current @param {(key: string) => string} label @param {(key: string) => number} count @param {number} total @param {string} allLabel @param {(key: string) => void} pick */
function kindPills(keys, current, label, count, total, allLabel, pick) {
  if (keys.length < 2) return null;
  /** @param {string} key @param {string} text @param {number} n */
  const pill = (key, text, n) => h('button', {
    type: 'button',
    class: current === key ? 'lp-chip active' : 'lp-chip',
    'aria-pressed': String(current === key),
    onclick: () => pick(key),
  }, label === dexName && key !== 'all' ? logo(dexLogo(key), text, 'xs') : null, text, h('span', { class: 'chip-count' }, n));
  return h('div', { class: 'row lp-filters lp-chains' }, pill('all', allLabel, total), keys.map((k) => pill(k, label(k), count(k))));
}
// The exchange and version pickers side by side on one row, when either shows.
/** @param {(HTMLElement | null)[]} groups */
const kindRow = (groups) => (groups.some(Boolean) ? h('div', { class: 'row lp-kinds' }, groups) : null);

// Fetches today's rate once a day when CAD is picked, then draws again.
/** @param {Store} store */
function askRate(store) {
  const day = todayISO();
  if (view.currency !== 'CAD' || knownRate(day) !== null || fxToday.day === day) return;
  Object.assign(fxToday, { day, status: 'loading', error: '' });
  fetchDayRate(day)
    .then(() => Object.assign(fxToday, { status: 'ok' }))
    .catch((/** @type {Error} */ err) => Object.assign(fxToday, { status: 'error', error: err.message }))
    .finally(() => store.refresh());
}

/** @param {Store} store */
function currencySwitch(store) {
  return h('div', { class: 'segmented money-currency', role: 'group', 'aria-label': 'Show amounts in' },
    CURRENCIES.map((c) => h('button', {
      type: 'button',
      class: c === view.currency ? 'seg active' : 'seg',
      'aria-pressed': String(c === view.currency),
      onclick: () => {
        view.currency = c;
        if (c === 'CAD' && fxToday.status === 'error') fxToday.day = '';
        store.refresh();
      },
    }, c)));
}

/** @returns {DefiNotice | null} */
function rateNotice() {
  if (view.currency !== 'CAD' || shownRate()) return null;
  return fxToday.status === 'error'
    ? { text: `The USD to CAD rate could not be read, so amounts stay in USD: ${fxToday.error}` }
    : { tone: 'info', text: 'Reading today\'s USD to CAD rate. Amounts show in USD until then.' };
}

// The Fees tab's note when Etherscan could not be read on some chains.
/** @param {Store} store @returns {DefiNotice | null} */
function etherscanNotice(store) {
  const errors = /** @type {Record<string, string>} */ (store.get(COLLECTION)?.etherscanErrors ?? {});
  return Object.keys(errors).length
    ? { tone: 'info', text: `Etherscan could not be read for ${Object.entries(errors).map(([name, text]) => `${name} (${text})`).join(', ')}. Collects there come from the node only.` }
    : null;
}
// The Positions tab's note when Etherscan could not list the wallets' v2 pairs on some chains.
/** @returns {DefiNotice | null} */
function v2Notice() {
  // Chains that failed for the same reason, such as a plan that does not cover them, are named together.
  /** @type {Map<string, string[]>} */
  const byReason = new Map();
  for (const [name, text] of Object.entries(readOf().v2lookup ?? {})) byReason.set(text, [...(byReason.get(text) ?? []), name]);
  return byReason.size
    ? { tone: 'info', text: `Etherscan could not list your wallets' Uniswap v2 pairs on ${[...byReason].map(([text, names]) => `${names.join(', ')} (${text})`).join('; ')}. A v2 pair there is read once you add it with Add position.` }
    : null;
}
/** @param {number} n */
const pct = (n) => `${(n * 100).toFixed(n < 0.1 ? 2 : 1)}%`;
/** @param {number} secs */
const span = (secs) => (secs >= 2 * 86400 ? `${(secs / 86400).toFixed(1)} days` : secs >= 2 * 3600 ? `${(secs / 3600).toFixed(1)} hours` : `${Math.round(secs / 60)} min`);
// A row with its fee APR over the chosen window, and its movement from the window before when both cover at
// least half of it. From the counter where swaps could not be read, which has no movement.
/**
 * @param {Store} store
 * @returns {(r: PositionRow) => Row}
 */
function aprOf(store) {
  const baselines = store.get(COLLECTION)?.fees ?? {};
  const secs = WINDOWS[view.window][0];
  return (r) => {
    const s = store.get(COLLECTION)?.aprs?.[`${view.window}|${r.ref}`];
    if (!s) return { ...r, apr: feeApr(r, baselines), aprLeft: counterLeft(r, baselines), move: null };
    const move = s.prev != null && s.prevSecs >= secs / 2 && s.secs >= secs / 2 ? s.apr - s.prev : null;
    return { ...r, apr: s.apr, aprSecs: s.secs, aprFull: s.full, aprPrev: s.prev, move };
  };
}

// The APR's movement in percentage points, with an arrow.
/** @param {Row} r */
function moveView(r) {
  if (r.closed) return h('span', { class: 'muted' }, '—');
  if (r.move == null) return h('span', { class: 'muted', title: moveTitle(r) }, aprBusy() ? '…' : '—');
  const pts = r.move * 100;
  const flat = Math.abs(pts) < 0.005;
  const kind = flat ? 'flat' : pts > 0 ? 'up' : 'down';
  return h('span', { class: `apr-move ${kind}`, title: moveTitle(r) },
    flat ? null : icon(pts > 0 ? 'chevron-up' : 'chevron-down'),
    `${pts > 0 && !flat ? '+' : ''}${pts.toFixed(2)} pts`);
}
/** @param {Row} r */
function moveTitle(r) {
  const win = WINDOWS[view.window][1];
  if (r.move == null) return `Needs fee APR over the last ${win} and the ${win} before it. Swaps or saved hours do not cover both yet.`;
  // A movement is only worked out from two APRs.
  return `Fee APR over the last ${win} (${pct(/** @type {number} */ (r.apr))}) minus the ${win} before it (${pct(/** @type {number} */ (r.aprPrev))}), in percentage points. Both at today's value and prices.`;
}

// Prices are shown in token1 per token0 unless the pair is flipped. The choice is saved per pair, so it is the
// default everywhere the pair shows.
/** @param {{ sym0: string, sym1: string }} r */
const flipKey = (r) => `${r.sym0}/${r.sym1}`;
/** @param {Store} store @param {{ sym0: string, sym1: string }} r */
const isFlipped = (store, r) => Boolean(store.get(COLLECTION)?.flip?.[flipKey(r)]);
/**
 * @param {PositionRow} r @param {boolean} flip
 * @returns {Side}
 */
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
/** @param {Store} store @param {PositionRow} r @param {boolean} flip */
function flipButton(store, r, flip) {
  const other = flip ? r.sym1 : r.sym0;
  return h('button', {
    type: 'button',
    class: 'icon-btn flip-btn',
    title: `Show prices in ${other}`,
    'aria-label': `Show ${r.pair} prices in ${other}`,
    onclick: (/** @type {MouseEvent} */ e) => {
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
/** @param {Row} r */
function aprText(r) {
  if (r.apr != null && r.aprSecs != null && !r.aprFull) return `${pct(r.apr)} · ${span(r.aprSecs).replace(/ (days|hours)$/, (m) => (m === ' days' ? ' d' : ' h'))}`;
  if (r.apr != null) return pct(r.apr);
  // null > 0 is false.
  if (/** @type {number} */ (r.aprLeft) > 0) return `counting · ${Math.ceil(/** @type {number} */ (r.aprLeft) / 60000)} min`;
  return aprBusy() ? '…' : '—';
}
/** @param {Row} r */
function aprTitle(r) {
  if (r.aprSecs != null) {
    return r.aprFull
      ? `Fees from the swaps in the last ${WINDOWS[view.window][1]}, as a yearly rate of the value. An estimate.`
      : `Fees from the swaps in the last ${span(r.aprSecs)} only, as a yearly rate: the node gave no more history in this load.`;
  }
  return 'The swaps could not be read, so this counts the fees earned since the board started counting, as a yearly rate. Shown after an hour.';
}

// A short, stable colour for a symbol, so a missing logo still looks like it belongs to its token.
/** @param {string} text */
function hueOf(text) {
  let hash = 0;
  for (const c of String(text)) hash = (hash * 31 + c.charCodeAt(0)) % 360;
  return hash;
}

// A logo image, or a monogram when there is no image or it fails to load.
// Logos already shown once are drawn at once on a redraw: no lazy load and no fade, which made them blink.
/** @type {Set<string>} */
const shownLogos = new Set();
/** @param {string | null | undefined} src @param {string} label @param {string} [cls] */
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
      onerror: (/** @type {Event} */ e) => /** @type {HTMLImageElement} */ (e.currentTarget).replaceWith(monogram()),
    }));
}

/** @param {{ chainId: number }} row @param {string} address */
const tokenLogoOf = (row, address) => logoMap.get(`${row.chainId}:${address.toLowerCase()}`) ?? null;
/** @param {number} chainId */
const chainOf = (chainId) => CHAINS.find((c) => c.id === chainId);

// The price range as a track: the band is the position's range and the dot is the current price.
/** @param {Row} r @param {Store} store */
function rangeView(r, store) {
  const flip = isFlipped(store, r);
  const p = sideOf(r, flip);
  return h('div', { class: 'range' },
    h('div', { class: 'range-head' },
      h('span', { class: 'muted small' }, r.full ? 'Price range' : `${p.unit} per ${p.base}`),
      h('span', { class: 'range-side' }, statusPill(r), r.full ? null : flipButton(store, r, flip))),
    h('div', { class: r.full ? 'range-track full' : 'range-track' },
      h('span', { class: 'range-band' }),
      r.full ? null : h('span', { class: `range-marker ${r.inRange ? 'in' : 'out'}`, style: { left: `${p.marker}%` } })),
    h('div', { class: 'range-foot' },
      h('span', null, r.full ? 'Full range' : `${price(p.min)} ${p.unit}`),
      h('span', { class: 'now' }, r.full ? '' : `now ${price(p.current)}`),
      h('span', null, r.full ? '' : `${price(p.max)} ${p.unit}`)));
}

// The token split as a bar: the share of value in each token.
/** @param {PositionRow} row */
function distribution(row) {
  if (row.share0 === null) return h('div', { class: 'muted small' }, `${amount(row.a0)} ${row.sym0} · ${amount(row.a1)} ${row.sym1}`);
  const pct0 = Math.round(row.share0 * 100);
  return h('div', { class: 'dist' },
    h('div', { class: 'dist-bar' },
      h('span', { class: 'dist-a', style: { width: `${pct0}%` } }),
      h('span', { class: 'dist-b', style: { width: `${100 - pct0}%` } })),
    h('div', { class: 'muted small' }, `${pct0}% ${row.sym0} · ${100 - pct0}% ${row.sym1}`));
}

/** @param {PositionRow} r */
function statusPill(r) {
  if (r.closed) return h('span', { class: 'status-pill closed', title: 'No liquidity and no unclaimed fees left' }, h('span', { class: 'dot' }), 'Closed');
  return h('span', { class: r.inRange ? 'status-pill in' : 'status-pill out' }, h('span', { class: 'dot' }), r.inRange ? 'In range' : 'Out of range');
}

// Marks a row that may be out of date: read earlier, or valued with earlier prices.
/** @param {PositionRow} r */
function outdatedPill(r) {
  if (r.staleAt) return h('span', { class: 'outdated-pill', title: `This read failed. Showing the read from ${ago(r.staleAt)}.` }, `Outdated · ${ago(r.staleAt)}`);
  if (r.pricesAt) return h('span', { class: 'outdated-pill', title: `Prices could not be read. Values use the prices from ${ago(r.pricesAt)}.` }, 'Old prices');
  return null;
}

// A sort as text, "value-desc", for the menu and the address. The first names (newest, oldest, fees, apr) still read.
/** @param {string} key @param {number} dir */
const sortName = (key, dir) => `${key}-${dir > 0 ? 'asc' : 'desc'}`;
/**
 * @param {string} [text]
 * @returns {[string, number]}
 */
function parseSort(text = '') {
  const old = /** @type {Record<string, [string, number]>} */ ({ newest: ['number', -1], oldest: ['number', 1] })[text];
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

/** @param {string} label @param {Child} value @param {string | null} [title] */
function poolStat(label, value, title = null) {
  return h('div', { class: 'pool-stat', title }, h('span', null, label), h('strong', null, value));
}

// One position as a card: the pair, its chain and fee, the range, the value and the token split.
/** @param {Row} r @param {number | null} i @param {Map<string, number>} collected @param {Store} store */
function poolCard(r, i, collected, store) {
  const chain = chainOf(r.chainId);
  return h('article', {
    class: `pool-card clickable ${r.closed ? 'is-closed' : r.inRange ? 'is-in' : 'is-out'}${i === null ? '' : ' enter'}`,
    style: { '--i': i ?? 0 },
    onclick: (/** @type {MouseEvent} */ e) => {
      if (!/** @type {Element} */ (e.target).closest('a, button, select, input')) openDetail(store, r.ref);
    },
  },
    h('header', { class: 'pool-head' },
      h('div', { class: 'pair' },
        logo(tokenLogoOf(r, r.addr0), r.sym0, 'token'),
        logo(tokenLogoOf(r, r.addr1), r.sym1, 'token second')),
      h('div', { class: 'pool-title' },
        h('div', { class: 'pool-name-row' },
          h('button', { type: 'button', class: 'link-btn pool-name', title: 'See this position', onclick: () => openDetail(store, r.ref) }, r.pair),
          farmTag(r)),
        venueLine(r),
        outdatedPill(r)),
      r.url ? h('a', { href: r.url, target: '_blank', rel: 'noopener', class: 'icon-btn pool-open', title: `Open on ${dexName(r.dex)}`, 'aria-label': `Open position ${r.tokenId} on ${dexName(r.dex)}` }, icon('link')) : null),
    rangeView(r, store),
    h('div', { class: r.closed ? 'pool-stats' : 'pool-stats four' },
      poolStat('Value', usdOrDash(r.value)),
      poolStat('Unclaimed fees', unclaimed(r)),
      r.closed
        ? poolStat('Fees collected', collected.has(r.ref) ? cash(/** @type {number} */ (collected.get(r.ref))) : '—', 'The collections of this position in the fee log')
        : [poolStat(`Fee APR · ${WINDOWS[view.window][1]}`, aprText(r), aprTitle(r)),
            poolStat(`Movement · ${WINDOWS[view.window][1]}`, moveView(r), moveTitle(r))]),
    distribution(r),
    h('footer', { class: 'pool-foot muted small' },
      h('span', { class: 'pool-meta' }, chainTag(r.chain, chain?.logo), h('span', { class: 'lp-venue' }, r.owner)),
      h('span', null, numberOf(r))));
}

// Placeholders shown while the first read is running.
/** @param {number} i */
function skeletonCard(i) {
  return h('article', { class: 'pool-card ghost', style: { '--i': i }, 'aria-hidden': 'true' },
    h('div', { class: 'pool-head' },
      h('span', { class: 'skeleton sk-circle' }),
      h('div', { class: 'sk-stack' }, h('span', { class: 'skeleton sk-line w60' }), h('span', { class: 'skeleton sk-line w40' }))),
    h('span', { class: 'skeleton sk-line' }),
    h('div', { class: 'pool-stats' }, h('span', { class: 'skeleton sk-block' }), h('span', { class: 'skeleton sk-block' })));
}

// Counts a number from what was shown to its new value.
/** @param {HTMLElement} el @param {number} from @param {number} to @param {(n: number) => string} format */
function countUp(el, from, to, format) {
  const start = performance.now();
  const duration = 900;
  /** @param {number} now */
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
/** @param {Row} r @param {Store} store */
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
/** @param {Row[]} rows @param {Store} store */
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
          onclick: (/** @type {MouseEvent} */ e) => {
            if (!/** @type {Element} */ (e.target).closest('a, button, select, input')) openDetail(store, r.ref);
          },
        },
          h('td', null, h('div', { class: 'row' },
            h('div', { class: 'pair' }, logo(tokenLogoOf(r, r.addr0), r.sym0, 'token'), logo(tokenLogoOf(r, r.addr1), r.sym1, 'token second')),
            h('div', null, h('button', { type: 'button', class: 'link-btn', title: 'See this position', onclick: () => openDetail(store, r.ref) }, r.pair), ' ', outdatedPill(r),
              h('div', { class: 'pool-meta muted small' }, platformTag(r), farmTag(r), h('span', { class: 'lp-venue' }, `${r.owner} · ${numberOf(r)}`))))),
          h('td', null, h('span', { class: 'chain-chip' }, logo(chainOf(r.chainId)?.logo, r.chain, 'xs'), r.chain), h('div', { class: 'muted small' }, `${r.feePct}% fee`)),
          h('td', null, rangeCell(r, store)),
          h('td', null, distribution(r)),
          h('td', { class: 'num' }, usdOrDash(r.value)),
          h('td', { class: 'num' }, unclaimed(r)),
          h('td', { class: 'num', title: aprTitle(r) }, aprText(r)),
          h('td', { class: 'num' }, moveView(r)),
          h('td', null, r.url
            ? h('a', { href: r.url, target: '_blank', rel: 'noopener', class: 'icon-btn', title: `Open on ${dexName(r.dex)}`, 'aria-label': `Open position ${r.tokenId} on ${dexName(r.dex)}` }, icon('link'))
            : null))))));
}

// The add form is built once and kept while it is open. A load re-renders the section each time a chain lands, and
// a new form each time would drop what was typed, the focus and the last message.
/** @type {AddForm | null} */
let addEl = null;

/** @param {Store} store */
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

/** @param {Store} store */
function closeAdd(store) {
  view.adding = false;
  addEl = null;
  store.refresh();
}

// Adds positions the board did not find: a link copied from the Uniswap app, or a number with its chain and
// version. Each is saved in Settings, where it can be removed, and read straight away. The form stays open and
// empty after each one, so several can be pasted in a row.
/** @param {Store} store */
function addForm(store) {
  if (addEl) return addEl;
  const message = h('div', { 'aria-live': 'polite' });
  /** @param {'error' | 'ok'} tone @param {string} text */
  const say = (tone, text) => message.replaceChildren(notice({ tone, text }));
  const f = positionFields({ placeholder: 'A link from app.uniswap.org or pancakeswap.finance, or a number' });
  /** @param {SubmitEvent} e */
  const submit = (e) => {
    e.preventDefault();
    const form = /** @type {AddForm} */ (e.currentTarget);
    const text = form.elements.position.value;
    const entry = parsePosition(text, Number(form.elements.chain.value), String(form.elements.version.value));
    const error = entry ? addPosition(store, entry) : positionError(text);
    if (error) {
      say('error', error);
      return form.elements.position.focus();
    }
    // No error means the entry was read.
    const chain = chainOf(/** @type {Entry} */ (entry).chainId)?.name ?? `Chain ${/** @type {Entry} */ (entry).chainId}`;
    const added = /** @type {Entry} */ (entry);
    say('ok', added.version === 'v2'
      ? `Added the ${chain} ${dexName(added.dex)} v2 pair ${numberOf(added)}. Each wallet that holds it shows here once it is read.`
      : `Added ${chain} ${dexName(added.dex)} ${added.version} ${numberOf(added)}. It shows here once it is read.`);
    form.elements.position.value = '';
    form.elements.position.dispatchEvent(new Event('input'));
    form.elements.position.focus();
    load(store, { again: true });
  };
  addEl = /** @type {AddForm} */ (h('form', { class: 'card panel stack lp-add', onsubmit: submit },
    h('h3', null, 'Add a position'),
    h('p', { class: 'muted small' }, 'For a position the board does not find: a v3 position held by an address not in your wallets, or a v4 position older than the node keeps. Paste its link from app.uniswap.org or pancakeswap.finance and the chain, exchange and version are read from it. A plain number needs them picked. Positions staked in PancakeSwap\'s farm are found by themselves.'),
    h('p', { class: 'muted small' }, 'A v2 position is a share of a pair: paste its link, or the pair\'s address with its chain picked, and it is read for every wallet. With an Etherscan key in Settings → Blockchains, the pairs your wallets hold are found by themselves.'),
    f.input,
    f.hint,
    h('div', { class: 'row' },
      f.pickers,
      h('button', { type: 'submit', class: 'btn-small' }, 'Add'),
      h('button', { type: 'button', class: 'btn-small', onclick: () => closeAdd(store) }, 'Done')),
    message));
  return addEl;
}

// A re-render moves the kept add form into the new page, which takes the focus away from it. This puts the focus
// and the caret back once the new page is on screen.
function keepAddFocus() {
  // A field of the add form: an input has a caret, and the others only need focus().
  const el = /** @type {HTMLInputElement | null} */ (document.activeElement);
  if (!addEl || !el || !addEl.contains(el)) return;
  /** @type {[number | null, number | null] | null} */
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
/** @type {Record<string, [number, string]>} */
const FEE_RANGES = { today: [0, 'Today'], yesterday: [0, 'Yesterday'], all: [0, 'All time'], 7: [7, '7 days'], 30: [30, '30 days'], 90: [90, '90 days'], 365: [365, '1 year'], month: [0, 'This month'], lastmonth: [0, 'Last month'] };
const FEE_RANGE_ORDER = ['today', 'yesterday', '7', '30', '90', '365', 'month', 'lastmonth', 'all'];
// A range's start and its end (excluded) in ms; null for no bound. Months are calendar months in local time.
/**
 * @param {string} key @param {number} nowMs
 * @returns {[number | null, number | null]}
 */
function feeRangeBounds(key, nowMs) {
  const now = new Date(nowMs);
  /** @param {number} back */
  const monthStart = (back) => new Date(now.getFullYear(), now.getMonth() - back, 1).getTime();
  /** @param {number} back */
  const dayStart = (back) => new Date(now.getFullYear(), now.getMonth(), now.getDate() - back).getTime();
  if (key === 'today') return [dayStart(0), null];
  if (key === 'yesterday') return [dayStart(1), dayStart(0)];
  if (key === 'month') return [monthStart(0), null];
  if (key === 'lastmonth') return [monthStart(1), monthStart(0)];
  const days = FEE_RANGES[key][0];
  return [days ? nowMs - days * DAY_MS : null, null];
}
/** @type {[string, string][]} */
const FEE_GROUPS = [['day', 'Day'], ['week', 'Week'], ['month', 'Month']];
// Days by default; a year or more of days is too many bars, so 1 year and All time start on months.
/** @param {string} range */
const defaultFeeGroup = (range) => (range === '365' || range === 'all' ? 'month' : 'day');

// Local calendar keys, so a collect late in the evening counts on its own day.
/** @param {Date} d */
const localDay = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
/** @param {Date} date @param {string} group */
function bucketOf(date, group) {
  if (group === 'month') return localDay(date).slice(0, 7);
  if (group === 'week') return localDay(new Date(date.getFullYear(), date.getMonth(), date.getDate() - ((date.getDay() + 6) % 7))); // its Monday
  return localDay(date);
}
// Every bucket from the first to the last, so quiet days or months show as gaps rather than vanishing.
/** @param {Date} from @param {Date} to @param {string} group */
function bucketsBetween(from, to, group) {
  /** @type {string[]} */
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
/** @param {string} key @param {string} group */
const bucketLabel = (key, group) => (group === 'month'
  ? new Date(`${key}-01T00:00`).toLocaleDateString(dateLocale(), { month: 'short', year: '2-digit' })
  : new Date(`${key}T00:00`).toLocaleDateString(dateLocale(), { month: 'short', day: 'numeric' }));

// The full name of a bucket, for the chart's tooltip.
/** @param {string} key @param {string} group */
function bucketName(key, group) {
  if (group === 'month') return new Date(`${key}-01T00:00`).toLocaleDateString(dateLocale(), { month: 'long', year: 'numeric' });
  const date = new Date(`${key}T00:00`).toLocaleDateString(dateLocale(), { weekday: group === 'day' ? 'short' : undefined, month: 'short', day: 'numeric', year: 'numeric' });
  return group === 'week' ? `Week of ${date}` : date;
}

// One bar's tooltip: its total, how many collections, and the positions that gave the most.
/** @param {string} key @param {string} group @param {CollectEntry[]} list */
function bucketTip(key, group, list) {
  const total = list.reduce((s, c) => s + (c.usd ?? 0), 0);
  /** @type {Map<string, number>} */
  const byPos = new Map();
  for (const c of list) {
    const name = c.pair ? `${c.pair}${c.tokenId ? ` #${c.tokenId}` : ''}` : 'No position';
    byPos.set(name, (byPos.get(name) ?? 0) + (c.usd ?? 0));
  }
  const top = [...byPos].sort((a, b) => b[1] - a[1]);
  return [
    h('span', { class: 'muted' }, bucketName(key, group)),
    h('strong', null, cash(total)),
    h('span', { class: 'muted' }, list.length ? plural(list.length, 'collection') : 'No collections'),
    top.slice(0, 3).map(([name, usd]) => h('span', { class: 'tip-row' }, h('span', null, name), h('span', null, cash(usd)))),
    top.length > 3 ? h('span', { class: 'muted' }, `and ${plural(top.length - 3, 'more position')}`) : null,
  ];
}

/** @param {Store} store */
const collectedOf = (store) => (store.get(COLLECTION)?.collected ?? []).map(named);

// What the log holds per position, in USD, for the closed cards.
/** @param {Store} store */
function collectedByRef(store) {
  /** @type {Map<string, number>} */
  const out = new Map();
  for (const c of collectedOf(store)) if (c.ref) out.set(c.ref, (out.get(c.ref) ?? 0) + (c.usd ?? 0));
  return out;
}

// A collect read from the chain or Etherscan would be read again, so its key is kept in `hidden`.
/** @param {Store} store @param {CollectEntry} entry */
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
/** @param {Store} store */
function logForm(store) {
  const rows = [...state.rows].sort((a, b) => a.pair.localeCompare(b.pair));
  /** @param {SubmitEvent} e */
  const submit = (e) => {
    e.preventDefault();
    const form = new FormData(/** @type {HTMLFormElement} */ (e.currentTarget));
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
      // Nothing is collected from a v2 pair.
      rows.filter((r) => r.version !== 'v2').map((r) => h('option', { value: r.ref }, `${r.pair} · ${r.chain} · #${r.tokenId}${r.closed ? ' (closed)' : ''}`))),
    h('input', { name: 'note', placeholder: 'Note (optional)', 'aria-label': 'Note' }),
    h('div', { class: 'row' },
      h('button', { type: 'submit', class: 'btn-small' }, 'Log'),
      h('button', { type: 'button', class: 'btn-small', onclick: () => { view.logging = false; store.refresh(); } }, 'Cancel')),
    view.logMessage ? notice({ text: view.logMessage }) : null);
}

// A token's logo for a collection: from its position, or the addresses it saved, or any position with the symbol.
/** @param {CollectEntry} c @param {string} sym */
function collectLogo(c, sym) {
  const row = state.rows.find((r) => r.ref === c.ref);
  const i = c.sym0 === sym ? 0 : c.sym1 === sym ? 1 : -1;
  if (row && i >= 0) return tokenLogoOf(row, i ? row.addr1 : row.addr0);
  const addr = i === 0 ? c.addr0 : i === 1 ? c.addr1 : null;
  if (addr && c.chainId) return logoMap.get(`${c.chainId}:${addr.toLowerCase()}`) ?? null;
  return symbolLogo(sym);
}
/** @param {string} sym */
function symbolLogo(sym) {
  for (const r of state.rows) {
    if (r.sym0 === sym && tokenLogoOf(r, r.addr0)) return tokenLogoOf(r, r.addr0);
    if (r.sym1 === sym && tokenLogoOf(r, r.addr1)) return tokenLogoOf(r, r.addr1);
  }
  return null;
}

// The tokens of a collection, one per line with its logo.
/** @param {CollectEntry} c */
function tokenCell(c) {
  if (c.a0 == null) {
    const syms = tokensOf(c);
    return syms.length ? h('div', { class: 'lp-tokens muted' }, syms.map((t) => h('span', { class: 'lp-token' }, logo(symbolLogo(t), t, 'xs'), t))) : '';
  }
  return h('div', { class: 'lp-tokens' },
    // An entry with amounts has both, with their symbols.
    /** @type {[number, string][]} */ ([[c.a0, c.sym0], [c.a1, c.sym1]]).map(([n, sym]) => h('span', { class: n ? 'lp-token' : 'lp-token muted' }, logo(collectLogo(c, sym), sym, 'xs'), `${amount(n)} ${sym}`)));
}

// Whether a collection's position is still open: a dot on the log, so closed positions stand out.
/** @param {CollectEntry} c */
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
/** @type {((e: Event) => void) | null} */
let pickerOutside = null;
/** @param {Store} store */
function closePicker(store) {
  picker.open = false;
  picker.query = '';
  if (pickerOutside) document.removeEventListener('pointerdown', pickerOutside, true);
  pickerOutside = null;
  store.refresh();
}
/** @param {Store} store @param {PickerOption[]} options */
function tokenPicker(store, options) {
  const current = options.find((o) => o.value === view.feeToken) ?? options[0];
  /** @param {string} value */
  const choose = (value) => {
    view.feeToken = value;
    closePicker(store);
  };
  /** @param {PickerOption} o */
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
  /** @param {number} step */
  const move = (step) => {
    const items = /** @type {HTMLButtonElement[]} */ ([...list.querySelectorAll('.lp-picker-item')]);
    const at = items.indexOf(/** @type {HTMLButtonElement} */ (document.activeElement));
    items[Math.max(0, Math.min(items.length - 1, at + step))]?.focus();
  };
  const search = h('input', {
    type: 'search',
    class: 'lp-picker-search',
    placeholder: 'Search tokens',
    'aria-label': 'Search tokens',
    value: picker.query,
    autocomplete: 'off',
    oninput: (/** @type {Event} */ e) => {
      picker.query = /** @type {HTMLInputElement} */ (e.currentTarget).value;
      fill();
    },
    onkeydown: (/** @type {KeyboardEvent} */ e) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        /** @type {HTMLButtonElement | null} */ (list.querySelector('.lp-picker-item'))?.focus();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const first = /** @type {HTMLButtonElement[]} */ ([...list.querySelectorAll('.lp-picker-item')]).find((b) => b.dataset.value !== 'all' || !picker.query.trim());
        if (first) choose(/** @type {string} */ (first.dataset.value));
      }
    },
  });
  fill();
  const wrap = h('div', {
    class: picker.open ? 'lp-picker open' : 'lp-picker',
    onkeydown: (/** @type {KeyboardEvent} */ e) => {
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
          if (!/** @type {Element} */ (e.target).closest?.('.lp-picker')) closePicker(store);
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
/** @param {HTMLElement} root */
function keepPickerFocus(root) {
  if (!picker.open) return;
  const input = /** @type {HTMLInputElement | null} */ (root.querySelector('.lp-picker-search'));
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
/** @param {number} n @param {string} word */
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** @type {Record<string, string>} */
const SOURCE_NAMES = { chain: 'From the chain', etherscan: 'From Etherscan', auto: 'Seen by the board', manual: 'Logged by hand' };
/** @param {CollectEntry} c */
const sourceOf = (c) => (Object.hasOwn(SOURCE_NAMES, c.source) ? c.source : 'auto');
// The tokens of a collection: its symbols, or the pair's for one logged by hand.
/** @param {CollectEntry} c */
const tokensOf = (c) => [...new Set(c.sym0 ? /** @type {string[]} */ ([c.sym0, c.sym1]) : String(c.pair ?? '').split('/').map((t) => t.trim()).filter(Boolean))];

// What each column of the log sorts by, and the direction it starts in.
/** @type {Record<string, { value: (c: CollectEntry) => string | number | null, dir: number }>} */
const FEE_SORTS = {
  date: { value: (c) => c.at, dir: -1 },
  chain: { value: (c) => c.chain || null, dir: 1 },
  position: { value: (c) => c.pair || null, dir: 1 },
  tokens: { value: (c) => (c.a0 != null ? tokensOf(c).join(' / ') : null), dir: 1 },
  source: { value: (c) => SOURCE_NAMES[sourceOf(c)], dir: 1 },
  value: { value: (c) => c.usd ?? null, dir: -1 },
};

// Rows without the value sorted on go last; ties fall back to the newest first.
/** @param {CollectEntry[]} list @param {string} key @param {number} dir */
function sortCollects(list, key, dir) {
  const read = FEE_SORTS[key].value;
  // Both values come from the same sort, so they are of one kind.
  /** @param {string | number} a @param {string | number} b */
  const cmp = (a, b) => (typeof a === 'string' ? a.localeCompare(/** @type {string} */ (b)) : a < /** @type {number} */ (b) ? -1 : a > /** @type {number} */ (b) ? 1 : 0);
  return list.sort((x, y) => {
    const a = read(x);
    const b = read(y);
    const missing = (a == null ? 1 : 0) - (b == null ? 1 : 0);
    if (missing) return missing;
    // Here b is set too: a missing one returned above.
    return (a == null ? 0 : dir * cmp(a, /** @type {string | number} */ (b))) || y.at.localeCompare(x.at);
  });
}

/** @param {Store} store @param {string} key @param {string} label @param {Record<string, string>} [attrs] */
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
/** @param {CollectEntry[]} list @param {string} sym */
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
/** @param {Store} store @param {CollectEntry[]} inRange */
function feeFilters(store, inRange) {
  /** @param {(c: CollectEntry) => boolean} pred */
  const count = (pred) => inRange.filter(pred).length;
  /** @param {boolean} active @param {string} label @param {number} n @param {() => void} onclick @param {string | null} [logoSrc] */
  const chip = (active, label, n, onclick, logoSrc = null) => h('button', {
    type: 'button',
    class: active ? 'lp-chip chain active' : 'lp-chip chain',
    'aria-pressed': String(active),
    onclick,
  }, logoSrc ? logo(logoSrc, label, 'xs') : null, label, h('span', { class: 'chip-count' }, n));
  /** @param {'feeChain' | 'feeToken' | 'feeSource'} key @param {string} value */
  const set = (key, value) => () => {
    view[key] = value;
    store.refresh();
  };
  const chains = [...new Set(/** @type {string[]} */ (inRange.map((c) => c.chain).filter(Boolean)))].sort((a, b) => a.localeCompare(b));
  const tokens = [...new Set(inRange.flatMap(tokensOf))].sort((a, b) => a.localeCompare(b));
  const sources = Object.keys(SOURCE_NAMES).filter((k) => inRange.some((c) => sourceOf(c) === k));
  /** @param {'feeChain' | 'feeToken' | 'feeSource'} key @param {string} label @param {[string, string][]} options */
  const select = (key, label, options) => h('select', {
    'aria-label': label,
    onchange: (/** @type {Event} */ e) => set(key, /** @type {HTMLSelectElement} */ (e.currentTarget).value)(),
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
    sources.length > 1 ? select('feeSource', 'Source', [['all', 'All sources'], ...sources.map((k) => /** @type {[string, string]} */ ([k, `${SOURCE_NAMES[k]} (${count((c) => sourceOf(c) === k)})`]))]) : null);
}

// The exchange and version pills of the log; a collect logged by hand without a position shows only under All.
/** @param {Store} store @param {CollectEntry[]} inRange */
function feeKindFilters(store, inRange) {
  const kinds = inRange.map((c) => kindOfRef(c.ref));
  const dexes = kindsIn(kinds.map((k) => k?.dex));
  const versions = kindsIn(kinds.map((k) => k?.version));
  return kindRow([
    kindPills(dexes, view.feeDex, dexName, (d) => kinds.filter((k) => k?.dex === d).length, inRange.length, 'All platforms', (d) => {
      view.feeDex = d;
      store.refresh();
    }),
    kindPills(versions, view.feeVersion, (v) => v, (v) => kinds.filter((k) => k?.version === v).length, inRange.length, 'All versions', (v) => {
      view.feeVersion = v;
      store.refresh();
    }),
  ]);
}

// A share as a percent that only reads 100% when the search is complete.
/** @param {number} x */
const coveragePct = (x) => (x >= 1 ? '100%' : `${Math.min(99.9, Math.floor(x * 1000) / 10)}%`);
const COVERAGE_TITLE = 'How far the search for collect events has got, over every position shown, open and closed. A position counts in full once its search reached the transaction that opened it, or once Etherscan read every transaction of its wallet. Until then, the share of blocks searched back. Each load searches further.';

// How sure the log is to hold every collect: the search coverage, for all chains and per chain.
/** @param {Store} store */
function coverageCard(store) {
  const cov = collectCoverage(store);
  if (!cov.total) return null;
  const busy = searching.size > 0 || loading;
  /** @param {number} x */
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
  if (!view.coverageOpen) {
    return h('section', { class: 'card lp-coverage collapsed', title: COVERAGE_TITLE },
      toggle);
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
          }, refreshIcon(searching.has(c.chainId))))))
      : null);
}

// ---- Fees collected insights: outlook, running total, pace, breakdown and calendar ----

// When a bucket ends, in ms, so an estimate can be read at the end of each future bucket.
/** @param {string} key @param {string} group */
function bucketEnd(key, group) {
  if (group === 'month') {
    const d = new Date(`${key}-01T00:00`);
    return new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime();
  }
  const d = new Date(`${key}T00:00`);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + (group === 'week' ? 7 : 1)).getTime();
}
/** @param {CollectEntry[]} list */
const sumUsd = (list) => list.reduce((s, c) => s + (c.usd ?? 0), 0);
/** @param {CollectEntry[]} list @param {number} from @param {number} to */
const sumBetween = (list, from, to) => sumUsd(list.filter((c) => {
  const t = Date.parse(c.at);
  return t >= from && t < to;
}));
/** @param {number} now @param {number} before */
const signedChange = (now, before) => (before > 0 ? signedPct((now / before - 1) * 100) : now > 0 ? 'New' : '—');
// The round totals worth a note, from $100 up.
/** @param {number} total */
function nextMilestone(total) {
  for (let base = 100; base < 1e12; base *= 10) {
    for (const m of [1, 2.5, 5]) if (base * m > total) return base * m;
  }
  return null;
}
/** @param {number} ms */
const shortDate = (ms) => new Date(ms).toLocaleDateString(dateLocale(), { month: 'short', day: 'numeric', year: new Date(ms).getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });

// The outlook tiles: how this range compares with the one before, what the month and year should end on, the
// next round total, and how often fees get collected.
/** @param {FeeCtx} ctx */
function feeOutlook(ctx) {
  const { list, pool, start, end, from, nowMs, stat } = ctx;
  /** @type {HTMLElement[]} */
  const tiles = [];
  if (from !== null) {
    const len = end - start;
    const before = sumBetween(pool, start - len, start);
    tiles.push(stat('vs the period before', signedChange(sumUsd(list), before), `${cash(before)} in the ${plural(Math.max(1, Math.round(len / DAY_MS)), 'day')} before`));
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
  tiles.push(stat('Month-end estimate', cash(mtd + rate30 * ((monthEnd - nowMs) / DAY_MS)), `${cash(mtd)} so far, at the 30-day pace`));
  tiles.push(stat('Year-end estimate', cash(ytd + rate30 * ((yearEnd - nowMs) / DAY_MS)), `${cash(ytd)} so far in ${today.getFullYear()}`));
  const lifetime = sumUsd(pool);
  // A round milestone in the shown currency, kept in USD like the rest.
  const k = shownRate() ?? 1;
  // null only past 1e12, which a fee log does not reach.
  const goal = /** @type {number} */ (nextMilestone(lifetime * k)) / k;
  if (goal) {
    const days = rate30 > 0 ? (goal - lifetime) / rate30 : null;
    tiles.push(stat(`Next ${cash(goal)}`, days === null ? '—' : days < 1 ? 'Today' : `~${plural(Math.ceil(days), 'day')}`,
      days === null ? `${cash(lifetime)} in all; nothing in the last 30 days` : `${cash(goal - lifetime)} to go, around ${shortDate(nowMs + days * DAY_MS)}`));
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
    // Every entry here has a value.
    const largest = priced.reduce((a, c) => (/** @type {number} */ (a.usd) >= /** @type {number} */ (c.usd) ? a : c));
    tiles.push(stat('Average collect', cash(sumUsd(priced) / priced.length), `Largest ${cash(/** @type {number} */ (largest.usd))} on ${shortDate(Date.parse(largest.at))}`));
  }
  return h('div', { class: 'lp-stats' }, tiles);
}

// The running total over the range, with a dashed estimate past today at the range's own pace.
/** @param {FeeCtx} ctx */
function cumulativeChart(ctx) {
  const { list, start, end, to, perDay, nowMs, group } = ctx;
  const keys = bucketsBetween(new Date(start), new Date(end - 1), group);
  /** @type {Map<string, number>} */
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
  /** @type {string[]} */
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
  /** @type {import('../chart.js').LineSeries[]} */
  const series = [{ name: 'Collected', color: 'var(--accent)', values: [...actual, ...future.map(() => null)], area: true }];
  if (ahead) series.push({ name: 'Estimate', color: 'var(--income)', values: estimate, dashed: true });
  const chart = lineChart(all.map((k) => bucketLabel(k, group)), series, {
    format: (v) => cash(v),
    tip: (i) => [
      h('span', { class: 'muted' }, bucketName(all[i], group)),
      i < keys.length
        ? [h('strong', null, cash(actual[i])), h('span', { class: 'muted' }, `+${cash(sums.get(all[i]) ?? 0)} this ${group}`)]
        : [h('strong', null, cash(/** @type {number} */ (estimate[i]))), h('span', { class: 'muted' }, 'Estimate at this range\'s pace')],
    ],
  });
  // The estimate is set from the last real point on.
  const note = ahead ? `About ${cash(/** @type {number} */ (estimate[estimate.length - 1]))} by the end of ${bucketName(future[future.length - 1], group)}` : cash(total);
  return panel('Running total', note, chart, legend(series));
}

// The pace of fees per day: a short and a long rolling average, so a speed-up or slow-down shows early.
/** @param {FeeCtx} ctx */
function paceChart(ctx) {
  const { pool, end, spanDays } = ctx;
  const shown = Math.min(365, Math.max(30, Math.round(spanDays)));
  /** @type {Map<string, number>} */
  const daily = new Map();
  for (const c of pool) {
    const k = localDay(new Date(c.at));
    daily.set(k, (daily.get(k) ?? 0) + (c.usd ?? 0));
  }
  // 29 days before the first shown day, so the 30-day average is whole from the start.
  const keys = bucketsBetween(new Date(end - (shown + 29) * DAY_MS), new Date(end - 1), 'day');
  const vals = keys.map((k) => daily.get(k) ?? 0);
  /** @param {number} n */
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
      format: (v) => cash(v),
      tip: (i) => [
        h('span', { class: 'muted' }, bucketName(days[i], 'day')),
        series.map((sr) => h('span', { class: 'tip-row' },
          h('span', null, h('span', { class: 'legend-swatch', style: { background: sr.color } }), ` ${sr.name}`),
          h('strong', null, cash(sr.values[i] ?? 0)))),
        h('span', { class: 'tip-row' }, h('span', null, 'Collected that day'), h('span', null, cash(daily.get(days[i]) ?? 0))),
      ],
    }),
    legend(series),
    h('p', { class: 'muted small' }, 'When the 7-day line runs above the 30-day line, fees are coming in faster than usual.'));
}

const FEE_SPLITS = [['position', 'Position'], ['chain', 'Chain'], ['token', 'Token'], ['source', 'Source']];
// A collection's USD value split between its tokens: by their value at the position's current prices when the
// amounts and prices are known, else all to the only token collected, else evenly. amount is null when not logged.
/** @param {CollectEntry} c */
function tokenShares(c) {
  const usd = c.usd ?? 0;
  if (c.a0 != null && c.sym0) {
    const row = state.rows.find((r) => r.ref === c.ref);
    const v0 = row?.p0 != null ? c.a0 * row.p0 : null;
    // An entry with amounts has both.
    const v1 = row?.p1 != null ? /** @type {number} */ (c.a1) * row.p1 : null;
    const w0 = v0 != null && v1 != null && v0 + v1 > 0 ? v0 / (v0 + v1) : !c.a1 ? 1 : !c.a0 ? 0 : 0.5;
    return [{ sym: c.sym0, usd: usd * w0, amount: c.a0 }, { sym: /** @type {string} */ (c.sym1), usd: usd * (1 - w0), amount: c.a1 }];
  }
  const syms = tokensOf(c);
  return syms.map((sym) => ({ sym, usd: usd / syms.length, amount: null }));
}

// Where the range's fees came from: each position, chain or source with its share, the largest first.
/** @param {Store} store @param {FeeCtx} ctx */
function breakdown(store, ctx) {
  const { list } = ctx;
  const split = view.feeSplit ?? 'position';
  /** @type {Map<string, FeeGroup>} */
  const groups = new Map();
  for (const c of split === 'token' ? [] : list) {
    const [key, label] = split === 'chain' ? [c.chain || '', c.chain || 'No chain']
      : split === 'source' ? [sourceOf(c), SOURCE_NAMES[sourceOf(c)]]
      : [c.ref || c.pair || '', c.pair ? `${c.pair}${c.tokenId ? ` #${c.tokenId}` : ''}` : 'No position'];
    const g = groups.get(key) ?? { key, label, usd: 0, n: 0, sample: c };
    g.usd += c.usd ?? 0;
    g.n++;
    groups.set(key, g);
  }
  // A collection counts once for each of its tokens. amount: the token's total, while every collection logged it.
  for (const c of split === 'token' ? list : []) {
    for (const t of tokenShares(c)) {
      const g = groups.get(t.sym) ?? { key: t.sym, label: t.sym, usd: 0, n: 0, sample: c, amount: 0 };
      g.usd += t.usd;
      g.n++;
      g.amount = g.amount == null || t.amount == null ? null : g.amount + t.amount;
      groups.set(t.sym, g);
    }
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
  /** @param {FeeGroup} g */
  const name = (g) => {
    if (split === 'token' && g.key) return h('span', { class: 'lp-token' }, logo(tokenLogoIn(list, g.key), g.label, 'xs'), g.label);
    if (split === 'chain' && g.key) return h('span', { class: 'chain-chip' }, logo(CHAINS.find((x) => x.name === g.key)?.logo, g.label, 'xs'), g.label);
    if (split === 'position' && g.sample?.ref) {
      return h('span', { class: 'lp-pos' }, positionDot(g.sample),
        h('button', { type: 'button', class: 'link-btn', title: 'See this position', onclick: () => openDetail(store, /** @type {string} */ (g.sample?.ref)) }, g.label));
    }
    return h('span', null, g.label);
  };
  /** @param {number} usd */
  const share = (usd) => (total > 0 ? pct(usd / total) : '—');
  const lead = rows[0];
  return h('section', { class: 'card stack lp-panel' },
    h('div', { class: 'lp-panel-head' }, h('h3', null, 'Where fees came from'), pills),
    h('ul', { class: 'fee-split' }, top.map((g) => h('li', null,
      h('div', { class: 'fee-split-name' }, name(g),
        h('span', { class: 'muted small' }, g.amount ? `${amount(g.amount)} ${g.label} · ${plural(g.n, 'collection')}` : plural(g.n, 'collection'))),
      h('div', { class: 'meter', role: 'presentation' }, h('span', { style: { width: `${(g.usd / max) * 100}%` } })),
      h('strong', { class: 'num' }, cash(g.usd)),
      h('span', { class: 'muted small num' }, share(g.usd))))),
    lead && rows.length > 1 && total > 0 ? h('p', { class: 'muted small' }, `${lead.label} gave ${share(lead.usd)} of the range.`) : null,
    split === 'token' ? h('p', { class: 'muted small' }, 'Each collection\'s value is split between its tokens at the position\'s current prices, or evenly when the amounts or prices are unknown.') : null);
}

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
// Each day of the last 26 weeks as a square, darker for more fees: streaks and quiet spells at a glance.
/** @param {FeeCtx} ctx */
function feeCalendar(ctx) {
  const { pool, nowMs } = ctx;
  /** @type {Map<string, { usd: number, n: number }>} */
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
  /** @param {number} v */
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
        title: `${bucketName(k, 'day')}: ${d ? `${cash(d.usd)} · ${plural(d.n, 'collection')}` : 'no collects'}`,
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

/** @param {Store} store @param {FeeCtx} ctx */
function feeInsights(store, ctx) {
  return [
    h('section', { class: 'stack' }, h('h3', null, 'Outlook'), feeOutlook(ctx)),
    ctx.list.length ? h('div', { class: 'lp-insight-grid' }, cumulativeChart(ctx), paceChart(ctx)) : null,
    ctx.list.length ? h('div', { class: 'lp-insight-grid' }, breakdown(store, ctx), feeCalendar(ctx)) : null,
  ];
}

/** @param {Store} store */
function feesView(store) {
  const all = [...collectedOf(store)].sort((a, b) => b.at.localeCompare(a.at));
  const nowMs = Date.now();
  const [todayStart] = /** @type {[number, null]} */ (feeRangeBounds('today', nowMs));
  const anyToday = all.some((c) => Date.parse(c.at) >= todayStart);
  const [yesterdayStart] = /** @type {[number, number]} */ (feeRangeBounds('yesterday', nowMs));
  const anyYesterday = all.some((c) => Date.parse(c.at) >= yesterdayStart && Date.parse(c.at) < todayStart);
  // Today and Yesterday only show when they have collects, or when picked.
  /** @type {Record<string, boolean>} */
  const shown = { today: anyToday, yesterday: anyYesterday };
  // With no range picked, open on Today when something was collected today, else on 7 days.
  if (view.feeAuto) view.feeRange = anyToday ? 'today' : '7';
  const [from, to] = feeRangeBounds(view.feeRange, nowMs);
  const inRange = all.filter((c) => (from === null || Date.parse(c.at) >= from) && (to === null || Date.parse(c.at) < to));
  // A choice with nothing left in the range falls back to all, so the log never sits empty behind a hidden filter.
  if (!inRange.some((c) => c.chain === view.feeChain)) view.feeChain = 'all';
  if (!inRange.some((c) => tokensOf(c).includes(view.feeToken))) view.feeToken = 'all';
  if (!inRange.some((c) => sourceOf(c) === view.feeSource)) view.feeSource = 'all';
  if (!inRange.some((c) => kindOfRef(c.ref)?.dex === view.feeDex)) view.feeDex = 'all';
  if (!inRange.some((c) => kindOfRef(c.ref)?.version === view.feeVersion)) view.feeVersion = 'all';
  /** @param {CollectEntry} c */
  const matches = (c) => (view.feeChain === 'all' || c.chain === view.feeChain)
    && (view.feeToken === 'all' || tokensOf(c).includes(view.feeToken))
    && (view.feeSource === 'all' || sourceOf(c) === view.feeSource)
    && (view.feeDex === 'all' || kindOfRef(c.ref)?.dex === view.feeDex)
    && (view.feeVersion === 'all' || kindOfRef(c.ref)?.version === view.feeVersion);
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

  /** @type {Stat} */
  const stat = (label, value, hint = null) => h('div', { class: 'card lp-stat' },
    h('span', { class: 'muted' }, label), h('strong', null, value), hint ? h('span', { class: 'muted small' }, hint) : null);
  /** @param {[string, string][]} items @param {string} current @param {(key: string) => void} set */
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

  /** @type {Child} */
  let chart = null;
  if (list.length) {
    /** @type {Map<string, number>} */
    const sums = new Map();
    /** @type {Map<string, CollectEntry[]>} */
    const groups = new Map();
    for (const c of list) {
      const key = bucketOf(new Date(c.at), view.feeGroup);
      sums.set(key, (sums.get(key) ?? 0) + (c.usd ?? 0));
      groups.set(key, [...(groups.get(key) ?? []), c]);
    }
    const keys = bucketsBetween(new Date(start), new Date(end - 1), view.feeGroup);
    chart = barChart(keys.map((k) => bucketLabel(k, view.feeGroup)), [{ name: 'Collected', color: 'var(--accent)', values: keys.map((k) => sums.get(k) ?? 0) }], {
      format: (v) => cash(v),
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
        h('td', { title: c.since ? `Collected between ${new Date(c.since).toLocaleString(dateLocale())} and ${new Date(c.at).toLocaleString(dateLocale())}` : null },
          new Date(c.at).toLocaleDateString(dateLocale()),
          // One logged by hand is set to noon, a placeholder, so it shows no time.
          c.source === 'manual' ? null : h('span', { class: 'muted' }, ` ${new Date(c.at).toLocaleTimeString(dateLocale(), { hour: '2-digit', minute: '2-digit' })}`),
          c.level === 1 ? h('div', { class: 'muted small' }, `The ${c.sym0} part could not be read`) : null),
        h('td', null, c.chain
          ? h('span', { class: 'chain-chip' }, logo(CHAINS.find((x) => x.name === c.chain)?.logo, c.chain, 'xs'), c.chain)
          : h('span', { class: 'muted' }, '—')),
        h('td', null,
          c.pair
            ? h('div', { class: 'lp-pos' },
                positionDot(c),
                c.ref
                  ? h('button', { type: 'button', class: 'link-btn', title: 'See this position', onclick: () => openDetail(store, /** @type {string} */ (c.ref)) }, c.pair)
                  : h('strong', null, c.pair))
            : h('span', { class: 'muted' }, '—'),
          h('div', { class: 'muted small' }, [c.tokenId ? `#${c.tokenId}` : '', c.note].filter(Boolean).join(' · '))),
        h('td', { class: 'small' }, tokenCell(c)),
        h('td', { class: 'small muted', title: c.tx ?? null }, SOURCE_NAMES[sourceOf(c)]),
        h('td', { class: 'num', title: /** @type {Record<string, string>} */ ({ auto: 'The unclaimed fees at the read before the collect. Fees earned after that read are not counted.', chain: COLLECT_TITLE, etherscan: COLLECT_TITLE })[c.source] ?? null }, usdOrDash(c.usd ?? null)),
        h('td', null, h('button', {
          type: 'button',
          class: 'icon-btn',
          title: 'Remove',
          'aria-label': `Remove the collection of ${new Date(c.at).toLocaleDateString(dateLocale())}`,
          onclick: () => removeCollect(store, c),
        }, icon('trash'))))))));

  return h('div', { class: 'stack-lg' },
    h('div', { class: 'row between' },
      pills(FEE_RANGE_ORDER.filter((k) => (shown[k] ?? true) || view.feeRange === k).map((k) => /** @type {[string, string]} */ ([k, FEE_RANGES[k][1]])), view.feeRange, (k) => { view.feeRange = k; view.feeAuto = false; view.feeGroup = defaultFeeGroup(k); }),
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
    feeKindFilters(store, inRange),
    h('div', { class: 'lp-stats' },
      stat('Collected', cash(total), plural(list.length, 'collection')),
      stat('Per day', cash(perDay), `over ${plural(Math.round(spanDays), 'day')}`),
      stat('Per week', cash(perDay * 7)),
      stat('Per month', cash(perDay * 30.44)),
      stat('Per year', cash(perDay * 365))),
    coverageCard(store),
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
/** @param {Store} store @param {string} ref */
function openDetail(store, ref) {
  view.detailFrom = view.tab === 'fees' ? 'fees' : 'positions';
  view.detail = ref;
  detailEnter = true;
  if (picker.open) closePicker(store);
  store.refresh();
  window.scrollTo({ top: 0 });
}
/** @param {Store} store */
function closeDetail(store) {
  view.detail = null;
  view.tab = view.detailFrom ?? view.tab;
  store.refresh();
}

/** @param {Store} store @param {number} chainId @param {string} kind @param {string | null | undefined} id */
const explorerLink = (store, chainId, kind, id) => (/^0x[0-9a-fA-F]{40}$/.test(id ?? '') ? explorerUrl(chainById(store.get('settings'), chainId), kind, id) : null);

// The row for a position: as read now, or from any saved read, so a position whose wallet was removed still
// shows its range and holdings, marked as from that read.
/**
 * @param {Store} store @param {string} ref
 * @returns {PositionRow | null}
 */
function detailRow(store, ref) {
  const now = state.rows.find((r) => r.ref === ref);
  if (now) return now;
  for (const part of Object.values(store.get(COLLECTION)?.cache ?? {})) {
    const r = part?.rows?.find((x) => x.ref === ref);
    if (r) return { ...r, max: r.max ?? Infinity, staleAt: part.at };
  }
  return null;
}

const HOUR = 3600;

// What a position earned over the last secs seconds, from the hours saved for fee APR, at today's prices.
// covered: the seconds those hours span, so a part-covered window is said as such.
/** @param {Store} store @param {Row} r @param {number} secs */
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
  // null > 0 is false.
  return { usd, covered, apr: /** @type {number} */ (r.value) > 0 ? (usd / /** @type {number} */ (r.value)) * (YEAR_MS / (covered * 1000)) : null };
}

// What a position earned per day over the last 30 days, from the saved hours, at today's prices.
/** @param {Store} store @param {Row} r */
function earnedChart(store, r) {
  const hours = store.get(COLLECTION)?.earned?.[r.ref];
  if (!hours || r.p0 == null || r.p1 == null) return null;
  /** @type {Map<string, { a0: number, a1: number, hours: number }>} */
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
  /** @param {{ a0: number, a1: number } | undefined} d */
  // Both prices were checked above.
  const usd = (d) => (d ? d.a0 * /** @type {number} */ (r.p0) + d.a1 * /** @type {number} */ (r.p1) : 0);
  const total = [...days.values()].reduce((s, d) => s + usd(d), 0);
  const chart = barChart(keys.map((k) => bucketLabel(k, 'day')), [{ name: 'Earned', color: 'var(--income)', values: keys.map((k) => usd(days.get(k))) }], {
    format: (v) => cash(v),
    tip: (i) => {
      const d = days.get(keys[i]);
      return [
        h('span', { class: 'muted' }, bucketName(keys[i], 'day')),
        h('strong', null, cash(usd(d))),
        d ? h('span', { class: 'tip-row' }, h('span', null, r.sym0), h('span', null, amount(d.a0))) : h('span', { class: 'muted' }, 'No hours saved'),
        d ? h('span', { class: 'tip-row' }, h('span', null, r.sym1), h('span', null, amount(d.a1))) : null,
        d && d.hours < 24 ? h('span', { class: 'muted' }, `${plural(d.hours, 'hour')} saved`) : null,
      ];
    },
  });
  return { chart, total, days: keys.length };
}

// A section card with a title, an optional note on the right, and its content.
/** @param {string} title @param {Child} note @param {...Child} children */
function panel(title, note, ...children) {
  return h('section', { class: 'card stack lp-panel' },
    h('div', { class: 'lp-panel-head' }, h('h3', null, title), note ? h('span', { class: 'muted small' }, note) : null),
    ...children);
}

// How far the price moves, as a percent, to reach a price.
/** @param {number} from @param {number} to */
const moveTo = (from, to) => (from > 0 && to > 0 && Number.isFinite(to) ? (to / from - 1) * 100 : null);
/** @param {number | null} x */
const signedPct = (x) => (x == null ? '—' : `${x > 0 ? '+' : ''}${Math.abs(x) >= 100 ? x.toFixed(0) : x.toFixed(1)}%`);

// The range on a price scale wider than it, so the price shows where it sits even out of range. Log scale:
// prices move in ratios.
/** @param {PositionRow} r @param {Side} p */
function rangeScale(r, p) {
  const lo = Math.log(p.min);
  const hi = Math.log(p.max);
  const cur = Math.log(p.current);
  const pad = Math.max((hi - lo) * 0.45, 0.02);
  const from = Math.min(lo - pad, cur - pad / 2);
  const to = Math.max(hi + pad, cur + pad / 2);
  /** @param {number} x */
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
/** @param {Store} store @param {Row} r */
function detailRange(store, r) {
  const flip = isFlipped(store, r);
  const p = sideOf(r, flip);
  /** @param {string} note */
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
  /** @param {string} label @param {string} value @param {string} hint @param {string} [cls] */
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
/** @param {Row} r */
function detailHoldings(r) {
  const total = /** @type {number} */ (r.value) > 0 ? r.value : null; // null > 0 is false
  /** @param {string} addr @param {string} sym @param {number} n @param {number | null} px @param {number | null} [share] */
  const line = (addr, sym, n, px, share = null) => h('li', null,
    h('span', { class: 'lp-token' }, logo(tokenLogoOf(r, addr), sym, 'xs'), h('strong', null, sym)),
    h('span', { class: 'num' }, amount(n)),
    h('span', { class: 'num muted' }, px == null ? '—' : cash(n * px)),
    share == null ? null : h('span', { class: 'lp-share', title: `${Math.round(share * 100)}% of the value`, style: { '--w': `${Math.round(share * 100)}%` } }),
    share == null ? null : h('span', { class: 'lp-share-pct muted small' }, `${Math.round(share * 100)}%`));
  const fees = typeof r.fee0 === 'number';
  return panel('Holdings', total ? cash(total) : null,
    h('ul', { class: 'lp-holdings' },
      // A value means both prices are known.
      line(r.addr0, r.sym0, r.a0, r.p0, total ? (r.a0 * /** @type {number} */ (r.p0)) / total : null),
      line(r.addr1, r.sym1, r.a1, r.p1, total ? (r.a1 * /** @type {number} */ (r.p1)) / total : null)),
    r.version === 'v2' ? null : h('div', { class: 'lp-panel-head' }, h('h3', null, 'Unclaimed fees'), h('span', { class: 'muted small' }, usdOrDash(r.fees))),
    r.version === 'v2'
      ? null
      : fees
        ? h('ul', { class: 'lp-holdings' }, line(r.addr0, r.sym0, r.fee0, r.p0), line(r.addr1, r.sym1, r.fee1, r.p1))
        : h('p', { class: 'muted small' }, 'Not read.'));
}

// Fees earned over the last day, week and month, from the saved hours, with the yearly rate each makes.
/** @param {Store} store @param {Row} r */
function detailEarnings(store, r) {
  const rows = /** @type {[string, number][]} */ ([['24 h', 86400], ['7 days', 7 * 86400], ['30 days', 30 * 86400]]).map(([label, secs]) => /** @type {const} */ ([label, secs, earnedOver(store, r, secs)]));
  if (!rows.some(([, , e]) => e)) return null;
  return panel('Earnings', 'From the swaps, at today\'s prices',
    h('table', { class: 'mon-table lp-earn' },
      h('thead', null, h('tr', null, h('th', null, 'Over'), h('th', { class: 'num' }, 'Earned'), h('th', { class: 'num' }, 'Fee APR'), h('th', { class: 'num' }, 'Covered'))),
      h('tbody', null, rows.map(([label, secs, e]) => h('tr', null,
        h('td', null, label),
        h('td', { class: 'num' }, e ? cash(e.usd) : '—'),
        h('td', { class: 'num' }, e?.apr != null ? pct(e.apr) : '—'),
        h('td', { class: 'num muted' }, e ? (e.covered >= secs * 0.95 ? 'full' : span(e.covered)) : '—'))))));
}

// The facts: chain, numbers, addresses with explorer links, and how fresh the read is.
/** @param {Store} store @param {Row} r */
function detailFacts(store, r) {
  const d = store.get(COLLECTION) ?? {};
  /** @param {string} kind @param {string} id @param {string} [label] */
  const address = (kind, id, label = shortAddress(id)) => h('span', { class: 'row lp-addr' },
    copyable(id, { label }),
    explorerLink(store, r.chainId, kind, id) ? h('a', { href: explorerLink(store, r.chainId, kind, id), target: '_blank', rel: 'noopener', class: 'icon-btn', title: 'Open in the block explorer', 'aria-label': `Open ${label} in the block explorer` }, icon('link')) : null);
  const share = searchShare(r, d, etherscanKey(store.get('settings')));
  /** @type {[string, Child][]} */
  const facts = [
    ['Chain', h('span', { class: 'chain-chip' }, logo(chainOf(r.chainId)?.logo, r.chain, 'xs'), r.chain)],
    ['Protocol', `${dexName(r.dex)} ${r.version} · ${r.feePct}% fee tier${r.feePips !== r.feePct * 10000 ? ` (${(r.feePips / 10000).toLocaleString(numberLocale(), { maximumSignificantDigits: 3 })}% to liquidity)` : ''}`],
    ['Position', r.url ? h('a', { href: r.url, target: '_blank', rel: 'noopener' }, numberOf(r)) : numberOf(r)],
    ['Owner', r.owner],
    ['Wallet', address('address', r.wallet)],
    [r.version === 'v4' ? 'Pool ID' : r.version === 'v2' ? 'Pair' : 'Pool', r.pool ? (r.version === 'v4' ? copyable(r.pool, { label: `${r.pool.slice(0, 10)}…${r.pool.slice(-6)}` }) : address('address', r.pool)) : '—'],
    [r.sym0, address('token', r.addr0)],
    [r.sym1, address('token', r.addr1)],
    ['Liquidity', BigInt(r.liq ?? '0').toLocaleString(numberLocale())],
    ['Read', r.staleAt ? `${ago(r.staleAt)} (outdated)` : state.at ? ago(state.at) : '—'],
    ['Prices', r.pricesAt ? `from ${ago(r.pricesAt)}` : 'Current'],
    ['Collect search', h('span', { class: 'row lp-search', title: COVERAGE_TITLE }, h('div', { class: 'meter', role: 'presentation' }, h('span', { style: { width: `${share * 100}%` } })), coveragePct(share))],
  ];
  // A v2 pair has no collects to search for. What it holds is its share of the pair's own token.
  if (r.version === 'v2') {
    const part = Number(r.supply) > 0 ? Number(r.liq) / Number(r.supply) : 0;
    facts.splice(-1, 1, ['Share of the pair', `${(part * 100).toLocaleString(numberLocale(), { maximumSignificantDigits: 3 })}%`]);
  }
  return panel('Details', null,
    h('dl', { class: 'lp-facts' }, facts.map(([k, v]) => h('div', null, h('dt', { class: 'muted small' }, k), h('dd', null, v)))));
}

// The position's collections, newest first, with their total.
/** @param {CollectEntry[]} collects */
function detailCollections(collects) {
  const total = collects.reduce((s, c) => s + (c.usd ?? 0), 0);
  return panel('Collections', collects.length ? `${plural(collects.length, 'collection')} · ${cash(total)}` : null,
    collects.length
      ? h('div', { class: 'mon-scroll' }, h('table', { class: 'mon-table' },
          h('thead', null, h('tr', null, h('th', null, 'Date'), h('th', null, 'Tokens'), h('th', null, 'Source'), h('th', { class: 'num' }, 'Value'))),
          h('tbody', null, collects.map((c) => h('tr', null,
            h('td', null, new Date(c.at).toLocaleDateString(dateLocale())),
            h('td', { class: 'small' }, tokenCell(c)),
            h('td', { class: 'small muted', title: c.tx ?? null }, SOURCE_NAMES[sourceOf(c)]),
            h('td', { class: 'num' }, usdOrDash(c.usd ?? null)))))))
      : h('p', { class: 'muted small' }, 'No collections logged for this position.'));
}

// Everything the board knows about one position. One no longer read anywhere shows what the fee log holds.
/** @param {Store} store @param {string} ref */
function detailView(store, ref) {
  const raw = detailRow(store, ref);
  const r = raw ? aprOf(store)(raw) : null;
  const collects = collectedOf(store).filter((c) => c.ref === ref).sort((a, b) => b.at.localeCompare(a.at));
  const known = r ?? collects[0];
  const back = h('button', { type: 'button', class: 'btn-small lp-back', onclick: () => closeDetail(store) },
    icon('arrow-left'), view.detailFrom === 'fees' ? 'LP Fees Collected' : 'LP Positions');
  if (!known) {
    return h('div', { class: 'stack-lg lp' }, back,
      notice({ tone: 'info', text: loading ? 'Reading the positions…' : 'This position is not among those read, and the fee log has nothing for it.' }));
  }
  const chain = r ? chainOf(r.chainId) : CHAINS.find((x) => x.name === known.chain);
  // With no row, known is the newest collection.
  const syms = r ? [r.sym0, r.sym1] : tokensOf(/** @type {CollectEntry} */ (known));
  const collectedUsd = collects.reduce((s, c) => s + (c.usd ?? 0), 0);
  const win = WINDOWS[view.window][1];
  /** @param {string} label @param {Child} value @param {string | null} [hint] @param {string | null} [title] */
  const stat = (label, value, hint = null, title = null) => h('div', { class: 'card lp-stat', title },
    h('span', { class: 'muted' }, label), h('strong', null, value), hint ? h('span', { class: 'muted small' }, hint) : null);
  const earned = r ? earnedChart(store, r) : null;
  const kind = !r ? 'gone' : r.closed ? 'closed' : r.inRange ? 'in' : 'out';
  const v2 = r?.version === 'v2';

  const hero = h('header', { class: `card lp-hero is-${kind}` },
    h('div', { class: 'lp-hero-main' },
      h('div', { class: 'pair lp-hero-pair' },
        r ? logo(tokenLogoOf(r, r.addr0), r.sym0, 'token') : logo(symbolLogo(syms[0]), syms[0] ?? '?', 'token'),
        r ? logo(tokenLogoOf(r, r.addr1), r.sym1, 'token second') : logo(symbolLogo(syms[1]), syms[1] ?? '?', 'token second')),
      h('div', { class: 'pool-title' },
        h('h2', null, known.pair ?? 'Position'),
        r ? venueLine(r, [chainTag(r.chain, chain?.logo), farmTag(r)])
          : known.chain ? h('div', { class: 'pool-meta' }, chainTag(known.chain, chain?.logo)) : null,
        h('div', { class: 'pool-meta' },
          r ? statusPill(r) : h('span', { class: 'status-pill closed' }, h('span', { class: 'dot' }), 'Not read'),
          r ? outdatedPill(r) : null,
          h('span', { class: 'muted small' }, `${numberOf(r ?? known)}${r ? ` · ${r.owner}` : ''}`)))),
    h('div', { class: 'lp-hero-side' },
      r ? h('div', { class: 'lp-hero-value' }, h('span', { class: 'muted small' }, 'Value'), h('strong', null, usdOrDash(r.value))) : null,
      h('div', { class: 'row' },
        r?.url ? h('a', { href: r.url, target: '_blank', rel: 'noopener', class: 'btn-small' }, icon('link'), dexName(r.dex)) : null,
        r && explorerLink(store, r.chainId, 'address', r.wallet)
          ? h('a', { href: explorerLink(store, r.chainId, 'address', r.wallet), target: '_blank', rel: 'noopener', class: 'btn-small', title: 'Open the wallet in the block explorer' }, icon('globe'), 'Wallet')
          : null)));

  return h('div', { class: 'stack-lg lp lp-detail' },
    back,
    hero,
    !r ? notice({ tone: 'info', text: 'This position is not among those read, and no saved read has it: it was burned, or its wallet was removed before it was read. Below is what the fee log holds for it.' }) : null,
    r?.closed ? notice({ tone: 'info', text: 'Closed: this position holds no liquidity now. Its range, its last prices and its fee history are shown as read.' }) : null,
    r?.staked ? notice({ tone: 'info', text: `Staked in ${dexName(r.dex)}'s farm, which holds the position and pays ${r.rewardSym ?? 'CAKE'} on top of the fees. The fees and the reward are harvested apart, from the farm.` }) : null,
    v2 ? notice({ tone: 'info', text: 'A v2 position is a share of the whole pair, over the full range. Its fees are added to the pool as they are paid: they grow the value and come out with the liquidity, so there is nothing to claim or collect. Fee APR is read from the pair\'s swaps.' }) : null,
    h('div', { class: 'lp-stats' },
      r && !v2 ? stat('Unclaimed fees', usdOrDash(r.fees)) : null,
      r?.staked ? stat(`${r.rewardSym ?? 'CAKE'} to harvest`, r.rewardUsd != null ? cash(r.rewardUsd) : '—', `${amount(r.reward ?? 0)} ${r.rewardSym ?? 'CAKE'}`) : null,
      v2 ? stat('Fees', 'In the pool', 'part of the value', V2_FEES) : null,
      r && !r.closed ? stat(`Fee APR · ${win}`, aprText(r), null, aprTitle(r)) : null,
      r && !r.closed ? stat(`Movement · ${win}`, moveView(r), r.aprPrev != null ? `from ${pct(r.aprPrev)}` : null, moveTitle(r)) : null,
      v2 ? null : stat('Fees collected', cash(collectedUsd), plural(collects.length, 'collection')),
      r && !v2 && r.fees != null ? stat('Total earned', cash(collectedUsd + r.fees), 'collected and unclaimed') : null),
    r && !r.closed
      ? h('label', { class: 'inline lp-sort', title: 'The time fee APR is read over' }, 'APR window',
          h('select', {
            'aria-label': 'Fee APR window',
            onchange: (/** @type {Event} */ e) => {
              view.window = /** @type {HTMLSelectElement} */ (e.target).value;
              store.refresh();
              loadAprs(store);
            },
          }, Object.entries(WINDOWS).map(([key, [, label]]) => h('option', { value: key, selected: key === view.window }, label))))
      : null,
    r ? detailRange(store, r) : null,
    // A closed position holds nothing, so its holdings are left out unless fees are still owed.
    r ? h('div', { class: 'lp-detail-grid' }, r.closed && !(r.a0 || r.a1 || r.fee0 || r.fee1) ? null : detailHoldings(r), detailEarnings(store, r)) : null,
    earned
      ? panel('Fees earned per day', `${cash(earned.total)} over ${plural(earned.days, 'day')} · ${cash(earned.total / earned.days)} a day`, earned.chart)
      : null,
    v2 ? null : detailCollections(collects),
    r ? detailFacts(store, r) : null);
}

const FEES_SUBTITLE = 'Fees collected from your positions: read from the chain, from Etherscan when its key is set, and logged by hand.';

// The DeFi section's views: a summary of the rest, the LP positions, the fees collected from them, the wallets'
// balances, and Aave. Sub-tabs, as in Monitoring and Tools.
/** @type {[string, string, IconName][]} */
const TABS = [['summary', 'Summary', 'activity'], ['positions', 'LP Positions', 'droplet'], ['fees', 'LP Fees Collected', 'coins'], ['wallets', 'Wallets', 'wallet'], ['lending', 'Lending / Borrowing', 'landmark']];
// Tabs drawn by their own module, not by the LP views: their title and how to draw them.
/** @type {Record<string, [string, (store: Store, ui: DefiUi) => DefiTab]>} */
const OWN_TABS = { summary: ['Summary', summaryTab], wallets: ['Wallets', walletsTab], lending: ['Lending / Borrowing', lendingTab] };

// The tabs, with the open tab's controls at the end of their row: the page has no header. What the open tab
// shows, and what is being read, is in its tooltip.
// The open tab's notices fold into pills at the start of those controls (noticePills() in js/ui.js).
/** @param {Store} store @param {string} [subtitle] @param {Child[]} [tools] @param {(DefiNotice | null)[]} [notices] */
function tabs(store, subtitle = '', tools = [], notices = []) {
  tools = [noticePills(`defi-${view.tab}`, notices), ...tools];
  return h('div', { class: 'sub-tabs-bar' },
    h('nav', { class: 'sub-tabs lp-tabs', role: 'tablist', 'aria-label': 'DeFi view' },
      TABS.map(([key, label, iconName]) =>
        h('button', {
          type: 'button',
          role: 'tab',
          class: view.tab === key ? 'sub-tab active' : 'sub-tab',
          'aria-selected': String(view.tab === key),
          title: view.tab === key && subtitle ? subtitle : null,
          onclick: () => {
            view.tab = key;
            store.refresh();
          },
        }, icon(iconName), label))),
    tools.some(Boolean) ? h('div', { class: 'row sub-tabs-tools' }, tools) : null);
}

/** @param {HTMLElement} root @param {Store} store */
function showDetail(root, store) {
  if (detailEnter) root.classList.add('enter');
  detailEnter = false;
  // Called only while a position is open.
  root.replaceChildren(detailView(store, /** @type {string} */ (view.detail)));
}

// The page shows what the runners saved. Only a folder they never read is asked for at once; otherwise their own
// schedule keeps it fresh.
/** @param {Store} store */
function ensureRows(store) {
  bound = store;
  if (!loading && !state.at && !askedAt) {
    askedAt = Date.now();
    setTimeout(() => load(store), 0);
  }
}

// The LP totals for the Summary tab: open positions only, as in the LP view. null when there is nothing to read.
/**
 * @param {Store} store
 * @returns {LpSummary | null}
 */
function lpSummary(store) {
  const cfg = store.get('settings').uniswap ?? {};
  const wallets = (cfg.wallets ?? []).filter((w) => isAddress(w.address));
  if (!wallets.length && !addedPositions(cfg).length) return null;
  ensureRows(store);
  const open = state.rows.filter((r) => !r.closed);
  const since = Date.now() - 30 * 24 * 60 * 60 * 1000;
  return {
    value: open.reduce((s, r) => s + (r.value ?? 0), 0),
    fees: open.reduce((s, r) => s + (r.fees ?? 0), 0),
    count: open.length,
    inRange: open.filter((r) => r.inRange).length,
    out: open.filter((r) => !r.inRange).sort((a, b) => (b.value ?? 0) - (a.value ?? 0)),
    top: [...open].sort((a, b) => (b.value ?? 0) - (a.value ?? 0)),
    collected30: collectedOf(store).filter((c) => Date.parse(c.at) >= since).reduce((s, c) => s + (c.usd ?? 0), 0),
    reading: state.status === 'loading',
    firstRead: state.status === 'loading' && !state.rows.length,
    failed: state.stale.map((x) => x.name),
  };
}

// A tab drawn by its own module, inside the section's header, tab bar and currency switch.
/** @param {HTMLElement} root @param {Store} store */
function drawOwnTab(root, store) {
  askLogos(store);
  askRate(store);
  /** @type {DefiUi} */
  const ui = {
    cash,
    logo,
    logoOf: (chainId, address) => logoMap.get(`${chainId}:${String(address).toLowerCase()}`) ?? null,
    refresh: () => store.refresh(),
    // For the Summary tab.
    lp: () => lpSummary(store),
    loadLp: () => load(store),
    go: (tab, filter) => {
      view.tab = tab;
      if (filter) view.filter = filter;
      store.refresh();
      window.scrollTo({ top: 0 });
    },
    openPosition: (ref) => openDetail(store, ref),
  };
  const [, drawTab] = OWN_TABS[view.tab];
  const { subtitle, actions, notices = [], body } = drawTab(store, ui);
  root.replaceChildren(h('div', { class: 'stack-lg lp' },
    tabs(store, subtitle, [currencySwitch(store), ...actions], [rateNotice(), ...notices]),
    body));
}

/** @param {HTMLElement} root @param {Store} store */
function draw(root, store) {
  bound = store;
  if (Object.hasOwn(OWN_TABS, view.tab) && !view.detail) {
    drawOwnTab(root, store);
    return;
  }
  keepAddFocus();
  const cfg = store.get('settings').uniswap ?? {};
  const wallets = (cfg.wallets ?? []).filter((w) => isAddress(w.address));
  if (!wallets.length && !addedPositions(cfg).length) {
    // The log of collections stays reachable once there is one, even with no wallet left.
    const logged = collectedOf(store).length > 0;
    if (!logged && view.tab === 'fees') view.tab = 'positions';
    if (view.detail && logged) {
      showDetail(root, store);
      return;
    }
    askRate(store);
    root.replaceChildren(h('div', { class: 'stack-lg lp' },
      tabs(store, logged && view.tab === 'fees' ? FEES_SUBTITLE : '', [logged ? currencySwitch(store) : null],
        logged ? [rateNotice(), view.tab === 'fees' ? etherscanNotice(store) : null] : []),
      view.tab === 'fees'
        ? feesView(store)
        : [setupBanner('wallets', 'Add a wallet address in Settings to see its Uniswap positions.'),
            view.adding ? addForm(store) : h('button', { type: 'button', class: 'btn-small', onclick: () => openAdd(store) }, icon('plus'), 'Add a position by link or number')]));
    keepPickerFocus(root);
    return;
  }
  ensureRows(store);
  askLogos(store);
  askRate(store);
  if (view.detail) {
    showDetail(root, store);
    return;
  }

  const chainCount = enabledChains(cfg).length;
  const all = state.rows;
  // Chain chips show only chains that have positions, so the row stays short.
  const chainsWithRows = CHAINS.filter((c) => all.some((r) => r.chainId === c.id));
  if (view.chain !== 'all' && !chainsWithRows.some((c) => c.id === view.chain)) view.chain = 'all';
  const chainRows = view.chain === 'all' ? all : all.filter((r) => r.chainId === view.chain);
  // Then the exchange and the version, each counted within the filters before it.
  const dexes = kindsIn(chainRows.map(dexOf));
  if (!dexes.includes(view.dex)) view.dex = 'all';
  const dexRows = view.dex === 'all' ? chainRows : chainRows.filter((r) => dexOf(r) === view.dex);
  const versions = kindsIn(dexRows.map((r) => r.version));
  if (!versions.includes(view.version)) view.version = 'all';
  const inChain = view.version === 'all' ? dexRows : dexRows.filter((r) => r.version === view.version);
  // Closed positions only show under their own filter, and never count in the totals.
  const byChain = inChain.filter((r) => !r.closed);
  const closedRows = inChain.filter((r) => r.closed);
  const showClosed = view.filter === 'closed';
  const inRange = byChain.filter((r) => r.inRange).length;
  const pick = /** @type {Record<string, PositionRow[]>} */ ({ in: byChain.filter((r) => r.inRange), out: byChain.filter((r) => !r.inRange), closed: closedRows })[view.filter] ?? byChain;
  const withApr = aprOf(store);
  const shown = sortRows(pick.map(withApr), view.sort, view.dir);
  const totalValue = byChain.reduce((s, r) => s + (r.value ?? 0), 0);
  const totalFees = byChain.reduce((s, r) => s + (r.fees ?? 0), 0);
  const totalValueKnown = byChain.some((r) => r.value !== null);
  const totalFeesKnown = byChain.some((r) => r.fees !== null);

  // Totals count from the old number to the new one when it changes, as each chain lands or a filter changes.
  /** @type {(() => void)[]} */
  const counters = [];
  /** @param {HTMLElement} el @param {boolean} known @param {number} value @param {'value' | 'fees'} key */
  const total = (el, known, value, key) => {
    if (!known) return;
    const from = shownTotals[key];
    shownTotals[key] = value;
    if (from === value) el.textContent = usdOrDash(value);
    else counters.push(() => countUp(el, from, value, (n) => cash(n)));
  };
  const valueEl = h('strong', null, '—');
  const feesEl = h('strong', null, '—');
  total(valueEl, totalValueKnown, totalValue, 'value');
  total(feesEl, totalFeesKnown, totalFees, 'fees');

  /** @param {string} key @param {string} label @param {number} count */
  const chip = (key, label, count) => h('button', {
    type: 'button',
    class: view.filter === key ? 'lp-chip active' : 'lp-chip',
    onclick: () => {
      view.filter = key;
      store.refresh();
    },
  }, key === 'all' ? null : h('span', { class: `pos-dot ${key}`, 'aria-hidden': 'true' }), label, h('span', { class: 'chip-count' }, count));

  /** @param {number | 'all'} key @param {string} label @param {string | null} logoSrc @param {number} count */
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

  /** @type {Child} */
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
    const filtered = view.filter !== 'all' || view.chain !== 'all' || view.dex !== 'all' || view.version !== 'all';
    body = h('div', { class: 'lp-empty' },
      h('span', { class: 'float' }, icon('wallet')),
      h('p', null, showClosed ? 'No closed positions.' : all.length && filtered ? 'No positions match this filter.' : 'No open Uniswap positions for these wallets.'));
  }

  root.replaceChildren(h('div', { class: 'stack-lg lp' },
    tabs(store,
      (view.tab === 'fees'
        ? FEES_SUBTITLE
        : `Uniswap and PancakeSwap positions on ${chainCount} chain${chainCount === 1 ? '' : 's'}, read from the chain. Read-only.`)
        + (state.pending.length ? ` Reading ${state.pending.join(', ')}…` : state.at ? ` ${updatedText()}.` : ''),
      [
        currencySwitch(store),
        view.tab === 'fees' ? null : h('button', { type: 'button', class: 'btn-small', onclick: () => openAdd(store), title: 'Add a position the board did not find' }, icon('plus'), 'Add position'),
        h('button', { type: 'button', class: 'btn-small', disabled: reading || chainCount === 0, onclick: () => load(store), title: state.at ? updatedText() : null },
          refreshIcon(reading),
          reading ? 'Reading…' : 'Refresh'),
      ],
      [
        rateNotice(),
        view.tab === 'fees' ? etherscanNotice(store) : v2Notice(),
        state.shallow.length
          ? { tone: 'info', text: `The node for ${state.shallow.join(', ')} keeps only recent history, so older v4 positions there are not found. Add them with Add position, or set a node that keeps full history in Settings.` }
          : null,
        staleText ? { tone: 'info', text: staleText } : null,
        !state.at && all.length ? { tone: 'info', text: 'Showing the positions saved by the last read while the chains are read again.' } : null,
        state.warning ? { tone: 'info', text: state.warning } : null,
        state.status === 'error' ? { text: `The positions could not be read: ${state.error}` } : null,
        chainCount === 0 ? { tone: 'info', text: 'No chains are selected. Pick the chains to read in Settings.' } : null,
      ]),
    view.adding && view.tab !== 'fees' ? addForm(store) : null,

    view.tab === 'fees' ? feesView(store) : [
    h('div', { class: 'lp-stats' },
      h('div', { class: 'card lp-stat' }, h('span', { class: 'muted' }, 'Total liquidity'), valueEl),
      h('div', { class: 'card lp-stat' }, h('span', { class: 'muted' }, 'Unclaimed fees'), feesEl),
      h('div', { class: 'card lp-stat' }, h('span', { class: 'muted' }, 'Positions'), h('strong', null, `${byChain.length} · ${inRange} in range`))),

    firstRead ? null : insightsPanel(store, byChain.map(withApr), {
      sideOf: (r) => sideOf(r, isFlipped(store, r)),
      isFlipped: (pair) => isFlipped(store, pair),
      logo,
      cash,
      // The open row's logos when it is still read; a saved read of a closed position falls back to the symbols.
      tokenLogos: (pos, row) => (row ? [tokenLogoOf(row, row.addr0), tokenLogoOf(row, row.addr1)] : [symbolLogo(pos.sym0), symbolLogo(pos.sym1)]),
    }),

    chainsWithRows.length > 1
      ? h('div', { class: 'row lp-filters lp-chains' },
          chainChip('all', 'All chains', null, all.filter((r) => !!r.closed === showClosed).length),
          chainsWithRows.map((c) => chainChip(c.id, c.name, c.logo, all.filter((r) => r.chainId === c.id && !!r.closed === showClosed).length)))
      : null,
    kindRow([kindPills(dexes, view.dex, dexName, (k) => chainRows.filter((r) => dexOf(r) === k && !!r.closed === showClosed).length,
      chainRows.filter((r) => !!r.closed === showClosed).length, 'All platforms', (k) => {
        view.dex = k;
        store.refresh();
      }),
    kindPills(versions, view.version, (k) => k, (k) => dexRows.filter((r) => r.version === k && !!r.closed === showClosed).length,
      dexRows.filter((r) => !!r.closed === showClosed).length, 'All versions', (k) => {
        view.version = k;
        store.refresh();
      })]),

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
          onchange: (/** @type {Event} */ e) => {
            view.window = /** @type {HTMLSelectElement} */ (e.target).value;
            store.refresh();
            loadAprs(store);
          },
        }, Object.entries(WINDOWS).map(([key, [, label]]) => h('option', { value: key, selected: key === view.window }, label)))),
      h('label', { class: 'inline lp-sort' }, 'Sort',
        h('select', {
          'aria-label': 'Sort positions',
          onchange: (/** @type {Event} */ e) => {
            [view.sort, view.dir] = parseSort(/** @type {HTMLSelectElement} */ (e.target).value);
            store.refresh();
          },
        }, sortOptions())),
      h('div', { class: 'segmented lp-layout', role: 'group', 'aria-label': 'View' },
        /** @type {[string, string, IconName][]} */ ([['cards', 'Cards', 'cards'], ['list', 'List', 'list']]).map(([key, label, iconName]) =>
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

export default /** @satisfies {import('../../types/data').Module} */ ({
  id: 'positions',
  title: 'Liquidity Pools',
  short: 'DeFi',
  icon: 'droplet',
  collection: COLLECTION,
  defaults: { cache: {}, prices: {}, scan: {}, fees: {}, earned: {}, collected: [], history: {}, hidden: [], etherscan: {}, flip: {}, insights: [], balances: {}, tokens: [], hiddenTokens: [], lending: {} },
  render: draw,
  // Redrawn when a DeFi job's outcome changes.
  readsRunners: true,
  serialize: () => ({
    cur: view.currency === 'USD' ? '' : view.currency,
    filter: view.filter === 'all' ? '' : view.filter,
    chain: view.chain === 'all' ? '' : String(view.chain),
    dex: view.dex === 'all' ? '' : view.dex,
    ver: view.version === 'all' ? '' : view.version,
    view: view.layout === 'list' ? 'list' : '',
    sort: view.sort === 'value' && view.dir === -1 ? '' : sortName(view.sort, view.dir),
    apr: view.window === '24h' ? '' : view.window,
    tab: view.tab === 'summary' ? '' : view.tab,
    wchain: view.tab === 'wallets' && walletsView.chain !== 'all' ? String(walletsView.chain) : '',
    wallet: view.tab === 'wallets' && walletsView.wallet !== 'all' ? walletsView.wallet : '',
    lchain: view.tab === 'lending' && lendingView.chain !== 'all' ? String(lendingView.chain) : '',
    lwallet: view.tab === 'lending' && lendingView.wallet !== 'all' ? lendingView.wallet : '',
    lview: view.tab === 'lending' && lendingView.layout === 'list' ? 'list' : '',
    range: view.feeAuto ? '' : view.feeRange,
    by: view.feeGroup === defaultFeeGroup(view.feeRange) ? '' : view.feeGroup,
    fsort: view.feeSort === 'date' && view.feeDir === -1 ? '' : sortName(view.feeSort, view.feeDir),
    fchain: view.feeChain === 'all' ? '' : view.feeChain,
    ftoken: view.feeToken === 'all' ? '' : view.feeToken,
    fsource: view.feeSource === 'all' ? '' : view.feeSource,
    fdex: view.feeDex === 'all' ? '' : view.feeDex,
    fver: view.feeVersion === 'all' ? '' : view.feeVersion,
    pos: view.detail ?? '',
    from: view.detail && view.detailFrom === 'fees' ? 'fees' : '',
  }),
  /** @param {Record<string, string>} [p] */
  restore: (p = {}) => {
    view.currency = CURRENCIES.includes(p.cur) ? p.cur : 'USD';
    view.filter = ['in', 'out', 'closed'].includes(p.filter) ? p.filter : 'all';
    view.layout = p.view === 'list' ? 'list' : 'cards';
    [view.sort, view.dir] = parseSort(p.sort);
    view.window = Object.hasOwn(WINDOWS, p.apr) ? p.apr : '24h';
    const id = Number(p.chain);
    view.chain = CHAINS.some((c) => c.id === id) ? id : 'all';
    view.tab = TABS.some(([k]) => k === p.tab) ? p.tab : 'summary';
    // Checked against the rows when the tab is drawn.
    walletsView.chain = Number(p.wchain) || 'all';
    walletsView.wallet = isAddress(p.wallet) ? p.wallet.toLowerCase() : 'all';
    lendingView.chain = Number(p.lchain) || 'all';
    lendingView.wallet = isAddress(p.lwallet) ? p.lwallet.toLowerCase() : 'all';
    lendingView.layout = p.lview === 'list' ? 'list' : 'cards';
    view.feeAuto = !Object.hasOwn(FEE_RANGES, p.range);
    view.feeRange = view.feeAuto ? '7' : p.range;
    view.feeGroup = FEE_GROUPS.some(([k]) => k === p.by) ? p.by : defaultFeeGroup(view.feeRange);
    const [fkey, fdir] = String(p.fsort ?? '').split('-');
    [view.feeSort, view.feeDir] = Object.hasOwn(FEE_SORTS, fkey) ? [fkey, fdir === 'asc' ? 1 : -1] : ['date', -1];
    // Chain and token names are checked against the log when it is drawn.
    view.feeChain = p.fchain || 'all';
    view.feeToken = p.ftoken || 'all';
    view.feeSource = Object.hasOwn(SOURCE_NAMES, p.fsource) ? p.fsource : 'all';
    // Exchanges and versions are checked against the rows and the log when they are drawn.
    view.dex = p.dex || 'all';
    view.version = p.ver || 'all';
    view.feeDex = p.fdex || 'all';
    view.feeVersion = p.fver || 'all';
    // The position shown in detail, checked against the rows and the log when it is drawn.
    view.detail = typeof p.pos === 'string' && p.pos ? p.pos : null;
    view.detailFrom = p.from === 'fees' ? 'fees' : 'positions';
  },
});
