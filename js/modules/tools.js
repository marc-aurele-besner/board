// Tools: checks that run against the website of each project, and the status of the services they rely on.
import { h, icon, refreshIcon, empty, notice, uid } from '../ui.js';
import { projectIcon, projectTree } from './projects.js';
import { hostOf, daysUntil, statusPageOf } from '../sitecheck.js';
import { sitesOf, siteData, checkSite, checkAllSites, runRules, autoTaskFor, ruleOf, emailGaps, checkProviders, TOOLS_DEFAULTS } from '../automations.js';
import { makeTask } from '../capture.js';
import { toast } from '../toast.js';
import { openDialog } from '../modal.js';
import { barChart } from '../chart.js';

const COLLECTION = 'tools';
const TABS = [['health', 'Website health', 'globe'], ['ssl', 'SSL and domains', 'shield'], ['dns', 'DNS and email', 'mail'], ['crawl', 'Crawl files', 'file'], ['meta', 'Metadata preview', 'link'], ['status', 'Provider status', 'activity']];
// What "Check all now" looks up on each tab.
const TAB_PARTS = { health: ['health'], ssl: ['ssl', 'domain'], dns: ['dns'], crawl: ['crawl'] };
const EVERY = [[15, '15 minutes'], [60, 'hour'], [360, '6 hours'], [1440, 'day']];
const STATUS = { up: ['Up', 'done'], slow: ['Slow', 'medium'], down: ['Down', 'high'] };

// View state: the tab, the project shown in the metadata preview, and which sites are being checked now.
const view = { tab: 'health', project: '', busy: new Set(), openDns: new Set(), openFile: '', logLevel: '' };

