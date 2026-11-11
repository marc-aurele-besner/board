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
// Provider status is read from each provider's own public status page; nothing about the user is sent.

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
const DNS_TYPES = { A: 1, NS: 2, CNAME: 5, SOA: 6, MX: 15, TXT: 16, AAAA: 28, SRV: 33, HTTPS: 65, CAA: 257 };
const TYPE_NAME = Object.fromEntries(Object.entries(DNS_TYPES).map(([k, v]) => [v, k]));
// DKIM keys live under a selector the sender picks, which DNS cannot list, so the common ones are tried.
const DKIM_SELECTORS = ['google', 'default', 'selector1', 'selector2', 'k1', 'k2', 's1', 's2', 'mail', 'dkim', 'resend', 'mandrill', 'zoho', 'protonmail', 'fm1'];
// Mail policy names other than DKIM: MTA-STS, TLS reporting and BIMI.
const MAIL_NAMES = ['_mta-sts', '_smtp._tls', 'default._bimi'];

// A TXT answer can be split into several quoted strings; joined, they are the record.
const txtOf = (data) => (data.match(/"(?:[^"\\]|\\.)*"/g) ?? [data]).map((x) => x.replace(/^"|"$/g, '')).join('');

// Every answer to one question, including the CNAME steps that led to it.
async function query(name, type) {
  const res = await timed(`${DOH}?name=${encodeURIComponent(name)}&type=${type}`, { headers: { accept: 'application/dns-json' } });
  if (!res.ok) throw new Error(`The DNS lookup answered ${res.status}.`);
  const data = await res.json();
  // Status 3 is "no such name": an answer, not a failure.
  if (data.Status !== 0 && data.Status !== 3) throw new Error(`The DNS lookup failed for ${name}.`);
  return (data.Answer ?? []).map((a) => ({
    name: a.name.replace(/\.$/, ''),
    type: TYPE_NAME[a.type] ?? `TYPE${a.type}`,
    ttl: a.TTL,
    data: a.type === DNS_TYPES.TXT ? txtOf(a.data) : a.data,
  }));
}

// DNS has no "list everything" question, so the usual types are asked for the domain, the site's host,
// www, and the names mail services use. `records` keeps every answer once.
export async function checkDns(host) {
  const domain = registrable(host);
  const www = `www.${domain}`;
  const core = ['A', 'AAAA', 'NS', 'MX', 'TXT', 'SOA', 'CAA', 'HTTPS'].map((t) => [domain, t]);
  const extra = [
    ...(host !== domain ? ['A', 'AAAA', 'CNAME', 'TXT', 'HTTPS'].map((t) => [host, t]) : []),
    ...(host !== www ? ['A', 'AAAA', 'CNAME'].map((t) => [www, t]) : []),
    [`_dmarc.${domain}`, 'TXT'],
    ...MAIL_NAMES.map((n) => [`${n}.${domain}`, 'TXT']),
    ...DKIM_SELECTORS.map((sel) => [`${sel}._domainkey.${domain}`, 'TXT']),
  ];
  // The domain's own answers must come back; the other names may fail on their own.
  const answers = await Promise.all([...core.map(([n, t]) => query(n, t)), ...extra.map(([n, t]) => query(n, t).catch(() => []))]);
  const seen = new Map();
  for (const a of answers.flat()) seen.set(`${a.name}|${a.type}|${a.data}`, a);
  const all = [...seen.values()];
  // A name's records may sit at the end of its CNAME chain (a host on a platform, a DKIM key kept by the mail service).
  const endOf = (name) => {
    let end = name;
    for (let i = 0; i < 8; i += 1) {
      const next = all.find((r) => r.name === end && r.type === 'CNAME');
      if (!next) break;
      end = next.data.replace(/\.$/, '');
    }
    return end;
  };
  const of = (name, type) => {
    const end = type === 'CNAME' ? name : endOf(name);
    return all.filter((r) => r.name === end && r.type === type).map((r) => r.data);
  };
  const order = Object.keys(DNS_TYPES);
  const rank = (name) => (name === domain ? 0 : name === host ? 1 : name === www ? 2 : name.endsWith(`.${domain}`) ? 3 : 4);
  const records = all.sort((x, y) => rank(x.name) - rank(y.name) || x.name.localeCompare(y.name) || order.indexOf(x.type) - order.indexOf(y.type)
    // MX and SRV start with a priority number: lowest first.
    || (/^(MX|SRV)$/.test(x.type) ? parseInt(x.data, 10) - parseInt(y.data, 10) : 0));
  const spf = of(domain, 'TXT').find((t) => /^v=spf1\b/i.test(t)) ?? '';
  const dmarc = of(`_dmarc.${domain}`, 'TXT').find((t) => /^v=DMARC1\b/i.test(t)) ?? '';
  const mx = of(domain, 'MX');
  const caa = of(domain, 'CAA');
  const ns = of(domain, 'NS');
  return {
    domain,
    a: of(host, 'A'),
    aaaa: of(host, 'AAAA'),
    caa,
    records,
    ns: ns.map((n) => n.replace(/\.$/, '')),
    // "10 mx.example.com." becomes "mx.example.com", lowest preference first. A null MX ("0 .") says the domain takes no mail.
    mx: mx.map((m) => m.split(' ')).sort((x, y) => Number(x[0]) - Number(y[0])).map((m) => (m[1] ?? m[0]).replace(/\.$/, '')).filter(Boolean),
    spf: { record: spf, all: spf.match(/[~?+-]?all\b/i)?.[0] ?? '' },
    dmarc: { record: dmarc, policy: dmarc.match(/\bp=(\w+)/i)?.[1]?.toLowerCase() ?? '' },
    // An empty key ("p=") is a revoked selector, often a wildcard answering for every name.
    dkim: DKIM_SELECTORS.filter((sel) => of(`${sel}._domainkey.${domain}`, 'TXT').some((t) => /\bp=[A-Za-z0-9+/]/.test(t))),
  };
}

