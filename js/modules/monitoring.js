import { h, icon, money, empty } from '../ui.js';
import { getCatalog } from '../model-picker.js';

const COLLECTION = 'usage';
const RANGES = [['7', 'Last 7 days'], ['30', 'Last 30 days'], ['all', 'All time']];

// View state: the period shown.
const view = { range: '30' };
// Prices per model (USD per token), from OpenRouter's public list. Used to estimate calls that had no reported cost.
const prices = { status: 'idle', map: new Map() };

const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
const dayOf = (iso) => iso.slice(0, 10);
const fmtTokens = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));
const usd = (n) => money(n, 'USD');
// Costs under a cent are shown with more decimals, so small calls are still visible.
const usdPrecise = (n) => (n < 0.01 ? `$${n.toFixed(4)}` : usd(n));

// A call's cost: the reported one, or an estimate from the model's price. Null when neither is known.
function costOf(e) {
  if (e.cost !== null && e.cost !== undefined) return { value: e.cost, estimated: false };
  const p = prices.map.get(e.model);
  if (!p) return null;
  return { value: e.promptTokens * p.prompt + e.completionTokens * p.completion, estimated: true };
}

function loadPrices(store) {
  if (prices.status === 'loading' || prices.status === 'ok') return;
  prices.status = 'loading';
  store.refresh();
  getCatalog()
    .then((models) => {
      for (const m of models) prices.map.set(m.id, { prompt: (m.prompt ?? 0) / 1e6, completion: (m.completion ?? 0) / 1e6 });
      prices.status = 'ok';
    })
    .catch(() => {
      prices.status = 'error';
    })
    .finally(() => store.refresh());
}

function stat(label, value, hint) {
  return h('div', { class: 'card stat' },
    h('span', { class: 'muted small' }, label),
    h('strong', null, value),
    hint ? h('span', { class: 'muted small' }, hint) : null);
}

// A table of rows grouped by a key, with calls, tokens and cost.
function groupTable(title, rows, label) {
  if (!rows.length) return h('section', { class: 'card stack' }, h('h3', null, title), empty('No calls in this period.'));
  return h('section', { class: 'card stack' },
    h('h3', null, title),
    h('div', { class: 'mon-scroll' },
      h('table', { class: 'mon-table' },
        h('thead', null, h('tr', null,
          h('th', null, label),
          h('th', { class: 'num' }, 'Calls'),
          h('th', { class: 'num' }, 'Tokens'),
          h('th', { class: 'num' }, 'Cost'))),
        h('tbody', null, rows.map((r) =>
          h('tr', null,
            h('td', null, r.label),
            h('td', { class: 'num' }, String(r.calls)),
            h('td', { class: 'num' }, fmtTokens(r.tokens)),
            h('td', { class: 'num' }, r.cost === null ? '—' : `${r.estimated ? '≈ ' : ''}${usdPrecise(r.cost)}`)))))));
}

// Groups calls by a key and sums them.
function group(entries, keyOf, labelOf) {
  const map = new Map();
  for (const e of entries) {
    const key = keyOf(e);
    const row = map.get(key) ?? { label: labelOf(e), calls: 0, tokens: 0, cost: 0, estimated: false, priced: 0 };
    row.calls += 1;
    row.tokens += e.promptTokens + e.completionTokens;
    const c = costOf(e);
    if (c) {
      row.cost += c.value;
      row.priced += 1;
      row.estimated = row.estimated || c.estimated;
    }
    map.set(key, row);
  }
  return [...map.values()]
    .map((r) => ({ ...r, cost: r.priced ? r.cost : null }))
    .sort((a, b) => (b.cost ?? 0) - (a.cost ?? 0) || b.calls - a.calls);
}

