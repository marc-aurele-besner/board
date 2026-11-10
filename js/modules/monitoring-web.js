// Monitoring tabs for the project websites: visitors (Google Analytics) and search (Google Search Console, Bing).
import { h, empty, notice, progress, icon } from '../ui.js';
import { setupBanner } from '../integrations.js';
import { isConnected } from '../google.js';
import { analyticsReport, searchReport, bingReport } from '../webstats.js';
import { sitesOf } from '../automations.js';
import { hostOf } from '../sitecheck.js';
import { barChart, legend, stat } from './monitoring.js';

const ymd = (ms) => {
  const d = new Date(ms);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
};
const fmt = (n) => Math.round(n).toLocaleString();
const pct = (n) => `${(n * 100).toFixed(1)}%`;
const duration = (s) => (s >= 60 ? `${Math.floor(s / 60)} min ${Math.round(s % 60)} s` : `${Math.round(s)} s`);

// One load per site, period and source. Kept until the page is reloaded or "Refresh" is pressed.
const cache = new Map();

function load(store, key, work) {
  const hit = cache.get(key);
  if (hit) return hit;
  const entry = { status: 'loading' };
  cache.set(key, entry);
  work()
    .then((data) => Object.assign(entry, { status: 'ok', data }))
    .catch((err) => Object.assign(entry, { status: 'error', error: err.message }))
    .finally(() => {
      if (location.hash.startsWith('#/monitoring')) store.refresh();
    });
  return entry;
}

// The days of the period as chart buckets. A one-day period is one bucket: these services report per day.
function dayBuckets(w) {
  const from = ymd(w.start);
  const to = ymd(w.end - 1);
  const days = [];
  for (let ms = new Date(`${from}T12:00:00`).getTime(); ymd(ms) <= to; ms += 86400000) days.push(ymd(ms));
  return { from, to, days, labels: days.map((d) => `${Number(d.slice(5, 7))}/${Number(d.slice(8))}`) };
}

// "All" comes first and is the default: an empty `view.site` adds every site together.
function siteChips(store, view, sites, current) {
  return h('div', { class: 'chips' }, [{ id: '', name: 'All' }, ...sites].map((p) =>
    h('button', {
      type: 'button',
      class: p.id === (current?.id ?? '') ? 'chip active' : 'chip',
      onclick: () => {
        view.site = p.id;
        store.refresh();
      },
    }, p.name)));
}

const pickedSite = (view, sites) => sites.find((x) => x.id === view.site) ?? null;

// Loads every site for the "All" view. Sites that fail are named; the others are still added up.
function loadAll(store, sites, keyOf, work) {
  const entries = sites.map((p) => ({ p, key: keyOf(p), entry: load(store, keyOf(p), () => work(p)) }));
  return {
    keys: entries.map((e) => e.key),
    loading: entries.some((e) => e.entry.status === 'loading'),
    ok: entries.filter((e) => e.entry.status === 'ok').map((e) => ({ p: e.p, d: e.entry.data })),
    failed: entries.filter((e) => e.entry.status === 'error').map((e) => `${hostOf(e.p.website)} (${e.entry.error})`),
  };
}

// Adds up rows of [name, ...numbers] from several sites, keeping the top `n` by the first number.
function mergeRows(lists, n = 8) {
  const sum = new Map();
  for (const rows of lists) {
    for (const [name, ...nums] of rows) {
      const cur = sum.get(name) ?? nums.map(() => 0);
      sum.set(name, cur.map((v, i) => v + nums[i]));
    }
  }
  return [...sum.entries()].sort((a, b) => b[1][0] - a[1][0]).slice(0, n).map(([name, nums]) => [name, ...nums]);
}

// Search rows are [name, clicks, impressions, ctr, position]. Clicks and impressions add up; the rate
// is worked out again and the position is weighed by impressions.
function mergeSearchRows(lists, n = 10) {
  const sum = new Map();
  for (const rows of lists) {
    for (const [name, clicks, imps, , pos] of rows) {
      const cur = sum.get(name) ?? { clicks: 0, imps: 0, pos: 0 };
      cur.clicks += clicks;
      cur.imps += imps;
      cur.pos += (pos || 0) * imps;
      sum.set(name, cur);
    }
  }
  return [...sum.entries()].sort((a, b) => b[1].clicks - a[1].clicks || b[1].imps - a[1].imps).slice(0, n)
    .map(([name, v]) => [name, v.clicks, v.imps, v.imps ? v.clicks / v.imps : 0, v.imps ? v.pos / v.imps : 0]);
}

