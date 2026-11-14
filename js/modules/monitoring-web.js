// Monitoring tabs for the project websites: visitors (Google Analytics) and search (Google Search Console, Bing, or both added together).
import { h, empty, notice, progress, icon, refreshIcon } from '../ui.js';
import { setupBanner } from '../integrations.js';
import { isConnected } from '../google.js';
import { analyticsReport, searchReport, bingReport, mergeSearchRows, mergeSearchReports } from '../webstats.js';
import { sitesOf, searchSitesOf } from '../automations.js';
import { hostOf } from '../sitecheck.js';
import { barChart, legend } from '../chart.js';
import { stat } from './monitoring.js';
import { projectLabel } from './monitoring-ai.js';
/** @import { Project, Store } from '../../types/data' */
/** @import { Child } from '../../types/ui' */
/** @import { MonitoringView, PeriodWindow, SortColumn } from '../../types/monitoring' */
/** @import { SearchReport } from '../webstats.js' */

/** @typedef {Awaited<ReturnType<typeof analyticsReport>>} AnalyticsData */
/** @template T @typedef {{ status: 'loading' } | { status: 'ok', data: T } | { status: 'error', error: string }} Loaded */
/** The period's days. @typedef {ReturnType<typeof dayBuckets>} DayBuckets */

const ymd = (/** @type {number} */ ms) => {
  const d = new Date(ms);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
};
const fmt = (/** @type {number} */ n) => Math.round(n).toLocaleString();
const pct = (/** @type {number} */ n) => `${(n * 100).toFixed(1)}%`;
const duration = (/** @type {number} */ s) => (s >= 60 ? `${Math.floor(s / 60)} min ${Math.round(s % 60)} s` : `${Math.round(s)} s`);

// One load per site, period and source. Kept until the page is reloaded or "Refresh" is pressed.
/** @type {Map<string, Loaded<unknown>>} */
const cache = new Map();

/** @template T @param {Store} store @param {string} key @param {() => Promise<T>} work @returns {Loaded<T>} */
function load(store, key, work) {
  const hit = /** @type {Loaded<T> | undefined} */ (cache.get(key));
  if (hit) return hit;
  /** @type {Loaded<T>} */
  const entry = { status: 'loading' };
  cache.set(key, entry);
  work()
    .then((data) => Object.assign(entry, { status: 'ok', data }))
    .catch((/** @type {Error} */ err) => Object.assign(entry, { status: 'error', error: err.message }))
    .finally(() => {
      if (location.hash.startsWith('#/monitoring')) store.refresh();
    });
  return entry;
}

// The days of the period as chart buckets. A one-day period is one bucket: these services report per day.
/** @param {PeriodWindow} w */
function dayBuckets(w) {
  const from = ymd(w.start);
  const to = ymd(w.end - 1);
  /** @type {string[]} */
  const days = [];
  for (let ms = new Date(`${from}T12:00:00`).getTime(); ymd(ms) <= to; ms += 86400000) days.push(ymd(ms));
  return { from, to, days, labels: days.map((d) => `${Number(d.slice(5, 7))}/${Number(d.slice(8))}`) };
}

// "All" comes first and is the default: an empty `view.site` adds every site together.
// A site's chip carries its project's icon; "All" has none.
/** @param {Store} store @param {MonitoringView} view @param {Project[]} sites @param {Project | null} current */
function siteChips(store, view, sites, current) {
  return h('div', { class: 'chips' }, [null, ...sites].map((p) =>
    h('button', {
      type: 'button',
      class: (p?.id ?? '') === (current?.id ?? '') ? 'chip active' : 'chip',
      onclick: () => {
        view.site = p?.id ?? '';
        store.refresh();
      },
    }, p ? projectLabel(p) : 'All')));
}

const pickedSite = (/** @type {MonitoringView} */ view, /** @type {Project[]} */ sites) => sites.find((x) => x.id === view.site) ?? null;

