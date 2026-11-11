// Task statuses and category colours, with the names and colours set in Settings → Labels.
// The seven status keys are fixed: search (is:), the board columns, the sort order and automations rely on them.
// Only a status's name, colour, place in the pickers and whether pickers offer it can change. todos.json keeps the
// overrides as `statuses: { [key]: { name, color, hidden } }` and the order as `statusOrder: [key]`, and a category's
// colour as `color` on the category.

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

// The saved order, with any key it lacks (or an unknown one) falling back to the default order.
function orderedStatuses(order) {
  const rank = (key) => {
    const i = (order ?? []).indexOf(key);
    return i < 0 ? 100 + STATUSES.findIndex(([k]) => k === key) : i;
  };
  return [...STATUSES].sort((a, b) => rank(a[0]) - rank(b[0]));
}

// [{ key, name, defaultName, tone, color, hidden }] with the saved overrides and order applied.
export function taskStatuses(store) {
  const { statuses: own = {}, statusOrder } = store.get('todos');
  return orderedStatuses(statusOrder).map(([key, defaultName, tone]) => ({
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

// Task category names in their saved order, then any name only a task carries, A to Z.
export function taskCategoryNames(store) {
  const { categories = [], items = [] } = store.get('todos');
  const saved = categories.map((c) => c.name);
  const extra = [...new Set(items.map((i) => i.category).filter((n) => n && !saved.includes(n)))];
  return [...saved, ...extra.sort((a, b) => a.localeCompare(b))];
}

// The colour of a task category, matched by name since tasks store the name. '' when it has none.
export function categoryColor(store, name) {
  if (!name) return '';
  return (store.get('todos').categories ?? []).find((c) => sameLower(c.name, name))?.color ?? '';
}

// The project labels a category scoped to labels applies to. Older files saved one label as `projectCategoryId`.
export function categoryLabelIds(c) {
  if (c.scope !== 'projectCategory') return [];
  return c.projectCategoryIds ?? (c.projectCategoryId ? [c.projectCategoryId] : []);
}

// Task categories once a project label is gone: one scoped to it moves to `targetId`, or only loses that label.
// A category left with no label is dropped, as it would apply to no project.
export function withoutLabel(categories, id, targetId = null) {
  return categories.flatMap((c) => {
    const ids = categoryLabelIds(c);
    if (!ids.includes(id)) return [c];
    const next = [...new Set(ids.map((x) => (x === id ? targetId : x)).filter(Boolean))];
    if (!next.length) return [];
    const { projectCategoryId, ...rest } = c;
    return [{ ...rest, projectCategoryIds: next }];
  });
}
