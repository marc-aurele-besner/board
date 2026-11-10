// Automations: site checks that run on their own, and rules that turn what they find into tasks.
// A task made by a rule carries `auto` (which rule) and `autoRef` (what it is about), so it is flagged in Tasks
// and a rule never makes a second task while its first one is still open.
import { statusOf, now, todayISO, money } from './ui.js';
import { makeTask } from './capture.js';
import { notify } from './notifications.js';
import { checkHealth, checkDomain, checkCertificate, checkDns, readMeta, readCrawlFiles, checkProvider, hostOf, daysUntil } from './sitecheck.js';
import { nextRecurringDue, overBudget } from './modules/money.js';

// [key, title, description, has a "days before" setting]
export const RULES = [
  ['domain', 'Domain renewal', 'Create a task in the project before its domain expires. The deadline is the expiry date.', true],
  ['ssl', 'SSL certificate expiry', 'Create a task before a certificate expires.', true],
  ['health', 'Website down', 'Create a high-priority task when a website fails two checks in a row.', false],
  ['email', 'Email authentication', 'Create a task when a domain that receives mail has no SPF or DMARC record.', false],
  ['crawl', 'Site hidden from search', 'Create a high-priority task when robots.txt blocks Google or Bing from the whole site.', false],
  ['recurring', 'Recurring bill due', 'Create a task before a recurring expense in Money is due.', true],
  ['pools', 'Position out of range', 'Create a task when a liquidity position leaves its price range.', false],
];
const RULE_DEFAULTS = { domain: { on: true, days: 30 }, ssl: { on: true, days: 14 }, health: { on: true }, email: { on: false }, crawl: { on: true }, recurring: { on: false, days: 3 }, pools: { on: false } };
export const ruleOf = (store, key) => ({ ...RULE_DEFAULTS[key], ...(store.get('settings').automations?.[key] ?? {}) });

// What each source is called on a task's "Auto" flag.
export const AUTO_SOURCES = { domain: 'the domain check', ssl: 'the SSL check', health: 'the website health check', email: 'the DNS check', crawl: 'the crawl files check', recurring: 'a recurring bill', pools: 'Liquidity Pools', telegram: 'a Telegram message', cron: 'a Cron flow' };

// `every`: minutes between automatic checks. `providers`: the status pages followed in Provider status, and `status` their last answer.
export const TOOLS_DEFAULTS = { sites: {}, every: 60, providers: [], status: {} };
export const sitesOf = (store) => store.get('projects').projects.filter((p) => hostOf(p.website ?? ''));
export const siteData = (store, projectId) => store.get('tools').sites[projectId] ?? {};
export const autoTaskFor = (store, kind, ref) =>
  store.get('todos').items.find((t) => t.auto === kind && t.autoRef === ref && statusOf(t) !== 'done') ?? null;

function makeAuto(store, { kind, ref, text, due = '', projectId = null, why, priority = 'high' }) {
  if (autoTaskFor(store, kind, ref)) return false;
  store.update('todos', (d) => d.items.push(makeTask({ text, description: `Created automatically: ${why}`, priority, due, projectId, auto: kind, autoRef: ref })));
  notify(store, { kind: 'auto', text: `Task created automatically: ${text}.`, href: '#/todos?filter=auto' });
  return true;
}

// The mail records a domain that receives mail should have but lacks. A domain without MX is skipped: it sends nothing to protect.
export const emailGaps = (dns) =>
  !dns?.domain || dns.error || !dns.mx?.length ? [] : [dns.spf?.record ? '' : 'SPF', dns.dmarc?.record ? '' : 'DMARC'].filter(Boolean);

// Applies every rule that is switched on to what is known now. Returns how many tasks it made.
export function runRules(store) {
  let made = 0;
  const count = (ok) => {
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
      count(makeAuto(store, { kind: 'domain', ref: s.domain.name, projectId: p.id, due: s.domain.until, text: `Renew the domain ${s.domain.name}`, why: `the domain expires on ${s.domain.until}.` }));
    }
    const last = (s.history ?? []).slice(-2);
    if (health.on && last.length === 2 && last.every((c) => !c.ok)) {
      count(makeAuto(store, { kind: 'health', ref: host, projectId: p.id, due: todayISO(), text: `${host} is not answering`, why: 'two checks in a row failed.' }));
    }
    const gaps = emailGaps(s.dns);
    if (email.on && gaps.length) {
      count(makeAuto(store, { kind: 'email', ref: s.dns.domain, projectId: p.id, priority: 'medium', text: `Add ${gaps.join(' and ')} records for ${s.dns.domain}`, why: `${s.dns.domain} receives mail but has no ${gaps.join(' or ')} record, so others can send mail in its name.` }));
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
export function poolsChanged(store, rows) {
  for (const r of rows.filter((x) => !x.inRange)) {
    const ref = r.ref;
    notify(store, { kind: 'pools', text: `${r.pair} on ${r.chain} is out of its price range.`, href: '#/positions?filter=out', key: `pool:${ref}:${todayISO()}` });
    if (ruleOf(store, 'pools').on) {
      makeAuto(store, { kind: 'pools', ref, priority: 'medium', text: `Rebalance ${r.pair} on ${r.chain}`, why: 'the position left its price range.' });
    }
  }
}

// Announces a category that went over its monthly budget. Once per category and month.
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

const HISTORY = 60; // checks kept per site for the uptime bars

// Runs the chosen checks for one project and saves what they found. A failed lookup is saved as its error text.
export async function checkSite(store, project, parts = ['health', 'ssl', 'domain']) {
  const host = hostOf(project.website);
  const attempt = async (run) => {
    try {
      return { ...(await run()), at: now() };
    } catch (err) {
      return { error: err.name === 'AbortError' ? 'The lookup took too long.' : err.message, at: now() };
    }
  };
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
    const s = (d.sites[project.id] ??= {});
    // A lookup that failed keeps the last good answer, so one bad moment does not erase a known expiry date.
    for (const key of ['ssl', 'domain', 'meta', 'dns', 'crawl']) {
      if (!found[key]) continue;
      s[key] = found[key].error && s[key] && !s[key].error ? { ...s[key], error: found[key].error, at: found[key].at } : found[key];
    }
    if (found.health) {
      s.health = found.health;
      s.history = [...(s.history ?? []), { at: found.health.at, ok: found.health.status !== 'down', ms: found.health.ms }].slice(-HISTORY);
    }
  });
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

export async function checkAllSites(store, parts) {
  for (const p of sitesOf(store)) await checkSite(store, p, parts);
  return runRules(store);
}

// True when the automatic check is due: never run, or older than the chosen interval.
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
export async function checkProviders(store, ids = null) {
  const providers = store.get('tools').providers.filter((pr) => !ids || ids.includes(pr.id));
  const found = await Promise.all(providers.map(async (pr) => {
    try {
      return [pr, { ...(await checkProvider(pr.url)), at: now() }];
    } catch (err) {
      return [pr, { error: err.name === 'AbortError' ? 'The status page took too long.' : err.message, at: now() }];
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
export function providersDue(store) {
  const { every, providers, status } = store.get('tools');
  const ms = (every || 60) * 60000;
  return providers.some((pr) => {
    const at = status[pr.id]?.at;
    return !at || Date.now() - Date.parse(at) > ms;
  });
}
