// Monitoring tabs for the project websites: visitors (Google Analytics) and search (Google Search Console, Bing).
import { h, empty, notice, progress } from '../ui.js';
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

function siteChips(store, view, sites, current) {
  return h('div', { class: 'chips' }, sites.map((p) =>
    h('button', {
      type: 'button',
      class: p.id === current.id ? 'chip active' : 'chip',
      onclick: () => {
        view.site = p.id;
        store.refresh();
      },
    }, p.name)));
}

function table(head, rows, format) {
  if (!rows.length) return empty('Nothing in this period.');
  return h('div', { class: 'mon-scroll' },
    h('table', { class: 'mon-table' },
      h('thead', null, h('tr', null, head.map((t, i) => h('th', { class: i ? 'num' : null }, t)))),
      h('tbody', null, rows.map((r) => h('tr', null, r.map((c, i) => h('td', { class: i ? 'num' : 'cell-clip' }, format?.[i] ? format[i](c) : String(c))))))));
}

const refreshButton = (store, key) =>
  h('button', {
    type: 'button',
    class: 'btn-small',
    onclick: () => {
      cache.delete(key);
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
  const p = sites.find((x) => x.id === view.site) ?? sites[0];
  const b = dayBuckets(w);
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
  const p = sites.find((x) => x.id === view.site) ?? sites[0];
  const b = dayBuckets(w);
  const key = `${engine}:${p.id}:${b.from}:${b.to}`;
  const entry = load(store, key, () => (engine === 'google' ? searchReport(p.website, b.from, b.to) : bingReport(bingKey, p.website, b.from, b.to)));
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
