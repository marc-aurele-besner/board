// Checks run against a project's website: is it reachable, when do its certificate and domain expire,
// and which share tags does its home page carry.
//
// A page cannot read another site's certificate or registration, so three public lookups are used. Each one
// receives only the site's address, which is public anyway:
//   - rdap.org: the registries' own lookup protocol, for the domain's expiry and registrar.
//   - api.certspotter.com, then crt.sh: the public certificate transparency logs, for the newest certificate
//     issued for the host. The second is asked only when the first does not answer.
//   - r.jina.ai: the page reader already used for recipes, for the home page's HTML and the crawl files.
//   - cloudflare-dns.com: DNS over HTTPS, for the records that say who may send mail and issue certificates.

const TIMEOUT_MS = 12000;
const SLOW_MS = 1500;
const READER = 'https://r.jina.ai/';

export const hostOf = (website) => {
  try {
    return new URL(website).hostname;
  } catch {
    return '';
  }
};

// The part of a host that is registered: example.com for docs.example.com. Two-part endings such as co.uk are kept whole.
const TWO_PART = /\.(co|com|org|net|gov|ac|edu)\.[a-z]{2}$/;
export function registrable(host) {
  const parts = host.split('.');
  return parts.slice(TWO_PART.test(host) ? -3 : -2).join('.');
}

async function timed(url, options) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: ctl.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Reachability and response time. The answer itself is hidden from the page by the browser ("no-cors"),
// so this tells "answered" from "did not answer", not which status code came back.
export async function checkHealth(website) {
  const start = performance.now();
  try {
    await timed(website, { mode: 'no-cors', cache: 'no-store', redirect: 'follow' });
    const ms = Math.round(performance.now() - start);
    return { status: ms > SLOW_MS ? 'slow' : 'up', ms };
  } catch {
    return { status: 'down', ms: 0 };
  }
}

export async function checkDomain(host) {
  const name = registrable(host);
  const res = await timed(`https://rdap.org/domain/${encodeURIComponent(name)}`);
  if (res.status === 404) throw new Error('The registry does not publish this domain.');
  if (!res.ok) throw new Error(`The domain lookup answered ${res.status}.`);
  const data = await res.json();
  const expiry = (data.events ?? []).find((e) => e.eventAction === 'expiration')?.eventDate;
  if (!expiry) throw new Error('The registry did not give an expiry date.');
  const registrarEntity = (data.entities ?? []).find((e) => (e.roles ?? []).includes('registrar'));
  const registrar = (registrarEntity?.vcardArray?.[1] ?? []).find((v) => v[0] === 'fn')?.[3] ?? '';
  return { name, until: expiry.slice(0, 10), registrar };
}

// The certificate with the latest expiry among those logged for this exact host (or a wildcard covering it).
export async function checkCertificate(host) {
  try {
    return await fromCertSpotter(host);
  } catch {
    return fromCrtSh(host);
  }
}

async function fromCertSpotter(host) {
  const res = await timed(`https://api.certspotter.com/v1/issuances?domain=${encodeURIComponent(host)}&match_wildcards=true&expand=issuer`);
  if (!res.ok) throw new Error(`The certificate log answered ${res.status}.`);
  const newest = (await res.json()).filter((c) => !c.revoked).sort((a, b) => String(b.not_after).localeCompare(String(a.not_after)))[0];
  if (!newest) throw new Error('No valid certificate is logged for this host.');
  return { until: String(newest.not_after).slice(0, 10), issuer: newest.issuer?.friendly_name ?? newest.issuer?.name?.match(/O=([^,]+)/)?.[1] ?? '' };
}

