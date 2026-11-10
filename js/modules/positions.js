import { h, icon, money, empty, notice } from '../ui.js';
import { setupBanner } from '../integrations.js';
import { readPositions, poolState, tokenMeta, usdPrices, positionAmounts, priceAtTick, isAddress, DEFAULT_NODE } from '../uniswap.js';

const STALE_MS = 10 * 60 * 1000;
const MAX_TICK = 887272; // the widest possible range: a "full range" position

// View state: which rows are shown.
const view = { filter: 'all' };
// Loaded positions and the state of the last load.
const state = { status: 'idle', rows: [], error: '', warning: '', at: 0 };
const tokenInfo = new Map(); // token address -> { symbol, decimals }
let loading = false;

// Builds one row from a position, its pool's current state and the token prices.
function buildRow(p, pool, prices) {
  if (!pool) return null;
  const m0 = tokenInfo.get(p.token0) ?? { symbol: '?', decimals: 18 };
  const m1 = tokenInfo.get(p.token1) ?? { symbol: '?', decimals: 18 };
  const raw = positionAmounts(p, pool.sqrtPrice);
  const a0 = raw.a0 / 10 ** m0.decimals;
  const a1 = raw.a1 / 10 ** m1.decimals;
  const p0 = prices[p.token0.toLowerCase()] ?? null;
  const p1 = prices[p.token1.toLowerCase()] ?? null;
  const priced = p0 !== null && p1 !== null;
  const value = priced ? a0 * p0 + a1 * p1 : null;
  const fees = priced ? (Number(p.owed0) / 10 ** m0.decimals) * p0 + (Number(p.owed1) / 10 ** m1.decimals) * p1 : null;
  return {
    tokenId: p.tokenId,
    owner: p.label,
    pair: `${m0.symbol} / ${m1.symbol}`,
    sym0: m0.symbol,
    sym1: m1.symbol,
    feePct: p.fee / 10000,
    inRange: pool.tick >= p.tickLower && pool.tick < p.tickUpper,
    min: p.tickLower <= -MAX_TICK ? 0 : priceAtTick(p.tickLower, m0.decimals, m1.decimals),
    max: p.tickUpper >= MAX_TICK ? Infinity : priceAtTick(p.tickUpper, m0.decimals, m1.decimals),
    a0,
    a1,
    value,
    fees,
    share0: value ? (a0 * p0) / value : null,
    url: `https://app.uniswap.org/positions/v3/ethereum/${p.tokenId}`,
  };
}

// Reads every wallet's positions, their pools and the token prices.
async function load(store) {
  if (loading) return;
  loading = true;
  state.status = 'loading';
  state.error = '';
  store.refresh();
  try {
    const cfg = store.get('settings').uniswap ?? {};
    const node = cfg.node || DEFAULT_NODE;
    const wallets = (cfg.wallets ?? []).filter((w) => isAddress(w.address));
    const perWallet = await Promise.all(wallets.map(async (w) => (await readPositions(node, w.address)).map((p) => ({ ...p, label: w.label || w.address }))));
    const positions = perWallet.flat();

    const tokens = [...new Set(positions.flatMap((p) => [p.token0, p.token1]))];
    await Promise.all(tokens.filter((t) => !tokenInfo.has(t)).map(async (t) => tokenInfo.set(t, await tokenMeta(node, t))));

    const pools = new Map();
    const poolKeys = [...new Set(positions.map((p) => `${p.token0}|${p.token1}|${p.fee}`))];
    await Promise.all(poolKeys.map(async (key) => {
      const [token0, token1, fee] = key.split('|');
      pools.set(key, await poolState(node, { token0, token1, fee: Number(fee) }).catch(() => null));
    }));

    let prices = {};
    state.warning = '';
    try {
      prices = await usdPrices(tokens);
    } catch (err) {
      state.warning = `Token prices are unavailable (${err.message}), so values are not shown.`;
    }

    state.rows = positions
      .map((p) => buildRow(p, pools.get(`${p.token0}|${p.token1}|${p.fee}`), prices))
      .filter(Boolean)
      .sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
    state.status = 'ok';
    state.at = Date.now();
  } catch (err) {
    state.status = 'error';
    state.error = err.message;
  } finally {
    loading = false;
    store.refresh();
  }
}

const amount = (n) => (n >= 1000 ? n.toLocaleString(undefined, { maximumFractionDigits: 0 }) : n >= 1 ? n.toFixed(2) : n.toPrecision(4));
const price = (n) => (n === Infinity ? '∞' : n === 0 ? '0' : amount(n));
const usdOrDash = (n) => (n === null ? '—' : money(n, 'USD'));

function stat(label, value) {
  return h('div', { class: 'card lp-stat' },h('span', { class: 'muted' }, label), h('strong', null, value));
}

// The price range with a marker for the current price, as in Uniswap's own list.
function rangeBar(row) {
  const lo = row.min;
  const hi = row.max;
  return h('div', { class: 'range-cell' },
    h('div', { class: 'range-text' }, `${price(lo)} → ${price(hi)} ${row.sym1}`),
    h('div', { class: row.inRange ? 'range-status in' : 'range-status out' }, row.inRange ? 'In range' : 'Out of range'));
}

