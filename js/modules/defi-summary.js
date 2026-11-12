// DeFi → Summary: the first tab. What every other tab holds in one place: total liquidity across wallets, LP
// positions and Aave, what needs attention, and the main lines of each tab. It reads nothing itself: each tab's
// module reads (or shows its last saved read) and hands its totals here.
import { h, icon, notice } from '../ui.js';
import { setupBanner } from '../integrations.js';
import { walletsSummary, load as loadBalances } from './defi-wallets.js';
import { lendingSummary, load as loadLending, healthTone, healthText, RISK } from './defi-lending.js';
/** @import { Store, IconName } from '../../types/data' */
/** @import { DefiUi, DefiTab } from '../../types/defi' */
/** @import { Child } from '../../types/ui' */

/** @param {number | null} n */
const pctText = (n) => (n == null ? '—' : `${(n * 100).toFixed(2)}%`);

// One line of a panel's list: a lead (logo or dot), a name with a note under it, and a value.
/** @param {Child} lead @param {string} name @param {string | null} note @param {string} value @param {(() => void) | null} [onclick] */
const line = (lead, name, note, value, onclick = null) => h('li', null,
  h(onclick ? 'button' : 'div', { type: onclick ? 'button' : null, class: 'sum-line', onclick },
    lead,
    h('span', { class: 'sum-line-name' }, h('strong', null, name), note ? h('span', { class: 'muted small' }, note) : null),
    h('span', { class: 'sum-num' }, value)));

/**
 * @param {IconName} iconName @param {string} title @param {string} tab @param {DefiUi} ui @param {string} headline
 * @param {[string, string, string?][]} facts @param {Child[]} list @param {string} empty
 */
function panel(iconName, title, tab, ui, headline, facts, list, empty) {
  return h('section', { class: 'card panel sum-panel' },
    h('div', { class: 'row between' },
      h('h3', { class: 'row' }, icon(iconName), title),
      h('button', { type: 'button', class: 'btn-small', onclick: () => ui.go(tab) }, 'Open', icon('chevron-right'))),
    h('strong', { class: 'sum-headline' }, headline),
    h('div', { class: 'sum-facts' }, facts.filter(Boolean).map(([label, value, cls]) =>
      h('div', null, h('span', { class: 'muted small' }, label), h('strong', { class: cls ?? null }, value)))),
    list?.length ? h('ul', { class: 'sum-list' }, list) : h('p', { class: 'muted small' }, empty));
}

// The tab: { subtitle, actions, body }. ui carries the section's helpers (cash, logo, logoOf, refresh) and, from
// the LP views, lp() for their totals, loadLp() to read them again, go(tab) and openPosition(ref).
/**
 * @param {Store} store
 * @param {DefiUi} ui
 * @returns {DefiTab}
 */