const pillOf = (text, tone) => h('span', { class: `pill tone-${tone}` }, text);
const timeOf = (at) => (at ? new Date(at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'never');

// A check can finish in a few milliseconds; the busy state lasts long enough to be seen.
const MIN_BUSY_MS = 600;

function run(store, key, work) {
  view.busy.add(key);
  store.refresh();
  const shown = new Promise((resolve) => setTimeout(resolve, MIN_BUSY_MS));
  return Promise.all([work(), shown])
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
    ? h('a', { href: '#/todos?filter=auto', class: 'btn-small task-open', title: 'A task for this is open. Show it in Tasks.' }, icon('check-square'), 'Task open')
    : h('button', { type: 'button', class: 'btn-small', onclick: () => addTask(store, p, kind, text, due) }, 'Create task');
}

// A task for something a check found, filled in for the site's project and editable before it is added.
// `comment` adds a field for what to change, put at the top of the description.
function openTaskDialog(store, p, { text, description = '', priority = 'low', comment = '' }) {
  const projects = projectTree(store.get('projects').projects).map(({ project }) => project);
  const dialog = openDialog({
    title: 'Create a task',
    body: h('form', {
      class: 'stack',
      onsubmit: (e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        const title = String(f.get('text') ?? '').trim();
        if (!title) return;
        const projectId = f.get('project') || null;
        store.update('todos', (d) => d.items.push(makeTask({
          text: title,
          description: [f.get('comment'), f.get('description')].map((x) => String(x ?? '').trim()).filter(Boolean).join('\n\n'),
          projectId,
          priority: String(f.get('priority')),
          due: String(f.get('due') ?? ''),
        })));
        dialog.close();
        toast(`Task added to ${projects.find((x) => x.id === projectId)?.name ?? 'Personal'}`);
      },
    },
      h('label', null, 'Task', h('input', { name: 'text', value: text, required: true, autocomplete: 'off' })),
      comment ? h('label', null, 'What to change', h('textarea', { name: 'comment', rows: 3, placeholder: comment, autofocus: true })) : null,
      h('label', null, comment ? 'Found by the check' : 'Description', h('textarea', { name: 'description', rows: 3 }, description)),
      h('div', { class: 'row' },
        h('label', null, 'Project', h('select', { name: 'project' },
          h('option', { value: '' }, 'Personal'),
          projects.map((x) => h('option', { value: x.id, selected: x.id === p.id }, x.name)))),
        h('label', null, 'Priority', h('select', { name: 'priority' },
          [['none', 'No priority'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High']].map(([v, l]) => h('option', { value: v, selected: v === priority }, l)))),
        h('label', null, 'Due', h('input', { name: 'due', type: 'date' }))),
      h('div', { class: 'row end' }, h('button', { class: 'primary', type: 'submit' }, 'Create task'))),
  });
}

// A check or a cross. A cross that is given a task opens the task dialog for it.
const tick = (found, title, task) =>
  !found && task
    ? h('button', { type: 'button', class: 'tick miss', title: `${title} · create a task`, 'aria-label': `${title}: create a task`, onclick: task }, icon('x'))
    : h('span', { class: found ? 'tick ok' : 'tick miss', title }, icon(found ? 'check' : 'x'));

function daysPill(until) {
  const n = daysUntil(until);
  return pillOf(n < 0 ? 'Expired' : `${n} day${n === 1 ? '' : 's'} left`, n <= 14 ? 'high' : n <= 30 ? 'medium' : 'done');
}

// --- Website health ---

const openSite = (store, p) => () => {
  view.project = p.id;
  store.refresh();
};
const goTab = (store, p, tab) => () => {
  view.tab = tab;
  view.project = p.id;
  store.refresh();
};

const LEVEL = { error: ['Error', 'high'], warn: ['Warning', 'medium'], info: ['Info', 'done'] };
const SOURCE = { health: 'Health', ssl: 'SSL', domain: 'Domain', dns: 'DNS', crawl: 'Crawl files', meta: 'Metadata' };

// The site's log, newest first. Checks made before the log existed are filled in from the uptime history.
function logOf(s) {
  const log = s.log ?? [];
  const since = log[0]?.at ?? '9999';
  const older = (s.history ?? []).filter((c) => c.at < since && (!c.ok || c.ms > 1500))
    .map((c) => ({ at: c.at, level: c.ok ? 'warn' : 'error', source: 'health', text: c.ok ? `Slow answer: ${c.ms} ms.` : 'Did not answer.' }));
  return [...older, ...log].reverse();
}

function siteDetail(store, sites, p) {
  const s = siteData(store, p.id);
  const host = hostOf(p.website);
  const busy = view.busy.has(p.id) || view.busy.has('all');
  const [label, tone] = STATUS[s.health?.status] ?? ['Not checked', 'plain'];
  const history = s.history ?? [];
  const ok = history.filter((c) => c.ok);
  const up = history.length ? Math.round((ok.length / history.length) * 1000) / 10 : null;
  const times = ok.map((c) => c.ms).sort((a, b) => a - b);
  const avg = times.length ? Math.round(times.reduce((a, b) => a + b, 0) / times.length) : null;
  const p95 = times.length ? times[Math.min(times.length - 1, Math.floor(times.length * 0.95))] : null;
  const lastDown = [...history].reverse().find((c) => !c.ok);
  const stat = (value, text) => h('div', null, h('strong', null, value ?? '—'), h('span', { class: 'muted small' }, text));
  const all = logOf(s);
  const shown = view.logLevel ? all.filter((e) => e.level === view.logLevel) : all;
  const count = (level) => all.filter((e) => e.level === level).length;
  const gaps = emailGaps(s.dns);
  const crawlCore = s.crawl?.robots ? CORE.filter(([k]) => crawlFile(s.crawl, k).found).length : null;
  const metaCount = s.meta && !s.meta.error ? ['title', 'description', 'ogTitle', 'ogDescription', 'ogImage', 'ogUrl', 'twitterCard', 'twitterImage'].filter((k) => s.meta[k]).length : null;
  // One line per other check, each opening its tab on this site.
  const checks = [
    ['ssl', 'SSL certificate', s.ssl?.until ? daysPill(s.ssl.until) : null, s.ssl?.until ? `until ${s.ssl.until}${s.ssl.issuer ? ` · ${s.ssl.issuer}` : ''}` : s.ssl?.error ?? 'Not checked yet'],
    ['ssl', 'Domain', s.domain?.until ? daysPill(s.domain.until) : null, s.domain?.until ? `${s.domain.name} · renews by ${s.domain.until}` : s.domain?.error ?? 'Not checked yet'],
    ['dns', 'Email records', s.dns?.domain ? pillOf(gaps.length ? `No ${gaps.join(' or ')}` : 'In place', gaps.length ? 'high' : 'done') : null, s.dns?.domain ? `${s.dns.records?.length ?? '—'} DNS records · looked up ${timeOf(s.dns.at)}` : s.dns?.error ?? 'Not looked up yet'],
    ['crawl', 'Crawl files', crawlCore === null ? null : pillOf(`${crawlCore} of ${CORE.length} key files`, crawlCore === CORE.length ? 'done' : 'medium'), s.crawl?.robots?.blocksSearch ? 'robots.txt blocks search engines' : s.crawl?.at ? `read ${timeOf(s.crawl.at)}` : 'Not read yet'],
    ['meta', 'Share tags', metaCount === null ? null : pillOf(`${metaCount} of 8 tags`, metaCount === 8 ? 'done' : 'medium'), s.meta?.at ? `read ${timeOf(s.meta.at)}` : 'Not read yet'],
  ];
  return h('div', { class: 'stack-lg' }, siteChips(store, sites, p),
    h('section', { class: `card stack site-detail ${s.health?.status ?? ''}` },
      h('div', { class: 'row between' },
        h('div', { class: 'row' },
          projectIcon(p, 'project-icon large'),
          h('div', null, h('h3', null, p.name), h('a', { href: p.website, target: '_blank', rel: 'noopener', class: 'small' }, host))),
        h('div', { class: 'row' },
          busy ? pillOf('Checking…', 'plain') : pillOf(label, tone),
          s.health?.status === 'down' || s.health?.status === 'slow' ? taskCell(store, p, 'health', `Look into ${host}: ${s.health.status === 'down' ? 'not answering' : 'slow'}`) : null,
          h('button', { type: 'button', class: 'btn-small primary', disabled: busy, onclick: () => check(store, p, ['health', 'ssl', 'domain', 'dns']) }, refreshIcon(busy), busy ? 'Checking…' : 'Check everything'))),
      h('div', { class: 'stats detail-stats' },
        stat(up === null ? null : `${up}%`, `up, over ${history.length} check${history.length === 1 ? '' : 's'}`),
        stat(s.health?.ms ? `${s.health.ms} ms` : null, 'last answer'),
        stat(avg === null ? null : `${avg} ms`, 'average'),
        stat(p95 === null ? null : `${p95} ms`, '95% answered within'),
        stat(lastDown ? timeOf(lastDown.at) : 'Never', 'last failed check')),
      history.length
        ? barChart(history.map((c) => new Date(c.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })), [
            { name: 'Answered', color: 'var(--income)', values: history.map((c) => (c.ok && c.ms <= 1500 ? c.ms : 0)) },
            { name: 'Slow', color: 'var(--warn)', values: history.map((c) => (c.ok && c.ms > 1500 ? c.ms : 0)) },
          ], { format: (v) => `${v} ms`, tip: (i) => [h('span', { class: 'muted' }, timeOf(history[i].at)), h('strong', null, history[i].ok ? `${history[i].ms} ms${history[i].ms > 1500 ? ' · slow' : ''}` : 'No answer')] })
        : h('p', { class: 'muted small' }, 'No checks yet. Check now to start the history.'),
      h('p', { class: 'muted small' }, `Response time of the last ${history.length} checks, oldest first. Gaps are checks that got no answer.`)),
    h('section', { class: 'card stack' },
      h('h3', null, 'Other checks'),
      h('ul', { class: 'detail-checks' }, checks.map(([tab, name, pill, text]) =>
        h('li', null,
          h('button', { type: 'button', class: 'btn-link-inline', onclick: goTab(store, p, tab) }, name),
          pill ?? h('span', { class: 'pill tone-plain' }, '—'),
          h('span', { class: 'muted small grow' }, text))))),
    h('section', { class: 'card stack' },
      h('div', { class: 'row between' },
        h('h3', null, 'Log'),
        h('div', { class: 'chips' }, [['', `All ${all.length}`], ['error', `Errors ${count('error')}`], ['warn', `Warnings ${count('warn')}`], ['info', `Info ${count('info')}`]].map(([lvl, text]) =>
          h('button', { type: 'button', class: view.logLevel === lvl ? 'chip active' : 'chip', onclick: () => { view.logLevel = lvl; store.refresh(); } }, text)))),
      shown.length
        ? h('div', { class: 'mon-scroll log-scroll' },
            h('table', { class: 'mon-table log-table' },
              h('thead', null, h('tr', null, ['When', 'Level', 'Check', 'What happened'].map((t) => h('th', null, t)))),
              h('tbody', null, shown.slice(0, 200).map((e) =>
                h('tr', { class: `lvl-${e.level}` },
                  h('td', { class: 'muted small nowrap' }, timeOf(e.at)),
                  h('td', null, pillOf(...LEVEL[e.level] ?? [e.level, 'plain'])),
                  h('td', { class: 'small' }, SOURCE[e.source] ?? e.source),
                  h('td', null, e.text))))))
        : h('p', { class: 'muted small' }, all.length ? 'Nothing at this level.' : 'Nothing went wrong in the checks kept so far.'),
      s.log?.length
        ? h('div', null, h('button', {
            type: 'button',
            class: 'btn-small',
            onclick: () => store.update(COLLECTION, (d) => {
              d.sites[p.id].log = [];
            }),
          }, 'Clear the log'))
        : null));
}

function healthTab(store, sites) {
  const picked = pickedSite(sites);
  if (picked) return siteDetail(store, sites, picked);
  const data = sites.map((p) => [p, siteData(store, p.id)]);
  const countOf = (status) => data.filter(([, s]) => s.health?.status === status).length;
  const stat = (n, label) => h('div', { class: 'card stat' }, h('strong', null, String(n)), h('span', { class: 'muted small' }, label));
  return h('div', { class: 'stack-lg' },
    siteChips(store, sites, null),
    h('div', { class: 'summary tool-stats' }, stat(countOf('up'), 'up'), stat(countOf('slow'), 'slow'), stat(countOf('down'), 'down'), stat(sites.length, 'sites')),
    h('div', { class: 'site-grid' }, data.map(([p, s]) => {
      const host = hostOf(p.website);
      const busy = view.busy.has(p.id) || view.busy.has('all');
      const [label, tone] = STATUS[s.health?.status] ?? ['Not checked', 'plain'];
      const history = s.history ?? [];
      const up = history.length ? Math.round((history.filter((c) => c.ok).length / history.length) * 1000) / 10 : null;
      const issues = logOf(s).filter((e) => e.level !== 'info' && Date.now() - Date.parse(e.at) < 86400000).length;
      return h('article', { class: `card site-card ${s.health?.status ?? ''}` },
        h('div', { class: 'row between' },
          h('div', { class: 'row' },
            projectIcon(p, 'project-icon large'),
            h('div', null,
              h('button', { type: 'button', class: 'site-name', title: 'Show details and the log', onclick: openSite(store, p) }, p.name),
              h('div', null, h('a', { href: p.website, target: '_blank', rel: 'noopener', class: 'small' }, host)))),
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
            h('button', { type: 'button', class: 'btn-small', onclick: openSite(store, p) },
              'Details', issues ? h('span', { class: 'pill tone-medium', title: 'Warnings and errors in the last 24 hours' }, String(issues)) : null),
            h('button', { type: 'button', class: 'btn-small', disabled: busy, onclick: () => check(store, p, ['health']) }, refreshIcon(busy), 'Check now'),
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
            h('td', null, h('button', { type: 'button', class: 'icon-btn', disabled: busy, title: 'Look up again', 'aria-label': `Look up ${host} again`, onclick: () => check(store, p, ['ssl', 'domain']) }, refreshIcon(busy))));
        })))),
    h('p', { class: 'muted small' }, 'The certificate date comes from the public certificate logs (Cert Spotter, then crt.sh): the newest certificate issued for the host. The domain date comes from its registry (RDAP). Only the site’s address is sent to them.'));
}

// --- DNS and email ---

// SPF ends with how strictly mail from other servers is treated; "+all" lets anyone send as the domain.
const SPF_ALL = { '-all': ['Strict', 'done'], '~all': ['Soft fail', 'done'], '?all': ['Neutral', 'medium'], '+all': ['Anyone may send', 'high'], all: ['Anyone may send', 'high'] };
const DMARC_POLICY = { reject: ['Reject', 'done'], quarantine: ['Quarantine', 'done'], none: ['Monitor only', 'medium'] };

const ttlOf = (s) => (s >= 86400 && s % 86400 === 0 ? `${s / 86400} d` : s >= 3600 && s % 3600 === 0 ? `${s / 3600} h` : s >= 60 && s % 60 === 0 ? `${s / 60} min` : `${s} s`);
// "@" for the domain itself and "www" for www.example.com, as DNS dashboards show them.
const relName = (name, domain) => (name === domain ? '@' : name.endsWith(`.${domain}`) ? name.slice(0, -domain.length - 1) : name);

// Every record the lookup found, one row each, with a count per type above.
function recordTable(d) {
  const counts = d.records.reduce((m, r) => m.set(r.type, (m.get(r.type) ?? 0) + 1), new Map());
  return h('div', { class: 'stack dns-all' },
    h('div', { class: 'chips' }, [...counts].map(([type, n]) => h('span', { class: 'pill tone-plain' }, `${n} ${type}`))),
    d.records.length
      ? h('div', { class: 'mon-scroll' },
          h('table', { class: 'mon-table dns-table' },
            h('thead', null, h('tr', null, ['Name', 'Type', 'TTL', 'Value'].map((t) => h('th', null, t)))),
            h('tbody', null, d.records.map((r) =>
              h('tr', null,
                h('td', { title: r.name }, h('code', null, relName(r.name, d.domain))),
                h('td', null, h('span', { class: `dns-type t-${r.type.toLowerCase()}` }, r.type)),
                h('td', { class: 'num muted small' }, ttlOf(r.ttl)),
                h('td', { class: 'dns-value' }, h('code', null, r.data)))))))
      : h('p', { class: 'muted small' }, 'No records found.'),
    h('p', { class: 'muted small' }, `DNS cannot list every name under a domain, so this asks for ${d.domain}, the site’s host, www, _dmarc, MTA-STS, TLS reporting, BIMI and common DKIM selectors. Records on other names are not shown.`));
}

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
          const again = h('td', null, h('button', { type: 'button', class: 'icon-btn', disabled: busy, title: 'Look up again', 'aria-label': `Look up ${host} again`, onclick: () => check(store, p, ['dns']) }, refreshIcon(busy)));
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
                h('details', { open: view.openDns.has(p.id), ontoggle: (e) => (e.currentTarget.open ? view.openDns.add(p.id) : view.openDns.delete(p.id)) },
                  h('summary', { class: 'small' },
                    h('strong', null, d.records ? `All ${d.records.length} records` : 'Records'),
                    h('span', { class: 'muted' }, ` for ${d.domain} · looked up ${timeOf(d.at)}${d.error ? ` · last try failed: ${d.error}` : ''}`)),
                  d.records
                    ? recordTable(d)
                    : [h('p', { class: 'muted small' }, 'Look up again to see every record, with CNAME and TXT.'),
                        h('dl', { class: 'dns-records' }, records.flatMap(([k, v]) => [h('dt', null, k), h('dd', null, v.filter(Boolean).length ? v.filter(Boolean).map((x) => h('code', null, x)) : h('span', { class: 'muted small' }, 'None'))]))]))),
          ];
        })))),
    h('p', { class: 'muted small' }, 'Records come from Cloudflare’s public DNS resolver (DNS over HTTPS); only the domain names are sent. DKIM keys sit under a name the mail service picks, so only common selectors are tried: “None found” does not mean the domain signs nothing.'));
}

