// DeFi → Wallets: the native coin and ERC-20 balances of every DeFi wallet, on each chain read for Liquidity Pools.
// Drawn inside the Liquidity Pools section, which owns the tab bar, the currency switch and pools.json.
import { h, icon, refreshIcon, notice, copyable } from '../ui.js';
import { setupBanner } from '../integrations.js';
import { CHAINS, chainSettings, isAddress, tokenMeta } from '../uniswap.js';
import { tokenRef } from '../balances.js';
import { savedChainRows, walletsOf, enabledChains } from '../defi/wallets-read.js';
import { runJob } from '../runners.js';
import { toast } from '../toast.js';
/** @import { Store, Wallet, WalletBalance, ChainReadState } from '../../types/data' */
/** @import { DefiUi, DefiTab } from '../../types/defi' */
/** @import { Child } from '../../types/ui' */
/**
 * A balance as shown: its row with the names of its chain and wallet.
 * @typedef {WalletBalance & { chainName: string, chainLogo: string | undefined, walletName: string }} BalanceRow
 * @typedef {{ name: string, logo: Child, value: number }} Group
 */

const COLLECTION = 'pools';
const DUST_USD = 1; // balances worth less are hidden while "Hide small balances" is on

// View state. chain: a chain id or 'all'. wallet: a lowercase address or 'all'. adding: the add token form is open.
/** @type {{ chain: number | 'all', wallet: string, small: boolean, adding: boolean, sort: string, dir: number, message: string, ok: boolean }} */
export const walletsView = { chain: 'all', wallet: 'all', small: false, adding: false, sort: 'value', dir: -1, message: '', ok: true };
// The last read: rows from every chain, which chains are being read, and which failed (with their last good read).
// The reads run in js/defi/wallets-read.js and save in pools.json; the page draws that. loading: a read this tab started.
let loading = false;
let askedAt = 0; // when this tab last started a read, so a stale page asks once, not on every redraw
/** @type {Store | null} */
let bound = null;
/** @returns {Partial<ChainReadState>} */
const readOf = () => bound?.get(COLLECTION)?.balancesRead ?? {};
const state = {
  get status() {
    return loading ? 'loading' : readOf().at ? 'ok' : 'idle';
  },
  get at() {
    return readOf().at ?? 0;
  },
  get pending() {
    return loading ? readOf().pending ?? [] : [];
  },
  get failed() {
    return readOf().failed ?? [];
  },
};

/** @param {Store} store */
const addedOf = (store) => store.get(COLLECTION)?.tokens ?? [];
/** @param {Store} store */
const hiddenOf = (store) => new Set(store.get(COLLECTION)?.hiddenTokens ?? []);
/** @param {string} a */
const shortAddress = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
/** @param {number} n */
const amountText = (n) => (n >= 1e6 ? n.toLocaleString(undefined, { maximumFractionDigits: 0 }) : n >= 1 ? n.toLocaleString(undefined, { maximumFractionDigits: 4 }) : n.toPrecision(4));

// Asks the runners to read every chain now (tools/jobs/defi.js); each lands on screen as soon as they save it.
/** @param {Store} store */
export async function load(store) {
  if (loading) return;
  loading = true;
  askedAt = Date.now();
  store.refresh();
  try {
    await runJob('defi-wallets');
    await store.sync();
  } catch (err) {
    // Their last error also shows in Settings → Runners.
    toast(/** @type {Error} */ (err).message);
  } finally {
    loading = false;
    store.refresh();
  }
}

/** @param {Store} store @param {FormData} form */
async function addToken(store, form) {
  const chain = CHAINS.find((c) => c.id === Number(form.get('chain')));
  const address = String(form.get('address') ?? '').trim();
  /** @param {boolean} ok @param {string} message */
  const say = (ok, message) => Object.assign(walletsView, { ok, message });
  if (!chain) return say(false, 'Pick a chain.');
  if (!isAddress(address)) return say(false, 'That is not a token address. It starts with 0x and has 40 hex characters.');
  const ref = tokenRef(chain.id, address);
  if (addedOf(store).some((t) => tokenRef(t.chainId, t.address) === ref)) return say(false, 'That token is already added.');
  const cfg = store.get('settings').uniswap ?? {};
  const meta = await tokenMeta(chainSettings(cfg, chain).node, address, chain);
  store.update(COLLECTION, (d) => {
    d.tokens = [...(d.tokens ?? []), { chainId: chain.id, address: address.toLowerCase(), symbol: meta.symbol, decimals: meta.decimals }];
    d.hiddenTokens = (d.hiddenTokens ?? []).filter((x) => x !== ref);
  });
  say(true, `${meta.symbol} on ${chain.name} added. Reading balances…`);
  setTimeout(() => load(store), 0);
  return true;
}

