import { h, icon, money, monthKey, todayISO, statusOf, empty, notice } from '../ui.js';
import { projectIcon, labelsOf, labelColor } from './projects.js';
import { repoStats } from '../github.js';
import { ask } from '../ai.js';
import { setupBanner, hasOpenRouter } from '../integrations.js';
import { connect, isConnected, upcomingEvents } from '../google.js';
import { makeTask } from '../capture.js';
import { sitesOf, siteData, ruleOf } from '../automations.js';
import { hostOf, daysUntil } from '../sitecheck.js';
import { overBudget } from './money.js';
import { outOfRange } from './positions.js';

const PRIORITY_RANK = { high: 0, medium: 1, low: 2, none: 3 };
const RECIPE_LABEL = { testing: 'Testing', idea: 'Ideas', final: 'Final' };

// --- Plan my day (AI) ---

const plan = { status: 'idle', text: '' };

async function runPlan(store) {
  const projects = store.get('projects').projects;
  const open = store.get('todos').items.filter((i) => statusOf(i) !== 'done').slice(0, 40);
  plan.status = 'loading';
  store.refresh();
  try {
    plan.text = (await ask(store, 'task-plan', [
      {
        role: 'system',
        content: 'You plan a personal day. Given open tasks as JSON, reply in plain text with three short sections titled Now, Next and Later, each with up to four bullet points. Name the project in brackets when it helps. Be concise.',
      },
      {
        role: 'user',
        content: JSON.stringify(open.map((i) => ({
          text: i.text,
          status: statusOf(i),
          priority: i.priority ?? 'none',
          project: projects.find((p) => p.id === i.projectId)?.name ?? 'Personal',
          category: i.category || '',
        }))),
      },
    ])).trim();
    plan.status = 'ok';
  } catch (err) {
    plan.status = 'error';
    plan.text = err.message;
  }
  store.refresh();
}

function planPanel(store) {
  if (!hasOpenRouter(store)) return setupBanner('openrouter', 'Plan my day needs an OpenRouter key.');
  const button = h('button', { type: 'button', class: 'btn-small primary', disabled: plan.status === 'loading', onclick: () => runPlan(store) },
    icon('activity'), plan.status === 'idle' ? 'Plan my day' : 'Plan again');
  if (plan.status === 'idle') return h('div', { class: 'stack' }, h('p', { class: 'muted small' }, 'A short plan for today, from your open tasks.'), button);
  if (plan.status === 'loading') return h('div', { class: 'stack' }, button, h('p', { class: 'muted small' }, 'Planning…'));
  if (plan.status === 'error') return h('div', { class: 'stack' }, button, notice({ text: plan.text }));
  return h('div', { class: 'stack' }, button, h('pre', { class: 'plan-text' }, plan.text));
}

// --- Calendar (Google) ---

const cal = { status: 'idle', events: [], error: '' };

const timeLabel = (e) => (e.allDay ? 'All day' : new Date(e.start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));

function loadCalendar(store) {
  cal.status = 'loading';
  store.refresh();
  upcomingEvents(2)
    .then((events) => {
      cal.events = events;
      cal.status = 'ok';
    })
    .catch((err) => {
      cal.status = 'error';
      cal.error = err.message;
    })
    .finally(() => store.refresh());
}

function connectCalendar(store, clientId) {
  connect(clientId)
    .then(() => loadCalendar(store))
    .catch((err) => {
      cal.status = 'error';
      cal.error = err.message;
      store.refresh();
    });
}

// Turns a calendar event into a task in Personal, with its time and place in the description.
function eventAsTask(store, e) {
  const description = [timeLabel(e), e.location].filter(Boolean).join(' · ');
  store.update('todos', (d) =>
    d.items.push(makeTask({ text: e.title, description, due: String(e.start ?? '').slice(0, 10) })));
}

