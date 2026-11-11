// A task search that doubles as a filter. Plain words must all appear in the title, description, category or
// project name. Tokens narrow further: #project (or #personal), !high, is:doing (or is:open), cat:design, due:today.
import { statusOf, todayISO } from './ui.js';

const STATUS_KEYS = ['todo', 'blocked', 'paused', 'ondeck', 'doing', 'review', 'done'];
const STATUS_ALIASES = { open: 'open', progress: 'doing', inprogress: 'doing', deck: 'ondeck', completed: 'done', closed: 'done' };
const PRIORITY_KEYS = ['high', 'medium', 'low', 'none'];
export const QUERY_HINT = 'words, #project, !high, is:doing, cat:name, due:today';

const addDays = (iso, n) => {
  // Noon UTC, so adding days never crosses a date line.
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

function dueMatches(item, when) {
  const today = todayISO();
  if (when === 'none') return !item.due;
  if (!item.due) return false;
  if (when === 'today') return item.due <= today;
  if (when === 'late' || when === 'overdue') return item.due < today;
  if (when === 'week') return item.due <= addDays(today, 7);
  return item.due.startsWith(when);
}

// Reads the query once; the returned function tests one task. `hasStatus` says the query names a status itself,
// so a list's own status filter can step aside.
export function taskMatcher(query, projects) {
  const tests = [];
  const words = [];
  let hasStatus = false;
  const projectName = (id) => projects.find((p) => p.id === id)?.name ?? 'Personal';
  for (const raw of query.trim().toLowerCase().split(/\s+/).filter(Boolean)) {
    const [, key, value] = raw.match(/^(is|status|cat|category|due):(.+)$/) ?? [];
    if (raw.length > 1 && raw.startsWith('#')) {
      const name = raw.slice(1);
      if (name === 'personal') tests.push((i) => !i.projectId);
      else {
        const ids = new Set(projects.filter((p) => p.name.toLowerCase().replace(/\s+/g, '').includes(name)).map((p) => p.id));
        tests.push((i) => ids.has(i.projectId));
      }
    } else if (raw.length > 1 && raw.startsWith('!') && PRIORITY_KEYS.includes(raw.slice(1))) {
      tests.push((i) => (i.priority ?? 'none') === raw.slice(1));
    } else if (key === 'is' || key === 'status') {
      const s = STATUS_ALIASES[value] ?? value;
      if (s !== 'open' && !STATUS_KEYS.includes(s)) {
        words.push(raw);
        continue;
      }
      hasStatus = true;
      tests.push((i) => (s === 'open' ? statusOf(i) !== 'done' : statusOf(i) === s));
    } else if (key === 'cat' || key === 'category') {
      tests.push((i) => (i.category ?? '').toLowerCase().includes(value));
    } else if (key === 'due') {
      tests.push((i) => dueMatches(i, value));
    } else {
      words.push(raw);
    }
  }
  const match = (item) => {
    if (!tests.every((t) => t(item))) return false;
    if (!words.length) return true;
    const haystack = `${item.text} ${item.description ?? ''} ${item.category ?? ''} ${projectName(item.projectId)}`.toLowerCase();
    return words.every((w) => haystack.includes(w));
  };
  match.hasStatus = hasStatus;
  match.active = tests.length + words.length > 0;
  return match;
}
