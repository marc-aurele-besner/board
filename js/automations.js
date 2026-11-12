// @ts-check
// Automations: site checks that run on their own, and rules that turn what they find into tasks.
// A task made by a rule carries `auto` (which rule) and `autoRef` (what it is about), so it is flagged in Tasks
// and a rule never makes a second task while its first one is still open.
import { statusOf, now, todayISO, money } from './ui.js';
import { makeTask } from './capture.js';
import { notify } from './notify-core.js';
import { checkHealth, checkDomain, checkCertificate, checkDns, readMeta, readCrawlFiles, checkProvider, hostOf, daysUntil } from './sitecheck.js';
import { nextRecurringDue, overBudget } from './money-core.js';
/** @import { AutomationRule, CrawlCheck, DataStore, Project, Provider, Site, SiteDns, SiteLogEntry, ToolsData, ProviderStatus } from '../types/data' */

// [key, title, description, has a "days before" setting]
export const RULES = [
  ['domain', 'Domain renewal', 'Create a task in the project before its domain expires. The deadline is the expiry date.', true],
  ['ssl', 'SSL certificate expiry', 'Create a task before a certificate expires.', true],
  ['health', 'Website down', 'Create a high-priority task when a website fails two checks in a row.', false],
  ['email', 'Email authentication', 'Create a task when a domain that receives mail has no SPF or DMARC record.', false],
  ['crawl', 'Site hidden from search', 'Create a high-priority task when robots.txt blocks Google or Bing from the whole site.', false],
  ['recurring', 'Recurring bill due', 'Create a task before a recurring expense in Money is due.', true],
  ['pools', 'Position out of range', 'Create a task when a liquidity position leaves its price range.', false],
  ['lending', 'Aave health factor low', 'Create a high-priority task when an Aave account’s health factor falls below the level set. The account is liquidated below 1.', 'factor'],
];
/** @type {Record<string, AutomationRule>} */
const RULE_DEFAULTS = { domain: { on: true, days: 30 }, ssl: { on: true, days: 14 }, health: { on: true }, email: { on: false }, crawl: { on: true }, recurring: { on: false, days: 3 }, pools: { on: false }, lending: { on: true, factor: 1.2 } };
// `days` and `factor` are read only on the rules whose defaults have them.
export const ruleOf = (/** @type {DataStore} */ store, /** @type {string} */ key) => /** @type {Required<AutomationRule>} */ ({ ...RULE_DEFAULTS[key], ...(store.get('settings').automations?.[key] ?? {}) });

// What each source is called on a task's "Auto" flag.
export const AUTO_SOURCES = { domain: 'the domain check', ssl: 'the SSL check', health: 'the website health check', email: 'the DNS check', crawl: 'the crawl files check', recurring: 'a recurring bill', pools: 'Liquidity Pools', lending: 'Aave lending', telegram: 'a Telegram message', cron: 'a Cron flow' };

// `every`: minutes between automatic checks. `providers`: the status pages followed in Provider status, and `status` their last answer.
/** @type {ToolsData} */
export const TOOLS_DEFAULTS = { sites: {}, every: 60, providers: [], status: {} };
export const sitesOf = (/** @type {DataStore} */ store) => store.get('projects').projects.filter((p) => hostOf(p.website ?? ''));
export const siteData = (/** @type {DataStore} */ store, /** @type {string} */ projectId) => /** @type {Site} */ (store.get('tools').sites[projectId] ?? {});
export const autoTaskFor = (/** @type {DataStore} */ store, /** @type {string} */ kind, /** @type {string | undefined} */ ref) =>
  store.get('todos').items.find((t) => t.auto === kind && t.autoRef === ref && statusOf(t) !== 'done') ?? null;

/**
 * @param {DataStore} store
 * @param {{ kind: string, ref: string, text: string, due?: string, projectId?: string | null, why: string, priority?: string }} task
 */
function makeAuto(store, { kind, ref, text, due = '', projectId = null, why, priority = 'high' }) {
  if (autoTaskFor(store, kind, ref)) return false;
  store.update('todos', (d) => d.items.push(makeTask({ text, description: `Created automatically: ${why}`, priority, due, projectId, auto: kind, autoRef: ref })));
  notify(store, { kind: 'auto', text: `Task created automatically: ${text}.`, href: '#/todos?filter=auto' });
  return true;
}