function calendarBlock(store) {
  const clientId = store.get('settings').google?.clientId ?? '';
  if (!isConnected()) {
    return h('div', { class: 'stack' },
      h('p', { class: 'muted small' }, clientId ? 'Connect to see the next two days.' : 'Add a Google OAuth Client ID to see your calendar here.'),
      clientId
        ? h('button', { type: 'button', class: 'btn-small', onclick: () => connectCalendar(store, clientId) }, icon('plus'), 'Connect Google Calendar')
        : setupBanner('google', 'Calendar needs a Google OAuth Client ID.'));
  }
  if (cal.status === 'loading') return h('p', { class: 'muted small' }, 'Loading events…');
  if (cal.status === 'error') {
    return h('div', { class: 'stack' }, notice({ text: cal.error }),
      h('button', { type: 'button', class: 'btn-small', onclick: () => loadCalendar(store) }, 'Try again'));
  }
  if (cal.status !== 'ok') {
    return h('button', { type: 'button', class: 'btn-small', onclick: () => loadCalendar(store) }, 'Load events');
  }
  if (!cal.events.length) return h('p', { class: 'muted small' }, 'No events in the next two days.');
  return h('ul', { class: 'board-list' },
    cal.events.map((e) =>
      h('li', null,
        h('span', { class: 'time muted small' }, timeLabel(e)),
        h('span', { class: 'grow' }, e.title),
        h('button', { type: 'button', class: 'btn-small', title: 'Add as a task', onclick: () => eventAsTask(store, e) }, 'Task'))));
}

// --- Board sections ---

// A titled panel. `more` is the link to the full section.
function panel(title, more, ...children) {
  return h('section', { class: 'card board-panel' },
    h('div', { class: 'row between board-panel-head' },
      h('h3', null, title),
      more ? h('a', { href: more, class: 'btn-link' }, 'Open') : null),
    ...children);
}

// The stat strip at the top of the page.
function statStrip(store, open, doing, projects) {
  const github = projects.flatMap((p) => p.github.repos);
  let prs = 0;
  let pending = false;
  for (const r of new Set(github)) {
    const s = repoStats(r, () => {
      if (location.hash === '#/home' || location.hash === '') store.refresh();
    });
    if (s.status === 'ok') prs += s.prs;
    else if (s.status === 'loading') pending = true;
  }
  const testing = store.get('recipes').recipes.filter((r) => r.status === 'testing').length;
  const cell = (n, label, href) =>
    h('a', { href, class: 'stat-cell' }, h('strong', null, n), h('span', { class: 'muted small' }, label));
  return h('div', { class: 'stat-strip' },
    cell(String(open), 'open tasks', '#/todos'),
    cell(String(doing), 'in progress', '#/todos'),
    cell(String(projects.length), 'projects', '#/projects'),
    cell(String(testing), 'recipes in testing', '#/kitchen'),
    cell(pending ? '…' : String(prs), 'open PRs', '#/monitoring'));
}

// A tile per project: icon, name, labels, and open tasks.
function projectTiles(store, projects, open) {
  if (!projects.length) return empty('No projects yet. Create one in Projects to see it here.');
  const label = (id) => store.get('projects').categories?.find((c) => c.id === id);
  return h('div', { class: 'tiles' },
    [...projects].sort((a, b) => a.name.localeCompare(b.name)).map((p) => {
      const n = open.filter((i) => i.projectId === p.id).length;
      const names = labelsOf(p).map(label).filter(Boolean);
      return h('a', { href: `#/projects?project=${p.id}`, class: 'tile' },
        h('div', { class: 'tile-head' }, projectIcon(p), h('strong', null, p.name)),
        h('div', { class: 'tile-meta' },
          names.length
            ? names.map((l) => h('span', { class: 'pill tone-custom', style: { '--c': labelColor(l) } }, l.name))
            : h('span', { class: 'muted small' }, 'No label')),
        h('div', { class: 'tile-count' }, h('span', null, String(n)), h('span', { class: 'muted small' }, n === 1 ? 'open task' : 'open tasks')));
    }));
}

function kitchenPanel(store) {
  const recipes = store.get('recipes').recipes;
  const testing = recipes.filter((r) => r.status === 'testing')
    .sort((a, b) => (b.versions.at(-1)?.date ?? b.created).localeCompare(a.versions.at(-1)?.date ?? a.created));
  const counts = ['idea', 'testing', 'final'].map((s) => `${recipes.filter((r) => r.status === s).length} ${RECIPE_LABEL[s].toLowerCase()}`);
  return panel('Kitchen', '#/kitchen',
    h('p', { class: 'muted small' }, counts.join(' · ')),
    testing.length
      ? h('ul', { class: 'board-list' }, testing.slice(0, 5).map((r) =>
          h('li', null,
            h('span', { class: 'grow' }, r.title),
            h('span', { class: 'muted small' }, `${r.versions.length} ${r.versions.length === 1 ? 'try' : 'tries'}`))))
      : h('p', { class: 'muted small' }, 'Nothing in testing right now.'));
}

