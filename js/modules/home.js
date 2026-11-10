import { h, icon, money, monthKey, todayISO, statusOf, empty } from '../ui.js';
import { projectIcon } from './projects.js';

const PRIORITY_RANK = { high: 0, medium: 1, low: 2, none: 3 };
const LABEL = { testing: 'Testing', idea: 'Ideas', final: 'Final' };

// A card with a title and a link to the full section.
function card(title, href, ...children) {
  return h('section', { class: 'card home-card' },
    h('div', { class: 'row between' },
      h('h3', null, title),
      h('a', { href, class: 'more' }, 'Open')),
    ...children);
}

const lastActivity = (recipe) =>
  recipe.versions.reduce((latest, v) => (v.date > latest ? v.date : latest), recipe.created.slice(0, 10));

function draw(root, store) {
  const items = store.get('todos').items;
  const projects = store.get('projects').projects;
  const recipes = store.get('recipes').recipes;
  const entries = store.get('finance').entries;

  const open = items.filter((i) => statusOf(i) !== 'done');
  const doing = open.filter((i) => statusOf(i) === 'doing');
  const attention = open
    .filter((i) => statusOf(i) === 'doing' || i.priority === 'high')
    .sort((a, b) => (PRIORITY_RANK[a.priority ?? 'none'] - PRIORITY_RANK[b.priority ?? 'none']) || a.created.localeCompare(b.created))
    .slice(0, 6);
  const personalOpen = open.filter((i) => i.projectId === null).length;

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

  root.replaceChildren(
    h('div', { class: 'stack-lg' },
      h('div', null,
        h('h2', null, 'Home'),
        h('p', { class: 'muted' }, today)),

      h('div', { class: 'home-grid' },
        card('Todos', '#/todos',
          h('div', { class: 'stats' },
            h('div', null, h('strong', null, String(open.length)), h('span', { class: 'muted' }, 'open')),
            h('div', null, h('strong', null, String(doing.length)), h('span', { class: 'muted' }, 'doing')),
            h('div', null, h('strong', null, String(personalOpen)), h('span', { class: 'muted' }, 'personal'))),
          attention.length
            ? h('ul', { class: 'home-list' },
                attention.map((i) =>
                  h('li', null,
                    h('span', { class: 'grow' }, i.text),
                    statusOf(i) === 'doing' ? h('span', { class: 'pill doing' }, 'Doing') : null,
                    i.priority === 'high' ? h('span', { class: 'pill priority-high' }, 'High') : null)))
            : h('p', { class: 'muted' }, 'Nothing urgent or in progress.')),

        card('Projects', '#/projects',
          projects.length
            ? h('ul', { class: 'home-list' },
                [...projects].sort((a, b) => a.name.localeCompare(b.name)).map((p) => {
                  const n = open.filter((i) => i.projectId === p.id).length;
                  return h('li', null,
                    projectIcon(p),
                    h('span', { class: 'grow' }, p.name),
                    h('span', { class: 'count' }, `${n} open`));
                }))
            : empty('No projects yet.')),

        card('Kitchen', '#/kitchen',
          h('div', { class: 'stats' },
            ['idea', 'testing', 'final'].map((s) =>
              h('div', null,
                h('strong', null, String(recipes.filter((r) => r.status === s).length)),
                h('span', { class: 'muted' }, LABEL[s]))) ),
          testing.length
            ? h('ul', { class: 'home-list' },
                testing.slice(0, 5).map((r) =>
                  h('li', null,
                    h('span', { class: 'grow' }, r.title),
                    h('span', { class: 'muted' }, `${r.versions.length} tries · ${lastActivity(r)}`))))
            : h('p', { class: 'muted' }, 'No recipes in testing right now.')),

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