// The mail records a domain that receives mail should have but lacks. A domain without MX is skipped: it sends nothing to protect.
export const emailGaps = (/** @type {Site['dns']} */ dns) =>
  !dns?.domain || dns.error || !dns.mx?.length ? [] : [dns.spf?.record ? '' : 'SPF', dns.dmarc?.record ? '' : 'DMARC'].filter(Boolean);

// Applies every rule that is switched on to what is known now. Returns how many tasks it made.
/** @param {DataStore} store */
export function runRules(store) {
  let made = 0;
  const count = (/** @type {boolean} */ ok) => {
    if (ok) made += 1;
  };
  const ssl = ruleOf(store, 'ssl');
  const domain = ruleOf(store, 'domain');
  const health = ruleOf(store, 'health');
  const email = ruleOf(store, 'email');
  const crawl = ruleOf(store, 'crawl');
  for (const p of sitesOf(store)) {
    const host = hostOf(p.website);
    const s = siteData(store, p.id);
    if (ssl.on && s.ssl?.until && daysUntil(s.ssl.until) <= ssl.days) {
      count(makeAuto(store, { kind: 'ssl', ref: host, projectId: p.id, due: s.ssl.until, text: `Renew the SSL certificate for ${host}`, why: `the certificate expires on ${s.ssl.until}.` }));
    }
    if (domain.on && s.domain?.until && daysUntil(s.domain.until) <= domain.days) {
      count(makeAuto(store, { kind: 'domain', ref: /** @type {string} */ (s.domain.name), projectId: p.id, due: s.domain.until, text: `Renew the domain ${s.domain.name}`, why: `the domain expires on ${s.domain.until}.` }));
    }
    const last = (s.history ?? []).slice(-2);
    if (health.on && last.length === 2 && last.every((c) => !c.ok)) {
      count(makeAuto(store, { kind: 'health', ref: host, projectId: p.id, due: todayISO(), text: `${host} is not answering`, why: 'two checks in a row failed.' }));
    }
    const gaps = emailGaps(s.dns);
    if (email.on && gaps.length) {
      count(makeAuto(store, { kind: 'email', ref: /** @type {string} */ (/** @type {SiteDns} */ (s.dns).domain), projectId: p.id, priority: 'medium', text: `Add ${gaps.join(' and ')} records for ${/** @type {SiteDns} */ (s.dns).domain}`, why: `${/** @type {SiteDns} */ (s.dns).domain} receives mail but has no ${gaps.join(' or ')} record, so others can send mail in its name.` }));
    }
    if (crawl.on && s.crawl?.robots?.blocksSearch) {
      count(makeAuto(store, { kind: 'crawl', ref: host, projectId: p.id, due: todayISO(), text: `Let search engines crawl ${host}`, why: 'its robots.txt blocks Google or Bing from the whole site, so it drops out of search results.' }));
    }
  }
  const recurring = ruleOf(store, 'recurring');
  if (recurring.on) {
    for (const r of store.get('finance').recurring ?? []) {
      const next = nextRecurringDue(r);
      if (next && daysUntil(next) <= recurring.days) {
        count(makeAuto(store, { kind: 'recurring', ref: `${r.id}:${next}`, due: next, priority: 'medium', text: `Pay ${r.name}`, why: `this recurring expense is due on ${next}.` }));
      }
    }
  }
  return made;
}

// Called by Liquidity Pools after each read, with the rows it shows.
/** @param {DataStore} store @param {{ inRange: boolean, ref: string, pair: string, chain: string }[]} rows */
export function poolsChanged(store, rows) {
  for (const r of rows.filter((x) => !x.inRange)) {
    const ref = r.ref;
    notify(store, { kind: 'pools', text: `${r.pair} on ${r.chain} is out of its price range.`, href: '#/positions?tab=positions&filter=out', key: `pool:${ref}:${todayISO()}` });
    if (ruleOf(store, 'pools').on) {
      makeAuto(store, { kind: 'pools', ref, priority: 'medium', text: `Rebalance ${r.pair} on ${r.chain}`, why: 'the position left its price range.' });
    }
  }
}