function moneyPanel(store) {
  const entries = store.get('finance').entries;
  const month = monthKey(todayISO());
  const monthEntries = entries.filter((e) => monthKey(e.date) === month);
  // Totals in USD; entries in CAD are shown as they were recorded, so the page never guesses a rate.
  const usdSum = (type) => monthEntries.filter((e) => e.type === type && (e.currency ?? 'USD') === 'USD').reduce((s, e) => s + e.amount, 0);
  const cadCount = monthEntries.filter((e) => (e.currency ?? 'USD') === 'CAD').length;
  const income = usdSum('income');
  const expense = usdSum('expense');
  return panel('Money', '#/money',
    h('p', { class: 'muted small' }, `${month} · USD`),
    h('div', { class: 'board-money' },
      h('div', null, h('span', { class: 'muted small' }, 'Income'), h('strong', { class: 'income' }, money(income, 'USD'))),
      h('div', null, h('span', { class: 'muted small' }, 'Expenses'), h('strong', { class: 'expense' }, money(expense, 'USD'))),
      h('div', null, h('span', { class: 'muted small' }, 'Net'), h('strong', { class: income - expense < 0 ? 'expense' : 'income' }, money(income - expense, 'USD')))),
    cadCount ? h('p', { class: 'muted small' }, `${cadCount} CAD ${cadCount === 1 ? 'entry is' : 'entries are'} not in these totals. Open Money to convert.`) : null);
}

function githubPanel(store, projects) {
  const repos = [...new Set(projects.flatMap((p) => p.github.repos))];
  if (!repos.length) {
    return panel('GitHub', '#/projects', h('p', { class: 'muted small' }, 'Link a repo to a project to see its issues and PRs here.'));
  }
  const totals = { issues: 0, prs: 0, loading: 0, failed: 0 };
  for (const r of repos) {
    const s = repoStats(r, () => {});
    if (s.status === 'ok') {
      totals.issues += s.issues;
      totals.prs += s.prs;
    } else if (s.status === 'loading') totals.loading += 1;
    else totals.failed += 1;
  }
  return panel('GitHub', '#/monitoring',
    h('div', { class: 'board-money' },
      h('div', null, h('span', { class: 'muted small' }, 'Open issues'), h('strong', null, totals.loading ? '…' : String(totals.issues))),
      h('div', null, h('span', { class: 'muted small' }, 'Open PRs'), h('strong', null, totals.loading ? '…' : String(totals.prs))),
      h('div', null, h('span', { class: 'muted small' }, 'Repos'), h('strong', null, String(repos.length)))),
    totals.failed ? h('p', { class: 'muted small' }, `${totals.failed} repo${totals.failed > 1 ? 's' : ''} could not be read.`) : null);
}

// What still needs connecting, in one place. Hidden once everything is set up.
function setupCard(store) {
  const s = store.get('settings');
  const rows = [
    ['github', 'GitHub token', s.github?.token],
    ['openrouter', 'OpenRouter key, for the AI features', s.openrouter?.key],
    ['models', 'Default AI model', s.models?.default],
    ['google', 'Google Calendar', s.google?.clientId],
    ['uniswap', 'Wallet for Liquidity Pools', s.uniswap?.wallets?.length],
    ['telegram', 'Telegram bot', s.telegram?.token && s.telegram?.chatId],
  ];
  const done = rows.filter(([, , ok]) => ok).length;
  if (done === rows.length) return null;
  return h('section', { class: 'card board-panel' },
    h('div', { class: 'row between board-panel-head' }, h('h3', null, 'Finish setting up'), h('span', { class: 'muted small' }, `${done} of ${rows.length}`)),
    h('div', { class: 'meter' }, h('span', { style: { width: `${(done / rows.length) * 100}%` } })),
    h('ul', { class: 'board-list' }, rows.map(([key, text, ok]) =>
      h('li', null,
        h('span', { class: ok ? 'tick ok' : 'tick todo' }, ok ? icon('check') : null),
        h('span', { class: ok ? 'grow muted' : 'grow' }, text),
        ok ? null : h('a', { href: `#/settings?section=${key}`, class: 'btn-link' }, 'Set up')))));
}