// Sort choice per table, kept across re-renders. No entry means the order the rows came in.
const sorts = new Map();

const compare = (a, b) => {
  // Missing values sink to the bottom in both directions.
  if (a === null || a === undefined) return b === null || b === undefined ? 0 : 1;
  if (b === null || b === undefined) return -1;
  return typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b));
};

// A table whose headers sort it. Columns: { label, num, value(row), format(value, row), clip }.
// A click re-sorts only the body, so the page keeps its scroll and nothing reloads.
export function sortTable(key, columns, rows) {
  const tbody = h('tbody');
  const ths = columns.map((c, i) => h('th', { class: c.num ? 'num' : null },
    h('button', { type: 'button', class: 'mon-sort', onclick: () => pick(i) }, c.label, h('span', { class: 'sort-mark' }))));
  const draw = () => {
    const s = sorts.get(key);
    const list = s ? [...rows].sort((a, b) => {
      const va = columns[s.col].value(a);
      const vb = columns[s.col].value(b);
      if (va === null || va === undefined || vb === null || vb === undefined) return compare(va, vb);
      return s.dir * compare(va, vb);
    }) : rows;
    ths.forEach((th, i) => {
      const on = s?.col === i;
      if (on) th.setAttribute('aria-sort', s.dir > 0 ? 'ascending' : 'descending');
      else th.removeAttribute('aria-sort');
      th.querySelector('.sort-mark').replaceChildren(icon(on && s.dir > 0 ? 'chevron-up' : 'chevron-down'));
    });
    tbody.replaceChildren(...list.map((r) => h('tr', null, columns.map((c) => {
      const v = c.value(r);
      return h('td', { class: c.num ? 'num' : c.clip ? 'cell-clip' : null }, c.format ? c.format(v, r) : String(v ?? '—'));
    }))));
  };
  // Numbers start high to low, text A to Z; a second click flips it.
  const pick = (i) => {
    const s = sorts.get(key);
    sorts.set(key, { col: i, dir: s?.col === i ? -s.dir : columns[i].num ? -1 : 1 });
    draw();
  };
  draw();
  return h('div', { class: 'mon-scroll' }, h('table', { class: 'mon-table' }, h('thead', null, h('tr', null, ths)), tbody));
}

function table(head, rows, format) {
  if (!rows.length) return empty('Nothing in this period.');
  return sortTable(head.join('|'), head.map((label, i) => ({
    label, num: i > 0, clip: i === 0, value: (r) => r[i], format: format?.[i] ? (v) => format[i](v) : null,
  })), rows);
}

const refreshButton = (store, keys) =>
  h('button', {
    type: 'button',
    class: 'btn-small',
    onclick: () => {
      for (const key of [keys].flat()) cache.delete(key);
      store.refresh();
    },
  }, 'Refresh');

// --- Web analytics ---

