import { h, uid, now, icon, statusOf, empty, notice } from '../ui.js';
import { createProject, projectIcon, labelsOf, projectTree, moveProject, labelColor } from './projects.js';
import { editText, pickChip } from '../inline.js';
import { repoStats } from '../github.js';
import { ask, parseJson } from '../ai.js';
import { setupBanner, hasOpenRouter } from '../integrations.js';

const COLLECTION = 'todos';
const STATUSES = [
  ['todo', 'To do'],
  ['blocked', 'Blocked'],
  ['paused', 'Paused'],
  ['ondeck', 'On Deck'],
  ['doing', 'In progress'],
  ['review', 'In Review'],
  ['done', 'Completed'],
];
// Each status uses one of the palette tones, so pills stay consistent across the app.
const STATUS_TONE = { todo: 'todo', blocked: 'high', paused: 'plain', ondeck: 'low', doing: 'doing', review: 'medium', done: 'done' };
const PRIORITIES = [
  ['none', 'No priority'],
  ['low', 'Low'],
  ['medium', 'Medium'],
  ['high', 'High'],
];
const STATUS_FILTERS = [['open', 'Open'], ['all', 'All'], ...STATUSES];
const STATUS_ORDER = Object.fromEntries(STATUSES.map(([key], i) => [key, i]));
const PRIORITY_ORDER = { high: 0, medium: 1, low: 2, none: 3 };
const NO_CATEGORY = '__none';

// View state lives here so it survives re-renders.
// filter: 'all' | 'personal' | <project id>. status: a STATUS_FILTERS key. category: '' means any.
// sort: { key, dir }. colFilter: per-column filters. An empty value means "any".
const view = {
  filter: 'all',
  status: 'open',
  category: '',
  expanded: new Set(),
  dragId: null,
  managingCategories: false,
  creatingProject: false,
  catError: '',
  showProject: false,
  sort: { key: '', dir: 'asc' },
  colFilter: { text: '', status: '', priority: '', project: '', category: '' },
  tidy: { status: 'idle', items: [] },
};

const isProjectFilter = (f) => f !== 'all' && f !== 'personal';
const matchesFilter = (item) =>
  view.filter === 'all' || (view.filter === 'personal' ? item.projectId === null : item.projectId === view.filter);
const matchesStatus = (item) => {
  const s = statusOf(item);
  if (view.status === 'open') return s !== 'done';
  return view.status === 'all' || s === view.status;
};
const matchesCategory = (item) => !view.category || item.category === view.category;
const matchesColumns = (item) => {
  const f = view.colFilter;
  if (f.text && !item.text.toLowerCase().includes(f.text.toLowerCase())) return false;
  if (f.status && statusOf(item) !== f.status) return false;
  if (f.priority && (item.priority ?? 'none') !== f.priority) return false;
  if (f.project && (f.project === 'none' ? item.projectId !== null : item.projectId !== f.project)) return false;
  if (f.category && (f.category === NO_CATEGORY ? Boolean(item.category) : item.category !== f.category)) return false;
  return true;
};
const projectsOf = (store) => store.get('projects').projects;
const formValues = (form) => Object.fromEntries(new FormData(form));
const sameLower = (a, b) => a.trim().toLowerCase() === b.trim().toLowerCase();
const label = (list, key) => list.find(([k]) => k === key)?.[1] ?? '';

// Task categories. Each has a scope: 'all' (every project), 'project' (one project),
// or 'projectCategory' (every project in a project category such as Web).
const todoCategories = (store) => store.get(COLLECTION).categories ?? [];

// Names a todo in this project can use: general ones, plus those scoped to the project or its category.
function categoriesFor(store, projectId) {
  const project = projectsOf(store).find((p) => p.id === projectId);
  return todoCategories(store)
    .filter((c) =>
      c.scope === 'all' ||
      (c.scope === 'project' && c.projectId === projectId) ||
      (c.scope === 'projectCategory' && Boolean(project) && labelsOf(project).includes(c.projectCategoryId)))
    .map((c) => c.name);
}

// Select values: "all", "project:<id>", "category:<project category id>".
function parseScope(value) {
  if (value.startsWith('project:')) return { scope: 'project', projectId: value.slice(8), projectCategoryId: null };
  if (value.startsWith('category:')) return { scope: 'projectCategory', projectId: null, projectCategoryId: value.slice(9) };
  return { scope: 'all', projectId: null, projectCategoryId: null };
}
function scopeValue(c) {
  if (c.scope === 'project') return `project:${c.projectId}`;
  if (c.scope === 'projectCategory') return `category:${c.projectCategoryId}`;
  return 'all';
}

