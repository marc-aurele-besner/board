// DeFi → Lending: the Aave v3 positions of every DeFi wallet, per chain: what is supplied and borrowed, at what rate,
// and how far each account is from liquidation. Drawn inside the Liquidity Pools section, like Wallets.
import { h, icon, refreshIcon, notice } from '../ui.js';
import { setupBanner } from '../integrations.js';
import { CHAINS, chainSettings, isAddress } from '../uniswap.js';
import { readLending, hasAave } from '../aave.js';

const COLLECTION = 'pools';
const STALE_MS = 5 * 60 * 1000;
// Health factor bands: liquidation starts below 1.
const RISK = 1.1;
const WATCH = 1.5;

// View state. chain: a chain id or 'all'. wallet: a lowercase address or 'all'. layout: 'cards' or 'list'.
export const lendingView = { chain: 'all', wallet: 'all', layout: 'cards' };
const state = { status: 'idle', rows: [], at: 0, pending: [], failed: [] };
let loading = false;

const aaveChains = (cfg) => CHAINS.filter((c) => chainSettings(cfg, c).enabled && hasAave(c));
const walletsOf = (store) => (store.get('settings').uniswap?.wallets ?? []).filter((w) => isAddress(w.address));
const shortAddress = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const pct = (n) => (n == null ? '—' : `${(n * 100).toFixed(2)}%`);
const amountText = (n) => (n >= 1e6 ? n.toLocaleString(undefined, { maximumFractionDigits: 0 }) : n >= 1 ? n.toLocaleString(undefined, { maximumFractionDigits: 4 }) : n.toPrecision(4));
const healthTone = (hf) => (hf == null ? 'safe' : hf < RISK ? 'risk' : hf < WATCH ? 'watch' : 'safe');
const healthText = (hf) => (hf == null ? '∞' : hf >= 100 ? '>100' : hf.toFixed(2));

function savedRows(store, chains, wallets) {
  const cache = store.get(COLLECTION)?.lending ?? {};
  const keep = new Set(wallets.map((w) => w.address.toLowerCase()));
  return chains.flatMap((c) => (cache[c.id]?.rows ?? []).filter((r) => keep.has(r.wallet)));
}

// Reads every chain with Aave at once; each lands as soon as it is read and is saved as its last good read.
export async function load(store) {
  if (loading) return;
  loading = true;
  const cfg = store.get('settings').uniswap ?? {};
  const chains = aaveChains(cfg);
  const wallets = walletsOf(store);
  Object.assign(state, { status: 'loading', pending: chains.map((c) => c.name), failed: [] });
  store.refresh();
  await Promise.all(chains.map(async (chain) => {
    try {
      const rows = await readLending(chain, chainSettings(cfg, chain).node, wallets);
      state.rows = [...state.rows.filter((r) => r.chainId !== chain.id), ...rows];
      store.update(COLLECTION, (d) => {
        d.lending = { ...d.lending, [chain.id]: { at: Date.now(), rows } };
      });
    } catch (err) {
      const at = store.get(COLLECTION)?.lending?.[chain.id]?.at ?? 0;
      state.failed.push({ name: chain.name, error: err.message, at });
    } finally {
      state.pending = state.pending.filter((n) => n !== chain.name);
      store.refresh();
    }
  }));
  Object.assign(state, { status: 'ok', at: Date.now() });
  loading = false;
  store.refresh();
}

// The yearly rate the account earns on its equity: supply interest less borrow interest, over supplied less borrowed.
function netApy(assets) {
  const supplied = assets.reduce((s, a) => s + a.suppliedUsd, 0);
  const borrowed = assets.reduce((s, a) => s + a.borrowedUsd, 0);
  const earn = assets.reduce((s, a) => s + a.suppliedUsd * (a.supplyApy ?? 0) - a.borrowedUsd * (a.borrowApy ?? 0), 0);
  return supplied - borrowed > 0 ? earn / (supplied - borrowed) : null;
}

function assetList(title, items, ui, amountOf, usdOf, apyOf, extra) {
  if (!items.length) return null;
  return h('div', { class: 'lend-side' },
    h('span', { class: 'muted small' }, title),
    h('ul', { class: 'lend-assets' }, items.map((a) => h('li', null,
      h('span', { class: 'row lend-asset' }, ui.logo(ui.logoOf(a.chainId, a.asset), a.symbol, 'xs'), h('strong', null, a.symbol), extra?.(a)),
      h('span', { class: 'lend-num' }, ui.cash(usdOf(a)), h('span', { class: 'muted small' }, ` ${amountText(amountOf(a))}`)),
      h('span', { class: 'lend-num muted small', title: 'Yearly rate, compounded' }, `${pct(apyOf(a))} APY`)))));
}

