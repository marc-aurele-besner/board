import { h, icon, money, empty, notice } from '../ui.js';
import { setupBanner } from '../integrations.js';
import { poolsChanged } from '../automations.js';
import { readPositions, poolState, tokenMeta, usdPrices, positionAmounts, priceAtTick, isAddress, CHAINS, chainSettings, tokenLogos, scanV4, readV4Position } from '../uniswap.js';

const STALE_MS = 10 * 60 * 1000;
const MAX_TICK = 887272; // the widest possible range: a "full range" position

// View state: which rows are shown.
// layout: 'cards' or 'list'.
const view = { filter: 'all', chain: 'all', layout: 'cards' };
// Loaded positions and the state of the last load. shallow: chains whose node would not search back to v4's start.
// stale: chains shown from the last good read because this one failed, with when that read was.
const state = { status: 'idle', rows: [], error: '', warning: '', at: 0, shallow: [], stale: [] };
// pools.json keeps the last good read of each chain and version, the last good prices of each chain, and how far
// each v4 search got. A read that fails then shows the old rows, marked as possibly out of date.
const COLLECTION = 'pools';
const tokenInfo = new Map(); // "chainId:token address" -> { symbol, decimals }
let loading = false;
let logoMap = new Map(); // "chainId:token address" -> logo URL, from the token list
let logosAsked = false;
let shownAt = 0; // the load whose cards are already on screen; new loads animate once

const tokenKey = (chain, address) => `${chain.id}:${address}`;

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
  const fees = priced ? (Number(p.owed0) / 10 ** m0.decimals) * p0 + (Number(p.owed1) / 10 ** m1.decimals) * p1 : null;
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
    // v3 rows keep their old key, so tasks made before v4 still match.
    ref: p.version === 'v3' ? `${chain.id}:${p.tokenId}` : `${chain.id}:${p.version}:${p.tokenId}`,
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
    value,
    fees,
    share0: value ? (a0 * p0) / value : null,
    url: chain.app ? `https://app.uniswap.org/positions/${p.version}/${chain.app}/${p.tokenId}` : null,
  };
}

const shortAddress = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const hasValue = (p) => p.liquidity > 0n || p.owed0 > 0n || p.owed1 > 0n;

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
  const manual = new Set((cfg.v4ids ?? []).filter((x) => x.chainId === chain.id).map((x) => String(x.tokenId)));
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

