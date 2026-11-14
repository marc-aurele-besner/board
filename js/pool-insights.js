// AI insights on the Liquidity Pools tab: a read of the open positions, in range and out, with what to adjust.
// The last few reads are saved in the pools collection, so they can be opened again after a reload.
import { h, icon, money, notice, uid } from './ui.js';
import { ask, parseJson } from './ai.js';
import { systemPrompt } from './prompts.js';
import { setupBanner, hasOpenRouter } from './integrations.js';
import { CHAINS, dexName } from './uniswap.js';
/** @import { Store, PoolInsightItem, PoolInsightPosition, PoolInsightRun } from '../types/data' */
/** @import { PositionRow } from '../types/defi' */
/** @import { Child } from '../types/ui' */
/**
 * @typedef {PositionRow & { apr?: number | null }} InsightRow
 * @typedef {{ min: number, max: number, current: number, marker: number | null, unit: string, base: string }} Side
 * @typedef {{ logo: (src: string | null | undefined, label: string, cls?: string) => HTMLElement, tokens: (pos: PoolInsightPosition, live: InsightRow | undefined) => (string | null)[] }} Look
 * @typedef {{ sym0: string, sym1: string }} Pair
 */

const COLLECTION = 'pools';
const KEEP = 5;

// status and error: the read in progress. run: the saved read shown, by id ('' for the newest).
// action, range, chain: the filters on the read shown. hidden: the panel folded; folded until opened or a new read.
/** @type {{ status: string, error: string, run: string, action: string, range: string, chain: string, hidden: boolean }} */
const insight = { status: 'idle', error: '', run: '', action: 'all', range: 'all', chain: 'all', hidden: true };

// The actions the model may pick, most urgent first; the list is shown in this order.
/** @type {Record<string, [string, string]>} */
const ACTIONS = {
  withdraw: ['Withdraw', 'bad'],
  recenter: ['Re-center', 'act'],
  widen: ['Widen', 'act'],
  narrow: ['Narrow', 'act'],
  collect: ['Collect fees', 'act'],
  watch: ['Watch', 'warn'],
  keep: ['Keep', 'good'],
};
const ORDER = Object.keys(ACTIONS);
// Within this share of the range from an edge, an in-range position counts as near the edge.
const EDGE = 10;