// --- Crawl files ---

// What a task for a missing file says.
const crawlTask = (store, p, name, why) => () =>
  openTaskDialog(store, p, { text: `Add ${name === 'Sitemap' ? 'a sitemap' : name} to ${hostOf(p.website)}`, description: why });

const kb = (n) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} bytes`);

// [key, name, short name for the table, what it is for, needed by most sites, what is worth knowing about it once found].
const CRAWL_FILES = [
  ['robots', 'robots.txt', 'robots', 'Tells crawlers what they may read.', true, (f) => [
    f.blocksSearch ? pillOf('Blocks Google or Bing', 'high') : f.blocksAll ? pillOf('Blocks unnamed crawlers', 'medium') : pillOf('Search engines allowed', 'done'),
    f.aiBlocked?.length ? `AI crawlers blocked: ${f.aiBlocked.join(', ')}` : 'No AI crawler blocked by name',
    f.sitemaps?.length ? `Points to ${f.sitemaps.length} sitemap${f.sitemaps.length === 1 ? '' : 's'}` : 'Names no sitemap',
  ]],
  ['sitemap', 'Sitemap', 'sitemap', 'Lists the pages search engines should find.', true, (f) => [
    f.indexes ? `Index of ${f.indexes} sitemap${f.indexes === 1 ? '' : 's'}` : `${f.urls} page${f.urls === 1 ? '' : 's'}`,
    f.lastmod ? `Last changed ${f.lastmod}` : 'No change dates',
  ]],
  ['llms', 'llms.txt', 'llms', 'A short guide to the site for AI assistants.', true, (f) => [f.title ? `Titled “${f.title}”` : 'No title line']],
  ['llmsFull', 'llms-full.txt', 'llms-full', 'The whole documentation in one file, for AI assistants.', false, (f) => [kb(f.size ?? 0)]],
  ['security', 'security.txt', 'security', 'Says where to report a security problem.', true, (f) => [
    f.contact?.length ? `Contact: ${f.contact.join(', ')}` : 'No contact',
    !f.expires ? 'No expiry date' : daysUntil(f.expires) < 0 ? pillOf(`Expired on ${f.expires}`, 'high') : `Valid until ${f.expires}`,
  ]],
  ['humans', 'humans.txt', 'humans', 'Credits the people behind the site.', false, null],
  ['ads', 'ads.txt', 'ads', 'Lists who may sell ads on the site. Only needed with ads.', false, null],
  ['manifest', 'Web app manifest', 'manifest', 'Lets the site be installed as an app, with its name and icons.', false, null],
  ['aasa', 'Apple app site association', 'apple', 'Opens links in the site’s iOS app.', false, null],
  ['assetlinks', 'Android asset links', 'android', 'Opens links in the site’s Android app.', false, null],
];
const CORE = CRAWL_FILES.filter((x) => x[4]);
const fileOf = (key) => CRAWL_FILES.find(([k]) => k === key);
// Files saved before a kind was added have no entry; they read as unread until the next read.
const crawlFile = (c, key) => c?.[key] ?? { found: false, unread: 'Read again to check this file.' };
const issuesOf = (f) => (f.checks ?? []).filter(([level]) => level !== 'ok');

function checksPill(f) {
  if (!f.checks) return null;
  const errors = f.checks.filter(([l]) => l === 'error').length;
  const warns = f.checks.filter(([l]) => l === 'warn').length;
  return errors ? pillOf(`${errors} error${errors === 1 ? '' : 's'}`, 'high') : warns ? pillOf(`${warns} warning${warns === 1 ? '' : 's'}`, 'medium') : pillOf('Looks right', 'done');
}

// A found file is green, or amber when its format check found an error. A missing optional file is an empty circle.
function fileTick(store, p, key, f, onOpen) {
  const [, name, , why, core] = fileOf(key);
  if (f.unread) return h('span', { class: 'tick todo', title: `${name}: ${f.unread}` }, icon('clock'));
  if (f.found) {
    const bad = (f.checks ?? []).some(([l]) => l === 'error');
    return h('button', { type: 'button', class: `tick ${bad ? 'warn' : 'ok'}`, title: `${name} found${bad ? ', with errors' : ''} · show the file`, 'aria-label': `Show ${name}`, onclick: onOpen }, icon(bad ? 'alert' : 'check'));
  }
  return core ? tick(false, `${name} missing`, crawlTask(store, p, name, why)) : h('button', { type: 'button', class: 'tick todo', title: `${name} not found (optional) · create a task`, 'aria-label': `${name}: create a task`, onclick: crawlTask(store, p, name, why) });
}

// The file itself, with what its format check found. Shown under the row it belongs to.
function filePreview(store, p, key, f) {
  const [, name, , why] = fileOf(key);
  const host = hostOf(p.website);
  if (!f.found) {
    return h('div', { class: 'file-preview stack' },
      h('p', { class: 'small' }, f.unread ? `Could not be read: ${f.unread}` : f.note ?? (f.status ? `Not found: ${f.url} answered ${f.status}.` : 'Not found.')),
      h('p', { class: 'muted small' }, why),
      f.unread ? null : h('div', null, h('button', { type: 'button', class: 'btn-small', onclick: crawlTask(store, p, name, why) }, icon('plus'), 'Create a task to add it')));
  }
  const issues = issuesOf(f);
  const cut = f.size && f.raw && f.size > f.raw.length;
  return h('div', { class: 'file-preview stack' },
    h('div', { class: 'row between' },
      h('a', { href: f.url, target: '_blank', rel: 'noopener', class: 'small file-url' }, f.url),
      h('span', { class: 'muted small' }, [f.size ? kb(f.size) : '', cut ? `first ${f.raw.length.toLocaleString()} characters shown` : ''].filter(Boolean).join(' · '))),
    f.checks
      ? h('ul', { class: 'file-checks' }, f.checks.map(([level, text]) => h('li', { class: `lvl-${level}` }, icon(level === 'ok' ? 'check' : level === 'warn' ? 'alert' : 'x'), h('span', null, text))))
      : h('p', { class: 'muted small' }, 'Read again to check its format.'),
    issues.length
      ? h('div', null, h('button', {
          type: 'button',
          class: 'btn-small',
          onclick: () => openTaskDialog(store, p, { text: `Fix ${name} on ${host}`, description: `The format check of ${f.url} found:\n${issues.map(([, t]) => `- ${t}`).join('\n')}`, priority: issues.some(([l]) => l === 'error') ? 'medium' : 'low' }),
        }, icon('plus'), `Create a task for ${issues.length === 1 ? 'this issue' : `these ${issues.length} issues`}`))
      : null,
    h('pre', { class: 'file-raw' }, (f.raw ?? '').split('\n').map((line) => h('span', { class: 'line' }, `${line}\n`))));
}

const toggleFile = (store, ref) => () => {
  view.openFile = view.openFile === ref ? '' : ref;
  store.refresh();
};

function crawlTab(store, sites) {
  const p = pickedSite(sites);
  if (!p) return crawlAll(store, sites);
  const c = siteData(store, p.id).crawl;
  const host = hostOf(p.website);
  const busy = view.busy.has(p.id) || view.busy.has('all');
  const read = h('button', { type: 'button', class: 'btn-small', disabled: busy, onclick: () => check(store, p, ['crawl']) }, refreshIcon(busy), busy ? 'Reading…' : c ? 'Read again' : 'Read the files');
  if (!c?.robots) {
    return h('div', { class: 'stack-lg' }, siteChips(store, sites, p),
      c?.error ? notice({ text: c.error }) : null,
      h('div', { class: 'card stack' }, h('p', { class: 'muted' }, `Read the files on ${host} that crawlers, AI assistants and app stores look for.`), h('div', null, read)));
  }
  const missing = CORE.filter(([k]) => !crawlFile(c, k).found && !crawlFile(c, k).unread).map(([, name]) => name);
  const present = CORE.filter(([k]) => crawlFile(c, k).found).length;
  const extras = CRAWL_FILES.filter(([k, , , , core]) => !core && crawlFile(c, k).found).length;
  return h('div', { class: 'stack-lg' }, siteChips(store, sites, p),
    c.robots.blocksSearch
      ? notice({ text: `robots.txt on ${host} blocks search engines from the whole site, so it drops out of search results.`, actions: [taskCell(store, p, 'crawl', `Let search engines crawl ${host}`)] })
      : null,
    h('section', { class: 'card stack' },
      h('div', { class: 'row between' }, h('h3', null, `Files found on ${host}`), read),
      h('div', { class: 'meter' }, h('span', { style: { width: `${(present / CORE.length) * 100}%` } })),
      h('p', { class: 'muted small' }, `${present} of ${CORE.length} key files present, ${extras} of ${CRAWL_FILES.length - CORE.length} optional ones · read ${timeOf(c.at)}${c.error ? ` · last try failed: ${c.error}` : ''}`),
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
    h('div', { class: 'card file-list' }, CRAWL_FILES.map(([key, name, , why, core, facts]) => {
      const f = crawlFile(c, key);
      const open = view.openFile === key;
      const summary = f.found ? (facts ? facts(f) : [(f.checks ?? []).find(([l]) => l === 'ok')?.[1] ?? 'Found']) : [f.unread ? 'Unread' : core ? 'Missing' : 'Not found (optional)'];
      return h('div', { class: open ? 'file-item open' : 'file-item' },
        h('div', { class: 'file-row' },
          fileTick(store, p, key, f, toggleFile(store, key)),
          h('button', { type: 'button', class: 'file-name', 'aria-expanded': String(open), onclick: toggleFile(store, key) },
            h('strong', null, name),
            h('span', { class: 'muted small' }, why)),
          h('div', { class: 'file-facts small' }, summary.map((x) => h('span', null, x))),
          f.found ? checksPill(f) : h('span'),
          h('button', { type: 'button', class: 'icon-btn file-chevron', 'aria-label': `${open ? 'Hide' : 'Show'} ${name}`, onclick: toggleFile(store, key) }, icon('chevron'))),
        open ? filePreview(store, p, key, f) : null);
    })),
    h('p', { class: 'muted small' }, 'The files are read through r.jina.ai, the page reader also used for share tags; only their addresses are sent. Long files are shown in part, but checked in full.'));
}

// The "All" table. A file's tick opens it under its site's row.
function crawlAll(store, sites) {
  const cols = CRAWL_FILES.length + 3;
  return h('div', { class: 'stack-lg' }, siteChips(store, sites, null),
    h('div', { class: 'card mon-scroll' },
      h('table', { class: 'mon-table tool-table crawl-table' },
        h('thead', null, h('tr', null, ['Site', ...CRAWL_FILES.map(([, name, short]) => h('span', { title: name }, short)), 'Read', ''].map((t) => h('th', null, t)))),
        h('tbody', null, sites.flatMap((p) => {
          const c = siteData(store, p.id).crawl;
          const busy = view.busy.has(p.id) || view.busy.has('all');
          const cells = c?.robots
            ? CRAWL_FILES.map(([k]) => {
                const ref = `${p.id}:${k}`;
                return h('td', { class: view.openFile === ref ? 'picked' : '' }, fileTick(store, p, k, crawlFile(c, k), toggleFile(store, ref)),
                  k === 'robots' && c.robots.blocksSearch ? pillOf('Blocks search', 'high') : null);
              })
            : [h('td', { colspan: CRAWL_FILES.length }, h('span', { class: 'muted small' }, busy ? 'Reading…' : c?.error ?? 'Not read yet'))];
          const openKey = c?.robots && view.openFile.startsWith(`${p.id}:`) ? view.openFile.slice(p.id.length + 1) : '';
          return [
            h('tr', { class: openKey ? 'has-preview' : '' }, siteCell(store, p), ...cells, h('td', { class: 'muted small' }, c?.at ? timeOf(c.at) : ''), h('td', null, againButton(store, p, 'crawl', busy))),
            openKey && fileOf(openKey)
              ? h('tr', { class: 'preview-row' }, h('td', { colspan: cols },
                  h('div', { class: 'row between' }, h('strong', null, `${fileOf(openKey)[1]} on ${hostOf(p.website)}`),
                    h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Close the preview', onclick: toggleFile(store, view.openFile) }, icon('x'))),
                  filePreview(store, p, openKey, crawlFile(c, openKey))))
              : null,
          ].filter(Boolean);
        })))),
    h('p', { class: 'muted small' }, 'Click a file’s mark to open it under its site. Hollow circles are optional files the site does not have.'));
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
  }, refreshIcon(view.busy.has('all')), view.busy.has('all') ? 'Reading…' : label);

const againButton = (store, p, part, busy) =>
  h('button', { type: 'button', class: 'icon-btn', disabled: busy, title: 'Read again', 'aria-label': `Read ${hostOf(p.website)} again`, onclick: () => check(store, p, [part]) }, refreshIcon(busy));

// What is off with a tag that is there: a length search results or previews cut, an address that is not full.
function tagHint(tag, v) {
  if (!v) return '';
  const len = v.length;
  const long = (max, where) => (len > max ? `${len} characters; ${where} show about ${max}.` : '');
  if (tag === '<title>') return len < 15 ? `Only ${len} characters; a title of 30 to 60 says more.` : long(60, 'search results');
  if (tag === 'meta description') return len < 50 ? `Only ${len} characters; 70 to 160 reads better in search results.` : long(160, 'search results');
  if (tag === 'og:title') return long(90, 'most networks');
  if (tag === 'og:description') return len < 30 ? `Only ${len} characters.` : long(200, 'most networks');
  if (tag === 'og:image' || tag === 'twitter:image') return /^https:\/\//i.test(v) ? '' : 'Not served over https, so some networks skip it.';
  if (tag === 'og:url') return /^https?:\/\//i.test(v) ? '' : 'Should be a full address with https://.';
  if (tag === 'twitter:card') return ['summary', 'summary_large_image', 'app', 'player'].includes(v) ? '' : `“${v}” is not a card type X knows.`;
  return '';
}

// A task about one tag: add it when missing, fix it when the hint found something, or improve it otherwise.
const metaTask = (store, p, tag, value = '') => () => {
  const host = hostOf(p.website);
  const hint = tagHint(tag, value);
  const image = /image/.test(tag);
  openTaskDialog(store, p, {
    text: !value ? `Add ${tag} to ${host}` : hint ? `Fix ${tag} on ${host}` : `Improve ${tag} on ${host}`,
    description: [!value ? 'A share tag the metadata preview found missing.' : `Now: ${value}`, hint].filter(Boolean).join('\n'),
    comment: image ? 'For example: use a brighter banner with the logo and a short tagline' : 'For example: make it shorter and name what the site does',
    priority: !value || hint ? 'medium' : 'low',
  });
};

// A task about the whole preview on one network, with a comment on what to change.
const previewTask = (store, p, label, m) => () =>
  openTaskDialog(store, p, {
    text: `Improve how ${hostOf(p.website)} looks when shared on ${label}`,
    description: [`Title: ${m.ogTitle || m.title || 'none'}`, `Description: ${m.ogDescription || m.description || 'none'}`, `Image: ${m.ogImage || 'none'}`].join('\n'),
    comment: 'For example: the banner is cropped, the text is too long',
  });

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
            h('td', null, tick(Boolean(m.ogImage), m.ogImage ? 'og:image found' : 'og:image missing', metaTask(store, p, 'og:image'))),
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
  const read = h('button', { type: 'button', class: 'btn-small', disabled: busy, onclick: () => check(store, p, ['meta']) }, refreshIcon(busy), busy ? 'Reading…' : m ? 'Read again' : 'Read the page');
  if (!m || (m.error && !m.title && !m.ogTitle)) {
    return h('div', { class: 'stack-lg' }, chips,
      m?.error ? notice({ text: m.error }) : null,
      h('div', { class: 'card stack' }, h('p', { class: 'muted' }, `Read ${hostOf(p.website)} to see its share tags and how a link to it looks.`), h('div', null, read)));
  }
  const tags = [['<title>', m.title], ['meta description', m.description], ['og:title', m.ogTitle], ['og:description', m.ogDescription], ['og:image', m.ogImage], ['og:url', m.ogUrl], ['twitter:card', m.twitterCard], ['twitter:image', m.twitterImage]];
  const present = tags.filter(([, v]) => v).length;
  const missing = tags.filter(([, v]) => !v).map(([k]) => k);
  const weak = tags.filter(([k, v]) => tagHint(k, v)).map(([k, v]) => `${k}: ${tagHint(k, v)}`);
  return h('div', { class: 'stack-lg' }, chips,
    h('div', { class: 'meta-grid' },
      h('section', { class: 'card stack' },
        h('div', { class: 'row between' }, h('h3', null, `Tags found on ${hostOf(p.website)}`), read),
        h('div', { class: 'meter' }, h('span', { style: { width: `${(present / tags.length) * 100}%` } })),
        h('p', { class: 'muted small' }, `${present} of ${tags.length} tags present · read ${timeOf(m.at)}`),
        h('ul', { class: 'tag-rows' }, tags.map(([k, v]) => {
          const hint = tagHint(k, v);
          return h('li', null,
            v && hint ? h('span', { class: 'tick warn', title: `${k}: ${hint}` }, icon('alert')) : tick(Boolean(v), `${k} ${v ? 'found' : 'missing'}`, metaTask(store, p, k)),
            h('code', null, k),
            h('div', { class: 'grow tag-value' },
              /image/.test(k) && v ? h('img', { class: 'tag-thumb', src: v, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' }) : null,
              h('span', { class: v ? '' : 'muted' }, v || 'Missing'),
              hint ? h('span', { class: 'tag-hint small' }, hint) : null),
            h('button', {
              type: 'button',
              class: v && !hint ? 'icon-btn tag-task' : 'btn-small tag-task',
              title: !v ? `Create a task to add ${k}` : hint ? `Create a task to fix ${k}` : `Create a task to improve ${k}, with a comment`,
              'aria-label': `Create a task about ${k}`,
              onclick: metaTask(store, p, k, v),
            }, icon(v && !hint ? 'pencil' : 'plus'), v && !hint ? null : 'Task'));
        })),
        missing.length || weak.length
          ? h('div', null, h('button', {
              type: 'button',
              class: 'btn-small',
              onclick: () => openTaskDialog(store, p, {
                text: `${missing.length ? 'Add the missing' : 'Fix the'} share tags on ${hostOf(p.website)}`,
                description: [missing.length ? `Missing: ${missing.join(', ')}` : '', ...weak.map((w) => `- ${w}`)].filter(Boolean).join('\n'),
                comment: 'Anything else to change',
              }),
            }, `Create a task for the ${[missing.length ? 'missing' : '', weak.length ? 'incomplete' : ''].filter(Boolean).join(' and ')} tags`))
          : null),
      h('section', { class: 'stack' },
        h('h3', null, 'How a shared link looks'),
        h('div', { class: 'shares' }, [['x', 'X'], ['linkedin', 'LinkedIn'], ['slack', 'Slack'], ['discord', 'Discord'], ['imessage', 'iMessage']].map(([k, label]) =>
          h('figure', null,
            h('figcaption', { class: 'row between' },
              h('span', { class: 'muted small' }, label),
              h('button', { type: 'button', class: 'btn-link-inline', onclick: previewTask(store, p, label, m) }, 'Comment as a task')),
            shareCard(k, p, m)))))));
}

// --- Provider status ---

// Common services and the kind of status page they run. Any other Statuspage or Datadog page can be added by hand.
const PRESETS = [
  ['GitHub', 'https://www.githubstatus.com'],
  ['Vercel', 'https://www.vercel-status.com'],
  ['Cloudflare', 'https://www.cloudflarestatus.com'],
  ['Netlify', 'https://www.netlifystatus.com'],
  ['npm', 'https://status.npmjs.org'],
  ['Anthropic', 'https://status.anthropic.com'],
  ['OpenAI', 'https://status.openai.com'],
  ['OpenRouter', 'https://status.openrouter.ai', 'datadog'],
  ['Supabase', 'https://status.supabase.com'],
  ['Stripe', 'https://www.stripestatus.com'],
  ['Render', 'https://status.render.com'],
  ['DigitalOcean', 'https://status.digitalocean.com'],
  ['Discord', 'https://discordstatus.com'],
];
const INDICATOR = { none: ['Operational', 'done'], minor: ['Minor issue', 'medium'], maintenance: ['Maintenance', 'medium'], major: ['Major outage', 'high'], critical: ['Critical outage', 'high'] };
const COMPONENT = { degraded_performance: 'degraded', partial_outage: 'partial outage', major_outage: 'major outage', under_maintenance: 'maintenance' };
const IMPACT = { none: 'plain', minor: 'medium', major: 'high', critical: 'high', maintenance: 'medium' };
const INCIDENT_STATUS = { investigating: 'Investigating', identified: 'Identified', monitoring: 'Monitoring', scheduled: 'Scheduled', in_progress: 'In progress', verifying: 'Verifying' };

// "3 hours ago", "in 2 days": close enough to tell how fresh an incident is.
function agoOf(at) {
  if (!at) return '';
  const diff = Date.parse(at) - Date.now();
  const abs = Math.abs(diff);
  const [n, unit] = abs < 3600000 ? [Math.max(1, Math.round(abs / 60000)), 'minute'] : abs < 86400000 ? [Math.round(abs / 3600000), 'hour'] : [Math.round(abs / 86400000), 'day'];
  const text = `${n} ${unit}${n === 1 ? '' : 's'}`;
  return diff > 0 ? `in ${text}` : `${text} ago`;
}

function follow(store, name, url, kind = '') {
  const page = statusPageOf(url);
  if (!page) return toast('Enter the address of a status page, such as www.githubstatus.com.');
  if (store.get(COLLECTION).providers.some((pr) => pr.url === page)) return toast(`${name || page} is already followed.`);
  const id = uid();
  store.update(COLLECTION, (d) => {
    d.providers.push({ id, name: name.trim() || new URL(page).hostname, url: page, ...(kind ? { kind } : {}) });
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

const problemOf = (s) => (s?.indicator && s.indicator !== 'none' ? (s.indicator === 'maintenance' ? 1 : 2) : 0);

function providerCard(store, pr) {
  const s = store.get(COLLECTION).status[pr.id];
  const busy = view.busy.has(pr.id) || view.busy.has('all');
  const [label, tone] = s?.indicator ? INDICATOR[s.indicator] ?? [s.indicator, 'medium'] : s?.error ? ['Unreadable', 'plain'] : ['Not read yet', 'plain'];
  const parts = s?.parts;
  const recent = s?.recent ?? [];
  return h('article', { class: `card provider-card stack tone-${s?.indicator ? tone : 'plain'}` },
    h('div', { class: 'row between' },
      h('div', { class: 'row provider-head' },
        h('span', { class: `status-dot tone-${s?.indicator ? tone : 'plain'}`, 'aria-hidden': 'true' }),
        h('div', null,
          h('strong', null, pr.name),
          h('div', null, h('a', { href: pr.url, target: '_blank', rel: 'noopener', class: 'small' }, new URL(pr.url).hostname)))),
      busy ? pillOf('Reading…', 'plain') : pillOf(label, tone)),
    s?.description ? h('p', { class: 'provider-state' }, s.description) : null,
    parts?.total
      ? h('div', { class: 'stack-sm' },
          h('div', { class: 'meter provider-meter' }, h('span', { style: { width: `${(parts.ok / parts.total) * 100}%` } })),
          h('span', { class: 'muted small' }, `${parts.ok} of ${parts.total} part${parts.total === 1 ? '' : 's'} operational`))
      : null,
    s?.incidents?.length
      ? h('ul', { class: 'incidents' }, s.incidents.map((i) =>
          h('li', null,
            h('div', { class: 'row' },
              pillOf(INCIDENT_STATUS[i.status] ?? i.status, IMPACT[i.impact] ?? 'medium'),
              h('a', { href: i.url, target: '_blank', rel: 'noopener', class: 'incident-name' }, i.name)),
            i.update ? h('p', { class: 'small incident-update' }, i.update) : null,
            h('span', { class: 'muted small' }, [i.started ? `Started ${agoOf(i.started)}` : '', i.updated ? `updated ${agoOf(i.updated)}` : ''].filter(Boolean).join(' · ')))))
      : null,
    s?.components?.length
      ? h('div', { class: 'stack-sm' },
          h('span', { class: 'small' }, h('strong', null, 'Affected')),
          h('div', { class: 'chips' }, s.components.map((c) => h('span', { class: `pill tone-${c.status === 'major_outage' || c.status === 'partial_outage' ? 'high' : 'medium'}`, title: COMPONENT[c.status] ?? c.status }, `${c.name} · ${COMPONENT[c.status] ?? c.status}`))))
      : null,
    s?.maintenances?.length
      ? h('ul', { class: 'incidents maint' }, s.maintenances.map((m) =>
          h('li', null,
            h('div', { class: 'row' }, pillOf(INCIDENT_STATUS[m.status] ?? m.status, 'doing'), h('a', { href: m.url, target: '_blank', rel: 'noopener', class: 'incident-name' }, m.name)),
            m.start ? h('span', { class: 'muted small' }, `${m.status === 'scheduled' ? 'Starts' : 'Started'} ${timeOf(m.start)} (${agoOf(m.start)})${m.end ? ` · until ${timeOf(m.end)}` : ''}`) : null)))
      : null,
    s?.recentCount != null || recent.length
      ? h('details', { class: 'provider-recent' },
          h('summary', { class: 'small' },
            s.recentCount === 0
              ? 'No incident in the last 30 days'
              : [h('strong', null, `${s.recentCount ?? recent.length} incident${(s.recentCount ?? recent.length) === 1 ? '' : 's'}`), ` in 30 days · last ${agoOf(recent[0]?.at)}`]),
          h('ul', { class: 'crawl-facts' }, recent.map((i) => h('li', null, h('a', { href: i.url, target: '_blank', rel: 'noopener' }, i.name), h('span', { class: 'muted small' }, ` · resolved ${agoOf(i.at)}`)))))
      : null,
    s?.error ? h('p', { class: 'muted small' }, `${s.indicator ? 'Last read failed' : 'Could not read'}: ${s.error}`) : null,
    h('div', { class: 'row between provider-foot' },
      h('span', { class: 'muted small' }, `Read ${timeOf(s?.at)}${s?.kind === 'datadog' ? ' · Datadog page' : ''}`),
      h('div', { class: 'row' },
        h('button', { type: 'button', class: 'icon-btn', disabled: busy, title: 'Read again', 'aria-label': `Read ${pr.name} again`, onclick: () => run(store, pr.id, () => checkProviders(store, [pr.id])) }, refreshIcon(busy)),
        h('button', { type: 'button', class: 'icon-btn', title: 'Stop following', 'aria-label': `Stop following ${pr.name}`, onclick: () => unfollow(store, pr) }, icon('x')))));
}

function statusTab(store) {
  const { providers, status } = store.get(COLLECTION);
  const followed = new Set(providers.map((pr) => pr.url));
  const presets = PRESETS.filter(([, url]) => !followed.has(url));
  const down = providers.filter((pr) => problemOf(status[pr.id]) === 2);
  const maint = providers.filter((pr) => problemOf(status[pr.id]) === 1);
  // Services with a problem come first; the rest keep the order they were followed in.
  const sorted = [...providers].sort((a, b) => problemOf(status[b.id]) - problemOf(status[a.id]));
  const incidents30 = providers.reduce((n, pr) => n + (status[pr.id]?.recentCount ?? 0), 0);
  const stat = (n, label, tone = '') => h('div', { class: `card stat ${tone}` }, h('strong', null, String(n)), h('span', { class: 'muted small' }, label));
  // The fields are read on submit, so typing never re-renders the tab.
  const name = h('input', { type: 'text', placeholder: 'Name', 'aria-label': 'Provider name', autocomplete: 'off' });
  const url = h('input', { type: 'text', inputmode: 'url', placeholder: 'status.example.com', 'aria-label': 'Status page address', autocomplete: 'off' });
  return h('div', { class: 'stack-lg' },
    providers.length
      ? h('div', { class: 'summary tool-stats' },
          stat(providers.length - down.length - maint.length, 'operational'),
          stat(down.length, 'with a problem', down.length ? 'stat-bad' : ''),
          stat(maint.length, 'in maintenance'),
          stat(incidents30, 'incidents in 30 days'))
      : null,
    providers.length
      ? notice(down.length
          ? { tone: 'info', text: `${down.map((pr) => pr.name).join(', ')} ${down.length === 1 ? 'reports' : 'report'} a problem right now.` }
          : { tone: 'ok', text: maint.length ? `Everything works; ${maint.map((pr) => pr.name).join(', ')} ${maint.length === 1 ? 'is' : 'are'} in maintenance.` : 'Every followed service reports that it is working.' })
      : null,
    providers.length
      ? h('div', { class: 'site-grid' }, sorted.map((pr) => providerCard(store, pr)))
      : h('div', { class: 'card' }, empty('Follow the services your projects rely on, and the bell tells you when one has an outage and when it is over.')),
    h('section', { class: 'card stack' },
      h('h3', null, 'Follow a service'),
      presets.length
        ? h('div', { class: 'chips' }, presets.map(([n, u, kind]) => h('button', { type: 'button', class: 'chip', onclick: () => follow(store, n, u, kind) }, icon('plus'), n)))
        : null,
      h('form', {
        class: 'follow-form',
        onsubmit: (e) => {
          e.preventDefault();
          follow(store, name.value, url.value);
        },
      }, name, url, h('button', { type: 'submit', class: 'btn-small primary' }, 'Follow'))),
    h('p', { class: 'muted small' }, 'Works with status pages hosted on Statuspage (most providers use it) and on Datadog (OpenRouter, for one). The page’s public summary and recent incidents are read on the same interval as website health; nothing about you is sent. Datadog pages are read through r.jina.ai, which receives only the page’s address.'));
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
              }, refreshIcon(all), all ? 'Checking…' : 'Check all now'))
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
  serialize: () => ({ tab: view.tab === 'health' ? '' : view.tab, project: ['meta', 'crawl', 'health'].includes(view.tab) ? view.project : '' }),
  restore: (p = {}) => {
    view.tab = TABS.some(([k]) => k === p.tab) ? p.tab : 'health';
    view.project = p.project || '';
  },
};
