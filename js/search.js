// What the full search page looks through, grouped by kind. The palette shows the first few matches; this is all of them.
import { statusOf } from './ui.js';
import { taskMatcher } from './task-query.js';
import { openShortcuts } from './shortcuts.js';

export const SETTINGS = [['github', 'GitHub'], ['openrouter', 'OpenRouter'], ['google', 'Google Calendar'], ['uniswap', 'Uniswap'], ['telegram', 'Telegram'], ['analytics', 'Google Analytics'], ['search', 'Search consoles'], ['appearance', 'Appearance'], ['models', 'Models & tasks'], ['categories', 'Categories'], ['exchange', 'Exchange rates'], ['notifications', 'Notifications'], ['automations', 'Automations'], ['data', 'Data folder']];

// [key, label, icon], in the order the page lists them.
export const GROUPS = [['tasks', 'Tasks', 'check-square'], ['projects', 'Projects', 'folder'], ['recipes', 'Recipes', 'chef-hat'], ['sections', 'Sections', 'home'], ['settings', 'Settings', 'settings']];

const STATUS_LABELS = { todo: 'To do', blocked: 'Blocked', paused: 'Paused', ondeck: 'On Deck', doing: 'In progress', review: 'In Review', done: 'Completed' };

// Every word has to appear somewhere in the text.
const wordsIn = (q, text) => {
  const haystack = text.toLowerCase();
  return q.split(/\s+/).filter(Boolean).every((w) => haystack.includes(w));
};

// Returns { tasks: [...], projects: [...], ... }. Each result is { label, hint, iconName, href } or has `run` instead of href.
export function searchAll(store, modules, query) {
  const q = query.trim().toLowerCase();
  const out = Object.fromEntries(GROUPS.map(([key]) => [key, []]));
  if (!q) return out;
  const projects = store.get('projects').projects;
  const projectName = (id) => projects.find((p) => p.id === id)?.name ?? 'Personal';

  // Tasks open in their own list, filtered by the same search, so the one found is easy to spot.
  const matchTask = taskMatcher(query, projects);
  const tasks = store.get('todos').items.filter(matchTask);
  // Open tasks first; done ones are still found but come last.
  tasks.sort((a, b) => Number(statusOf(a) === 'done') - Number(statusOf(b) === 'done'));
  for (const t of tasks) {
    const params = new URLSearchParams({ filter: t.projectId ?? 'personal', status: 'all', q: query.trim() });
    out.tasks.push({
      label: t.text,
      hint: [projectName(t.projectId), STATUS_LABELS[statusOf(t)], t.priority && t.priority !== 'none' ? t.priority : '', t.due ? `due ${t.due}` : '', t.category ?? ''].filter(Boolean).join(' · '),
      iconName: 'check-square',
      done: statusOf(t) === 'done',
      href: `#/todos?${params}`,
    });
  }
  for (const p of projects) {
    if (wordsIn(q, `${p.name} ${p.description ?? ''}`)) out.projects.push({ label: p.name, hint: p.description ?? '', iconName: 'folder', href: `#/projects?project=${p.id}` });
  }
  for (const r of store.get('recipes').recipes) {
    if (wordsIn(q, `${r.title} ${(r.tags ?? []).join(' ')} ${(r.ingredients ?? []).join(' ')}`)) {
      out.recipes.push({ label: r.title, hint: (r.tags ?? []).join(', '), iconName: 'chef-hat', href: `#/kitchen?recipe=${r.id}` });
    }
  }
  const section = (label, hint, iconName, target) => {
    if (wordsIn(q, label)) out.sections.push({ label, hint, iconName, ...(typeof target === 'function' ? { run: target } : { href: target }) });
  };
  for (const m of modules.filter((x) => x.id !== 'search')) section(m.title, 'Section', m.icon, `#/${m.id}`);
  section('Tasks due today', 'Task list', 'clock', '#/todos?filter=today');
  section('Tasks to organize', 'Task list', 'inbox', '#/todos?filter=organize');
  section('Keyboard shortcuts', 'Help', 'info', openShortcuts);
  for (const [key, label] of SETTINGS) {
    // Typing "settings" (or the start of it) lists them all; otherwise only the name counts.
    if (wordsIn(q, label) || (q.length >= 3 && 'settings'.startsWith(q))) out.settings.push({ label, hint: 'Settings', iconName: 'settings', href: `#/settings?section=${key}` });
  }
  return out;
}