// How much of the borrowing limit before liquidation is used: debt over collateral times the liquidation threshold.
function limitUsed(r) {
  const limit = r.collateral * r.threshold;
  return limit > 0 ? Math.min(1, r.debt / limit) : 0;
}

// One account: a wallet on one chain.
function accountCard(r, ui, i) {
  const assets = r.assets.map((a) => ({ ...a, chainId: r.chainId }));
  const supplied = assets.filter((a) => a.supplied > 0).sort((a, b) => b.suppliedUsd - a.suppliedUsd);
  const borrowed = assets.filter((a) => a.borrowed > 0).sort((a, b) => b.borrowedUsd - a.borrowedUsd);
  const tone = healthTone(r.health);
  const used = limitUsed(r);
  const net = netApy(assets);
  return h('article', { class: `card lend-card ${tone}`, style: { '--i': i } },
    h('div', { class: 'row between lend-head' },
      h('div', { class: 'row' },
        ui.logo(r.chainLogo, r.chainName, 'token'),
        h('div', null, h('strong', null, r.walletName), h('div', { class: 'muted small' }, `Aave v3 · ${r.chainName}`))),
      h('div', { class: `lend-hf ${tone}`, title: 'Health factor: the account is liquidated below 1' },
        h('span', { class: 'muted small' }, 'Health'),
        h('strong', null, healthText(r.health)))),
    h('div', { class: 'lend-stats' },
      h('div', null, h('span', { class: 'muted small' }, 'Supplied'), h('strong', null, ui.cash(r.collateral))),
      h('div', null, h('span', { class: 'muted small' }, 'Borrowed'), h('strong', null, ui.cash(r.debt))),
      h('div', null, h('span', { class: 'muted small' }, 'Net'), h('strong', null, ui.cash(r.collateral - r.debt))),
      h('div', null, h('span', { class: 'muted small', title: 'Supply interest less borrow interest, on the net value' }, 'Net APY'), h('strong', null, pct(net)))),
    r.debt > 0
      ? h('div', { class: 'lend-usage' },
        h('div', { class: 'row between small' },
          h('span', { class: 'muted' }, 'Borrow limit used'),
          h('span', null, `${(used * 100).toFixed(1)}% · ${ui.cash(r.available)} more can be borrowed`)),
        h('div', { class: 'lend-bar', 'aria-hidden': 'true' }, h('span', { class: tone, style: { width: `${used * 100}%` } })))
      : null,
    h('div', { class: 'lend-sides' },
      assetList('Supplied', supplied, ui, (a) => a.supplied, (a) => a.suppliedUsd, (a) => a.supplyApy,
        (a) => (a.collateral ? h('span', { class: 'version-pill', title: 'Counts as collateral' }, 'collateral') : null)),
      assetList('Borrowed', borrowed, ui, (a) => a.borrowed, (a) => a.borrowedUsd, (a) => a.borrowApy)));
}

// The accounts to show, read again when stale; until the first read lands, what the last one saved.
function currentRows(store, chains, wallets) {
  if (state.status === 'idle' && !state.rows.length) state.rows = savedRows(store, chains, wallets);
  if (state.status === 'idle' || (state.status === 'ok' && Date.now() - state.at > STALE_MS)) setTimeout(() => load(store), 0);
  const names = new Map(wallets.map((w) => [w.address.toLowerCase(), w.label || shortAddress(w.address)]));
  const chainIds = new Set(chains.map((c) => c.id));
  return state.rows
    .filter((r) => chainIds.has(r.chainId) && names.has(r.wallet))
    .map((r) => {
      const chain = CHAINS.find((c) => c.id === r.chainId);
      return { ...r, chainName: chain?.name ?? String(r.chainId), chainLogo: chain?.logo, walletName: names.get(r.wallet) };
    });
}

// For DeFi → Summary: every Aave account, unfiltered, riskiest first. null when no wallet or chain has Aave.
export function lendingSummary(store) {
  const wallets = walletsOf(store);
  const chains = aaveChains(store.get('settings').uniswap ?? {});
  if (!wallets.length || !chains.length) return null;
  const all = currentRows(store, chains, wallets)
    .sort((a, b) => (a.health ?? Infinity) - (b.health ?? Infinity) || b.collateral - a.collateral);
  const supplied = all.reduce((s, r) => s + r.collateral, 0);
  const borrowed = all.reduce((s, r) => s + r.debt, 0);
  return {
    supplied,
    borrowed,
    net: supplied - borrowed,
    netApy: netApy(all.flatMap((r) => r.assets)),
    accounts: all,
    lowest: all.find((r) => r.health != null) ?? null,
    atRisk: all.filter((r) => r.health != null && r.health < RISK),
    reading: state.status === 'loading',
    firstRead: state.status === 'loading' && !all.length,
    failed: state.failed.map((f) => f.name),
  };
}