// Things from every section that want a look today. Hidden when there are none.
function attentionCard(store, open) {
  const today = todayISO();
  const rows = [];
  const add = (iconName, text, href, action) => rows.push(h('li', null, icon(iconName), h('span', { class: 'grow' }, text), h('a', { href, class: 'btn-link' }, action)));
  const late = open.filter((i) => i.due && i.due < today).length;
  const inbox = open.filter((i) => i.inbox).length;
  if (late) add('clock', `${late} task${late === 1 ? '' : 's'} past the deadline`, '#/todos?filter=today', 'Review');
  if (inbox) add('inbox', `${inbox} task${inbox === 1 ? '' : 's'} to organize`, '#/todos?filter=organize', 'Organize');
  const domains = new Set();
  for (const p of sitesOf(store)) {
    const s = siteData(store, p.id);
    const host = hostOf(p.website);
    if (s.health?.status === 'down') add('globe', `${host} is not answering`, '#/tools', 'Open');
    if (s.ssl?.until && daysUntil(s.ssl.until) <= ruleOf(store, 'ssl').days) add('shield', `The SSL certificate for ${host} expires in ${daysUntil(s.ssl.until)} days`, '#/tools?tab=ssl', 'Open');
    // Sites on the same domain share one line.
    if (s.domain?.until && daysUntil(s.domain.until) <= ruleOf(store, 'domain').days && !domains.has(s.domain.name) && domains.add(s.domain.name)) add('shield', `The domain ${s.domain.name} expires in ${daysUntil(s.domain.until)} days`, '#/tools?tab=ssl', 'Open');
  }
  for (const b of overBudget(store)) {
    add('wallet', `${b.category} is over its budget this month: ${money(b.spent, b.currency)} of ${money(b.budget, b.currency)}`, '#/money', 'Open');
  }
  const out = outOfRange(store);
  if (out.length === 1) add('droplet', `${out[0].pair} on ${out[0].chain} is out of its price range`, '#/positions?filter=out', 'Open');
  else if (out.length) add('droplet', `${out.length} pool positions are out of their price range`, '#/positions?filter=out', 'Open');
  if (!rows.length) return null;
  return h('section', { class: 'card board-panel' },
    h('div', { class: 'row between board-panel-head' }, h('h3', null, 'Needs attention')),
    h('ul', { class: 'board-list attention' }, rows));
}

// --- Page ---

function draw(root, store) {
  const items = store.get('todos').items;
  const projects = store.get('projects').projects;
  const open = items.filter((i) => statusOf(i) !== 'done');
  const doing = open.filter((i) => statusOf(i) === 'doing');
  const focus = open
    .filter((i) => statusOf(i) === 'doing' || i.priority === 'high' || (i.due && i.due <= todayISO()))
    .sort((a, b) => (PRIORITY_RANK[a.priority ?? 'none'] - PRIORITY_RANK[b.priority ?? 'none']) || a.created.localeCompare(b.created))
    .slice(0, 6);
  const today = new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  const hour = new Date().getHours();
  const greet = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';

  root.replaceChildren(
    h('div', { class: 'board' },
      h('header', { class: 'board-hero' },
        h('div', null,
          h('h2', null, greet),
          h('p', { class: 'muted' }, today)),
        statStrip(store, open.length, doing.length, projects)),

      h('div', { class: 'board-row board-row-even' }, attentionCard(store, open), setupCard(store)),

      h('div', { class: 'board-row' },
        panel('Today', '#/todos',
          focus.length
            ? h('ul', { class: 'board-list' }, focus.map((i) =>
                h('li', null,
                  h('span', { class: 'grow' }, i.text),
                  i.due && i.due <= todayISO() ? h('span', { class: i.due < todayISO() ? 'due late' : 'due today' }, i.due < todayISO() ? 'Overdue' : 'Today') : null,
                  statusOf(i) === 'doing' ? h('span', { class: 'pill doing' }, 'In progress') : null,
                  i.priority === 'high' ? h('span', { class: 'pill priority-high' }, 'High') : null)))
            : h('p', { class: 'muted small' }, 'Nothing urgent or in progress. A good time to plan.'),
          h('div', { class: 'board-sub' },
            h('span', { class: 'muted small' }, 'Calendar · next two days'),
            calendarBlock(store))),
        panel('Plan my day', null, planPanel(store))),

      h('section', { class: 'board-section' },
        h('div', { class: 'row between board-panel-head' },
          h('h3', null, 'Projects'),
          h('a', { href: '#/projects', class: 'btn-link' }, 'Open projects')),
        projectTiles(store, projects, open)),

      h('div', { class: 'board-row board-row-3' },
        kitchenPanel(store),
        moneyPanel(store),
        githubPanel(store, projects))));
}

export default {
  id: 'home',
  title: 'Home',
  icon: 'home',
  collection: null,
  defaults: {},
  render: draw,
};