// "buy milk #home" files the item under project "home" (created if missing).
// Extra lines from a multi-line paste arrive as the description.
function addItem(store, raw, description = '') {
  let text = raw.trim();
  const tag = text.match(/(?:^|\s)#([\w-]+)/);
  if (tag) text = text.replace(tag[0], ' ').replace(/\s+/g, ' ').trim();
  if (!text) return;

  let projectId = isProjectFilter(view.filter) ? view.filter : null;
  if (tag) {
    const project = projectsOf(store).find((p) => p.name.toLowerCase() === tag[1].toLowerCase())
      ?? createProject(store, tag[1]).project;
    projectId = project.id;
  }
  store.update(COLLECTION, (d) =>
    d.items.push({ id: uid(), text, description, status: 'todo', priority: 'none', category: '', projectId, created: now() }));
}

// Pasting several lines: first non-empty line is the title, the rest is the description.
function pasteAsTodo(store, e) {
  const raw = e.clipboardData?.getData('text/plain') ?? '';
  if (!/\r?\n/.test(raw.trim())) return; // single line: let the browser paste normally
  e.preventDefault();
  const lines = raw.split(/\r?\n/);
  const first = lines.findIndex((l) => l.trim());
  if (first < 0) return;
  addItem(store, lines[first], lines.slice(first + 1).join('\n').trim());
}

// Every edit to a todo goes through here. A status change also drops the legacy `done` flag.
function updateItem(store, id, patch) {
  store.update(COLLECTION, (d) => {
    const item = d.items.find((i) => i.id === id);
    if (!item) return;
    Object.assign(item, patch);
    if ('status' in patch) delete item.done;
  });
}

const removeItem = (store, id) =>
  store.update(COLLECTION, (d) => {
    d.items = d.items.filter((i) => i.id !== id);
  });

// Creates a todo category from a todo's category picker. It is scoped to that todo's project, if it has one.
function createTodoCategory(store, name, projectId) {
  const existing = todoCategories(store).find((c) => sameLower(c.name, name));
  if (!existing) {
    store.update(COLLECTION, (d) =>
      d.categories.push({ id: uid(), name, ...(projectId ? parseScope(`project:${projectId}`) : parseScope('all')) }));
  }
  return name;
}

function saveTodoCategory(store, id, name, scope) {
  if (!name) return;
  if (todoCategories(store).some((c) => c.id !== id && sameLower(c.name, name))) {
    view.catError = `"${name}" already exists.`;
    return store.refresh();
  }
  view.catError = '';
  store.update(COLLECTION, (d) => {
    const c = d.categories.find((x) => x.id === id);
    if (c) Object.assign(c, { name }, parseScope(scope));
  });
}

function addTodoCategory(store, v) {
  const name = v.name.trim();
  if (!name) return;
  if (todoCategories(store).some((c) => sameLower(c.name, name))) {
    view.catError = `"${name}" already exists.`;
    return store.refresh();
  }
  view.catError = '';
  store.update(COLLECTION, (d) => d.categories.push({ id: uid(), name, ...parseScope(v.scope) }));
}

function deleteTodoCategory(store, c) {
  if (!confirm(`Delete category "${c.name}"? Todos keep their label.`)) return;
  store.update(COLLECTION, (d) => {
    d.categories = d.categories.filter((x) => x.id !== c.id);
  });
}

const toggleExpanded = (store, id) => {
  if (view.expanded.has(id)) view.expanded.delete(id);
  else view.expanded.add(id);
  store.refresh();
};

// Used by drag-and-drop onto a sidebar list. projectId null means Personal.
const moveToProject = (store, id, projectId) => updateItem(store, id, { projectId });

// Move `id` next to `targetId` (before it, or after it when `after` is true).
// The stored array order is the display order, so this is the reorder.
function moveItem(store, id, targetId, after) {
  if (id === targetId) return;
  store.update(COLLECTION, (d) => {
    const from = d.items.findIndex((i) => i.id === id);
    if (from < 0) return;
    const [item] = d.items.splice(from, 1);
    let to = d.items.findIndex((i) => i.id === targetId);
    if (to < 0) to = from;
    d.items.splice(after ? to + 1 : to, 0, item);
  });
}

// Drop indicator: above or below the row depending on pointer position.
function dropSide(e) {
  const r = e.currentTarget.getBoundingClientRect();
  return e.clientY > r.top + r.height / 2 ? 'after' : 'before';
}
function clearDropMarks(el) {
  el.classList.remove('drop-before', 'drop-after');
}

// The project currently being dragged in the sidebar (a task drag uses view.dragId).
let dragProjectId = null;

// Sorting by a column replaces the stored order, so drag-to-reorder is off while a sort is active.
const reorderEnabled = () => !view.sort.key;

// One todo row. Title, description, and the pickers all edit in place.
// ctx: { store, projects, projectLabel }
function todoRow(store, item, ctx) {
  const expanded = view.expanded.has(item.id);
  const status = statusOf(item);
  const priority = item.priority ?? 'none';
  const hasDescription = Boolean(item.description);
  const projectOptions = [...ctx.projects].sort((a, b) => a.name.localeCompare(b.name))
    .map((p) => ({ value: p.id, label: p.name, color: p.color }));
  const categoryNames = categoriesFor(store, item.projectId);
  if (item.category && !categoryNames.includes(item.category)) categoryNames.push(item.category);

  return h('li', {
    class: status === 'done' ? 'todo-item done' : 'todo-item',
    'data-id': item.id,
    ondragstart: (e) => {
      if (!reorderEnabled()) return e.preventDefault();
      view.dragId = item.id;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', item.id); // Firefox needs data to start a drag
      e.currentTarget.classList.add('dragging');
    },
    ondragend: (e) => {
      view.dragId = null;
      e.currentTarget.draggable = false;
      e.currentTarget.classList.remove('dragging');
    },
    ondragover: (e) => {
      if (!reorderEnabled() || !view.dragId || view.dragId === item.id) return;
      e.preventDefault();
      const side = dropSide(e);
      e.currentTarget.classList.toggle('drop-before', side === 'before');
      e.currentTarget.classList.toggle('drop-after', side === 'after');
    },
    ondragleave: (e) => clearDropMarks(e.currentTarget),
    ondrop: (e) => {
      if (!reorderEnabled() || !view.dragId) return;
      e.preventDefault();
      const after = dropSide(e) === 'after';
      clearDropMarks(e.currentTarget);
      moveItem(store, view.dragId, item.id, after);
      view.dragId = null;
    },
  },
    h('div', { class: 'todo-row' },
      h('span', {
        class: 'grip',
        title: reorderEnabled() ? 'Drag to reorder' : 'Clear the sort to reorder',
        'aria-label': 'Drag to reorder',
        // Only the grip makes the row draggable, so text stays selectable.
        onpointerdown: (e) => {
          if (reorderEnabled()) e.currentTarget.closest('li').draggable = true;
        },
      }, icon('grip')),
      h('input', {
        type: 'checkbox',
        checked: status === 'done',
        'aria-label': `Mark "${item.text}" done`,
        onchange: (e) => updateItem(store, item.id, { status: e.target.checked ? 'done' : 'todo' }),
      }),
      h('div', { class: 'todo-title-cell' },
        editText({
          value: item.text,
          placeholder: 'Untitled',
          className: 'todo-title',
          onSave: (text) => updateItem(store, item.id, { text }),
        })),
      h('div', { class: 'todo-meta' },
        pickChip({
          value: status,
          options: STATUSES.map(([v, l]) => ({ value: v, label: l, tone: STATUS_TONE[v] })),
          onPick: (v) => updateItem(store, item.id, { status: v }),
        }),
        pickChip({
          value: priority,
          options: PRIORITIES.map(([v, l]) => ({ value: v, label: l, tone: v === 'none' ? 'plain' : v })),
          onPick: (v) => updateItem(store, item.id, { priority: v }),
        }),
        pickChip({
          value: item.projectId ?? null,
          options: projectOptions,
          nullable: true,
          nullLabel: 'Personal',
          onPick: (v) => moveToProject(store, item.id, v),
        }),
        pickChip({
          value: item.category || null,
          options: categoryNames.map((c) => ({ value: c, label: c })),
          nullable: true,
          nullLabel: 'No category',
          allowCreate: true,
          onPick: (v) => updateItem(store, item.id, { category: v ?? '' }),
          onCreate: (name) => updateItem(store, item.id, { category: createTodoCategory(store, name, item.projectId) }),
        })),
      h('div', { class: 'todo-actions' },
        hasDescription
          ? h('span', { class: 'desc-indicator', title: 'Has a description', 'aria-label': 'Has a description' }, icon('align-left'))
          : null,
        h('button', {
          type: 'button',
          class: expanded ? 'icon-btn chevron open' : 'icon-btn chevron',
          title: expanded ? 'Hide description' : 'Show description',
          'aria-label': expanded ? 'Hide description' : 'Show description',
          'aria-expanded': String(expanded),
          onclick: () => toggleExpanded(store, item.id),
        }, icon('chevron-down')),
        h('button', {
          type: 'button',
          class: 'icon-btn',
          title: 'Delete',
          'aria-label': `Delete "${item.text}"`,
          onclick: () => removeItem(store, item.id),
        }, icon('x')))),

    expanded
      ? h('div', { class: 'todo-desc' },
          editText({
            value: item.description,
            placeholder: 'Add a description… paste notes, links, steps',
            rich: true,
            multiline: true,
            allowEmpty: true,
            onSave: (description) => updateItem(store, item.id, { description }),
          }))
      : null);
}

// --- Sorting and column filters ---

const columnValue = (item, key, projects) => {
  if (key === 'text') return item.text.toLowerCase();
  if (key === 'status') return STATUS_ORDER[statusOf(item)];
  if (key === 'priority') return PRIORITY_ORDER[item.priority ?? 'none'];
  if (key === 'project') return (projects.find((p) => p.id === item.projectId)?.name ?? 'Personal').toLowerCase();
  return (item.category || '￿').toLowerCase(); // empty categories sort last
};

function sortItems(items, projects) {
  const { key, dir } = view.sort;
  if (!key) return items;
  const sign = dir === 'desc' ? -1 : 1;
  return [...items].sort((a, b) => {
    const x = columnValue(a, key, projects);
    const y = columnValue(b, key, projects);
    const cmp = typeof x === 'number' ? x - y : String(x).localeCompare(String(y));
    return cmp * sign;
  });
}

// Click a column title: ascending, then descending, then back to manual order.
function cycleSort(store, key) {
  if (view.sort.key !== key) view.sort = { key, dir: 'asc' };
  else if (view.sort.dir === 'asc') view.sort = { key, dir: 'desc' };
  else view.sort = { key: '', dir: 'asc' };
  store.refresh();
}

const sortMark = (key) => (view.sort.key !== key ? '' : view.sort.dir === 'asc' ? ' ↑' : ' ↓');

function columnHeader(store, key, text) {
  return h('button', {
    type: 'button',
    class: view.sort.key === key ? 'th-btn sorted' : 'th-btn',
    title: `Sort by ${text}`,
    onclick: () => cycleSort(store, key),
  }, text + sortMark(key));
}

// Filter row under the headers, one control per column, aligned with the rows.
function columnFilters(store, projects, categories) {
  const f = view.colFilter;
  const set = (key) => (e) => {
    view.colFilter = { ...view.colFilter, [key]: e.target.value };
    store.refresh();
  };
  const select = (key, options) =>
    h('select', { value: f[key], 'aria-label': `Filter ${key}`, onchange: set(key) },
      h('option', { value: '' }, 'Any'),
      options.map(([v, l]) => h('option', { value: v }, l)));
  return h('div', { class: 'todo-row todo-filters' },
    h('span'), h('span'),
    h('input', {
      type: 'search',
      value: f.text,
      placeholder: 'Filter titles',
      'aria-label': 'Filter titles',
      onchange: set('text'),
    }),
    select('status', STATUSES),
    select('priority', PRIORITIES),
    select('project', [['none', 'Personal'], ...projects.map((p) => [p.id, p.name])]),
    select('category', [[NO_CATEGORY, 'No category'], ...categories.map((c) => [c, c])]),
    h('span', null, Object.values(f).some(Boolean) || view.sort.key
      ? h('button', {
          type: 'button',
          class: 'btn-small',
          onclick: () => {
            view.colFilter = { text: '', status: '', priority: '', project: '', category: '' };
            view.sort = { key: '', dir: 'asc' };
            store.refresh();
          },
        }, 'Reset')
      : null));
}

// --- AI: tidy todo titles (task 3) ---

const TIDY_PROMPT = [
  'You clean up a personal todo list.',
  'Reply with JSON only: an array of objects {"id","title","category","priority"}.',
  'title: a short, clear action sentence in the same language as the original.',
  'category: one short word, or an empty string if none fits.',
  'priority: one of "none", "low", "medium", "high".',
  'Keep every id exactly as given. Include only items you would change.',
].join(' ');

async function runTidy(store) {
  const open = store.get(COLLECTION).items.filter((i) => statusOf(i) !== 'done').slice(0, 40);
  if (!open.length) {
    view.tidy = { status: 'ok', items: [] };
    return store.refresh();
  }
  view.tidy = { status: 'loading', items: [] };
  store.refresh();
  try {
    const reply = await ask(store, 'task-tidy', [
      { role: 'system', content: TIDY_PROMPT },
      { role: 'user', content: JSON.stringify(open.map((i) => ({ id: i.id, title: i.text, category: i.category || '', priority: i.priority ?? 'none' }))) },
    ]);
    const parsed = parseJson(reply);
    const list = Array.isArray(parsed) ? parsed : parsed.items ?? [];
    const known = new Map(open.map((i) => [i.id, i]));
    const items = list
      .filter((s) => s && known.has(s.id))
      .map((s) => {
        const before = known.get(s.id);
        const priority = PRIORITIES.some(([k]) => k === s.priority) ? s.priority : before.priority ?? 'none';
        return { id: s.id, title: String(s.title ?? '').trim() || before.text, category: String(s.category ?? '').trim(), priority };
      })
      .filter((s) => s.title !== known.get(s.id).text || s.category !== (known.get(s.id).category || '') || s.priority !== (known.get(s.id).priority ?? 'none'));
    view.tidy = { status: 'ok', items };
  } catch (err) {
    view.tidy = { status: 'error', error: err.message };
  }
  store.refresh();
}

function applyTidy(store, s) {
  updateItem(store, s.id, { text: s.title, category: s.category, priority: s.priority });
  view.tidy.items = view.tidy.items.filter((x) => x.id !== s.id);
  store.refresh();
}

function tidyPanel(store) {
  const t = view.tidy;
  if (t.status === 'idle' && !hasOpenRouter(store)) return setupBanner('openrouter', 'Tidy with AI needs an OpenRouter key.');
  const dismiss = h('button', { type: 'button', class: 'btn-small', onclick: () => { view.tidy = { status: 'idle', items: [] }; store.refresh(); } }, 'Dismiss');
  if (t.status === 'loading') return h('div', { class: 'panel-mini' }, 'Asking the model…');
  if (t.status === 'error') return notice({ text: t.error, actions: [dismiss] });
  if (t.status !== 'ok') return null;
  if (!t.items.length) return h('div', { class: 'panel-mini' }, 'Nothing to tidy. ', dismiss);
  const items = store.get(COLLECTION).items;
  return h('div', { class: 'panel-mini' },
    h('div', { class: 'row between' },
      h('strong', null, `${t.items.length} suggestion${t.items.length > 1 ? 's' : ''}`),
      h('div', { class: 'row' },
        h('button', {
          type: 'button',
          class: 'btn-small primary',
          onclick: () => {
            t.items.forEach((s) => updateItem(store, s.id, { text: s.title, category: s.category, priority: s.priority }));
            view.tidy = { status: 'idle', items: [] };
            store.refresh();
          },
        }, 'Apply all'),
        dismiss)),
    h('ul', { class: 'tidy-list' },
      t.items.map((s) => {
        const before = items.find((i) => i.id === s.id);
        return h('li', null,
          h('span', { class: 'muted' }, before?.text ?? ''),
          h('span', { class: 'arrow' }, '→'),
          h('strong', null, s.title),
          s.category ? h('span', { class: 'tag' }, s.category) : null,
          s.priority !== 'none' ? h('span', { class: `pill tone-${s.priority}` }, label(PRIORITIES, s.priority)) : null,
          h('button', { type: 'button', class: 'btn-small', onclick: () => applyTidy(store, s) }, 'Apply'));
      })));
}

// --- Project bar and details ---

// Project summary under the title. "Show more" reveals the project's details.
// The labels a project carries, as objects with names.
const labelsFor = (store, p) => labelsOf(p)
  .map((id) => (store.get('projects').categories ?? []).find((c) => c.id === id))
  .filter(Boolean);

// Inline after the title: labels, open count, and a toggle for the details panel.
function projectMeta(store, p) {
  if (!p) return null;
  const open = store.get(COLLECTION).items.filter((i) => i.projectId === p.id && statusOf(i) !== 'done').length;
  return h('span', { class: 'row meta-inline' },
    labelsFor(store, p).map((l) => h('span', { class: 'pill tone-custom', style: { '--c': labelColor(l) } }, l.name)),
    h('span', { class: 'muted small' }, `${open} open`),
    h('button', {
      type: 'button',
      class: 'btn-small',
      'aria-expanded': String(view.showProject),
      onclick: () => {
        view.showProject = !view.showProject;
        store.refresh();
      },
    }, view.showProject ? 'Less' : 'More'));
}

function projectDetails(store, p) {
  const items = store.get(COLLECTION).items.filter((i) => i.projectId === p.id);
  const done = items.filter((i) => statusOf(i) === 'done').length;
  // Repo counts load in the background; the page refreshes when they arrive, but only while on this list.
  const onLoad = () => {
    if (location.hash.startsWith('#/todos')) store.refresh();
  };
  return h('div', { class: 'project-details stack' },
    p.description ? h('p', null, p.description) : h('p', { class: 'muted' }, 'No description yet. Use the pencil to add one.'),
    h('div', { class: 'stats' },
      h('div', null, h('strong', null, String(items.length - done)), h('span', { class: 'muted' }, 'open')),
      h('div', null, h('strong', null, String(done)), h('span', { class: 'muted' }, 'done')),
      labelsFor(store, p).length
        ? h('div', null, h('strong', null, labelsFor(store, p).map((l) => l.name).join(', ')), h('span', { class: 'muted' }, 'labels'))
        : null),
    p.website ? h('p', null, h('a', { href: p.website, target: '_blank', rel: 'noopener' }, p.website)) : null,
    p.github.org ? h('p', null, 'GitHub: ', h('a', { href: `https://github.com/${p.github.org}`, target: '_blank', rel: 'noopener' }, p.github.org)) : null,
    p.github.repos.length
      ? h('ul', { class: 'repo-summary' },
          p.github.repos.map((r) => {
            const s = repoStats(r, onLoad);
            const text = s.status === 'ok' ? `${s.issues} issues · ${s.prs} PRs` : s.status === 'loading' ? 'loading…' : s.error;
            return h('li', null,
              h('a', { href: `https://github.com/${r}`, target: '_blank', rel: 'noopener' }, r),
              h('span', { class: 'muted' }, text));
          }))
      : null);
}

// --- Category manager ---

// Manager card: name and scope of every todo category, edited in place.
function categoriesManager(store) {
  const projects = projectsOf(store);
  const projectCategories = store.get('projects').categories ?? [];
  const scopeOptions = () => [
    h('option', { value: 'all' }, 'All projects'),
    h('optgroup', { label: 'One project' },
      [...projects].sort((a, b) => a.name.localeCompare(b.name)).map((p) => h('option', { value: `project:${p.id}` }, p.name))),
    h('optgroup', { label: 'Projects in a category' },
      projectCategories.map((c) => h('option', { value: `category:${c.id}` }, c.name))),
  ];
  const scopeLabel = (c) => {
    if (c.scope === 'project') return projects.find((p) => p.id === c.projectId)?.name ?? 'Missing project';
    if (c.scope === 'projectCategory') return `Category: ${projectCategories.find((x) => x.id === c.projectCategoryId)?.name ?? 'Missing'}`;
    return 'All projects';
  };
  const cats = todoCategories(store);

  return h('section', { class: 'panel-mini stack' },
    h('div', { class: 'row between' },
      h('strong', null, 'Task categories'),
      h('button', {
        type: 'button',
        class: 'btn-small',
        onclick: () => {
          view.managingCategories = false;
          store.refresh();
        },
      }, 'Done')),
    h('p', { class: 'muted small' }, 'General categories apply to every project. Scope one to a single project, or to all projects in a project category. Click a name or scope to change it.'),
    view.catError ? h('p', { class: 'error', role: 'alert' }, view.catError) : null,
    cats.length
      ? h('ul', { class: 'cat-list' },
          cats.map((c) =>
            h('li', { class: 'cat-row' },
              editText({
                value: c.name,
                placeholder: 'Name',
                className: 'cat-name',
                onSave: (name) => saveTodoCategory(store, c.id, name, scopeValue(c)),
              }),
              h('label', { class: 'cat-scope' },
                h('select', {
                  value: scopeValue(c),
                  'aria-label': `Applies to for ${c.name}`,
                  onchange: (e) => saveTodoCategory(store, c.id, c.name, e.target.value),
                }, scopeOptions())),
              h('span', { class: 'muted small' }, scopeLabel(c)),
              h('button', { type: 'button', class: 'icon-btn', title: 'Delete', 'aria-label': `Delete ${c.name}`, onclick: () => deleteTodoCategory(store, c) }, icon('x')))))
      : empty('No todo categories yet. Add one below.'),
    h('form', {
      class: 'row',
      onsubmit: (e) => {
        e.preventDefault();
        addTodoCategory(store, formValues(e.currentTarget));
      },
    },
      h('input', { name: 'name', placeholder: 'New category, e.g. errands', 'aria-label': 'New category', class: 'grow', autocomplete: 'off' }),
      h('select', { name: 'scope', 'aria-label': 'Applies to' }, scopeOptions()),
      h('button', { class: 'primary', type: 'submit' }, 'Add')));
}

// --- Page ---

function draw(root, store) {
  const projects = projectsOf(store);
  const { items } = store.get(COLLECTION);
  if (isProjectFilter(view.filter) && !projects.some((p) => p.id === view.filter)) view.filter = 'all';

  const categories = [...new Set([...todoCategories(store).map((c) => c.name), ...items.map((i) => i.category).filter(Boolean)])]
    .sort((a, b) => a.localeCompare(b));
  if (view.category && !categories.includes(view.category)) view.category = '';

  const openCount = (pred) => items.filter((i) => statusOf(i) !== 'done' && pred(i)).length;
  const projectName = (id) => projects.find((p) => p.id === id)?.name ?? '';
  const currentLabel =
    view.filter === 'all' ? 'All' : view.filter === 'personal' ? 'Personal' : projectName(view.filter);

  // Personal and project lists accept dropped todos; "All" does not, since it has no project.
  const navItem = (key, text, count, leading) => {
    const accepts = key !== 'all';
    return h('button', {
      type: 'button',
      class: view.filter === key ? 'nav-item active' : 'nav-item',
      onclick: () => {
        view.filter = key;
        store.refresh();
      },
      ondragover: (e) => {
        if (!accepts || !view.dragId) return;
        e.preventDefault();
        e.currentTarget.classList.add('drop-target');
      },
      ondragleave: (e) => e.currentTarget.classList.remove('drop-target'),
      ondrop: (e) => {
        if (!accepts || !view.dragId) return;
        e.preventDefault();
        e.currentTarget.classList.remove('drop-target');
        moveToProject(store, view.dragId, key === 'personal' ? null : key);
        view.dragId = null;
      },
    },
      leading ?? null,
      h('span', { class: 'grow' }, text),
      h('span', { class: 'count' }, String(count)));
  };

  // Filters first, then the sort. Manual order is kept when no sort is active.
  const visible = sortItems(
    items.filter((i) => matchesFilter(i) && matchesStatus(i) && matchesCategory(i) && matchesColumns(i)),
    projects,
  );
  const columnsActive = Object.values(view.colFilter).some(Boolean);

  root.replaceChildren(
    h('div', { class: 'split' },
      h('aside', { class: 'card side' },
        h('div', { class: 'row between' },
          h('h2', null, 'Lists'),
          h('span', { class: 'muted small' }, 'drag onto a list to move')),
        navItem('all', 'All', openCount(() => true)),
        navItem('personal', 'Personal', openCount((i) => i.projectId === null)),
        h('div', { class: 'row between' },
          h('h2', null, 'Projects'),
          h('div', { class: 'row' },
            h('button', {
              type: 'button',
              class: 'icon-btn',
              title: 'New project',
              'aria-label': 'New project',
              onclick: () => {
                view.creatingProject = !view.creatingProject;
                store.refresh();
              },
            }, icon('plus')),
            h('a', { href: '#/projects', class: 'icon-btn', title: 'Edit projects', 'aria-label': 'Edit projects' }, icon('pencil')))),
        view.creatingProject
          ? h('form', {
              class: 'stack',
              onsubmit: (e) => {
                e.preventDefault();
                const name = formValues(e.currentTarget).name.trim();
                if (!name) return;
                const { project } = createProject(store, name);
                view.filter = project.id;
                view.creatingProject = false;
                store.refresh();
              },
            },
              h('input', { name: 'name', placeholder: 'Project name, Enter', 'aria-label': 'New project name', autocomplete: 'off', 'data-autofocus': true }))
          : null,
        projectTree(projects).map(({ project: p, depth }) =>
          h('div', {
            class: 'tree-row',
            style: { paddingLeft: `${depth * 14}px` },
            ondragstart: (e) => {
              dragProjectId = p.id;
              e.dataTransfer.effectAllowed = 'move';
              e.dataTransfer.setData('text/plain', p.id); // Firefox needs data to start a drag
              e.currentTarget.classList.add('dragging');
            },
            ondragend: (e) => {
              dragProjectId = null;
              e.currentTarget.draggable = false;
              e.currentTarget.classList.remove('dragging');
            },
            ondragover: (e) => {
              if (!dragProjectId || dragProjectId === p.id) return;
              e.preventDefault();
              const side = dropSide(e);
              e.currentTarget.classList.toggle('drop-before', side === 'before');
              e.currentTarget.classList.toggle('drop-after', side === 'after');
            },
            ondragleave: (e) => e.currentTarget.classList.remove('drop-before', 'drop-after'),
            ondrop: (e) => {
              if (!dragProjectId) return;
              e.preventDefault();
              e.currentTarget.classList.remove('drop-before', 'drop-after');
              moveProject(store, dragProjectId, p.id, dropSide(e) === 'after');
              dragProjectId = null;
            },
          },
            h('span', {
              class: 'grip project-grip',
              title: 'Drag to reorder projects',
              'aria-label': 'Drag to reorder project',
              // Only the grip makes the row draggable; a task dragged onto the name still files the task.
              onpointerdown: (e) => {
                e.currentTarget.closest('.tree-row').draggable = true;
              },
            }, icon('grip')),
            navItem(p.id, p.name, openCount((i) => i.projectId === p.id), projectIcon(p))))),

      h('section', { class: 'card main-pane' },
        h('div', { class: 'head-bar' },
          h('div', { class: 'row head-title' },
            h('h2', null, currentLabel),
            isProjectFilter(view.filter)
              ? h('a', { href: `#/projects?project=${view.filter}`, class: 'icon-btn', title: 'Open project', 'aria-label': 'Open project' }, icon('pencil'))
              : null,
            isProjectFilter(view.filter) ? projectMeta(store, projects.find((p) => p.id === view.filter)) : null),
          h('div', { class: 'row head-actions' },
            h('label', { class: 'inline' }, 'Show',
              h('select', {
                value: view.status,
                'aria-label': 'Filter by status',
                onchange: (e) => {
                  view.status = e.target.value;
                  store.refresh();
                },
              }, STATUS_FILTERS.map(([k, l]) => h('option', { value: k }, l)))),
            categories.length
              ? h('label', { class: 'inline' }, 'Category',
                  h('select', {
                    value: view.category,
                    'aria-label': 'Filter by category',
                    onchange: (e) => {
                      view.category = e.target.value;
                      store.refresh();
                    },
                  }, h('option', { value: '' }, 'All'),
                    categories.map((c) => h('option', { value: c }, c))))
              : null,
            h('button', {
              type: 'button',
              class: 'btn-small',
              disabled: view.tidy.status === 'loading',
              onclick: () => runTidy(store),
            }, 'Tidy with AI'),
            h('button', {
              type: 'button',
              class: 'btn-small',
              onclick: () => {
                view.managingCategories = !view.managingCategories;
                view.catError = '';
                store.refresh();
              },
            }, 'Labels'),
            h('span', { class: 'muted small' }, `${visible.length} shown`))),

        isProjectFilter(view.filter) && view.showProject
          ? projectDetails(store, projects.find((p) => p.id === view.filter))
          : null,

        view.managingCategories ? categoriesManager(store) : null,
        tidyPanel(store),

        h('form', {
          class: 'quick',
          onsubmit: (e) => {
            e.preventDefault();
            const input = e.currentTarget.querySelector('input[name="todo"]');
            addItem(store, input.value);
          },
        },
          h('input', {
            name: 'todo',
            placeholder: 'Add a task… #project to file it, paste several lines for a description',
            'aria-label': 'New todo',
            autocomplete: 'off',
            'data-autofocus': true,
            onpaste: (e) => pasteAsTodo(store, e),
          }),
          h('button', { class: 'primary', type: 'submit' }, 'Add')),

        h('div', { class: 'todo-table' },
          h('div', { class: 'todo-row todo-head' },
            h('span'), h('span'),
            columnHeader(store, 'text', 'Task'),
            columnHeader(store, 'status', 'Status'),
            columnHeader(store, 'priority', 'Priority'),
            columnHeader(store, 'project', 'Project'),
            columnHeader(store, 'category', 'Category'),
            h('span')),
          columnFilters(store, projects, categories),
          visible.length
            ? h('ul', { class: 'todo-list' },
                visible.map((item) =>
                  todoRow(store, item, {
                    store,
                    projects,
                    projectLabel: view.filter === 'all' ? projectName(item.projectId) : '',
                  })))
            : h('p', { class: 'empty' }, columnsActive || view.sort.key ? 'No todo matches these filters.' : 'Nothing matches these filters.')))));
}

export default {
  id: 'todos',
  title: 'Tasks',
  icon: 'check-square',
  collection: COLLECTION,
  defaults: { items: [], categories: [] },
  render: draw,
  // View state kept in the URL, so a refresh returns to the same list.
  serialize: () => ({
    filter: view.filter,
    status: view.status,
    category: view.category,
    more: view.showProject ? '1' : '',
    sort: view.sort.key ? `${view.sort.key}.${view.sort.dir}` : '',
  }),
  restore: (p = {}) => {
    view.filter = p.filter || 'all';
    view.status = p.status || 'open';
    view.category = p.category || '';
    view.showProject = p.more === '1';
    const [key = '', dir = 'asc'] = (p.sort ?? '').split('.');
    view.sort = { key: ['text', 'status', 'priority', 'project', 'category'].includes(key) ? key : '', dir: dir === 'desc' ? 'desc' : 'asc' };
  },
};