// Cost per day as bars, scaled to the largest day.
function dailyBars(entries, days) {
  const perDay = new Map();
  for (let i = days - 1; i >= 0; i--) perDay.set(daysAgo(i), 0);
  for (const e of entries) {
    const d = dayOf(e.at);
    if (!perDay.has(d)) continue;
    const c = costOf(e);
    perDay.set(d, perDay.get(d) + (c ? c.value : 0));
  }
  const max = Math.max(0, ...perDay.values());
  return h('section', { class: 'card stack' },
    h('h3', null, 'Cost per day'),
    max === 0
      ? empty('No cost recorded yet.')
      : h('div', { class: 'bars-day', role: 'img', 'aria-label': 'Cost per day' },
          [...perDay].map(([day, value]) =>
            h('div', { class: 'day', title: `${day}: ${usdPrecise(value)}` },
              h('div', { class: 'day-bar', style: { height: `${(value / max) * 100}%` } }),
              h('span', { class: 'day-label' }, day.slice(5))))));
}

function draw(root, store) {
  if (prices.status === 'idle') {
    // Load prices after this render, so the refresh does not run inside it.
    setTimeout(() => loadPrices(store), 0);
  }
  const all = store.get(COLLECTION).entries;
  const days = view.range === 'all' ? 30 : Number(view.range);
  const entries = view.range === 'all' ? all : all.filter((e) => dayOf(e.at) >= daysAgo(days - 1));
  const tasks = new Map((store.get('settings').models?.tasks ?? []).map((t) => [t.id, t.name]));

  const totalCost = entries.reduce((s, e) => s + (costOf(e)?.value ?? 0), 0);
  const unpriced = entries.filter((e) => !costOf(e)).length;
  const tokens = entries.reduce((s, e) => s + e.promptTokens + e.completionTokens, 0);
  const estimated = entries.some((e) => {
    const c = costOf(e);
    return c && c.estimated;
  });

  const recent = [...entries].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 20);

  root.replaceChildren(
    h('div', { class: 'stack-lg' },
      h('div', { class: 'row between head' },
        h('div', null,
          h('h2', null, 'Monitoring'),
          h('p', { class: 'muted small' }, 'AI usage, from the calls the board makes with your OpenRouter key.')),
        h('label', { class: 'inline' }, 'Period',
          h('select', {
            value: view.range,
            'aria-label': 'Period',
            onchange: (e) => {
              view.range = e.target.value;
              store.refresh();
            },
          }, RANGES.map(([k, l]) => h('option', { value: k }, l))))),

      prices.status === 'error'
        ? h('p', { class: 'muted small' }, 'Model prices could not be loaded, so calls without a reported cost are not priced.')
        : null,

      h('div', { class: 'summary' },
        stat('Cost', `${estimated ? '≈ ' : ''}${usdPrecise(totalCost)}`, unpriced ? `${unpriced} call${unpriced === 1 ? '' : 's'} without a price` : 'USD'),
        stat('Calls', String(entries.length), `${new Set(entries.map((e) => dayOf(e.at))).size} active days`),
        stat('Tokens', fmtTokens(tokens), 'input + output')),

      dailyBars(entries, days),

      h('div', { class: 'split' },
        groupTable('By task', group(entries, (e) => e.task, (e) => tasks.get(e.task) ?? e.task), 'Task'),
        groupTable('By model', group(entries, (e) => e.model, (e) => e.model), 'Model')),

      h('section', { class: 'card stack' },
        h('h3', null, 'Recent calls'),
        recent.length
          ? h('ul', { class: 'mon-recent' },
              recent.map((e) => {
                const c = costOf(e);
                return h('li', null,
                  h('span', { class: 'muted small time' }, e.at.slice(0, 16).replace('T', ' ')),
                  h('span', { class: 'grow' }, tasks.get(e.task) ?? e.task, h('span', { class: 'muted small' }, ` · ${e.model}`)),
                  h('span', { class: 'muted small' }, `${fmtTokens(e.promptTokens + e.completionTokens)} tokens`),
                  h('span', { class: 'num' }, c ? `${c.estimated ? '≈ ' : ''}${usdPrecise(c.value)}` : '—'));
              }))
          : empty('No AI calls yet. Calls appear here after you use a feature such as Tidy with AI or reading a bill.'))));
}

export default {
  id: 'monitoring',
  title: 'Monitoring',
  icon: 'activity',
  collection: COLLECTION,
  defaults: { entries: [] },
  render: draw,
  serialize: () => ({ range: view.range === '30' ? '' : view.range }),
  restore: (p = {}) => {
    view.range = RANGES.some(([k]) => k === p.range) ? p.range : '30';
  },
};