// Announces an Aave account whose health factor fell below the level set in Automations, once per account and day,
// and makes a task when the rule is on. The runners call it after each lending read.
/** @param {DataStore} store @param {{ health?: number | null, chainName?: string, chainId: number, wallet: string }[]} rows */
export function lendingChanged(store, rows) {
  const { on, factor } = ruleOf(store, 'lending');
  for (const r of rows.filter((x) => x.health != null && x.health < factor)) {
    const chain = r.chainName ?? `chain ${r.chainId}`;
    const who = `${r.wallet.slice(0, 6)}…${r.wallet.slice(-4)}`;
    const ref = `${r.chainId}:${r.wallet}`;
    notify(store, { kind: 'lending', text: `Aave on ${chain}: ${who}’s health factor is ${/** @type {number} */ (r.health).toFixed(2)}, below ${factor}.`, href: '#/positions?tab=lending', key: `lending:${ref}:${todayISO()}` });
    if (on) makeAuto(store, { kind: 'lending', ref, text: `Raise the Aave health factor of ${who} on ${chain}`, why: `its health factor fell to ${/** @type {number} */ (r.health).toFixed(2)}, below ${factor}.` });
  }
}

// Announces a category that went over its monthly budget. Once per category and month.
/** @param {DataStore} store */
export function checkBudgets(store) {
  const month = todayISO().slice(0, 7);
  for (const b of overBudget(store)) {
    notify(store, {
      kind: 'budget',
      text: `${b.category} is over its budget this month: ${money(b.spent, b.currency)} of ${money(b.budget, b.currency)}.`,
      href: '#/money',
      key: `budget:${b.category}:${month}`,
    });
  }
}

/** @typedef {'ssl' | 'domain' | 'meta' | 'dns' | 'crawl'} LookupKey */
/** What one round of checks found, by check. @typedef {Pick<Site, 'health' | LookupKey>} Found */

const HISTORY = 60; // checks kept per site for the uptime bars
const LOG_KEEP = 200; // log entries kept per site
const LOG_REPEAT_MS = 6 * 3600000; // the same warning is written again only after this long
/** @type {Record<string, string>} */
const PART_LABEL = { ssl: 'SSL', domain: 'Domain', dns: 'DNS', crawl: 'Crawl files', meta: 'Metadata' };

// What one round of checks found worth keeping: errors, warnings, and a site coming back.
// Each entry is { at, level: 'error' | 'warn' | 'info', source, text }.
/** @param {Project} project @param {Found} found @param {Site} before @param {Site} after */
function logEntries(project, found, before, after) {
  const host = hostOf(project.website);
  /** @type {SiteLogEntry[]} */
  const out = [];
  const add = (/** @type {string} */ level, /** @type {string} */ source, /** @type {string} */ text) => out.push({ at: now(), level, source, text });
  if (found.health) {
    const { status, ms } = found.health;
    if (status === 'down') add('error', 'health', `${host} did not answer.`);
    else if (status === 'slow') add('warn', 'health', `Slow answer: ${ms} ms.`);
    else if (before.health?.status === 'down') add('info', 'health', `Answering again (${ms} ms).`);
  }
  for (const key of /** @type {LookupKey[]} */ (Object.keys(PART_LABEL))) {
    if (found[key]?.error) add('warn', key, `${PART_LABEL[key]} lookup failed: ${found[key].error}`);
  }
  if (found.ssl && after.ssl?.until && daysUntil(after.ssl.until) <= 30) add(daysUntil(after.ssl.until) <= 7 ? 'error' : 'warn', 'ssl', `The SSL certificate expires on ${after.ssl.until}.`);
  if (found.domain && after.domain?.until && daysUntil(after.domain.until) <= 60) add(daysUntil(after.domain.until) <= 14 ? 'error' : 'warn', 'domain', `The domain ${after.domain.name} expires on ${after.domain.until}.`);
  if (found.dns) {
    const gaps = emailGaps(after.dns);
    if (gaps.length) add('warn', 'dns', `${/** @type {SiteDns} */ (after.dns).domain} receives mail but has no ${gaps.join(' or ')} record.`);
  }
  if (found.crawl && after.crawl?.robots) {
    if (after.crawl.robots.blocksSearch) add('error', 'crawl', 'robots.txt blocks Google or Bing from the whole site.');
    const broken = Object.entries(after.crawl).filter(([, f]) => f?.checks?.some((/** @type {CrawlCheck} */ [l]) => l === 'error')).map(([k]) => k);
    if (broken.length) add('warn', 'crawl', `Format errors in ${broken.join(', ')}.`);
  }
  return out;
}

