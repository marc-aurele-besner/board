// Monitoring → Contracts: what happened on the smart contracts saved in Settings during the period. Transactions come
// from Etherscan when a key is set; events come from the chain's node, as far back as it will search.
import { h, icon, empty, notice, progress, refreshIcon, copyable } from '../ui.js';
import { chainById, explorerUrl } from '../chains.js';
import { contractsOf, etherscanKey, loadActivity } from '../contracts.js';
import { barChart, legend } from '../chart.js';
import { stat } from './monitoring.js';
import { sortTable } from './monitoring-web.js';
import { logo } from './positions.js';

// The contract shown ('' adds them all up), and one load per contract and period until Refresh.
const sel = { contract: '' };
const cache = new Map();

// One color per contract in the "All" chart, from the theme's tokens.
const COLORS = ['var(--accent)', 'var(--info)', 'var(--income)', 'var(--warn)', 'var(--ai)', 'var(--expense)'];
const fmt = (n) => Math.round(n).toLocaleString();
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const timeOf = (ms) => new Date(ms).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

function load(store, settings, c, w, period) {
  const key = `${c.id}:${period}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const entry = { status: 'loading' };
  cache.set(key, entry);
  loadActivity(settings, c, w.start, w.end)
    .then((data) => Object.assign(entry, { status: 'ok', data }))
    .catch((err) => Object.assign(entry, { status: 'error', error: err.message }))
    .finally(() => {
      if (location.hash.startsWith('#/monitoring')) store.refresh();
    });
  return entry;
}

const bucketValues = (w, times) => {
  const values = w.items.map(() => 0);
  for (const ms of times) {
    const i = w.items.findIndex((b) => ms >= b.start && ms < b.end);
    if (i >= 0) values[i]++;
  }
  return values;
};

// Counts by name, most first.
const tally = (items, nameOf) => {
  const map = new Map();
  for (const it of items) map.set(nameOf(it), (map.get(nameOf(it)) ?? 0) + 1);
  return [...map].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count);
};

const summaryOf = (d) => ({
  txs: d.txs?.length ?? null,
  senders: d.txs ? new Set(d.txs.map((t) => t.from.toLowerCase())).size : null,
  failed: d.txs ? d.txs.filter((t) => t.failed).length : null,
  events: d.events.length,
  last: Math.max(0, ...(d.txs ?? []).map((t) => t.at), ...d.events.map((e) => e.at)) || null,
});

// The search reached back only so far: say how far, when that is short of the period.
const coverage = (d, w) => (d.eventsFrom && d.eventsFrom > w.start ? `Events cover since ${timeOf(d.eventsFrom)}: the search stops at 100,000 blocks back or 2,000 events.` : '');

function contractChips(store, settings, list, current) {
  return h('div', { class: 'chips' }, [{ id: '', label: 'All' }, ...list].map((c) => {
    const chain = c.chainId ? chainById(settings, c.chainId) : null;
    return h('button', {
      type: 'button',
      class: c.id === (current?.id ?? '') ? 'chip active' : 'chip',
      onclick: () => {
        sel.contract = c.id;
        store.refresh();
      },
    }, c.chainId ? logo(chain?.logo, chain?.name ?? String(c.chainId), 'xs') : null, c.label);
  }));
}

function refreshButton(store, keys) {
  const busy = keys.some((k) => cache.get(k)?.status === 'loading');
  return h('button', {
    type: 'button',
    class: 'btn-small',
    disabled: busy,
    onclick: () => {
      for (const k of keys) cache.delete(k);
      store.refresh();
    },
  }, refreshIcon(busy), busy ? 'Reading…' : 'Refresh');
}

function allView(settings, list, w, entries) {
  const done = list.map((c, i) => ({ c, e: entries[i] })).filter((x) => x.e.status === 'ok');
  const failed = list.map((c, i) => ({ c, e: entries[i] })).filter((x) => x.e.status === 'error');
  const loading = entries.filter((e) => e.status === 'loading').length;
  const rows = done.map(({ c, e }) => ({ c, ...summaryOf(e.data) }));
  const series = done.map(({ c, e }, i) => ({
    name: c.label,
    color: COLORS[i % COLORS.length],
    values: bucketValues(w, [...(e.data.txs ?? []).map((t) => t.at), ...e.data.events.map((x) => x.at)]),
  }));
  const total = (k) => rows.reduce((n, r) => n + (r[k] ?? 0), 0);
  return [
    loading ? progress(`Reading ${loading} contract${loading === 1 ? '' : 's'}…`) : null,
    failed.length ? notice({ text: `Not read: ${failed.map(({ c, e }) => `${c.label} (${e.error})`).join('; ')}` }) : null,
    done.some(({ e }) => e.data.errors.length) ? notice({ text: done.filter(({ e }) => e.data.errors.length).map(({ c, e }) => `${c.label}: ${e.data.errors.join(' ')}`).join(' ') }) : null,
    h('div', { class: 'summary' },
      stat('Contracts', fmt(list.length)),
      etherscanKey(settings) ? stat('Transactions', fmt(total('txs'))) : null,
      etherscanKey(settings) ? stat('Failed', fmt(total('failed'))) : null,
      stat('Events', fmt(total('events')))),
    h('section', { class: 'card stack' },
      h('h3', null, 'Activity'),
      rows.some((r) => r.txs || r.events) ? [barChart(w.items.map((b) => b.label), series), legend(series)] : empty('No activity in this period.')),
    h('section', { class: 'card stack' },
      h('h3', null, 'By contract'),
      rows.length
        ? sortTable('contracts-all', [
          { label: 'Contract', value: (r) => r.c.label },
          { label: 'Chain', value: (r) => chainById(settings, r.c.chainId)?.name ?? String(r.c.chainId) },
          { label: 'Transactions', num: true, value: (r) => r.txs ?? -1, format: (v) => (v < 0 ? '—' : fmt(v)) },
          { label: 'Senders', num: true, value: (r) => r.senders ?? -1, format: (v) => (v < 0 ? '—' : fmt(v)) },
          { label: 'Events', num: true, value: (r) => r.events },
          { label: 'Last', num: true, value: (r) => r.last ?? 0, format: (v) => (v ? timeOf(v) : '—') },
        ], rows)
        : empty('Nothing read yet.')),
  ];
}

function oneView(settings, c, w, entry) {
  const chain = chainById(settings, c.chainId);
  if (entry.status === 'loading') return [progress(`Reading ${c.label} on ${chain?.name ?? `chain ${c.chainId}`}…`)];
  if (entry.status === 'error') return [notice({ text: entry.error })];
  const d = entry.data;
  const s = summaryOf(d);
  const series = [
    d.txs ? { name: 'Transactions', color: 'var(--accent)', values: bucketValues(w, d.txs.map((t) => t.at)) } : null,
    { name: 'Events', color: 'var(--info)', values: bucketValues(w, d.events.map((e) => e.at)) },
  ].filter(Boolean);
  const link = (hash) => {
    const url = explorerUrl(chain, 'tx', hash);
    return url ? h('a', { href: url, target: '_blank', rel: 'noopener' }, short(hash)) : copyable(hash, { label: short(hash) });
  };
  const recent = [
    ...(d.txs ?? []).map((t) => ({ at: t.at, kind: 'Transaction', name: t.method, who: t.from, hash: t.hash, failed: t.failed })),
    ...d.events.map((e) => ({ at: e.at, kind: 'Event', name: e.name, who: '', hash: e.hash })),
  ].sort((a, b) => b.at - a.at).slice(0, 25);
  const cov = coverage(d, w);
  return [
    d.errors.length ? notice({ text: d.errors.join(' ') }) : null,
    d.txs === null ? notice({ tone: 'info', text: 'Transactions need an Etherscan API key (Settings → Uniswap). Events are read from the node.' }) : null,
    h('div', { class: 'summary' },
      s.txs !== null ? stat('Transactions', fmt(s.txs)) : null,
      s.senders !== null ? stat('Senders', fmt(s.senders)) : null,
      s.failed !== null ? stat('Failed', fmt(s.failed)) : null,
      stat('Events', fmt(s.events), cov ? 'partly covered' : null),
      stat('Last activity', s.last ? timeOf(s.last) : '—')),
    h('section', { class: 'card stack' },
      h('h3', null, 'Activity'),
      s.txs || s.events ? [barChart(w.items.map((b) => b.label), series), legend(series)] : empty('No activity in this period.'),
      cov ? h('p', { class: 'muted small' }, cov) : null),
    h('div', { class: 'split-2' },
      d.txs ? h('section', { class: 'card stack' }, h('h3', null, 'Methods called'),
        d.txs.length ? sortTable(`contract-methods`, [{ label: 'Method', value: (r) => r.label }, { label: 'Calls', num: true, value: (r) => r.count }], tally(d.txs, (t) => t.method)) : empty('No transactions in this period.')) : null,
      h('section', { class: 'card stack' }, h('h3', null, 'Events emitted'),
        d.events.length ? sortTable(`contract-events`, [{ label: 'Event', value: (r) => r.label }, { label: 'Count', num: true, value: (r) => r.count }], tally(d.events, (e) => e.name)) : empty('No events in this period.'))),
    h('section', { class: 'card stack' },
      h('h3', null, 'Latest'),
      recent.length
        ? h('table', { class: 'mon-table' },
          h('thead', null, h('tr', null, ['When', 'Kind', 'Name', 'From', 'Transaction'].map((x) => h('th', null, x)))),
          h('tbody', null, recent.map((r) => h('tr', null,
            h('td', null, timeOf(r.at)),
            h('td', null, r.kind),
            h('td', null, r.name, r.failed ? h('span', { class: 'pill tone-high' }, 'Failed') : null),
            h('td', null, r.who ? copyable(r.who, { label: short(r.who) }) : '—'),
            h('td', null, link(r.hash))))))
        : empty('Nothing in this period.')),
  ];
}

export function contractsActivityTab(store, w, period) {
  const settings = store.get('settings');
  const list = contractsOf(settings);
  if (!list.length) {
    return h('div', { class: 'card stack' },
      empty('No smart contracts yet. Add one in Settings to follow its activity here.'),
      h('div', null, h('a', { href: '#/settings?section=contracts', class: 'btn-link' }, icon('code'), 'Open Settings → Smart contracts')));
  }
  const c = list.find((x) => x.id === sel.contract) ?? null;
  const shown = c ? [c] : list;
  const entries = shown.map((x) => load(store, settings, x, w, period));
  const head = h('div', { class: 'row between' }, contractChips(store, settings, list, c), refreshButton(store, shown.map((x) => `${x.id}:${period}`)));
  return h('div', { class: 'stack-lg' }, head, c ? oneView(settings, c, w, entries[0]) : allView(settings, list, w, entries));
}

export const contractsActivitySerialize = () => sel.contract;
export const contractsActivityRestore = (id) => {
  sel.contract = id || '';
};
