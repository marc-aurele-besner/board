// Tools: checks that run against the website of each project, and the status of the services they rely on.
import { h, icon, empty, notice, uid } from '../ui.js';
import { projectIcon } from './projects.js';
import { hostOf, daysUntil, statusPageOf } from '../sitecheck.js';
import { sitesOf, siteData, checkSite, checkAllSites, runRules, autoTaskFor, ruleOf, emailGaps, checkProviders, TOOLS_DEFAULTS } from '../automations.js';
import { makeTask } from '../capture.js';
import { toast } from '../toast.js';

const COLLECTION = 'tools';
const TABS = [['health', 'Website health', 'globe'], ['ssl', 'SSL and domains', 'shield'], ['dns', 'DNS and email', 'mail'], ['crawl', 'Crawl files', 'file'], ['meta', 'Metadata preview', 'link'], ['status', 'Provider status', 'activity']];
// What "Check all now" looks up on each tab.
const TAB_PARTS = { health: ['health'], ssl: ['ssl', 'domain'], dns: ['dns'], crawl: ['crawl'] };
const EVERY = [[15, '15 minutes'], [60, 'hour'], [360, '6 hours'], [1440, 'day']];
const STATUS = { up: ['Up', 'done'], slow: ['Slow', 'medium'], down: ['Down', 'high'] };

// View state: the tab, the project shown in the metadata preview, and which sites are being checked now.
const view = { tab: 'health', project: '', busy: new Set() };