// --- Crawl files ---

const RAW_KEEP = 5000; // characters of each file kept, enough to preview it without bloating tools.json
// Crawlers that train or answer with AI, reported when robots.txt names them in a group that blocks the site.
const AI_BOTS = ['GPTBot', 'ClaudeBot', 'Google-Extended', 'PerplexityBot', 'CCBot'];
const READS_AT_ONCE = 3;

// The reader allows a few requests at a time without a key; the rest wait their turn.
let reading = 0;
const queue = [];
async function inTurn(work) {
  if (reading >= READS_AT_ONCE) await new Promise((resolve) => queue.push(resolve));
  reading += 1;
  try {
    return await work();
  } finally {
    reading -= 1;
    queue.shift()?.();
  }
}

// A file read through the page reader. Its JSON answer carries the site's own status, which the plain answer hides.
// A busy reader (429) is asked again after a pause.
async function readFile(url) {
  for (let attempt = 0; ; attempt += 1) {
    const res = await inTurn(() => timed(`${READER}${url}`, { headers: { accept: 'application/json', 'X-Return-Format': 'text' } }));
    if (res.status === 429 && attempt < 2) {
      await new Promise((resolve) => setTimeout(resolve, 4000 * (attempt + 1)));
      continue;
    }
    if (res.status === 429) throw new Error('The page reader is busy. Try again in a minute.');
    if (!res.ok) throw new Error(`The page reader answered ${res.status}.`);
    const { data = {} } = await res.json();
    return { status: data.httpStatus ?? 200, text: String(data.text ?? '').trim() };
  }
}