export { healthTone, healthText, RISK };

// The list layout: one row per account, in the same order as the cards.
function accountTable(rows, ui) {
  const symbols = (r, key) => r.assets.filter((a) => a[key] > 0).map((a) => a.symbol).join(', ');
  return h('div', { class: 'card mon-scroll' },
    h('table', { class: 'mon-table lend-table' },
      h('thead', null, h('tr', null,
        h('th', null, 'Account'),
        h('th', null, 'Chain'),
        h('th', { class: 'num' }, 'Supplied'),
        h('th', { class: 'num' }, 'Borrowed'),
        h('th', { class: 'num' }, 'Net'),
        h('th', { class: 'num', title: 'Supply interest less borrow interest, on the net value' }, 'Net APY'),
        h('th', { class: 'num', title: 'Share of the borrow limit used' }, 'Limit used'),
        h('th', { class: 'num', title: 'Health factor: the account is liquidated below 1' }, 'Health'))),
      h('tbody', null, rows.map((r) => {
        const tone = healthTone(r.health);
        return h('tr', null,
          h('td', null, h('strong', null, r.walletName),
            h('div', { class: 'muted small' }, [symbols(r, 'supplied'), symbols(r, 'borrowed') && `debt: ${symbols(r, 'borrowed')}`].filter(Boolean).join(' · '))),
          h('td', null, h('span', { class: 'chain-chip' }, ui.logo(r.chainLogo, r.chainName, 'xs'), r.chainName)),
          h('td', { class: 'num' }, ui.cash(r.collateral)),
          h('td', { class: 'num' }, r.debt > 0 ? ui.cash(r.debt) : h('span', { class: 'muted' }, '—')),
          h('td', { class: 'num' }, ui.cash(r.collateral - r.debt)),
          h('td', { class: 'num' }, pct(netApy(r.assets))),
          h('td', { class: 'num' }, r.debt > 0 ? `${(limitUsed(r) * 100).toFixed(1)}%` : h('span', { class: 'muted' }, '—')),
          h('td', { class: 'num' }, h('strong', { class: `lend-hf-text ${tone}` }, healthText(r.health))));
      }))));
}

function layoutSwitch(ui) {
  return h('div', { class: 'segmented lp-layout', role: 'group', 'aria-label': 'View' },
    [['cards', 'Cards', 'cards'], ['list', 'List', 'list']].map(([key, label, iconName]) =>
      h('button', {
        type: 'button',
        class: lendingView.layout === key ? 'seg active' : 'seg',
        'aria-pressed': String(lendingView.layout === key),
        onclick: () => { lendingView.layout = key; ui.refresh(); },
      }, icon(iconName), label)));
}