export function analyticsTab(store, view, w) {
  const settings = store.get('settings');
  const props = settings.analytics?.properties ?? {};
  if (!isConnected('analytics')) {
    return setupBanner('analytics', settings.google?.clientId
      ? 'Connect Google Analytics to see visitors and page views for each project website. The connection lasts about an hour.'
      : 'Google Analytics needs a Google OAuth Client ID and a property for each project.');
  }
  const sites = sitesOf(store).filter((p) => props[p.id]);
  if (!sites.length) return setupBanner('analytics', 'Google Analytics is connected, but no project has a property yet. Add a property ID to a project.');
  const p = pickedSite(view, sites);
  const b = dayBuckets(w);
  if (!p) return analyticsAll(store, view, sites, props, b);
  const key = `ga:${p.id}:${b.from}:${b.to}`;
  const entry = load(store, key, () => analyticsReport(props[p.id], b.from, b.to));
  const head = h('div', { class: 'row between' }, siteChips(store, view, sites, p), refreshButton(store, key));
  if (entry.status === 'loading') return h('div', { class: 'stack-lg' }, head, progress(`Reading Google Analytics for ${hostOf(p.website)}…`));
  if (entry.status === 'error') return h('div', { class: 'stack-lg' }, head, notice({ text: entry.error }));
  const d = entry.data;
  const series = [
    { name: 'Users', color: 'var(--accent)', values: b.days.map((day) => d.days[day]?.users ?? 0) },
    { name: 'Page views', color: 'var(--info)', values: b.days.map((day) => d.days[day]?.views ?? 0) },
  ];
  return h('div', { class: 'stack-lg' }, head,
    h('p', { class: 'muted small' }, `${hostOf(p.website)} · ${props[p.id]}`),
    h('div', { class: 'summary' },
      stat('Users', fmt(d.totals.users)),
      stat('Sessions', fmt(d.totals.sessions)),
      stat('Page views', fmt(d.totals.views)),
      stat('Average session', duration(d.totals.seconds)),
      stat('Engagement rate', pct(d.totals.engagement))),
    h('div', { class: 'split-2' }, series.map((s) =>
      h('section', { class: 'card stack' }, h('h3', null, s.name), d.totals.views ? barChart(b.labels, [s]) : empty('No visits recorded in this period.'), legend([s])))),
    h('div', { class: 'split-3' },
      h('section', { class: 'card stack' }, h('h3', null, 'Top pages'), table(['Page', 'Views', 'Users'], d.pages, [null, fmt, fmt])),
      h('section', { class: 'card stack' }, h('h3', null, 'Where visitors come from'), table(['Source', 'Sessions'], d.sources, [null, fmt])),
      h('section', { class: 'card stack' }, h('h3', null, 'Countries'), table(['Country', 'Users'], d.countries, [null, fmt]))));
}

// --- Search ---

export function searchTab(store, view, w) {
  const settings = store.get('settings');
  const engine = view.engine === 'bing' ? 'bing' : 'google';
  const bingKey = settings.bing?.key ?? '';
  const engines = h('div', { class: 'period', role: 'group', 'aria-label': 'Search engine' },
    [['google', 'Google Search Console'], ['bing', 'Bing Webmaster Tools']].map(([key, label]) =>
      h('button', {
        type: 'button',
        class: engine === key ? 'period-btn active' : 'period-btn',
        'aria-pressed': String(engine === key),
        onclick: () => {
          view.engine = key;
          store.refresh();
        },
      }, label)));
  if (engine === 'google' ? !isConnected('search') : !bingKey) {
    return h('div', { class: 'stack-lg' }, engines,
      setupBanner('search', engine === 'google'
        ? 'Connect Google Search Console to see clicks, impressions and queries. The connection lasts about an hour.'
        : 'Add a Bing Webmaster API key to see clicks, impressions and queries from Bing.'));
  }
  const sites = sitesOf(store);
  if (!sites.length) return h('div', { class: 'stack-lg' }, engines, empty('No project has a website yet. Add one on a project page.'));
  const p = pickedSite(view, sites);
  const b = dayBuckets(w);
  const report = (x) => (engine === 'google' ? searchReport(x.website, b.from, b.to) : bingReport(bingKey, x.website, b.from, b.to, settings.bing?.relay));
  if (!p) return searchAll(store, view, sites, engine, engines, b, report);
  const key = `${engine}:${p.id}:${b.from}:${b.to}`;
  const entry = load(store, key, () => report(p));
  const head = h('div', { class: 'row between' }, siteChips(store, view, sites, p), refreshButton(store, key));
  if (entry.status === 'loading') return h('div', { class: 'stack-lg' }, engines, head, progress(`Reading search data for ${hostOf(p.website)}…`));
  if (entry.status === 'error') return h('div', { class: 'stack-lg' }, engines, head, notice({ text: entry.error }));
  const d = entry.data;
  const clicks = b.days.map((day) => d.days[day]?.clicks ?? 0);
  const imps = b.days.map((day) => d.days[day]?.impressions ?? 0);
  const C = clicks.reduce((s, n) => s + n, 0);
  const I = imps.reduce((s, n) => s + n, 0);
  const positions = b.days.map((day) => d.days[day]?.position).filter(Boolean);
  const cols = ['', 'Clicks', 'Impressions', 'CTR', 'Position'];
  const format = [null, fmt, fmt, pct, (n) => (n ? n.toFixed(1) : '—')];
  const clickSeries = [{ name: 'Clicks', color: 'var(--accent)', values: clicks }];
  const impSeries = [{ name: 'Impressions', color: 'var(--info)', values: imps }];
  return h('div', { class: 'stack-lg' }, engines, head,
    h('p', { class: 'muted small' }, `${hostOf(p.website)} · ${d.site}. Search data arrives two to three days late.`),
    h('div', { class: 'summary' },
      stat('Clicks', fmt(C)),
      stat('Impressions', fmt(I)),
      stat('Click-through rate', I ? pct(C / I) : '—'),
      stat('Average position', positions.length ? (positions.reduce((s, n) => s + n, 0) / positions.length).toFixed(1) : '—')),
    h('div', { class: 'split-2' },
      h('section', { class: 'card stack' }, h('h3', null, 'Clicks'), C ? barChart(b.labels, clickSeries) : empty('No clicks in this period.'), legend(clickSeries)),
      h('section', { class: 'card stack' }, h('h3', null, 'Impressions'), I ? barChart(b.labels, impSeries) : empty('No impressions in this period.'), legend(impSeries))),
    h('div', { class: 'split-2' },
      h('section', { class: 'card stack' }, h('h3', null, 'Top queries'), table(['Query', ...cols.slice(1)], d.queries, format)),
      h('section', { class: 'card stack' }, h('h3', null, 'Top pages'), table(['Page', ...cols.slice(1)], d.pages, format))));
}