// Runs the chosen checks for one project and saves what they found. A failed lookup is saved as its error text.
/** @param {DataStore} store @param {Project} project @param {string[]} [parts] */
export async function checkSite(store, project, parts = ['health', 'ssl', 'domain']) {
  const host = hostOf(project.website);
  /** @template T @param {() => Promise<T>} run @returns {Promise<(T | { error: string }) & { at: string }>} */
  const attempt = async (run) => {
    try {
      return { ...(await run()), at: now() };
    } catch (err) {
      return { error: /** @type {Error} */ (err).name === 'AbortError' ? 'The lookup took too long.' : /** @type {Error} */ (err).message, at: now() };
    }
  };
  /** @type {Found} */
  const found = {};
  await Promise.all([
    parts.includes('health') ? checkHealth(project.website).then((r) => (found.health = { ...r, at: now() })) : null,
    parts.includes('ssl') ? attempt(() => checkCertificate(host)).then((r) => (found.ssl = r)) : null,
    parts.includes('domain') ? attempt(() => checkDomain(host)).then((r) => (found.domain = r)) : null,
    parts.includes('meta') ? attempt(() => readMeta(project.website)).then((r) => (found.meta = r)) : null,
    parts.includes('dns') ? attempt(() => checkDns(host)).then((r) => (found.dns = r)) : null,
    parts.includes('crawl') ? attempt(() => readCrawlFiles(project.website)).then((r) => (found.crawl = r)) : null,
  ]);
  const before = siteData(store, project.id);
  const wasUp = before.health ? before.health.status !== 'down' : true;
  store.update('tools', (d) => {
    // any: each lookup's own shape is copied across by key.
    const s = /** @type {Site & Record<LookupKey, any>} */ (d.sites[project.id] ??= {});
    // A lookup that failed keeps the last good answer, so one bad moment does not erase a known expiry date.
    for (const key of /** @type {LookupKey[]} */ (['ssl', 'domain', 'meta', 'dns', 'crawl'])) {
      if (!found[key]) continue;
      s[key] = found[key].error && s[key] && !s[key].error ? { ...s[key], error: found[key].error, at: found[key].at } : found[key];
    }
    if (found.health) {
      s.health = found.health;
      s.history = [...(s.history ?? []), { at: found.health.at, ok: found.health.status !== 'down', ms: found.health.ms }].slice(-HISTORY);
    }
  });
  const entries = logEntries(project, found, before, siteData(store, project.id));
  if (entries.length) {
    store.update('tools', (d) => {
      const s = d.sites[project.id];
      const log = s.log ?? [];
      // A health problem is written each time, so the log shows how long it lasted; other warnings only when new or stale.
      const fresh = entries.filter((e) => e.source === 'health' || !log.some((x) => x.source === e.source && x.text === e.text && Date.parse(e.at) - Date.parse(x.at) < LOG_REPEAT_MS));
      s.log = [...log, ...fresh].slice(-LOG_KEEP);
    });
  }
  if (found.health?.status === 'down' && wasUp) {
    notify(store, { kind: 'health', text: `${host} did not answer.`, href: '#/tools' });
  }
  const s = siteData(store, project.id);
  if (s.ssl?.until && daysUntil(s.ssl.until) <= ruleOf(store, 'ssl').days) {
    notify(store, { kind: 'ssl', text: `The SSL certificate for ${host} expires on ${s.ssl.until}.`, href: '#/tools?tab=ssl', key: `ssl:${host}:${s.ssl.until}` });
  }
  if (s.domain?.until && daysUntil(s.domain.until) <= ruleOf(store, 'domain').days) {
    notify(store, { kind: 'ssl', text: `The domain ${s.domain.name} expires on ${s.domain.until}.`, href: '#/tools?tab=ssl', key: `domain:${s.domain.name}:${s.domain.until}` });
  }
}