// The tab: { subtitle, actions, body }. ui carries the section's helpers: cash, logo, logoOf and refresh.
export function lendingTab(store, ui) {
  const cfg = store.get('settings').uniswap ?? {};
  const wallets = walletsOf(store);
  const chains = aaveChains(cfg);
  if (!wallets.length) {
    return { subtitle: 'Aave lending and borrowing positions of your wallets.', actions: [], body: setupBanner('wallets', 'Add a wallet address in Settings to see its Aave positions.') };
  }
  const all = currentRows(store, chains, wallets);
  const names = new Map(wallets.map((w) => [w.address.toLowerCase(), w.label || shortAddress(w.address)]));
  if (lendingView.chain !== 'all' && !all.some((r) => r.chainId === lendingView.chain)) lendingView.chain = 'all';
  if (lendingView.wallet !== 'all' && !names.has(lendingView.wallet)) lendingView.wallet = 'all';
  const inWallet = lendingView.wallet === 'all' ? all : all.filter((r) => r.wallet === lendingView.wallet);
  const shown = (lendingView.chain === 'all' ? inWallet : inWallet.filter((r) => r.chainId === lendingView.chain))
    // Riskiest first: an account close to liquidation should be the first thing seen.
    .sort((a, b) => (a.health ?? Infinity) - (b.health ?? Infinity) || b.collateral - a.collateral);

  const supplied = shown.reduce((s, r) => s + r.collateral, 0);
  const borrowed = shown.reduce((s, r) => s + r.debt, 0);
  const lowest = shown.filter((r) => r.health != null).reduce((m, r) => (m == null || r.health < m.health ? r : m), null);
  const atRisk = shown.filter((r) => r.health != null && r.health < RISK);
  const reading = state.status === 'loading';
  const firstRead = reading && !all.length;

  const chip = (active, label, count, onclick, lead = null) => h('button', { type: 'button', class: active ? 'lp-chip chain active' : 'lp-chip chain', onclick }, lead, label, h('span', { class: 'chip-count' }, count));
  const chainsWithRows = chains.filter((c) => inWallet.some((r) => r.chainId === c.id));
  const walletsWithRows = wallets.filter((w) => all.some((r) => r.wallet === w.address.toLowerCase()));

  const subtitle = [
    `Aave v3 positions of ${wallets.length} wallet${wallets.length === 1 ? '' : 's'} on ${chains.length} chain${chains.length === 1 ? '' : 's'}, read from the chain. Read-only.`,
    state.pending.length ? ` Reading ${state.pending.join(', ')}…` : '',
  ].join('');
  const actions = [
    h('button', { type: 'button', class: 'btn-small', disabled: reading || !chains.length, onclick: () => load(store) }, refreshIcon(reading), reading ? 'Reading…' : 'Refresh'),
  ];

  const body = [
    chains.length ? null : notice({ tone: 'info', text: 'None of the chains read has Aave v3. Pick chains in Settings → Blockchains.' }),
    state.failed.length
      ? notice({ tone: 'info', text: `Could not read ${state.failed.map((f) => (f.at ? `${f.name} (shown from an earlier read)` : f.name)).join(', ')}: ${state.failed[0].error}` })
      : null,
    atRisk.length
      ? notice({ text: `${atRisk.length === 1 ? 'One account is' : `${atRisk.length} accounts are`} close to liquidation (health factor under ${RISK}): ${atRisk.map((r) => `${r.walletName} on ${r.chainName}`).join(', ')}.` })
      : null,
    h('div', { class: 'lp-stats' },
      h('div', { class: 'card lp-stat' }, h('span', { class: 'muted' }, 'Supplied'), h('strong', null, firstRead ? '…' : ui.cash(supplied))),
      h('div', { class: 'card lp-stat' }, h('span', { class: 'muted' }, 'Borrowed'), h('strong', null, firstRead ? '…' : ui.cash(borrowed))),
      h('div', { class: 'card lp-stat' }, h('span', { class: 'muted' }, 'Net'), h('strong', null, firstRead ? '…' : ui.cash(supplied - borrowed))),
      h('div', { class: 'card lp-stat' }, h('span', { class: 'muted' }, 'Lowest health'),
        h('strong', { class: `lend-hf-text ${healthTone(lowest?.health)}` }, lowest ? healthText(lowest.health) : '—'))),
    walletsWithRows.length > 1
      ? h('div', { class: 'row lp-filters' },
        chip(lendingView.wallet === 'all', 'All wallets', all.length, () => { lendingView.wallet = 'all'; ui.refresh(); }),
        walletsWithRows.map((w) => {
          const a = w.address.toLowerCase();
          return chip(lendingView.wallet === a, names.get(a), all.filter((r) => r.wallet === a).length, () => { lendingView.wallet = a; ui.refresh(); }, icon('wallet'));
        }))
      : null,
    h('div', { class: 'row between' },
      chainsWithRows.length > 1
        ? h('div', { class: 'row lp-filters' },
          chip(lendingView.chain === 'all', 'All chains', inWallet.length, () => { lendingView.chain = 'all'; ui.refresh(); }),
          chainsWithRows.map((c) => chip(lendingView.chain === c.id, c.name, inWallet.filter((r) => r.chainId === c.id).length, () => { lendingView.chain = c.id; ui.refresh(); }, ui.logo(c.logo, c.name, 'xs'))))
        : h('span'),
      shown.length ? layoutSwitch(ui) : null),
    firstRead
      ? h('div', { class: 'lp-empty' }, h('span', { class: 'float' }, icon('landmark')), h('p', null, 'Reading Aave positions…'))
      : shown.length
        ? lendingView.layout === 'list' ? accountTable(shown, ui) : h('div', { class: 'lend-grid' }, shown.map((r, i) => accountCard(r, ui, i)))
        : h('div', { class: 'lp-empty' }, h('span', { class: 'float' }, icon('landmark')), h('p', null, all.length ? 'No positions match these filters.' : 'No Aave positions for these wallets.')),
  ];
  return { subtitle, actions, body };
}
