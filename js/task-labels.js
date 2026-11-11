// Task statuses and category colours, with the names and colours set in Settings → Labels.
// The seven status keys are fixed: search (is:), the board columns, the sort order and automations rely on them.
// Only a status's name, colour and whether pickers offer it can change. todos.json keeps the overrides as
// `statuses: { [key]: { name, color, hidden } }`, and a category's colour as `color` on the category.

// [key, default name, palette tone], in picker order.
export const STATUSES = [
  ['todo', 'To do', 'todo'],
  ['blocked', 'Blocked', 'high'],
  ['paused', 'Paused', 'plain'],
  ['ondeck', 'On Deck', 'low'],
  ['doing', 'In progress', 'doing'],
  ['review', 'In Review', 'medium'],
  ['done', 'Completed', 'done'],
];

// A new task starts in one and the done button moves it to the other, so neither can be hidden.
export const ALWAYS_SHOWN = ['todo', 'done'];

const sameLower = (a, b) => a.trim().toLowerCase() === b.trim().toLowerCase();

// [{ key, name, defaultName, tone, color, hidden }] with the saved overrides applied.
export function taskStatuses(store) {
  const own = store.get('todos').statuses ?? {};
  return STATUSES.map(([key, defaultName, tone]) => ({
    key,
    name: own[key]?.name || defaultName,
    defaultName,
    tone,
    color: own[key]?.color || '',
    hidden: !ALWAYS_SHOWN.includes(key) && Boolean(own[key]?.hidden),
  }));
}

export const statusName = (store, key) => taskStatuses(store).find((s) => s.key === key)?.name ?? key;

// How a status pill looks: its own colour when one is set, otherwise its palette tone.
export const statusLook = (s) => (s.color ? { color: s.color } : { tone: s.tone });

// Picker options. A hidden status is left out, except for the task that already has it.
export function statusOptions(store, current = null) {
  return taskStatuses(store)
    .filter((s) => !s.hidden || s.key === current)
    .map((s) => ({ value: s.key, label: s.name, ...statusLook(s) }));
}

// The colour of a task category, matched by name since tasks store the name. '' when it has none.
export function categoryColor(store, name) {
  if (!name) return '';
  return (store.get('todos').categories ?? []).find((c) => sameLower(c.name, name))?.color ?? '';
}
