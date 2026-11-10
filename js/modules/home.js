import { h, icon, money, monthKey, todayISO, statusOf, empty } from '../ui.js';
import { projectIcon, labelsOf } from './projects.js';
import { repoStats } from '../github.js';
import { ask } from '../ai.js';

// "Plan my day" (task 2): a plain-text plan built from the open tasks.
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

function planBlock(store) {
  const button = h('button', {
    type: 'button',
    class: 'btn-small',
    disabled: plan.status === 'loading',
    onclick: () => runPlan(store),
  }, 'Plan my day with AI');
  if (plan.status === 'idle') return button;
  if (plan.status === 'loading') return h('div', { class: 'stack' }, button, h('p', { class: 'muted small' }, 'Planning…'));
  if (plan.status === 'error') return h('div', { class: 'stack' }, button, h('p', { class: 'error small', role: 'alert' }, plan.text));
  return h('div', { class: 'stack' }, button, h('pre', { class: 'plan-text' }, plan.text));
}

const PRIORITY_RANK = { high: 0, medium: 1, low: 2, none: 3 };
const RECIPE_LABEL = { testing: 'Testing', idea: 'Ideas', final: 'Final' };

let liveStore = null;
// Refresh when repo counts arrive, but only while the home page is showing.
const onRepoChange = () => {
  if (liveStore && (location.hash === '#/home' || location.hash === '')) liveStore.refresh();
};

// A card with a title and a link to the full section.
function card(title, href, ...children) {
  return h('section', { class: 'card home-card' },
    h('div', { class: 'row between' },
      h('h3', null, title),
      h('a', { href, class: 'more' }, 'Open')),
    ...children);
}

const greeting = () => {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
};

const lastActivity = (recipe) =>
  recipe.versions.reduce((latest, v) => (v.date > latest ? v.date : latest), recipe.created.slice(0, 10));