/** @param {{ ref: string }[]} rows */
const keyOf = (rows) => rows.map((r) => r.ref).sort().join(',');
/** @param {number | null} n */
const round = (n, digits = 4) => (Number.isFinite(n) ? Number(/** @type {number} */ (n).toPrecision(digits)) : null);
/** @param {number} n */
const pctOf = (n) => (Number.isFinite(n) ? round(n * 100, 3) : null);
/** @param {number} n */
const priceText = (n) => (!Number.isFinite(n) ? '∞' : n >= 1000 ? n.toLocaleString(undefined, { maximumFractionDigits: 0 }) : n >= 1 ? n.toFixed(2) : n.toPrecision(4));
/** @param {InsightRow} r */
const nearEdge = (r) => r.inRange && !r.full && r.marker !== null && (r.marker < EDGE || r.marker > 100 - EDGE);
/** @param {number} at */
const whenText = (at) => new Date(at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
/** @param {Store} store */
const runsOf = (store) => store.get(COLLECTION)?.insights ?? [];

// The facts the model reads for one position, with prices in the pair's base as the board shows it
// (side: the min, max, current, marker, unit and base after a flip). Distances are worked out here.
/** @param {InsightRow} r @param {Side} side */
function factsOf(r, side) {
  const below = !r.inRange && side.current < side.min;
  return {
    id: r.ref,
    pair: r.pair,
    chain: r.chain,
    exchange: dexName(r.dex),
    version: r.version,
    // Staked in PancakeSwap's farm: the reward it can harvest, besides the fees.
    farming: r.staked ? { rewardToken: r.rewardSym ?? 'CAKE', pendingRewardUsd: r.rewardUsd ?? null } : null,
    feeTierPct: r.feePct,
    status: r.inRange ? 'in range' : below ? 'out of range, price below the range' : 'out of range, price above the range',
    fullRange: r.full,
    priceUnit: `${side.unit} per ${side.base}`,
    currentPrice: round(side.current, 6),
    rangeMin: r.full ? null : round(side.min, 6),
    rangeMax: r.full || !Number.isFinite(side.max) ? null : round(side.max, 6),
    // max / min - 1: how wide the range is.
    rangeWidthPct: r.full || !(side.min > 0) || !Number.isFinite(side.max) ? null : pctOf(side.max / side.min - 1),
    // Where the price sits in the range on a log scale: 0 at the lower edge, 100 at the upper.
    positionInRangePct: r.inRange && side.marker !== null ? round(side.marker, 3) : null,
    // In range: the move to the nearer edge. Out of range: the move needed to get back in.
    moveToLowerEdgePct: r.inRange && side.min > 0 ? pctOf(side.min / side.current - 1) : null,
    moveToUpperEdgePct: r.inRange && Number.isFinite(side.max) ? pctOf(side.max / side.current - 1) : null,
    moveBackInPct: r.inRange ? null : pctOf((below ? side.min : side.max) / side.current - 1),
    valueUsd: round(r.value, 6),
    unclaimedFeesUsd: round(r.fees, 6),
    feeAprPct: r.apr == null ? null : pctOf(r.apr),
    token0: r.sym0,
    shareInToken0Pct: r.share0 == null ? null : round(r.share0 * 100, 3),
  };
}

// What a saved read keeps of a position, so it still shows once the position changed or closed.
/**
 * @param {InsightRow} r
 * @param {Side} side
 * @returns {PoolInsightPosition}
 */
function snapshotOf(r, side) {
  return {
    pair: r.pair, chain: r.chain, feePct: r.feePct, tokenId: r.tokenId, url: r.url ?? '', inRange: r.inRange, full: r.full,
    sym0: r.sym0, sym1: r.sym1, unit: side.unit, base: side.base,
    min: side.min, max: Number.isFinite(side.max) ? side.max : null, current: side.current,
  };
}

// Keeps only what the board can show: known ids and actions, and a range with min below max.
/**
 * @param {any} data any: the model's JSON reply, checked field by field here
 * @param {InsightRow[]} rows
 * @returns {{ summary: string, items: Omit<PoolInsightItem, 'pos'>[] }}
 */
function cleanReply(data, rows) {
  const known = new Set(rows.map((r) => r.ref));
  // What the model sent for a position; id and action are checked by the first filter.
  const items = /** @type {{ id: string, action: string, headline?: unknown, reason?: unknown, range?: { min?: unknown, max?: unknown } }[]} */ (Array.isArray(data?.positions) ? data.positions : [])
    .filter((p) => known.has(p?.id) && Object.hasOwn(ACTIONS, p.action))
    // One entry per position: the first the model gave.
    .filter((p, i, list) => list.findIndex((q) => q.id === p.id) === i)
    .map((p) => {
      const min = Number(p.range?.min);
      const max = Number(p.range?.max);
      return {
        ref: p.id,
        action: p.action,
        headline: String(p.headline ?? '').slice(0, 120),
        reason: String(p.reason ?? '').slice(0, 600),
        range: min >= 0 && max > min && Number.isFinite(max) ? { min, max } : null,
      };
    });
  return { summary: String(data?.summary ?? '').slice(0, 1200), items };
}

/** @param {Store} store @param {InsightRow[]} rows @param {(r: InsightRow) => Side} sideOf */
async function run(store, rows, sideOf) {
  insight.status = 'loading';
  insight.error = '';
  insight.hidden = false;
  store.refresh();
  try {
    const sides = new Map(rows.map((r) => [r.ref, sideOf(r)]));
    const reply = await ask(store, 'task-pools', [
      { role: 'system', content: systemPrompt(store, 'pools') },
      { role: 'user', content: JSON.stringify({ positions: rows.map((r) => factsOf(r, /** @type {Side} */ (sides.get(r.ref)))) }) },
    ]);
    const { summary, items } = cleanReply(parseJson(reply), rows);
    if (!items.length && !summary) throw new Error('The model returned nothing usable. Try again or pick another model in Settings.');
    const byRef = new Map(rows.map((r) => [r.ref, r]));
    const saved = {
      id: uid(),
      at: Date.now(),
      key: keyOf(rows),
      summary,
      items: items.map((it) => ({ ...it, pos: snapshotOf(/** @type {InsightRow} */ (byRef.get(it.ref)), /** @type {Side} */ (sides.get(it.ref))) })),
    };
    Object.assign(insight, { status: 'idle', run: '', action: 'all', range: 'all', chain: 'all' });
    store.update(COLLECTION, (d) => {
      d.insights = [saved, ...(d.insights ?? [])].slice(0, KEEP);
    });
  } catch (err) {
    insight.status = 'error';
    insight.error = /** @type {Error} */ (err).message;
    store.refresh();
  }
}

// A saved range in the base the pair is shown in now; a read from before a flip is turned over.
/** @param {PoolInsightPosition} pos @param {boolean} flipped @param {{ min: number, max: number, current?: number }} range */
function inBase(pos, flipped, range) {
  const unit = flipped ? pos.sym0 : pos.sym1;
  if (unit === pos.unit || !range) return { ...range, unit: pos.unit, base: pos.base };
  return {
    min: range.max == null || !Number.isFinite(range.max) ? 0 : 1 / range.max,
    max: range.min > 0 ? 1 / range.min : Infinity,
    // A suggested range has no current price, and undefined > 0 is false.
    current: /** @type {number} */ (range.current) > 0 ? 1 / /** @type {number} */ (range.current) : null,
    unit: pos.base,
    base: pos.unit,
  };
}

/** @param {PoolInsightItem} it @param {InsightRow | undefined} live @param {boolean} flipped @param {Look} look */
function item(it, live, flipped, look) {
  const [label, tone] = ACTIONS[it.action];
  const pos = it.pos;
  const now = inBase(pos, flipped, { min: pos.min, max: pos.max ?? Infinity, current: pos.current });
  const suggested = it.range ? inBase(pos, flipped, it.range) : null;
  const changed = live && live.inRange !== pos.inRange;
  return h('li', { class: 'insight-item' },
    h('div', { class: 'insight-top' },
      h('span', { class: `insight-action ${tone}` }, label),
      h('span', { class: 'pair insight-pair' }, look.tokens(pos, live).map((src, i) => look.logo(src, i ? pos.sym1 : pos.sym0, i ? 'xs second' : 'xs'))),
      h('strong', null, pos.pair),
      h('span', { class: 'muted small' }, `${pos.chain} · ${pos.feePct}% · #${pos.tokenId}`),
      h('span', { class: pos.inRange ? 'status-pill in' : 'status-pill out' }, h('span', { class: 'dot' }), pos.inRange ? 'In range' : 'Out of range'),
      changed ? h('span', { class: 'muted small' }, `now ${live.inRange ? 'in range' : 'out of range'}`) : null,
      !live ? h('span', { class: 'muted small' }, 'no longer open') : null,
      pos.url ? h('a', { href: pos.url, target: '_blank', rel: 'noopener', class: 'icon-btn insight-open', title: 'Open on Uniswap', 'aria-label': `Open position ${pos.tokenId} on Uniswap` }, icon('link')) : null),
    it.headline ? h('div', { class: 'insight-headline' }, it.headline) : null,
    it.reason ? h('p', { class: 'muted small' }, it.reason) : null,
    suggested
      ? h('div', { class: 'insight-range small' },
          h('span', { class: 'muted' }, 'Suggested range'),
          h('strong', null, `${priceText(suggested.min)} – ${priceText(suggested.max)} ${suggested.unit} per ${suggested.base}`),
          pos.full ? null : h('span', { class: 'muted' }, `was ${priceText(now.min)} – ${priceText(now.max)}`),
          now.current ? h('span', { class: 'muted' }, `price ${priceText(now.current)}`) : null)
      : null);
}

// The same status dot the positions list shows: green in range, red out of range.
/** @param {string} kind */
const dot = (kind) => h('span', { class: `pos-dot ${kind}`, 'aria-hidden': 'true' });

// The chips over a read's list: by action, by range status, and by chain when there are several.
/** @param {Store} store @param {PoolInsightItem[]} items @param {Look} look */
function filters(store, items, look) {
  /** @param {'action' | 'range' | 'chain'} key @param {string} value @param {string} label @param {number} n @param {Child} [lead] */
  const chip = (key, value, label, n, lead = null) => h('button', {
    type: 'button',
    class: `lp-chip${key === 'chain' ? ' chain' : ''}${insight[key] === value ? ' active' : ''}`,
    'aria-pressed': String(insight[key] === value),
    onclick: () => {
      insight[key] = value;
      store.refresh();
    },
  }, lead, label, h('span', { class: 'chip-count' }, n));
  /** @param {(it: PoolInsightItem) => boolean} pred */
  const count = (pred) => items.filter(pred).length;
  const actions = ORDER.filter((a) => items.some((it) => it.action === a));
  const chains = [...new Set(items.map((it) => it.pos.chain))].sort((a, b) => a.localeCompare(b));
  return h('div', { class: 'stack insight-filters' },
    h('div', { class: 'row lp-filters' },
      chip('action', 'all', 'All actions', items.length),
      actions.map((a) => chip('action', a, ACTIONS[a][0], count((it) => it.action === a)))),
    h('div', { class: 'row lp-filters' },
      chip('range', 'all', 'Any range', items.length),
      chip('range', 'in', 'In range', count((it) => it.pos.inRange), dot('in')),
      chip('range', 'out', 'Out of range', count((it) => !it.pos.inRange), dot('out')),
      chains.length > 1 ? chip('chain', 'all', 'All chains', items.length) : null,
      chains.length > 1 ? chains.map((c) => chip('chain', c, c, count((it) => it.pos.chain === c), look.logo(CHAINS.find((x) => x.name === c)?.logo, c, 'xs'))) : null));
}

// The saved reads as tabs, newest first, each named by its date and time.
/** @param {Store} store @param {PoolInsightRun[]} runs @param {PoolInsightRun} shown */
function tabs(store, runs, shown) {
  if (runs.length < 2) return null;
  return h('div', { class: 'segmented insight-tabs', role: 'tablist', 'aria-label': 'Saved insights' },
    runs.map((r, i) => h('button', {
      type: 'button',
      role: 'tab',
      class: r.id === shown.id ? 'seg active' : 'seg',
      'aria-selected': String(r.id === shown.id),
      title: i === 0 ? 'The latest read' : `A read from ${whenText(r.at)}`,
      onclick: () => {
        insight.run = i === 0 ? '' : r.id;
        store.refresh();
      },
    }, whenText(r.at))));
}

/** @param {Store} store @param {InsightRow[]} rows @param {PoolInsightRun} shown @param {(pos: Pair) => boolean} isFlipped @param {Look} look */
function runView(store, rows, shown, isFlipped, look) {
  const live = new Map(rows.map((r) => [r.ref, r]));
  const latest = runsOf(store)[0]?.id === shown.id;
  const items = shown.items
    .filter((it) => it.pos)
    .sort((a, b) => ORDER.indexOf(a.action) - ORDER.indexOf(b.action));
  const picked = items.filter((it) =>
    (insight.action === 'all' || it.action === insight.action) &&
    (insight.range === 'all' || (insight.range === 'in') === it.pos.inRange) &&
    (insight.chain === 'all' || it.pos.chain === insight.chain));
  return h('div', { class: 'stack' },
    latest && shown.key !== keyOf(rows)
      ? notice({ tone: 'info', text: 'The positions changed since this read. Ask again for an up-to-date one.' })
      : null,
    shown.summary ? h('p', null, shown.summary) : null,
    items.length > 1 ? filters(store, items, look) : null,
    picked.length
      ? h('ul', { class: 'insight-list' }, picked.map((it) => item(it, live.get(it.ref), isFlipped(it.pos), look)))
      : items.length ? h('p', { class: 'muted small' }, 'No insights match these filters.') : null,
    h('p', { class: 'muted small' }, `Read ${whenText(shown.at)}. An AI read of the numbers above, not financial advice.`));
}

// rows: the open positions on screen (closed ones left out), with fee APR when it is known.
// sideOf(r): the row's prices in the base the board shows. isFlipped(pair): whether a pair is shown flipped.
// cash(n): formats a USD amount in the currency the page shows.
/**
 * @param {Store} store
 * @param {InsightRow[]} rows
 * @param {{ sideOf: (r: InsightRow) => Side, isFlipped: (pos: Pair) => boolean, logo: Look['logo'], tokenLogos: Look['tokens'], cash?: (n: number) => string }} options
 */
export function insightsPanel(store, rows, { sideOf, isFlipped, logo, tokenLogos, cash = (n) => money(n, 'USD') }) {
  if (!rows.length) return null;
  const out = rows.filter((r) => !r.inRange);
  const edge = rows.filter(nearEdge);
  const outValue = out.reduce((s, r) => s + (r.value ?? 0), 0);
  const tally = [
    `${rows.length - out.length} in range`,
    `${out.length} out of range${outValue > 0 ? ` (${cash(outValue)} idle)` : ''}`,
    edge.length ? `${edge.length} near an edge` : '',
  ].filter(Boolean).join(' · ');

  const runs = runsOf(store);
  const shown = runs.find((r) => r.id === insight.run) ?? runs[0] ?? null;
  const loading = insight.status === 'loading';
  const open = !insight.hidden && (shown || insight.status !== 'idle');
  const button = h('button', {
    type: 'button',
    class: 'btn-small',
    disabled: loading || !hasOpenRouter(store),
    onclick: () => run(store, rows, sideOf),
  }, icon('sparkle'), loading ? 'Reading…' : runs.length ? 'Ask again' : 'Get insights');
  const toggle = shown || insight.status === 'error'
    ? h('button', {
        type: 'button',
        class: 'btn-small',
        onclick: () => {
          // open is false or truthy, and hidden is only tested for truth.
          insight.hidden = /** @type {boolean} */ (open);
          if (insight.status === 'error') insight.status = 'idle';
          store.refresh();
        },
      }, open ? 'Hide' : runs.length > 1 ? `Show ${runs.length} saved` : 'Show')
    : null;

  const head = h('div', { class: 'row between' },
    h('div', null,
      h('h3', { class: 'insight-title' }, icon('sparkle'), 'AI insights'),
      h('p', { class: 'muted small' }, tally)),
    h('div', { class: 'row' }, toggle, button));

  // Saved reads stay readable without a key; only a new read needs one.
  const banner = hasOpenRouter(store) ? null : setupBanner('openrouter', 'AI insights need an OpenRouter key.');
  let body = banner;
  if (open) {
    body = h('div', { class: 'stack' },
      banner,
      insight.status === 'error' ? notice({ text: insight.error }) : null,
      loading ? h('p', { class: 'muted small' }, `Reading ${rows.length} position${rows.length === 1 ? '' : 's'}…`) : null,
      shown ? tabs(store, runs, shown) : null,
      shown ? runView(store, rows, shown, isFlipped, { logo, tokens: tokenLogos }) : null);
  }

  return h('section', { class: 'card stack lp-insights' }, head, body);
}
