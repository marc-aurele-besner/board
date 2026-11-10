// Tools: checks that run against the website of each project.
import { h, icon, empty, notice } from '../ui.js';
import { projectIcon } from './projects.js';
import { hostOf, daysUntil } from '../sitecheck.js';
import { sitesOf, siteData, checkSite, checkAllSites, runRules, autoTaskFor, ruleOf, TOOLS_DEFAULTS } from '../automations.js';
import { makeTask } from '../capture.js';
import { toast } from '../toast.js';

const COLLECTION = 'tools';
const TABS = [['health', 'Website health', 'globe'], ['ssl', 'SSL and domains', 'shield'], ['meta', 'Metadata preview', 'link']];
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

// A task for a site, made by hand from a row. It is linked to the rule it belongs to, so the rule does not add another.
function addTask(store, p, kind, text, due = '') {
  const ref = kind === 'domain' ? siteData(store, p.id).domain?.name : hostOf(p.website);
  store.update('todos', (d) => d.items.push(makeTask({ text, projectId: p.id, priority: 'medium', due, ...(kind ? { auto: kind, autoRef: ref } : {}) })));
  toast(`Task added to ${p.name}`);
}

function taskCell(store, p, kind, text, due) {
  const ref = kind === 'domain' ? siteData(store, p.id).domain?.name : hostOf(p.website);
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

function metaTab(store, sites) {
  const p = sites.find((x) => x.id === view.project) ?? sites[0];
  const m = siteData(store, p.id).meta;
  const busy = view.busy.has(p.id);
  const chips = h('div', { class: 'chips' }, sites.map((x) =>
    h('button', {
      type: 'button',
      class: x.id === p.id ? 'chip active' : 'chip',
      onclick: () => {
        view.project = x.id;
        store.refresh();
      },
    }, x.name)));
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

function draw(root, store) {
  const sites = sitesOf(store);
  const without = store.get('projects').projects.filter((p) => !hostOf(p.website ?? ''));
  const all = view.busy.has('all');
  const body = !sites.length
    ? h('div', { class: 'card stack' }, empty('No project has a website yet. Add one on a project page and it appears here.'), h('div', null, h('a', { href: '#/projects', class: 'btn-link' }, 'Open Projects')))
    : view.tab === 'ssl' ? sslTab(store, sites) : view.tab === 'meta' ? metaTab(store, sites) : healthTab(store, sites);

  root.replaceChildren(
    h('div', { class: 'stack-lg tools' },
      h('header', { class: 'row between' },
        h('div', null, h('h2', null, 'Tools'), h('p', { class: 'muted small' }, 'Checks that run against the website of each project, while the board is open.')),
        sites.length && view.tab !== 'meta'
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
                  const made = await checkAllSites(store, view.tab === 'ssl' ? ['ssl', 'domain'] : ['health']);
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
  serialize: () => ({ tab: view.tab === 'health' ? '' : view.tab, project: view.tab === 'meta' ? view.project : '' }),
  restore: (p = {}) => {
    view.tab = TABS.some(([k]) => k === p.tab) ? p.tab : 'health';
    view.project = p.project || '';
  },
};