// --- All sites ---

function analyticsAll(store, view, sites, props, b) {
  const all = loadAll(store, sites, (p) => `ga:${p.id}:${b.from}:${b.to}`, (p) => analyticsReport(props[p.id], b.from, b.to));
  const head = h('div', { class: 'row between' }, siteChips(store, view, sites, null), refreshButton(store, all.keys));
  const failed = all.failed.length ? notice({ text: `Could not read: ${all.failed.join('; ')}` }) : null;
  if (all.loading) return h('div', { class: 'stack-lg' }, head, progress(`Reading Google Analytics for ${sites.length} site${sites.length === 1 ? '' : 's'}…`));
  if (!all.ok.length) return h('div', { class: 'stack-lg' }, head, failed);
  const sum = (f) => all.ok.reduce((s, x) => s + f(x.d), 0);
  const sessions = sum((d) => d.totals.sessions);
  // Duration and engagement are per session, so each site counts by its number of sessions.
  const perSession = (f) => (sessions ? sum((d) => f(d) * d.totals.sessions) / sessions : 0);
  const views = sum((d) => d.totals.views);
  const series = [
    { name: 'Users', color: 'var(--accent)', values: b.days.map((day) => sum((d) => d.days[day]?.users ?? 0)) },
    { name: 'Page views', color: 'var(--info)', values: b.days.map((day) => sum((d) => d.days[day]?.views ?? 0)) },
  ];
  const bySite = all.ok.map(({ p, d }) => [p.name, d.totals.users, d.totals.sessions, d.totals.views]).sort((a, c) => c[3] - a[3]);
  const pages = mergeRows(all.ok.map(({ p, d }) => d.pages.map(([path, ...n]) => [`${hostOf(p.website)}${path}`, ...n])));
  return h('div', { class: 'stack-lg' }, head, failed,
    h('p', { class: 'muted small' }, `${all.ok.length} site${all.ok.length === 1 ? '' : 's'} added together. Users are counted per site, so someone who visits two sites counts twice.`),
    h('div', { class: 'summary' },
      stat('Users', fmt(sum((d) => d.totals.users))),
      stat('Sessions', fmt(sessions)),
      stat('Page views', fmt(views)),
      stat('Average session', duration(perSession((d) => d.totals.seconds))),
      stat('Engagement rate', pct(perSession((d) => d.totals.engagement)))),
    h('div', { class: 'split-2' }, series.map((s) =>
      h('section', { class: 'card stack' }, h('h3', null, s.name), views ? barChart(b.labels, [s]) : empty('No visits recorded in this period.'), legend([s])))),
    h('section', { class: 'card stack' }, h('h3', null, 'By site'), table(['Site', 'Users', 'Sessions', 'Page views'], bySite, [null, fmt, fmt, fmt])),
    h('div', { class: 'split-3' },
      h('section', { class: 'card stack' }, h('h3', null, 'Top pages'), table(['Page', 'Views', 'Users'], pages, [null, fmt, fmt])),
      h('section', { class: 'card stack' }, h('h3', null, 'Where visitors come from'), table(['Source', 'Sessions'], mergeRows(all.ok.map((x) => x.d.sources)), [null, fmt])),
      h('section', { class: 'card stack' }, h('h3', null, 'Countries'), table(['Country', 'Users'], mergeRows(all.ok.map((x) => x.d.countries)), [null, fmt]))));
}

