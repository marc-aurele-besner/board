import { h, icon, refreshIcon, money, empty, notice } from '../ui.js';
import { setupBanner } from '../integrations.js';
import { poolsChanged } from '../automations.js';
import { readPositions, poolState, tokenMeta, usdPrices, positionAmounts, priceAtTick, isAddress, CHAINS, chainSettings, tokenLogos, scanV4, readV4Position, readV3Position, addedPositions, parsePosition, addPosition } from '../uniswap.js';

const STALE_MS = 10 * 60 * 1000;
const MAX_TICK = 887272; // the widest possible range: a "full range" position

// View state: which rows are shown.
// layout: 'cards' or 'list'.
// adding: the form to add a position by hand is open; addMessage is its last error.
const view = { filter: 'all', chain: 'all', layout: 'cards', adding: false, addMessage: '' };
// Loaded positions and the state of the last load. shallow: chains whose node would not search back to v4's start.
// stale: chains shown from the last good read because this one failed, with when that read was.
// pending: chains still being read in the current load.
const state = { status: 'idle', rows: [], error: '', warning: '', at: 0, shallow: [], stale: [], pending: [] };
// pools.json keeps the last good read of each chain and version, the last good prices of each chain, and how far
// each v4 search got. A read that fails then shows the old rows, marked as possibly out of date.
const COLLECTION = 'pools';
const tokenInfo = new Map(); // "chainId:token address" -> { symbol, decimals }
let loading = false;
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
      poolStat('Unclaimed fees', usdOrDash(r.fees))),
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
  const shown = view.filter === 'in' ? byChain.filter((r) => r.inRange) : view.filter === 'out' ? byChain.filter((r) => !r.inRange) : byChain;
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
      ? poolTable(shown)
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
