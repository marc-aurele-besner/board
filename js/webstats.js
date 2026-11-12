// @ts-check
// Visitors and search numbers for a project's website: Google Analytics, Google Search Console and Bing Webmaster Tools.
// Each function returns { labels, series..., tables } for one site over a range of days (YYYY-MM-DD, both included).
import { googleFetch } from './google.js';
import { runJob, workerCall } from './runners.js';
/** @import { DataStore, Store, BingQueryRow, WebstatsData } from '../types/data' */

// What the code reads of Google's and Bing's answers.
/** @typedef {{ rows?: { dimensionValues?: { value: string }[], metricValues?: { value?: string }[] }[] }} GaReport */
/** @typedef {{ rows?: { keys: string[], clicks: number, impressions: number, ctr: number, position: number }[] }} GscReport */
/** @typedef {{ sitemap?: { path: string, contents?: { submitted?: string }[], errors?: string, warnings?: string, isPending?: boolean, lastDownloaded?: string }[] }} GscSitemaps */
/** @typedef {{ siteEntry?: { siteUrl: string, permissionLevel: string }[] }} GscSites */
/** A day of search numbers. @typedef {{ clicks: number, impressions: number, position: number }} SearchDay */
/** A table row: name, clicks, impressions, click rate, position. @typedef {[string, number, number, number, number]} SearchRow */
/** @typedef {{ site: string, days: Record<string, SearchDay>, queries: SearchRow[], pages: SearchRow[], sitemaps?: (string | number)[][] | null }} SearchReport */

const GA = 'https://analyticsdata.googleapis.com/v1beta';
const GSC = 'https://www.googleapis.com/webmasters/v3';
// Bing sends no CORS header, so a web page cannot read its answers. The runners (tools/jobs/webstats.js) read each
// site's Bing data every 6 hours into webstats.json: { bing: { <website>: { at, traffic, queries, pages, error } } }.
const BING = 'https://ssl.bing.com/webmaster/api.svc/json';
export const WEBSTATS = 'webstats';
/** @type {WebstatsData} */
export const WEBSTATS_DEFAULTS = { bing: {} };
// Query and page rows are weekly and pile up; the newest are kept.
const BING_ROWS = 3000;
const post = (/** @type {unknown} */ body) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const num = (/** @type {unknown} */ v) => Number(v ?? 0);