// Clicks, impressions, rate and average position over a set of day rows; the position is weighed by impressions.
function searchTotals(rows) {
  const clicks = rows.reduce((s, r) => s + r.clicks, 0);
  const imps = rows.reduce((s, r) => s + r.impressions, 0);
  const seen = rows.filter((r) => r.position);
  const weight = seen.reduce((s, r) => s + r.impressions, 0);
  return { clicks, imps, ctr: imps ? clicks / imps : 0, position: weight ? seen.reduce((s, r) => s + r.position * r.impressions, 0) / weight : 0 };
}

function searchAll(store, view, sites, engine, engines, b, report) {
  const all = loadAll(store, sites, (p) => `${engine}:${p.id}:${b.from}:${b.to}`, report);
  const head = h('div', { class: 'row between' }, siteChips(store, view, sites, null), refreshButton(store, all.keys));
  const failed = all.failed.length ? notice({ text: `Could not read: ${all.failed.join('; ')}` }) : null;
  if (all.loading) return h('div', { class: 'stack-lg' }, engines, head, progress(`Reading search data for ${sites.length} site${sites.length === 1 ? '' : 's'}…`));
  if (!all.ok.length) return h('div', { class: 'stack-lg' }, engines, head, failed);
  const daysOf = (d) => b.days.map((day) => d.days[day]).filter(Boolean);
  const total = searchTotals(all.ok.flatMap((x) => daysOf(x.d)));
  const daySum = (f) => b.days.map((day) => all.ok.reduce((s, x) => s + (x.d.days[day]?.[f] ?? 0), 0));
  const cols = ['', 'Clicks', 'Impressions', 'CTR', 'Position'];
  const format = [null, fmt, fmt, pct, (n) => (n ? n.toFixed(1) : '—')];
  const bySite = all.ok.map(({ p, d }) => {
    const t = searchTotals(daysOf(d));
    return [p.name, t.clicks, t.imps, t.ctr, t.position];
  }).sort((a, c) => c[1] - a[1] || c[2] - a[2]);
  const clickSeries = [{ name: 'Clicks', color: 'var(--accent)', values: daySum('clicks') }];
  const impSeries = [{ name: 'Impressions', color: 'var(--info)', values: daySum('impressions') }];
  return h('div', { class: 'stack-lg' }, engines, head, failed,
    h('p', { class: 'muted small' }, `${all.ok.length} site${all.ok.length === 1 ? '' : 's'} added together. Search data arrives two to three days late.`),
    h('div', { class: 'summary' },
      stat('Clicks', fmt(total.clicks)),
      stat('Impressions', fmt(total.imps)),
      stat('Click-through rate', total.imps ? pct(total.ctr) : '—'),
      stat('Average position', total.position ? total.position.toFixed(1) : '—')),
    h('div', { class: 'split-2' },
      h('section', { class: 'card stack' }, h('h3', null, 'Clicks'), total.clicks ? barChart(b.labels, clickSeries) : empty('No clicks in this period.'), legend(clickSeries)),
      h('section', { class: 'card stack' }, h('h3', null, 'Impressions'), total.imps ? barChart(b.labels, impSeries) : empty('No impressions in this period.'), legend(impSeries))),
    h('section', { class: 'card stack' }, h('h3', null, 'By site'), table(['Site', ...cols.slice(1)], bySite, format)),
    h('div', { class: 'split-2' },
      h('section', { class: 'card stack' }, h('h3', null, 'Top queries'), table(['Query', ...cols.slice(1)], mergeSearchRows(all.ok.map((x) => x.d.queries)), format)),
      h('section', { class: 'card stack' }, h('h3', null, 'Top pages'), table(['Page', ...cols.slice(1)], mergeSearchRows(all.ok.map((x) => x.d.pages)), format))));
}