const pillOf = (text, tone) => h('span', { class: `pill tone-${tone}` }, text);
const timeOf = (at) => (at ? new Date(at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'never');

function run(store, key, work) {
  view.busy.add(key);
  store.refresh();
  return work()
    .catch((err) => toast(err.message))
    .finally(() => {
      view.busy.delete(key);
      store.refresh();
    });
}

const check = (store, p, parts) =>
  run(store, p.id, async () => {
    await checkSite(store, p, parts);
    const made = runRules(store);
    if (made) toast(`${made} task${made === 1 ? '' : 's'} created automatically`);
  });

// What a rule's task is about: the registered domain for domain and mail rules, the host otherwise.
const refOf = (store, p, kind) =>
  kind === 'domain' ? siteData(store, p.id).domain?.name : kind === 'email' ? siteData(store, p.id).dns?.domain : hostOf(p.website);

// A task for a site, made by hand from a row. It is linked to the rule it belongs to, so the rule does not add another.
function addTask(store, p, kind, text, due = '') {
  const ref = refOf(store, p, kind);
  store.update('todos', (d) => d.items.push(makeTask({ text, projectId: p.id, priority: 'medium', due, ...(kind ? { auto: kind, autoRef: ref } : {}) })));
  toast(`Task added to ${p.name}`);
}

function taskCell(store, p, kind, text, due) {
  const ref = refOf(store, p, kind);
  return autoTaskFor(store, kind, ref)
    ? h('a', { href: '#/todos?filter=auto', class: 'btn-link' }, 'Task open')
    : h('button', { type: 'button', class: 'btn-small', onclick: () => addTask(store, p, kind, text, due) }, 'Create task');
}

function daysPill(until) {
  const n = daysUntil(until);
  return pillOf(n < 0 ? 'Expired' : `${n} day${n === 1 ? '' : 's'} left`, n <= 14 ? 'high' : n <= 30 ? 'medium' : 'done');
}

// --- Website health ---

function healthTab(store, sites) {
  const data = sites.map((p) => [p, siteData(store, p.id)]);
  const countOf = (status) => data.filter(([, s]) => s.health?.status === status).length;
  const stat = (n, label) => h('div', { class: 'card stat' }, h('strong', null, String(n)), h('span', { class: 'muted small' }, label));
  return h('div', { class: 'stack-lg' },
    h('div', { class: 'summary tool-stats' }, stat(countOf('up'), 'up'), stat(countOf('slow'), 'slow'), stat(countOf('down'), 'down'), stat(sites.length, 'sites')),
    h('div', { class: 'site-grid' }, data.map(([p, s]) => {
      const host = hostOf(p.website);
      const busy = view.busy.has(p.id) || view.busy.has('all');
      const [label, tone] = STATUS[s.health?.status] ?? ['Not checked', 'plain'];
      const history = s.history ?? [];
      const up = history.length ? Math.round((history.filter((c) => c.ok).length / history.length) * 1000) / 10 : null;
      return h('article', { class: `card site-card ${s.health?.status ?? ''}` },
        h('div', { class: 'row between' },
          h('div', { class: 'row' },
            projectIcon(p, 'project-icon large'),
            h('div', null, h('strong', null, p.name), h('div', null, h('a', { href: p.website, target: '_blank', rel: 'noopener', class: 'small' }, host)))),
          busy ? pillOf('Checking…', 'plain') : pillOf(label, tone)),
        h('div', { class: 'stats' },
          h('div', null, h('strong', null, s.health ? (s.health.status === 'down' ? 'No answer' : 'Answered') : '—'), h('span', { class: 'muted small' }, 'last check')),
          h('div', null, h('strong', null, s.health?.ms ? `${s.health.ms} ms` : '—'), h('span', { class: 'muted small' }, 'response')),
          h('div', null, h('strong', null, up === null ? '—' : `${up}%`), h('span', { class: 'muted small' }, `of ${history.length} check${history.length === 1 ? '' : 's'}`))),
        h('div', { class: 'up-bars', role: 'img', 'aria-label': 'Recent checks, oldest first' },
          history.length
            ? history.slice(-40).map((c) => h('span', { class: c.ok ? (c.ms > 1500 ? 'slow' : '') : 'bad', title: `${timeOf(c.at)}: ${c.ok ? `${c.ms} ms` : 'no answer'}` }))
            : h('span', { class: 'na' })),
        h('div', { class: 'row between' },
          h('span', { class: 'muted small' }, `Checked ${timeOf(s.health?.at)}`),
          h('div', { class: 'row' },
            h('button', { type: 'button', class: 'btn-small', disabled: busy, onclick: () => check(store, p, ['health']) }, icon('refresh'), 'Check now'),
            s.health?.status === 'down' || s.health?.status === 'slow'
              ? taskCell(store, p, 'health', `Look into ${host}: ${s.health.status === 'down' ? 'not answering' : 'slow'}`)
              : null)));
    })),
    h('p', { class: 'muted small' }, 'A check asks the site for its home page from this browser. The browser hides the answer itself, so a check tells “answered” from “did not answer” and how long it took, not the status code.'));
}

// --- SSL and domains ---

function sslTab(store, sites) {
  const ssl = ruleOf(store, 'ssl');
  const domain = ruleOf(store, 'domain');
  const cell = (info, body) => (info?.until ? body() : h('span', { class: 'muted small' }, info?.error ?? 'Not checked yet'));
  return h('div', { class: 'stack-lg' },
    notice({
      tone: 'info',
      text: `Tasks are created automatically ${ssl.on ? `${ssl.days} days before an SSL certificate expires` : 'for SSL only when you ask'} and ${domain.on ? `${domain.days} days before a domain does` : 'for domains only when you ask'}. Each one is flagged “Auto” in Tasks.`,
      actions: [h('a', { href: '#/settings?section=automations', class: 'btn-small' }, 'Change the rules')],
    }),
    h('div', { class: 'card mon-scroll' },
      h('table', { class: 'mon-table tool-table' },
        h('thead', null, h('tr', null,
          ['Site', 'SSL certificate', 'Issuer', 'SSL task', 'Domain', 'Registrar', 'Domain task', ''].map((t) => h('th', null, t)))),
        h('tbody', null, sites.map((p) => {
          const s = siteData(store, p.id);
          const host = hostOf(p.website);
          const busy = view.busy.has(p.id) || view.busy.has('all');
          return h('tr', null,
            h('td', null, h('div', { class: 'row' }, projectIcon(p), h('div', null, h('strong', null, p.name), h('div', { class: 'muted small' }, host)))),
            h('td', null, cell(s.ssl, () => [daysPill(s.ssl.until), h('div', { class: 'muted small' }, `valid until ${s.ssl.until}`)])),
            h('td', null, s.ssl?.issuer ?? ''),
            h('td', null, s.ssl?.until && daysUntil(s.ssl.until) <= 30 ? taskCell(store, p, 'ssl', `Renew the SSL certificate for ${host}`, s.ssl.until) : h('span', { class: 'muted small' }, s.ssl?.until ? 'Not needed yet' : '')),
            h('td', null, cell(s.domain, () => [daysPill(s.domain.until), h('div', { class: 'muted small' }, `${s.domain.name} · renews by ${s.domain.until}`)])),
            h('td', null, s.domain?.registrar ?? ''),
            h('td', null, s.domain?.until && daysUntil(s.domain.until) <= 60 ? taskCell(store, p, 'domain', `Renew the domain ${s.domain.name}`, s.domain.until) : h('span', { class: 'muted small' }, s.domain?.until ? 'Not needed yet' : '')),
            h('td', null, h('button', { type: 'button', class: 'icon-btn', disabled: busy, title: 'Look up again', 'aria-label': `Look up ${host} again`, onclick: () => check(store, p, ['ssl', 'domain']) }, icon('refresh'))));
        })))),
    h('p', { class: 'muted small' }, 'The certificate date comes from the public certificate logs (Cert Spotter, then crt.sh): the newest certificate issued for the host. The domain date comes from its registry (RDAP). Only the site’s address is sent to them.'));
}

// --- DNS and email ---

// SPF ends with how strictly mail from other servers is treated; "+all" lets anyone send as the domain.
const SPF_ALL = { '-all': ['Strict', 'done'], '~all': ['Soft fail', 'done'], '?all': ['Neutral', 'medium'], '+all': ['Anyone may send', 'high'], all: ['Anyone may send', 'high'] };
const DMARC_POLICY = { reject: ['Reject', 'done'], quarantine: ['Quarantine', 'done'], none: ['Monitor only', 'medium'] };

function dnsTab(store, sites) {
  const email = ruleOf(store, 'email');
  return h('div', { class: 'stack-lg' },
    notice({
      tone: 'info',
      text: email.on
        ? 'A task is created automatically when a domain that receives mail has no SPF or DMARC record.'
        : 'Tasks for missing SPF or DMARC records are created only when you ask.',
      actions: [h('a', { href: '#/settings?section=automations', class: 'btn-small' }, 'Change the rules')],
    }),
    h('div', { class: 'card mon-scroll' },
      h('table', { class: 'mon-table tool-table' },
        h('thead', null, h('tr', null, ['Site', 'Mail servers', 'SPF', 'DMARC', 'DKIM', 'CAA', 'Task', ''].map((t) => h('th', null, t)))),
        h('tbody', null, sites.flatMap((p) => {
          const d = siteData(store, p.id).dns;
          const host = hostOf(p.website);
          const busy = view.busy.has(p.id) || view.busy.has('all');
          const site = h('td', null, h('div', { class: 'row' }, projectIcon(p), h('div', null, h('strong', null, p.name), h('div', { class: 'muted small' }, d?.domain ?? host))));
          const again = h('td', null, h('button', { type: 'button', class: 'icon-btn', disabled: busy, title: 'Look up again', 'aria-label': `Look up ${host} again`, onclick: () => check(store, p, ['dns']) }, icon('refresh')));
          if (!d?.domain) return [h('tr', null, site, h('td', { colspan: 6 }, h('span', { class: 'muted small' }, busy ? 'Looking up…' : d?.error ?? 'Not looked up yet')), again)];
          const mail = d.mx.length > 0;
          const noMail = () => h('span', { class: 'muted small' }, 'No mail');
          const gaps = emailGaps(d);
          const [spfText, spfTone] = !d.spf.record ? ['Missing', 'high'] : SPF_ALL[d.spf.all.toLowerCase()] ?? ['No “all” rule', 'medium'];
          const [dmarcText, dmarcTone] = !d.dmarc.record ? ['Missing', 'high'] : DMARC_POLICY[d.dmarc.policy] ?? ['Unclear policy', 'medium'];
          const issuers = d.caa.filter((c) => / issue "/.test(c)).map((c) => c.match(/"([^"]*)"/)?.[1]).filter(Boolean);
          const records = [['A', d.a], ['AAAA', d.aaaa], ['NS', d.ns], ['MX', d.mx], ['SPF', [d.spf.record]], ['DMARC', [d.dmarc.record]], ['DKIM selectors', d.dkim], ['CAA', d.caa]];
          return [
            h('tr', null,
              site,
              h('td', null, mail ? [h('strong', null, String(d.mx.length)), h('div', { class: 'muted small' }, d.mx[0])] : noMail()),
              h('td', null, mail || d.spf.record ? pillOf(spfText, spfTone) : noMail()),
              h('td', null, mail || d.dmarc.record ? pillOf(dmarcText, dmarcTone) : noMail()),
              h('td', null, d.dkim.length ? d.dkim.join(', ') : h('span', { class: 'muted small' }, mail ? 'None found' : '')),
              h('td', null, issuers.length ? [...new Set(issuers)].join(', ') : h('span', { class: 'muted small' }, 'Any authority')),
              h('td', null, gaps.length ? taskCell(store, p, 'email', `Add ${gaps.join(' and ')} records for ${d.domain}`) : h('span', { class: 'muted small' }, mail ? 'Not needed' : '')),
              again),
            h('tr', { class: 'dns-raw' },
              h('td', { colspan: 8 },
                h('details', null,
                  h('summary', { class: 'muted small' }, `Records for ${d.domain} · looked up ${timeOf(d.at)}${d.error ? ` · last try failed: ${d.error}` : ''}`),
                  h('dl', { class: 'dns-records' }, records.flatMap(([k, v]) => [h('dt', null, k), h('dd', null, v.filter(Boolean).length ? v.filter(Boolean).map((x) => h('code', null, x)) : h('span', { class: 'muted small' }, 'None'))]))))),
          ];
        })))),
    h('p', { class: 'muted small' }, 'Records come from Cloudflare’s public DNS resolver (DNS over HTTPS); only the domain names are sent. DKIM keys sit under a name the mail service picks, so only common selectors are tried: “None found” does not mean the domain signs nothing.'));
}

// --- Crawl files ---

// What each file is for, and what is worth knowing about it once found.
const CRAWL_FILES = [
  ['robots', 'robots.txt', 'Tells crawlers what they may read.', (f) => [
    f.blocksSearch ? pillOf('Blocks Google or Bing', 'high') : f.blocksAll ? pillOf('Blocks unnamed crawlers', 'medium') : pillOf('Search engines allowed', 'done'),
    f.aiBlocked?.length ? `AI crawlers blocked: ${f.aiBlocked.join(', ')}` : 'No AI crawler blocked by name',
    f.sitemaps?.length ? `Points to ${f.sitemaps.length} sitemap${f.sitemaps.length === 1 ? '' : 's'}` : 'Names no sitemap',
  ]],
  ['sitemap', 'Sitemap', 'Lists the pages search engines should find.', (f) => [
    f.indexes ? `Index of ${f.indexes} sitemap${f.indexes === 1 ? '' : 's'}` : `${f.urls} page${f.urls === 1 ? '' : 's'}`,
    f.lastmod ? `Last changed ${f.lastmod}` : 'No change dates',
    h('a', { href: f.url, target: '_blank', rel: 'noopener', class: 'small' }, f.url),
  ]],
  ['llms', 'llms.txt', 'A short guide to the site for AI assistants.', (f) => [f.title ? `Titled “${f.title}”` : 'No title line']],
  ['security', 'security.txt', 'Says where to report a security problem.', (f) => [
    f.contact?.length ? `Contact: ${f.contact.join(', ')}` : 'No contact',
    !f.expires ? 'No expiry date' : daysUntil(f.expires) < 0 ? pillOf(`Expired on ${f.expires}`, 'high') : `Valid until ${f.expires}`,
  ]],
];

function crawlTab(store, sites) {
  const p = pickedSite(sites);
  if (!p) return crawlAll(store, sites);
  const c = siteData(store, p.id).crawl;
  const host = hostOf(p.website);
  const busy = view.busy.has(p.id) || view.busy.has('all');
  const read = h('button', { type: 'button', class: 'btn-small', disabled: busy, onclick: () => check(store, p, ['crawl']) }, icon('refresh'), busy ? 'Reading…' : c ? 'Read again' : 'Read the files');
  if (!c?.robots) {
    return h('div', { class: 'stack-lg' }, siteChips(store, sites, p),
      c?.error ? notice({ text: c.error }) : null,
      h('div', { class: 'card stack' }, h('p', { class: 'muted' }, `Read the files on ${host} that crawlers and AI assistants look for.`), h('div', null, read)));
  }
  const missing = CRAWL_FILES.filter(([k]) => !c[k].found && !c[k].unread).map(([, name]) => name);
  const present = CRAWL_FILES.filter(([k]) => c[k].found).length;
  return h('div', { class: 'stack-lg' }, siteChips(store, sites, p),
    c.robots.blocksSearch
      ? notice({ text: `robots.txt on ${host} blocks search engines from the whole site, so it drops out of search results.`, actions: [taskCell(store, p, 'crawl', `Let search engines crawl ${host}`)] })
      : null,
    h('section', { class: 'card stack' },
      h('div', { class: 'row between' }, h('h3', null, `Files found on ${host}`), read),
      h('div', { class: 'meter' }, h('span', { style: { width: `${(present / CRAWL_FILES.length) * 100}%` } })),
      h('p', { class: 'muted small' }, `${present} of ${CRAWL_FILES.length} files present · read ${timeOf(c.at)}${c.error ? ` · last try failed: ${c.error}` : ''}`),
      missing.length
        ? h('div', null, h('button', {
            type: 'button',
            class: 'btn-small',
            onclick: () => {
              store.update('todos', (d) => d.items.push(makeTask({ text: `Add the missing crawl files on ${host}`, description: `Missing: ${missing.join(', ')}`, projectId: p.id, priority: 'low' })));
              toast(`Task added to ${p.name}`);
            },
          }, 'Create a task for the missing files'))
        : null),
    h('div', { class: 'crawl-grid' }, CRAWL_FILES.map(([key, name, why, facts]) => {
      const f = c[key];
      return h('article', { class: 'card stack' },
        h('div', { class: 'row' }, h('span', { class: f.found ? 'tick ok' : 'tick miss' }, icon(f.found ? 'check' : 'x')), h('strong', null, name)),
        h('p', { class: 'muted small' }, why),
        f.found
          ? h('ul', { class: 'crawl-facts' }, facts(f).map((x) => h('li', null, x)))
          : h('p', { class: 'small' }, f.unread ? `Could not be read: ${f.unread}` : f.note ?? (f.status ? `Not found (the site answered ${f.status}).` : 'Not found.')),
        f.found ? h('details', null, h('summary', { class: 'muted small' }, 'Show the file'), h('pre', { class: 'readme' }, f.raw)) : null);
    })),
    h('p', { class: 'muted small' }, 'The files are read through r.jina.ai, the page reader also used for share tags; only their addresses are sent. Long files are shown in part.'));
}

// --- Metadata preview ---

// How a shared link looks on one network. The picture is the site's own og:image, loaded from the site.
function shareCard(kind, p, m) {
  const host = hostOf(p.website);
  const title = m.ogTitle || m.title || host;
  const text = m.ogDescription || m.description || '';
  const src = kind === 'x' ? m.twitterImage || m.ogImage : m.ogImage;
  const image = (cls = '') => (src ? h('img', { class: `share-img ${cls}`, src, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' }) : null);
  if (kind === 'x') {
    return m.twitterCard === 'summary_large_image' && src
      ? [h('div', { class: 'share x' }, image(), h('span', { class: 'share-over' }, title)), h('span', { class: 'muted small' }, `From ${host}`)]
      : h('div', { class: 'share x small' }, src ? image('thumb') : h('div', { class: 'share-img thumb none' }, icon('link')),
          h('div', { class: 'share-text' }, h('span', { class: 'muted small' }, host), h('strong', null, title), h('span', { class: 'muted small' }, text)));
  }
  if (kind === 'linkedin') return h('div', { class: 'share' }, image(), h('div', { class: 'share-text' }, h('strong', null, title), h('span', { class: 'muted small' }, host)));
  if (kind === 'slack') return h('div', { class: 'share slack' }, h('strong', { class: 'small' }, host), h('span', { class: 'share-link' }, title), h('span', { class: 'small' }, text), image());
  if (kind === 'discord') return h('div', { class: 'share discord', style: { '--c': p.color } }, h('span', { class: 'muted small' }, host), h('span', { class: 'share-link' }, title), h('span', { class: 'small' }, text), image());
  return h('div', { class: 'share imsg' }, image(), h('div', { class: 'share-text' }, h('strong', null, title), h('span', { class: 'muted small' }, host)));
}

// The tabs that show one site at a time pick it with a row of chips. "All" comes first and is the default:
// an empty `view.project` means every site, shown side by side in one table.
const pickedSite = (sites) => sites.find((x) => x.id === view.project) ?? null;
const siteChips = (store, sites, p) =>
  h('div', { class: 'chips' }, [{ id: '', name: 'All' }, ...sites].map((x) =>
    h('button', {
      type: 'button',
      class: x.id === (p?.id ?? '') ? 'chip active' : 'chip',
      onclick: () => {
        view.project = x.id;
        store.refresh();
      },
    }, x.name)));

// The site cell of an "All" table. Its name opens the site on its own.
const siteCell = (store, p) =>
  h('td', null, h('div', { class: 'row' }, projectIcon(p),
    h('div', null,
      h('button', { type: 'button', class: 'btn-link-inline', onclick: () => { view.project = p.id; store.refresh(); } }, h('strong', null, p.name)),
      h('div', { class: 'muted small' }, hostOf(p.website)))));

// Reads every page from the metadata "All" view, which has no "Check all now" in its header.
const readAll = (store, part, label) =>
  h('button', {
    type: 'button',
    class: 'btn-small primary',
    disabled: view.busy.has('all'),
    onclick: () => run(store, 'all', async () => {
      const made = await checkAllSites(store, [part]);
      toast(made ? `${made} task${made === 1 ? '' : 's'} created automatically` : 'All sites read');
    }),
  }, icon('refresh'), view.busy.has('all') ? 'Reading…' : label);

const againButton = (store, p, part, busy) =>
  h('button', { type: 'button', class: 'icon-btn', disabled: busy, title: 'Read again', 'aria-label': `Read ${hostOf(p.website)} again`, onclick: () => check(store, p, [part]) }, icon('refresh'));

const tick = (found, title) => h('span', { class: found ? 'tick ok' : 'tick miss', title }, icon(found ? 'check' : 'x'));

function crawlAll(store, sites) {
  return h('div', { class: 'stack-lg' }, siteChips(store, sites, null),
    h('div', { class: 'card mon-scroll' },
      h('table', { class: 'mon-table tool-table' },
        h('thead', null, h('tr', null, ['Site', ...CRAWL_FILES.map(([, name]) => name), 'Read', ''].map((t) => h('th', null, t)))),
        h('tbody', null, sites.map((p) => {
          const c = siteData(store, p.id).crawl;
          const busy = view.busy.has(p.id) || view.busy.has('all');
          const cells = c?.robots
            ? CRAWL_FILES.map(([k, name]) => h('td', null, c[k].unread ? h('span', { class: 'muted small' }, 'Unread') : tick(c[k].found, `${name} ${c[k].found ? 'found' : 'missing'}`),
                k === 'robots' && c.robots.blocksSearch ? pillOf('Blocks search', 'high') : null))
            : [h('td', { colspan: CRAWL_FILES.length }, h('span', { class: 'muted small' }, busy ? 'Reading…' : c?.error ?? 'Not read yet'))];
          return h('tr', null, siteCell(store, p), ...cells, h('td', { class: 'muted small' }, c?.at ? timeOf(c.at) : ''), h('td', null, againButton(store, p, 'crawl', busy)));
        })))));
}

function metaAll(store, sites) {
  const TAGS = ['title', 'description', 'ogTitle', 'ogDescription', 'ogImage', 'ogUrl', 'twitterCard', 'twitterImage'];
  return h('div', { class: 'stack-lg' }, siteChips(store, sites, null),
    h('div', { class: 'card mon-scroll' },
      h('table', { class: 'mon-table tool-table' },
        h('thead', null, h('tr', null, ['Site', 'Share tags', 'Title', 'og:image', 'Read', ''].map((t) => h('th', null, t)))),
        h('tbody', null, sites.map((p) => {
          const m = siteData(store, p.id).meta;
          const busy = view.busy.has(p.id) || view.busy.has('all');
          const again = h('td', null, againButton(store, p, 'meta', busy));
          if (!m || (m.error && !m.title && !m.ogTitle)) {
            return h('tr', null, siteCell(store, p), h('td', { colspan: 4 }, h('span', { class: 'muted small' }, busy ? 'Reading…' : m?.error ?? 'Not read yet')), again);
          }
          const present = TAGS.filter((k) => m[k]).length;
          return h('tr', null, siteCell(store, p),
            h('td', null, pillOf(`${present} of ${TAGS.length}`, present === TAGS.length ? 'done' : present >= TAGS.length / 2 ? 'medium' : 'high')),
            h('td', { class: 'cell-clip' }, m.ogTitle || m.title || h('span', { class: 'muted small' }, 'Missing')),
            h('td', null, tick(Boolean(m.ogImage), m.ogImage ? 'og:image found' : 'og:image missing')),
            h('td', { class: 'muted small' }, timeOf(m.at)),
            again);
        })))),
    h('div', null, readAll(store, 'meta', 'Read every page')));
}

function metaTab(store, sites) {
  const p = pickedSite(sites);
  if (!p) return metaAll(store, sites);
  const m = siteData(store, p.id).meta;
  const busy = view.busy.has(p.id);
  const chips = siteChips(store, sites, p);
  const read = h('button', { type: 'button', class: 'btn-small', disabled: busy, onclick: () => check(store, p, ['meta']) }, icon('refresh'), busy ? 'Reading…' : m ? 'Read again' : 'Read the page');
  if (!m || (m.error && !m.title && !m.ogTitle)) {
    return h('div', { class: 'stack-lg' }, chips,
      m?.error ? notice({ text: m.error }) : null,
      h('div', { class: 'card stack' }, h('p', { class: 'muted' }, `Read ${hostOf(p.website)} to see its share tags and how a link to it looks.`), h('div', null, read)));
  }
  const tags = [['<title>', m.title], ['meta description', m.description], ['og:title', m.ogTitle], ['og:description', m.ogDescription], ['og:image', m.ogImage], ['og:url', m.ogUrl], ['twitter:card', m.twitterCard], ['twitter:image', m.twitterImage]];
  const present = tags.filter(([, v]) => v).length;
  const missing = tags.filter(([, v]) => !v).map(([k]) => k);
  return h('div', { class: 'stack-lg' }, chips,
    h('div', { class: 'meta-grid' },
      h('section', { class: 'card stack' },
        h('div', { class: 'row between' }, h('h3', null, `Tags found on ${hostOf(p.website)}`), read),
        h('div', { class: 'meter' }, h('span', { style: { width: `${(present / tags.length) * 100}%` } })),
        h('p', { class: 'muted small' }, `${present} of ${tags.length} tags present · read ${timeOf(m.at)}`),
        h('ul', { class: 'tag-rows' }, tags.map(([k, v]) =>
          h('li', null,
            h('span', { class: v ? 'tick ok' : 'tick miss' }, icon(v ? 'check' : 'x')),
            h('code', null, k),
            h('span', { class: v ? 'grow' : 'grow muted' }, v || 'Missing')))),
        missing.length
          ? h('div', null, h('button', {
              type: 'button',
              class: 'btn-small',
              onclick: () => {
                store.update('todos', (d) => d.items.push(makeTask({ text: `Add the missing share tags on ${hostOf(p.website)}`, description: `Missing: ${missing.join(', ')}`, projectId: p.id, priority: 'low' })));
                toast(`Task added to ${p.name}`);
              },
            }, 'Create a task for the missing tags'))
          : null),
      h('section', { class: 'stack' },
        h('h3', null, 'How a shared link looks'),
        h('div', { class: 'shares' }, [['x', 'X'], ['linkedin', 'LinkedIn'], ['slack', 'Slack'], ['discord', 'Discord'], ['imessage', 'iMessage']].map(([k, label]) =>
          h('figure', null, h('figcaption', { class: 'muted small' }, label), shareCard(k, p, m)))))));
}

// --- Provider status ---

// Common services whose status page runs on Statuspage. Any other Statuspage address can be added by hand.
const PRESETS = [
  ['GitHub', 'https://www.githubstatus.com'],
  ['Vercel', 'https://www.vercel-status.com'],
  ['Cloudflare', 'https://www.cloudflarestatus.com'],
  ['Netlify', 'https://www.netlifystatus.com'],
  ['npm', 'https://status.npmjs.org'],
  ['Anthropic', 'https://status.anthropic.com'],
  ['OpenAI', 'https://status.openai.com'],
];
const INDICATOR = { none: ['Operational', 'done'], minor: ['Minor issue', 'medium'], maintenance: ['Maintenance', 'medium'], major: ['Major outage', 'high'], critical: ['Critical outage', 'high'] };
const COMPONENT = { degraded_performance: 'degraded', partial_outage: 'partial outage', major_outage: 'major outage', under_maintenance: 'maintenance' };

function follow(store, name, url) {
  const page = statusPageOf(url);
  if (!page) return toast('Enter the address of a status page, such as www.githubstatus.com.');
  if (store.get(COLLECTION).providers.some((pr) => pr.url === page)) return toast(`${name || page} is already followed.`);
  const id = uid();
  store.update(COLLECTION, (d) => {
    d.providers.push({ id, name: name.trim() || new URL(page).hostname, url: page });
  });
  run(store, id, () => checkProviders(store, [id]));
}

function unfollow(store, pr) {
  store.update(COLLECTION, (d) => {
    d.providers = d.providers.filter((x) => x.id !== pr.id);
    delete d.status[pr.id];
  });
  toast(`${pr.name} is no longer followed`);
}

function providerCard(store, pr) {
  const s = store.get(COLLECTION).status[pr.id];
  const busy = view.busy.has(pr.id) || view.busy.has('all');
  const [label, tone] = s?.indicator ? INDICATOR[s.indicator] ?? [s.indicator, 'medium'] : s?.error ? ['Unreadable', 'plain'] : ['Not read yet', 'plain'];
  return h('article', { class: `card site-card stack ${s?.indicator && s.indicator !== 'none' ? 'down' : ''}` },
    h('div', { class: 'row between' },
      h('div', null, h('strong', null, pr.name), h('div', null, h('a', { href: pr.url, target: '_blank', rel: 'noopener', class: 'small' }, new URL(pr.url).hostname))),
      busy ? pillOf('Reading…', 'plain') : pillOf(label, tone)),
    s?.description && s.indicator !== 'none' ? h('p', { class: 'small' }, s.description) : null,
    s?.incidents?.length
      ? h('ul', { class: 'crawl-facts' }, s.incidents.map((i) => h('li', null, h('a', { href: i.url, target: '_blank', rel: 'noopener' }, i.name), h('span', { class: 'muted small' }, ` · ${i.status}`))))
      : null,
    s?.components?.length
      ? h('details', null,
          h('summary', { class: 'muted small' }, `${s.components.length}${s.components.length >= 12 ? '+' : ''} part${s.components.length === 1 ? '' : 's'} affected`),
          h('ul', { class: 'crawl-facts' }, s.components.map((c) => h('li', null, c.name, h('span', { class: 'muted small' }, ` · ${COMPONENT[c.status] ?? c.status}`)))))
      : null,
    s?.error ? h('p', { class: 'muted small' }, `${s.indicator ? 'Last read failed' : 'Could not read'}: ${s.error}`) : null,
    h('div', { class: 'row between' },
      h('span', { class: 'muted small' }, `Read ${timeOf(s?.at)}`),
      h('div', { class: 'row' },
        h('button', { type: 'button', class: 'icon-btn', disabled: busy, title: 'Read again', 'aria-label': `Read ${pr.name} again`, onclick: () => run(store, pr.id, () => checkProviders(store, [pr.id])) }, icon('refresh')),
        h('button', { type: 'button', class: 'icon-btn', title: 'Stop following', 'aria-label': `Stop following ${pr.name}`, onclick: () => unfollow(store, pr) }, icon('x')))));
}

function statusTab(store) {
  const { providers, status } = store.get(COLLECTION);
  const followed = new Set(providers.map((pr) => pr.url));
  const presets = PRESETS.filter(([, url]) => !followed.has(url));
  const down = providers.filter((pr) => status[pr.id]?.indicator && status[pr.id].indicator !== 'none');
  // The fields are read on submit, so typing never re-renders the tab.
  const name = h('input', { type: 'text', placeholder: 'Name', 'aria-label': 'Provider name', autocomplete: 'off' });
  const url = h('input', { type: 'text', inputmode: 'url', placeholder: 'status.example.com', 'aria-label': 'Status page address', autocomplete: 'off' });
  return h('div', { class: 'stack-lg' },
    providers.length
      ? notice(down.length
          ? { tone: 'info', text: `${down.map((pr) => pr.name).join(', ')} ${down.length === 1 ? 'reports' : 'report'} a problem right now.` }
          : { tone: 'ok', text: 'Every followed service reports that it is working.' })
      : null,
    providers.length
      ? h('div', { class: 'site-grid' }, providers.map((pr) => providerCard(store, pr)))
      : h('div', { class: 'card' }, empty('Follow the services your projects rely on, and the bell tells you when one has an outage and when it is over.')),
    h('section', { class: 'card stack' },
      h('h3', null, 'Follow a service'),
      presets.length
        ? h('div', { class: 'chips' }, presets.map(([n, u]) => h('button', { type: 'button', class: 'chip', onclick: () => follow(store, n, u) }, icon('plus'), n)))
        : null,
      h('form', {
        class: 'follow-form',
        onsubmit: (e) => {
          e.preventDefault();
          follow(store, name.value, url.value);
        },
      }, name, url, h('button', { type: 'submit', class: 'btn-small primary' }, 'Follow'))),
    h('p', { class: 'muted small' }, 'Works with status pages hosted on Statuspage (most providers use it). The page’s public summary is read on the same interval as website health; nothing about you is sent.'));
}

function draw(root, store) {
  const sites = sitesOf(store);
  const without = store.get('projects').projects.filter((p) => !hostOf(p.website ?? ''));
  const all = view.busy.has('all');
  // Provider status follows outside services, so it works before any project has a website.
  const status = view.tab === 'status';
  const body = status ? statusTab(store) : !sites.length
    ? h('div', { class: 'card stack' }, empty('No project has a website yet. Add one on a project page and it appears here.'), h('div', null, h('a', { href: '#/projects', class: 'btn-link' }, 'Open Projects')))
    : view.tab === 'ssl' ? sslTab(store, sites) : view.tab === 'dns' ? dnsTab(store, sites) : view.tab === 'crawl' ? crawlTab(store, sites) : view.tab === 'meta' ? metaTab(store, sites) : healthTab(store, sites);

  root.replaceChildren(
    h('div', { class: 'stack-lg tools' },
      h('header', { class: 'row between' },
        h('div', null, h('h2', null, 'Tools'), h('p', { class: 'muted small' }, 'Checks that run against the website of each project, and the services they rely on, while the board is open.')),
        (sites.length || (status && store.get(COLLECTION).providers.length)) && view.tab !== 'meta'
          ? h('div', { class: 'row' },
              h('label', { class: 'inline' }, 'Check every',
                h('select', {
                  value: String(store.get(COLLECTION).every),
                  'aria-label': 'How often to check',
                  onchange: (e) => store.update(COLLECTION, (d) => {
                    d.every = Number(e.target.value);
                  }),
                }, EVERY.map(([v, label]) => h('option', { value: v }, label)))),
              h('button', {
                type: 'button',
                class: 'btn-small primary',
                disabled: all,
                onclick: () => run(store, 'all', async () => {
                  if (status) {
                    await checkProviders(store);
                    toast('All status pages read');
                    return;
                  }
                  const made = await checkAllSites(store, TAB_PARTS[view.tab] ?? ['health']);
                  toast(made ? `${made} task${made === 1 ? '' : 's'} created automatically` : 'All sites checked');
                }),
              }, icon('refresh'), all ? 'Checking…' : 'Check all now'))
          : null),
      h('nav', { class: 'sub-tabs', role: 'tablist', 'aria-label': 'Tools' },
        TABS.map(([key, label, iconName]) =>
          h('button', {
            type: 'button',
            role: 'tab',
            class: view.tab === key ? 'sub-tab active' : 'sub-tab',
            'aria-selected': String(view.tab === key),
            onclick: () => {
              view.tab = key;
              store.refresh();
            },
          }, icon(iconName), label))),
      body,
      sites.length && without.length && view.tab === 'health'
        ? h('p', { class: 'muted small' }, `Without a website, so not checked: ${without.map((p) => p.name).join(', ')}.`)
        : null));
}

export default {
  id: 'tools',
  title: 'Tools',
  icon: 'wrench',
  collection: COLLECTION,
  defaults: TOOLS_DEFAULTS,
  render: draw,
  serialize: () => ({ tab: view.tab === 'health' ? '' : view.tab, project: view.tab === 'meta' || view.tab === 'crawl' ? view.project : '' }),
  restore: (p = {}) => {
    view.tab = TABS.some(([k]) => k === p.tab) ? p.tab : 'health';
    view.project = p.project || '';
  },
};
