// The search palette (Cmd/Ctrl+K or "/"): jump to a section, a project, a recipe or a task, or capture something new:
// a task, a Money entry ("-42.50 groceries") or a recipe link.
import { h, icon, statusOf, money, todayISO, CURRENCIES } from './ui.js';
import { parseTask, parseMoney, makeTask } from './capture.js';
import { createProject } from './modules/projects.js';
import { addEntries } from './modules/money.js';
import { importFromUrl } from './modules/kitchen.js';
import { toast } from './toast.js';
import { openShortcuts } from './shortcuts.js';
import { SETTINGS } from './search.js';

const MAX_ROWS = 12;

let overlay = null;

export function closePalette() {
  overlay?.remove();
  overlay = null;
}

function addTask(store, raw) {
  const parsed = parseTask(raw, store.get('projects').projects);
  if (!parsed.text) return;
  const projectId = parsed.projectId ?? (parsed.tag ? createProject(store, parsed.tag).project.id : null);
  store.update('todos', (d) => d.items.push(makeTask({ text: parsed.text, priority: parsed.priority, due: parsed.due, projectId })));
  const where = store.get('projects').projects.find((p) => p.id === projectId)?.name ?? 'Personal';
  toast(`Added to ${where}`);
}

function itemsFor(store, modules, query) {
  const q = query.trim().toLowerCase();
  const out = [];
  const add = (label, hint, iconName, run) => {
    if (!q || label.toLowerCase().includes(q)) out.push({ label, hint, iconName, run });
  };
  const go = (hash) => () => {
    location.hash = hash;
  };
  // A line that reads as an amount is offered as a Money entry first; a link as a recipe to import.
  const entry = q ? parseMoney(query, store.get('finance').categories, CURRENCIES) : null;
  if (entry) {
    const currency = entry.currency || CURRENCIES[0];
    out.push({
      label: `Add ${entry.type} ${money(entry.amount, currency)}`,
      hint: [entry.category || 'Uncategorized', entry.note, 'today'].filter(Boolean).join(' · '),
      iconName: 'wallet',
      run: () => {
        addEntries(store, [{ ...entry, currency, date: todayISO() }]);
        toast(`Added to Money: ${money(entry.amount, currency)} ${entry.category || 'Uncategorized'}`);
      },
    });
  }
  const link = query.trim();
  if (/^https?:\/\/\S+$/i.test(link)) {
    out.push({
      label: 'Import a recipe from this link',
      hint: 'Kitchen',
      iconName: 'chef-hat',
      run: () => {
        location.hash = '#/kitchen';
        importFromUrl(store, link);
      },
    });
  }
  if (q) {
    const p = parseTask(query, store.get('projects').projects);
    const project = store.get('projects').projects.find((x) => x.id === p.projectId)?.name ?? (p.tag ? `new project “${p.tag}”` : 'Personal');
    if (p.text) {
      out.push({
        label: `Add task “${p.text}”`,
        hint: [project, p.priority !== 'none' ? p.priority : '', p.due ? `due ${p.due}` : ''].filter(Boolean).join(' · '),
        iconName: 'plus',
        run: () => addTask(store, query),
      });
    }
  }
  for (const m of modules.filter((x) => x.id !== 'search')) add(m.title, 'Go to', m.icon, go(`#/${m.id}`));
  add('Tasks due today', 'Go to', 'clock', go('#/todos?filter=today'));
  add('Tasks to organize', 'Go to', 'inbox', go('#/todos?filter=organize'));
  add('Keyboard shortcuts', 'Help', 'info', openShortcuts);
  for (const [key, label] of SETTINGS) add(`Settings: ${label}`, 'Go to', 'settings', go(`#/settings?section=${key}`));
  for (const p of store.get('projects').projects) add(p.name, 'Project', 'folder', go(`#/projects?project=${p.id}`));
  for (const r of store.get('recipes').recipes) add(r.title, 'Recipe', 'chef-hat', go(`#/kitchen?recipe=${r.id}`));
  if (q) {
    for (const t of store.get('todos').items) {
      if (statusOf(t) !== 'done') add(t.text, 'Task', 'check-square', go(`#/todos?filter=${t.projectId ?? 'personal'}`));
    }
  }
  const rows = out.slice(0, MAX_ROWS);
  // The last row always opens every match on its own page, with a tab per kind.
  if (q) {
    rows.push({
      label: `See all results for “${query.trim()}”`,
      hint: 'Search page',
      iconName: 'search',
      more: true,
      run: () => {
        location.hash = `#/search?${new URLSearchParams({ q: query.trim() })}`;
      },
    });
  }
  return rows;
}

export function openPalette(store, modules) {
  if (overlay) return closePalette();
  let active = 0;
  let items = [];
  const input = h('input', { class: 'palette-input', placeholder: 'Search, jump, or type a task: fix the footer #atlas !high friday', 'aria-label': 'Search or jump', autocomplete: 'off' });
  const list = h('ul', { class: 'palette-list', role: 'listbox' });
  const run = (item) => {
    closePalette();
    item?.run();
  };
  const paint = () => {
    items = itemsFor(store, modules, input.value);
    active = Math.min(active, Math.max(0, items.length - 1));
    list.replaceChildren(...(items.length
      ? items.map((item, i) =>
          h('li', { role: 'option', 'aria-selected': String(i === active), class: [i === active ? 'active' : '', item.more ? 'palette-more' : ''].filter(Boolean).join(' '), onclick: () => run(item) },
            icon(item.iconName), h('span', { class: 'grow' }, item.label), h('span', { class: 'muted small' }, item.hint)))
      : [h('li', { class: 'muted' }, 'Nothing matches.')]));
  };
  input.addEventListener('input', () => {
    active = 0;
    paint();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      active = (active + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % Math.max(1, items.length);
      paint();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      run(items[active]);
    } else if (e.key === 'Escape') {
      closePalette();
    }
  });
  overlay = h('div', {
    class: 'palette-overlay',
    onclick: (e) => {
      if (e.target === overlay) closePalette();
    },
  },
    h('div', { class: 'palette', role: 'dialog', 'aria-label': 'Search or jump' },
      h('div', { class: 'palette-head' }, icon('search'), input),
      list,
      h('p', { class: 'muted small palette-foot' }, '↑↓ to move · Enter to open · Esc to close · -42.50 groceries adds an expense · a pasted link imports a recipe')));
  document.body.append(overlay);
  paint();
  input.focus();
}
