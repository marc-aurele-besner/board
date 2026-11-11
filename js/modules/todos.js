import { h, uid, icon, statusOf, notice, todayISO } from '../ui.js';
import { makeTask } from '../capture.js';
import { AUTO_SOURCES } from '../automations.js';
import { toast } from '../toast.js';
import { createProject, projectIcon, labelsOf, projectTree, moveProject, labelColor } from './projects.js';
import { editText, pickChip, pickButton, pill } from '../inline.js';
import { repoStats, createIssue, getIssue, githubLink } from '../github.js';
import { openDialog } from '../modal.js';
import { ask, parseJson } from '../ai.js';
import { systemPrompt } from '../prompts.js';
import { setupBanner, hasOpenRouter } from '../integrations.js';
import { taskMatcher, QUERY_HINT } from '../task-query.js';
import { taskStatuses, statusName, statusOptions, statusLook, categoryColor, taskCategoryNames } from '../task-labels.js';

const COLLECTION = 'todos';
const PRIORITIES = [
  ['none', 'No priority'],
  ['low', 'Low'],
  ['medium', 'Medium'],
  ['high', 'High'],
];
// The "Show" filter: open, all, or one status by the name it has in Settings → Labels.
const statusFilters = (store) => [['open', 'Open'], ['all', 'All'], ...taskStatuses(store).map((s) => [s.key, s.name])];
const PRIORITY_ORDER = { high: 0, medium: 1, low: 2, none: 3 };
const NO_CATEGORY = '__none';
// Lists that are not a project: everything, no project, due today or late, waiting to be organized, made by a rule.
const SMART_LISTS = ['all', 'personal', 'today', 'organize', 'auto'];
// Ways to lay out the same tasks: [key, label, icon]. The list, status and column filters apply to all of them.
const LAYOUTS = [['table', 'Table', 'list'], ['board', 'Board', 'columns'], ['project', 'By project', 'folder'], ['status', 'By status', 'check-square']];
// In "By status", what is being worked on comes first and what is done comes last.
const STATUS_GROUP_ORDER = ['doing', 'review', 'ondeck', 'todo', 'blocked', 'paused', 'done'];

// Tasks open sorted by status, so what is being worked on is on top. An empty key means the manual (dragged) order.
const DEFAULT_SORT = { key: 'status', dir: 'asc' };
const isDefaultSort = (s) => s.key === DEFAULT_SORT.key && s.dir === DEFAULT_SORT.dir;

// View state lives here so it survives re-renders.
// filter: one of SMART_LISTS, or a project id. status: a statusFilters key. category: '' means any.
// sort: { key, dir }. colFilter: per-column filters. An empty value means "any".
// query: the search box, read by taskMatcher (words plus #project, !priority, is:status, cat:, due: tokens).
const view = {
  layout: 'table',
  query: '',
  filter: 'all',
  status: 'open',
  category: '',
  expanded: new Set(),
  // Ticked tasks, for the batch actions. Not saved: a reload starts with nothing selected.
  selected: new Set(),
  // The task last ticked, so Shift+click can tick everything between it and the next one.
  lastPicked: null,
  dragId: null,
  dragStatus: null,
  creatingProject: false,
  showProject: false,
  sort: { ...DEFAULT_SORT },
  colFilter: { text: '', status: '', priority: '', project: '', category: '' },
  tidy: { status: 'idle', items: [] },
};

const isProjectFilter = (f) => !SMART_LISTS.includes(f);
const matchesFilter = (item) => {
  const f = view.filter;
  if (f === 'all') return true;
  if (f === 'personal') return item.projectId === null;
  if (f === 'today') return Boolean(item.due) && item.due <= todayISO();
  if (f === 'organize') return Boolean(item.inbox);
  if (f === 'auto') return Boolean(item.auto);
  return item.projectId === f;
};
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
    d.items.push(makeTask({ text, description, projectId, due: view.filter === 'today' ? todayISO() : '' })));
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

// Every edit to a todo goes through here, one task or a batch. A status change also drops the legacy `done` flag.
function updateItems(store, ids, patch) {
  const pick = new Set(ids);
  store.update(COLLECTION, (d) => {
    for (const item of d.items) {
      if (!pick.has(item.id)) continue;
      Object.assign(item, patch);
      if ('status' in patch) delete item.done;
      // A task that got its project and its deadline no longer waits in "To Organize".
      if (item.inbox && item.projectId && item.due) delete item.inbox;
    }
  });
}
const updateItem = (store, id, patch) => updateItems(store, [id], patch);

// Deleting is immediate, with a few seconds to take it back.
function removeItem(store, id) {
  const items = store.get(COLLECTION).items;
  const index = items.findIndex((i) => i.id === id);
  if (index < 0) return;
  const removed = items[index];
  store.update(COLLECTION, (d) => {
    d.items = d.items.filter((i) => i.id !== id);
  });
  toast('Task deleted', { undo: () => store.update(COLLECTION, (d) => d.items.splice(Math.min(index, d.items.length), 0, removed)) });
}