// Loads every site for the "All" view. Sites that fail are named; the others are still added up.
/** @template T @param {Store} store @param {Project[]} sites @param {(p: Project) => string} keyOf @param {(p: Project) => Promise<T>} work */
function loadAll(store, sites, keyOf, work) {
  const entries = sites.map((p) => ({ p, key: keyOf(p), entry: load(store, keyOf(p), () => work(p)) }));
  return {
    keys: entries.map((e) => e.key),
    loading: entries.some((e) => e.entry.status === 'loading'),
    ok: entries.filter((e) => e.entry.status === 'ok').map((e) => ({ p: e.p, d: /** @type {{ data: T }} */ (e.entry).data })),
    failed: entries.filter((e) => e.entry.status === 'error').map((e) => `${hostOf(e.p.website)} (${/** @type {{ error: string }} */ (e.entry).error})`),
  };
}

// Adds up rows of [name, ...numbers] from several sites, keeping the top `n` by the first number.
/** @param {(string | number)[][][]} lists @param {number} [n] */
function mergeRows(lists, n = 8) {
  /** @type {Map<string | number, number[]>} */
  const sum = new Map();
  for (const rows of lists) {
    for (const [name, ...nums] of rows) {
      const cur = sum.get(name) ?? nums.map(() => 0);
      sum.set(name, cur.map((v, i) => v + /** @type {number} */ (nums[i])));
    }
  }
  return [...sum.entries()].sort((a, b) => b[1][0] - a[1][0]).slice(0, n).map(([name, nums]) => [name, ...nums]);
}

// Sort choice per table, kept across re-renders. No entry means the order the rows came in.
/** @type {Map<string, { col: number, dir: number }>} */
const sorts = new Map();

const compare = (/** @type {unknown} */ a, /** @type {unknown} */ b) => {
  // Missing values sink to the bottom in both directions.
  if (a === null || a === undefined) return b === null || b === undefined ? 0 : 1;
  if (b === null || b === undefined) return -1;
  return typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b));
};

// A table whose headers sort it. Columns: { label, num, value(row), format(value, row), clip }.
// A click re-sorts only the body, so the page keeps its scroll and nothing reloads.
// `rowClass(row)` gives a row its class, such as a session still running.
/**
 * @template R
 * @param {string} key
 * @param {SortColumn<NoInfer<R>>[]} columns
 * @param {R[]} rows
 * @param {((row: R) => string) | null} [rowClass]
 */
export function sortTable(key, columns, rows, rowClass = null) {
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
      if (on) th.setAttribute('aria-sort', /** @type {{ dir: number }} */ (s).dir > 0 ? 'ascending' : 'descending');
      else th.removeAttribute('aria-sort');
      /** @type {HTMLElement} */ (th.querySelector('.sort-mark')).replaceChildren(icon(on && /** @type {{ dir: number }} */ (s).dir > 0 ? 'chevron-up' : 'chevron-down'));
    });
    tbody.replaceChildren(...list.map((r) => h('tr', { class: rowClass?.(r) || null }, columns.map((c) => {
      const v = c.value(r);
      return h('td', { class: c.num ? 'num' : c.clip ? 'cell-clip' : null }, c.format ? c.format(/** @type {never} */ (v), r) : String(v ?? '—'));
    }))));
  };
  // Numbers start high to low, text A to Z; a second click flips it.
  const pick = (/** @type {number} */ i) => {
    const s = sorts.get(key);
    sorts.set(key, { col: i, dir: s?.col === i ? -s.dir : columns[i].num ? -1 : 1 });
    draw();
  };
  draw();
  return h('div', { class: 'mon-scroll' }, h('table', { class: 'mon-table' }, h('thead', null, h('tr', null, ths)), tbody));
}

/** @param {string[]} head @param {unknown[][]} rows @param {(((value: never) => Child) | null)[]} [format] */
function table(head, rows, format) {
  if (!rows.length) return empty('Nothing in this period.');
  return sortTable(head.join('|'), head.map((label, i) => ({
    label, num: i > 0, clip: i === 0, value: (r) => r[i], format: format?.[i] ? (/** @type {never} */ v) => /** @type {(value: never) => Child} */ (format[i])(v) : null,
  })), rows);
}

/** A site's row in an All view: its project, then its numbers. @typedef {[Project, ...number[]]} SiteRow */