/** @param {Store} store @param {string} ref */
function hideToken(store, ref) {
  store.update(COLLECTION, (d) => {
    d.hiddenTokens = [...new Set([...(d.hiddenTokens ?? []), ref])];
  });
}
/** @param {Store} store @param {string} ref */
function showToken(store, ref) {
  store.update(COLLECTION, (d) => {
    d.hiddenTokens = (d.hiddenTokens ?? []).filter((x) => x !== ref);
  });
}
/** @param {Store} store @param {string} ref */
function removeToken(store, ref) {
  store.update(COLLECTION, (d) => {
    d.tokens = (d.tokens ?? []).filter((t) => tokenRef(t.chainId, t.address) !== ref);
    for (const part of Object.values(d.balances ?? {})) part.rows = (part.rows ?? []).filter((r) => r.ref !== ref);
  });
}

// The form to add a token the list does not carry, and the tokens added or hidden so far.
/** @param {Store} store @param {DefiUi} ui */
function addPanel(store, ui) {
  const added = addedOf(store);
  const hidden = [...hiddenOf(store)];
  const known = new Map(Object.values(store.get(COLLECTION)?.balances ?? {}).flatMap((part) => part.rows ?? []).map((r) => [r.ref, r]));
  /** @param {string} ref */
  const nameOf = (ref) => {
    const [chainId, address] = ref.split(':');
    const t = known.get(ref) ?? added.find((x) => tokenRef(x.chainId, x.address) === ref);
    const chain = CHAINS.find((c) => c.id === Number(chainId));
    return `${t?.symbol ?? shortAddress(address)} on ${chain?.name ?? chainId}`;
  };
  return h('section', { class: 'card panel stack' },
    h('div', { class: 'row between' },
      h('h3', null, 'Tokens'),
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Close', onclick: () => { walletsView.adding = false; walletsView.message = ''; ui.refresh(); } }, icon('x'))),
    h('p', { class: 'muted small' }, 'Each chain\'s Uniswap token list is checked. Add a token it does not carry by its contract address.'),
    h('form', {
      class: 'row wallet-add',
      /** @param {SubmitEvent} e */
      onsubmit: async (e) => {
        e.preventDefault();
        const form = /** @type {HTMLFormElement} */ (e.currentTarget);
        const button = /** @type {HTMLButtonElement} */ (form.querySelector('button[type="submit"]'));
        button.disabled = true;
        try {
          if (await addToken(store, new FormData(form))) form.reset();
        } catch (err) {
          Object.assign(walletsView, { ok: false, message: `The token could not be read: ${/** @type {Error} */ (err).message}` });
        }
        button.disabled = false;
        ui.refresh();
      },
    },
      h('select', { name: 'chain', 'aria-label': 'Chain' }, CHAINS.map((c) => h('option', { value: c.id }, c.name))),
      h('input', { name: 'address', placeholder: 'Token address 0x…', spellcheck: false, autocomplete: 'off', 'aria-label': 'Token address' }),
      h('button', { type: 'submit', class: 'btn-small' }, icon('plus'), 'Add token')),
    walletsView.message ? h('p', { class: walletsView.ok ? 'muted small' : 'error small', role: 'status' }, walletsView.message) : null,
    added.length
      ? h('div', { class: 'stack' }, h('span', { class: 'muted small' }, 'Added by hand'),
        h('ul', { class: 'stack' }, added.map((t) => {
          const ref = tokenRef(t.chainId, t.address);
          return h('li', { class: 'row between' }, h('span', null, `${nameOf(ref)} · `, copyable(t.address, { label: shortAddress(t.address) })),
            h('button', { type: 'button', class: 'btn-small', onclick: () => removeToken(store, ref) }, 'Remove'));
        })))
      : null,
    hidden.length
      ? h('div', { class: 'stack' }, h('span', { class: 'muted small' }, 'Hidden'),
        h('ul', { class: 'stack' }, hidden.map((ref) => h('li', { class: 'row between' }, h('span', null, nameOf(ref)),
          h('button', { type: 'button', class: 'btn-small', onclick: () => showToken(store, ref) }, 'Show again')))))
      : null);
}

// Totals grouped by a key, largest first, as rows with a share bar.
/** @param {string} title @param {Group[]} groups @param {number} total @param {DefiUi} ui */
function breakdown(title, groups, total, ui) {
  return h('section', { class: 'card panel stack wallet-break' },
    h('h3', null, title),
    groups.length
      ? h('ul', { class: 'wallet-bars' }, groups.map((g) => h('li', null,
        h('div', { class: 'row between' }, h('span', { class: 'row wallet-bar-name' }, g.logo, g.name), h('strong', null, ui.cash(g.value))),
        h('div', { class: 'wallet-bar', 'aria-hidden': 'true' }, h('span', { style: { width: `${total > 0 ? Math.max(1, (g.value / total) * 100) : 0}%` } })))))
      : h('p', { class: 'muted small' }, 'Nothing priced yet.'));
}

/** @type {Record<string, (r: BalanceRow) => string | number>} */
const SORTS = { token: (r) => r.symbol.toLowerCase(), chain: (r) => r.chainName, wallet: (r) => r.walletName.toLowerCase(), amount: (r) => r.amount, value: (r) => r.value ?? -1 };

/** @param {DefiUi} ui @param {string} key @param {string} label @param {string} [cls] */
function sortHead(ui, key, label, cls) {
  const active = walletsView.sort === key;
  return h('th', { class: cls, 'aria-sort': active ? (walletsView.dir === 1 ? 'ascending' : 'descending') : null },
    h('button', {
      type: 'button',
      class: 'mon-sort',
      onclick: () => {
        walletsView.dir = active ? -walletsView.dir : key === 'value' || key === 'amount' ? -1 : 1;
        walletsView.sort = key;
        ui.refresh();
      },
    }, label, h('span', { class: 'sort-mark' }, icon(active && walletsView.dir === 1 ? 'chevron-up' : 'chevron-down'))));
}

/** @param {Store} store @param {BalanceRow[]} rows @param {DefiUi} ui @param {boolean} multiWallet */
function balanceTable(store, rows, ui, multiWallet) {
  const by = SORTS[walletsView.sort] ?? SORTS.value;
  const sorted = [...rows].sort((a, b) => {
    const x = by(a);
    const y = by(b);
    // One sort gives both the same type.
    return (typeof x === 'string' ? x.localeCompare(/** @type {string} */ (y)) : x - /** @type {number} */ (y)) * walletsView.dir;
  });
  return h('div', { class: 'card mon-scroll' },
    h('table', { class: 'mon-table wallet-table' },
      h('thead', null, h('tr', null,
        sortHead(ui, 'token', 'Token'),
        sortHead(ui, 'chain', 'Chain'),
        multiWallet ? sortHead(ui, 'wallet', 'Wallet') : null,
        sortHead(ui, 'amount', 'Balance', 'num'),
        h('th', { class: 'num' }, 'Price'),
        sortHead(ui, 'value', 'Value', 'num'),
        h('th', null, ''))),
      h('tbody', null, sorted.map((r) => h('tr', null,
        h('td', null, h('span', { class: 'row wallet-token' }, ui.logo(r.logo || ui.logoOf(r.chainId, r.token), r.symbol, 'token'), h('strong', null, r.symbol))),
        h('td', null, h('span', { class: 'chain-chip' }, ui.logo(r.chainLogo, r.chainName, 'xs'), r.chainName)),
        multiWallet ? h('td', { class: 'small' }, r.walletName) : null,
        h('td', { class: 'num' }, amountText(r.amount)),
        h('td', { class: 'num muted' }, r.price === null ? '—' : r.price < 0.01 ? `< ${ui.cash(0.01)}` : ui.cash(r.price)),
        h('td', { class: 'num' }, r.value === null ? h('span', { class: 'muted', title: 'No price for this token' }, '—') : ui.cash(r.value)),
        h('td', null, h('button', { type: 'button', class: 'icon-btn', title: 'Hide this token', 'aria-label': `Hide ${r.symbol} on ${r.chainName}`, onclick: () => hideToken(store, r.ref) }, icon('x'))))))));
}

// The rows to show, from the last read saved; read again when stale.
/**
 * @param {Store} store @param {{ id: number }[]} chains @param {Wallet[]} wallets
 * @returns {BalanceRow[]}
 */
function currentRows(store, chains, wallets) {
  bound = store;
  // The runners keep it fresh; only a folder they never read is asked for at once.
  if (!loading && !state.at && !askedAt) {
    askedAt = Date.now();
    setTimeout(() => load(store), 0);
  }
  const rows = savedChainRows(store, 'balances', chains, wallets);
  const names = new Map(wallets.map((w) => [w.address.toLowerCase(), w.label || shortAddress(w.address)]));
  const chainIds = new Set(chains.map((c) => c.id));
  const hidden = hiddenOf(store);
  return rows
    .filter((r) => chainIds.has(r.chainId) && names.has(r.wallet) && !hidden.has(r.ref))
    .map((r) => {
      const chain = CHAINS.find((c) => c.id === r.chainId);
      return { ...r, chainName: chain?.name ?? String(r.chainId), chainLogo: chain?.logo, walletName: /** @type {string} */ (names.get(r.wallet)) };
    });
}

// For DeFi → Summary: every wallet on every chain, unfiltered. null when no wallet is set.
/** @param {Store} store */
export function walletsSummary(store) {
  const wallets = walletsOf(store);
  if (!wallets.length) return null;
  const all = currentRows(store, enabledChains(store.get('settings').uniswap ?? {}), wallets);
  /** @type {Map<string, { symbol: string, chainId: number, token: string, logo: string, value: number }>} */
  const tokens = new Map();
  for (const r of all) {
    // A balance with no price (null) is left out, as null > 0 is false.
    if (!(/** @type {number} */ (r.value) > 0)) continue;
    const t = tokens.get(r.symbol) ?? { symbol: r.symbol, chainId: r.chainId, token: r.token, logo: r.logo, value: 0 };
    t.value += /** @type {number} */ (r.value);
    tokens.set(r.symbol, t);
  }
  return {
    total: all.reduce((s, r) => s + (r.value ?? 0), 0),
    count: all.length,
    chains: new Set(all.filter((r) => /** @type {number} */ (r.value) > 0).map((r) => r.chainId)).size,
    tokens: [...tokens.values()].sort((a, b) => b.value - a.value),
    reading: state.status === 'loading',
    firstRead: state.status === 'loading' && !all.length,
    failed: state.failed.map((f) => f.name),
  };
}

// The tab: { subtitle, actions, body }. ui carries the section's helpers: cash, logo, logoOf and refresh.
/**
 * @param {Store} store
 * @param {DefiUi} ui
 * @returns {DefiTab}
 */
export function walletsTab(store, ui) {
  const cfg = store.get('settings').uniswap ?? {};
  const wallets = walletsOf(store);
  const chains = enabledChains(cfg);
  if (!wallets.length) {
    return { subtitle: 'Native coins and tokens held by your wallets.', actions: [], body: setupBanner('wallets', 'Add a wallet address in Settings to see what it holds.') };
  }
  const all = currentRows(store, chains, wallets);
  const names = new Map(wallets.map((w) => [w.address.toLowerCase(), w.label || shortAddress(w.address)]));
  if (walletsView.chain !== 'all' && !all.some((r) => r.chainId === walletsView.chain)) walletsView.chain = 'all';
  if (walletsView.wallet !== 'all' && !names.has(walletsView.wallet)) walletsView.wallet = 'all';
  const inWallet = walletsView.wallet === 'all' ? all : all.filter((r) => r.wallet === walletsView.wallet);
  const inChain = walletsView.chain === 'all' ? inWallet : inWallet.filter((r) => r.chainId === walletsView.chain);
  /** @param {BalanceRow} r */
  const dust = (r) => r.value !== null && r.value < DUST_USD;
  const shown = walletsView.small ? inChain.filter((r) => !dust(r)) : inChain;
  const total = inChain.reduce((s, r) => s + (r.value ?? 0), 0);
  const unpriced = inChain.filter((r) => r.value === null).length;

  /**
   * @param {BalanceRow[]} rows @param {(r: BalanceRow) => string | number} keyOf @param {(r: BalanceRow) => string} nameOf
   * @param {(r: BalanceRow) => Child} logoOf
   */
  const group = (rows, keyOf, nameOf, logoOf) => {
    /** @type {Map<string | number, Group>} */
    const map = new Map();
    for (const r of rows) {
      const k = keyOf(r);
      const g = map.get(k) ?? { name: nameOf(r), logo: logoOf(r), value: 0 };
      g.value += r.value ?? 0;
      map.set(k, g);
    }
    return [...map.values()].filter((g) => g.value > 0).sort((a, b) => b.value - a.value);
  };
  const byChain = group(inWallet, (r) => r.chainId, (r) => r.chainName, (r) => ui.logo(r.chainLogo, r.chainName, 'xs'));
  const byWallet = group(walletsView.chain === 'all' ? all : all.filter((r) => r.chainId === walletsView.chain), (r) => r.wallet, (r) => r.walletName, () => null);
  const byToken = group(inChain, (r) => r.symbol, (r) => r.symbol, (r) => ui.logo(r.logo || ui.logoOf(r.chainId, r.token), r.symbol, 'xs')).slice(0, 8);

  /** @param {boolean} active @param {Child} label @param {number} count @param {() => void} onclick @param {Child} [lead] */
  const chip = (active, label, count, onclick, lead = null) => h('button', { type: 'button', class: active ? 'lp-chip chain active' : 'lp-chip chain', onclick }, lead, label, h('span', { class: 'chip-count' }, count));
  const chainsWithRows = chains.filter((c) => inWallet.some((r) => r.chainId === c.id));
  const reading = state.status === 'loading';
  const firstRead = reading && !all.length;

  const subtitle = [
    `Native coins and tokens in ${wallets.length} wallet${wallets.length === 1 ? '' : 's'} on ${chains.length} chain${chains.length === 1 ? '' : 's'}, read from the chain. Read-only.`,
    state.pending.length ? ` Reading ${state.pending.join(', ')}…` : '',
  ].join('');
  const actions = [
    h('button', { type: 'button', class: 'btn-small', onclick: () => { walletsView.adding = !walletsView.adding; ui.refresh(); } }, icon('plus'), 'Tokens'),
    h('button', { type: 'button', class: 'btn-small', disabled: reading || !chains.length, onclick: () => load(store) }, refreshIcon(reading), reading ? 'Reading…' : 'Refresh'),
  ];

  const body = [
    walletsView.adding ? addPanel(store, ui) : null,
    chains.length ? null : notice({ tone: 'info', text: 'No chains are selected. Pick the chains to read in Settings → Blockchains.' }),
    state.failed.length
      ? notice({ tone: 'info', text: `Could not read ${state.failed.map((f) => (f.at ? `${f.name} (shown from an earlier read)` : f.name)).join(', ')}: ${state.failed[0].error}` })
      : null,
    h('div', { class: 'lp-stats' },
      h('div', { class: 'card lp-stat' }, h('span', { class: 'muted' }, 'Total value'), h('strong', null, firstRead ? '…' : ui.cash(total))),
      h('div', { class: 'card lp-stat' }, h('span', { class: 'muted' }, 'Tokens held'), h('strong', null, String(inChain.length))),
      h('div', { class: 'card lp-stat' }, h('span', { class: 'muted' }, 'Chains with funds'), h('strong', null, String(new Set(inChain.map((r) => r.chainId)).size)))),
    total > 0
      ? h('div', { class: 'wallet-breaks' },
        breakdown('By token', byToken, total, ui),
        breakdown('By chain', byChain, byChain.reduce((s, g) => s + g.value, 0), ui),
        wallets.length > 1 ? breakdown('By wallet', byWallet, byWallet.reduce((s, g) => s + g.value, 0), ui) : null)
      : null,
    wallets.length > 1
      ? h('div', { class: 'row lp-filters' },
        chip(walletsView.wallet === 'all', 'All wallets', all.length, () => { walletsView.wallet = 'all'; ui.refresh(); }),
        wallets.map((w) => {
          const a = w.address.toLowerCase();
          return chip(walletsView.wallet === a, names.get(a), all.filter((r) => r.wallet === a).length, () => { walletsView.wallet = a; ui.refresh(); }, icon('wallet'));
        }))
      : null,
    h('div', { class: 'row between' },
      chainsWithRows.length > 1
        ? h('div', { class: 'row lp-filters' },
          chip(walletsView.chain === 'all', 'All chains', inWallet.length, () => { walletsView.chain = 'all'; ui.refresh(); }),
          chainsWithRows.map((c) => chip(walletsView.chain === c.id, c.name, inWallet.filter((r) => r.chainId === c.id).length, () => { walletsView.chain = c.id; ui.refresh(); }, ui.logo(c.logo, c.name, 'xs'))))
        : h('span'),
      h('label', { class: 'inline small' },
        h('input', { type: 'checkbox', checked: walletsView.small, onchange: (/** @type {Event} */ e) => { walletsView.small = /** @type {HTMLInputElement} */ (e.target).checked; ui.refresh(); } }),
        `Hide balances under ${ui.cash(DUST_USD)}`)),
    unpriced ? h('p', { class: 'muted small' }, `${unpriced} token${unpriced === 1 ? ' has' : 's have'} no price and ${unpriced === 1 ? 'is' : 'are'} left out of the totals.`) : null,
    firstRead
      ? h('div', { class: 'lp-empty' }, h('span', { class: 'float' }, icon('wallet')), h('p', null, 'Reading balances…'))
      : shown.length
        ? balanceTable(store, shown, ui, wallets.length > 1 && walletsView.wallet === 'all')
        : h('div', { class: 'lp-empty' }, h('span', { class: 'float' }, icon('wallet')), h('p', null, all.length ? 'No balances match these filters.' : 'No balances found on these chains.')),
  ];
  return { subtitle, actions, body };
}