async function fromCrtSh(host) {
  const res = await timed(`https://crt.sh/?q=${encodeURIComponent(host)}&output=json&exclude=expired`);
  if (!res.ok) throw new Error(`The certificate log answered ${res.status}.`);
  const list = await res.json();
  const wildcard = `*.${host.split('.').slice(1).join('.')}`;
  const matching = list.filter((c) => String(c.name_value ?? '').split('\n').some((n) => n === host || n === wildcard));
  const newest = (matching.length ? matching : list).sort((a, b) => String(b.not_after).localeCompare(String(a.not_after)))[0];
  if (!newest) throw new Error('No valid certificate is logged for this host.');
  const issuer = String(newest.issuer_name ?? '').match(/O=([^,]+)/)?.[1]?.replace(/"/g, '') ?? '';
  return { until: String(newest.not_after).slice(0, 10), issuer };
}

// The share tags of a page: what a link to it shows on social networks and in chat apps.
export async function readMeta(website) {
  const res = await timed(`${READER}${website}`, { headers: { 'X-Return-Format': 'html' } });
  if (!res.ok) throw new Error(`The page could not be read (${res.status}). Some sites do not allow it.`);
  const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
  const meta = (selector) => doc.querySelector(selector)?.getAttribute('content')?.trim() ?? '';
  const abs = (url) => {
    try {
      return url ? new URL(url, website).href : '';
    } catch {
      return '';
    }
  };
  return {
    title: doc.querySelector('title')?.textContent?.trim() ?? '',
    description: meta('meta[name="description"]'),
    ogTitle: meta('meta[property="og:title"]'),
    ogDescription: meta('meta[property="og:description"]'),
    ogImage: abs(meta('meta[property="og:image"]')),
    ogUrl: meta('meta[property="og:url"]'),
    twitterCard: meta('meta[name="twitter:card"]'),
    twitterImage: abs(meta('meta[name="twitter:image"]') || meta('meta[name="twitter:image:src"]')),
  };
}

// --- DNS and email ---

const DOH = 'https://cloudflare-dns.com/dns-query';
const DNS_TYPES = { A: 1, NS: 2, MX: 15, TXT: 16, AAAA: 28, CAA: 257 };
// DKIM keys live under a selector the sender picks, which DNS cannot list, so the common ones are tried.
const DKIM_SELECTORS = ['google', 'default', 'selector1', 'selector2', 'k1', 's1', 'mail'];

// A TXT answer can be split into several quoted strings; joined, they are the record.
const txtOf = (data) => (data.match(/"(?:[^"\\]|\\.)*"/g) ?? [data]).map((x) => x.replace(/^"|"$/g, '')).join('');

async function resolve(name, type) {
  const res = await timed(`${DOH}?name=${encodeURIComponent(name)}&type=${type}`, { headers: { accept: 'application/dns-json' } });
  if (!res.ok) throw new Error(`The DNS lookup answered ${res.status}.`);
  const data = await res.json();
  // Status 3 is "no such name": an answer, not a failure.
  if (data.Status !== 0 && data.Status !== 3) throw new Error(`The DNS lookup failed for ${name}.`);
  return (data.Answer ?? []).filter((a) => a.type === DNS_TYPES[type]).map((a) => (type === 'TXT' ? txtOf(a.data) : a.data));
}

export async function checkDns(host) {
  const domain = registrable(host);
  const [a, aaaa, caa, mx, ns, txt, dmarcTxt, ...dkim] = await Promise.all([
    resolve(host, 'A'), resolve(host, 'AAAA'), resolve(domain, 'CAA'), resolve(domain, 'MX'), resolve(domain, 'NS'), resolve(domain, 'TXT'),
    resolve(`_dmarc.${domain}`, 'TXT'),
    ...DKIM_SELECTORS.map((sel) => resolve(`${sel}._domainkey.${domain}`, 'TXT').catch(() => [])),
  ]);
  const spf = txt.find((t) => /^v=spf1\b/i.test(t)) ?? '';
  const dmarc = dmarcTxt.find((t) => /^v=DMARC1\b/i.test(t)) ?? '';
  return {
    domain,
    a,
    aaaa,
    caa,
    ns: ns.map((n) => n.replace(/\.$/, '')),
    // "10 mx.example.com." becomes "mx.example.com", lowest preference first. A null MX ("0 .") says the domain takes no mail.
    mx: mx.map((m) => m.split(' ')).sort((x, y) => Number(x[0]) - Number(y[0])).map((m) => (m[1] ?? m[0]).replace(/\.$/, '')).filter(Boolean),
    spf: { record: spf, all: spf.match(/[~?+-]?all\b/i)?.[0] ?? '' },
    dmarc: { record: dmarc, policy: dmarc.match(/\bp=(\w+)/i)?.[1]?.toLowerCase() ?? '' },
    // An empty key ("p=") is a revoked selector, often a wildcard answering for every name.
    dkim: DKIM_SELECTORS.filter((_, i) => dkim[i].some((t) => /\bp=[A-Za-z0-9+/]/.test(t))),
  };
}

// --- Crawl files ---

const RAW_KEEP = 4000; // characters of each file kept, enough to read it without bloating tools.json
// Crawlers that train or answer with AI, reported when robots.txt names them in a group that blocks the site.
const AI_BOTS = ['GPTBot', 'ClaudeBot', 'Google-Extended', 'PerplexityBot', 'CCBot'];

// A file read through the page reader. Its JSON answer carries the site's own status, which the plain answer hides.
async function readFile(url) {
  const res = await timed(`${READER}${url}`, { headers: { accept: 'application/json', 'X-Return-Format': 'text' } });
  if (!res.ok) throw new Error(`The page reader answered ${res.status}.`);
  const { data = {} } = await res.json();
  return { status: data.httpStatus ?? 200, text: String(data.text ?? '').trim() };
}

// Many sites answer every address with their home page, so a file counts as found only if it looks like one.
async function readKind(url, looksRight) {
  const { status, text } = await readFile(url);
  if (status >= 400) return { url, found: false, status };
  if (!looksRight(text)) return { url, found: false, status, note: 'The site answered with a page, not this file.' };
  return { url, found: true, status, text, raw: text.slice(0, RAW_KEEP) };
}

// Groups of user agents and their rules. An agent follows its own group, or the "*" group if it has none.
function parseRobots(text) {
  const groups = [];
  const sitemaps = [];
  let group = null;
  let agentLine = false;
  for (const line of text.split('\n')) {
    const m = line.replace(/#.*/, '').match(/^\s*([A-Za-z-]+)\s*:\s*(.*?)\s*$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2];
    if (key === 'user-agent') {
      if (!agentLine) groups.push((group = { agents: [], allow: [], disallow: [] }));
      group.agents.push(value.toLowerCase());
      agentLine = true;
    } else {
      agentLine = false;
      if (key === 'sitemap' && value) sitemaps.push(value);
      else if (group && (key === 'allow' || key === 'disallow') && value) group[key].push(value);
    }
  }
  const groupOf = (agent) => groups.find((g) => g.agents.includes(agent.toLowerCase())) ?? groups.find((g) => g.agents.includes('*'));
  const blocks = (g) => Boolean(g && g.disallow.includes('/') && !g.allow.includes('/'));
  return {
    sitemaps,
    blocksSearch: blocks(groupOf('googlebot')) || blocks(groupOf('bingbot')),
    blocksAll: blocks(groupOf('*')),
    aiBlocked: AI_BOTS.filter((bot) => blocks(groups.find((g) => g.agents.includes(bot.toLowerCase())))),
  };
}

export async function readCrawlFiles(website) {
  const origin = new URL(website).origin;
  const [robots, llms, security] = await Promise.all([
    readKind(`${origin}/robots.txt`, (t) => /^\s*(user-agent|sitemap|disallow|allow)\s*:/im.test(t)),
    readKind(`${origin}/llms.txt`, (t) => /^#\s+\S/.test(t)),
    readKind(`${origin}/.well-known/security.txt`, (t) => /^\s*contact\s*:/im.test(t)),
  ]);
  const rules = robots.found ? parseRobots(robots.raw) : { sitemaps: [], blocksSearch: false, blocksAll: false, aiBlocked: [] };
  const sitemap = await readKind(rules.sitemaps[0] ?? `${origin}/sitemap.xml`, (t) => /<(urlset|sitemapindex)\b/.test(t));
  if (sitemap.found) {
    // Counted on the whole file, not on the part kept.
    const lastmods = [...sitemap.text.matchAll(/<lastmod>\s*([^<\s]+)/g)].map((m) => m[1]).sort();
    Object.assign(sitemap, { urls: (sitemap.text.match(/<url\b/g) ?? []).length, indexes: (sitemap.text.match(/<sitemap\b/g) ?? []).length, lastmod: lastmods.at(-1)?.slice(0, 10) ?? '' });
  }
  for (const file of [robots, sitemap, llms, security]) delete file.text;
  if (llms.found) llms.title = llms.raw.match(/^#\s+(.+)/)?.[1]?.trim() ?? '';
  if (security.found) {
    security.contact = [...security.raw.matchAll(/^\s*contact\s*:\s*(\S+)/gim)].map((m) => m[1]);
    security.expires = security.raw.match(/^\s*expires\s*:\s*(\S+)/im)?.[1]?.slice(0, 10) ?? '';
  }
  return { robots: { ...robots, ...rules }, sitemap, llms, security };
}

export const daysUntil = (isoDate) => Math.round((Date.parse(`${isoDate}T00:00:00`) - new Date().setHours(0, 0, 0, 0)) / 86400000);