// The "By site" table: a site is named with its project's icon, and still sorts by its name.
/** @param {string[]} head @param {SiteRow[]} rows @param {((value: number) => Child)[]} format One per number column. */
function siteTable(head, rows, format) {
  if (!rows.length) return empty('Nothing in this period.');
  return sortTable(head.join('|'), head.map((label, i) => (i
    ? { label, num: true, value: (/** @type {SiteRow} */ r) => r[i], format: format[i - 1] }
    : { label, clip: true, value: (/** @type {SiteRow} */ r) => r[0].name, format: (/** @type {string} */ _name, /** @type {SiteRow} */ r) => projectLabel(r[0]) })), rows);
}

/** @param {Store} store @param {string | string[]} keys */
function refreshButton(store, keys) {
  const busy = [keys].flat().some((key) => cache.get(key)?.status === 'loading');
  return h('button', {
    type: 'button',
    class: 'btn-small',
    disabled: busy,
    'aria-busy': busy ? 'true' : null,
    onclick: () => {
      for (const key of [keys].flat()) cache.delete(key);
      store.refresh();
    },
  }, refreshIcon(busy), busy ? 'Refreshing…' : 'Refresh');
}

// --- Web analytics ---

/** @param {Store} store @param {MonitoringView} view @param {PeriodWindow} w */
export function analyticsTab(store, view, w) {
  const settings = store.get('settings');
  const props = settings.analytics?.properties ?? {};
  if (!isConnected('analytics')) {
    return setupBanner('analytics', settings.google?.clientId
      ? 'Connect Google Analytics to see visitors and page views for each project website.'
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

/** @typedef {'google' | 'bing'} SearchEngine */
/** @type {Record<SearchEngine, { name: string, label: string }>} */
const SEARCH_ENGINES = {
  google: { name: 'Google', label: 'Google Search Console' },
  bing: { name: 'Bing', label: 'Bing Webmaster Tools' },
};

const daysIn = (/** @type {DayBuckets} */ b, /** @type {SearchReport} */ d) => b.days.map((day) => d.days[day]).filter(Boolean);

// Reads every site from each engine in `sources`, one cache entry per engine and site, so All, Google and
// Bing share what is loaded. A site counts once one engine answered: `parts` are its reports, `d` those
// merged, `google` the one the indexing card reads. Each failure is named, with its engine when two are read.
/** @param {Store} store @param {Project[]} sites @param {SearchEngine[]} sources @param {DayBuckets} b */
function loadSearch(store, sites, sources, b) {
  const entries = sites.flatMap((p) => sources.map((engine) => {
    const key = `${engine}:${p.id}:${b.from}:${b.to}`;
    const entry = load(store, key, () => (engine === 'google' ? searchReport(p.website, b.from, b.to) : bingReport(store, p.website, b.from, b.to)));
    return { p, engine, key, entry };
  }));
  const on = (/** @type {SearchEngine} */ engine) => (sources.length > 1 ? ` on ${SEARCH_ENGINES[engine].name}` : '');
  return {
    keys: entries.map((e) => e.key),
    loading: entries.some((e) => e.entry.status === 'loading'),
    ok: sites.flatMap((p) => {
      const mine = entries.filter((e) => e.p === p);
      const parts = mine.flatMap((e) => (e.entry.status === 'ok' ? [e.entry.data] : []));
      const g = mine.find((e) => e.engine === 'google')?.entry;
      return parts.length ? [{ p, parts, d: mergeSearchReports(parts), google: g?.status === 'ok' ? g.data : null }] : [];
    }),
    failed: entries.flatMap((e) => (e.entry.status === 'error' ? [`${hostOf(e.p.website)}${on(e.engine)} (${e.entry.error})`] : [])),
    errors: entries.flatMap((e) => (e.entry.status === 'error' ? [e.entry.error] : [])),
  };
}

/** @param {Store} store @param {MonitoringView} view @param {PeriodWindow} w */
export function searchTab(store, view, w) {
  const settings = store.get('settings');
  // "All" comes first and is the default: it adds up the engines that are set up.
  const engine = view.engine === 'google' || view.engine === 'bing' ? view.engine : 'all';
  /** @type {Record<SearchEngine, boolean>} */
  const ready = { google: isConnected('search'), bing: Boolean(settings.bing?.key) };
  const engines = h('div', { class: 'period', role: 'group', 'aria-label': 'Search engine' },
    [['all', 'All'], ['google', SEARCH_ENGINES.google.label], ['bing', SEARCH_ENGINES.bing.label]].map(([key, label]) =>
      h('button', {
        type: 'button',
        class: engine === key ? 'period-btn active' : 'period-btn',
        'aria-pressed': String(engine === key),
        onclick: () => {
          view.engine = key;
          store.refresh();
        },
      }, label)));
  /** @type {SearchEngine[]} */
  const wanted = engine === 'all' ? ['google', 'bing'] : [engine];
  const sources = wanted.filter((e) => ready[e]);
  if (!sources.length) {
    return h('div', { class: 'stack-lg' }, engines,
      setupBanner('search', engine === 'all'
        ? 'Connect Google Search Console or add a Bing Webmaster API key to see clicks, impressions and queries.'
        : engine === 'google'
          ? 'Connect Google Search Console to see clicks, impressions and queries.'
          : 'Add a Bing Webmaster API key to see clicks, impressions and queries from Bing.'));
  }
  // Under "All" with one engine set up, a quiet line says the other is missing.
  const missing = wanted.find((e) => !ready[e]);
  const note = missing
    ? ` ${SEARCH_ENGINES[missing].label} is not connected: only ${SEARCH_ENGINES[sources[0]].name} is counted.`
    : sources.length > 1 ? ' Google and Bing are added together.' : '';
  const sites = searchSitesOf(store);
  if (!sites.length) {
    return h('div', { class: 'stack-lg' }, engines, empty(sitesOf(store).length
      ? 'Every project website is switched off in Settings → Search consoles.'
      : 'No project has a website yet. Add one on a project page.'));
  }
  const p = pickedSite(view, sites);
  const b = dayBuckets(w);
  const all = loadSearch(store, p ? [p] : sites, sources, b);
  if (!p) return searchAll(store, view, sites, engines, b, all, note);
  const head = h('div', { class: 'row between' }, siteChips(store, view, sites, p), refreshButton(store, all.keys));
  if (all.loading) return h('div', { class: 'stack-lg' }, engines, head, progress(`Reading search data for ${hostOf(p.website)}…`));
  // One engine failing leaves the other's numbers standing, with the failure named above them.
  const failed = all.failed.length ? notice({ text: sources.length > 1 ? `Could not read: ${all.failed.join('; ')}` : all.errors[0] }) : null;
  const x = all.ok[0];
  if (!x) return h('div', { class: 'stack-lg' }, engines, head, failed);
  const d = x.d;
  // Totals come from each engine's own days, so Bing's days (no position) leave the average position alone.
  const total = searchTotals(x.parts.flatMap((r) => daysIn(b, r)));
  const cols = ['', 'Clicks', 'Impressions', 'CTR', 'Position'];
  const format = [null, fmt, fmt, pct, (/** @type {number} */ n) => (n ? n.toFixed(1) : '—')];
  const clickSeries = [{ name: 'Clicks', color: 'var(--accent)', values: b.days.map((day) => d.days[day]?.clicks ?? 0) }];
  const impSeries = [{ name: 'Impressions', color: 'var(--info)', values: b.days.map((day) => d.days[day]?.impressions ?? 0) }];
  return h('div', { class: 'stack-lg' }, engines, head, failed,
    h('p', { class: 'muted small' }, `${hostOf(p.website)} · ${d.site}. Search data arrives two to three days late.${note}`),
    h('div', { class: 'summary' },
      stat('Clicks', fmt(total.clicks)),
      stat('Impressions', fmt(total.imps)),
      stat('Click-through rate', total.imps ? pct(total.ctr) : '—'),
      stat('Average position', total.position ? total.position.toFixed(1) : '—')),
    h('div', { class: 'split-2' },
      h('section', { class: 'card stack' }, h('h3', null, 'Clicks'), total.clicks ? barChart(b.labels, clickSeries) : empty('No clicks in this period.'), legend(clickSeries)),
      h('section', { class: 'card stack' }, h('h3', null, 'Impressions'), total.imps ? barChart(b.labels, impSeries) : empty('No impressions in this period.'), legend(impSeries))),
    h('div', { class: 'split-2' },
      h('section', { class: 'card stack' }, h('h3', null, 'Top queries'), table(['Query', ...cols.slice(1)], d.queries, format)),
      h('section', { class: 'card stack' }, h('h3', null, 'Top pages'), table(['Page', ...cols.slice(1)], d.pages, format))),
    // The sitemaps describe the site, not an engine: they show whenever Google's report is among those read.
    x.google ? indexingCard(x.google) : null);
}

// What Google holds for the site's sitemaps: how many pages each lists, and whether Google could read it.
/** @param {SearchReport} d */
function indexingCard(d) {
  const body = d.sitemaps === null || d.sitemaps === undefined
    ? notice({ tone: 'info', text: 'The sitemaps could not be read from Search Console.' })
    : d.sitemaps.length
      ? table(['Sitemap', 'Pages submitted', 'Errors', 'Warnings', 'Last read by Google'], d.sitemaps, [null, fmt, fmt, fmt, (/** @type {string} */ v) => v || '—'])
      : empty('No sitemap is submitted for this property. Submit one in Search Console so new pages are found sooner.');
  return h('section', { class: 'card stack' },
    h('h3', null, 'Indexing'),
    body,
    h('p', { class: 'muted small' }, 'Search Console does not report how many pages are indexed through its API; the Pages report on its website has that. Tools › Crawl files shows what the sitemap on your site lists today.'));
}

// --- All sites ---

/** @param {Store} store @param {MonitoringView} view @param {Project[]} sites @param {Record<string, string>} props @param {DayBuckets} b */
function analyticsAll(store, view, sites, props, b) {
  const all = loadAll(store, sites, (p) => `ga:${p.id}:${b.from}:${b.to}`, (p) => analyticsReport(props[p.id], b.from, b.to));
  const head = h('div', { class: 'row between' }, siteChips(store, view, sites, null), refreshButton(store, all.keys));
  const failed = all.failed.length ? notice({ text: `Could not read: ${all.failed.join('; ')}` }) : null;
  if (all.loading) return h('div', { class: 'stack-lg' }, head, progress(`Reading Google Analytics for ${sites.length} site${sites.length === 1 ? '' : 's'}…`));
  if (!all.ok.length) return h('div', { class: 'stack-lg' }, head, failed);
  const sum = (/** @type {(d: AnalyticsData) => number} */ f) => all.ok.reduce((s, x) => s + f(x.d), 0);
  const sessions = sum((d) => d.totals.sessions);
  // Duration and engagement are per session, so each site counts by its number of sessions.
  const perSession = (/** @type {(d: AnalyticsData) => number} */ f) => (sessions ? sum((d) => f(d) * d.totals.sessions) / sessions : 0);
  const views = sum((d) => d.totals.views);
  const series = [
    { name: 'Users', color: 'var(--accent)', values: b.days.map((day) => sum((d) => d.days[day]?.users ?? 0)) },
    { name: 'Page views', color: 'var(--info)', values: b.days.map((day) => sum((d) => d.days[day]?.views ?? 0)) },
  ];
  const bySite = all.ok.map(({ p, d }) => /** @type {SiteRow} */ ([p, d.totals.users, d.totals.sessions, d.totals.views])).sort((a, c) => c[3] - a[3]);
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
    h('section', { class: 'card stack' }, h('h3', null, 'By site'), siteTable(['Site', 'Users', 'Sessions', 'Page views'], bySite, [fmt, fmt, fmt])),
    h('div', { class: 'split-3' },
      h('section', { class: 'card stack' }, h('h3', null, 'Top pages'), table(['Page', 'Views', 'Users'], pages, [null, fmt, fmt])),
      h('section', { class: 'card stack' }, h('h3', null, 'Where visitors come from'), table(['Source', 'Sessions'], mergeRows(all.ok.map((x) => x.d.sources)), [null, fmt])),
      h('section', { class: 'card stack' }, h('h3', null, 'Countries'), table(['Country', 'Users'], mergeRows(all.ok.map((x) => x.d.countries)), [null, fmt]))));
}

// Clicks, impressions, rate and average position over a set of day rows; the position is weighed by impressions.
/** @param {{ clicks: number, impressions: number, position: number }[]} rows */
function searchTotals(rows) {
  const clicks = rows.reduce((s, r) => s + r.clicks, 0);
  const imps = rows.reduce((s, r) => s + r.impressions, 0);
  const seen = rows.filter((r) => r.position);
  const weight = seen.reduce((s, r) => s + r.impressions, 0);
  return { clicks, imps, ctr: imps ? clicks / imps : 0, position: weight ? seen.reduce((s, r) => s + r.position * r.impressions, 0) / weight : 0 };
}

/**
 * @param {Store} store @param {MonitoringView} view @param {Project[]} sites @param {HTMLElement} engines
 * @param {DayBuckets} b @param {ReturnType<typeof loadSearch>} all @param {string} note
 */
function searchAll(store, view, sites, engines, b, all, note) {
  const head = h('div', { class: 'row between' }, siteChips(store, view, sites, null), refreshButton(store, all.keys));
  const failed = all.failed.length ? notice({ text: `Could not read: ${all.failed.join('; ')}` }) : null;
  if (all.loading) return h('div', { class: 'stack-lg' }, engines, head, progress(`Reading search data for ${sites.length} site${sites.length === 1 ? '' : 's'}…`));
  if (!all.ok.length) return h('div', { class: 'stack-lg' }, engines, head, failed);
  // Every engine's report of every site, unmerged: totals and rows are added up from these.
  const parts = all.ok.flatMap((x) => x.parts);
  const total = searchTotals(parts.flatMap((r) => daysIn(b, r)));
  const daySum = (/** @type {'clicks' | 'impressions'} */ f) => b.days.map((day) => all.ok.reduce((s, x) => s + (x.d.days[day]?.[f] ?? 0), 0));
  const cols = ['', 'Clicks', 'Impressions', 'CTR', 'Position'];
  const format = [null, fmt, fmt, pct, (/** @type {number} */ n) => (n ? n.toFixed(1) : '—')];
  const bySite = all.ok.map((x) => {
    const t = searchTotals(x.parts.flatMap((r) => daysIn(b, r)));
    return /** @type {SiteRow} */ ([x.p, t.clicks, t.imps, t.ctr, t.position]);
  }).sort((a, c) => c[1] - a[1] || c[2] - a[2]);
  const clickSeries = [{ name: 'Clicks', color: 'var(--accent)', values: daySum('clicks') }];
  const impSeries = [{ name: 'Impressions', color: 'var(--info)', values: daySum('impressions') }];
  return h('div', { class: 'stack-lg' }, engines, head, failed,
    h('p', { class: 'muted small' }, `${all.ok.length} site${all.ok.length === 1 ? '' : 's'} added together. Search data arrives two to three days late.${note}`),
    h('div', { class: 'summary' },
      stat('Clicks', fmt(total.clicks)),
      stat('Impressions', fmt(total.imps)),
      stat('Click-through rate', total.imps ? pct(total.ctr) : '—'),
      stat('Average position', total.position ? total.position.toFixed(1) : '—')),
    h('div', { class: 'split-2' },
      h('section', { class: 'card stack' }, h('h3', null, 'Clicks'), total.clicks ? barChart(b.labels, clickSeries) : empty('No clicks in this period.'), legend(clickSeries)),
      h('section', { class: 'card stack' }, h('h3', null, 'Impressions'), total.imps ? barChart(b.labels, impSeries) : empty('No impressions in this period.'), legend(impSeries))),
    h('section', { class: 'card stack' }, h('h3', null, 'By site'), siteTable(['Site', ...cols.slice(1)], bySite, [fmt, fmt, pct, (n) => (n ? n.toFixed(1) : '—')])),
    h('div', { class: 'split-2' },
      h('section', { class: 'card stack' }, h('h3', null, 'Top queries'), table(['Query', ...cols.slice(1)], mergeSearchRows(parts.map((r) => r.queries)), format)),
      h('section', { class: 'card stack' }, h('h3', null, 'Top pages'), table(['Page', ...cols.slice(1)], mergeSearchRows(parts.map((r) => r.pages)), format))));
}