// Deleting a batch, with the same few seconds to take it back.
function removeItems(store, ids) {
  const pick = new Set(ids);
  const before = store.get(COLLECTION).items;
  const count = before.filter((i) => pick.has(i.id)).length;
  if (!count) return;
  const snapshot = before.map((i) => ({ item: i, index: before.indexOf(i) })).filter(({ item }) => pick.has(item.id));
  view.selected.clear();
  store.update(COLLECTION, (d) => {
    d.items = d.items.filter((i) => !pick.has(i.id));
  });
  toast(`${count} task${count === 1 ? '' : 's'} deleted`, {
    undo: () => store.update(COLLECTION, (d) => {
      for (const { item, index } of snapshot) d.items.splice(Math.min(index, d.items.length), 0, item);
    }),
  });
}

// The deadline next to a title: today and late ones stand out.
function dueChip(item) {
  if (!item.due || statusOf(item) === 'done') return null;
  const today = todayISO();
  const label = new Date(`${item.due}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  if (item.due < today) return h('span', { class: 'due late' }, `Overdue · ${label}`);
  return h('span', { class: item.due === today ? 'due today' : 'due' }, item.due === today ? 'Today' : label);
}

// Time left until the end of the deadline day: hours on the last day, days before that.
function timeLeft(due) {
  const ms = new Date(`${due}T23:59:59`) - Date.now();
  const hours = Math.floor(Math.abs(ms) / 3_600_000);
  const plural = (n, unit) => `${n} ${unit}${n === 1 ? '' : 's'}`;
  const span = hours < 24 ? plural(Math.max(hours, 1), 'hour') : plural(Math.floor(hours / 24), 'day');
  return ms < 0 ? `${span} late` : `in ${span}`;
}

// The deadline in a task row: an icon button when none is set, the time left when one is.
// Both open the native date picker on a hidden input.
function dueControl(store, item) {
  const input = h('input', {
    type: 'date',
    class: 'due-picker',
    value: item.due ?? '',
    tabindex: '-1',
    'aria-hidden': 'true',
    onchange: (e) => updateItem(store, item.id, { due: e.target.value }),
  });
  const open = () => {
    try { input.showPicker(); } catch { input.focus(); }
  };
  const date = item.due ? new Date(`${item.due}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }) : '';
  const button = item.due
    ? h('button', { type: 'button', class: 'btn-small due-left', title: `Deadline: ${date}`, 'aria-label': `Deadline for "${item.text}": ${date}. Change it`, onclick: open }, timeLeft(item.due))
    : h('button', { type: 'button', class: 'icon-btn', title: 'Set a deadline', 'aria-label': `Set a deadline for "${item.text}"`, onclick: open }, icon('calendar'));
  return h('span', { class: 'due-control' }, button, input);
}

// The flag on a task the board created by itself, naming where it came from.
function autoBadge(item) {
  if (!item.auto) return null;
  const telegram = item.auto === 'telegram';
  return h('span', { class: 'auto-badge', title: `Created automatically by ${AUTO_SOURCES[item.auto] ?? 'a rule'}` }, icon(telegram ? 'send' : 'zap'), telegram ? 'Telegram' : 'Auto');
}

// A category on a card: in its colour when Settings → Labels gives it one, otherwise a plain tag.
function categoryTag(store, name) {
  if (!name) return null;
  const color = categoryColor(store, name);
  return color ? pill(name, { color }) : h('span', { class: 'tag' }, name);
}

// What a task in "To Organize" still needs.
const missingFor = (item) => [item.projectId ? '' : 'a project', item.due ? '' : 'a deadline'].filter(Boolean).join(' and ') || 'a look';