// "properties/123456789" from what was typed: the number alone, or the full name.
export const propertyName = (/** @type {unknown} */ text) => {
  const id = String(text ?? '').trim().replace(/^properties\//, '');
  return /^\d+$/.test(id) ? `properties/${id}` : '';
};

// --- Google Analytics ---

/** @param {string} property @param {string} from @param {string} to */
export async function analyticsReport(property, from, to) {
  const run = (/** @type {string[]} */ dimensions, /** @type {string[]} */ metrics, /** @type {object} */ extra = {}) =>
    /** @type {Promise<GaReport>} */ (googleFetch('analytics', 'Google Analytics', `${GA}/${property}:runReport`, post({
      dateRanges: [{ startDate: from, endDate: to }],
      dimensions: dimensions.map((name) => ({ name })),
      metrics: metrics.map((name) => ({ name })),
      ...extra,
    })));
  const top = (/** @type {string} */ metric) => ({ orderBys: [{ metric: { metricName: metric }, desc: true }], limit: 8 });
  const [byDay, totals, pages, sources, countries] = await Promise.all([
    run(['date'], ['activeUsers', 'screenPageViews'], { orderBys: [{ dimension: { dimensionName: 'date' } }] }),
    run([], ['activeUsers', 'sessions', 'screenPageViews', 'averageSessionDuration', 'engagementRate']),
    run(['pagePath'], ['screenPageViews', 'activeUsers'], top('screenPageViews')),
    run(['sessionDefaultChannelGroup'], ['sessions'], top('sessions')),
    run(['country'], ['activeUsers'], top('activeUsers')),
  ]);
  // The dimension values (text) then the metric values (numbers) of each row.
  const rows = (/** @type {GaReport} */ report) => (report.rows ?? []).map(/** @returns {any[]} any: dimensions are text and metrics numbers, by position */ (r) => [...(r.dimensionValues ?? []).map((d) => d.value), ...(r.metricValues ?? []).map((m) => num(m.value))]);
  const t = rows(totals)[0] ?? [0, 0, 0, 0, 0];
  return {
    days: Object.fromEntries(rows(byDay).map(([d, users, views]) => [`${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}`, { users, views }])),
    totals: { users: t[0], sessions: t[1], views: t[2], seconds: t[3], engagement: t[4] },
    pages: rows(pages),
    sources: rows(sources),
    countries: rows(countries),
  };
}

// --- Google Search Console ---

// The Search Console property for a website: its domain property, or the address-prefix one.
/** @param {string} website */
export async function searchSite(website) {
  const { siteEntry = [] } = /** @type {GscSites} */ (await googleFetch('search', 'Search Console', `${GSC}/sites`));
  const host = new URL(website).hostname;
  const owned = siteEntry.filter((s) => s.permissionLevel !== 'siteUnverifiedUser').map((s) => s.siteUrl);
  const domain = host.split('.').slice(-2).join('.');
  return owned.find((u) => u === `sc-domain:${host}`)
    ?? owned.find((u) => u === `sc-domain:${domain}`)
    ?? owned.find((u) => u.startsWith('http') && new URL(u).hostname === host)
    ?? null;
}

/** @param {string} website @param {string} from @param {string} to @returns {Promise<SearchReport>} */
export async function searchReport(website, from, to) {
  const site = await searchSite(website);
  if (!site) throw new Error('This website is not a verified property in your Search Console account.');
  const query = (/** @type {string[]} */ dimensions, /** @type {number} */ rowLimit) =>
    /** @type {Promise<GscReport>} */ (googleFetch('search', 'Search Console', `${GSC}/sites/${encodeURIComponent(site)}/searchAnalytics/query`, post({ startDate: from, endDate: to, dimensions, rowLimit })));
  // The sitemaps Google holds for the property. A failure here leaves the rest of the report standing.
  const sitemaps = googleFetch('search', 'Search Console', `${GSC}/sites/${encodeURIComponent(site)}/sitemaps`)
    .then((/** @type {GscSitemaps} */ res) => (res.sitemap ?? []).map((s) => [
      s.path,
      (s.contents ?? []).reduce((sum, c) => sum + num(c.submitted), 0),
      num(s.errors),
      num(s.warnings),
      s.isPending ? 'Waiting to be read' : String(s.lastDownloaded ?? '').slice(0, 10),
    ]))
    .catch(() => null);
  const [byDay, queries, pages, maps] = await Promise.all([query(['date'], 500), query(['query'], 10), query(['page'], 10), sitemaps]);
  const table = (/** @type {GscReport} */ res) => (res.rows ?? []).map((r) => /** @type {SearchRow} */ ([r.keys[0], r.clicks, r.impressions, r.ctr, r.position]));
  const days = Object.fromEntries((byDay.rows ?? []).map((r) => [r.keys[0], { clicks: r.clicks, impressions: r.impressions, position: r.position }]));
  return { site, days, queries: table(queries), pages: table(pages), sitemaps: maps };
}

// --- Bing Webmaster Tools ---

const bingDate = (/** @type {unknown} */ value) => {
  const ms = Number(String(value).match(/\d+/)?.[0]);
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : '';
};

/** @param {string} method @param {string} key @param {string} website @returns {Promise<any[]>} any: each method answers its own rows */
async function bing(method, key, website) {
  let res;
  try {
    res = await fetch(`${BING}/${method}?siteUrl=${encodeURIComponent(website)}&apikey=${encodeURIComponent(key)}`);
  } catch {
    throw new Error('Could not reach Bing. Check the connection.');
  }
  // Bing answers a bad key with 400 and ErrorCode 3 (InvalidApiKey).
  const body = /** @type {{ d?: unknown[], ErrorCode?: number, Message?: string } | null} */ (await res.json().catch(() => null));
  if (res.status === 401 || res.status === 403 || body?.ErrorCode === 3) throw new Error('Bing rejected this key. Generate a new one under API access.');
  if (!res.ok) throw new Error(body?.Message ? `Bing error ${res.status}: ${body.Message}` : `Bing error ${res.status}`);
  return body?.d ?? [];
}

// Runners side of Settings' key check.
export const checkBingKey = async (/** @type {string} */ key) => {
  const sites = await bing('GetUserSites', key, '');
  return `Connected. ${sites.length} site${sites.length === 1 ? '' : 's'} found.`;
};

// Settings → Bing: checks a key through the runners.
export const checkBing = async (/** @type {string} */ key) => /** @type {{ text: string }} */ (await workerCall('POST', '/bing/check', { key }, 30000)).text;

const newest = (/** @type {BingQueryRow[]} */ rows) => [...rows].sort((a, b) => bingDate(b.Date).localeCompare(bingDate(a.Date))).slice(0, BING_ROWS);

// Reads Bing's data for each website into webstats.json. A failed read keeps the last one. Runners only.
/** @param {DataStore} store @param {string} key @param {string[]} websites */
export async function readBing(store, key, websites) {
  /** @type {string[]} */
  const errors = [];
  for (const website of websites) {
    try {
      const [traffic, queries, pages] = await Promise.all([
        bing('GetRankAndTrafficStats', key, website),
        bing('GetQueryStats', key, website),
        bing('GetPageStats', key, website),
      ]);
      store.save(WEBSTATS, (d) => {
        d.bing = { ...d.bing, [website]: { at: Date.now(), traffic, queries: newest(queries), pages: newest(pages), error: null } };
      });
    } catch (err) {
      errors.push(`${website}: ${/** @type {Error} */ (err).message}`);
      store.save(WEBSTATS, (d) => {
        d.bing = { ...d.bing, [website]: { ...d.bing?.[website], error: /** @type {Error} */ (err).message } };
      });
    }
  }
  return errors;
}

// A site's Bing numbers for a range, from webstats.json. A site the file does not hold yet is asked of the runners.
/** @param {Store} store @param {string} website @param {string} from @param {string} to @returns {Promise<SearchReport>} */
export async function bingReport(store, website, from, to) {
  let raw = store.get(WEBSTATS)?.bing?.[website];
  if (!raw?.at) {
    await runJob('webstats', { websites: [website] });
    await store.sync();
    raw = store.get(WEBSTATS)?.bing?.[website];
  }
  if (!raw?.at) throw new Error(raw?.error || 'Bing has no data for this site yet.');
  const { traffic = [], queries = [], pages = [] } = raw;
  /** @type {Record<string, SearchDay>} */
  const days = {};
  for (const r of traffic) {
    const d = bingDate(r.Date);
    if (d >= from && d <= to) days[d] = { clicks: num(r.Clicks), impressions: num(r.Impressions), position: 0 };
  }
  // Query and page rows are per week; add them up over the period.
  const table = (/** @type {BingQueryRow[]} */ rows, /** @type {'Query'} */ nameKey) => {
    /** @type {Map<string, { clicks: number, impressions: number, pos: number, n: number }>} */
    const sum = new Map();
    for (const r of rows) {
      const d = bingDate(r.Date);
      if (d < from || d > to) continue;
      const cur = sum.get(r[nameKey]) ?? { clicks: 0, impressions: 0, pos: 0, n: 0 };
      cur.clicks += num(r.Clicks);
      cur.impressions += num(r.Impressions);
      cur.pos += num(r.AvgImpressionPosition);
      cur.n += 1;
      sum.set(r[nameKey], cur);
    }
    return [...sum.entries()].sort((a, b) => b[1].clicks - a[1].clicks).slice(0, 10)
      .map(([name, v]) => /** @type {SearchRow} */ ([name, v.clicks, v.impressions, v.impressions ? v.clicks / v.impressions : 0, v.n ? v.pos / v.n : 0]));
  };
  return { site: website, days, queries: table(queries, 'Query'), pages: table(pages, 'Query') };
}