function draw(root, store) {
  liveStore = store;
  const items = store.get('todos').items;
  const projects = store.get('projects').projects;
  const categories = store.get('projects').categories ?? [];
  const recipes = store.get('recipes').recipes;
  const entries = store.get('finance').entries;

  const open = items.filter((i) => statusOf(i) !== 'done');
  const doing = open.filter((i) => statusOf(i) === 'doing');
  const focus = open
    .filter((i) => statusOf(i) === 'doing' || i.priority === 'high')
    .sort((a, b) => (PRIORITY_RANK[a.priority ?? 'none'] - PRIORITY_RANK[b.priority ?? 'none']) || a.created.localeCompare(b.created))
    .slice(0, 6);

  // Projects grouped by category. Uncategorized projects get their own group.
  // A project with several labels appears under each of them.
  const groups = [...categories.map((c) => ({ id: c.id, name: c.name, projects: projects.filter((p) => labelsOf(p).includes(c.id)) }))];
  const uncategorized = projects.filter((p) => labelsOf(p).length === 0);
  if (uncategorized.length) groups.push({ id: null, name: 'Uncategorized', projects: uncategorized });

  // GitHub totals over every linked repo. Each lookup starts a fetch the first time.
  const repos = [...new Set(projects.flatMap((p) => p.github.repos))];
  const gh = { issues: 0, prs: 0, loading: 0, failed: 0 };
  for (const r of repos) {
    const s = repoStats(r, onRepoChange);
    if (s.status === 'ok') {
      gh.issues += s.issues;
      gh.prs += s.prs;
    } else if (s.status === 'loading') gh.loading += 1;
    else gh.failed += 1;
  }

  const testing = recipes
    .filter((r) => r.status === 'testing')
    .sort((a, b) => lastActivity(b).localeCompare(lastActivity(a)));

  const month = monthKey(todayISO());
  const monthEntries = entries.filter((e) => monthKey(e.date) === month);
  const sum = (type) => monthEntries.filter((e) => e.type === type).reduce((s, e) => s + e.amount, 0);
  const income = sum('income');
  const expense = sum('expense');
  const byCategory = new Map();
  for (const e of monthEntries) {
    if (e.type === 'expense') byCategory.set(e.category, (byCategory.get(e.category) ?? 0) + e.amount);
  }
  const topCategories = [...byCategory].sort((a, b) => b[1] - a[1]).slice(0, 3);

  const today = new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  const quickAdd = (text, href) => h('a', { href, class: 'quick-link' }, icon('plus'), text);

  root.replaceChildren(
    h('div', { class: 'stack-lg' },
      h('div', { class: 'home-hero' },
        h('h2', null, greeting()),
        h('p', { class: 'muted' }, today),
        h('div', { class: 'stats' },
          h('div', null, h('strong', null, String(open.length)), h('span', { class: 'muted' }, 'open tasks')),
          h('div', null, h('strong', null, String(doing.length)), h('span', { class: 'muted' }, 'in progress')),
          h('div', null, h('strong', null, String(projects.length)), h('span', { class: 'muted' }, 'projects')),
          h('div', null,
            h('strong', null, gh.loading && !gh.issues && !gh.prs ? '…' : String(gh.issues)),
            h('span', { class: 'muted' }, 'open issues')),
          h('div', null,
            h('strong', null, gh.loading && !gh.issues && !gh.prs ? '…' : String(gh.prs)),
            h('span', { class: 'muted' }, 'open PRs')))),

      h('div', { class: 'home-grid' },
        card('Focus', '#/todos',
          focus.length
            ? h('ul', { class: 'home-list' },
                focus.map((i) =>
                  h('li', null,
                    h('span', { class: 'grow' }, i.text),
                    statusOf(i) === 'doing' ? h('span', { class: 'pill doing' }, 'Doing') : null,
                    i.priority === 'high' ? h('span', { class: 'pill priority-high' }, 'High') : null)))
            : h('p', { class: 'muted' }, 'Nothing urgent or in progress. Good time to plan.'),
          quickAdd('Add a task', '#/todos'),
          planBlock(store)),

        card('Projects by category', '#/projects',
          groups.some((g) => g.projects.length)
            ? h('div', { class: 'groups' },
                groups.filter((g) => g.projects.length).map((g) =>
                  h('div', { class: 'group' },
                    h('div', { class: 'row between' },
                      h('strong', null, g.name),
                      h('span', { class: 'muted' }, `${g.projects.length} project${g.projects.length === 1 ? '' : 's'}`)),
                    h('ul', { class: 'home-list' },
                      g.projects.map((p) => {
                        const n = open.filter((i) => i.projectId === p.id).length;
                        return h('li', null,
                          projectIcon(p),
                          h('span', { class: 'grow' }, p.name),
                          h('span', { class: 'count' }, `${n} open`));
                      })))))
            : empty('No projects yet.'),
          quickAdd('New project', '#/projects')),

        card('GitHub', '#/projects',
          repos.length
            ? h('div', { class: 'stack' },
                h('div', { class: 'stats' },
                  h('div', null, h('strong', null, String(gh.issues)), h('span', { class: 'muted' }, 'open issues')),
                  h('div', null, h('strong', null, String(gh.prs)), h('span', { class: 'muted' }, 'open PRs')),
                  h('div', null, h('strong', null, String(repos.length)), h('span', { class: 'muted' }, 'repos'))),
                gh.loading ? h('p', { class: 'muted' }, `Loading ${gh.loading} repo${gh.loading > 1 ? 's' : ''}…`) : null,
                gh.failed ? h('p', { class: 'muted' }, `${gh.failed} repo${gh.failed > 1 ? 's' : ''} could not be read (private, missing, or rate limited).`) : null)
            : h('p', { class: 'muted' }, 'No repos linked yet. Link one from a project to see its issues and PRs here.')),

        card('Kitchen', '#/kitchen',
          h('div', { class: 'stats' },
            ['idea', 'testing', 'final'].map((s) =>
              h('div', null,
                h('strong', null, String(recipes.filter((r) => r.status === s).length)),
                h('span', { class: 'muted' }, RECIPE_LABEL[s])))),
          testing.length
            ? h('ul', { class: 'home-list' },
                testing.slice(0, 5).map((r) =>
                  h('li', null,
                    h('span', { class: 'grow' }, r.title),
                    h('span', { class: 'muted' }, `${r.versions.length} tries · ${lastActivity(r)}`))))
            : h('p', { class: 'muted' }, 'No recipes in testing right now.'),
          quickAdd('Open kitchen', '#/kitchen')),

        card(`Money · ${month}`, '#/money',
          h('div', { class: 'stats' },
            h('div', null, h('strong', { class: 'income' }, money(income)), h('span', { class: 'muted' }, 'income')),
            h('div', null, h('strong', { class: 'expense' }, money(expense)), h('span', { class: 'muted' }, 'expenses')),
            h('div', null, h('strong', { class: income - expense < 0 ? 'expense' : 'income' }, money(income - expense)), h('span', { class: 'muted' }, 'net'))),
          topCategories.length
            ? h('ul', { class: 'home-list' },
                topCategories.map(([name, amount]) =>
                  h('li', null, h('span', { class: 'grow' }, name), h('span', null, money(amount)))))
            : h('p', { class: 'muted' }, 'No expenses this month.')))));
}

export default {
  id: 'home',
  title: 'Home',
  icon: 'home',
  hidden: true, // reached from the "Board" logo, not from the nav tabs
  collection: null,
  defaults: {},
  render: draw,
};