// Creates a todo category from a todo's category picker. It is scoped to that todo's project, if it has one.
function createTodoCategory(store, name, projectId) {
  const existing = todoCategories(store).find((c) => sameLower(c.name, name));
  if (!existing) {
    store.update(COLLECTION, (d) =>
      d.categories.push({ id: uid(), name, ...(projectId ? parseScope(`project:${projectId}`) : parseScope('all')) }));
  }
  return name;
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
// The status sort is stable and keeps the stored order within a status, so tasks of the same status can still be dragged.
const reorderEnabled = () => !view.sort.key || view.sort.key === 'status';
const canDropOn = (item) => !view.sort.key || view.dragStatus === statusOf(item);

// --- GitHub issues for a task ---

// "#12", "12" or a github.com issue link, as { repo, number }. null when the text is not an issue reference.
function parseIssueRef(text, defaultRepo) {
  const t = String(text ?? '').trim();
  const link = t.match(/github\.com\/([^/\s]+\/[^/\s]+)\/issues\/(\d+)/);
  if (link) return { repo: link[1], number: Number(link[2]) };
  const number = t.match(/^#?(\d+)$/);
  if (number) return { repo: defaultRepo, number: Number(number[1]) };
  return null;
}

// Creates a new issue for a task, or links an existing one. The task keeps the issue's repo, number, link and title.
function openIssueDialog(store, item, repos) {
  let repo = repos[0];
  let mode = 'create';
  const body = h('div', { class: 'stack' });
  const message = h('div', null);
  const dialog = openDialog({ title: 'GitHub issue', body: h('div', { class: 'stack' }, body, message) });

  const fail = (text) => message.replaceChildren(notice({ text }));
  const saved = (issue) => {
    updateItem(store, item.id, { issue });
    dialog.close();
  };
  const create = (title, text) => {
    createIssue(repo, title, text).then(saved).catch((err) => fail(err.message));
  };
  const link = (target, number) => {
    getIssue(target, number).then(saved).catch((err) => fail(err.message));
  };

  const paint = () => {
    const repoPick = repos.length > 1
      ? h('label', { class: 'bill-field' },
          h('span', { class: 'muted small' }, 'Repository'),
          h('select', {
            value: repo,
            onchange: (e) => {
              repo = e.target.value;
              paint();
            },
          }, repos.map((r) => h('option', { value: r }, r))))
      : h('p', { class: 'muted small' }, `Repository: ${repo}`);
    const modes = h('div', { class: 'segmented' },
      [['create', 'Create new'], ['link', 'Link existing']].map(([key, label]) =>
        h('button', {
          type: 'button',
          class: mode === key ? 'seg active' : 'seg',
          onclick: () => {
            mode = key;
            paint();
          },
        }, label)));
    const form = mode === 'create'
      ? h('form', {
          class: 'stack',
          onsubmit: (e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            create(String(f.get('title') ?? '').trim(), String(f.get('body') ?? '').trim());
          },
        },
          h('input', { name: 'title', value: item.text, required: true, 'aria-label': 'Issue title' }),
          h('textarea', { name: 'body', rows: 4, placeholder: 'Issue description', 'aria-label': 'Issue description' }, item.description ?? ''),
          h('div', { class: 'row end' }, h('button', { class: 'primary', type: 'submit' }, 'Create issue')))
      : h('form', {
          class: 'stack',
          onsubmit: (e) => {
            e.preventDefault();
            const ref = parseIssueRef(new FormData(e.currentTarget).get('ref'), repo);
            if (!ref) return fail('Enter an issue number like 12, or a github.com issue link.');
            link(ref.repo, ref.number);
          },
        },
          h('input', { name: 'ref', placeholder: '#12 or a github.com issue link', 'aria-label': 'Issue number or link' }),
          h('div', { class: 'row end' }, h('button', { class: 'primary', type: 'submit' }, 'Link issue')));
    const unlink = item.issue
      ? h('button', {
          type: 'button',
          class: 'btn-small danger',
          onclick: () => {
            updateItem(store, item.id, { issue: null });
            dialog.close();
          },
        }, `Unlink #${item.issue.number}`)
      : null;
    body.replaceChildren(repoPick, modes, form, unlink);
  };
  paint();
}

// The issue of a task as a link (#12, opens in a new tab), or a button to create or link one.
function issueControl(store, item, repos) {
  if (item.issue) {
    return h('a', {
      href: item.issue.url,
      target: '_blank',
      rel: 'noopener',
      class: 'issue-link',
      title: `${item.issue.repo} #${item.issue.number}: ${item.issue.title}`,
      'aria-label': `Open issue #${item.issue.number}`,
    }, icon('repo'), `#${item.issue.number}`);
  }
  return h('button', {
    type: 'button',
    class: 'icon-btn',
    title: 'Create or link a GitHub issue',
    'aria-label': 'Create or link a GitHub issue',
    onclick: () => openIssueDialog(store, item, repos),
  }, icon('repo'));
}

// A task as Markdown: a checklist line with its status, project and deadline, then its description indented.
function taskMarkdown(store, item, projects) {
  const status = statusOf(item);
  const project = projects.find((p) => p.id === item.projectId)?.name;
  const details = [status === 'done' ? '' : statusName(store, status), project, item.due ? `due ${item.due}` : ''].filter(Boolean);
  const head = `- [${status === 'done' ? 'x' : ' '}] ${item.text}${details.length ? ` (${details.join(' · ')})` : ''}`;
  const desc = (item.description ?? '').trim();
  return desc ? `${head}\n${desc.split(/\r?\n/).map((l) => `  ${l}`).join('\n')}` : head;
}

// A copied task is being handed on, so it moves to "On Deck" (completed ones stay done) and leaves the selection.
async function copyTasks(store, items) {
  if (!items.length) return;
  const text = items.map((i) => taskMarkdown(store, i, projectsOf(store))).join('\n');
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    toast('Could not copy: the browser blocked the clipboard');
    return;
  }
  for (const i of items) view.selected.delete(i.id);
  const moving = items.filter((i) => !['done', 'ondeck'].includes(statusOf(i))).map((i) => i.id);
  if (moving.length) updateItems(store, moving, { status: 'ondeck' });
  else store.refresh();
  toast(`${items.length === 1 ? 'Task' : `${items.length} tasks`} copied${moving.length ? ', moved to On Deck' : ''}`);
}

function copyButton(store, item) {
  return h('button', {
    type: 'button',
    class: 'icon-btn copy-btn',
    title: 'Copy',
    'aria-label': `Copy "${item.text}"`,
    onclick: () => copyTasks(store, [item]),
  }, icon('copy'));
}

// Marks a task done, or back to "To do" when it already is.
function doneButton(store, item) {
  const done = statusOf(item) === 'done';
  return h('button', {
    type: 'button',
    class: done ? 'icon-btn done-btn on' : 'icon-btn done-btn',
    title: done ? 'Mark as not done' : 'Mark done',
    'aria-label': done ? `Mark "${item.text}" as not done` : `Mark "${item.text}" done`,
    'aria-pressed': String(done),
    onclick: () => updateItem(store, item.id, { status: done ? 'todo' : 'done' }),
  }, icon('check'));
}

// The checkbox picks the task for the batch actions. Shift+click picks the whole range from the last one.
// order: the ids shown, top to bottom.
function selectBox(store, item, order = []) {
  return h('input', {
    type: 'checkbox',
    class: 'todo-select',
    checked: view.selected.has(item.id),
    title: 'Select (Shift+click for a range)',
    'aria-label': `Select "${item.text}"`,
    onclick: (e) => {
      const on = e.currentTarget.checked;
      const from = order.indexOf(view.lastPicked);
      const to = order.indexOf(item.id);
      const ids = e.shiftKey && from >= 0 && to >= 0
        ? order.slice(Math.min(from, to), Math.max(from, to) + 1)
        : [item.id];
      for (const id of ids) on ? view.selected.add(id) : view.selected.delete(id);
      view.lastPicked = item.id;
      store.refresh();
    },
  });
}

// Shown while tasks are ticked: change them all at once, copy them, or delete them.
// Each field opens the same searchable, colored picker as a row's chips; picking a value applies it to every ticked task.
function batchBar(store, visible, projects, categories) {
  const items = store.get(COLLECTION).items.filter((i) => view.selected.has(i.id));
  if (!items.length) return null;
  const ids = items.map((i) => i.id);
  const apply = (patch) => updateItems(store, ids, patch);
  const select = (name, options, onPick) =>
    pickButton({ label: name, title: `Set the ${name.toLowerCase()} of the selected tasks`, options, onPick });
  const deadline = h('input', {
    type: 'date',
    class: 'due-picker',
    tabindex: '-1',
    'aria-hidden': 'true',
    onchange: (e) => apply({ due: e.target.value }),
  });
  const allShown = visible.length > 0 && visible.every((i) => view.selected.has(i.id));
  return h('div', { class: 'batch-bar', role: 'toolbar', 'aria-label': 'Selected tasks' },
    // The count doubles as the way out, so clearing never wraps onto a line of its own.
    h('button', {
      type: 'button',
      class: 'btn-small batch-count',
      title: 'Clear the selection',
      'aria-label': `${items.length} selected, clear the selection`,
      onclick: () => {
        view.selected.clear();
        store.refresh();
      },
    }, `${items.length} selected`, icon('x')),
    allShown
      ? null
      : h('button', {
          type: 'button',
          class: 'btn-small',
          onclick: () => {
            for (const i of visible) view.selected.add(i.id);
            store.refresh();
          },
        }, `Select all ${visible.length} shown`),
    h('button', { type: 'button', class: 'btn-small', title: 'Mark the selected tasks done', onclick: () => apply({ status: 'done' }) }, icon('check'), 'Done'),
    select('Status', statusOptions(store), (v) => apply({ status: v })),
    select('Priority', PRIORITIES.map(([v, l]) => ({ value: v, label: l, tone: v === 'none' ? 'plain' : v })), (v) => apply({ priority: v })),
    select('Project', [
      { value: '__personal', label: 'Personal' },
      ...[...projects].sort((a, b) => a.name.localeCompare(b.name)).map((p) => ({ value: p.id, label: p.name, plainIcon: () => projectIcon(p) })),
    ], (v) => apply({ projectId: v === '__personal' ? null : v })),
    select('Category', [{ value: NO_CATEGORY, label: 'No category' }, ...categories.map((c) => ({ value: c, label: c, color: categoryColor(store, c) }))],
      (v) => apply({ category: v === NO_CATEGORY ? '' : v })),
    h('span', { class: 'due-control' },
      h('button', {
        type: 'button',
        class: 'btn-small',
        title: 'Set the deadline of the selected tasks',
        onclick: () => {
          try { deadline.showPicker(); } catch { deadline.focus(); }
        },
      }, icon('calendar'), 'Deadline'),
      deadline),
    h('span', { class: 'grow' }),
    h('button', { type: 'button', class: 'btn-small', title: 'Copy the selected tasks as a Markdown list', onclick: () => copyTasks(store, items) }, icon('copy'), 'Copy'),
    h('button', { type: 'button', class: 'btn-small danger', onclick: () => removeItems(store, ids) }, icon('trash'), 'Delete'));
}

// Ticks or unticks every task shown, from the table header.
function selectAllBox(store, visible) {
  const picked = visible.filter((i) => view.selected.has(i.id)).length;
  const box = h('input', {
    type: 'checkbox',
    class: 'todo-select',
    checked: visible.length > 0 && picked === visible.length,
    disabled: !visible.length,
    title: 'Select all shown',
    'aria-label': 'Select all shown tasks',
    onchange: (e) => {
      for (const i of visible) e.target.checked ? view.selected.add(i.id) : view.selected.delete(i.id);
      store.refresh();
    },
  });
  box.indeterminate = picked > 0 && picked < visible.length;
  return box;
}

// One todo row. Title, description, and the pickers all edit in place.
// ctx: { store, projects, projectLabel, order, showDue }. Without a deadline column, its button sits with the actions.
function todoRow(store, item, ctx) {
  const expanded = view.expanded.has(item.id);
  const status = statusOf(item);
  const priority = item.priority ?? 'none';
  const hasDescription = Boolean(item.description);
  const repos = ctx.projects.find((p) => p.id === item.projectId)?.github?.repos ?? [];
  const projectOptions = [...ctx.projects].sort((a, b) => a.name.localeCompare(b.name))
    .map((p) => ({ value: p.id, label: p.name, plainIcon: () => projectIcon(p) }));
  const categoryNames = categoriesFor(store, item.projectId);
  if (item.category && !categoryNames.includes(item.category)) categoryNames.push(item.category);

  return h('li', {
    class: ['todo-item', status === 'done' ? 'done' : '', view.selected.has(item.id) ? 'selected' : ''].filter(Boolean).join(' '),
    'data-id': item.id,
    ondragstart: (e) => {
      if (!reorderEnabled()) return e.preventDefault();
      view.dragId = item.id;
      view.dragStatus = statusOf(item);
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
      if (!reorderEnabled() || !view.dragId || view.dragId === item.id || !canDropOn(item)) return;
      e.preventDefault();
      const side = dropSide(e);
      e.currentTarget.classList.toggle('drop-before', side === 'before');
      e.currentTarget.classList.toggle('drop-after', side === 'after');
    },
    ondragleave: (e) => clearDropMarks(e.currentTarget),
    ondrop: (e) => {
      if (!reorderEnabled() || !view.dragId || !canDropOn(item)) return;
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
      selectBox(store, item, ctx.order),
      h('div', { class: 'todo-title-cell' },
        editText({
          value: item.text,
          placeholder: 'Untitled',
          className: 'todo-title',
          onSave: (text) => updateItem(store, item.id, { text }),
        }),
        dueChip(item),
        autoBadge(item),
        item.inbox ? h('span', { class: 'muted small' }, `needs ${missingFor(item)}`) : null,
        item.inbox
          ? h('button', {
              type: 'button',
              class: 'btn-small',
              title: 'Take it out of To Organize',
              onclick: () => updateItem(store, item.id, { inbox: false }),
            }, 'Organized')
          : null),
      h('div', { class: 'todo-meta' },
        h('div', { class: 'todo-status' },
          pickChip({
            value: status,
            options: statusOptions(store, status),
            onPick: (v) => updateItem(store, item.id, { status: v }),
          }),
          doneButton(store, item)),
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
          options: categoryNames.map((c) => ({ value: c, label: c, color: categoryColor(store, c) })),
          nullable: true,
          nullLabel: 'No category',
          allowCreate: true,
          onPick: (v) => updateItem(store, item.id, { category: v ?? '' }),
          onCreate: (name) => updateItem(store, item.id, { category: createTodoCategory(store, name, item.projectId) }),
        }),
        ctx.showDue ? dueControl(store, item) : null),
      h('div', { class: 'todo-actions' },
        ctx.showDue ? null : dueControl(store, item),
        repos.length || item.issue ? issueControl(store, item, repos) : null,
        item.email
          ? h('a', { href: `#/inbox?email=${encodeURIComponent(item.email.id)}`, class: 'icon-btn', title: 'Open the email', 'aria-label': 'Open the email this task came from' }, icon('mail'))
          : null,
        hasDescription
          ? h('span', { class: 'desc-indicator', title: 'Has a description', 'aria-label': 'Has a description' }, icon('align-left'))
          : null,
        copyButton(store, item),
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

// --- Board: one column per status; dragging a card to a column changes its status ---

function boardCard(store, item, projects, order) {
  const p = projects.find((x) => x.id === item.projectId);
  const priority = item.priority ?? 'none';
  const expanded = view.expanded.has(item.id);
  return h('article', {
    class: view.selected.has(item.id) ? 'kanban-card selected' : 'kanban-card',
    draggable: 'true',
    ondragstart: (e) => {
      view.dragId = item.id;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', item.id); // Firefox needs data to start a drag
      e.currentTarget.classList.add('dragging');
    },
    ondragend: (e) => {
      view.dragId = null;
      e.currentTarget.classList.remove('dragging');
    },
  },
    h('div', { class: 'row kanban-title' },
      selectBox(store, item, order),
      editText({ value: item.text, placeholder: 'Untitled', className: 'todo-title', onSave: (text) => updateItem(store, item.id, { text }) })),
    h('div', { class: 'row kanban-meta' },
      p ? h('span', { class: 'row small' }, projectIcon(p), p.name) : h('span', { class: 'muted small' }, 'Personal'),
      priority !== 'none' ? h('span', { class: `pill tone-${priority}` }, label(PRIORITIES, priority)) : null,
      categoryTag(store, item.category),
      dueChip(item),
      autoBadge(item)),
    h('div', { class: 'row between' },
      h('div', { class: 'todo-status' },
        pickChip({
          value: statusOf(item),
          options: statusOptions(store, statusOf(item)),
          onPick: (v) => updateItem(store, item.id, { status: v }),
        }),
        doneButton(store, item)),
      h('div', { class: 'row kanban-actions' },
        item.description ? h('span', { class: 'desc-indicator', title: 'Has a description', 'aria-label': 'Has a description' }, icon('align-left')) : null,
        copyButton(store, item),
        h('button', {
          type: 'button',
          class: expanded ? 'icon-btn chevron open' : 'icon-btn chevron',
          title: expanded ? 'Hide details' : 'Deadline and description',
          'aria-label': expanded ? 'Hide details' : 'Show deadline and description',
          'aria-expanded': String(expanded),
          onclick: () => toggleExpanded(store, item.id),
        }, icon('chevron-down')),
        h('button', { type: 'button', class: 'icon-btn', title: 'Delete', 'aria-label': `Delete "${item.text}"`, onclick: () => removeItem(store, item.id) }, icon('x')))),
    // The same details as a table row, so a card never needs the table to be edited.
    expanded
      ? h('div', { class: 'kanban-details' },
          h('label', { class: 'row small muted' }, 'Deadline',
            h('input', {
              type: 'date',
              class: 'due-input',
              value: item.due ?? '',
              'aria-label': `Deadline for "${item.text}"`,
              onchange: (e) => updateItem(store, item.id, { due: e.target.value }),
            })),
          editText({
            value: item.description,
            placeholder: 'Add a description…',
            rich: true,
            multiline: true,
            allowEmpty: true,
            onSave: (description) => updateItem(store, item.id, { description }),
          }))
      : null);
}

function boardView(store, items, projects, order) {
  // A status hidden in Settings → Labels keeps its column only while a task shown is in it.
  const columns = taskStatuses(store).filter((s) => !s.hidden || items.some((i) => statusOf(i) === s.key));
  return h('div', { class: 'kanban' }, columns.map((s) => {
    const { key } = s;
    const cards = items.filter((i) => statusOf(i) === key);
    return h('section', {
      class: 'kanban-col',
      ondragover: (e) => {
        if (!view.dragId) return;
        e.preventDefault();
        e.currentTarget.classList.add('drop-target');
      },
      ondragleave: (e) => e.currentTarget.classList.remove('drop-target'),
      ondrop: (e) => {
        e.preventDefault();
        e.currentTarget.classList.remove('drop-target');
        if (view.dragId) updateItem(store, view.dragId, { status: key });
        view.dragId = null;
      },
    },
      h('h3', { class: 'row between' }, pill(s.name, statusLook(s)), h('span', { class: 'count' }, String(cards.length))),
      cards.length ? cards.map((item) => boardCard(store, item, projects, order)) : h('p', { class: 'muted small' }, 'Drop a task here'));
  }));
}

// --- Sorting and column filters ---

const columnValue = (item, key, projects) => {
  if (key === 'text') return item.text.toLowerCase();
  if (key === 'status') return STATUS_GROUP_ORDER.indexOf(statusOf(item));
  if (key === 'priority') return PRIORITY_ORDER[item.priority ?? 'none'];
  if (key === 'project') return (projects.find((p) => p.id === item.projectId)?.name ?? 'Personal').toLowerCase();
  if (key === 'due') return item.due || '9999-99-99'; // tasks without a deadline sort last
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

// Click a column title: ascending, then descending, then the manual order.
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
function columnFilters(store, projects, categories, showDue) {
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
    select('status', taskStatuses(store).map((s) => [s.key, s.name])),
    select('priority', PRIORITIES),
    select('project', [['none', 'Personal'], ...projects.map((p) => [p.id, p.name])]),
    select('category', [[NO_CATEGORY, 'No category'], ...categories.map((c) => [c, c])]),
    showDue ? h('span') : null,
    h('span', null, Object.values(f).some(Boolean) || !isDefaultSort(view.sort)
      ? h('button', {
          type: 'button',
          class: 'btn-small',
          onclick: () => {
            view.colFilter = { text: '', status: '', priority: '', project: '', category: '' };
            view.sort = { ...DEFAULT_SORT };
            store.refresh();
          },
        }, 'Reset')
      : null));
}

// --- AI: tidy todo titles (task 3) ---

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
      { role: 'system', content: systemPrompt(store, 'tidy') },
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
          categoryTag(store, s.category),
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
    p.github.org ? h('p', null, 'GitHub: ', githubLink(p.github.org)) : null,
    p.github.repos.length
      ? h('ul', { class: 'repo-summary' },
          p.github.repos.map((r) => {
            const s = repoStats(r, onLoad);
            const text = s.status === 'ok' ? `${s.issues} issues · ${s.prs} PRs` : s.status === 'loading' ? 'loading…' : s.error;
            return h('li', null,
              githubLink(r),
              h('span', { class: 'muted' }, text));
          }))
      : null);
}

// --- Page ---

// Each keystroke re-renders the list; the shell keeps focus and the caret in the box across the render. It has to run
// inside the input event: a render from a timer counts as a background one and is held while the box has focus.
function searchBox(store) {
  const input = h('input', {
    type: 'search',
    value: view.query,
    placeholder: 'Search tasks',
    title: `Search tasks: ${QUERY_HINT}`,
    'aria-label': 'Search tasks',
    autocomplete: 'off',
    oninput: (e) => {
      view.query = e.target.value;
      store.refresh();
    },
    onkeydown: (e) => {
      if (e.key === 'Escape' && view.query) {
        e.stopPropagation();
        view.query = '';
        store.refresh();
      }
    },
  });
  return h('label', { class: view.query ? 'todo-search active' : 'todo-search' }, icon('search'), input);
}

function draw(root, store) {
  const projects = projectsOf(store);
  const { items } = store.get(COLLECTION);
  if (isProjectFilter(view.filter) && !projects.some((p) => p.id === view.filter)) view.filter = 'all';

  // Settings → Labels sets the order.
  const categories = taskCategoryNames(store);
  if (view.category && !categories.includes(view.category)) view.category = '';

  const openCount = (pred) => items.filter((i) => statusOf(i) !== 'done' && pred(i)).length;
  const projectName = (id) => projects.find((p) => p.id === id)?.name ?? '';
  const currentLabel =
    { all: 'All', personal: 'Personal', today: 'Today', organize: 'To Organize', auto: 'Automated' }[view.filter] ?? projectName(view.filter);
  const listHint = {
    today: 'Tasks whose deadline is today or has passed.',
    organize: 'Tasks that arrived without a project or a deadline, for example from Telegram. Give them both, or press Organized.',
    auto: 'Tasks the board created by itself. Each one says why in its description.',
  }[view.filter];

  // Personal and project lists accept dropped todos; "All" does not, since it has no project.
  const navItem = (key, text, count, leading) => {
    const accepts = key === 'personal' || isProjectFilter(key);
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
  // A search that names a status (is:done) overrides the "Show" filter, so done tasks can be found.
  const matchesQuery = taskMatcher(view.query, projects);
  const visible = sortItems(
    items.filter((i) => matchesFilter(i) && (matchesQuery.hasStatus || matchesStatus(i)) && matchesCategory(i) && matchesColumns(i) && matchesQuery(i)),
    projects,
  );
  const columnsActive = Object.values(view.colFilter).some(Boolean);

  // The selection only holds tasks on screen, so a batch never touches one hidden by a filter or deleted elsewhere.
  const order = visible.map((i) => i.id);
  for (const id of view.selected) if (!order.includes(id)) view.selected.delete(id);
  // A deadline column with nothing in it only takes room, so it shows once a task on screen has one.
  const showDue = visible.some((i) => i.due);
  const rowOf = (item) => todoRow(store, item, { store, projects, order, showDue, projectLabel: view.filter === 'all' ? projectName(item.projectId) : '' });
  const grouped = (groups) => h('div', { class: 'todo-groups' },
    groups.filter(([, rows]) => rows.length).map(([name, rows]) =>
      h('section', { class: 'todo-group' },
        h('h3', { class: 'row' }, name, h('span', { class: 'count' }, String(rows.length))),
        h('ul', { class: 'todo-list' }, rows.map(rowOf)))));
  let listBody;
  if (!visible.length) {
    listBody = h('p', { class: 'empty' }, matchesQuery.active
      ? `No task matches “${view.query.trim()}”${view.status === 'open' && !matchesQuery.hasStatus ? ' among open tasks. Add is:done to look in completed ones.' : '.'}`
      : columnsActive ? 'No todo matches these filters.' : 'Nothing matches these filters.');
  } else if (view.layout === 'board') {
    listBody = boardView(store, visible, projects, order);
  } else if (view.layout === 'project') {
    listBody = grouped([['Personal', visible.filter((i) => !i.projectId)], ...projectTree(projects).map(({ project: p }) => [p.name, visible.filter((i) => i.projectId === p.id)])]);
  } else if (view.layout === 'status') {
    listBody = grouped(STATUS_GROUP_ORDER.map((key) => [statusName(store, key), visible.filter((i) => statusOf(i) === key)]));
  } else {
    listBody = h('ul', { class: 'todo-list' }, visible.map(rowOf));
  }

  root.replaceChildren(
    h('div', { class: 'split' },
      h('aside', { class: 'card side' },
        h('div', { class: 'row between' },
          h('h2', null, 'Lists'),
          h('span', { class: 'muted small' }, 'drag onto a list to move')),
        navItem('all', 'All', openCount(() => true)),
        navItem('today', 'Today', openCount((i) => Boolean(i.due) && i.due <= todayISO()), icon('clock')),
        navItem('personal', 'Personal', openCount((i) => i.projectId === null)),
        navItem('organize', 'To Organize', openCount((i) => Boolean(i.inbox)), icon('inbox')),
        navItem('auto', 'Automated', openCount((i) => Boolean(i.auto)), icon('zap')),
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
            searchBox(store),
            h('label', { class: 'inline' }, 'Show',
              h('select', {
                value: view.status,
                'aria-label': 'Filter by status',
                onchange: (e) => {
                  view.status = e.target.value;
                  store.refresh();
                },
              }, statusFilters(store).map(([k, l]) => h('option', { value: k }, l)))),
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
            h('a', { href: '#/settings?section=categories', class: 'btn-small', title: 'Statuses and categories, in Settings' }, 'Labels'),
            h('div', { class: 'segmented layout-seg', role: 'group', 'aria-label': 'View' },
              LAYOUTS.map(([key, text, iconName]) =>
                h('button', {
                  type: 'button',
                  class: view.layout === key ? 'seg active' : 'seg',
                  title: `${text} view`,
                  'aria-label': `${text} view`,
                  'aria-pressed': String(view.layout === key),
                  onclick: () => {
                    view.layout = key;
                    store.refresh();
                  },
                }, icon(iconName), view.layout === key ? text : null))),
            h('span', { class: 'muted small' }, `${visible.length} shown`))),

        listHint ? h('p', { class: 'muted small' }, listHint) : null,

        isProjectFilter(view.filter) && view.showProject
          ? projectDetails(store, projects.find((p) => p.id === view.filter))
          : null,

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

        batchBar(store, visible, projects, categories),

        h('div', { class: ['todo-table', view.layout === 'table' ? '' : 'no-columns', showDue ? '' : 'no-due'].filter(Boolean).join(' ') },
          h('div', { class: 'todo-row todo-head' },
            h('span'), selectAllBox(store, visible),
            columnHeader(store, 'text', 'Task'),
            columnHeader(store, 'status', 'Status'),
            columnHeader(store, 'priority', 'Priority'),
            columnHeader(store, 'project', 'Project'),
            columnHeader(store, 'category', 'Category'),
            showDue ? columnHeader(store, 'due', 'Deadline') : null,
            h('span')),
          columnFilters(store, projects, categories, showDue),
          listBody))));
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
    view: view.layout === 'table' ? '' : view.layout,
    filter: view.filter,
    q: view.query,
    status: view.status,
    category: view.category,
    more: view.showProject ? '1' : '',
    sort: isDefaultSort(view.sort) ? '' : view.sort.key ? `${view.sort.key}.${view.sort.dir}` : 'manual',
  }),
  restore: (p = {}) => {
    view.layout = LAYOUTS.some(([k]) => k === p.view) ? p.view : 'table';
    view.filter = p.filter || 'all';
    view.query = p.q || '';
    view.status = p.status || 'open';
    view.category = p.category || '';
    view.showProject = p.more === '1';
    const [key = '', dir = 'asc'] = (p.sort ?? '').split('.');
    view.sort = p.sort === 'manual'
      ? { key: '', dir: 'asc' }
      : ['text', 'status', 'priority', 'project', 'category', 'due'].includes(key)
        ? { key, dir: dir === 'desc' ? 'desc' : 'asc' }
        : { ...DEFAULT_SORT };
  },
};