// The token split as a bar: the share of value in each token.
function distribution(row) {
  if (row.share0 === null) return h('span', { class: 'muted small' }, `${amount(row.a0)} ${row.sym0} · ${amount(row.a1)} ${row.sym1}`);
  const pct0 = Math.round(row.share0 * 100);
  return h('div', { class: 'dist-cell' },
    h('div', { class: 'dist-bar' },
      h('span', { class: 'dist-a', style: { width: `${pct0}%` } }),
      h('span', { class: 'dist-b', style: { width: `${100 - pct0}%` } })),
    h('div', { class: 'muted small' }, `${pct0}% ${row.sym0} · ${100 - pct0}% ${row.sym1}`));
}

function draw(root, store) {
  const cfg = store.get('settings').uniswap ?? {};
  const wallets = (cfg.wallets ?? []).filter((w) => isAddress(w.address));
  if (!wallets.length) {
    return root.replaceChildren(h('div', { class: 'stack-lg' },
      h('h2', null, 'LP positions'),
      setupBanner('uniswap', 'Add a wallet address in Settings to see its Uniswap positions.')));
  }
  if (state.status === 'idle' || (state.status === 'ok' && Date.now() - state.at > STALE_MS)) {
    setTimeout(() => load(store), 0);
  }

  const rows = state.rows;
  const inRange = rows.filter((r) => r.inRange).length;
  const shown = view.filter === 'in' ? rows.filter((r) => r.inRange) : view.filter === 'out' ? rows.filter((r) => !r.inRange) : rows;
  const totalValue = rows.reduce((s, r) => s + (r.value ?? 0), 0);
  const totalFees = rows.reduce((s, r) => s + (r.fees ?? 0), 0);
  const chip = (key, label, count) => h('button', {
    type: 'button',
    class: view.filter === key ? 'lp-chip active' : 'lp-chip',
    onclick: () => {
      view.filter = key;
      store.refresh();
    },
  }, `${label} ${count}`);

  root.replaceChildren(h('div', { class: 'stack-lg lp' },
    h('div', { class: 'row between lp-head' },
      h('div', null,
        h('h2', null, 'LP positions'),
        h('p', { class: 'muted small' }, 'Your Uniswap v3 positions on Ethereum, read from the chain. Read-only.')),
      h('button', { type: 'button', class: 'btn-small', disabled: state.status === 'loading', onclick: () => load(store) }, icon('refresh'), state.status === 'loading' ? 'Reading…' : 'Refresh')),

    state.warning ? notice({ tone: 'info', text: state.warning }) : null,
    state.status === 'error' ? notice({ text: `The positions could not be read: ${state.error}` }) : null,

    h('div', { class: 'lp-stats' },
      stat('Total liquidity', usdOrDash(rows.some((r) => r.value !== null) ? totalValue : null)),
      stat('Unclaimed fees', usdOrDash(rows.some((r) => r.fees !== null) ? totalFees : null)),
      stat('Positions', `${rows.length} · ${inRange} in range`)),

    h('div', { class: 'row lp-filters' },
      chip('all', 'All', rows.length),
      chip('in', 'In range', inRange),
      chip('out', 'Out of range', rows.length - inRange)),

    shown.length
      ? h('div', { class: 'lp-table-wrap' },
          h('table', { class: 'lp-table' },
            h('thead', null, h('tr', null,
              h('th', null, 'Pool'),
              h('th', null, 'Price range'),
              h('th', null, 'Distribution'),
              h('th', { class: 'num' }, 'Value'),
              h('th', { class: 'num' }, 'Fees'),
              h('th', null, ''))),
            h('tbody', null, shown.map((r) =>
              h('tr', null,
                h('td', null,
                  h('strong', null, r.pair),
                  h('div', { class: 'muted small' }, `v3 · ${r.feePct}% · #${r.tokenId}`),
                  h('div', { class: 'muted small' }, r.owner)),
                h('td', null, rangeBar(r)),
                h('td', null, distribution(r)),
                h('td', { class: 'num' }, usdOrDash(r.value)),
                h('td', { class: 'num' }, usdOrDash(r.fees)),
                h('td', null, h('a', { href: r.url, target: '_blank', rel: 'noopener', class: 'icon-btn', title: 'Open on Uniswap', 'aria-label': `Open position ${r.tokenId} on Uniswap` }, icon('link'))))))))
      : empty(state.status === 'loading' ? 'Reading your positions…' : 'No open positions for these wallets.')));
}

export default {
  id: 'positions',
  title: 'LP positions',
  icon: 'wallet',
  collection: null,
  defaults: {},
  render: draw,
  serialize: () => ({ filter: view.filter === 'all' ? '' : view.filter }),
  restore: (p = {}) => {
    view.filter = ['in', 'out'].includes(p.filter) ? p.filter : 'all';
  },
};
