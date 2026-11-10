// The search palette (Cmd/Ctrl+K or "/"): jump to a section, a project, a recipe or a task, or type a new task.
import { h, icon, statusOf } from './ui.js';
import { parseTask, makeTask } from './capture.js';
import { createProject } from './modules/projects.js';
import { toast } from './toast.js';

const MAX_ROWS = 12;
const SETTINGS = [['github', 'GitHub'], ['openrouter', 'OpenRouter'], ['google', 'Google Calendar'], ['uniswap', 'Uniswap'], ['telegram', 'Telegram'], ['analytics', 'Google Analytics'], ['search', 'Search consoles'], ['appearance', 'Appearance'], ['models', 'Models & tasks'], ['categories', 'Categories'], ['exchange', 'Exchange rates'], ['notifications', 'Notifications'], ['automations', 'Automations']];

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
  for (const m of modules) add(m.title, 'Go to', m.icon, go(`#/${m.id}`));
  add('Tasks due today', 'Go to', 'clock', go('#/todos?filter=today'));
  add('Tasks to organize', 'Go to', 'inbox', go('#/todos?filter=organize'));
  for (const [key, label] of SETTINGS) add(`Settings: ${label}`, 'Go to', 'settings', go(`#/settings?section=${key}`));
  for (const p of store.get('projects').projects) add(p.name, 'Project', 'folder', go(`#/projects?project=${p.id}`));
  for (const r of store.get('recipes').recipes) add(r.title, 'Recipe', 'chef-hat', go(`#/kitchen?recipe=${r.id}`));
  if (q) {
    for (const t of store.get('todos').items) {
      if (statusOf(t) !== 'done') add(t.text, 'Task', 'check-square', go(`#/todos?filter=${t.projectId ?? 'personal'}`));
    }
  }
  return out.slice(0, MAX_ROWS);
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
          h('li', { role: 'option', 'aria-selected': String(i === active), class: i === active ? 'active' : '', onclick: () => run(item) },
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
      h('p', { class: 'muted small palette-foot' }, '↑↓ to move · Enter to open · Esc to close')));
  document.body.append(overlay);
  paint();
  input.focus();
}