// Reads one chain: every wallet's v3 and v4 positions there, their pools and the token prices.
// v3 or v4 is null when it could not be read. saved holds this chain's v4 search state and last good prices.
async function readChain(chain, node, wallets, cfg, saved) {
  // v3 and v4 are read side by side, so one failing does not hide the other.
  const [v3Read, v4Read] = await Promise.allSettled([
    Promise.all(wallets.map(async (w) => (await readPositions(chain, node, w.address)).map((p) => ({ ...p, label: w.label || w.address })))),
    readV4(chain, node, wallets, cfg, saved.scan),
  ]);
  if (v3Read.status === 'rejected' && v4Read.status === 'rejected') throw v3Read.reason;
  const positions = v3Read.status === 'fulfilled' ? v3Read.value.flat() : [];
  const v4 = v4Read.status === 'fulfilled' ? v4Read.value : { items: [], scans: null };
  let warning = [
    v3Read.status === 'rejected' ? `${chain.name} v3 positions could not be read: ${v3Read.reason.message}` : '',
    v4Read.status === 'rejected' ? `${chain.name} v4 positions could not be read: ${v4Read.reason.message}` : '',
  ].filter(Boolean).join(' ');

  const tokens = [...new Set([...positions, ...v4.items.map((x) => x.position)].flatMap((p) => [p.token0, p.token1]))];
  await Promise.all(tokens.filter((t) => !tokenInfo.has(tokenKey(chain, t))).map(async (t) => tokenInfo.set(tokenKey(chain, t), await tokenMeta(node, t, chain))));

  const pools = new Map();
  const poolKeys = [...new Set(positions.map((p) => `${p.token0}|${p.token1}|${p.fee}`))];
  await Promise.all(poolKeys.map(async (key) => {
    const [token0, token1, fee] = key.split('|');
    pools.set(key, await poolState(chain, node, { token0, token1, fee: Number(fee) }).catch(() => null));
  }));

  // Prices that fail fall back to the last ones read for this chain.
  let prices = {};
  let pricesAt = null;
  let freshPrices = null;
  try {
    prices = await usdPrices(chain, tokens);
    freshPrices = prices;
  } catch (err) {
    if (saved.prices) {
      prices = saved.prices.usd;
      pricesAt = saved.prices.at;
      warning = [warning, `${chain.name} token prices could not be read (${err.message}), so values use the prices from ${ago(pricesAt)}.`].filter(Boolean).join(' ');
    } else {
      warning = [warning, `${chain.name} token prices are unavailable (${err.message}), so values are not shown.`].filter(Boolean).join(' ');
    }
  }

  return {
    v3: v3Read.status === 'fulfilled' ? positions.map((p) => buildRow(p, pools.get(`${p.token0}|${p.token1}|${p.fee}`), prices, chain, pricesAt)).filter(Boolean) : null,
    v4: v4Read.status === 'fulfilled' ? v4.items.map((x) => buildRow(x.position, x.pool, prices, chain, pricesAt)).filter(Boolean) : null,
    warning,
    scans: v4.scans,
    prices: freshPrices,
  };
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
  const manual = new Set((cfg.v4ids ?? []).map((x) => `${x.chainId}:v4:${x.tokenId}`));
  return keys.flatMap((key) => (cache[key]?.rows ?? [])
    .filter((r) => wallets.has(r.wallet) || manual.has(r.ref))
    .map((r) => ({ ...r, max: r.max ?? Infinity, staleAt: cache[key].at })));
}
const cacheKeys = (chains) => chains.flatMap((c) => [`${c.id}:v3`, `${c.id}:v4`]);
const enabledChains = (cfg) => CHAINS.filter((chain) => chainSettings(cfg, chain).enabled);