/** @param {DataStore} store @param {string[]} [parts] */
export async function checkAllSites(store, parts) {
  for (const p of sitesOf(store)) await checkSite(store, p, parts);
  return runRules(store);
}

const DAY_MS = 86400000;
const olderThan = (/** @type {string | undefined} */ at, /** @type {number} */ ms) => !at || Date.now() - Date.parse(at) > ms;

// The runners' round of site checks: health on the interval chosen in Tools; certificates, domains, DNS and crawl
// files, which change slowly, once a day. Returns the number of tasks the rules made.
/** @param {DataStore} store */
export async function checkDueSites(store) {
  const every = (store.get('tools').every || 60) * 60000;
  for (const p of sitesOf(store)) {
    const s = siteData(store, p.id);
    const parts = /** @type {string[]} */ ([
      olderThan(s.health?.at, every) ? 'health' : null,
      olderThan(s.ssl?.at, DAY_MS) ? 'ssl' : null,
      olderThan(s.domain?.at, DAY_MS) ? 'domain' : null,
      olderThan(s.dns?.at, DAY_MS) ? 'dns' : null,
      olderThan(s.crawl?.at, DAY_MS) ? 'crawl' : null,
    ].filter(Boolean));
    if (parts.length) await checkSite(store, p, parts);
  }
  return runRules(store);
}

// True when the automatic check is due: never run, or older than the chosen interval.
/** @param {DataStore} store */
export function sitesDue(store) {
  const every = (store.get('tools').every || 60) * 60000;
  return sitesOf(store).some((p) => {
    const at = siteData(store, p.id).health?.at;
    return !at || Date.now() - Date.parse(at) > every;
  });
}

// --- Provider status ---

// Reads the status page of each followed provider (or only `ids`), and says when one gets worse or recovers.
// The first answer for a provider says nothing: it shows on the page that just added it.
/** @param {DataStore} store @param {string[] | null} [ids] */
export async function checkProviders(store, ids = null) {
  const providers = store.get('tools').providers.filter((pr) => !ids || ids.includes(pr.id));
  const found = await Promise.all(providers.map(/** @returns {Promise<[Provider, ProviderStatus]>} */ async (pr) => {
    try {
      return [pr, { ...(await checkProvider(pr.url, pr.kind ?? store.get('tools').status[pr.id]?.kind)), at: now() }];
    } catch (err) {
      return [pr, { error: /** @type {Error} */ (err).name === 'AbortError' ? 'The status page took too long.' : /** @type {Error} */ (err).message, at: now() }];
    }
  }));
  const before = store.get('tools').status;
  const was = Object.fromEntries(found.map(([pr]) => [pr.id, before[pr.id]?.indicator]));
  store.update('tools', (d) => {
    for (const [pr, r] of found) {
      const last = d.status[pr.id];
      // A failed read keeps the last answer, so one bad moment looks like neither an outage nor a recovery.
      d.status[pr.id] = r.error && last?.indicator ? { ...last, error: r.error, at: r.at } : r;
    }
  });
  for (const [pr, r] of found) {
    if (!r.indicator || !was[pr.id] || was[pr.id] === r.indicator) continue;
    const text = r.indicator === 'none' ? `${pr.name} is back to normal.` : `${pr.name}: ${r.description || 'something is wrong'}.`;
    notify(store, { kind: 'status', text, href: '#/tools?tab=status', key: `status:${pr.id}:${r.indicator}:${todayISO()}` });
  }
}

// True when a followed provider has not been read within the interval chosen in Tools.
/** @param {DataStore} store */
export function providersDue(store) {
  const { every, providers, status } = store.get('tools');
  const ms = (every || 60) * 60000;
  return providers.some((pr) => {
    const at = status[pr.id]?.at;
    return !at || Date.now() - Date.parse(at) > ms;
  });
}