export function summaryTab(store, ui) {
  const w = walletsSummary(store);
  const l = lendingSummary(store);
  const lp = ui.lp();
  if (!w && !lp) {
    return { subtitle: 'Everything your DeFi wallets hold, in one place.', actions: [], body: setupBanner('wallets', 'Add a wallet address in Settings to see its balances, pools and loans.') };
  }

  const reading = [w?.reading && 'balances', lp?.reading && 'LP positions', l?.reading && 'Aave'].filter(Boolean);
  const first = (w?.firstRead ?? false) || (lp?.firstRead ?? false) || (l?.firstRead ?? false);
  const failed = [...(w?.failed ?? []).map((n) => `balances on ${n}`), ...(lp?.failed ?? []).map((n) => `positions on ${n}`), ...(l?.failed ?? []).map((n) => `Aave on ${n}`)];

  // Total liquidity: what could be withdrawn today. Aave counts as supplied less borrowed.
  const parts = [
    { key: 'wallets', label: 'Wallets', value: w?.total ?? 0 },
    { key: 'positions', label: 'LP positions', value: lp?.value ?? 0 },
    { key: 'fees', label: 'Unclaimed fees', value: lp?.fees ?? 0 },
    { key: 'lending', label: 'Aave, net of debt', value: Math.max(0, l?.net ?? 0) },
  ];
  const total = parts.reduce((s, p) => s + p.value, 0);

  const subtitle = [
    'Totals from Wallets, LP Positions and Lending / Borrowing, read from the chain. Read-only.',
    reading.length ? ` Reading ${reading.join(', ')}…` : '',
  ].join('');
  const busy = reading.length > 0;
  const actions = [
    h('button', {
      type: 'button',
      class: 'btn-small',
      disabled: busy,
      onclick: () => { if (w) loadBalances(store); if (l) loadLending(store); ui.loadLp(); },
    }, icon('refresh'), busy ? 'Reading…' : 'Refresh all'),
  ];

  const out = lp?.out ?? [];
  const atRisk = l?.atRisk ?? [];
  const body = [
    failed.length ? notice({ tone: 'info', text: `Could not read ${failed.join(', ')}. Those totals are from an earlier read.` }) : null,
    atRisk.length
      ? notice({ text: `${atRisk.length === 1 ? 'One Aave account is' : `${atRisk.length} Aave accounts are`} close to liquidation (health factor under ${RISK}): ${atRisk.map((r) => `${r.walletName} on ${r.chainName}`).join(', ')}.`,
        actions: [h('button', { type: 'button', class: 'btn-small', onclick: () => ui.go('lending') }, 'Open Lending / Borrowing')] })
      : null,
    out.length
      ? notice({ tone: 'info', text: `${out.length === 1 ? 'One LP position is' : `${out.length} LP positions are`} out of range and earning no fees: ${out.slice(0, 4).map((r) => `${r.pair} on ${r.chain}`).join(', ')}${out.length > 4 ? ` and ${out.length - 4} more` : ''}.`,
        actions: [h('button', { type: 'button', class: 'btn-small', onclick: () => ui.go('positions', 'out') }, 'Show them')] })
      : null,

    h('section', { class: 'card sum-hero' },
      h('div', { class: 'row between sum-hero-head' },
        h('div', null,
          h('span', { class: 'muted' }, 'Total liquidity'),
          h('strong', { class: 'sum-total' }, first && !total ? '…' : ui.cash(total))),
        h('span', { class: 'muted small' }, 'Wallets + LP positions + unclaimed fees + Aave supplied less borrowed')),
      total > 0
        ? h('div', { class: 'sum-bar', role: 'img', 'aria-label': parts.map((p) => `${p.label} ${ui.cash(p.value)}`).join(', ') },
          parts.filter((p) => p.value > 0).map((p) => h('span', { class: `sum-seg ${p.key}`, style: { width: `${(p.value / total) * 100}%` }, title: `${p.label}: ${ui.cash(p.value)}` })))
        : null,
      h('ul', { class: 'sum-legend' }, parts.map((p) => h('li', null,
        h('span', { class: `sum-key ${p.key}`, 'aria-hidden': 'true' }),
        h('span', { class: 'muted' }, p.label),
        h('strong', null, ui.cash(p.value)),
        total > 0 ? h('span', { class: 'muted small' }, `${((p.value / total) * 100).toFixed(1)}%`) : null)))),

    h('div', { class: 'lp-stats' },
      h('div', { class: 'card lp-stat' }, h('span', { class: 'muted' }, 'LP in range'),
        h('strong', null, lp ? `${lp.inRange} of ${lp.count}` : '—')),
      h('div', { class: 'card lp-stat' }, h('span', { class: 'muted' }, 'Fees collected, 30 d'),
        h('strong', null, lp ? ui.cash(lp.collected30) : '—')),
      h('div', { class: 'card lp-stat' }, h('span', { class: 'muted' }, 'Aave debt'),
        h('strong', null, l ? ui.cash(l.borrowed) : '—')),
      h('div', { class: 'card lp-stat' }, h('span', { class: 'muted' }, 'Lowest health'),
        h('strong', { class: `lend-hf-text ${healthTone(l?.lowest?.health)}` }, l?.lowest ? healthText(l.lowest.health) : '—'))),

    h('div', { class: 'sum-grid' },
      w
        ? panel('wallet', 'Wallets', 'wallets', ui, ui.cash(w.total),
          [['Tokens held', String(w.count)], ['Chains with funds', String(w.chains)]],
          w.tokens.slice(0, 5).map((t) => line(ui.logo(t.logo || ui.logoOf(t.chainId, t.token), t.symbol, 'xs'), t.symbol,
            w.total > 0 ? `${((t.value / w.total) * 100).toFixed(1)}% of wallets` : null, ui.cash(t.value))),
          w.firstRead ? 'Reading balances…' : 'No priced balances.')
        : null,
      lp
        ? panel('droplet', 'LP Positions', 'positions', ui, ui.cash(lp.value),
          [['Unclaimed fees', ui.cash(lp.fees)], ['Positions', `${lp.count} · ${lp.inRange} in range`]],
          lp.top.slice(0, 5).map((r) => line(h('span', { class: `pos-dot ${r.inRange ? 'in' : 'out'}`, title: r.inRange ? 'In range' : 'Out of range' }),
            r.pair, `${r.chain} · ${r.feePct}% fee`, r.value == null ? '—' : ui.cash(r.value), () => ui.openPosition(r.ref))),
          lp.firstRead ? 'Reading positions…' : 'No open positions.')
        : null,
      l
        ? panel('landmark', 'Lending / Borrowing', 'lending', ui, ui.cash(l.net),
          [['Supplied', ui.cash(l.supplied)], ['Borrowed', ui.cash(l.borrowed)], ['Net APY', pctText(l.netApy)]],
          l.accounts.slice(0, 5).map((r) => line(ui.logo(r.chainLogo, r.chainName, 'xs'), r.walletName,
            `${r.chainName} · health ${healthText(r.health)}`, ui.cash(r.collateral - r.debt))),
          l.firstRead ? 'Reading Aave positions…' : 'No Aave positions.')
        : null),
    first ? h('p', { class: 'muted small' }, 'Totals fill in as each chain is read.') : null,
  ];
  return { subtitle, actions, body };
}