// Reads every enabled chain in parallel. A chain that fails is reported and does not stop the others.
async function load(store) {
  if (loading) return;
  loading = true;
  state.status = 'loading';
  state.error = '';
  store.refresh();
  try {
    const cfg = store.get('settings').uniswap ?? {};
    const wallets = (cfg.wallets ?? []).filter((w) => isAddress(w.address));
    const chains = CHAINS.map((chain) => ({ chain, ...chainSettings(cfg, chain) })).filter((c) => c.enabled);
    const saved = store.get(COLLECTION) ?? {};
    const results = await Promise.all(chains.map(({ chain, node }) => readChain(chain, node, wallets, cfg, { scan: saved.scan?.[chain.id] ?? {}, prices: saved.prices?.[chain.id] })
      .catch((err) => ({ v3: null, v4: null, warning: `${chain.name} could not be read: ${err.message}` }))));

    // Fresh rows replace the saved ones. A chain and version that failed shows its last good read instead.
    const now = Date.now();
    const rows = [];
    const cache = {};
    const prices = {};
    const scans = {};
    const stale = new Map();
    chains.forEach(({ chain }, i) => {
      const r = results[i];
      for (const version of ['v3', 'v4']) {
        const key = `${chain.id}:${version}`;
        if (r[version]) {
          rows.push(...r[version]);
          cache[key] = { at: now, rows: r[version] };
        } else {
          const old = savedRows(store, cfg, [key]);
          rows.push(...old);
          if (saved.cache?.[key]) stale.set(chain.name, Math.min(stale.get(chain.name) ?? Infinity, saved.cache[key].at));
        }
      }
      if (r.prices) prices[chain.id] = { at: now, usd: { ...saved.prices?.[chain.id]?.usd, ...r.prices } };
      // Keep how far each v4 search got, so the next load goes on from there.
      if (r.scans) scans[chain.id] = r.scans;
    });
    state.stale = [...stale].map(([name, at]) => ({ name, at }));
    state.shallow = chains
      .filter(({ chain }) => Object.values(scans[chain.id] ?? {}).some((s) => s?.done && s.from > chain.v4.start))
      .map(({ chain }) => chain.name);
    store.update(COLLECTION, (d) => {
      d.cache = { ...d.cache, ...cache };
      d.prices = { ...d.prices, ...prices };
      d.scan = { ...d.scan, ...scans };
    });

    state.warning = results.map((r) => r.warning).filter(Boolean).join(' ');
    state.rows = rows.sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
    state.status = 'ok';
    state.at = Date.now();
    // Tell the automation rules and the notifications which positions left their range. Old rows are left out.
    poolsChanged(store, state.rows.filter((r) => !r.staleAt));
  } catch (err) {
    state.status = 'error';
    state.error = err.message;
  } finally {
    loading = false;
    store.refresh();
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

function poolStat(label, value) {
  return h('div', { class: 'pool-stat' }, h('span', null, label), h('strong', null, value));
}

// One position as a card: the pair, its chain and fee, the range, the value and the token split.
function poolCard(r, i) {
  const chain = chainOf(r.chainId);
  return h('article', { class: `pool-card ${r.inRange ? 'is-in' : 'is-out'}`, style: { '--i': i } },
    h('header', { class: 'pool-head' },
      h('div', { class: 'pair' },
        logo(tokenLogoOf(r, r.addr0), r.sym0, 'token'),
        logo(tokenLogoOf(r, r.addr1), r.sym1, 'token second')),
      h('div', { class: 'pool-title' },
        h('strong', null, r.pair),
        h('div', { class: 'pool-meta' },
          h('span', { class: 'chain-chip' }, logo(chain?.logo, r.chain, 'xs'), r.chain),
          h('span', { class: 'fee-pill' }, `${r.feePct}%`),
          h('span', { class: r.inRange ? 'status-pill in' : 'status-pill out' },
            h('span', { class: 'dot' }),
            r.inRange ? 'In range' : 'Out of range'),
          outdatedPill(r))),
      r.url ? h('a', { href: r.url, target: '_blank', rel: 'noopener', class: 'icon-btn pool-open', title: 'Open on Uniswap', 'aria-label': `Open position ${r.tokenId} on Uniswap` }, icon('link')) : null),
    rangeView(r),
    h('div', { class: 'pool-stats' },
      poolStat('Value', usdOrDash(r.value)),
      poolStat('Unclaimed fees', usdOrDash(r.fees))),
    distribution(r),
    h('footer', { class: 'pool-foot muted small' },
      h('span', null, r.owner),
      h('span', null, `${r.version} · #${r.tokenId}`)));
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

// Counts a number up to its value, once per load.
function countUp(el, to, format) {
  const start = performance.now();
  const duration = 900;
  const step = (now) => {
    const t = Math.min(1, (now - start) / duration);
    const eased = 1 - (1 - t) ** 3;
    el.textContent = format(to * eased);
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
function poolTable(rows) {
  return h('div', { class: 'card mon-scroll' },
    h('table', { class: 'mon-table lp-table' },
      h('thead', null, h('tr', null,
        h('th', null, 'Pool'), h('th', null, 'Chain'), h('th', null, 'Price range'), h('th', null, 'Distribution'),
        h('th', { class: 'num' }, 'Value'), h('th', { class: 'num' }, 'Unclaimed fees'), h('th', null, ''))),
      h('tbody', null, rows.map((r) =>
        h('tr', null,
          h('td', null, h('div', { class: 'row' },
            h('div', { class: 'pair' }, logo(tokenLogoOf(r, r.addr0), r.sym0, 'token'), logo(tokenLogoOf(r, r.addr1), r.sym1, 'token second')),
            h('div', null, h('strong', null, r.pair), outdatedPill(r), h('div', { class: 'muted small' }, `${r.owner} · ${r.version} · #${r.tokenId}`)))),
          h('td', null, h('span', { class: 'chain-chip' }, logo(chainOf(r.chainId)?.logo, r.chain, 'xs'), r.chain), h('div', { class: 'muted small' }, `${r.feePct}% fee`)),
          h('td', null,
            h('div', null, r.full ? 'Full range' : `${price(r.min)} → ${price(r.max)} ${r.sym1}`),
            h('div', { class: 'row' },
              h('span', { class: r.inRange ? 'status-pill in' : 'status-pill out' }, h('span', { class: 'dot' }), r.inRange ? 'In range' : 'Out of range'),
              r.full ? null : h('span', { class: 'muted small' }, `now ${price(r.current)}`))),
          h('td', null, distribution(r)),
          h('td', { class: 'num' }, usdOrDash(r.value)),
          h('td', { class: 'num' }, usdOrDash(r.fees)),
          h('td', null, r.url
            ? h('a', { href: r.url, target: '_blank', rel: 'noopener', class: 'icon-btn', title: 'Open on Uniswap', 'aria-label': `Open position ${r.tokenId} on Uniswap` }, icon('link'))
            : null))))));
}

function draw(root, store) {
  const cfg = store.get('settings').uniswap ?? {};
  const wallets = (cfg.wallets ?? []).filter((w) => isAddress(w.address));
  if (!wallets.length) {
    return root.replaceChildren(h('div', { class: 'stack-lg' },
      h('h2', null, 'Liquidity Pools'),
      setupBanner('uniswap', 'Add a wallet address in Settings to see its Uniswap positions.')));
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
  const shown = view.filter === 'in' ? byChain.filter((r) => r.inRange) : view.filter === 'out' ? byChain.filter((r) => !r.inRange) : byChain;
  const totalValue = byChain.reduce((s, r) => s + (r.value ?? 0), 0);
  const totalFees = byChain.reduce((s, r) => s + (r.fees ?? 0), 0);
  const totalValueKnown = byChain.some((r) => r.value !== null);
  const totalFeesKnown = byChain.some((r) => r.fees !== null);

  // Count up the totals only when a new read lands, not on every filter click.
  const fresh = state.status === 'ok' && state.at !== shownAt;
  if (fresh) shownAt = state.at;
  const counters = [];

  const valueEl = h('strong', null, '—');
  const feesEl = h('strong', null, '—');
  if (totalValueKnown) {
    if (fresh) counters.push(() => countUp(valueEl, totalValue, (n) => money(n, 'USD')));
    else valueEl.textContent = usdOrDash(totalValue);
  }
  if (totalFeesKnown) {
    if (fresh) counters.push(() => countUp(feesEl, totalFees, (n) => money(n, 'USD')));
    else feesEl.textContent = usdOrDash(totalFees);
  }

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
    body = view.layout === 'list' ? poolTable(shown) : h('div', { class: fresh ? 'lp-grid enter' : 'lp-grid' }, shown.map((r, i) => poolCard(r, i)));
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
          state.at ? ` ${updatedText()}.` : '')),
      h('button', { type: 'button', class: 'btn-small', disabled: reading || chainCount === 0, onclick: () => load(store) },
        h('span', { class: reading ? 'spin-icon' : '' }, icon('refresh')),
        reading ? 'Reading…' : 'Refresh')),

    state.shallow.length
      ? notice({ tone: 'info', text: `The node for ${state.shallow.join(', ')} keeps only recent history, so older v4 positions there are not found. Add them by link in Settings, or set a node that keeps full history.` })
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
          }, icon(iconName), label)))),

    body));

  for (const run of counters) run();
}

export default {
  id: 'positions',
  title: 'Liquidity Pools',
  short: 'Pools',
  icon: 'droplet',
  collection: COLLECTION,
  defaults: { cache: {}, prices: {}, scan: {} },
  render: draw,
  serialize: () => ({
    filter: view.filter === 'all' ? '' : view.filter,
    chain: view.chain === 'all' ? '' : String(view.chain),
    view: view.layout === 'list' ? 'list' : '',
  }),
  restore: (p = {}) => {
    view.filter = ['in', 'out'].includes(p.filter) ? p.filter : 'all';
    view.layout = p.view === 'list' ? 'list' : 'cards';
    const id = Number(p.chain);
    view.chain = CHAINS.some((c) => c.id === id) ? id : 'all';
  },
};
