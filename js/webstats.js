// Visitors and search numbers for a project's website: Google Analytics, Google Search Console and Bing Webmaster Tools.
// Each function returns { labels, series..., tables } for one site over a range of days (YYYY-MM-DD, both included).
import { googleFetch } from './google.js';

const GA = 'https://analyticsdata.googleapis.com/v1beta';
const GSC = 'https://www.googleapis.com/webmasters/v3';
// Bing sends no CORS header, so requests go through tools/bing-relay.js running on this machine.
export const BING_RELAY = 'http://127.0.0.1:8417';
const BING_PATH = '/webmaster/api.svc/json';
const post = (body) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const num = (v) => Number(v ?? 0);

// "properties/123456789" from what was typed: the number alone, or the full name.
export const propertyName = (text) => {
  const id = String(text ?? '').trim().replace(/^properties\//, '');
  return /^\d+$/.test(id) ? `properties/${id}` : '';
};

// --- Google Analytics ---

export async function analyticsReport(property, from, to) {
  const run = (dimensions, metrics, extra = {}) =>
    googleFetch('analytics', 'Google Analytics', `${GA}/${property}:runReport`, post({
      dateRanges: [{ startDate: from, endDate: to }],
      dimensions: dimensions.map((name) => ({ name })),
      metrics: metrics.map((name) => ({ name })),
      ...extra,
    }));
  const top = (metric) => ({ orderBys: [{ metric: { metricName: metric }, desc: true }], limit: 8 });
  const [byDay, totals, pages, sources, countries] = await Promise.all([
    run(['date'], ['activeUsers', 'screenPageViews'], { orderBys: [{ dimension: { dimensionName: 'date' } }] }),
    run([], ['activeUsers', 'sessions', 'screenPageViews', 'averageSessionDuration', 'engagementRate']),
    run(['pagePath'], ['screenPageViews', 'activeUsers'], top('screenPageViews')),
    run(['sessionDefaultChannelGroup'], ['sessions'], top('sessions')),
    run(['country'], ['activeUsers'], top('activeUsers')),
  ]);
  const rows = (report) => (report.rows ?? []).map((r) => [...(r.dimensionValues ?? []).map((d) => d.value), ...(r.metricValues ?? []).map((m) => num(m.value))]);
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
export async function searchSite(website) {
  const { siteEntry = [] } = await googleFetch('search', 'Search Console', `${GSC}/sites`);
  const host = new URL(website).hostname;
  const owned = siteEntry.filter((s) => s.permissionLevel !== 'siteUnverifiedUser').map((s) => s.siteUrl);
  const domain = host.split('.').slice(-2).join('.');
  return owned.find((u) => u === `sc-domain:${host}`)
    ?? owned.find((u) => u === `sc-domain:${domain}`)
    ?? owned.find((u) => u.startsWith('http') && new URL(u).hostname === host)
    ?? null;
}

export async function searchReport(website, from, to) {
  const site = await searchSite(website);
  if (!site) throw new Error('This website is not a verified property in your Search Console account.');
  const query = (dimensions, rowLimit) =>
    googleFetch('search', 'Search Console', `${GSC}/sites/${encodeURIComponent(site)}/searchAnalytics/query`, post({ startDate: from, endDate: to, dimensions, rowLimit }));
  const [byDay, queries, pages] = await Promise.all([query(['date'], 500), query(['query'], 10), query(['page'], 10)]);
  const table = (res) => (res.rows ?? []).map((r) => [r.keys[0], r.clicks, r.impressions, r.ctr, r.position]);
  const days = Object.fromEntries((byDay.rows ?? []).map((r) => [r.keys[0], { clicks: r.clicks, impressions: r.impressions, position: r.position }]));
  return { site, days, queries: table(queries), pages: table(pages) };
}

// --- Bing Webmaster Tools ---

const bingDate = (value) => {
  const ms = Number(String(value).match(/\d+/)?.[0]);
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : '';
};

async function bing(method, key, website, relay) {
  const base = (relay || BING_RELAY).replace(/\/+$/, '');
  let res;
  try {
    res = await fetch(`${base}${BING_PATH}/${method}?siteUrl=${encodeURIComponent(website)}&apikey=${encodeURIComponent(key)}`);
  } catch {
    throw new Error(`Could not reach the Bing relay at ${base}. Start it with: bun tools/bing-relay.js`);
  }
  // Bing answers a bad key with 400 and ErrorCode 3 (InvalidApiKey).
  const body = await res.json().catch(() => null);
  if (res.status === 401 || res.status === 403 || body?.ErrorCode === 3) throw new Error('Bing rejected this key. Generate a new one under API access.');
  if (!res.ok) throw new Error(body?.Message ? `Bing error ${res.status}: ${body.Message}` : `Bing error ${res.status}`);
  return body?.d ?? [];
}

export const checkBing = async (key, relay) => {
  const sites = await bing('GetUserSites', key, '', relay);
  return `Connected. ${sites.length} site${sites.length === 1 ? '' : 's'} found.`;
};

export async function bingReport(key, website, from, to, relay) {
  const [traffic, queries, pages] = await Promise.all([
    bing('GetRankAndTrafficStats', key, website, relay),
    bing('GetQueryStats', key, website, relay),
    bing('GetPageStats', key, website, relay),
  ]);
  const days = {};
  for (const r of traffic) {
    const d = bingDate(r.Date);
    if (d >= from && d <= to) days[d] = { clicks: num(r.Clicks), impressions: num(r.Impressions), position: 0 };
  }
  // Query and page rows are per week; add them up over the period.
  const table = (rows, nameKey) => {
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
      .map(([name, v]) => [name, v.clicks, v.impressions, v.impressions ? v.clicks / v.impressions : 0, v.n ? v.pos / v.n : 0]);
  };
  return { site: website, days, queries: table(queries, 'Query'), pages: table(pages, 'Query') };
}