// Many sites answer every address with their home page, so a file counts as found only if it looks like one.
// A file the reader could not fetch is marked unread rather than missing.
async function readKind(url, looksRight) {
  let answer;
  try {
    answer = await readFile(url);
  } catch (err) {
    return { url, found: false, unread: err.name === 'AbortError' ? 'The reader took too long.' : err.message };
  }
  const { status, text } = answer;
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

// --- Format checks ---
// Each check is [level, text], level being "ok", "warn" or "error". They run on the whole file, not on the part kept.

const isHtml = (t) => /^\s*(<!doctype html|<html)\b/i.test(t);
const looksJson = (t) => /^\s*[[{]/.test(t);
const parseJson = (t) => {
  try {
    return [JSON.parse(t), ''];
  } catch (err) {
    return [null, err.message];
  }
};
const DAY = 86400000;

function lintRobots(text, website) {
  const out = [];
  const KNOWN = ['user-agent', 'allow', 'disallow', 'sitemap', 'crawl-delay', 'host', 'clean-param', 'request-rate', 'visit-time', 'noindex'];
  let agent = false;
  const unknown = new Set();
  let orphan = 0;
  for (const line of text.split('\n')) {
    const bare = line.replace(/#.*/, '').trim();
    if (!bare) continue;
    const m = bare.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) {
      unknown.add(bare.slice(0, 30));
      continue;
    }
    const key = m[1].toLowerCase();
    if (!KNOWN.includes(key)) unknown.add(m[1]);
    if (key === 'user-agent') agent = true;
    else if ((key === 'allow' || key === 'disallow') && !agent) orphan += 1;
    if (key === 'sitemap' && m[2] && !/^https?:\/\//i.test(m[2])) out.push(['warn', `Sitemap “${m[2]}” is not a full address; crawlers need one with https://.`]);
    if (key === 'crawl-delay') out.push(['warn', 'Crawl-delay is ignored by Google.']);
    if (key === 'noindex') out.push(['warn', 'Noindex in robots.txt is ignored by Google; use a meta tag instead.']);
  }
  if (!agent) out.push(['error', 'No User-agent line, so the rules apply to no crawler.']);
  if (orphan) out.push(['error', `${orphan} rule${orphan === 1 ? '' : 's'} come before any User-agent line and are ignored.`]);
  if (unknown.size) out.push(['warn', `Lines crawlers do not understand: ${[...unknown].slice(0, 5).join(', ')}${unknown.size > 5 ? '…' : ''}`]);
  if (text.length > 500 * 1024) out.push(['error', 'Larger than 500 KB; Google reads only the first 500 KB.']);
  const rules = parseRobots(text);
  if (rules.blocksSearch) out.push(['error', 'Blocks Google or Bing from the whole site.']);
  if (!rules.sitemaps.length) out.push(['warn', 'Names no sitemap.']);
  else if (rules.sitemaps.some((s) => hostOf(s) && hostOf(s) !== hostOf(website))) out.push(['warn', 'Points to a sitemap on another host.']);
  if (!out.some(([l]) => l === 'error')) out.unshift(['ok', 'Every rule sits under a User-agent line.']);
  return out;
}

function lintSitemap(text, website) {
  const out = [];
  if (typeof DOMParser !== 'undefined') {
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    const err = doc.querySelector('parsererror');
    if (err) out.push(['error', `Not valid XML: ${err.textContent.split('\n')[0].slice(0, 120)}`]);
    else out.push(['ok', 'Valid XML.']);
  }
  if (!/xmlns\s*=\s*["']http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9["']/.test(text)) out.push(['warn', 'The sitemaps.org namespace is missing from the root element.']);
  const locs = [...text.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1]);
  const entries = (text.match(/<(url|sitemap)\b/g) ?? []).length;
  if (entries && locs.length < entries) out.push(['error', `${entries - locs.length} entr${entries - locs.length === 1 ? 'y has' : 'ies have'} no <loc>.`]);
  const relative = locs.filter((l) => !/^https?:\/\//i.test(l)).length;
  if (relative) out.push(['error', `${relative} address${relative === 1 ? ' is' : 'es are'} not absolute.`]);
  const host = hostOf(website).replace(/^www\./, '');
  const other = locs.filter((l) => /^https?:/i.test(l) && hostOf(l).replace(/^www\./, '') !== host).length;
  if (other) out.push(['warn', `${other} address${other === 1 ? ' points' : 'es point'} to another host.`]);
  const insecure = locs.filter((l) => /^http:\/\//i.test(l)).length;
  if (insecure && /^https:/i.test(website)) out.push(['warn', `${insecure} address${insecure === 1 ? ' uses' : 'es use'} http instead of https.`]);
  if (locs.length > 50000) out.push(['error', 'More than 50,000 addresses; split it into several sitemaps.']);
  const dates = [...text.matchAll(/<lastmod>\s*([^<\s]+)/g)].map((m) => m[1]);
  const bad = dates.filter((d) => Number.isNaN(Date.parse(d))).length;
  if (bad) out.push(['warn', `${bad} change date${bad === 1 ? ' is' : 's are'} not a valid date.`]);
  if (dates.some((d) => Date.parse(d) > Date.now() + DAY)) out.push(['warn', 'Some change dates are in the future.']);
  if (!dates.length && entries) out.push(['warn', 'No change dates (<lastmod>), so crawlers cannot tell what is new.']);
  return out;
}

function lintLlms(text, full) {
  const out = [];
  const first = text.split('\n').find((l) => l.trim());
  out.push(/^#\s+\S/.test(first ?? '') ? ['ok', 'Starts with a title (# Name).'] : ['error', 'Does not start with a # title.']);
  if (!full) {
    if (!/^>\s+\S/m.test(text)) out.push(['warn', 'No summary line (> …) under the title.']);
    const sections = (text.match(/^##\s+\S/gm) ?? []).length;
    const links = (text.match(/\[[^\]]+\]\([^)]+\)/g) ?? []).length;
    out.push(sections ? ['ok', `${sections} section${sections === 1 ? '' : 's'}, ${links} link${links === 1 ? '' : 's'}.`] : ['warn', 'No ## sections listing pages.']);
    if (!links) out.push(['warn', 'Links to no pages.']);
  }
  if (isHtml(text)) out.push(['error', 'Looks like HTML; it should be Markdown.']);
  return out;
}

function lintSecurity(text) {
  const out = [];
  const contacts = [...text.matchAll(/^\s*contact\s*:\s*(\S+)/gim)].map((m) => m[1]);
  if (!contacts.length) out.push(['error', 'No Contact line; it is required.']);
  else if (contacts.some((c) => !/^(mailto:|https:\/\/|tel:)/i.test(c))) out.push(['warn', 'A Contact should start with mailto:, https:// or tel:.']);
  else out.push(['ok', `Contact: ${contacts.join(', ')}`]);
  const expires = text.match(/^\s*expires\s*:\s*(\S+)/im)?.[1];
  if (!expires) out.push(['error', 'No Expires line; it is required.']);
  else if (Number.isNaN(Date.parse(expires))) out.push(['error', `Expires “${expires}” is not a valid date.`]);
  else if (Date.parse(expires) < Date.now()) out.push(['error', `Expired on ${expires.slice(0, 10)}.`]);
  else if (Date.parse(expires) > Date.now() + 366 * DAY) out.push(['warn', 'Expires more than a year ahead; the standard advises less.']);
  else out.push(['ok', `Valid until ${expires.slice(0, 10)}.`]);
  if (!/^\s*canonical\s*:/im.test(text)) out.push(['warn', 'No Canonical line saying where the file lives.']);
  if (!/^-----BEGIN PGP SIGNED MESSAGE-----/m.test(text)) out.push(['ok', 'Not signed (optional).']);
  return out;
}

function lintAds(text) {
  const lines = text.split('\n').map((l) => l.replace(/#.*/, '').trim()).filter(Boolean);
  const vars = lines.filter((l) => /^[a-z]+=/i.test(l));
  const records = lines.filter((l) => !/^[a-z]+=/i.test(l));
  const bad = records.filter((l) => {
    const f = l.split(',').map((x) => x.trim());
    return f.length < 3 || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(f[0]) || !f[1] || !/^(direct|reseller)$/i.test(f[2]);
  });
  const out = [[records.length ? 'ok' : 'warn', `${records.length} seller record${records.length === 1 ? '' : 's'}${vars.length ? `, ${vars.length} variable${vars.length === 1 ? '' : 's'}` : ''}.`]];
  if (bad.length) out.push(['error', `${bad.length} line${bad.length === 1 ? ' does' : 's do'} not follow “domain, account, DIRECT|RESELLER”: ${bad[0].slice(0, 60)}`]);
  return out;
}

function lintManifest(text) {
  const [m, err] = parseJson(text);
  if (!m) return [['error', `Not valid JSON: ${err}`]];
  const out = [['ok', 'Valid JSON.']];
  if (!m.name && !m.short_name) out.push(['error', 'No name or short_name.']);
  const sizes = (m.icons ?? []).flatMap((i) => String(i.sizes ?? '').split(/\s+/));
  for (const s of ['192x192', '512x512']) if (!sizes.includes(s)) out.push(['warn', `No ${s} icon, needed to install the site.`]);
  if (!(m.icons ?? []).some((i) => /maskable/.test(i.purpose ?? ''))) out.push(['warn', 'No maskable icon for Android.']);
  if (!m.start_url) out.push(['warn', 'No start_url.']);
  if (!m.display) out.push(['warn', 'No display mode (standalone, browser…).']);
  if (!m.theme_color) out.push(['warn', 'No theme_color.']);
  return out;
}

function lintAasa(text) {
  const [m, err] = parseJson(text);
  if (!m) return [['error', `Not valid JSON: ${err}`]];
  const parts = ['applinks', 'webcredentials', 'appclips'].filter((k) => m[k]);
  return [['ok', 'Valid JSON.'], parts.length ? ['ok', `Declares ${parts.join(', ')}.`] : ['error', 'Declares no applinks, webcredentials or appclips.']];
}

function lintAssetLinks(text) {
  const [m, err] = parseJson(text);
  if (!m) return [['error', `Not valid JSON: ${err}`]];
  if (!Array.isArray(m)) return [['error', 'Should be a list ([…]) of statements.']];
  const bad = m.filter((s) => !Array.isArray(s.relation) || !s.target?.namespace || (s.target.namespace === 'android_app' && (!s.target.package_name || !s.target.sha256_cert_fingerprints?.length)));
  return [['ok', `Valid JSON, ${m.length} statement${m.length === 1 ? '' : 's'}.`], ...(bad.length ? [['error', `${bad.length} statement${bad.length === 1 ? ' lacks' : 's lack'} a relation, target or app fingerprint.`]] : [])];
}

// [key, path, does the answer look like this file, its format checks]. The sitemap's address comes from robots.txt.
const CRAWL = [
  ['robots', '/robots.txt', (t) => /^\s*(user-agent|sitemap|disallow|allow)\s*:/im.test(t), lintRobots],
  ['sitemap', '/sitemap.xml', (t) => /<(urlset|sitemapindex)\b/.test(t), lintSitemap],
  ['llms', '/llms.txt', (t) => /^\s*#\s+\S/.test(t) && !isHtml(t), (t) => lintLlms(t, false)],
  ['llmsFull', '/llms-full.txt', (t) => /^\s*#\s+\S/.test(t) && !isHtml(t), (t) => lintLlms(t, true)],
  ['security', '/.well-known/security.txt', (t) => /^\s*(contact|expires)\s*:/im.test(t), lintSecurity],
  ['humans', '/humans.txt', (t) => t.length > 0 && !isHtml(t), (t) => [['ok', `${t.split('\n').filter((l) => l.trim()).length} lines.`]]],
  ['ads', '/ads.txt', (t) => /^[^#\n]*,\s*[^,\n]+,\s*(direct|reseller)/im.test(t) || /^\s*(contact|subdomain|ownerdomain|managerdomain)\s*=/im.test(t), lintAds],
  ['manifest', '/manifest.json', (t) => looksJson(t) && !isHtml(t), lintManifest],
  ['aasa', '/.well-known/apple-app-site-association', looksJson, lintAasa],
  ['assetlinks', '/.well-known/assetlinks.json', looksJson, lintAssetLinks],
];
export const CRAWL_KEYS = CRAWL.map(([k]) => k);

export async function readCrawlFiles(website) {
  const origin = new URL(website).origin;
  const check = async ([key, path, looksRight, lint], url = `${origin}${path}`) => {
    const f = await readKind(url, looksRight);
    if (f.found) {
      f.checks = lint(f.text, website);
      f.size = f.text.length;
    }
    return f;
  };
  const byKey = Object.fromEntries(CRAWL.map((c) => [c[0], c]));
  const robots = await check(byKey.robots);
  const rules = robots.found ? parseRobots(robots.text) : { sitemaps: [], blocksSearch: false, blocksAll: false, aiBlocked: [] };
  const rest = await Promise.all(CRAWL.filter(([k]) => k !== 'robots').map((c) =>
    c[0] === 'sitemap' ? check(c, rules.sitemaps[0] ?? `${origin}/sitemap.xml`) : c[0] === 'manifest'
      // Sites name the manifest either way; the second name is read only when the first is missing.
      ? check(c).then((f) => (f.found || f.unread ? f : check(c, `${origin}/site.webmanifest`).then((g) => (g.found ? g : f))))
      : check(c)));
  const files = { robots: { ...robots, ...rules }, ...Object.fromEntries(rest.map((f, i) => [CRAWL.filter(([k]) => k !== 'robots')[i][0], f])) };
  // Nothing read at all is a failed lookup, so the last good answer is kept.
  if (Object.values(files).every((f) => f.unread)) throw new Error(robots.unread);
  const { sitemap, llms, security } = files;
  if (sitemap.found) {
    const lastmods = [...sitemap.text.matchAll(/<lastmod>\s*([^<\s]+)/g)].map((m) => m[1]).sort();
    Object.assign(sitemap, { urls: (sitemap.text.match(/<url\b/g) ?? []).length, indexes: (sitemap.text.match(/<sitemap\b/g) ?? []).length, lastmod: lastmods.at(-1)?.slice(0, 10) ?? '' });
  }
  if (llms.found) llms.title = llms.raw.match(/^\s*#\s+(.+)/)?.[1]?.trim() ?? '';
  if (security.found) {
    security.contact = [...security.raw.matchAll(/^\s*contact\s*:\s*(\S+)/gim)].map((m) => m[1]);
    security.expires = security.raw.match(/^\s*expires\s*:\s*(\S+)/im)?.[1]?.slice(0, 10) ?? '';
  }
  for (const f of Object.values(files)) delete f.text;
  return files;
}

// --- Provider status ---

const STATUS_KEEP = 12; // degraded components kept; large providers list hundreds

// "githubstatus.com" or "https://www.githubstatus.com/history" both become the page's origin.
export function statusPageOf(input) {
  try {
    const url = new URL(/^https?:\/\//i.test(input.trim()) ? input.trim() : `https://${input.trim()}`);
    return url.hostname.includes('.') ? url.origin : '';
  } catch {
    return '';
  }
}

const RECENT_DAYS = 30; // how far back resolved incidents are counted
const UPDATE_KEEP = 280; // characters of an incident's latest update kept
const clip = (text) => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, UPDATE_KEEP);
const recentOf = (list) => list.filter((i) => i.at && Date.now() - Date.parse(i.at) < RECENT_DAYS * 86400000).sort((a, b) => b.at.localeCompare(a.at));

// Every status reader returns the same shape:
//   indicator: none | minor | major | critical | maintenance; description: the page's own one-line state;
//   parts: { total, ok }; components: the parts that are not operational;
//   incidents: open ones, with their latest update; maintenances: in progress or coming;
//   recent: incidents resolved in the last 30 days, newest first (a few kept), and recentCount.

// Statuspage: the public summary, and the incident history when the page shares it.
async function fromStatuspage(page) {
  const res = await timed(`${page}/api/v2/summary.json`);
  if (res.status === 404) throw new Error('This page does not publish a Statuspage summary.');
  if (!res.ok) throw new Error(`The status page answered ${res.status}.`);
  const data = await res.json().catch(() => null);
  if (!data?.status?.indicator) throw new Error('This page does not publish a Statuspage summary. Try its full address, often with www.');
  const history = await timed(`${page}/api/v2/incidents.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const parts = (data.components ?? []).filter((c) => !c.group);
  const resolved = recentOf((history?.incidents ?? []).filter((i) => ['resolved', 'postmortem'].includes(i.status))
    .map((i) => ({ name: i.name, impact: i.impact, at: i.resolved_at ?? i.updated_at, url: i.shortlink ?? `${page}/incidents/${i.id}` })));
  return {
    indicator: data.status.indicator,
    description: data.status.description ?? '',
    parts: { total: parts.length, ok: parts.filter((c) => c.status === 'operational').length },
    components: parts.filter((c) => c.status !== 'operational').slice(0, STATUS_KEEP).map((c) => ({ name: c.name, status: c.status })),
    incidents: (data.incidents ?? []).filter((i) => !['resolved', 'postmortem'].includes(i.status)).map((i) => ({
      name: i.name,
      impact: i.impact,
      status: i.status,
      url: i.shortlink ?? `${page}/incidents/${i.id}`,
      started: i.started_at ?? i.created_at,
      updated: i.incident_updates?.[0]?.updated_at ?? i.updated_at,
      update: clip(i.incident_updates?.[0]?.body),
    })),
    maintenances: (data.scheduled_maintenances ?? []).filter((m) => ['scheduled', 'in_progress', 'verifying'].includes(m.status)).map((m) => ({
      name: m.name, status: m.status, start: m.scheduled_for, end: m.scheduled_until, url: m.shortlink ?? `${page}/incidents/${m.id}`,
    })),
    recent: resolved.slice(0, 5),
    recentCount: history ? resolved.length : null,
  };
}

// Datadog status pages (OpenRouter's, for one) publish a config.json without a CORS header, so it is read
// through the page reader, like the crawl files.
const DD_STATUS = { operational: 0, under_maintenance: 1, degraded_performance: 2, partial_outage: 3, major_outage: 4 };
async function fromDatadog(page) {
  const res = await inTurn(() => timed(`${READER}${page}/config.json`, { headers: { 'X-Return-Format': 'text' } }));
  if (!res.ok) throw new Error(`The page reader answered ${res.status}.`);
  const data = JSON.parse(await res.text());
  if (!Array.isArray(data?.components)) throw new Error('This page is not a Datadog status page.');
  const parts = data.components.flatMap((c) => (c.type === 'ComponentGroup' ? c.components ?? [] : [c]));
  const worst = Math.max(0, ...parts.map((c) => DD_STATUS[c.status] ?? 0));
  const open = (data.incidents ?? []).filter((i) => !i.resolved);
  const ongoing = (data.maintenances ?? []).filter((m) => ['scheduled', 'in_progress'].includes(m.currentStatus));
  const indicator = worst >= 4 ? 'critical' : worst === 3 ? 'major' : worst === 2 || open.length ? 'minor' : worst === 1 || ongoing.some((m) => m.currentStatus === 'in_progress') ? 'maintenance' : 'none';
  const resolved = recentOf((data.incidents ?? []).filter((i) => i.resolved).map((i) => ({ name: i.title, impact: '', at: i.resolvedDate ?? i.lastModifiedAt, url: `${page}/incidents/${i.id}` })));
  return {
    indicator,
    description: { none: 'All Systems Operational', minor: 'Minor Service Outage', major: 'Partial System Outage', critical: 'Major Service Outage', maintenance: 'Service Under Maintenance' }[indicator],
    parts: { total: parts.length, ok: parts.filter((c) => c.status === 'operational').length },
    components: parts.filter((c) => c.status !== 'operational').slice(0, STATUS_KEEP).map((c) => ({ name: c.name, status: c.status })),
    incidents: open.map((i) => ({
      name: i.title, impact: '', status: i.currentStatus, url: `${page}/incidents/${i.id}`, started: i.publishedDate, updated: i.lastModifiedAt, update: clip(i.timeline?.[0]?.description ?? i.description),
    })),
    maintenances: ongoing.map((m) => ({ name: m.title ?? m.scheduledDescription?.slice(0, 80) ?? 'Maintenance', status: m.currentStatus, start: m.startDate, end: m.completedDate, url: `${page}/maintenances/${m.id}` })),
    recent: resolved.slice(0, 5),
    recentCount: resolved.length,
  };
}

// Reads a status page. `kind` is known for presets and remembered after the first read;
// an unknown page is tried as Statuspage, then as a Datadog page.
export async function checkProvider(page, kind = '') {
  if (kind === 'datadog') return { ...(await fromDatadog(page)), kind };
  try {
    return { ...(await fromStatuspage(page)), kind: 'statuspage' };
  } catch (err) {
    if (kind === 'statuspage') throw err;
    try {
      return { ...(await fromDatadog(page)), kind: 'datadog' };
    } catch {
      throw err;
    }
  }
}

export const daysUntil = (isoDate) => Math.round((Date.parse(`${isoDate}T00:00:00`) - new Date().setHours(0, 0, 0, 0)) / 86400000);
